// Agent dialer workspace: status, auto-dial, live call, script, disposition, follow-ups.
import {
  state, bus, get, post, esc, html, toast, toastErr, options, dur, hours, fmtDate, ago, money, pct, num, initials,
  AGENT_STATUS, statusBadge, onPage, pageInterval, loadRefs, localInput, native, isManager, openWhatsApp,
} from '../core.js';
import { openLead, followupModal, sendTemplate, newLeadModal } from './lead.js';

// Workspace state lives at module level so it survives navigation between pages.
const ws = {
  call: null, lead: null, campaign: null, executor: null, phase: null, // phase: dialing|ringing|connected|ended
  startedAt: 0, connectedAt: 0, endedAt: 0, duration: 0, connected: false,
  preview: null, nextIn: null, nextAt: 0, history: null, disp: null, campaignId: Number(localStorage.getItem('sad_campaign')) || null,
};
let root = null; // mounted element when page is visible

function rerender() { if (root && document.body.contains(root)) paint(); }

// ---- permanent subscriptions (registered once at module load)
bus.on('call:start', (p) => startCall(p, 'dialing'));
bus.on('call:resume', (p) => startCall(p, p.call.status === 'connected' ? 'connected' : p.call.ended_at ? 'ended' : 'dialing'));
bus.on('call:update', (d) => {
  if (!ws.call || d.callId !== ws.call.id) return;
  if (d.state === 'connected' && ws.phase !== 'connected') { ws.phase = 'connected'; ws.connectedAt = Date.now(); }
  else if (d.state === 'ringing' && ws.phase === 'dialing') ws.phase = 'ringing';
  rerender();
});
bus.on('call:ended', (d) => {
  if (!ws.call || d.callId !== ws.call.id) return;
  ws.phase = 'ended'; ws.endedAt = Date.now(); ws.duration = d.durationSec; ws.connected = d.connected;
  rerender();
});
bus.on('call:done', (d) => {
  if (ws.call && d.callId !== ws.call.id) return;
  Object.assign(ws, { call: null, lead: null, history: null, phase: null, disp: null, nextIn: d.nextInSec, nextAt: d.nextInSec ? Date.now() + d.nextInSec * 1000 : 0 });
  refreshSide();
  rerender();
});
bus.on('lead:preview', (p) => { ws.preview = p; ws.nextIn = null; loadHistory(p.lead.id); rerender(); });
bus.on('dialer:empty', (d) => { toast(d.message, 'info', 6000); ws.nextIn = null; rerender(); });
bus.on('agent:state', (s) => {
  if (s.status !== 'preview') ws.preview = null;
  if (s.status === 'idle' || s.status === 'break') ws.nextIn = null;
  if (!s.callId && ws.call && !['wrapup'].includes(s.status) && ws.phase !== 'ended') { ws.call = null; ws.phase = null; }
  if (s.campaignId) ws.campaignId = s.campaignId;
  rerender();
});

function startCall(p, phase) {
  Object.assign(ws, {
    call: p.call, lead: p.lead, campaign: p.campaign, executor: p.executor, phase, preview: null, nextIn: null, disp: null,
    startedAt: Date.now(), connectedAt: phase === 'connected' ? Date.now() : 0, endedAt: 0, duration: p.call.duration || 0, connected: !!p.call.connected,
  });
  if (p.call.ended_at) { ws.duration = p.call.duration; ws.endedAt = Date.now(); }
  ws.history = null;
  if (p.lead) loadHistory(p.lead.id);
  rerender();
}

async function loadHistory(leadId) {
  try {
    const l = await get(`/leads/${leadId}`);
    if ((ws.lead && ws.lead.id === leadId) || (ws.preview && ws.preview.lead.id === leadId)) { ws.history = l; rerender(); }
  } catch { /* lead might not be visible to agent */ }
}

// ---- side data (stats / follow-ups)
const side = { stats: null, followups: [] };
async function refreshSide() {
  try {
    const [stats, followups] = await Promise.all([get('/reports/dashboard'), get('/followups?mine=1&when=today')]);
    side.stats = stats; side.followups = followups;
    const el = root && root.querySelector('#sidePanel');
    if (el) el.innerHTML = sideHtml();
    bindSide();
  } catch { /* ignore */ }
}

