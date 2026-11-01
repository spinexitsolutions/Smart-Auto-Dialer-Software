'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const dialer = require('../dialer');
const { requireRole, isManager } = require('../auth');
const { getSettings } = require('../settings');
const {
  h, bad, notFound, forbidden, audit, int, num, cleanPhone, phoneKey, isValidPhone, parseCsv, sendCsv, sqlNow, toSqlDate, activity,
} = require('../util');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const EDITABLE = ['name', 'phone', 'phone_key', 'alt_phone', 'email', 'company_name', 'city', 'state', 'source', 'status', 'priority',
  'assigned_to', 'tags', 'custom', 'deal_value', 'amount_due', 'due_date', 'ptp_date', 'ptp_amount', 'campaign_id', 'next_call_at', 'updated_at'];

const ALIASES = {
  name: ['name', 'full name', 'customer name', 'customer', 'lead name', 'contact name', 'naam'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'number', 'contact', 'contact number', 'mobile no', 'phone no', 'cell'],
  alt_phone: ['alt phone', 'alternate phone', 'alternate number', 'phone 2', 'mobile 2', 'alt_phone', 'whatsapp'],
  email: ['email', 'email id', 'e-mail', 'mail'],
  company_name: ['company', 'company name', 'organisation', 'organization', 'business', 'firm'],
  city: ['city', 'location', 'town'],
  state: ['state', 'region'],
  source: ['source', 'lead source', 'channel'],
  tags: ['tags', 'tag', 'labels'],
  priority: ['priority'],
  deal_value: ['deal value', 'deal_value', 'value', 'budget'],
  amount_due: ['amount due', 'amount_due', 'due amount', 'outstanding', 'emi', 'balance', 'pending amount'],
  due_date: ['due date', 'due_date', 'emi date'],
  status: ['status', 'lead status'],
};

function mapRow(raw) {
  const lead = { custom: {} };
  const used = new Set();
  const lower = Object.fromEntries(Object.keys(raw).map((k) => [k.toLowerCase().replace(/[_\s]+/g, ' ').trim(), k]));
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const key = lower[n.replace(/_/g, ' ')];
      if (key !== undefined && raw[key] !== '' && lead[field] === undefined) { lead[field] = raw[key]; used.add(key); break; }
    }
  }
  for (const [k, v] of Object.entries(raw)) if (!used.has(k) && v !== '' && k) lead.custom[k] = v;
  return lead;
}

/** Visibility filter for agents: their assigned leads or leads they have called. */
function scope(req, alias = 'l') {
  if (isManager(req.user)) return { sql: '', params: {} };
  return {
    sql: ` AND (${alias}.assigned_to = $me OR EXISTS (SELECT 1 FROM calls cc WHERE cc.lead_id = ${alias}.id AND cc.user_id = $me))`,
    params: { me: req.user.id },
  };
}

function mask(req, lead) {
  if (!lead || isManager(req.user)) return lead;
  if (!getSettings(req.user.company_id).mask_phone_for_agents) return lead;
  const m = (p) => (p && p.length > 6 ? p.slice(0, 3) + 'X'.repeat(p.length - 7) + p.slice(-4) : p);
  return { ...lead, phone: m(lead.phone), alt_phone: m(lead.alt_phone), phone_masked: true };
}

function parseCustom(l) {
  if (!l) return l;
  try { l.custom = JSON.parse(l.custom || '{}'); } catch { l.custom = {}; }
  return l;
}

function loadLead(req, id = req.params.id) {
  const s = scope(req);
  const lead = db.get(`SELECT l.* FROM leads l WHERE l.id = $id AND l.company_id = $cid ${s.sql}`, { id: int(id), cid: req.user.company_id, ...s.params });
  if (!lead) throw notFound('Lead');
  return lead;
}

