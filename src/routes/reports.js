'use strict';
const express = require('express');
const db = require('../db');
const { requireRole, isManager } = require('../auth');
const { getSettings, localMidnightUtc, startOfTodayUtc } = require('../settings');
const { h, int, sendCsv, sqlNow } = require('../util');

const router = express.Router();

/** Offset of tz from UTC in minutes at the given instant. */
function tzOffsetMinutes(tz, date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function localDate(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Resolve ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive local dates) to UTC bounds. */
function range(req) {
  const tz = getSettings(req.user.company_id).timezone;
  const today = localDate(tz);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = re.test(req.query.from || '') ? req.query.from : today;
  const to = re.test(req.query.to || '') ? req.query.to : from > today ? from : today;
  const next = new Date(to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
  return { tz, from, to, start: localMidnightUtc(from, tz), end: localMidnightUtc(next.toISOString().slice(0, 10), tz), offset: tzOffsetMinutes(tz) };
}

function agentFilter(req, alias = 'c') {
  if (!isManager(req.user)) return { sql: ` AND ${alias}.user_id = $me`, p: { me: req.user.id } };
  if (req.query.user_id) return { sql: ` AND ${alias}.user_id = $me`, p: { me: int(req.query.user_id) } };
  return { sql: '', p: {} };
}
function campaignFilter(req, alias = 'c') {
  return req.query.campaign_id ? { sql: ` AND ${alias}.campaign_id = $camp`, p: { camp: int(req.query.campaign_id) } } : { sql: '', p: {} };
}

function out(req, res, name, rows, columns) {
  if (req.query.format === 'csv') return sendCsv(res, `${name}-${req.query.from || 'today'}.csv`, rows, columns);
  res.json(rows);
}

function totals(cidv, start, end, extra = { sql: '', p: {} }) {
  return db.get(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec,
       COALESCE(SUM(CASE WHEN d.is_success = 1 THEN 1 ELSE 0 END),0) AS success,
       COUNT(DISTINCT c.lead_id) AS unique_leads, COUNT(DISTINCT c.user_id) AS agents
     FROM calls c LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE c.company_id = $cid AND c.started_at >= $start AND c.started_at < $end ${extra.sql}`,
    { cid: cidv, start, end, ...extra.p }
  );
}

router.get('/dashboard', h((req, res) => {
  const cidv = req.user.company_id;
  const s = getSettings(cidv);
  const tz = s.timezone;
  const start = startOfTodayUtc(tz);
  const yStart = sqlNow(new Date(new Date(start.replace(' ', 'T') + 'Z').getTime() - 86400000));
  const end = sqlNow(new Date(Date.now() + 60000));
  const af = agentFilter(req);
  const today = totals(cidv, start, end, af);
  const yesterday = totals(cidv, yStart, start, af);
  const offset = tzOffsetMinutes(tz);
  const hourly = db.all(
    `SELECT CAST(strftime('%H', datetime(c.started_at, '${offset >= 0 ? '+' : ''}${offset} minutes')) AS INTEGER) AS hour,
       COUNT(*) AS calls, COALESCE(SUM(c.connected),0) AS connected
     FROM calls c WHERE c.company_id = $cid AND c.started_at >= $start ${af.sql} GROUP BY hour ORDER BY hour`,
    { cid: cidv, start, ...af.p }
  );
  const leadScope = isManager(req.user) ? '' : ' AND assigned_to = $me';
  const leadsByStatus = db.all(`SELECT status, COUNT(*) AS n FROM leads WHERE company_id = $cid ${leadScope} GROUP BY status ORDER BY n DESC`, { cid: cidv, ...(isManager(req.user) ? {} : { me: req.user.id }) });
  const dispositions = db.all(
    `SELECT c.disposition AS name, COALESCE(d.color,'#64748b') AS color, COUNT(*) AS n FROM calls c LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE c.company_id = $cid AND c.started_at >= $start AND c.disposition IS NOT NULL ${af.sql} GROUP BY c.disposition ORDER BY n DESC LIMIT 10`,
    { cid: cidv, start, ...af.p }
  );
  const topAgents = isManager(req.user) ? db.all(
    `SELECT u.id, u.name, COUNT(c.id) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec,
       COALESCE(SUM(CASE WHEN d.is_success = 1 THEN 1 ELSE 0 END),0) AS success
     FROM users u JOIN calls c ON c.user_id = u.id AND c.started_at >= $start LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE u.company_id = $cid GROUP BY u.id ORDER BY success DESC, connected DESC LIMIT 8`,
    { cid: cidv, start }
  ) : [];
  const fScope = isManager(req.user) ? '' : ' AND user_id = $me';
  const fp = { cid: cidv, now: sqlNow(), ...(isManager(req.user) ? {} : { me: req.user.id }) };
  const followups = {
    overdue: db.get(`SELECT COUNT(*) AS n FROM followups WHERE company_id = $cid AND status = 'pending' AND due_at < $now ${fScope}`, fp).n,
    today: db.get(`SELECT COUNT(*) AS n FROM followups WHERE company_id = $cid AND status = 'pending' AND due_at >= $now AND due_at < $end ${fScope}`, { ...fp, end: sqlNow(new Date(Date.now() + 86400000)) }).n,
  };
  const leadsToday = db.get(`SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND created_at >= ?`, [cidv, start]).n;
  const openTickets = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE company_id = ? AND status IN ('open','in_progress')`, [cidv]).n;
  const collections = db.get(
    `SELECT COALESCE(SUM(amount_due),0) AS due, COALESCE(SUM(CASE WHEN ptp_date IS NOT NULL THEN ptp_amount ELSE 0 END),0) AS ptp,
       COUNT(CASE WHEN ptp_date IS NOT NULL THEN 1 END) AS ptp_count FROM leads WHERE company_id = ? AND amount_due > 0`, [cidv]);
  res.json({ today, yesterday, hourly, leadsByStatus, dispositions, topAgents, followups, leadsToday, openTickets, collections, target: s.daily_call_target });
}));

