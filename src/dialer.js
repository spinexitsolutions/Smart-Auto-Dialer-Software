'use strict';
/**
 * Dialer engine: keeps live agent state in memory, picks the next lead,
 * drives calls on the agent's SIM device (Android app), the demo simulator
 * or manual mode, and pushes real-time updates to supervisors.
 */
const crypto = require('crypto');
const db = require('./db');
const { getSettings, withinHours, startOfTodayUtc } = require('./settings');
const { sqlNow, phoneKey, activity } = require('./util');

const LOCK_MINUTES = 10;
const OFFLINE_GRACE_MS = 20000;

let io = null;
// Extension points set by server.js (automations, AI analysis, missed-call messages).
const hooks = { onDisposition: null, onMissedCall: null };
const agents = new Map(); // userId -> state
const monitorTimers = new Map(); // companyId -> timeout
const demoTimers = new Map(); // callId -> [timeouts]

function setIo(server) { io = server; }

function emitUser(userId, event, data) { if (io) io.to(`user:${userId}`).emit(event, data); }
function emitNative(userId, event, data) { if (io) io.to(`native:${userId}`).emit(event, data); }

function getAgent(userId) { return agents.get(userId); }

function ensureAgent(user) {
  let a = agents.get(user.id);
  if (!a) {
    a = {
      userId: user.id, companyId: user.company_id, name: user.name, role: user.role, team: user.team,
      status: 'offline', since: Date.now(), campaignId: null, callId: null, leadId: null, phone: null,
      breakReason: null, autoDial: false, sockets: new Set(), nativeSockets: new Set(), sessionId: null,
      breakId: null, offlineTimer: null, dispatchTimer: null, device: null, previewLeadId: null, message: null,
    };
    agents.set(user.id, a);
  }
  a.name = user.name; a.team = user.team; a.role = user.role;
  return a;
}

function publicState(a) {
  return {
    userId: a.userId, status: a.status, since: a.since, campaignId: a.campaignId, callId: a.callId,
    leadId: a.leadId, breakReason: a.breakReason, autoDial: a.autoDial, hasDevice: a.nativeSockets.size > 0,
    device: a.device, previewLeadId: a.previewLeadId,
  };
}

function setStatus(a, status, extra = {}) {
  if (a.status !== status) a.since = Date.now();
  a.status = status;
  Object.assign(a, extra);
  emitUser(a.userId, 'agent:state', publicState(a));
  scheduleMonitor(a.companyId);
}

// ---------------------------------------------------------------- monitor

function scheduleMonitor(companyId) {
  if (!io || monitorTimers.has(companyId)) return;
  monitorTimers.set(companyId, setTimeout(() => {
    monitorTimers.delete(companyId);
    try { io.to(`monitor:${companyId}`).emit('monitor:update', snapshot(companyId)); } catch (e) { console.error('monitor', e); }
  }, 400));
}

function snapshot(companyId) {
  const tz = getSettings(companyId).timezone;
  const since = startOfTodayUtc(tz);
  const users = db.all(
    `SELECT u.id, u.name, u.role, u.team, u.phone,
       (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND c.started_at >= $since) AS calls,
       (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND c.started_at >= $since AND c.connected = 1) AS connected,
       (SELECT COALESCE(SUM(duration),0) FROM calls c WHERE c.user_id = u.id AND c.started_at >= $since) AS talk_sec,
       (SELECT COUNT(*) FROM calls c JOIN dispositions d ON d.id = c.disposition_id WHERE c.user_id = u.id AND c.started_at >= $since AND d.is_success = 1) AS success,
       (SELECT MIN(login_at) FROM agent_sessions s WHERE s.user_id = u.id AND s.login_at >= $since) AS first_login
     FROM users u WHERE u.company_id = $cid AND u.active = 1 AND u.role IN ('agent','manager','admin')
     ORDER BY u.name`,
    { since, cid: companyId }
  );
  const campaigns = Object.fromEntries(db.all('SELECT id, name FROM campaigns WHERE company_id = ?', [companyId]).map((c) => [c.id, c.name]));
  const now = Date.now();
  const list = users
    .map((u) => {
      const a = agents.get(u.id);
      const live = a ? publicState(a) : { status: 'offline', since: null };
      let lead = null;
      if (a && a.leadId && ['dialing', 'on_call', 'wrapup', 'preview'].includes(a.status)) {
        lead = db.get('SELECT id, name, phone FROM leads WHERE id = ?', [a.leadId]);
      } else if (a && a.phone && ['dialing', 'on_call', 'wrapup'].includes(a.status)) {
        lead = { id: null, name: null, phone: a.phone };
      }
      return {
        ...u, ...live, campaign: a?.campaignId ? campaigns[a.campaignId] || null : null, lead,
        elapsed: live.since ? Math.floor((now - live.since) / 1000) : null,
      };
    })
    // Admins/managers only appear once they log into the dialer.
    .filter((u) => u.role === 'agent' || u.status !== 'offline');
  const count = (s) => list.filter((x) => x.status === s).length;
  return {
    at: now,
    agents: list,
    summary: {
      total: list.length,
      online: list.filter((x) => x.status !== 'offline').length,
      on_call: count('on_call') + count('dialing'),
      available: count('available') + count('preview') + count('idle'),
      wrapup: count('wrapup'),
      break: count('break'),
      offline: count('offline'),
      calls: list.reduce((s, x) => s + x.calls, 0),
      connected: list.reduce((s, x) => s + x.connected, 0),
      talk_sec: list.reduce((s, x) => s + x.talk_sec, 0),
      success: list.reduce((s, x) => s + x.success, 0),
    },
  };
}

