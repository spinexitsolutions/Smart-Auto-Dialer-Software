'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT, contact_email TEXT, contact_phone TEXT,
  plan TEXT NOT NULL DEFAULT 'starter',
  max_agents INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  api_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','admin','manager','agent')),
  team TEXT,
  sim_slot INTEGER NOT NULL DEFAULT -1,
  active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'sales' CHECK (type IN ('sales','support','collection','survey','other')),
  dial_mode TEXT NOT NULL DEFAULT 'progressive' CHECK (dial_mode IN ('preview','progressive','power')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','completed')),
  description TEXT,
  script TEXT,
  wrapup_sec INTEGER NOT NULL DEFAULT 30,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retry_minutes INTEGER NOT NULL DEFAULT 60,
  call_start TEXT NOT NULL DEFAULT '09:00',
  call_end TEXT NOT NULL DEFAULT '21:00',
  auto_skip_unanswered INTEGER NOT NULL DEFAULT 0,
  sim_slot INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_agents (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  name TEXT,
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL,
  alt_phone TEXT,
  email TEXT,
  company_name TEXT,
  city TEXT,
  state TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  priority INTEGER NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT,
  custom TEXT NOT NULL DEFAULT '{}',
  deal_value REAL,
  amount_due REAL,
  due_date TEXT,
  ptp_date TEXT,
  ptp_amount REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT,
  next_call_at TEXT,
  last_disposition TEXT,
  locked_by INTEGER,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_company_status ON leads(company_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id, status, next_call_at);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(company_id, phone_key);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);

CREATE TABLE IF NOT EXISTS dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'connected' CHECK (category IN ('connected','not_connected')),
  lead_status TEXT,
  is_success INTEGER NOT NULL DEFAULT 0,
  needs_callback INTEGER NOT NULL DEFAULT 0,
  retry INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#64748b',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  mode TEXT NOT NULL DEFAULT 'sim',
  status TEXT NOT NULL DEFAULT 'dialing',
  connected INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  ended_at TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  disposition_id INTEGER REFERENCES dispositions(id) ON DELETE SET NULL,
  disposition TEXT,
  notes TEXT,
  recording_path TEXT,
  sim_slot INTEGER,
  disposed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_company_date ON calls(company_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(company_id, status, due_at);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_at TEXT NOT NULL DEFAULT (datetime('now')),
  logout_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON agent_sessions(user_id, login_at);

CREATE TABLE IF NOT EXISTS agent_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  start_at TEXT NOT NULL DEFAULT (datetime('now')),
  end_at TEXT
);

CREATE TABLE IF NOT EXISTS dnc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, phone_key)
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('sms','whatsapp','email')),
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  secret TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at);
`;

function clean(params) {
  if (params == null) return [];
  const fix = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  if (Array.isArray(params)) return params.map(fix);
  if (typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) out[k] = fix(v);
    return [out];
  }
  return [fix(params)];
}

const plain = (row) => (row ? { ...row } : row);

function init(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function close() {
  if (db) db.close();
  db = undefined;
}

const get = (sql, params) => plain(init().prepare(sql).get(...clean(params)));
const all = (sql, params) => init().prepare(sql).all(...clean(params)).map(plain);
const run = (sql, params) => {
  const r = init().prepare(sql).run(...clean(params));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};

let txDepth = 0;
function tx(fn) {
  const d = init();
  if (txDepth > 0) return fn();
  d.exec('BEGIN');
  txDepth++;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

/** Insert a row from an object, only using the provided whitelisted columns. */
function insert(table, data, columns) {
  const cols = columns.filter((c) => data[c] !== undefined);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '$' + c).join(',')})`;
  const params = {};
  for (const c of cols) params[c] = data[c];
  return run(sql, params).id;
}

/** Update a row from an object, only using the whitelisted columns. */
function update(table, id, data, columns, extraWhere = '', extraParams = {}) {
  const cols = columns.filter((c) => data[c] !== undefined);
  if (!cols.length) return 0;
  const params = { ...extraParams, __id: id };
  for (const c of cols) params[c] = data[c];
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = $${c}`).join(', ')} WHERE id = $__id ${extraWhere}`;
  return run(sql, params).changes;
}

module.exports = { init, close, get, all, run, tx, insert, update };