router.get('/agents', requireRole('manager'), h((req, res) => {
  const r = range(req);
  const cf = campaignFilter(req);
  const rows = db.all(
    `SELECT u.id, u.name, u.team,
       COUNT(c.id) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec,
       COALESCE(SUM(CASE WHEN d.is_success = 1 THEN 1 ELSE 0 END),0) AS success,
       COUNT(DISTINCT c.lead_id) AS unique_leads,
       COALESCE(MAX(c.duration),0) AS longest_call
     FROM users u LEFT JOIN calls c ON c.user_id = u.id AND c.started_at >= $start AND c.started_at < $end ${cf.sql}
       LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE u.company_id = $cid AND u.role IN ('agent','manager','admin') ${req.query.user_id ? 'AND u.id = $uid' : ''}
     GROUP BY u.id HAVING calls > 0 OR u.active = 1 AND u.role = 'agent' ORDER BY success DESC, connected DESC`,
    { cid: req.user.company_id, start: r.start, end: r.end, ...cf.p, ...(req.query.user_id ? { uid: int(req.query.user_id) } : {}) }
  );
  const nowS = sqlNow();
  for (const row of rows) {
    const sess = db.get(
      `SELECT MIN(login_at) AS first_login, MAX(COALESCE(logout_at, $now)) AS last_seen,
         COALESCE(SUM((julianday(MIN(COALESCE(logout_at, $now), $end)) - julianday(MAX(login_at, $start))) * 86400),0) AS login_sec
       FROM agent_sessions WHERE user_id = $uid AND login_at < $end AND COALESCE(logout_at, $now) > $start`,
      { uid: row.id, start: r.start, end: r.end, now: nowS });
    const brk = db.get(
      `SELECT COUNT(*) AS breaks, COALESCE(SUM((julianday(MIN(COALESCE(end_at, $now), $end)) - julianday(MAX(start_at, $start))) * 86400),0) AS break_sec
       FROM agent_breaks WHERE user_id = $uid AND start_at < $end AND COALESCE(end_at, $now) > $start`,
      { uid: row.id, start: r.start, end: r.end, now: nowS });
    row.first_login = sess.first_login; row.last_seen = sess.last_seen;
    row.login_sec = Math.max(0, Math.round(sess.login_sec)); row.break_sec = Math.max(0, Math.round(brk.break_sec)); row.breaks = brk.breaks;
    row.connect_rate = row.calls ? Math.round((row.connected / row.calls) * 100) : 0;
    row.avg_talk_sec = row.connected ? Math.round(row.talk_sec / row.connected) : 0;
    row.conversion_rate = row.connected ? Math.round((row.success / row.connected) * 100) : 0;
    row.productive_pct = row.login_sec ? Math.min(100, Math.round((row.talk_sec / row.login_sec) * 100)) : 0;
  }
  out(req, res, 'agent-performance', rows, ['name', 'team', 'calls', 'connected', 'connect_rate', 'talk_sec', 'avg_talk_sec', 'success', 'conversion_rate', 'unique_leads', 'login_sec', 'break_sec', 'breaks', 'productive_pct', 'first_login', 'last_seen']);
}));

