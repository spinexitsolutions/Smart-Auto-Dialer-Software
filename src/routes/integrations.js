'use strict';
/**
 * Integrations API: lead sources, WhatsApp/SMS providers, AI settings,
 * automation rules and message log. Secrets are masked in responses.
 */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { h, bad, notFound, int, bool, audit, sqlNow } = require('../util');
const sources = require('../leadsources');
const messaging = require('../messaging');
const ai = require('../ai');

const router = express.Router();
const cid = (req) => req.user.company_id;
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const TYPES = {
  ...Object.fromEntries(Object.entries(sources.SOURCES).map(([k, v]) => [k, { group: 'source', label: v.label }])),
  wa_cloud: { group: 'whatsapp', label: 'WhatsApp Cloud API (Meta)', secrets: ['access_token'] },
  wa_http: { group: 'whatsapp', label: 'WhatsApp via provider HTTP API (Interakt, AiSensy, Gupshup, Wati…)', secrets: [] },
  sms_msg91: { group: 'sms', label: 'MSG91 SMS (DLT Flow)', secrets: ['authkey'] },
  sms_http: { group: 'sms', label: 'SMS via gateway HTTP API', secrets: [] },
  ai: { group: 'ai', label: 'AI call analysis', secrets: ['stt_key', 'anthropic_key'] },
};
const SOURCE_SECRETS = ['page_token', 'app_secret', 'crm_key'];

function mask(v) { return v ? `••••${String(v).slice(-4)}` : ''; }

function present(row, req) {
  const config = parseJson(row.config, {});
  const secretKeys = [...(TYPES[row.type]?.secrets || []), ...SOURCE_SECRETS];
  const safe = { ...config };
  for (const k of secretKeys) if (safe[k]) safe[k] = mask(safe[k]);
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    ...row, config: safe, agent_ids: parseJson(row.agent_ids, []),
    webhook_url: TYPES[row.type]?.group === 'source' ? `${base}/api/hooks/${row.token}` : null,
    secrets_set: Object.fromEntries(secretKeys.filter((k) => config[k]).map((k) => [k, true])),
  };
}

/** Merge new config, keeping existing secrets when the masked placeholder is sent back. */
function mergeConfig(oldCfg, incoming) {
  const out = { ...oldCfg };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (typeof v === 'string' && v.startsWith('••••')) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

router.get('/', requireRole('manager'), h((req, res) => {
  const rows = db.all('SELECT * FROM integrations WHERE company_id = ? ORDER BY id', [cid(req)]);
  res.json({ types: TYPES, models: ai.MODELS, items: rows.map((r) => present(r, req)) });
}));

router.post('/', requireRole('admin'), h((req, res) => {
  const { type } = req.body;
  if (!TYPES[type]) throw bad('Unknown integration type');
  if (type === 'ai' && db.get("SELECT id FROM integrations WHERE company_id = ? AND type = 'ai'", [cid(req)])) throw bad('AI is already configured — edit it instead');
  const config = mergeConfig({}, req.body.config);
  if (type === 'facebook' && !config.verify_token) config.verify_token = sources.newToken().slice(0, 16);
  const id = db.insert('integrations', {
    company_id: cid(req), type, name: String(req.body.name || TYPES[type].label).slice(0, 120), token: sources.newToken(),
    config: JSON.stringify(config), campaign_id: req.body.campaign_id ? int(req.body.campaign_id) : null,
    agent_ids: JSON.stringify(Array.isArray(req.body.agent_ids) ? req.body.agent_ids.map(Number) : []),
    active: req.body.active === undefined ? 1 : bool(req.body.active),
  }, ['company_id', 'type', 'name', 'token', 'config', 'campaign_id', 'agent_ids', 'active']);
  audit(req, 'integration.create', { id, type });
  res.status(201).json(present(db.get('SELECT * FROM integrations WHERE id = ?', [id]), req));
}));

function loadRow(req) {
  const row = db.get('SELECT * FROM integrations WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!row) throw notFound('Integration');
  return row;
}

router.put('/:id', requireRole('admin'), h((req, res) => {
  const row = loadRow(req);
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).slice(0, 120);
  if (req.body.config !== undefined) patch.config = JSON.stringify(mergeConfig(parseJson(row.config, {}), req.body.config));
  if (req.body.campaign_id !== undefined) {
    if (req.body.campaign_id && !db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [int(req.body.campaign_id), cid(req)])) throw bad('Invalid campaign');
    patch.campaign_id = req.body.campaign_id ? int(req.body.campaign_id) : null;
  }
  if (req.body.agent_ids !== undefined) patch.agent_ids = JSON.stringify((req.body.agent_ids || []).map(Number));
  if (req.body.active !== undefined) patch.active = bool(req.body.active);
  db.update('integrations', row.id, patch, ['name', 'config', 'campaign_id', 'agent_ids', 'active']);
  audit(req, 'integration.update', { id: row.id, type: row.type });
  res.json(present(db.get('SELECT * FROM integrations WHERE id = ?', [row.id]), req));
}));