// ---------------------------------------------------------------- sockets

function onConnect(socket, user, { native = false } = {}) {
  const a = ensureAgent(user);
  socket.join(`user:${user.id}`);
  socket.join(`company:${user.company_id}`);
  if (user.role === 'admin' || user.role === 'manager') socket.join(`monitor:${user.company_id}`);
  a.sockets.add(socket.id);
  if (native) { a.nativeSockets.add(socket.id); socket.join(`native:${user.id}`); }
  if (a.offlineTimer) { clearTimeout(a.offlineTimer); a.offlineTimer = null; }
  if (a.status === 'offline') {
    const open = db.get('SELECT id FROM agent_sessions WHERE user_id = ? AND logout_at IS NULL ORDER BY id DESC LIMIT 1', [user.id]);
    a.sessionId = open ? open.id : db.run('INSERT INTO agent_sessions (company_id, user_id) VALUES (?,?)', [user.company_id, user.id]).id;
    setStatus(a, 'idle');
  } else {
    emitUser(a.userId, 'agent:state', publicState(a));
    scheduleMonitor(a.companyId);
  }
  // Re-send any in-progress call so a refreshed page can resume it.
  if (a.callId) {
    const payload = callPayload(a.callId);
    if (payload) socket.emit('call:resume', payload);
  } else if (a.previewLeadId) {
    const lead = db.get('SELECT * FROM leads WHERE id = ?', [a.previewLeadId]);
    if (lead) socket.emit('lead:preview', { lead, campaign: campaignInfo(a.campaignId) });
  }
}

function onDisconnect(socket, user) {
  const a = agents.get(user.id);
  if (!a) return;
  a.sockets.delete(socket.id);
  const wasNative = a.nativeSockets.delete(socket.id);
  if (wasNative) emitUser(a.userId, 'agent:state', publicState(a));
  if (a.sockets.size === 0) {
    a.offlineTimer = setTimeout(() => goOffline(a), OFFLINE_GRACE_MS);
  }
  scheduleMonitor(a.companyId);
}

function goOffline(a, reason) {
  a.offlineTimer = null;
  if (a.dispatchTimer) { clearTimeout(a.dispatchTimer); a.dispatchTimer = null; }
  endBreakRow(a);
  if (a.callId) {
    const call = db.get('SELECT * FROM calls WHERE id = ?', [a.callId]);
    if (call && !call.ended_at) finalizeCall(a, call, { durationSec: 0, connected: false, status: 'failed' });
  }
  if (a.leadId || a.previewLeadId) unlockLead(a.leadId || a.previewLeadId);
  if (a.sessionId) db.run('UPDATE agent_sessions SET logout_at = ? WHERE id = ?', [sqlNow(), a.sessionId]);
  a.sessionId = null;
  setStatus(a, 'offline', { autoDial: false, callId: null, leadId: null, previewLeadId: null, phone: null, campaignId: null, breakReason: null });
  if (reason) emitUser(a.userId, 'force:logout', { reason });
}

// ---------------------------------------------------------------- campaigns & leads

function campaignInfo(campaignId) {
  if (!campaignId) return null;
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  return c || null;
}

function agentCanUseCampaign(a, campaign) {
  if (!campaign || campaign.company_id !== a.companyId) return false;
  if (a.role === 'admin' || a.role === 'manager') return true;
  return !!db.get('SELECT 1 AS ok FROM campaign_agents WHERE campaign_id = ? AND user_id = ?', [campaign.id, a.userId]);
}

function isDnc(companyId, phone) {
  return !!db.get('SELECT 1 AS x FROM dnc WHERE company_id = ? AND phone_key = ?', [companyId, phoneKey(phone)]);
}

