'use strict';
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');
const { HttpError } = require('./util');

const ROLE_RANK = { agent: 1, manager: 2, admin: 3, superadmin: 4 };

function signToken(user) {
  return jwt.sign({ uid: user.id, tv: user.token_version }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

/** Returns the reason a company cannot be used, or null if its licence is valid. */
function licenseProblem(company) {
  if (!company) return 'Company not found';
  if (!company.active) return 'Your account has been suspended. Please contact your software provider.';
  if (company.expires_at && new Date(company.expires_at.replace(' ', 'T') + (company.expires_at.length <= 10 ? 'T23:59:59Z' : 'Z')) < new Date()) {
    return 'Your licence has expired. Please renew your subscription.';
  }
  return null;
}

/** Resolve a JWT into a fresh user row (or throw). Used by HTTP and Socket.IO. */
function userFromToken(token) {
  if (!token) throw new HttpError(401, 'Login required');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Session expired, please login again');
  }
  const user = db.get(
    'SELECT id, company_id, name, email, phone, role, team, sim_slot, active, token_version FROM users WHERE id = ?',
    [payload.uid]
  );
  if (!user || !user.active || user.token_version !== payload.tv) throw new HttpError(401, 'Session expired, please login again');
  if (user.role !== 'superadmin') {
    const company = db.get('SELECT * FROM companies WHERE id = ?', [user.company_id]);
    const problem = licenseProblem(company);
    if (problem) throw new HttpError(402, problem);
    user.company = company;
  }
  return user;
}

function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    req.user = userFromToken(token);
    next();
  } catch (e) {
    next(e);
  }
}

/** Require a minimum role. 'manager' allows manager, admin. Superadmin only passes 'superadmin' routes. */
const requireRole = (min) => (req, res, next) => {
  const r = req.user?.role;
  if (min === 'superadmin') return r === 'superadmin' ? next() : next(new HttpError(403, 'Super admin only'));
  if (r === 'superadmin') return next(new HttpError(403, 'Use a company login for this section'));
  if ((ROLE_RANK[r] || 0) >= ROLE_RANK[min]) return next();
  next(new HttpError(403, 'You do not have permission for this action'));
};

const isManager = (user) => user && (user.role === 'admin' || user.role === 'manager');

module.exports = { signToken, authenticate, requireRole, userFromToken, licenseProblem, isManager, ROLE_RANK };