router.get('/dispositions', h((req, res) => {
  const r = range(req);
  const af = agentFilter(req); const cf = campaignFilter(req);
  const rows = db.all(
    `SELECT COALESCE(c.disposition, CASE WHEN c.connected = 1 THEN 'Connected (no disposition)' ELSE 'Not connected (no disposition)' END) AS name,
       COALESCE(d.color, '#94a3b8') AS color, COALESCE(d.category, '') AS category, COUNT(*) AS calls, COALESCE(SUM(c.duration),0) AS talk_sec
     FROM calls c LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE c.company_id = $cid AND c.started_at >= $start AND c.started_at < $end ${af.sql} ${cf.sql}
     GROUP BY name ORDER BY calls DESC`,
    { cid: req.user.company_id, start: r.start, end: r.end, ...af.p, ...cf.p });
  out(req, res, 'dispositions', rows, ['name', 'category', 'calls', 'talk_sec']);
}));

router.get('/campaigns', requireRole('manager'), h((req, res) => {
  const r = range(req);
  const rows = db.all(
    `SELECT cp.id, cp.name, cp.type, cp.dial_mode, cp.status,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = cp.id) AS leads,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = cp.id AND l.attempts = 0) AS untouched,
       (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = cp.id AND l.status = 'converted') AS converted,
       COUNT(c.id) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec,
       COALESCE(SUM(CASE WHEN d.is_success = 1 THEN 1 ELSE 0 END),0) AS success
     FROM campaigns cp LEFT JOIN calls c ON c.campaign_id = cp.id AND c.started_at >= $start AND c.started_at < $end
       LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE cp.company_id = $cid GROUP BY cp.id ORDER BY calls DESC`,
    { cid: req.user.company_id, start: r.start, end: r.end });
  for (const row of rows) {
    row.connect_rate = row.calls ? Math.round((row.connected / row.calls) * 100) : 0;
    row.penetration = row.leads ? Math.round(((row.leads - row.untouched) / row.leads) * 100) : 0;
  }
  out(req, res, 'campaigns', rows, ['name', 'type', 'dial_mode', 'status', 'leads', 'untouched', 'penetration', 'converted', 'calls', 'connected', 'connect_rate', 'talk_sec', 'success']);
}));

router.get('/hourly', h((req, res) => {
  const r = range(req);
  const af = agentFilter(req); const cf = campaignFilter(req);
  const rows = db.all(
    `SELECT CAST(strftime('%H', datetime(c.started_at, '${r.offset >= 0 ? '+' : ''}${r.offset} minutes')) AS INTEGER) AS hour,
       COUNT(*) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec
     FROM calls c WHERE c.company_id = $cid AND c.started_at >= $start AND c.started_at < $end ${af.sql} ${cf.sql}
     GROUP BY hour ORDER BY hour`,
    { cid: req.user.company_id, start: r.start, end: r.end, ...af.p, ...cf.p });
  out(req, res, 'hourly', rows);
}));