/** Atomically pick and lock the next lead for an agent in a campaign. */
function nextLead(a, campaign) {
  const settings = getSettings(a.companyId);
  const closed = settings.closed_statuses;
  const now = sqlNow();
  const staleLock = sqlNow(new Date(Date.now() - LOCK_MINUTES * 60000));
  return db.tx(() => {
    for (let guard = 0; guard < 50; guard++) {
      const lead = db.get(
        `SELECT * FROM leads l
         WHERE l.company_id = $cid AND l.campaign_id = $camp
           AND l.status NOT IN (${closed.map((_, i) => '$s' + i).join(',') || "''"})
           AND l.attempts < $max
           AND (l.next_call_at IS NULL OR l.next_call_at <= $now)
           AND (l.assigned_to IS NULL OR l.assigned_to = $uid)
           AND (l.locked_by IS NULL OR l.locked_by = $uid OR l.locked_at < $stale)
         ORDER BY (l.next_call_at IS NOT NULL AND l.assigned_to = $uid) DESC,
                  (l.assigned_to = $uid) DESC, l.priority DESC, l.attempts ASC, l.id ASC
         LIMIT 1`,
        {
          cid: a.companyId, camp: campaign.id, max: campaign.max_attempts, now, uid: a.userId, stale: staleLock,
          ...Object.fromEntries(closed.map((s, i) => ['s' + i, s])),
        }
      );
      if (!lead) return null;
      if (isDnc(a.companyId, lead.phone)) {
        db.run("UPDATE leads SET status = 'dnc', updated_at = ? WHERE id = ?", [now, lead.id]);
        continue;
      }
      db.run('UPDATE leads SET locked_by = ?, locked_at = ? WHERE id = ?', [a.userId, now, lead.id]);
      return { ...lead, locked_by: a.userId, locked_at: now };
    }
    return null;
  });
}

function unlockLead(leadId) {
  if (leadId) db.run('UPDATE leads SET locked_by = NULL, locked_at = NULL WHERE id = ?', [leadId]);
}

function executorFor(a) {
  if (a.nativeSockets.size > 0) return 'native';
  if (getSettings(a.companyId).demo_mode) return 'demo';
  return 'manual';
}

