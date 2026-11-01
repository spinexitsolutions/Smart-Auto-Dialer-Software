'use strict';
/**
 * Outbound WhatsApp / SMS: provider adapters, automation rules and a small
 * persistent send queue (message_logs).
 *
 * Providers are stored as rows in `integrations`:
 *   wa_cloud  - Meta WhatsApp Cloud API   { phone_number_id, access_token, api_version }
 *   wa_http   - any WhatsApp BSP via HTTP { url, method, headers, body }   (Interakt, AiSensy, Gupshup, Wati ...)
 *   sms_msg91 - MSG91 Flow API (DLT)     { authkey }
 *   sms_http  - any SMS gateway via HTTP  { url, method, headers, body }
 */
const db = require('./db');
const { getSettings } = require('./settings');
const { sqlNow, renderTemplate, activity } = require('./util');

const CHANNEL_TYPES = { whatsapp: ['wa_cloud', 'wa_http'], sms: ['sms_msg91', 'sms_http'] };
let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn; }

function parseJson(s, def) { try { return JSON.parse(s); } catch { return def; } }

function providerFor(companyId, channel) {
  const types = CHANNEL_TYPES[channel] || [];
  const row = db.get(
    `SELECT * FROM integrations WHERE company_id = ? AND active = 1 AND type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
    [companyId, ...types]
  );
  return row ? { ...row, config: parseJson(row.config, {}) } : null;
}

/** Phone in international digits without '+', e.g. 919876543210. */
function intlDigits(phone, countryCode = '+91') {
  const d = String(phone || '').replace(/\D/g, '');
  const cc = String(countryCode).replace(/\D/g, '');
  if (d.length === 10) return cc + d;
  if (d.length === 11 && d.startsWith('0')) return cc + d.slice(1);
  return d;
}

/** "a={{name}}, b={{amount_due}}" or "{{name}},{{amount_due}}" -> rendered list / object. */
function renderParams(spec, lead, agent, company) {
  const parts = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = [];
  const obj = {};
  for (const p of parts) {
    const m = p.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const val = renderTemplate(m ? m[2] : p, lead, agent, company);
    list.push(val);
    if (m) obj[m[1]] = val;
  }
  return { list, obj };
}

function fillHttpTemplate(str, vars) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

async function httpSend(cfg, vars) {
  const jsonVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, JSON.stringify(String(v ?? '')).slice(1, -1)]));
  const url = fillHttpTemplate(cfg.url, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, encodeURIComponent(String(v ?? ''))])));
  const method = (cfg.method || 'POST').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...parseJson(cfg.headers || '{}', {}) };
  const res = await fetchImpl(url, { method, headers, body: method === 'GET' ? undefined : fillHttpTemplate(cfg.body || '', jsonVars), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text.slice(0, 200);
}

/** Send one message through the company's provider. Returns provider reference. */
async function deliver(companyId, msg) {
  const settings = getSettings(companyId);
  const provider = providerFor(companyId, msg.channel);
  if (!provider) {
    if (settings.demo_mode) return 'demo-simulated';
    throw new Error(`No ${msg.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} provider connected (Integrations → WhatsApp & SMS)`);
  }
  const cfg = provider.config;
  const to = intlDigits(msg.phone, settings.country_code);
  const params = parseJson(msg.provider_params || '{"list":[],"obj":{}}', { list: [], obj: {} });
  if (provider.type === 'wa_cloud') {
    const body = msg.provider_template
      ? {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: msg.provider_template, language: { code: msg.provider_lang || 'en' },
          ...(params.list.length ? { components: [{ type: 'body', parameters: params.list.map((t) => ({ type: 'text', text: String(t) })) }] } : {}),
        },
      }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.body } };
    const res = await fetchImpl(`https://graph.facebook.com/${cfg.api_version || 'v21.0'}/${encodeURIComponent(cfg.phone_number_id)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `WhatsApp API error ${res.status}`);
    return data?.messages?.[0]?.id || 'sent';
  }
  if (provider.type === 'sms_msg91') {
    if (!msg.provider_template) throw new Error('MSG91 needs a DLT Flow/Template ID on the automation');
    const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
      method: 'POST', headers: { authkey: cfg.authkey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: msg.provider_template, short_url: '0', recipients: [{ mobiles: to, ...params.obj }] }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') throw new Error(data.message || `MSG91 error ${res.status}`);
    return data.message || 'sent';
  }
  // Generic HTTP providers
  return httpSend(cfg, { phone: to, phone_local: String(msg.phone).replace(/\D/g, '').slice(-10), message: msg.body || '', template: msg.provider_template || '', lang: msg.provider_lang || '', ...params.obj });
}