function fillScript(text) {
  const l = ws.lead || ws.preview?.lead || {};
  const vars = {
    name: l.name || 'Sir/Madam', first_name: (l.name || '').split(' ')[0] || 'Sir/Madam', agent_name: state.user.name, phone: l.phone || '',
    city: l.city || '', company: l.company_name || '', amount_due: l.amount_due ?? '', due_date: l.due_date || '', business_name: state.user.company?.name || '',
  };
  return esc(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? `<mark style="background:var(--primary-soft);color:var(--primary);border-radius:4px;padding:0 3px">${esc(vars[k])}</mark>` : m));
}

// ---------------------------------------------------------------- rendering
export async function render(el) {
  root = el;
  await loadRefs().catch(() => {});
  const mine = state.campaigns.filter((c) => c.status === 'active');
  if (!ws.campaignId || !mine.find((c) => c.id === ws.campaignId)) ws.campaignId = mine[0]?.id || null;
  paint();
  refreshSide();
  pageInterval(tick, 1000);
  onPage('socket:connect', rerender);
  onPage('socket:disconnect', rerender);
}

function tick() {
  if (!root) return;
  const set = (sel, v) => { const n = root.querySelector(sel); if (n) n.textContent = v; };
  const a = state.agent;
  if (a?.since) set('#stTimer', dur((Date.now() - a.since) / 1000));
  if (ws.call) {
    if (ws.phase === 'connected') set('#callTimer', dur((Date.now() - ws.connectedAt) / 1000));
    else if (ws.phase !== 'ended') set('#callTimer', dur((Date.now() - ws.startedAt) / 1000));
    if (ws.phase === 'ended' && ws.campaign?.wrapup_sec) {
      const left = ws.campaign.wrapup_sec - Math.floor((Date.now() - ws.endedAt) / 1000);
      const n = root.querySelector('#wrapTimer');
      if (n) { n.textContent = left >= 0 ? `Wrap-up ${dur(left)}` : `Over by ${dur(-left)}`; n.classList.toggle('over', left < 0); }
    }
  }
  if (ws.nextAt) {
    const left = Math.max(0, Math.ceil((ws.nextAt - Date.now()) / 1000));
    set('#nextIn', left ? `Next call in ${left}s…` : 'Fetching next lead…');
  }
}

function deviceBadge() {
  const a = state.agent || {};
  const s = state.user.settings || {};
  if (native.available()) return '<span class="badge green"><i class="i i-smartphone"></i> This phone dials via SIM</span>';
  if (a.hasDevice) return `<span class="badge green" title="${esc(a.device?.model || '')}"><i class="i i-smartphone"></i> Phone app connected${a.device?.sims?.length ? ` · ${a.device.sims.length} SIM` : ''}</span>`;
  if (s.demo_mode) return '<span class="badge violet"><i class="i i-film"></i> Demo mode (simulated calls)</span>';
  return '<span class="badge amber" title="Install the Android app on your phone for automatic SIM dialing"><i class="i i-hand"></i> Manual mode</span>';
}

function paint() {
  const a = state.agent || { status: 'offline' };
  const s = state.user.settings || {};
  const mine = state.campaigns.filter((c) => c.status === 'active');
  const busy = ['dialing', 'on_call', 'wrapup'].includes(a.status);
  const dialing = a.autoDial && ['available', 'preview', 'dialing', 'on_call', 'wrapup'].includes(a.status);
  const connected = !!state.socket?.connected;
  root.innerHTML = html`
    <div class="card dialer-bar">
      <span class="status-pill st-${esc(a.status)}" style="background:color-mix(in srgb, currentColor 12%, transparent)">
        <span class="dot ${busy ? 'pulse' : ''}"></span>${esc(AGENT_STATUS[a.status] || a.status)}${a.breakReason ? ` · ${esc(a.breakReason)}` : ''}
        <span class="timer" id="stTimer"></span></span>
      <select id="campSel" style="width:auto;min-width:200px" ${busy || dialing ? 'disabled' : ''}>
        ${mine.length ? options(mine.map((c) => [c.id, `${c.name} · ${c.dial_mode}`]), ws.campaignId) : '<option value="">No active campaign assigned</option>'}
      </select>
      ${a.status === 'break'
        ? '<button class="btn green" id="resumeBtn"><i class="i i-play"></i> End break</button>'
        : dialing
          ? '<button class="btn amber" id="pauseBtn"><i class="i i-pause"></i> Pause dialing</button>'
          : `<button class="btn primary" id="startBtn" ${!mine.length || !connected || busy ? 'disabled' : ''}><i class="i i-play"></i> Start dialing</button>`}
      ${a.status !== 'break' ? `<select id="breakSel" style="width:auto" ${busy ? 'disabled' : ''}><option value="">Take a break…</option>${options(s.break_reasons || ['Break'], '')}</select>` : ''}
      <span style="flex:1"></span>
      ${deviceBadge()}
      ${!connected ? '<span class="badge red">Not connected to server</span>' : ''}
    </div>

    <div class="workspace">
      <div class="col gap-lg">
        <div class="card" id="callPanel">${callPanel(a)}</div>
        ${leadCard()}
      </div>
      <div class="col gap-lg">
        ${ws.call ? dispositionCard() : ''}
        ${scriptCard()}
        <div id="sidePanel" class="col gap-lg">${sideHtml()}</div>
      </div>
    </div>`;
  bind();
  tick();
}