function callPayload(callId) {
  const call = db.get('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) return null;
  const a = agents.get(call.user_id);
  const lead = call.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', [call.lead_id]) : null;
  return { call, lead, campaign: campaignInfo(call.campaign_id), executor: a ? executorFor(a) : 'manual' };
}

// ---------------------------------------------------------------- agent actions

function err(a, message) { emitUser(a.userId, 'dialer:error', { message }); }

function setReady(user, campaignId) {
  const a = ensureAgent(user);
  if (a.status === 'offline') return err(a, 'You are offline');
  if (['dialing', 'on_call'].includes(a.status)) return err(a, 'Finish the current call first');
  const campaign = campaignInfo(Number(campaignId));
  if (!agentCanUseCampaign(a, campaign)) return err(a, 'You are not assigned to this campaign');
  if (campaign.status !== 'active') return err(a, `Campaign is ${campaign.status}`);
  endBreakRow(a);
  if (a.previewLeadId && a.campaignId !== campaign.id) { unlockLead(a.previewLeadId); a.previewLeadId = null; }
  setStatus(a, 'available', { campaignId: campaign.id, autoDial: true, breakReason: null });
  dispatch(a);
}

function setNotReady(user) {
  const a = ensureAgent(user);
  if (a.dispatchTimer) { clearTimeout(a.dispatchTimer); a.dispatchTimer = null; }
  if (a.previewLeadId) { unlockLead(a.previewLeadId); a.previewLeadId = null; }
  if (['dialing', 'on_call', 'wrapup'].includes(a.status)) { a.autoDial = false; emitUser(a.userId, 'agent:state', publicState(a)); scheduleMonitor(a.companyId); return; }
  setStatus(a, 'idle', { autoDial: false });
}

function startBreak(user, reason) {
  const a = ensureAgent(user);
  if (['dialing', 'on_call'].includes(a.status)) return err(a, 'Finish the current call before taking a break');
  if (a.status === 'wrapup') return err(a, 'Save the disposition before taking a break');
  if (a.dispatchTimer) { clearTimeout(a.dispatchTimer); a.dispatchTimer = null; }
  if (a.previewLeadId) { unlockLead(a.previewLeadId); a.previewLeadId = null; }
  endBreakRow(a);
  a.breakId = db.run('INSERT INTO agent_breaks (company_id, user_id, reason) VALUES (?,?,?)', [a.companyId, a.userId, reason || 'Break']).id;
  setStatus(a, 'break', { breakReason: reason || 'Break', autoDial: false });
}

function endBreakRow(a) {
  if (a.breakId) {
    db.run('UPDATE agent_breaks SET end_at = ? WHERE id = ? AND end_at IS NULL', [sqlNow(), a.breakId]);
    a.breakId = null;
  }
}

function endBreak(user) {
  const a = ensureAgent(user);
  if (a.status !== 'break') return;
  endBreakRow(a);
  setStatus(a, 'idle', { breakReason: null });
}

function scheduleDispatch(a, delaySec) {
  if (a.dispatchTimer) clearTimeout(a.dispatchTimer);
  a.dispatchTimer = setTimeout(() => { a.dispatchTimer = null; dispatch(a); }, Math.max(0, delaySec) * 1000);
}

function dispatch(a) {
  if (a.status !== 'available' || !a.autoDial || !a.campaignId) return;
  const campaign = campaignInfo(a.campaignId);
  if (!campaign || campaign.status !== 'active') { setStatus(a, 'idle', { autoDial: false }); return err(a, 'Campaign is not active'); }
  const settings = getSettings(a.companyId);
  if (!withinHours(campaign.call_start, campaign.call_end, settings.timezone)) {
    setStatus(a, 'idle', { autoDial: false });
    return err(a, `Outside calling hours (${campaign.call_start} - ${campaign.call_end}). Calls are blocked to stay compliant.`);
  }
  const lead = a.previewLeadId ? db.get('SELECT * FROM leads WHERE id = ?', [a.previewLeadId]) : nextLead(a, campaign);
  if (!lead) {
    setStatus(a, 'idle', { autoDial: false });
    emitUser(a.userId, 'dialer:empty', { campaignId: campaign.id, message: 'No more leads to dial in this campaign right now.' });
    return;
  }
  if (campaign.dial_mode === 'preview') {
    setStatus(a, 'preview', { previewLeadId: lead.id, leadId: lead.id });
    emitUser(a.userId, 'lead:preview', { lead, campaign });
    return;
  }
  startCall(a, { lead, campaign });
}

function skipPreview(user) {
  const a = ensureAgent(user);
  if (a.status !== 'preview' || !a.previewLeadId) return;
  const id = a.previewLeadId;
  // Push it back a little so the same lead is not immediately offered again.
  db.run('UPDATE leads SET locked_by = NULL, locked_at = NULL, next_call_at = ? WHERE id = ?', [sqlNow(new Date(Date.now() + 15 * 60000)), id]);
  a.previewLeadId = null;
  setStatus(a, 'available', { leadId: null });
  dispatch(a);
}

/** Dial a specific lead or a raw number (click-to-call / preview "Call"). */
function manualDial(user, { leadId, phone }) {
  const a = ensureAgent(user);
  if (a.status === 'offline') return err(a, 'You are offline');
  if (['dialing', 'on_call', 'wrapup'].includes(a.status)) return err(a, 'Finish the current call first');
  const settings = getSettings(a.companyId);
  let lead = null;
  if (leadId) {
    lead = db.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [Number(leadId), a.companyId]);
    if (!lead) return err(a, 'Lead not found');
    if (a.role === 'agent' && lead.assigned_to && lead.assigned_to !== a.userId) return err(a, 'This lead is assigned to another agent');
    if (lead.locked_by && lead.locked_by !== a.userId && lead.locked_at > sqlNow(new Date(Date.now() - LOCK_MINUTES * 60000))) {
      return err(a, 'Another agent is currently calling this lead');
    }
    db.run('UPDATE leads SET locked_by = ?, locked_at = ? WHERE id = ?', [a.userId, sqlNow(), lead.id]);
  } else {
    if (a.role === 'agent' && !settings.allow_agent_manual_dial) return err(a, 'Manual dialing is disabled by your admin');
    if (!phone || String(phone).replace(/\D/g, '').length < 5) return err(a, 'Enter a valid number');
    lead = db.get('SELECT * FROM leads WHERE company_id = ? AND phone_key = ? ORDER BY id DESC LIMIT 1', [a.companyId, phoneKey(phone)]);
  }
  const number = lead ? lead.phone : String(phone);
  if (isDnc(a.companyId, number)) {
    if (lead) unlockLead(lead.id);
    return err(a, 'This number is on the Do-Not-Call list');
  }
  const campaign = lead?.campaign_id ? campaignInfo(lead.campaign_id) : a.campaignId ? campaignInfo(a.campaignId) : null;
  if (a.previewLeadId && (!lead || a.previewLeadId !== lead.id)) { unlockLead(a.previewLeadId); }
  a.previewLeadId = null;
  startCall(a, { lead, campaign, phone: number });
}

function startCall(a, { lead, campaign, phone }) {
  if (a.dispatchTimer) { clearTimeout(a.dispatchTimer); a.dispatchTimer = null; }
  const number = phone || lead.phone;
  const executor = executorFor(a);
  const user = db.get('SELECT sim_slot FROM users WHERE id = ?', [a.userId]);
  const simSlot = campaign && campaign.sim_slot >= 0 ? campaign.sim_slot : user?.sim_slot ?? -1;
  const callId = db.run(
    `INSERT INTO calls (company_id, lead_id, campaign_id, user_id, phone, mode, status, sim_slot, started_at)
     VALUES (?,?,?,?,?,?, 'dialing', ?, ?)`,
    [a.companyId, lead?.id ?? null, campaign?.id ?? null, a.userId, number, executor === 'native' ? 'sim' : executor, simSlot, sqlNow()]
  ).id;
  setStatus(a, 'dialing', { callId, leadId: lead?.id ?? null, phone: number, previewLeadId: null, campaignId: campaign?.id ?? a.campaignId });
  const payload = callPayload(callId);
  payload.simSlot = simSlot;
  emitUser(a.userId, 'call:start', payload);
  if (executor === 'demo') simulateCall(a, callId);
}