function queueMessage(m) {
  return db.run(
    `INSERT INTO message_logs (company_id, lead_id, call_id, automation_id, channel, phone, body, provider_template, provider_lang, provider_params, due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [m.company_id, m.lead_id || null, m.call_id || null, m.automation_id || null, m.channel, m.phone, m.body || '', m.provider_template || null,
      m.provider_lang || null, m.provider_params || null, m.due_at || sqlNow()]
  ).id;
}

/** Evaluate automation rules for an event and queue messages. */
function runAutomations(companyId, trigger, { leadId, callId, dispositionId, campaignId, userId } = {}) {
  let rules;
  try {
    rules = db.all('SELECT * FROM automations WHERE company_id = ? AND trigger = ? AND active = 1', [companyId, trigger]);
  } catch { return 0; }
  if (!rules.length || !leadId) return 0;
  const lead = db.get('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (!lead || lead.status === 'dnc') return 0;
  const agent = userId ? db.get('SELECT name, phone FROM users WHERE id = ?', [userId]) : {};
  const company = db.get('SELECT name FROM companies WHERE id = ?', [companyId]);
  let queued = 0;
  for (const r of rules) {
    if (r.disposition_id && r.disposition_id !== dispositionId) continue;
    if (r.campaign_id && r.campaign_id !== (campaignId ?? lead.campaign_id)) continue;
    const tpl = r.template_id ? db.get('SELECT body FROM templates WHERE id = ?', [r.template_id]) : null;
    const body = tpl ? renderTemplate(tpl.body, lead, agent || {}, company) : '';
    const params = renderParams(r.provider_params, lead, agent || {}, company);
    queueMessage({
      company_id: companyId, lead_id: lead.id, call_id: callId, automation_id: r.id, channel: r.channel, phone: lead.phone, body,
      provider_template: r.provider_template, provider_lang: r.provider_lang, provider_params: JSON.stringify(params),
      due_at: sqlNow(new Date(Date.now() + (r.delay_minutes || 0) * 60000)),
    });
    queued++;
  }
  if (queued) setTimeout(() => processQueue().catch(() => {}), 200).unref?.();
  return queued;
}

let running = false;
async function processQueue(limit = 20) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const rows = db.all("SELECT * FROM message_logs WHERE status = 'queued' AND due_at <= ? ORDER BY id LIMIT ?", [sqlNow(), limit]);
    for (const m of rows) {
      db.run("UPDATE message_logs SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [m.id]);
      try {
        const ref = await deliver(m.company_id, m);
        const status = ref === 'demo-simulated' ? 'simulated' : 'sent';
        db.run('UPDATE message_logs SET status = ?, provider_ref = ?, sent_at = ?, error = NULL WHERE id = ?', [status, ref, sqlNow(), m.id]);
        if (m.lead_id) {
          activity(m.company_id, m.lead_id, null, m.channel, `Auto ${m.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} ${status === 'simulated' ? '(demo, not really sent)' : 'sent'}: ${m.body || 'template ' + (m.provider_template || '')}`.slice(0, 600));
        }
      } catch (e) {
        const retry = m.attempts + 1 < 3 && !/No .* provider/.test(e.message);
        db.run('UPDATE message_logs SET status = ?, error = ?, due_at = ? WHERE id = ?',
          [retry ? 'queued' : 'failed', String(e.message).slice(0, 500), sqlNow(new Date(Date.now() + 2 * 60000)), m.id]);
      }
      done++;
    }
  } finally { running = false; }
  return done;
}

module.exports = { deliver, queueMessage, runAutomations, processQueue, providerFor, intlDigits, renderParams, setFetch, CHANNEL_TYPES };