function callPanel(a) {
  if (ws.call) {
    const l = ws.lead || {};
    const name = l.name || 'Unknown caller';
    const label = { dialing: 'Dialing…', ringing: 'Ringing…', connected: 'In call', ended: ws.connected ? 'Call ended · Connected' : 'Call ended · Not connected' }[ws.phase] || ws.phase;
    const color = { dialing: 'var(--blue)', ringing: 'var(--blue)', connected: 'var(--violet)', ended: ws.connected ? 'var(--green)' : 'var(--amber)' }[ws.phase];
    const manual = ws.executor === 'manual' && ws.phase !== 'ended';
    return `<div class="call-card">
      <div class="avatar ${ws.phase === 'ringing' || ws.phase === 'dialing' ? 'ring' : ''}">${esc(initials(name))}</div>
      <div class="call-state" style="color:${color}">${esc(label)}</div>
      <div class="name">${esc(name)}</div>
      <div class="number">${esc(ws.call.phone)}</div>
      <div class="call-timer" id="callTimer">${ws.phase === 'ended' ? dur(ws.duration) : '0:00'}</div>
      ${ws.phase === 'ended' ? '<div class="wrap-timer" id="wrapTimer"></div>' : ''}
      ${ws.executor === 'demo' && ws.phase !== 'ended' ? '<span class="badge violet">Demo mode — this call is simulated</span>' : ''}
      ${ws.executor === 'native' && ws.phase !== 'ended' ? '<span class="badge green">Calling from your phone SIM…</span>' : ''}
      ${manual ? `<div class="col" style="width:100%;max-width:360px">
          <a class="btn primary lg block" href="tel:${esc(ws.call.phone)}"><i class="i i-smartphone"></i> Dial ${esc(ws.call.phone)} on phone</a>
          <small class="muted">Manual mode: place the call from your phone, then mark what happened.</small>
          <div class="row" style="justify-content:center">
            ${ws.phase !== 'connected' ? '<button class="btn green" data-m="connected"><i class="i i-check"></i> Customer answered</button><button class="btn" data-m="noanswer"><i class="i i-x"></i> Not answered</button>' : ''}
          </div></div>` : ''}
      ${ws.phase !== 'ended' ? '<button class="btn red lg" id="hangBtn"><i class="i i-stop"></i> End call</button>' : ''}
    </div>`;
  }
  if (ws.preview) {
    const l = ws.preview.lead;
    return `<div class="call-card">
      <div class="call-state" style="color:var(--green)">Preview — next lead</div>
      <div class="avatar">${esc(initials(l.name))}</div>
      <div class="name">${esc(l.name || 'Unnamed lead')}</div>
      <div class="number">${esc(l.phone)}</div>
      <div class="row">${statusBadge(l.status)}<span class="badge">Attempt ${l.attempts + 1}</span>${l.city ? `<span class="badge">${esc(l.city)}</span>` : ''}</div>
      <div class="row"><button class="btn green xl" id="pvCall"><i class="i i-phone"></i> Call now</button><button class="btn lg" id="pvSkip">Skip <i class="i i-skip"></i></button></div>
    </div>`;
  }
  if (a.status === 'break') {
    return `<div class="idle-hero"><div class="big"><i class="i i-coffee"></i></div><h2>You are on a break</h2><p class="muted">Calls are paused. Click “End break” when you are back.</p></div>`;
  }
  if (a.autoDial && a.status === 'available') {
    return `<div class="idle-hero"><div class="big"><i class="i i-loader"></i></div><h2 id="nextIn">Fetching next lead…</h2><p class="muted">Auto-dialer is on. Pause any time.</p></div>`;
  }
  const s = state.user.settings || {};
  return `<div class="idle-hero">
      <div class="big"><i class="i i-phone"></i></div>
      <h2>Ready when you are</h2>
      <p class="muted" style="max-width:420px">Pick a campaign and press <b>Start dialing</b>. The next lead is dialed automatically after each call${s.auto_dial_delay_sec ? ` (${s.auto_dial_delay_sec}s gap)` : ''}.</p>
      ${s.allow_agent_manual_dial || isManager() ? `<form class="dialpad" id="manualForm" style="width:100%;max-width:380px">
        <input name="phone" placeholder="Or dial a number manually" inputmode="tel" autocomplete="off">
        <button class="btn primary" type="submit">Call</button></form>` : ''}
      <button class="btn sm ghost" id="addLeadBtn"><i class="i i-plus"></i> Add a new lead</button>
    </div>`;
}

