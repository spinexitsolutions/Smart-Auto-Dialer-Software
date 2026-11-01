'use strict';
/**
 * Direct lead-source connectors. Each connector gets a secret webhook URL
 * (/api/hooks/<token>) and maps the source's payload into a CRM lead.
 *
 *   facebook   - Facebook / Instagram Lead Ads (Meta webhook + Graph API lookup)
 *   google_ads - Google Ads lead form extensions (webhook with google_key)
 *   indiamart  - IndiaMART Lead Manager (push webhook + CRM pull API every 10 min)
 *   justdial   - JustDial lead push (GET or POST)
 *   website    - any website / landing page form (JSON or form-post)
 */
const crypto = require('crypto');
const db = require('./db');
const { cleanPhone, phoneKey, isValidPhone, activity, sqlNow, HttpError } = require('./util');

const SOURCES = {
  facebook: { label: 'Facebook / Instagram Lead Ads', source: 'Facebook Ads' },
  google_ads: { label: 'Google Ads Lead Forms', source: 'Google Ads' },
  indiamart: { label: 'IndiaMART', source: 'IndiaMART' },
  justdial: { label: 'JustDial', source: 'JustDial' },
  website: { label: 'Website / Landing page form', source: 'Website' },
};

let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn; }
const hooks = { onLead: null }; // set by server: (companyId, leadId) => void

const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const load = (row) => (row ? { ...row, config: parseJson(row.config, {}), agent_ids: parseJson(row.agent_ids, []) } : null);

function byToken(token) {
  return load(db.get('SELECT * FROM integrations WHERE token = ?', [String(token)]));
}

function newToken() { return crypto.randomBytes(18).toString('base64url'); }

function markSeen(integrationId, extId) {
  if (!extId) return true;
  return db.run('INSERT OR IGNORE INTO integration_seen (integration_id, ext_id) VALUES (?,?)', [integrationId, String(extId)]).changes > 0;
}

/** Create or update a lead from a normalised payload. */
function captureLead(integ, data) {
  const cid = integ.company_id;
  const phone = cleanPhone(data.phone);
  if (!isValidPhone(phone)) throw new HttpError(400, 'Lead has no valid phone number');
  const source = data.source || SOURCES[integ.type]?.source || integ.name;
  const custom = Object.fromEntries(Object.entries(data.custom || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v).slice(0, 1000)]));
  const existing = db.get('SELECT id, campaign_id FROM leads WHERE company_id = ? AND phone_key = ?', [cid, phoneKey(phone)]);
  if (existing) {
    // Re-enquiry: bump priority so it is called first, keep a note of what they asked.
    db.run("UPDATE leads SET priority = priority + 1, updated_at = ?, campaign_id = COALESCE(campaign_id, ?), status = CASE WHEN status IN ('not_interested','contacted') THEN 'new' ELSE status END WHERE id = ?",
      [sqlNow(), integ.campaign_id, existing.id]);
    activity(cid, existing.id, null, 'note', `New enquiry again via ${source}${data.message ? ': ' + String(data.message).slice(0, 400) : ''}`);
    db.run('UPDATE integrations SET last_lead_at = ?, last_error = NULL WHERE id = ?', [sqlNow(), integ.id]);
    return { id: existing.id, duplicate: true };
  }
  let assigned = null;
  let ids = integ.agent_ids.length ? integ.agent_ids : integ.campaign_id ? db.all('SELECT user_id FROM campaign_agents WHERE campaign_id = ?', [integ.campaign_id]).map((r) => r.user_id) : [];
  ids = ids.filter((id) => db.get("SELECT 1 AS x FROM users WHERE id = ? AND company_id = ? AND active = 1", [id, cid]));
  if (ids.length) {
    assigned = ids[integ.rr_index % ids.length];
    db.run('UPDATE integrations SET rr_index = rr_index + 1 WHERE id = ?', [integ.id]);
  }
  if (data.message) custom.Message = String(data.message).slice(0, 2000);
  const id = db.insert('leads', {
    company_id: cid, campaign_id: integ.campaign_id || null, name: data.name ? String(data.name).trim().slice(0, 200) : null, phone, phone_key: phoneKey(phone),
    email: data.email || null, city: data.city || null, state: data.state || null, company_name: data.company_name || null, source,
    priority: 1, assigned_to: assigned, custom: JSON.stringify(custom), tags: data.tags || null,
  }, ['company_id', 'campaign_id', 'name', 'phone', 'phone_key', 'email', 'city', 'state', 'company_name', 'source', 'priority', 'assigned_to', 'custom', 'tags']);
  activity(cid, id, null, 'created', `Lead received from ${source}${data.message ? ': ' + String(data.message).slice(0, 300) : ''}`);
  db.run('UPDATE integrations SET leads_count = leads_count + 1, last_lead_at = ?, last_error = NULL WHERE id = ?', [sqlNow(), integ.id]);
  hooks.onLead?.(cid, id);
  return { id, duplicate: false };
}

