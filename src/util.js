'use strict';
const crypto = require('crypto');
const db = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg);

/** Wrap async/sync route handlers so thrown errors reach the error middleware. */
const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

/** Normalise a phone number: keep leading + and digits. */
function cleanPhone(p) {
  if (p == null) return '';
  const s = String(p).trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  return (plus ? '+' : '') + digits;
}

/** Key used for duplicate / DNC matching: last 10 digits. */
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.slice(-10);
}

function isValidPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15;
}

/** SQLite-compatible UTC timestamp 'YYYY-MM-DD HH:MM:SS'. */
function sqlNow(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Convert any date-ish input (ISO / local string / Date) into sqlNow format, or null. */
function toSqlDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  return sqlNow(d);
}

const int = (v, def = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);

function randomKey(prefix = 'sad') {
  return `${prefix}_${crypto.randomBytes(20).toString('hex')}`;
}

/** Parse CSV text into array of objects keyed by header. Handles quotes, commas, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows.shift().map((x) => x.trim());
  return rows.map((r) => {
    const o = {};
    header.forEach((k, i) => { o[k] = (r[i] ?? '').trim(); });
    return o;
  });
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  // Guard against CSV/formula injection when opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  return lines.join('\r\n');
}

function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(rows, columns));
}

function audit(req, action, details) {
  try {
    db.run('INSERT INTO audit_logs (company_id, user_id, action, details, ip) VALUES (?,?,?,?,?)', [
      req.user?.company_id ?? null,
      req.user?.id ?? null,
      action,
      details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
      req.ip || null,
    ]);
  } catch { /* auditing must never break a request */ }
}

function activity(companyId, leadId, userId, type, text) {
  db.run('INSERT INTO activities (company_id, lead_id, user_id, type, text) VALUES (?,?,?,?,?)', [companyId, leadId, userId, type, text]);
}

/** Fill {{placeholders}} in a template with lead / agent data. */
function renderTemplate(body, lead = {}, agent = {}, company = {}) {
  const vars = {
    name: lead.name || '', first_name: (lead.name || '').split(' ')[0], phone: lead.phone || '',
    email: lead.email || '', city: lead.city || '', company: lead.company_name || '',
    amount_due: lead.amount_due ?? '', due_date: lead.due_date || '', ptp_date: lead.ptp_date || '',
    agent_name: agent.name || '', agent_phone: agent.phone || '', business_name: company.name || '',
  };
  return String(body).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

module.exports = {
  HttpError, bad, notFound, forbidden, h, cleanPhone, phoneKey, isValidPhone, sqlNow, toSqlDate,
  int, num, bool, randomKey, parseCsv, toCsv, sendCsv, csvEscape, audit, activity, renderTemplate,
};