/** Demo / sales-presentation mode: fake the telephony side of a call. */
function simulateCall(a, callId) {
  const timers = [];
  const answered = Math.random() < 0.65;
  const talk = 6 + Math.floor(Math.random() * 20);
  timers.push(setTimeout(() => callState(a.userId, { callId, state: 'ringing' }), 1200));
  if (answered) {
    timers.push(setTimeout(() => callState(a.userId, { callId, state: 'connected' }), 3500));
    timers.push(setTimeout(() => callState(a.userId, { callId, state: 'ended', durationSec: talk, connected: true }), 3500 + talk * 1000));
  } else {
    timers.push(setTimeout(() => callState(a.userId, { callId, state: 'ended', durationSec: 0, connected: false }), 7000));
  }
  demoTimers.set(callId, timers);
}

function clearDemo(callId) {
  const t = demoTimers.get(callId);
  if (t) { t.forEach(clearTimeout); demoTimers.delete(callId); }
}

/** Telephony state updates (from the Android app, the manual UI or the simulator). */
function callState(userId, { callId, state, durationSec, connected }) {
  const a = agents.get(userId);
  if (!a) return;
  callId = Number(callId);
  const call = db.get('SELECT * FROM calls WHERE id = ? AND user_id = ?', [callId, userId]);
  if (!call || call.ended_at) return;
  if (state === 'ringing' || state === 'dialing') {
    db.run("UPDATE calls SET status = 'ringing' WHERE id = ?", [callId]);
    emitUser(userId, 'call:update', { callId, state: 'ringing' });
  } else if (state === 'offhook' || state === 'connected') {
    // On Android, OFFHOOK fires as soon as an outgoing call starts dialing; the real
    // "answered" signal is the call-log duration at the end. We show "in call" state.
    db.run("UPDATE calls SET status = 'connected', answered_at = COALESCE(answered_at, ?) WHERE id = ?", [sqlNow(), callId]);
    setStatus(a, 'on_call');
    emitUser(userId, 'call:update', { callId, state: 'connected' });
  } else if (state === 'ended') {
    clearDemo(callId);
    const dur = Math.max(0, Math.round(Number(durationSec) || 0));
    finalizeCall(a, call, { durationSec: dur, connected: connected === undefined ? dur > 0 : !!connected });
  }
}

function finalizeCall(a, call, { durationSec, connected, status = 'ended' }) {
  const now = sqlNow();
  db.run('UPDATE calls SET status = ?, ended_at = ?, duration = ?, connected = ? WHERE id = ?', [status, now, durationSec, connected ? 1 : 0, call.id]);
  if (call.lead_id) {
    db.run(
      `UPDATE leads SET attempts = attempts + 1, last_called_at = ?, updated_at = ?,
         status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ?`,
      [now, now, call.lead_id]
    );
    activity(a.companyId, call.lead_id, a.userId, 'call', `${connected ? 'Connected' : 'Not connected'} call${durationSec ? ` (${durationSec}s)` : ''}`);
  }
  emitUser(a.userId, 'call:ended', { callId: call.id, durationSec, connected });
  fireWebhook(a.companyId, 'call.ended', { ...db.get('SELECT * FROM calls WHERE id = ?', [call.id]) });
  if (a.callId !== call.id) return;
  setStatus(a, 'wrapup');
  const campaign = campaignInfo(call.campaign_id);
  const autoSkip = campaign && (campaign.auto_skip_unanswered || campaign.dial_mode === 'power');
  if (!connected && autoSkip && status === 'ended') {
    const disp = db.get(
      "SELECT * FROM dispositions WHERE company_id = ? AND category = 'not_connected' AND active = 1 ORDER BY (lower(name) LIKE '%no answer%') DESC, sort LIMIT 1",
      [a.companyId]
    );
    if (disp) applyDisposition({ id: a.userId, company_id: a.companyId, role: a.role }, call.id, { disposition_id: disp.id, notes: 'Auto: not answered' });
  }
}

function hangup(user) {
  const a = ensureAgent(user);
  if (!a.callId) return;
  const call = db.get('SELECT * FROM calls WHERE id = ?', [a.callId]);
  if (!call || call.ended_at) return;
  const executor = executorFor(a);
  if (executor === 'native') {
    emitNative(a.userId, 'call:hangup', { callId: call.id });
    return; // the device reports 'ended' with the real duration
  }
  clearDemo(call.id);
  const answeredMs = call.answered_at ? Date.now() - new Date(call.answered_at.replace(' ', 'T') + 'Z').getTime() : 0;
  finalizeCall(a, call, { durationSec: Math.max(0, Math.round(answeredMs / 1000)), connected: !!call.answered_at });
}

/**
 * Save disposition for a call, update the lead and move the agent on.
 * Shared by the REST endpoint and auto-skip.
 */