function buildFilters(req) {
  const q = req.query;
  const where = ['l.company_id = $cid'];
  const p = { cid: req.user.company_id };
  if (q.q) {
    where.push('(l.name LIKE $q OR l.phone LIKE $q OR l.email LIKE $q OR l.company_name LIKE $q OR l.city LIKE $q OR l.tags LIKE $q)');
    p.q = `%${q.q}%`;
  }
  if (q.status) {
    const list = String(q.status).split(',');
    where.push(`l.status IN (${list.map((_, i) => '$st' + i).join(',')})`);
    list.forEach((s, i) => { p['st' + i] = s; });
  }
  if (q.campaign_id) {
    if (q.campaign_id === 'none') where.push('l.campaign_id IS NULL');
    else { where.push('l.campaign_id = $camp'); p.camp = int(q.campaign_id); }
  }
  if (q.assigned_to) {
    if (q.assigned_to === 'none') where.push('l.assigned_to IS NULL');
    else { where.push('l.assigned_to = $asg'); p.asg = int(q.assigned_to); }
  }
  if (q.source) { where.push('l.source = $src'); p.src = q.source; }
  if (q.tag) { where.push('l.tags LIKE $tag'); p.tag = `%${q.tag}%`; }
  if (q.from) { where.push('l.created_at >= $from'); p.from = toSqlDate(q.from); }
  if (q.to) { where.push('l.created_at < $to'); p.to = toSqlDate(new Date(new Date(q.to).getTime() + 86400000)); }
  if (q.due === '1') { where.push('l.next_call_at IS NOT NULL AND l.next_call_at <= $now'); p.now = sqlNow(); }
  if (q.never_called === '1') where.push('l.attempts = 0');
  const s = scope(req);
  return { where: where.join(' AND ') + s.sql, params: { ...p, ...s.params } };
}

const SORTS = { created: 'l.created_at DESC', updated: 'l.updated_at DESC', name: 'l.name COLLATE NOCASE ASC', priority: 'l.priority DESC, l.id DESC', next_call: 'l.next_call_at IS NULL, l.next_call_at ASC', last_called: 'l.last_called_at DESC' };

router.get('/', h((req, res) => {
  const { where, params } = buildFilters(req);
  const limit = Math.min(500, Math.max(1, int(req.query.limit, 50)));
  const page = Math.max(1, int(req.query.page, 1));
  const order = SORTS[req.query.sort] || SORTS.created;
  const total = db.get(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`, params).n;
  const rows = db.all(
    `SELECT l.*, u.name AS assigned_name, c.name AS campaign_name FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params
  );
  res.json({ total, page, limit, rows: rows.map((r) => mask(req, parseCustom(r))) });
}));