router.get('/daily', h((req, res) => {
  const r = range(req);
  const af = agentFilter(req); const cf = campaignFilter(req);
  const rows = db.all(
    `SELECT date(datetime(c.started_at, '${r.offset >= 0 ? '+' : ''}${r.offset} minutes')) AS day,
       COUNT(*) AS calls, COALESCE(SUM(c.connected),0) AS connected, COALESCE(SUM(c.duration),0) AS talk_sec,
       COALESCE(SUM(CASE WHEN d.is_success = 1 THEN 1 ELSE 0 END),0) AS success
     FROM calls c LEFT JOIN dispositions d ON d.id = c.disposition_id
     WHERE c.company_id = $cid AND c.started_at >= $start AND c.started_at < $end ${af.sql} ${cf.sql}
     GROUP BY day ORDER BY day`,
    { cid: req.user.company_id, start: r.start, end: r.end, ...af.p, ...cf.p });
  out(req, res, 'daily', rows);
}));

router.get('/attendance', requireRole('manager'), h((req, res) => {
  const r = range(req);
  const off = `${r.offset >= 0 ? '+' : ''}${r.offset} minutes`;
  const rows = db.all(
    `SELECT u.id AS user_id, u.name, date(datetime(s.login_at, '${off}')) AS day,
       datetime(MIN(s.login_at), '${off}') AS first_login, datetime(MAX(COALESCE(s.logout_at, $now)), '${off}') AS last_logout,
       ROUND(SUM((julianday(COALESCE(s.logout_at, $now)) - julianday(s.login_at)) * 86400)) AS login_sec,
       COUNT(*) AS sessions
     FROM agent_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.company_id = $cid AND s.login_at >= $start AND s.login_at < $end ${req.query.user_id ? 'AND s.user_id = $uid' : ''}
     GROUP BY u.id, day ORDER BY day DESC, u.name`,
    { cid: req.user.company_id, start: r.start, end: r.end, now: sqlNow(), ...(req.query.user_id ? { uid: int(req.query.user_id) } : {}) });
  for (const row of rows) {
    const b = db.get(
      `SELECT COUNT(*) AS breaks, ROUND(COALESCE(SUM((julianday(COALESCE(end_at, $now)) - julianday(start_at)) * 86400),0)) AS break_sec,
         GROUP_CONCAT(DISTINCT reason) AS reasons
       FROM agent_breaks b WHERE b.user_id = $uid AND b.company_id = $cid AND date(datetime(b.start_at, '${off}')) = $day`,
      { uid: row.user_id, cid: req.user.company_id, day: row.day, now: sqlNow() });
    Object.assign(row, b);
  }
  out(req, res, 'attendance', rows, ['day', 'name', 'first_login', 'last_logout', 'login_sec', 'sessions', 'breaks', 'break_sec', 'reasons']);
}));

/** Lead funnel / source performance. */
router.get('/sources', requireRole('manager'), h((req, res) => {
  const rows = db.all(
    `SELECT COALESCE(source, 'Unknown') AS source, COUNT(*) AS leads,
       SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted,
       SUM(CASE WHEN status = 'interested' THEN 1 ELSE 0 END) AS interested,
       SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS called,
       COALESCE(SUM(CASE WHEN status = 'converted' THEN deal_value ELSE 0 END),0) AS revenue
     FROM leads WHERE company_id = ? GROUP BY source ORDER BY leads DESC`, [req.user.company_id]);
  for (const row of rows) row.conversion_rate = row.leads ? Math.round((row.converted / row.leads) * 1000) / 10 : 0;
  out(req, res, 'lead-sources', rows);
}));

module.exports = router;
module.exports.tzOffsetMinutes = tzOffsetMinutes;