function applyDisposition(user, callId, body) {
  const call = db.get('SELECT * FROM calls WHERE id = ? AND company_id = ?', [callId, user.company_id]);
  if (!call) throw Object.assign(new Error('Call not found'), { status: 404 });
  if (user.role === 'agent' && call.user_id !== user.id) throw Object.assign(new Error('Not your call'), { status: 403 });
  const disp = body.disposition_id ? db.get('SELECT * FROM dispositions WHERE id = ? AND company_id = ?', [Number(body.disposition_id), user.company_id]) : null;
  if (!disp) throw Object.assign(new Error('Please select a disposition'), { status: 400 });
  const campaign = campaignInfo(call.campaign_id);
  const settings = getSettings(user.company_id);
  const now = sqlNow();
  const a = agents.get(call.user_id);

  db.tx(() => {
    if (!call.ended_at) {
      // Agent dispositioned before the device reported the end (e.g. manual mode).
      const answeredMs = call.answered_at ? Date.now() - new Date(call.answered_at.replace(' ', 'T') + 'Z').getTime() : 0;
      db.run("UPDATE calls SET status = 'ended', ended_at = ?, duration = ?, connected = ? WHERE id = ?",
        [now, Math.round(answeredMs / 1000), call.answered_at ? 1 : 0, call.id]);
      if (call.lead_id) db.run('UPDATE leads SET attempts = attempts + 1, last_called_at = ? WHERE id = ?', [now, call.lead_id]);
      clearDemo(call.id);
    }
    db.run('UPDATE calls SET disposition_id = ?, disposition = ?, notes = ?, disposed_at = ? WHERE id = ?',
      [disp.id, disp.name, body.notes || null, now, call.id]);

    if (call.lead_id) {
      const lead = db.get('SELECT * FROM leads WHERE id = ?', [call.lead_id]);
      const patch = { last_disposition: disp.name, updated_at: now, locked_by: null, locked_at: null };
      if (disp.lead_status) patch.status = disp.lead_status;
      // This conversation satisfies any follow-up that was due for the lead.
      db.run("UPDATE followups SET status = 'done' WHERE lead_id = ? AND status = 'pending' AND due_at <= ?",
        [lead.id, sqlNow(new Date(Date.now() + 12 * 3600000))]);
      let next = null;
      if (body.callback_at) {
        next = new Date(body.callback_at);
        if (isNaN(next)) next = null;
      }
      if (disp.needs_callback && !next) next = new Date(Date.now() + 24 * 3600000);
      if (next) {
        patch.next_call_at = sqlNow(next);
        if (!disp.lead_status) patch.status = 'follow_up';
        db.run('INSERT INTO followups (company_id, lead_id, user_id, due_at, note) VALUES (?,?,?,?,?)',
          [user.company_id, lead.id, call.user_id, sqlNow(next), body.notes || `Callback: ${disp.name}`]);
        // Callbacks stay with the agent who spoke to the customer.
        if (!lead.assigned_to) patch.assigned_to = call.user_id;
      } else if (disp.retry) {
        const mins = campaign?.retry_minutes ?? 60;
        patch.next_call_at = sqlNow(new Date(Date.now() + mins * 60000));
      } else {
        patch.next_call_at = null;
      }
      // Leads that exhausted max_attempts are skipped by nextLead()'s attempts filter.
      for (const k of ['ptp_date', 'ptp_amount', 'deal_value', 'amount_due']) if (body[k] !== undefined && body[k] !== '') patch[k] = body[k];
      if (patch.status === 'dnc' || body.add_dnc) {
        db.run('INSERT OR IGNORE INTO dnc (company_id, phone, phone_key, reason) VALUES (?,?,?,?)', [user.company_id, lead.phone, phoneKey(lead.phone), `Disposition: ${disp.name}`]);
        patch.status = 'dnc';
      }
      const cols = Object.keys(patch);
      db.run(`UPDATE leads SET ${cols.map((c) => `${c} = $${c}`).join(', ')} WHERE id = $id`, { ...patch, id: lead.id });
      activity(user.company_id, lead.id, user.id, 'disposition', `${disp.name}${body.notes ? ': ' + body.notes : ''}`);
      if (patch.status && patch.status !== lead.status) {
        activity(user.company_id, lead.id, user.id, 'status', `Status changed: ${lead.status} → ${patch.status}`);
        fireWebhook(user.company_id, 'lead.status_changed', { lead_id: lead.id, from: lead.status, to: patch.status, phone: lead.phone, name: lead.name });
      }
    }
  });

  fireWebhook(user.company_id, 'call.disposed', { call_id: call.id, lead_id: call.lead_id, disposition: disp.name, is_success: !!disp.is_success, notes: body.notes || null, agent_id: call.user_id });
  try {
    hooks.onDisposition?.({ companyId: user.company_id, callId: call.id, leadId: call.lead_id, dispositionId: disp.id, campaignId: call.campaign_id, userId: call.user_id });
  } catch (e) { console.error('disposition hook', e); }

  if (a && a.callId === call.id) {
    a.callId = null; a.leadId = null; a.phone = null;
    if (body.stop_dialing) a.autoDial = false;
    if (a.autoDial && a.campaignId) {
      setStatus(a, 'available');
      emitUser(a.userId, 'call:done', { callId: call.id, nextInSec: settings.auto_dial_delay_sec });
      scheduleDispatch(a, settings.auto_dial_delay_sec);
    } else {
      setStatus(a, 'idle');
      emitUser(a.userId, 'call:done', { callId: call.id, nextInSec: null });
    }
  }
  return db.get('SELECT * FROM calls WHERE id = ?', [call.id]);
}