function leadCard() {
  const l = ws.history || ws.lead || ws.preview?.lead;
  if (!l) return '';
  const custom = typeof l.custom === 'string' ? (() => { try { return JSON.parse(l.custom); } catch { return {}; } })() : l.custom || {};
  const rows = [
    ['Status', statusBadge(l.status)], ['Email', esc(l.email)], ['City', esc([l.city, l.state].filter(Boolean).join(', '))], ['Company', esc(l.company_name)],
    ['Source', esc(l.source)], ['Tags', esc(l.tags)], ['Attempts', esc(l.attempts)], ['Last result', esc(l.last_disposition)],
    ['Last called', l.last_called_at ? `${fmtDate(l.last_called_at)} <small class="muted">(${ago(l.last_called_at)})</small>` : ''],
    ['Deal value', l.deal_value != null ? money(l.deal_value) : ''], ['Amount due', l.amount_due != null ? `<b style="color:var(--red)">${money(l.amount_due)}</b>` : ''],
    ['Due date', esc(l.due_date)], ['PTP', l.ptp_date ? `${esc(l.ptp_date)} · ${money(l.ptp_amount)}` : ''],
    ...Object.entries(custom).map(([k, v]) => [esc(k), esc(v)]),
  ].filter(([, v]) => v !== '' && v != null && v !== 'null');
  const h = ws.history;
  const past = h ? [...h.calls.filter((c) => !ws.call || c.id !== ws.call.id).slice(0, 4)] : [];
  const notes = h ? h.activities.filter((x) => x.type === 'note' || x.type === 'whatsapp' || x.type === 'sms').slice(0, 3) : [];
  return `<div class="card">
    <div class="card-head"><h3>Customer details</h3>
      <button class="btn sm" id="waBtn"><i class="i i-message"></i> WhatsApp</button><button class="btn sm" id="fuBtn"><i class="i i-alarm"></i> Follow-up</button><button class="btn sm" id="openLead">Full profile <i class="i i-chevron-right"></i></button></div>
    <div class="card-body"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    ${past.length || notes.length ? `<div class="card-body" style="border-top:1px solid var(--border)"><h4>History</h4>
      ${past.map((c) => `<div class="row" style="padding:5px 0;font-size:13px"><span class="muted nowrap">${fmtDate(c.started_at)}</span>
        <span class="badge ${c.connected ? 'green' : ''}">${c.connected ? dur(c.duration) : 'No answer'}</span><span>${esc(c.disposition || '')}</span>
        <span class="muted">${esc(c.agent_name || '')}</span>${c.notes ? `<span class="muted">“${esc(c.notes)}”</span>` : ''}</div>`).join('')}
      ${notes.map((n) => `<div style="padding:5px 0;font-size:13px"><i class="i i-note"></i> ${esc(n.text)} <small class="muted">— ${esc(n.user_name || '')}, ${ago(n.created_at)}</small></div>`).join('')}
    </div>` : ''}
  </div>`;
}

function scriptCard() {
  const c = ws.campaign || ws.preview?.campaign || state.campaigns.find((x) => x.id === ws.campaignId);
  if (!c?.script) return '';
  return `<div class="card"><div class="card-head"><h3><i class="i i-script"></i> Call script</h3><small class="muted">${esc(c.name)}</small></div>
    <div class="card-body"><div class="script">${fillScript(c.script)}</div></div></div>`;
}