/** Pipeline (Kanban) board: leads grouped by status. */
router.get('/board', h((req, res) => {
  const { where, params } = buildFilters({ ...req, query: { ...req.query, status: '' } });
  const settings = getSettings(req.user.company_id);
  const show = req.query.statuses ? String(req.query.statuses).split(',').filter((s) => settings.lead_statuses.includes(s))
    : settings.lead_statuses.filter((s) => !['dnc', 'invalid'].includes(s));
  const limit = Math.min(200, Math.max(10, int(req.query.limit, 50)));
  const columns = show.map((status) => {
    const p = { ...params, bst: status };
    const agg = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(l.deal_value),0) AS value, COALESCE(SUM(l.amount_due),0) AS due FROM leads l WHERE ${where} AND l.status = $bst`, p);
    const rows = db.all(
      `SELECT l.id, l.name, l.phone, l.status, l.city, l.priority, l.deal_value, l.amount_due, l.last_disposition, l.last_called_at, l.next_call_at,
         l.attempts, l.tags, l.source, u.name AS assigned_name, c.name AS campaign_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN campaigns c ON c.id = l.campaign_id
       WHERE ${where} AND l.status = $bst ORDER BY l.priority DESC, l.updated_at DESC LIMIT ${limit}`, p);
    return { status, count: agg.n, value: agg.value, due: agg.due, rows: rows.map((r) => mask(req, r)) };
  });
  res.json({ columns });
}));

router.get('/export', requireRole('manager'), h((req, res) => {
  const { where, params } = buildFilters(req);
  const rows = db.all(
    `SELECT l.id, l.name, l.phone, l.alt_phone, l.email, l.company_name, l.city, l.state, l.source, l.status, l.priority,
       u.name AS assigned_to, c.name AS campaign, l.tags, l.deal_value, l.amount_due, l.due_date, l.ptp_date, l.ptp_amount,
       l.attempts, l.last_disposition, l.last_called_at, l.next_call_at, l.created_at, l.custom
     FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE ${where} ORDER BY l.id`,
    params
  );
  audit(req, 'lead.export', { count: rows.length });
  sendCsv(res, `leads-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}));

router.get('/:id', h((req, res) => {
  const lead = parseCustom(loadLead(req));
  const calls = db.all(
    `SELECT c.*, u.name AS agent_name, ca.status AS ai_status, ca.quality_score AS ai_score, ca.sentiment AS ai_sentiment, ca.summary AS ai_summary
     FROM calls c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN call_ai ca ON ca.call_id = c.id WHERE c.lead_id = ? ORDER BY c.id DESC LIMIT 100`,
    [lead.id]
  );
  const activities = db.all(
    `SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.id DESC LIMIT 200`,
    [lead.id]
  );
  const followups = db.all(
    `SELECT f.*, u.name AS user_name FROM followups f LEFT JOIN users u ON u.id = f.user_id WHERE f.lead_id = ? ORDER BY f.due_at DESC`,
    [lead.id]
  );
  const tickets = db.all('SELECT * FROM tickets WHERE lead_id = ? ORDER BY id DESC', [lead.id]);
  const assigned = lead.assigned_to ? db.get('SELECT id, name FROM users WHERE id = ?', [lead.assigned_to]) : null;
  const campaign = lead.campaign_id ? db.get('SELECT id, name, type, script FROM campaigns WHERE id = ?', [lead.campaign_id]) : null;
  const duplicates = db.all('SELECT id, name, phone, status FROM leads WHERE company_id = ? AND phone_key = ? AND id != ? LIMIT 10',
    [req.user.company_id, lead.phone_key, lead.id]);
  const dnc = !!db.get('SELECT 1 AS x FROM dnc WHERE company_id = ? AND phone_key = ?', [req.user.company_id, lead.phone_key]);
  res.json({
    ...mask(req, lead), assigned, campaign, calls: calls.map((c) => (mask(req, c))), activities, followups, tickets, duplicates, dnc,
  });
}));

function prepare(req, b, existing) {
  const out = {};
  const s = getSettings(req.user.company_id);
  if (b.phone !== undefined) {
    const phone = cleanPhone(b.phone);
    if (!isValidPhone(phone)) throw bad('Enter a valid phone number');
    out.phone = phone;
    out.phone_key = phoneKey(phone);
  }
  if (b.alt_phone !== undefined) out.alt_phone = b.alt_phone ? cleanPhone(b.alt_phone) : null;
  for (const k of ['name', 'email', 'company_name', 'city', 'state', 'source', 'tags']) if (b[k] !== undefined) out[k] = b[k] === null ? null : String(b[k]).trim();
  if (b.status !== undefined) {
    if (!s.lead_statuses.includes(b.status)) throw bad('Invalid status');
    out.status = b.status;
  }
  if (b.priority !== undefined) out.priority = int(b.priority, 0);
  for (const k of ['deal_value', 'amount_due', 'ptp_amount']) if (b[k] !== undefined) out[k] = num(b[k]);
  for (const k of ['due_date', 'ptp_date']) if (b[k] !== undefined) out[k] = b[k] || null;
  if (b.next_call_at !== undefined) out.next_call_at = toSqlDate(b.next_call_at);
  if (b.custom !== undefined) {
    const base = existing ? JSON.parse(existing.custom || '{}') : {};
    out.custom = JSON.stringify({ ...base, ...(typeof b.custom === 'object' && b.custom ? b.custom : {}) });
  }
  if (isManager(req.user)) {
    if (b.assigned_to !== undefined) {
      if (b.assigned_to && !db.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [b.assigned_to, req.user.company_id])) throw bad('Invalid agent');
      out.assigned_to = b.assigned_to || null;
    }
    if (b.campaign_id !== undefined) {
      if (b.campaign_id && !db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [b.campaign_id, req.user.company_id])) throw bad('Invalid campaign');
      out.campaign_id = b.campaign_id || null;
    }
  } else if (!existing) {
    out.assigned_to = req.user.id;
    if (b.campaign_id && db.get('SELECT 1 AS x FROM campaign_agents WHERE campaign_id = ? AND user_id = ?', [b.campaign_id, req.user.id])) out.campaign_id = b.campaign_id;
  }
  return out;
}