// ------------------------------------------------------------------ payload mappers

function mapFacebookFields(fieldData) {
  const f = {};
  for (const x of fieldData || []) f[String(x.name).toLowerCase()] = Array.isArray(x.values) ? x.values.join(', ') : x.values;
  const take = (...keys) => { for (const k of keys) if (f[k]) { const v = f[k]; delete f[k]; return v; } return null; };
  const first = take('first_name'); const last = take('last_name');
  return {
    name: take('full_name', 'name') || [first, last].filter(Boolean).join(' ') || null,
    phone: take('phone_number', 'phone', 'mobile_number', 'whatsapp_number'),
    email: take('email', 'work_email'),
    city: take('city'), state: take('state', 'province'), company_name: take('company_name'),
    custom: f,
  };
}

function mapGoogle(body) {
  const cols = {};
  const custom = {};
  for (const c of body.user_column_data || []) {
    const id = String(c.column_id || '').toUpperCase();
    cols[id] = c.string_value;
    if (!['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY', 'REGION', 'COMPANY_NAME', 'WORK_EMAIL', 'WORK_PHONE'].includes(id)) custom[c.column_name || id] = c.string_value;
  }
  if (body.campaign_id) custom['Google campaign'] = body.campaign_id;
  if (body.form_id) custom['Google form'] = body.form_id;
  return {
    name: cols.FULL_NAME || [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' ') || null,
    phone: cols.PHONE_NUMBER || cols.WORK_PHONE, email: cols.EMAIL || cols.WORK_EMAIL, city: cols.CITY, state: cols.REGION,
    company_name: cols.COMPANY_NAME, custom, ext_id: body.lead_id,
  };
}

function mapIndiaMart(r) {
  return {
    name: r.SENDER_NAME, phone: r.SENDER_MOBILE || r.SENDER_PHONE || r.SENDER_MOBILE_ALT, email: r.SENDER_EMAIL, city: r.SENDER_CITY,
    state: r.SENDER_STATE, company_name: r.SENDER_COMPANY, message: [r.SUBJECT, r.QUERY_MESSAGE].filter(Boolean).join(' — '),
    custom: { Product: r.QUERY_PRODUCT_NAME, 'Enquiry type': r.QUERY_TYPE, 'IndiaMART ID': r.UNIQUE_QUERY_ID, Address: r.SENDER_ADDRESS },
    ext_id: r.UNIQUE_QUERY_ID,
  };
}

function mapGeneric(b) {
  const pick = (...keys) => { for (const k of keys) if (b[k] != null && b[k] !== '') return String(b[k]); return null; };
  const known = new Set(['name', 'full_name', 'fullname', 'first_name', 'last_name', 'prefix', 'phone', 'mobile', 'mobile_number', 'phone_number', 'contact', 'email', 'city', 'area', 'state', 'company', 'company_name', 'message', 'msg', 'enquiry', 'query', 'category', 'leadid', 'lead_id', 'source', 'tags', '_redirect', 'api_key', 'date', 'time']);
  const custom = {};
  for (const [k, v] of Object.entries(b)) if (!known.has(k.toLowerCase()) && typeof v !== 'object') custom[k] = v;
  if (b.category) custom.Category = b.category;
  if (b.area) custom.Area = b.area;
  return {
    name: pick('name', 'full_name', 'fullname') || [pick('prefix'), pick('first_name'), pick('last_name')].filter(Boolean).join(' ') || null,
    phone: pick('phone', 'mobile', 'mobile_number', 'phone_number', 'contact'), email: pick('email'), city: pick('city'), state: pick('state'),
    company_name: pick('company', 'company_name'), message: pick('message', 'msg', 'enquiry', 'query'), tags: pick('tags'), source: pick('source'),
    custom, ext_id: pick('leadid', 'lead_id'),
  };
}

// ------------------------------------------------------------------ webhook handlers