function dispositionCard() {
  const disps = state.dispositions.filter((d) => d.active !== 0);
  const groups = [['connected', 'Connected'], ['not_connected', 'Not connected']];
  const sel = ws.disp ? disps.find((d) => d.id === ws.disp) : null;
  const camp = ws.campaign || {};
  const l = ws.lead || {};
  const def = new Date(Date.now() + 2 * 3600000); def.setMinutes(0, 0, 0);
  return `<form class="card" id="dispForm">
    <div class="card-head"><h3><i class="i i-tag"></i> Call outcome</h3>${ws.phase === 'ended' ? '<span class="wrap-timer" id="wrapTimer"></span>' : '<small class="muted">You can fill this during the call</small>'}</div>
    <div class="card-body col">
      ${groups.map(([g, label]) => {
        const list = disps.filter((d) => d.category === g);
        if (!list.length) return '';
        return `<h4>${label}</h4><div class="disp-grid">${list.map((d) => `<button type="button" class="disp-btn ${ws.disp === d.id ? 'selected' : ''}" data-disp="${d.id}" style="--c:${esc(d.color)}">
          <span class="dot"></span>${esc(d.name)}</button>`).join('')}</div>`;
      }).join('')}
      <label class="field mt-s">Notes<textarea name="notes" rows="3" placeholder="What did the customer say?">${esc(ws.notes || '')}</textarea></label>
      ${sel?.needs_callback ? `<label class="field">Call back at<input type="datetime-local" name="callback_at" value="${localInput(def)}" required></label>` : ''}
      ${sel && /ptp|promise/i.test(sel.name) || camp.type === 'collection' && sel?.is_success ? `<div class="form-grid">
          <label class="field">Promise-to-pay date<input type="date" name="ptp_date" value="${esc(l.ptp_date || '')}"></label>
          <label class="field">PTP amount<input type="number" step="any" name="ptp_amount" value="${esc(l.ptp_amount ?? l.amount_due ?? '')}"></label></div>` : ''}
      ${sel?.is_success && camp.type === 'sales' ? `<label class="field">Deal value<input type="number" step="any" name="deal_value" value="${esc(l.deal_value ?? '')}"></label>` : ''}
      <div class="row">
        <label class="check"><input type="checkbox" name="add_dnc"> Add to Do-Not-Call</label>
        <label class="check"><input type="checkbox" name="stop_dialing"> Pause dialing after saving</label>
      </div>
      <button class="btn primary lg block" type="submit" ${ws.disp ? '' : 'disabled'}>${state.agent?.autoDial ? 'Save & dial next <i class="i i-skip"></i>' : 'Save outcome'}</button>
    </div>
  </form>`;
}

function sideHtml() {
  const st = side.stats;
  const t = st?.today || { calls: 0, connected: 0, talk_sec: 0, success: 0 };
  const target = st?.target || 0;
  return `<div class="card card-pad">
      <div class="row between"><h3>Today</h3>${target ? `<small class="muted">${num(t.calls)} / ${num(target)} calls target</small>` : ''}</div>
      ${target ? `<div class="target-bar mt-s"><span style="width:${Math.min(100, pct(t.calls, target))}%"></span></div>` : ''}
      <div class="grid g4 mt" style="gap:8px;text-align:center">
        <div><div style="font-size:22px;font-weight:750">${num(t.calls)}</div><small class="muted">Calls</small></div>
        <div><div style="font-size:22px;font-weight:750">${num(t.connected)}</div><small class="muted">Connected</small></div>
        <div><div style="font-size:22px;font-weight:750">${hours(t.talk_sec)}</div><small class="muted">Talk time</small></div>
        <div><div style="font-size:22px;font-weight:750;color:var(--green)">${num(t.success)}</div><small class="muted">Success</small></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3><i class="i i-alarm"></i> My follow-ups due</h3><a href="#/followups" class="btn sm ghost">All <i class="i i-chevron-right"></i></a></div>
      ${side.followups.length ? `<div>${side.followups.slice(0, 8).map((f) => `<div class="row between" style="padding:9px 16px;border-bottom:1px solid var(--border)">
        <div style="min-width:0"><b class="ellipsis" style="display:block">${esc(f.lead_name || f.phone)}</b>
        <small class="${new Date(f.due_at.replace(' ', 'T') + 'Z') < new Date() ? '' : 'muted'}" style="${new Date(f.due_at.replace(' ', 'T') + 'Z') < new Date() ? 'color:var(--red)' : ''}">${fmtDate(f.due_at)} · ${ago(f.due_at)}</small>${f.note ? `<div class="muted ellipsis" style="font-size:12px">${esc(f.note)}</div>` : ''}</div>
        <button class="btn sm green" data-fcall="${f.lead_id}" data-fid="${f.id}"><i class="i i-phone"></i></button></div>`).join('')}</div>` : '<div class="empty" style="padding:20px">Nothing due.</div>'}
    </div>`;
}

