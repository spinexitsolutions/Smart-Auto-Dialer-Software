'use strict';
const express = require('express');
const db = require('../db');
const dialer = require('../dialer');
const { requireRole } = require('../auth');
const { h, bad, notFound, audit, int, bool } = require('../util');
const { getSettings } = require('../settings');

const router = express.Router();
const FIELDS = ['name', 'type', 'dial_mode', 'status', 'description', 'script', 'wrapup_sec', 'max_attempts', 'retry_minutes', 'call_start', 'call_end', 'auto_skip_unanswered', 'sim_slot'];

function normalize(b) {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name).trim();
  if (b.type !== undefined) out.type = b.type;
  if (b.dial_mode !== undefined) out.dial_mode = b.dial_mode;
  if (b.status !== undefined) out.status = b.status;
  if (b.description !== undefined) out.description = b.description;
  if (b.script !== undefined) out.script = b.script;
  if (b.wrapup_sec !== undefined) out.wrapup_sec = Math.max(0, int(b.wrapup_sec, 30));
  if (b.max_attempts !== undefined) out.max_attempts = Math.max(1, int(b.max_attempts, 3));
  if (b.retry_minutes !== undefined) out.retry_minutes = Math.max(1, int(b.retry_minutes, 60));
  for (const k of ['call_start', 'call_end']) {
    if (b[k] !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) throw bad(`${k} must be HH:MM`);
      out[k] = b[k];
    }
  }
  if (b.auto_skip_unanswered !== undefined) out.auto_skip_unanswered = bool(b.auto_skip_unanswered);
  if (b.sim_slot !== undefined) out.sim_slot = int(b.sim_slot, -1);
  if (out.type && !['sales', 'support', 'collection', 'survey', 'other'].includes(out.type)) throw bad('Invalid type');
  if (out.dial_mode && !['preview', 'progressive', 'power'].includes(out.dial_mode)) throw bad('Invalid dial mode');
  if (out.status && !['draft', 'active', 'paused', 'completed'].includes(out.status)) throw bad('Invalid status');
  return out;
}

function stats(companyId, ids) {
  if (!ids.length) return {};
  const closed = getSettings(companyId).closed_statuses;
  const rows = db.all(
    `SELECT campaign_id,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh,
       SUM(CASE WHEN status IN (${closed.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS closed,
       SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted
     FROM leads WHERE company_id = ? AND campaign_id IN (${ids.map(() => '?').join(',')}) GROUP BY campaign_id`,
    [...closed, companyId, ...ids]
  );
  const calls = db.all(
    `SELECT campaign_id, COUNT(*) AS calls, SUM(connected) AS connected, COALESCE(SUM(duration),0) AS talk_sec
     FROM calls WHERE company_id = ? AND campaign_id IN (${ids.map(() => '?').join(',')}) GROUP BY campaign_id`,
    [companyId, ...ids]
  );
  const out = {};
  for (const id of ids) out[id] = { total: 0, fresh: 0, closed: 0, converted: 0, calls: 0, connected: 0, talk_sec: 0 };
  for (const r of rows) Object.assign(out[r.campaign_id], r);
  for (const r of calls) Object.assign(out[r.campaign_id], r);
  return out;
}

router.get('/', h((req, res) => {
  let rows;
  if (req.user.role === 'agent') {
    rows = db.all(
      `SELECT c.* FROM campaigns c JOIN campaign_agents ca ON ca.campaign_id = c.id
       WHERE c.company_id = ? AND ca.user_id = ? ORDER BY c.status = 'active' DESC, c.name`,
      [req.user.company_id, req.user.id]
    );
  } else {
    rows = db.all("SELECT * FROM campaigns WHERE company_id = ? ORDER BY status = 'active' DESC, created_at DESC", [req.user.company_id]);
  }
  const s = stats(req.user.company_id, rows.map((r) => r.id));
  const agentsBy = {};
  for (const r of db.all('SELECT ca.campaign_id, ca.user_id FROM campaign_agents ca JOIN campaigns c ON c.id = ca.campaign_id WHERE c.company_id = ?', [req.user.company_id])) {
    (agentsBy[r.campaign_id] ||= []).push(r.user_id);
  }
  res.json(rows.map((r) => ({ ...r, stats: s[r.id], agent_ids: agentsBy[r.id] || [] })));
}));

