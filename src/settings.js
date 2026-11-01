'use strict';
const db = require('./db');

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Kolkata',
  country_code: '+91',
  currency: 'INR',
  demo_mode: false,
  auto_dial_delay_sec: 3,
  mask_phone_for_agents: false,
  allow_agent_manual_dial: true,
  allow_agent_lead_create: true,
  recording_enabled: true,
  recording_retention_days: 90,
  break_reasons: ['Lunch', 'Tea', 'Meeting', 'Training', 'Washroom', 'Personal'],
  lead_statuses: ['new', 'contacted', 'interested', 'follow_up', 'converted', 'not_interested', 'dnc', 'invalid'],
  closed_statuses: ['converted', 'not_interested', 'dnc', 'invalid'],
  custom_fields: [],
  daily_call_target: 150,
  auto_create_inbound_leads: true,
};

function getSettings(companyId) {
  const row = db.get('SELECT settings FROM companies WHERE id = ?', [companyId]);
  let s = {};
  try { s = JSON.parse(row?.settings || '{}'); } catch { s = {}; }
  return { ...DEFAULT_SETTINGS, ...s };
}

function saveSettings(companyId, patch) {
  const current = getSettings(companyId);
  const next = { ...current };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (patch[k] === undefined) continue;
    const def = DEFAULT_SETTINGS[k];
    let v = patch[k];
    if (typeof def === 'boolean') v = v === true || v === 'true' || v === 1 || v === '1';
    else if (typeof def === 'number') v = Number.isFinite(Number(v)) ? Number(v) : def;
    else if (Array.isArray(def)) v = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : x)).filter(Boolean) : def;
    else v = String(v);
    next[k] = v;
  }
  if (next.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: next.timezone }); } catch { next.timezone = DEFAULT_SETTINGS.timezone; }
  }
  db.run('UPDATE companies SET settings = ? WHERE id = ?', [JSON.stringify(next), companyId]);
  return next;
}

/** Local HH:MM in a given IANA time zone. */
function localTime(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hh = parts.find((p) => p.type === 'hour').value.replace('24', '00');
  const mm = parts.find((p) => p.type === 'minute').value;
  return `${hh}:${mm}`;
}

function withinHours(start, end, tz, date = new Date()) {
  const now = localTime(tz, date);
  if (!start || !end) return true;
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end; // overnight window
}

/** Start of "today" in the company's time zone, expressed as a UTC SQL timestamp. */
function startOfTodayUtc(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = fmt.format(date); // YYYY-MM-DD
  return localMidnightUtc(localDate, tz);
}

/** Convert local date 'YYYY-MM-DD' midnight in tz into UTC SQL timestamp. */
function localMidnightUtc(localDate, tz) {
  const guess = new Date(localDate + 'T00:00:00Z');
  // offset = local - utc at that instant
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(guess);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { DEFAULT_SETTINGS, getSettings, saveSettings, localTime, withinHours, startOfTodayUtc, localMidnightUtc };