router.delete('/:id', requireRole('admin'), h((req, res) => {
  const row = loadRow(req);
  db.run('DELETE FROM integrations WHERE id = ?', [row.id]);
  audit(req, 'integration.delete', { id: row.id, type: row.type });
  res.json({ ok: true });
}));

/** Lead sources: inject a sample lead to prove the pipeline works. */
router.post('/:id/test', requireRole('manager'), h(async (req, res) => {
  const row = sources.load(loadRow(req));
  const group = TYPES[row.type]?.group;
  if (group === 'source') {
    const sample = { ...sources.SAMPLES[row.type], tags: 'Test lead' };
    return res.json({ ok: true, result: sources.captureLead(row, sample) });
  }
  if (group === 'whatsapp' || group === 'sms') {
    const phone = String(req.body.phone || '').trim();
    if (!phone) throw bad('Enter a phone number to send the test message to');
    const ref = await messaging.deliver(cid(req), {
      channel: group, phone, body: req.body.text || 'Test message from your auto dialer',
      provider_template: req.body.provider_template || null, provider_lang: req.body.provider_lang || null,
      provider_params: JSON.stringify(messaging.renderParams(req.body.provider_params || '', { name: 'Test' }, {}, {})),
    });
    return res.json({ ok: true, ref });
  }
  throw bad('Nothing to test for this integration');
}));

router.post('/:id/sync', requireRole('manager'), h(async (req, res) => {
  const row = sources.load(loadRow(req));
  if (row.type !== 'indiamart') throw bad('Only IndiaMART supports manual sync');
  try {
    const r = await sources.pullIndiaMart(row);
    res.json({ ok: true, ...r });
  } catch (e) {
    db.run('UPDATE integrations SET last_error = ? WHERE id = ?', [String(e.message).slice(0, 300), row.id]);
    throw bad(e.message);
  }
}));