// ---------------------------------------------------------------- supervisor

function supervisorAction(manager, targetId, action, text) {
  const a = agents.get(Number(targetId));
  const target = db.get('SELECT id, company_id, name, role, team FROM users WHERE id = ?', [Number(targetId)]);
  if (!target || target.company_id !== manager.company_id) return { ok: false, message: 'Agent not found' };
  if (action === 'message') {
    emitUser(target.id, 'supervisor:message', { from: manager.name, text: String(text || '').slice(0, 500), at: Date.now() });
    return { ok: true };
  }
  if (!a || a.status === 'offline') return { ok: false, message: `${target.name} is offline` };
  if (action === 'break') startBreak(target, text || 'Supervisor break');
  else if (action === 'idle') setNotReady(target);
  else if (action === 'logout') {
    if (a.callId) return { ok: false, message: 'Agent is on a call' };
    goOffline(a, `Logged out by ${manager.name}`);
  } else return { ok: false, message: 'Unknown action' };
  return { ok: true };
}

/** Broadcast campaign changes (e.g. paused) to agents working it. */
function onCampaignChanged(campaign) {
  for (const a of agents.values()) {
    if (a.campaignId === campaign.id && campaign.status !== 'active' && ['available', 'preview'].includes(a.status)) {
      setNotReady({ id: a.userId, company_id: a.companyId, name: a.name, role: a.role });
      err(a, `Campaign "${campaign.name}" was ${campaign.status}`);
    }
  }
}