router.post('/', h((req, res) => {
  if (req.user.role === 'agent' && !getSettings(req.user.company_id).allow_agent_lead_create) throw forbidden('Agents cannot create leads');
  if (!req.body.phone) throw bad('Phone number is required');
  const data = prepare(req, req.body);
  data.company_id = req.user.company_id;
  if (!data.custom) data.custom = '{}';
  if (!req.body.allow_duplicate) {
    const dup = db.get('SELECT id, name FROM leads WHERE company_id = ? AND phone_key = ?', [req.user.company_id, data.phone_key]);
    if (dup) return res.status(409).json({ error: `Duplicate: this number already exists (${dup.name || 'Lead #' + dup.id})`, duplicate_id: dup.id });
  }
  const id = db.insert('leads', data, ['company_id', ...EDITABLE]);
  activity(req.user.company_id, id, req.user.id, 'created', `Lead created${data.source ? ' from ' + data.source : ''}`);
  dialer.fireWebhook(req.user.company_id, 'lead.created', db.get('SELECT * FROM leads WHERE id = ?', [id]));
  res.status(201).json(parseCustom(db.get('SELECT * FROM leads WHERE id = ?', [id])));
}));

router.put('/:id', h((req, res) => {
  const lead = loadLead(req);
  const data = prepare(req, req.body, lead);
  if (getSettings(req.user.company_id).mask_phone_for_agents && !isManager(req.user)) { delete data.phone; delete data.phone_key; delete data.alt_phone; }
  data.updated_at = sqlNow();
  db.update('leads', lead.id, data, EDITABLE);
  if (data.status && data.status !== lead.status) {
    activity(req.user.company_id, lead.id, req.user.id, 'status', `Status changed: ${lead.status} → ${data.status}`);
    dialer.fireWebhook(req.user.company_id, 'lead.status_changed', { lead_id: lead.id, from: lead.status, to: data.status, phone: lead.phone, name: lead.name });
  }
  if (data.assigned_to !== undefined && data.assigned_to !== lead.assigned_to) {
    const who = data.assigned_to ? db.get('SELECT name FROM users WHERE id = ?', [data.assigned_to])?.name : 'nobody';
    activity(req.user.company_id, lead.id, req.user.id, 'assign', `Assigned to ${who}`);
  }
  res.json(mask(req, parseCustom(db.get('SELECT * FROM leads WHERE id = ?', [lead.id]))));
}));

router.delete('/:id', requireRole('manager'), h((req, res) => {
  const lead = loadLead(req);
  db.run('DELETE FROM leads WHERE id = ?', [lead.id]);
  audit(req, 'lead.delete', { id: lead.id, phone: lead.phone });
  res.json({ ok: true });
}));

router.post('/:id/notes', h((req, res) => {
  const lead = loadLead(req);
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Note is empty');
  activity(req.user.company_id, lead.id, req.user.id, req.body.type && ['note', 'sms', 'whatsapp', 'email', 'meeting'].includes(req.body.type) ? req.body.type : 'note', text.slice(0, 5000));
  db.run('UPDATE leads SET updated_at = ? WHERE id = ?', [sqlNow(), lead.id]);
  res.status(201).json({ ok: true });
}));