// ------------------------------------------------------------------ automations
const AUTO_FIELDS = ['name', 'trigger', 'disposition_id', 'campaign_id', 'channel', 'template_id', 'provider_template', 'provider_lang', 'provider_params', 'delay_minutes', 'active'];
function autoData(req, b) {
  const d = {};
  if (b.name !== undefined) d.name = String(b.name).trim().slice(0, 120);
  if (b.trigger !== undefined) { if (!['disposition', 'missed_call', 'lead_created'].includes(b.trigger)) throw bad('Invalid trigger'); d.trigger = b.trigger; }
  if (b.channel !== undefined) { if (!['whatsapp', 'sms'].includes(b.channel)) throw bad('Invalid channel'); d.channel = b.channel; }
  const ref = (k, table) => {
    if (b[k] === undefined) return;
    if (b[k] && !db.get(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`, [int(b[k]), cid(req)])) throw bad(`Invalid ${k.replace('_id', '')}`);
    d[k] = b[k] ? int(b[k]) : null;
  };
  ref('disposition_id', 'dispositions'); ref('campaign_id', 'campaigns'); ref('template_id', 'templates');
  for (const k of ['provider_template', 'provider_lang', 'provider_params']) if (b[k] !== undefined) d[k] = String(b[k] || '').trim() || null;
  if (b.delay_minutes !== undefined) d.delay_minutes = Math.max(0, Math.min(10080, int(b.delay_minutes)));
  if (b.active !== undefined) d.active = bool(b.active);
  return d;
}
router.get('/automations', requireRole('manager'), h((req, res) => {
  res.json(db.all(
    `SELECT a.*, d.name AS disposition_name, c.name AS campaign_name, t.name AS template_name,
       (SELECT COUNT(*) FROM message_logs m WHERE m.automation_id = a.id AND m.status IN ('sent','simulated')) AS sent_count
     FROM automations a LEFT JOIN dispositions d ON d.id = a.disposition_id LEFT JOIN campaigns c ON c.id = a.campaign_id LEFT JOIN templates t ON t.id = a.template_id
     WHERE a.company_id = ? ORDER BY a.id`, [cid(req)]));
}));
router.post('/automations', requireRole('manager'), h((req, res) => {
  const d = autoData(req, req.body);
  if (!d.name || !d.trigger || !d.channel) throw bad('Name, trigger and channel are required');
  if (!d.template_id && !d.provider_template) throw bad('Choose a message template (or a provider template name)');
  d.company_id = cid(req);
  const id = db.insert('automations', d, ['company_id', ...AUTO_FIELDS]);
  audit(req, 'automation.create', { id });
  res.status(201).json(db.get('SELECT * FROM automations WHERE id = ?', [id]));
}));
router.put('/automations/:id', requireRole('manager'), h((req, res) => {
  const a = db.get('SELECT id FROM automations WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  if (!a) throw notFound('Automation');
  db.update('automations', a.id, autoData(req, req.body), AUTO_FIELDS);
  res.json(db.get('SELECT * FROM automations WHERE id = ?', [a.id]));
}));
router.delete('/automations/:id', requireRole('manager'), h((req, res) => {
  db.run('DELETE FROM automations WHERE id = ? AND company_id = ?', [int(req.params.id), cid(req)]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ message log
router.get('/messages', requireRole('manager'), h((req, res) => {
  const where = ['m.company_id = $cid'];
  const p = { cid: cid(req) };
  if (req.query.status) { where.push('m.status = $st'); p.st = req.query.status; }
  if (req.query.channel) { where.push('m.channel = $ch'); p.ch = req.query.channel; }
  if (req.query.lead_id) { where.push('m.lead_id = $lid'); p.lid = int(req.query.lead_id); }
  res.json(db.all(
    `SELECT m.*, l.name AS lead_name, a.name AS automation_name FROM message_logs m
     LEFT JOIN leads l ON l.id = m.lead_id LEFT JOIN automations a ON a.id = m.automation_id
     WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 300`, p));
}));
router.post('/messages/:id/retry', requireRole('manager'), h(async (req, res) => {
  const r = db.run("UPDATE message_logs SET status = 'queued', attempts = 0, due_at = ? WHERE id = ? AND company_id = ? AND status = 'failed'", [sqlNow(), int(req.params.id), cid(req)]);
  if (!r.changes) throw bad('Only failed messages can be retried');
  await messaging.processQueue();
  res.json({ ok: true });
}));

module.exports = router;

// ------------------------------------------------------------------ public webhook receiver
const hooksRouter = express.Router();
const { licenseProblem } = require('../auth');
hooksRouter.all('/:token', h(async (req, res) => {
  const integ = sources.byToken(req.params.token);
  if (!integ || !TYPES[integ.type] || TYPES[integ.type].group !== 'source') return res.status(404).json({ error: 'Unknown webhook' });
  const company = db.get('SELECT * FROM companies WHERE id = ?', [integ.company_id]);
  const problem = licenseProblem(company);
  if (problem) return res.status(402).json({ error: problem });
  if (!integ.active) return res.status(410).json({ error: 'This lead source is disabled' });
  let out;
  try {
    out = await sources.handleHook(integ, req);
  } catch (e) {
    db.run('UPDATE integrations SET last_error = ? WHERE id = ?', [String(e.message).slice(0, 300), integ.id]);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({ ok: false, error: e.message });
  }
  if (out.redirect) return res.redirect(out.status, out.redirect);
  if (out.text !== undefined) return res.status(out.status).type('text').send(out.text);
  res.status(out.status).json(out.json);
}));
module.exports.hooksRouter = hooksRouter;
module.exports.TYPES = TYPES;
