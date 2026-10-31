'use strict';
/**
 * Company settings (tenant admin) and the vendor "Super Admin" console used to
 * sell licences: create client companies, set plans/seats/expiry, suspend.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const dialer = require('../dialer');
const { requireRole } = require('../auth');
const { getSettings, saveSettings } = require('../settings');
const { h, bad, notFound, audit, int, randomKey, sqlNow } = require('../util');
const { seedCompanyDefaults } = require('../defaults');

const settingsRouter = express.Router();

settingsRouter.get('/', h((req, res) => {
  const c = req.user.company;
  const out = { company: { id: c.id, name: c.name, plan: c.plan, max_agents: c.max_agents, expires_at: c.expires_at, contact_name: c.contact_name, contact_email: c.contact_email, contact_phone: c.contact_phone }, settings: getSettings(c.id) };
  if (req.user.role === 'admin') out.api_key = c.api_key;
  out.usage = {
    users: db.get("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1 AND role IN ('agent','manager')", [c.id]).n,
    leads: db.get('SELECT COUNT(*) AS n FROM leads WHERE company_id = ?', [c.id]).n,
    calls: db.get('SELECT COUNT(*) AS n FROM calls WHERE company_id = ?', [c.id]).n,
  };
  res.json(out);
}));

settingsRouter.put('/', requireRole('admin'), h((req, res) => {
  const b = req.body || {};
  if (b.company) {
    const patch = {};
    for (const k of ['name', 'contact_name', 'contact_email', 'contact_phone']) if (b.company[k] !== undefined) patch[k] = String(b.company[k]).trim();
    if (patch.name === '') throw bad('Company name cannot be empty');
    db.update('companies', req.user.company_id, patch, ['name', 'contact_name', 'contact_email', 'contact_phone']);
  }
  const settings = b.settings ? saveSettings(req.user.company_id, b.settings) : getSettings(req.user.company_id);
  audit(req, 'settings.update', Object.keys(b.settings || {}));
  res.json({ ok: true, settings });
}));

settingsRouter.post('/api-key', requireRole('admin'), h((req, res) => {
  const key = randomKey('sad');
  db.run('UPDATE companies SET api_key = ? WHERE id = ?', [key, req.user.company_id]);
  audit(req, 'settings.api_key_rotate');
  res.json({ api_key: key });
}));

// ---------------------------------------------------------------- live monitor
const monitorRouter = express.Router();
monitorRouter.get('/', requireRole('manager'), h((req, res) => res.json(dialer.snapshot(req.user.company_id))));
monitorRouter.post('/agents/:id/:action', requireRole('manager'), h((req, res) => {
  const r = dialer.supervisorAction(req.user, int(req.params.id), req.params.action, req.body?.text);
  if (!r.ok) throw bad(r.message);
  audit(req, `monitor.${req.params.action}`, { agent: int(req.params.id) });
  res.json(r);
}));
monitorRouter.post('/broadcast', requireRole('manager'), h((req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) throw bad('Message is empty');
  const users = db.all("SELECT id FROM users WHERE company_id = ? AND active = 1", [req.user.company_id]);
  for (const u of users) if (u.id !== req.user.id) dialer.supervisorAction(req.user, u.id, 'message', text);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- super admin (vendor)
const superRouter = express.Router();
superRouter.use(requireRole('superadmin'));

const PLANS = {
  starter: { label: 'Starter', max_agents: 5 },
  professional: { label: 'Professional', max_agents: 25 },
  enterprise: { label: 'Enterprise', max_agents: 200 },
  trial: { label: 'Trial', max_agents: 3 },
};

superRouter.get('/plans', (req, res) => res.json(PLANS));

superRouter.get('/companies', h((req, res) => {
  const rows = db.all(
    `SELECT c.id, c.name, c.contact_name, c.contact_email, c.contact_phone, c.plan, c.max_agents, c.expires_at, c.active, c.created_at,
       (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1 AND u.role IN ('agent','manager')) AS users,
       (SELECT COUNT(*) FROM leads l WHERE l.company_id = c.id) AS leads,
       (SELECT COUNT(*) FROM calls k WHERE k.company_id = c.id) AS calls,
       (SELECT COUNT(*) FROM calls k WHERE k.company_id = c.id AND k.started_at >= $since) AS calls_30d,
       (SELECT MAX(last_login_at) FROM users u WHERE u.company_id = c.id) AS last_active
     FROM companies c ORDER BY c.id DESC`, { since: sqlNow(new Date(Date.now() - 30 * 86400000)) });
  res.json(rows);
}));

function companyPatch(b) {
  const patch = {};
  for (const k of ['name', 'contact_name', 'contact_email', 'contact_phone']) if (b[k] !== undefined) patch[k] = String(b[k]).trim();
  if (b.plan !== undefined) { if (!PLANS[b.plan]) throw bad('Invalid plan'); patch.plan = b.plan; }
  if (b.max_agents !== undefined) patch.max_agents = Math.max(1, int(b.max_agents, 5));
  if (b.expires_at !== undefined) {
    if (b.expires_at && !/^\d{4}-\d{2}-\d{2}/.test(b.expires_at)) throw bad('Expiry must be YYYY-MM-DD');
    patch.expires_at = b.expires_at ? String(b.expires_at).slice(0, 10) : null;
  }
  if (b.active !== undefined) patch.active = Number(b.active) ? 1 : 0;
  return patch;
}

superRouter.post('/companies', h((req, res) => {
  const b = req.body;
  if (!b.name) throw bad('Company name is required');
  if (!b.admin_email || !b.admin_password) throw bad('Admin email and password are required');
  if (String(b.admin_password).length < 6) throw bad('Password must be at least 6 characters');
  const email = String(b.admin_email).trim().toLowerCase();
  if (db.get('SELECT id FROM users WHERE email = ?', [email])) throw bad('This admin email is already used');
  const patch = companyPatch({ plan: 'starter', ...b });
  if (b.max_agents === undefined) patch.max_agents = PLANS[patch.plan].max_agents;
  if (patch.expires_at === undefined) patch.expires_at = new Date(Date.now() + (patch.plan === 'trial' ? 14 : 365) * 86400000).toISOString().slice(0, 10);
  const id = db.tx(() => {
    const cidv = db.insert('companies', { ...patch, api_key: randomKey('sad') }, ['name', 'contact_name', 'contact_email', 'contact_phone', 'plan', 'max_agents', 'expires_at', 'active', 'api_key']);
    db.insert('users', { company_id: cidv, name: b.admin_name || b.contact_name || 'Admin', email, role: 'admin', password_hash: bcrypt.hashSync(String(b.admin_password), 10) },
      ['company_id', 'name', 'email', 'role', 'password_hash']);
    seedCompanyDefaults(cidv);
    return cidv;
  });
  audit(req, 'super.company_create', { id, name: b.name });
  res.status(201).json(db.get('SELECT * FROM companies WHERE id = ?', [id]));
}));

superRouter.put('/companies/:id', h((req, res) => {
  const c = db.get('SELECT * FROM companies WHERE id = ?', [int(req.params.id)]);
  if (!c) throw notFound('Company');
  db.update('companies', c.id, companyPatch(req.body), ['name', 'contact_name', 'contact_email', 'contact_phone', 'plan', 'max_agents', 'expires_at', 'active']);
  if (req.body.active !== undefined && !Number(req.body.active)) {
    for (const u of db.all('SELECT id FROM users WHERE company_id = ?', [c.id])) dialer.onUserDisabled(u.id);
  }
  audit(req, 'super.company_update', { id: c.id, ...req.body });
  res.json(db.get('SELECT * FROM companies WHERE id = ?', [c.id]));
}));

/** Extend licence by N days from max(today, current expiry). */
superRouter.post('/companies/:id/extend', h((req, res) => {
  const c = db.get('SELECT * FROM companies WHERE id = ?', [int(req.params.id)]);
  if (!c) throw notFound('Company');
  const days = Math.max(1, int(req.body.days, 30));
  const base = c.expires_at && new Date(c.expires_at) > new Date() ? new Date(c.expires_at) : new Date();
  const exp = new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
  db.run('UPDATE companies SET expires_at = ?, active = 1 WHERE id = ?', [exp, c.id]);
  audit(req, 'super.company_extend', { id: c.id, days, expires_at: exp });
  res.json({ ok: true, expires_at: exp });
}));