/** Bulk actions: assign, status, campaign, delete, distribute (round robin), dnc. */
router.post('/bulk', requireRole('manager'), h((req, res) => {
  const { action, value } = req.body;
  let ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (req.body.all_matching) {
    req.query = { ...(req.body.filters || {}) };
    const { where, params } = buildFilters(req);
    ids = db.all(`SELECT l.id FROM leads l WHERE ${where}`, params).map((r) => r.id);
  }
  if (!ids.length) throw bad('No leads selected');
  const cid = req.user.company_id;
  const inList = ids.map(() => '?').join(',');
  let changed = 0;
  db.tx(() => {
    if (action === 'assign') {
      if (value && !db.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [value, cid])) throw bad('Invalid agent');
      changed = db.run(`UPDATE leads SET assigned_to = ?, updated_at = ? WHERE company_id = ? AND id IN (${inList})`, [value || null, sqlNow(), cid, ...ids]).changes;
    } else if (action === 'distribute') {
      const agentIds = (Array.isArray(value) ? value : []).map(Number).filter((id) => db.get('SELECT id FROM users WHERE id = ? AND company_id = ? AND active = 1', [id, cid]));
      if (!agentIds.length) throw bad('Select at least one agent');
      ids.forEach((id, i) => { changed += db.run('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ? AND company_id = ?', [agentIds[i % agentIds.length], sqlNow(), id, cid]).changes; });
    } else if (action === 'status') {
      if (!getSettings(cid).lead_statuses.includes(value)) throw bad('Invalid status');
      changed = db.run(`UPDATE leads SET status = ?, updated_at = ? WHERE company_id = ? AND id IN (${inList})`, [value, sqlNow(), cid, ...ids]).changes;
    } else if (action === 'campaign') {
      if (value && !db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [value, cid])) throw bad('Invalid campaign');
      changed = db.run(`UPDATE leads SET campaign_id = ?, attempts = 0, next_call_at = NULL, updated_at = ? WHERE company_id = ? AND id IN (${inList})`, [value || null, sqlNow(), cid, ...ids]).changes;
    } else if (action === 'priority') {
      changed = db.run(`UPDATE leads SET priority = ? WHERE company_id = ? AND id IN (${inList})`, [int(value), cid, ...ids]).changes;
    } else if (action === 'tag') {
      const tag = String(value || '').trim();
      if (!tag) throw bad('Tag is empty');
      for (const l of db.all(`SELECT id, tags FROM leads WHERE company_id = ? AND id IN (${inList})`, [cid, ...ids])) {
        const tags = new Set(String(l.tags || '').split(',').map((t) => t.trim()).filter(Boolean));
        tags.add(tag);
        changed += db.run('UPDATE leads SET tags = ? WHERE id = ?', [[...tags].join(', '), l.id]).changes;
      }
    } else if (action === 'dnc') {
      for (const l of db.all(`SELECT id, phone, phone_key FROM leads WHERE company_id = ? AND id IN (${inList})`, [cid, ...ids])) {
        db.run('INSERT OR IGNORE INTO dnc (company_id, phone, phone_key, reason) VALUES (?,?,?,?)', [cid, l.phone, l.phone_key, 'Bulk action']);
        changed += db.run("UPDATE leads SET status = 'dnc' WHERE id = ?", [l.id]).changes;
      }
    } else if (action === 'delete') {
      if (req.user.role !== 'admin') throw forbidden('Only admins can bulk delete');
      changed = db.run(`DELETE FROM leads WHERE company_id = ? AND id IN (${inList})`, [cid, ...ids]).changes;
    } else throw bad('Unknown action');
  });
  audit(req, 'lead.bulk', { action, count: changed });
  res.json({ ok: true, changed });
}));

/**
 * Import leads from CSV (multipart field "file") or JSON { rows: [...] }.
 * Options: campaign_id, assign ('none' | 'round_robin' | <userId>), agent_ids (for round robin), duplicates ('skip' | 'update' | 'allow'), source.
 */
