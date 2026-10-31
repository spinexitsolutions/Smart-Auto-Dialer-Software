'use strict';
/** Smaller CRM resources: dispositions, follow-ups, DNC, templates, tickets, webhooks, audit log. */
const express = require('express');
const db = require('../db');
const { requireRole, isManager } = require('../auth');
const { getSettings } = require('../settings');
const {
  h, bad, notFound, forbidden, audit, int, bool, cleanPhone, phoneKey, isValidPhone, sqlNow, toSqlDate, activity, randomKey, renderTemplate, sendCsv,
} = require('../util');

const router = express.Router();
const cid = (req) => req.user.company_id;

// ------------------------------------------------------------ dispositions
const DISP_FIELDS = ['name', 'category', 'lead_status', 'is_success', 'needs_callback', 'retry', 'color', 'sort', 'active'];
function dispData(req, b) {
  const d = {};
  if (b.name !== undefined) d.name = String(b.name).trim();
  if (b.category !== undefined) { if (!['connected', 'not_connected'].includes(b.category)) throw bad('Invalid category'); d.category = b.category; }
  if (b.lead_status !== undefined) {
    if (b.lead_status && !getSettings(cid(req)).lead_statuses.includes(b.lead_status)) throw bad('Invalid lead status');
    d.lead_status = b.lead_status || null;
  }
  for (const k of ['is_success', 'needs_callback', 'retry', 'active']) if (b[k] !== undefined) d[k] = bool(b[k]);
  if (b.color !== undefined) d.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#64748b';
  if (b.sort !== undefined) d.sort = int(b.sort);
  return d;
}
router.get('/dispositions', h((req, res) => {
  const all = req.query.all === '1' && isManager(req.user);
  res.json(db.all(`SELECT * FROM dispositions WHERE company_id = ? ${all ? '' : 'AND active = 1'} ORDER BY category, sort, name`, [cid(req)]));
}));
router.post('/dispositions', requireRole('manager'), h((req, res) => {
  const d = dispData(req, req.body);
  if (!d.name) throw bad('Name is required');
  d.company_id = cid(req);
  const id = db.insert('dispositions', d, ['company_id', ...DISP_FIELDS]);
  res.status(201).json(db.get('SELECT * FROM dispositions WHERE id = ?', [id]));
}));
router.put('/dispositions/:id', requireRole('manager'), h((req, res) => {
  const row = db.get('SELECT id FROM dispositions WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!row) throw notFound('Disposition');
  db.update('dispositions', row.id, dispData(req, req.body), DISP_FIELDS);
  res.json(db.get('SELECT * FROM dispositions WHERE id = ?', [row.id]));
}));
router.delete('/dispositions/:id', requireRole('admin'), h((req, res) => {
  // Soft delete to keep historic call reports intact.
  db.run('UPDATE dispositions SET active = 0 WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------ follow-ups / callbacks
router.get('/followups', h((req, res) => {
  const q = req.query;
  const where = ['f.company_id = $cid'];
  const p = { cid: cid(req) };
  if (!isManager(req.user) || q.mine === '1') { where.push('f.user_id = $me'); p.me = req.user.id; }
  else if (q.user_id) { where.push('f.user_id = $uid'); p.uid = int(q.user_id); }
  where.push('f.status = $st'); p.st = q.status || 'pending';
  if (q.when === 'overdue') { where.push('f.due_at < $now'); p.now = sqlNow(); }
  if (q.when === 'today') { where.push('f.due_at < $end'); p.end = sqlNow(new Date(Date.now() + 24 * 3600000)); }
  if (q.when === 'upcoming') { where.push('f.due_at >= $now'); p.now = sqlNow(); }
  res.json(db.all(
    `SELECT f.*, l.name AS lead_name, l.phone, l.status AS lead_status, u.name AS user_name FROM followups f
     JOIN leads l ON l.id = f.lead_id LEFT JOIN users u ON u.id = f.user_id
     WHERE ${where.join(' AND ')} ORDER BY f.due_at ASC LIMIT 500`, p));
}));
router.post('/followups', h((req, res) => {
  const lead = db.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [int(req.body.lead_id), cid(req)]);
  if (!lead) throw notFound('Lead');
  if (!isManager(req.user) && lead.assigned_to && lead.assigned_to !== req.user.id) throw forbidden('This lead belongs to another agent');
  const due = toSqlDate(req.body.due_at);
  if (!due) throw bad('Choose a date and time');
  const userId = isManager(req.user) && req.body.user_id ? int(req.body.user_id) : req.user.id;
  const id = db.insert('followups', { company_id: cid(req), lead_id: lead.id, user_id: userId, due_at: due, note: req.body.note || null },
    ['company_id', 'lead_id', 'user_id', 'due_at', 'note']);
  db.run("UPDATE leads SET next_call_at = ?, status = CASE WHEN status IN ('new','contacted') THEN 'follow_up' ELSE status END, updated_at = ? WHERE id = ?", [due, sqlNow(), lead.id]);
  activity(cid(req), lead.id, req.user.id, 'followup', `Follow-up scheduled for ${due} UTC${req.body.note ? ': ' + req.body.note : ''}`);
  res.status(201).json(db.get('SELECT * FROM followups WHERE id = ?', [id]));
}));
router.put('/followups/:id', h((req, res) => {
  const f = db.get('SELECT * FROM followups WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!f) throw notFound('Follow-up');
  if (!isManager(req.user) && f.user_id !== req.user.id) throw forbidden();
  const patch = {};
  if (req.body.status) { if (!['pending', 'done', 'cancelled'].includes(req.body.status)) throw bad('Invalid status'); patch.status = req.body.status; }
  if (req.body.due_at) patch.due_at = toSqlDate(req.body.due_at);
  if (req.body.note !== undefined) patch.note = req.body.note;
  db.update('followups', f.id, patch, ['status', 'due_at', 'note']);
  if (patch.due_at) db.run('UPDATE leads SET next_call_at = ? WHERE id = ?', [patch.due_at, f.lead_id]);
  if (patch.status === 'done') activity(cid(req), f.lead_id, req.user.id, 'followup', 'Follow-up completed');
  res.json(db.get('SELECT * FROM followups WHERE id = ?', [f.id]));
}));

// ------------------------------------------------------------ DNC
router.get('/dnc', requireRole('manager'), h((req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  const rows = db.all('SELECT * FROM dnc WHERE company_id = ? AND phone LIKE ? ORDER BY id DESC LIMIT 1000', [cid(req), q]);
  if (req.query.format === 'csv') return sendCsv(res, 'dnc.csv', rows, ['phone', 'reason', 'created_at']);
  res.json(rows);
}));
router.post('/dnc', h((req, res) => {
  // Agents can add (customer asked not to be called); only managers can remove.
  const list = Array.isArray(req.body.phones) ? req.body.phones : String(req.body.phones || req.body.phone || '').split(/[\s,;]+/);
  let added = 0;
  for (const raw of list) {
    const phone = cleanPhone(raw);
    if (!isValidPhone(phone)) continue;
    const r = db.run('INSERT OR IGNORE INTO dnc (company_id, phone, phone_key, reason) VALUES (?,?,?,?)', [cid(req), phone, phoneKey(phone), req.body.reason || null]);
    if (r.changes) {
      added++;
      db.run("UPDATE leads SET status = 'dnc' WHERE company_id = ? AND phone_key = ?", [cid(req), phoneKey(phone)]);
    }
  }
  audit(req, 'dnc.add', { added });
  res.json({ ok: true, added });
}));
router.delete('/dnc/:id', requireRole('manager'), h((req, res) => {
  const r = db.get('SELECT * FROM dnc WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!r) throw notFound('Entry');
  db.run('DELETE FROM dnc WHERE id = ?', [r.id]);
  audit(req, 'dnc.remove', { phone: r.phone });
  res.json({ ok: true });
}));

// ------------------------------------------------------------ message templates
router.get('/templates', h((req, res) => res.json(db.all('SELECT * FROM templates WHERE company_id = ? ORDER BY channel, name', [cid(req)]))));
router.post('/templates', requireRole('manager'), h((req, res) => {
  const { name, channel = 'whatsapp', body } = req.body;
  if (!name || !body) throw bad('Name and message are required');
  if (!['sms', 'whatsapp', 'email'].includes(channel)) throw bad('Invalid channel');
  const id = db.insert('templates', { company_id: cid(req), name, channel, body }, ['company_id', 'name', 'channel', 'body']);
  res.status(201).json(db.get('SELECT * FROM templates WHERE id = ?', [id]));
}));
router.put('/templates/:id', requireRole('manager'), h((req, res) => {
  const t = db.get('SELECT id FROM templates WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!t) throw notFound('Template');
  if (req.body.channel && !['sms', 'whatsapp', 'email'].includes(req.body.channel)) throw bad('Invalid channel');
  db.update('templates', t.id, req.body, ['name', 'channel', 'body']);
  res.json(db.get('SELECT * FROM templates WHERE id = ?', [t.id]));
}));
router.delete('/templates/:id', requireRole('manager'), h((req, res) => {
  db.run('DELETE FROM templates WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  res.json({ ok: true });
}));
/** Render a template for a lead and log it on the lead timeline. */
router.post('/templates/:id/render', h((req, res) => {
  const t = db.get('SELECT * FROM templates WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!t) throw notFound('Template');
  const lead = req.body.lead_id ? db.get('SELECT * FROM leads WHERE id = ? AND company_id = ?', [int(req.body.lead_id), cid(req)]) : {};
  const agent = db.get('SELECT name, phone FROM users WHERE id = ?', [req.user.id]);
  const text = renderTemplate(t.body, lead || {}, agent, req.user.company);
  if (lead && lead.id && req.body.log) activity(cid(req), lead.id, req.user.id, t.channel, `Sent ${t.channel.toUpperCase()}: ${text.slice(0, 500)}`);
  res.json({ text, phone: lead?.phone || null, channel: t.channel });
}));

// ------------------------------------------------------------ support tickets
const TICKET_FIELDS = ['subject', 'description', 'priority', 'status', 'assigned_to', 'lead_id', 'updated_at'];
router.get('/tickets', h((req, res) => {
  const q = req.query;
  const where = ['t.company_id = $cid'];
  const p = { cid: cid(req) };
  if (!isManager(req.user)) { where.push('(t.assigned_to = $me OR t.created_by = $me)'); p.me = req.user.id; }
  if (q.status) { where.push('t.status = $st'); p.st = q.status; }
  if (q.priority) { where.push('t.priority = $pr'); p.pr = q.priority; }
  if (q.lead_id) { where.push('t.lead_id = $lid'); p.lid = int(q.lead_id); }
  if (q.q) { where.push('(t.subject LIKE $q OR l.name LIKE $q OR l.phone LIKE $q)'); p.q = `%${q.q}%`; }
  res.json(db.all(
    `SELECT t.*, l.name AS lead_name, l.phone AS lead_phone, u.name AS assigned_name, cb.name AS created_by_name
     FROM tickets t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users cb ON cb.id = t.created_by
     WHERE ${where.join(' AND ')} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.id DESC LIMIT 500`, p));
}));
function ticketData(req, b) {
  const d = {};
  if (b.subject !== undefined) d.subject = String(b.subject).trim();
  if (b.description !== undefined) d.description = b.description;
  if (b.priority !== undefined) { if (!['low', 'medium', 'high', 'urgent'].includes(b.priority)) throw bad('Invalid priority'); d.priority = b.priority; }
  if (b.status !== undefined) { if (!['open', 'in_progress', 'resolved', 'closed'].includes(b.status)) throw bad('Invalid status'); d.status = b.status; }
  if (b.assigned_to !== undefined) {
    if (b.assigned_to && !db.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [b.assigned_to, cid(req)])) throw bad('Invalid user');
    d.assigned_to = b.assigned_to || null;
  }
  if (b.lead_id !== undefined) {
    if (b.lead_id && !db.get('SELECT id FROM leads WHERE id = ? AND company_id = ?', [b.lead_id, cid(req)])) throw bad('Invalid lead');
    d.lead_id = b.lead_id || null;
  }
  return d;
}
router.post('/tickets', h((req, res) => {
  const d = ticketData(req, req.body);
  if (!d.subject) throw bad('Subject is required');
  Object.assign(d, { company_id: cid(req), created_by: req.user.id });
  if (d.assigned_to === undefined) d.assigned_to = req.user.id;
  const id = db.insert('tickets', d, ['company_id', 'created_by', ...TICKET_FIELDS]);
  if (d.lead_id) activity(cid(req), d.lead_id, req.user.id, 'ticket', `Ticket #${id} opened: ${d.subject}`);
  res.status(201).json(db.get('SELECT * FROM tickets WHERE id = ?', [id]));
}));
router.put('/tickets/:id', h((req, res) => {
  const t = db.get('SELECT * FROM tickets WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!t) throw notFound('Ticket');
  if (!isManager(req.user) && t.assigned_to !== req.user.id && t.created_by !== req.user.id) throw forbidden();
  const d = ticketData(req, req.body);
  d.updated_at = sqlNow();
  db.update('tickets', t.id, d, TICKET_FIELDS);
  if (d.status && d.status !== t.status && t.lead_id) activity(cid(req), t.lead_id, req.user.id, 'ticket', `Ticket #${t.id} → ${d.status}`);
  res.json(db.get('SELECT * FROM tickets WHERE id = ?', [t.id]));
}));

// ------------------------------------------------------------ webhooks
router.get('/webhooks', requireRole('admin'), h((req, res) => res.json(db.all('SELECT * FROM webhooks WHERE company_id = ?', [cid(req)]))));
router.post('/webhooks', requireRole('admin'), h((req, res) => {
  const url = String(req.body.url || '');
  if (!/^https?:\/\//.test(url)) throw bad('Enter a valid http(s) URL');
  const id = db.insert('webhooks', { company_id: cid(req), url, events: req.body.events || '*', secret: req.body.secret || randomKey('whsec') },
    ['company_id', 'url', 'events', 'secret']);
  audit(req, 'webhook.create', { url });
  res.status(201).json(db.get('SELECT * FROM webhooks WHERE id = ?', [id]));
}));
router.put('/webhooks/:id', requireRole('admin'), h((req, res) => {
  const w = db.get('SELECT id FROM webhooks WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!w) throw notFound('Webhook');
  const b = { ...req.body };
  if (b.url !== undefined && !/^https?:\/\//.test(b.url)) throw bad('Enter a valid http(s) URL');
  if (b.active !== undefined) b.active = bool(b.active);
  db.update('webhooks', w.id, b, ['url', 'events', 'active']);
  res.json(db.get('SELECT * FROM webhooks WHERE id = ?', [w.id]));
}));
router.delete('/webhooks/:id', requireRole('admin'), h((req, res) => {
  db.run('DELETE FROM webhooks WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------ audit log
router.get('/audit', requireRole('admin'), h((req, res) => {
  const limit = Math.min(1000, int(req.query.limit, 200));
  res.json(db.all(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.company_id = ? ORDER BY a.id DESC LIMIT ${limit}`, [cid(req)]));
}));

module.exports = router;
