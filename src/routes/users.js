'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const dialer = require('../dialer');
const { requireRole } = require('../auth');
const { h, bad, notFound, forbidden, audit, int } = require('../util');

const router = express.Router();

const COLS = 'id, name, email, phone, role, team, sim_slot, active, last_login_at, created_at';

// Everyone in the company can list users (agents need names for transfers/assignment views).
router.get('/', h((req, res) => {
  const where = ['company_id = $cid'];
  const p = { cid: req.user.company_id };
  if (req.query.role) { where.push('role = $role'); p.role = req.query.role; }
  if (req.query.active !== undefined) { where.push('active = $active'); p.active = int(req.query.active); }
  const rows = db.all(`SELECT ${COLS} FROM users WHERE ${where.join(' AND ')} ORDER BY active DESC, name`, p);
  const live = rows.map((u) => ({ ...u, live_status: dialer.getAgent(u.id)?.status || 'offline' }));
  if (req.user.role === 'agent') return res.json(live.map(({ id, name, role, team, live_status }) => ({ id, name, role, team, live_status })));
  res.json(live);
}));

function seatCheck(companyId, excludeId) {
  const c = db.get('SELECT max_agents FROM companies WHERE id = ?', [companyId]);
  const used = db.get(`SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1 AND role IN ('agent','manager') AND id != ?`, [companyId, excludeId || 0]).n;
  if (used >= c.max_agents) throw bad(`Your plan allows ${c.max_agents} active users (agents + managers). Upgrade your licence to add more.`);
}

function validateRole(actor, role) {
  if (!['admin', 'manager', 'agent'].includes(role)) throw bad('Invalid role');
  if (actor.role === 'manager' && role !== 'agent') throw forbidden('Managers can only create agents');
}

router.post('/', requireRole('manager'), h((req, res) => {
  const b = req.body;
  const role = b.role || 'agent';
  validateRole(req.user, role);
  if (!b.name || !b.email || !b.password) throw bad('Name, email and password are required');
  if (String(b.password).length < 6) throw bad('Password must be at least 6 characters');
  if (db.get('SELECT id FROM users WHERE email = ?', [String(b.email).trim().toLowerCase()])) throw bad('A user with this email already exists');
  if (role !== 'admin') seatCheck(req.user.company_id);
  const id = db.insert('users', {
    company_id: req.user.company_id, name: String(b.name).trim(), email: String(b.email).trim().toLowerCase(),
    phone: b.phone || null, role, team: b.team || null, sim_slot: b.sim_slot !== undefined ? int(b.sim_slot, -1) : -1,
    password_hash: bcrypt.hashSync(String(b.password), 10),
  }, ['company_id', 'name', 'email', 'phone', 'role', 'team', 'sim_slot', 'password_hash']);
  if (Array.isArray(b.campaign_ids)) {
    for (const cid of b.campaign_ids) {
      if (db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [cid, req.user.company_id])) {
        db.run('INSERT OR IGNORE INTO campaign_agents (campaign_id, user_id) VALUES (?,?)', [cid, id]);
      }
    }
  }
  audit(req, 'user.create', { id, email: b.email, role });
  res.status(201).json(db.get(`SELECT ${COLS} FROM users WHERE id = ?`, [id]));
}));

function loadUser(req) {
  const u = db.get('SELECT * FROM users WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!u) throw notFound('User');
  if (req.user.role === 'manager' && u.role !== 'agent' && u.id !== req.user.id) throw forbidden('Managers can only edit agents');
  return u;
}

router.get('/:id', requireRole('manager'), h((req, res) => {
  const u = loadUser(req);
  const campaigns = db.all('SELECT campaign_id FROM campaign_agents WHERE user_id = ?', [u.id]).map((r) => r.campaign_id);
  const { password_hash, token_version, ...rest } = u;
  res.json({ ...rest, campaign_ids: campaigns });
}));

router.put('/:id', requireRole('manager'), h((req, res) => {
  const u = loadUser(req);
  const b = req.body;
  if (b.role && b.role !== u.role) {
    validateRole(req.user, b.role);
    if (u.id === req.user.id) throw bad('You cannot change your own role');
  }
  if (b.active !== undefined && !Number(b.active) && u.id === req.user.id) throw bad('You cannot disable yourself');
  if (b.active !== undefined && Number(b.active) && !u.active && (b.role || u.role) !== 'admin') seatCheck(req.user.company_id, u.id);
  if (b.email && String(b.email).toLowerCase() !== u.email.toLowerCase()) {
    if (db.get('SELECT id FROM users WHERE email = ? AND id != ?', [String(b.email).toLowerCase(), u.id])) throw bad('Email already in use');
  }
  const patch = {
    name: b.name, email: b.email ? String(b.email).trim().toLowerCase() : undefined, phone: b.phone, role: b.role, team: b.team,
    sim_slot: b.sim_slot !== undefined ? int(b.sim_slot, -1) : undefined,
    active: b.active !== undefined ? (Number(b.active) ? 1 : 0) : undefined,
  };
  if (b.password) {
    if (String(b.password).length < 6) throw bad('Password must be at least 6 characters');
    patch.password_hash = bcrypt.hashSync(String(b.password), 10);
  }
  db.update('users', u.id, patch, ['name', 'email', 'phone', 'role', 'team', 'sim_slot', 'active', 'password_hash']);
  if (b.password || patch.active === 0) db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [u.id]);
  if (Array.isArray(b.campaign_ids)) {
    db.run('DELETE FROM campaign_agents WHERE user_id = ?', [u.id]);
    for (const cid of b.campaign_ids) {
      if (db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [cid, req.user.company_id])) {
        db.run('INSERT OR IGNORE INTO campaign_agents (campaign_id, user_id) VALUES (?,?)', [cid, u.id]);
      }
    }
  }
  if (patch.active === 0 || b.password) dialer.onUserDisabled(u.id);
  audit(req, 'user.update', { id: u.id, fields: Object.keys(b).filter((k) => k !== 'password') });
  res.json(db.get(`SELECT ${COLS} FROM users WHERE id = ?`, [u.id]));
}));

router.delete('/:id', requireRole('admin'), h((req, res) => {
  const u = loadUser(req);
  if (u.id === req.user.id) throw bad('You cannot delete yourself');
  // Soft-delete keeps call history intact.
  db.run('UPDATE users SET active = 0, token_version = token_version + 1 WHERE id = ?', [u.id]);
  db.run('UPDATE leads SET assigned_to = NULL WHERE assigned_to = ?', [u.id]);
  dialer.onUserDisabled(u.id);
  audit(req, 'user.disable', { id: u.id });
  res.json({ ok: true });
}));

module.exports = router;