superRouter.post('/companies/:id/reset-admin', h((req, res) => {
  const admin = db.get("SELECT * FROM users WHERE company_id = ? AND role = 'admin' ORDER BY id LIMIT 1", [int(req.params.id)]);
  if (!admin) throw notFound('Admin user');
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw bad('Password must be at least 6 characters');
  db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1, active = 1 WHERE id = ?', [bcrypt.hashSync(pw, 10), admin.id]);
  audit(req, 'super.reset_admin', { company: int(req.params.id), email: admin.email });
  res.json({ ok: true, email: admin.email });
}));

superRouter.delete('/companies/:id', h((req, res) => {
  const c = db.get('SELECT * FROM companies WHERE id = ?', [int(req.params.id)]);
  if (!c) throw notFound('Company');
  if (req.body?.confirm !== c.name) throw bad('Type the company name to confirm deletion');
  for (const u of db.all('SELECT id FROM users WHERE company_id = ?', [c.id])) dialer.onUserDisabled(u.id);
  db.run('DELETE FROM companies WHERE id = ?', [c.id]);
  audit(req, 'super.company_delete', { id: c.id, name: c.name });
  res.json({ ok: true });
}));

superRouter.get('/stats', h((req, res) => {
  res.json({
    companies: db.get('SELECT COUNT(*) AS n FROM companies').n,
    active: db.get("SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND (expires_at IS NULL OR expires_at >= date('now'))").n,
    expiring: db.get("SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND expires_at BETWEEN date('now') AND date('now','+15 days')").n,
    seats: db.get('SELECT COALESCE(SUM(max_agents),0) AS n FROM companies WHERE active = 1').n,
    users: db.get("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role != 'superadmin'").n,
    calls_today: db.get("SELECT COUNT(*) AS n FROM calls WHERE started_at >= date('now')").n,
  });
}));

module.exports = { settingsRouter, monitorRouter, superRouter, PLANS };