function bindSide() {
  root?.querySelectorAll('[data-fcall]').forEach((b) => (b.onclick = () => {
    if (ws.call) return toast('Finish the current call first', 'error');
    // The follow-up is closed automatically when this call gets an outcome.
    state.socket?.emit('dial', { leadId: Number(b.dataset.fcall) }, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); });
  }));
}

function bind() {
  const $ = (s) => root.querySelector(s);
  const sock = state.socket;
  const emit = (evt, data) => {
    if (!sock?.connected) return toast('Not connected to server', 'error');
    sock.emit(evt, data, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); });
  };
  $('#campSel') && ($('#campSel').onchange = (e) => { ws.campaignId = Number(e.target.value) || null; localStorage.setItem('sad_campaign', ws.campaignId || ''); paint(); });
  $('#startBtn') && ($('#startBtn').onclick = () => {
    if (!ws.campaignId) return toast('Select a campaign first', 'error');
    emit('agent:ready', { campaignId: ws.campaignId });
  });
  $('#pauseBtn') && ($('#pauseBtn').onclick = () => { ws.nextAt = 0; emit('agent:notready'); });
  $('#resumeBtn') && ($('#resumeBtn').onclick = () => emit('agent:resume'));
  $('#breakSel') && ($('#breakSel').onchange = (e) => { if (e.target.value) emit('agent:break', { reason: e.target.value }); });
  $('#hangBtn') && ($('#hangBtn').onclick = () => {
    if (ws.executor === 'manual') {
      const d = ws.phase === 'connected' ? Math.round((Date.now() - ws.connectedAt) / 1000) : 0;
      emit('call:state', { callId: ws.call.id, state: 'ended', durationSec: d, connected: ws.phase === 'connected' });
    } else emit('call:hangup');
  });
  root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    if (b.dataset.m === 'connected') emit('call:state', { callId: ws.call.id, state: 'connected' });
    else emit('call:state', { callId: ws.call.id, state: 'ended', durationSec: 0, connected: false });
  }));
  $('#pvCall') && ($('#pvCall').onclick = () => emit('dial', { leadId: ws.preview.lead.id }));
  $('#pvSkip') && ($('#pvSkip').onclick = () => emit('lead:skip'));
  $('#manualForm') && ($('#manualForm').onsubmit = (e) => {
    e.preventDefault();
    const phone = e.target.phone.value.trim();
    if (phone) emit('dial', { phone });
  });
  $('#addLeadBtn') && ($('#addLeadBtn').onclick = () => newLeadModal(() => {}));
  const lead = ws.lead || ws.preview?.lead;
  $('#openLead') && ($('#openLead').onclick = () => openLead(lead.id, { onChange: () => loadHistory(lead.id) }));
  $('#waBtn') && ($('#waBtn').onclick = () => (lead?.id ? sendTemplate(lead, 'whatsapp', () => loadHistory(lead.id)) : openWhatsApp(ws.call?.phone, '')));
  $('#fuBtn') && ($('#fuBtn').onclick = () => lead?.id && followupModal(lead, () => loadHistory(lead.id)));

  const form = $('#dispForm');
  if (form) {
    form.notes.oninput = () => { ws.notes = form.notes.value; };
    form.querySelectorAll('[data-disp]').forEach((b) => (b.onclick = () => { ws.notes = form.notes.value; ws.disp = Number(b.dataset.disp); paint(); }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!ws.disp) return toast('Select the call outcome', 'error');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      const body = { disposition_id: ws.disp, notes: form.notes.value };
      if (form.callback_at?.value) body.callback_at = new Date(form.callback_at.value).toISOString();
      for (const k of ['ptp_date', 'ptp_amount', 'deal_value']) if (form[k]?.value) body[k] = form[k].value;
      if (form.add_dnc.checked) body.add_dnc = true;
      if (form.stop_dialing.checked) body.stop_dialing = true;
      try {
        await post(`/calls/${ws.call.id}/disposition`, body);
        ws.notes = '';
        toast('Saved', 'success', 1500);
      } catch (err) { toastErr(err); btn.disabled = false; }
    };
  }
  bindSide();
}
