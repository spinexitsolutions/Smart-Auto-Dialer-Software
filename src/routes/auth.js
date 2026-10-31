'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, authenticate, licenseProblem } = require('../auth');
const { h, bad, HttpError, audit, sqlNow } = require('../util');
const { getSettings } = require('../settings');

const router = express.Router();

// Basic brute-force protection: 10 failed attempts per email+ip per 15 minutes.
const failures = new Map();
function tooMany(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60000) { failures.delete(key); return false; }
  return f.count >= 10;
}
function fail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function profile(user) {
  const out = {
    id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, team: user.team,
    sim_slot: user.sim_slot, company_id: user.company_id,
  };
  if (user.company_id) {
    const c = user.company || db.get('SELECT * FROM companies WHERE id = ?', [user.company_id]);
    out.company = { id: c.id, name: c.name, plan: c.plan, max_agents: c.max_agents, expires_at: c.expires_at };
    out.settings = getSettings(c.id);
  }
  return out;
}

router.post('/login', h((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw bad('Email and password are required');
  const key = `${email}|${req.ip}`;
  if (tooMany(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const user = db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    fail(key);
    throw new HttpError(401, 'Invalid email or password');
  }
  if (!user.active) throw new HttpError(403, 'Your account is disabled. Contact your admin.');
  if (user.role !== 'superadmin') {
    const problem = licenseProblem(db.get('SELECT * FROM companies WHERE id = ?', [user.company_id]));
    if (problem) throw new HttpError(402, problem);
  }
  failures.delete(key);
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [sqlNow(), user.id]);
  req.user = user;
  audit(req, 'auth.login');
  res.json({ token: signToken(user), user: profile(user) });
}));

router.get('/me', authenticate, h((req, res) => {
  const u = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  u.company = req.user.company;
  res.json(profile(u));
}));

router.post('/change-password', authenticate, h((req, res) => {
  const { current_password, new_password } = req.body;
  const u = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(String(current_password || ''), u.password_hash)) throw bad('Current password is incorrect');
  if (!new_password || String(new_password).length < 6) throw bad('New password must be at least 6 characters');
  db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [bcrypt.hashSync(String(new_password), 10), u.id]);
  audit(req, 'auth.change_password');
  const fresh = db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true, token: signToken(fresh) });
}));

router.put('/profile', authenticate, h((req, res) => {
  const { name, phone, sim_slot } = req.body;
  db.update('users', req.user.id, {
    name: name ? String(name).trim() : undefined,
    phone: phone !== undefined ? String(phone) : undefined,
    sim_slot: sim_slot !== undefined ? Number(sim_slot) : undefined,
  }, ['name', 'phone', 'sim_slot']);
  const u = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  u.company = req.user.company;
  res.json(profile(u));
}));

module.exports = router;
module.exports.profile = profile;