router.get('/:id', h((req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!c) throw notFound('Campaign');
  const agentIds = db.all('SELECT user_id FROM campaign_agents WHERE campaign_id = ?', [c.id]).map((r) => r.user_id);
  if (req.user.role === 'agent' && !agentIds.includes(req.user.id)) throw notFound('Campaign');
  const byStatus = db.all('SELECT status, COUNT(*) AS n FROM leads WHERE campaign_id = ? GROUP BY status', [c.id]);
  const byDisp = db.all('SELECT disposition, COUNT(*) AS n FROM calls WHERE campaign_id = ? AND disposition IS NOT NULL GROUP BY disposition ORDER BY n DESC', [c.id]);
  res.json({ ...c, agent_ids: agentIds, stats: stats(req.user.company_id, [c.id])[c.id], by_status: byStatus, by_disposition: byDisp });
}));

function setAgents(campaignId, companyId, ids) {
  if (!Array.isArray(ids)) return;
  db.run('DELETE FROM campaign_agents WHERE campaign_id = ?', [campaignId]);
  for (const uid of ids) {
    if (db.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [uid, companyId])) {
      db.run('INSERT OR IGNORE INTO campaign_agents (campaign_id, user_id) VALUES (?,?)', [campaignId, uid]);
    }
  }
}

router.post('/', requireRole('manager'), h((req, res) => {
  const data = normalize(req.body);
  if (!data.name) throw bad('Campaign name is required');
  data.company_id = req.user.company_id;
  const id = db.insert('campaigns', data, ['company_id', ...FIELDS]);
  setAgents(id, req.user.company_id, req.body.agent_ids);
  audit(req, 'campaign.create', { id, name: data.name });
  res.status(201).json(db.get('SELECT * FROM campaigns WHERE id = ?', [id]));
}));

router.put('/:id', requireRole('manager'), h((req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!c) throw notFound('Campaign');
  const data = normalize(req.body);
  db.update('campaigns', c.id, data, FIELDS);
  setAgents(c.id, req.user.company_id, req.body.agent_ids);
  const fresh = db.get('SELECT * FROM campaigns WHERE id = ?', [c.id]);
  if (fresh.status !== c.status) dialer.onCampaignChanged(fresh);
  audit(req, 'campaign.update', { id: c.id });
  res.json(fresh);
}));

/** Recycle: put not-connected / exhausted leads back into the dialing queue. */
router.post('/:id/recycle', requireRole('manager'), h((req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!c) throw notFound('Campaign');
  const statuses = Array.isArray(req.body.statuses) && req.body.statuses.length ? req.body.statuses : ['new', 'contacted', 'follow_up'];
  const r = db.run(
    `UPDATE leads SET attempts = 0, next_call_at = NULL, locked_by = NULL, locked_at = NULL
     WHERE campaign_id = ? AND status IN (${statuses.map(() => '?').join(',')})`,
    [c.id, ...statuses]
  );
  audit(req, 'campaign.recycle', { id: c.id, statuses, count: r.changes });
  res.json({ ok: true, recycled: r.changes });
}));

router.delete('/:id', requireRole('admin'), h((req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!c) throw notFound('Campaign');
  dialer.onCampaignChanged({ ...c, status: 'completed' });
  db.run('DELETE FROM campaigns WHERE id = ?', [c.id]);
  audit(req, 'campaign.delete', { id: c.id, name: c.name });
  res.json({ ok: true });
}));

module.exports = router;