function onUserDisabled(userId) {
  const a = agents.get(userId);
  if (a && a.status !== 'offline') goOffline(a, 'Your account was disabled');
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

// ---------------------------------------------------------------- webhooks

function fireWebhook(companyId, event, data) {
  let hooks;
  try { hooks = db.all('SELECT * FROM webhooks WHERE company_id = ? AND active = 1', [companyId]); } catch { return; }
  for (const hook of hooks) {
    const events = String(hook.events || '*').split(',').map((s) => s.trim());
    if (!events.includes('*') && !events.includes(event)) continue;
    const body = JSON.stringify({ event, at: new Date().toISOString(), data });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SmartAutoDialer-Webhook/1.0' };
    if (hook.secret) headers['X-Signature'] = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    if (typeof fetch === 'function') {
      fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
}


// ---------------------------------------------------------------- incoming calls (Android app)

/**
 * Incoming call events from the agent's phone:
 *   { id, phone, state: 'ringing'|'answered'|'ended', answered, missed, durationSec, startedAt, endedAt }
 * Ringing pops the customer on screen; the end is logged as an inbound call.
 * Missed calls create a "call back" follow-up; answered calls open the outcome form.
 */
function findLeadByPhone(companyId, phone) {
  const key = phoneKey(phone);
  if (key.length < 6) return null;
  return db.get('SELECT * FROM leads WHERE company_id = ? AND phone_key = ? ORDER BY updated_at DESC LIMIT 1', [companyId, key]);
}

function leadCard(lead) {
  if (!lead) return null;
  const last = db.get('SELECT started_at, disposition, notes, direction FROM calls WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [lead.id]);
  const owner = lead.assigned_to ? db.get('SELECT name FROM users WHERE id = ?', [lead.assigned_to]) : null;
  const campaign = lead.campaign_id ? db.get('SELECT name FROM campaigns WHERE id = ?', [lead.campaign_id]) : null;
  return {
    id: lead.id, name: lead.name, phone: lead.phone, status: lead.status, city: lead.city, company_name: lead.company_name,
    amount_due: lead.amount_due, due_date: lead.due_date, deal_value: lead.deal_value, last_disposition: lead.last_disposition,
    owner: owner?.name || null, campaign: campaign?.name || null, last_call: last || null,
  };
}

function incomingCall(user, d = {}) {
  const a = ensureAgent(user);
  const extId = String(d.id || '').slice(0, 64) || null;
  const phone = String(d.phone || '');
  const state = d.state;
  if (state === 'ringing' || state === 'answered') {
    const lead = phone ? findLeadByPhone(a.companyId, phone) : null;
    emitUser(a.userId, 'incoming:ring', { id: extId, phone, state, lead: leadCard(lead), at: Date.now() });
    a.incoming = { id: extId, phone, state, since: Date.now() };
    scheduleMonitor(a.companyId);
    return { ok: true };
  }
  if (state !== 'ended') return { ok: false };
  a.incoming = null;
  if (extId && db.get("SELECT id FROM calls WHERE user_id = ? AND ext_id = ? AND direction = 'inbound'", [a.userId, extId])) return { ok: true, duplicate: true };
  const settings = getSettings(a.companyId);
  const answered = !!d.answered && !d.missed;
  const dur = Math.max(0, Math.round(Number(d.durationSec) || 0));
  if (!phone || phone.replace(/\D/g, '').length < 5) {
    emitUser(a.userId, 'incoming:end', { id: extId, answered });
    return { ok: false, error: 'Unknown number' };
  }
  let lead = findLeadByPhone(a.companyId, phone);
  const started = d.startedAt ? new Date(Number(d.startedAt)) : new Date(Date.now() - dur * 1000);
  const startedSql = sqlNow(isNaN(started) ? new Date() : started);
  const now = sqlNow();
  const result = db.tx(() => {
    if (!lead && settings.auto_create_inbound_leads !== false && !isDnc(a.companyId, phone)) {
      const id = db.run(
        `INSERT INTO leads (company_id, name, phone, phone_key, source, status, priority, assigned_to, custom) VALUES (?,?,?,?,?,?,?,?, '{}')`,
        [a.companyId, null, phone, phoneKey(phone), 'Incoming call', 'new', answered ? 0 : 2, a.userId]
      ).id;
      activity(a.companyId, id, a.userId, 'created', 'Lead created from an incoming call');
      lead = db.get('SELECT * FROM leads WHERE id = ?', [id]);
    }
    const callId = db.run(
      `INSERT INTO calls (company_id, lead_id, campaign_id, user_id, phone, direction, mode, status, connected, started_at, answered_at, ended_at, duration, ext_id)
       VALUES (?,?,?,?,?, 'inbound', 'sim', ?, ?, ?, ?, ?, ?, ?)`,
      [a.companyId, lead?.id ?? null, lead?.campaign_id ?? null, a.userId, phone, answered ? 'ended' : 'missed', answered ? 1 : 0, startedSql,
        answered ? startedSql : null, now, answered ? dur : 0, extId]
    ).id;
    if (lead) {
      if (answered) {
        db.run('UPDATE leads SET last_called_at = ?, updated_at = ? WHERE id = ?', [now, now, lead.id]);
        activity(a.companyId, lead.id, a.userId, 'call', `Incoming call answered (${dur}s)`);
      } else {
        db.run('UPDATE leads SET priority = priority + 1, next_call_at = ?, updated_at = ? WHERE id = ?', [now, now, lead.id]);
        const owner = lead.assigned_to || a.userId;
        db.run('INSERT INTO followups (company_id, lead_id, user_id, due_at, note) VALUES (?,?,?,?,?)', [a.companyId, lead.id, owner, now, 'Missed call — call back']);
        activity(a.companyId, lead.id, a.userId, 'call', 'Missed incoming call — follow-up created');
      }
    }
    return callId;
  });
  fireWebhook(a.companyId, answered ? 'call.inbound' : 'call.missed', { ...db.get('SELECT * FROM calls WHERE id = ?', [result]) });
  if (!answered) {
    emitUser(a.userId, 'incoming:missed', { callId: result, phone, lead: leadCard(lead) });
    try { hooks.onMissedCall?.({ companyId: a.companyId, callId: result, leadId: lead?.id, userId: a.userId }); } catch (e) { console.error('missed hook', e); }
  } else if (!a.callId && !['dialing', 'on_call'].includes(a.status)) {
    // Let the agent record the outcome of the conversation.
    a.callId = result; a.leadId = lead?.id ?? null; a.phone = phone;
    if (a.dispatchTimer) { clearTimeout(a.dispatchTimer); a.dispatchTimer = null; }
    setStatus(a, 'wrapup');
    const payload = callPayload(result);
    emitUser(a.userId, 'call:resume', payload);
  }
  emitUser(a.userId, 'incoming:end', { id: extId, answered, callId: result });
  scheduleMonitor(a.companyId);
  return { ok: true, callId: result };
}

function deviceInfo(userId, info) {
  const a = agents.get(userId);
  if (!a) return;
  a.device = { sims: Array.isArray(info?.sims) ? info.sims.slice(0, 4) : [], model: info?.device?.model || null, manufacturer: info?.device?.manufacturer || null, android: info?.device?.android || null };
  emitUser(userId, 'agent:state', publicState(a));
  scheduleMonitor(a.companyId);
}

function _reset() {
  for (const a of agents.values()) { if (a.offlineTimer) clearTimeout(a.offlineTimer); if (a.dispatchTimer) clearTimeout(a.dispatchTimer); }
  for (const t of monitorTimers.values()) clearTimeout(t);
  for (const id of demoTimers.keys()) clearDemo(id);
  agents.clear(); monitorTimers.clear();
}

module.exports = {
  hooks, incomingCall, findLeadByPhone, leadCard,
  setIo, onConnect, onDisconnect, setReady, setNotReady, startBreak, endBreak, skipPreview, manualDial,
  callState, hangup, applyDisposition, supervisorAction, snapshot, getAgent, publicState, onCampaignChanged,
  onUserDisabled, fireWebhook, deviceInfo, nextLead, _reset, ensureAgent,
};