function verifyFacebookSignature(integ, req) {
  const secret = integ.config.app_secret;
  if (!secret) return true;
  const sig = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function fetchFacebookLead(integ, leadgenId) {
  const v = integ.config.api_version || 'v21.0';
  const res = await fetchImpl(`https://graph.facebook.com/${v}/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(integ.config.page_token || '')}`, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Graph API error ${res.status}`);
  return data;
}

/** Handle an incoming webhook. Returns { status, body } for the HTTP response. */
async function handleHook(integ, req) {
  const body = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  const results = [];
  const take = (data) => {
    if (data.ext_id && !markSeen(integ.id, data.ext_id)) { results.push({ skipped: 'already received' }); return; }
    results.push(captureLead(integ, data));
  };
  if (integ.type === 'facebook') {
    if (req.method === 'GET') {
      if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === integ.config.verify_token) return { status: 200, text: String(req.query['hub.challenge'] || '') };
      return { status: 403, text: 'Verify token mismatch' };
    }
    if (!verifyFacebookSignature(integ, req)) return { status: 401, json: { error: 'Bad signature' } };
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
        if (!markSeen(integ.id, ch.value.leadgen_id)) continue;
        const lead = await fetchFacebookLead(integ, ch.value.leadgen_id);
        const mapped = mapFacebookFields(lead.field_data);
        mapped.custom['Facebook form'] = ch.value.form_id || lead.form_id || '';
        if (lead.ad_name || ch.value.ad_id) mapped.custom['Facebook ad'] = lead.ad_name || ch.value.ad_id;
        results.push(captureLead(integ, mapped));
      }
    }
    return { status: 200, json: { ok: true, results } };
  }
  if (integ.type === 'google_ads') {
    if (integ.config.google_key && body.google_key !== integ.config.google_key) return { status: 401, json: { error: 'Invalid google_key' } };
    const data = mapGoogle(body);
    if (body.is_test) data.tags = 'Google test lead';
    take(data);
    return { status: 200, json: { ok: true, results } };
  }
  if (integ.type === 'indiamart') {
    const list = Array.isArray(body.RESPONSE) ? body.RESPONSE : body.RESPONSE ? [body.RESPONSE] : body.SENDER_MOBILE ? [body] : [];
    for (const r of list) take(mapIndiaMart(r));
    return { status: 200, json: { CODE: 200, STATUS: 'SUCCESS' } };
  }
  // justdial + website (generic)
  if (integ.config.secret && body.secret !== integ.config.secret && req.get('X-Secret') !== integ.config.secret) return { status: 401, json: { error: 'Invalid secret' } };
  take(mapGeneric(body));
  if (integ.type === 'justdial') return { status: 200, text: 'RECEIVED' };
  if (body._redirect && /^https?:\/\//.test(body._redirect)) return { status: 303, redirect: body._redirect };
  return { status: 200, json: { ok: true, results } };
}

/** IndiaMART CRM pull API (last 24h if no range). */
async function pullIndiaMart(integ) {
  if (!integ.config.crm_key) throw new Error('IndiaMART CRM key is not set');
  const res = await fetchImpl(`https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(integ.config.crm_key)}`, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  db.run('UPDATE integrations SET last_sync_at = ? WHERE id = ?', [sqlNow(), integ.id]);
  if (String(data.CODE) !== '200') {
    // 204 = no new leads
    if (String(data.CODE) === '204') return { imported: 0 };
    throw new Error(data.MESSAGE || `IndiaMART error ${data.CODE || res.status}`);
  }
  let imported = 0;
  for (const r of data.RESPONSE || []) {
    const m = mapIndiaMart(r);
    if (!markSeen(integ.id, m.ext_id)) continue;
    try { captureLead(integ, m); imported++; } catch { /* skip bad rows */ }
  }
  return { imported };
}

async function syncAll() {
  const rows = db.all("SELECT * FROM integrations WHERE type = 'indiamart' AND active = 1").map(load);
  for (const integ of rows) {
    if (!integ.config.crm_key) continue;
    try { await pullIndiaMart(integ); } catch (e) { db.run('UPDATE integrations SET last_error = ? WHERE id = ?', [String(e.message).slice(0, 300), integ.id]); }
  }
}

const SAMPLES = {
  facebook: { name: 'Test Lead (Facebook)', phone: '9000012345', email: 'fb.test@example.com', city: 'Mumbai', custom: { 'Facebook form': 'Test form' } },
  google_ads: { name: 'Test Lead (Google)', phone: '9000012346', email: 'g.test@example.com', city: 'Delhi', custom: {} },
  indiamart: { name: 'Test Buyer (IndiaMART)', phone: '9000012347', city: 'Surat', message: 'Need price for 100 units', custom: { Product: 'Test product' } },
  justdial: { name: 'Test Lead (JustDial)', phone: '9000012348', city: 'Pune', custom: { Category: 'Test category' } },
  website: { name: 'Test Lead (Website)', phone: '9000012349', email: 'web.test@example.com', message: 'Please call me', custom: {} },
};

module.exports = {
  SOURCES, SAMPLES, byToken, load, newToken, captureLead, handleHook, pullIndiaMart, syncAll, setFetch, hooks,
  mapFacebookFields, mapGoogle, mapIndiaMart, mapGeneric,
};