function importRows(companyId, actorId, rows, opts) {
  const result = { total: rows.length, imported: 0, updated: 0, duplicates: 0, invalid: 0, dnc: 0, errors: [] };
  const campaignId = opts.campaign_id ? int(opts.campaign_id) : null;
  if (campaignId && !db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [campaignId, companyId])) throw bad('Invalid campaign');
  let rr = [];
  if (opts.assign === 'round_robin') {
    rr = (Array.isArray(opts.agent_ids) ? opts.agent_ids : String(opts.agent_ids || '').split(',')).map(Number).filter(Boolean);
    if (!rr.length && campaignId) rr = db.all('SELECT user_id FROM campaign_agents WHERE campaign_id = ?', [campaignId]).map((r) => r.user_id);
    rr = rr.filter((id) => db.get('SELECT id FROM users WHERE id = ? AND company_id = ? AND active = 1', [id, companyId]));
  }
  const fixedAgent = opts.assign && !['none', 'round_robin'].includes(String(opts.assign)) ? int(opts.assign) : null;
  if (fixedAgent && !db.get('SELECT id FROM users WHERE id = ? AND company_id = ?', [fixedAgent, companyId])) throw bad('Invalid agent');
  const mode = ['skip', 'update', 'allow'].includes(opts.duplicates) ? opts.duplicates : 'skip';
  const statuses = getSettings(companyId).lead_statuses;
  const seen = new Set();
  let i = 0;
  db.tx(() => {
    rows.forEach((raw, idx) => {
      const m = raw.phone !== undefined && typeof raw.custom === 'object' ? raw : mapRow(raw);
      const phone = cleanPhone(m.phone);
      if (!isValidPhone(phone)) { result.invalid++; if (result.errors.length < 20) result.errors.push(`Row ${idx + 2}: invalid phone "${m.phone ?? ''}"`); return; }
      const key = phoneKey(phone);
      if (db.get('SELECT 1 AS x FROM dnc WHERE company_id = ? AND phone_key = ?', [companyId, key])) { result.dnc++; return; }
      const existing = db.get('SELECT id FROM leads WHERE company_id = ? AND phone_key = ?', [companyId, key]);
      if ((existing || seen.has(key)) && mode !== 'allow') {
        if (mode === 'update' && existing) {
          const patch = { updated_at: sqlNow() };
          for (const k of ['name', 'email', 'company_name', 'city', 'state', 'source', 'tags']) if (m[k]) patch[k] = String(m[k]).trim();
          if (campaignId) patch.campaign_id = campaignId;
          db.update('leads', existing.id, patch, EDITABLE);
          result.updated++;
        } else result.duplicates++;
        return;
      }
      seen.add(key);
      const assigned = fixedAgent || (rr.length ? rr[i++ % rr.length] : null);
      const status = m.status && statuses.includes(String(m.status).toLowerCase()) ? String(m.status).toLowerCase() : 'new';
      const id = db.insert('leads', {
        company_id: companyId, campaign_id: campaignId, name: m.name ? String(m.name).trim() : null, phone, phone_key: key,
        alt_phone: m.alt_phone ? cleanPhone(m.alt_phone) : null, email: m.email || null, company_name: m.company_name || null,
        city: m.city || null, state: m.state || null, source: m.source || opts.source || 'Import', tags: m.tags || null,
        priority: int(m.priority, 0), deal_value: num(m.deal_value), amount_due: num(m.amount_due), due_date: m.due_date || null,
        status, assigned_to: assigned, custom: JSON.stringify(m.custom || {}),
      }, ['company_id', 'campaign_id', 'name', 'phone', 'phone_key', 'alt_phone', 'email', 'company_name', 'city', 'state', 'source', 'tags', 'priority', 'deal_value', 'amount_due', 'due_date', 'status', 'assigned_to', 'custom']);
      if (actorId) activity(companyId, id, actorId, 'created', 'Imported');
      result.imported++;
    });
  });
  return result;
}

router.post('/import', requireRole('manager'), upload.single('file'), h((req, res) => {
  let rows;
  if (req.file) rows = parseCsv(req.file.buffer.toString('utf8'));
  else if (Array.isArray(req.body.rows)) rows = req.body.rows;
  else throw bad('Upload a CSV file');
  if (!rows.length) throw bad('The file has no data rows');
  if (rows.length > 100000) throw bad('Maximum 100,000 rows per import');
  const result = importRows(req.user.company_id, req.user.id, rows, req.body);
  audit(req, 'lead.import', { imported: result.imported, total: result.total });
  res.json(result);
}));

module.exports = router;
module.exports.importRows = importRows;
