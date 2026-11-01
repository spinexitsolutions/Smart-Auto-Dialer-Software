'use strict';
// Incoming/missed calls, lead-source connectors, WhatsApp/SMS automations, AI call analysis, pipeline board.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-feat-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.SUPERADMIN_EMAIL = 'owner@test.local';
process.env.SUPERADMIN_PASSWORD = 'owner123';

const { createApp, attachSockets, ensureSuperAdmin } = require('../src/server');
const db = require('../src/db');
const dialer = require('../src/dialer');
const messaging = require('../src/messaging');
const sources = require('../src/leadsources');
const ai = require('../src/ai');
const { io: ioClient } = require('socket.io-client');

let server, base;
const t = {};
const outbound = []; // requests captured by the fake fetch

async function call(method, url, body, token, headers = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { email, password })).data.token;
function connect(token, auth = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token, ...auth }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const once = (s, evt) => new Promise((r) => s.once(evt, r));
const emitAck = (s, evt, data) => new Promise((r) => s.emit(evt, data, r));

function fakeFetch(url, opts = {}) {
  outbound.push({ url: String(url), opts });
  const u = String(url);
  const json = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
  if (u.includes('graph.facebook.com') && u.includes('/messages')) return json({ messages: [{ id: 'wamid.TEST' }] });
  if (u.includes('graph.facebook.com')) {
    return json({ id: 'LG1', form_id: 'F1', field_data: [
      { name: 'full_name', values: ['Meta User'] }, { name: 'phone_number', values: ['+91 98100 00001'] },
      { name: 'email', values: ['meta@example.com'] }, { name: 'budget', values: ['5 lakh'] }] });
  }
  if (u.includes('api.sarvam.ai')) return json({ transcript: 'Agent: Namaste ji. Customer: haan bataiye, mujhe loan chahiye 20 lakh ka.' });
  if (u.includes('mapi.indiamart.com')) return json({ CODE: 200, STATUS: 'SUCCESS', RESPONSE: [{ UNIQUE_QUERY_ID: 'IM9', SENDER_NAME: 'Pull Buyer', SENDER_MOBILE: '+91-9810000009', QUERY_PRODUCT_NAME: 'Pumps' }] });
  return json({ ok: true });
}

before(async () => {
  console.log = () => {};
  const app = createApp();
  ensureSuperAdmin();
  messaging.setFetch(fakeFetch);
  sources.setFetch(fakeFetch);
  ai._setClients({
    fetch: fakeFetch,
    anthropic: () => {
      const parse = async (params) => {
        t.claudeParams = params;
        return {
          stop_reason: 'end_turn', model: params.model,
          parsed_output: {
            summary: 'Customer wants a 20 lakh home loan.', customer_sentiment: 'positive', customer_intent: 'Wants a loan',
            key_points: ['20 lakh'], next_action: 'Send document list', suggested_outcome: 'Interested', quality_score: 88,
            script_adherence: 140, politeness: 90, strengths: ['Polite'], improvements: ['Ask income'], red_flags: [], language: 'Hinglish',
          },
        };
      };
      return { messages: { parse }, beta: { messages: { parse } } };
    },
  });
  server = http.createServer(app);
  attachSockets(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  t.owner = await login('owner@test.local', 'owner123');
  await call('POST', '/api/super/companies', { name: 'Feat Co', plan: 'professional', admin_email: 'admin@feat.test', admin_password: 'secret1' }, t.owner);
  t.admin = await login('admin@feat.test', 'secret1');
  for (const n of [1, 2]) await call('POST', '/api/users', { name: `Agent ${n}`, email: `a${n}@feat.test`, password: 'secret1', role: 'agent' }, t.admin);
  t.a1 = await login('a1@feat.test', 'secret1');
  const users = (await call('GET', '/api/users', null, t.admin)).data;
  t.agentIds = users.filter((u) => u.role === 'agent').map((u) => u.id);
  t.camp = (await call('POST', '/api/campaigns', { name: 'Feat', call_start: '00:00', call_end: '23:59', agent_ids: t.agentIds }, t.admin)).data.id;
  t.lead = (await call('POST', '/api/leads', { name: 'Known Customer', phone: '9811111111', campaign_id: t.camp }, t.admin)).data;
  t.disps = (await call('GET', '/api/dispositions', null, t.admin)).data;
});

after(() => {
  dialer._reset();
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('incoming call: screen pop, missed-call follow-up, auto lead, answered → outcome form', async () => {
  const web = await connect(t.a1);
  const phone = await connect(t.a1, { native: true });
  const ring = once(web, 'incoming:ring');
  await emitAck(phone, 'call:incoming', { id: 'in-1', phone: '+91 98111 11111', state: 'ringing' });
  const r = await ring;
  assert.strictEqual(r.lead.name, 'Known Customer');

  const missed = once(web, 'incoming:missed');
  await emitAck(phone, 'call:incoming', { id: 'in-1', phone: '9811111111', state: 'ended', answered: false, missed: true, durationSec: 0 });
  await missed;
  const fu = db.all("SELECT * FROM followups WHERE lead_id = ? AND status = 'pending'", [t.lead.id]);
  assert.strictEqual(fu.length, 1);
  assert.match(fu[0].note, /Missed call/);
  // The same event delivered twice (app retry) is ignored.
  const dup = await emitAck(phone, 'call:incoming', { id: 'in-1', phone: '9811111111', state: 'ended', answered: false, missed: true });
  assert.strictEqual(dup.duplicate, true);

  // Unknown caller → new lead assigned to the agent.
  await emitAck(phone, 'call:incoming', { id: 'in-2', phone: '9822222222', state: 'ended', answered: false, missed: true });
  const newLead = db.get("SELECT * FROM leads WHERE phone_key = '9822222222'");
  assert.strictEqual(newLead.source, 'Incoming call');

  // Answered call opens the outcome form for the agent.
  const resume = once(web, 'call:resume');
  await emitAck(phone, 'call:incoming', { id: 'in-3', phone: '9811111111', state: 'ended', answered: true, durationSec: 75 });
  const p = await resume;
  assert.strictEqual(p.call.direction, 'inbound');
  assert.strictEqual(p.call.duration, 75);
  const interested = t.disps.find((d) => d.name === 'Interested');
  const dres = await call('POST', `/api/calls/${p.call.id}/disposition`, { disposition_id: interested.id }, t.a1);
  assert.strictEqual(dres.status, 200);

  const calls = (await call('GET', '/api/calls?direction=inbound', null, t.admin)).data;
  assert.strictEqual(calls.total, 3);
  const dash = (await call('GET', '/api/reports/dashboard', null, t.admin)).data;
  assert.strictEqual(dash.inbound.missed, 2);
  web.close(); phone.close();
});

test('lead sources: Facebook, Google Ads, IndiaMART, JustDial, website', async () => {
  const mk = async (type, extra = {}) => (await call('POST', '/api/integrations', { type, campaign_id: t.camp, agent_ids: t.agentIds, ...extra }, t.admin)).data;
  const fb = await mk('facebook', { config: { page_token: 'PAGETOKEN', verify_token: 'vt123' } });
  assert.ok(fb.webhook_url.includes('/api/hooks/'));
  assert.strictEqual(fb.config.page_token, '••••OKEN', 'secrets are masked');
  const hook = new URL(fb.webhook_url).pathname;
  const verify = await call('GET', `${hook}?hub.mode=subscribe&hub.verify_token=vt123&hub.challenge=CH42`);
  assert.strictEqual(verify.data, 'CH42');
  assert.strictEqual((await call('GET', `${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status, 403);
  const payload = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LG1', form_id: 'F1' } }] }] };
  assert.strictEqual((await call('POST', hook, payload)).status, 200);
  await call('POST', hook, payload); // retry from Meta: ignored
  const fbLead = db.get("SELECT * FROM leads WHERE phone_key = '9810000001'");
  assert.strictEqual(fbLead.name, 'Meta User');
  assert.strictEqual(fbLead.source, 'Facebook Ads');
  assert.strictEqual(JSON.parse(fbLead.custom).budget, '5 lakh');
  assert.ok(t.agentIds.includes(fbLead.assigned_to));
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM leads WHERE phone_key = '9810000001'").n, 1);
  assert.ok(outbound.some((o) => o.url.includes('LG1') && o.url.includes('PAGETOKEN')), 'page token kept after masking');

  const g = await mk('google_ads', { config: { google_key: 'gk' } });
  const gh = new URL(g.webhook_url).pathname;
  const gBody = { lead_id: 'G1', google_key: 'gk', user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Goo User' }, { column_id: 'PHONE_NUMBER', string_value: '+919810000002' }, { column_name: 'Loan type', column_id: 'X1', string_value: 'Home' }] };
  assert.strictEqual((await call('POST', gh, { ...gBody, google_key: 'bad' })).status, 401);
  assert.strictEqual((await call('POST', gh, gBody)).status, 200);
  assert.strictEqual(JSON.parse(db.get("SELECT custom FROM leads WHERE phone_key = '9810000002'").custom)['Loan type'], 'Home');

  const im = await mk('indiamart', { config: { crm_key: 'IMKEY' } });
  await call('POST', new URL(im.webhook_url).pathname, { CODE: 200, RESPONSE: { UNIQUE_QUERY_ID: 'IM1', SENDER_NAME: 'Buyer', SENDER_MOBILE: '+91-9810000003', QUERY_PRODUCT_NAME: 'Valves', QUERY_MESSAGE: 'Need 100 pcs' } });
  assert.strictEqual(db.get("SELECT name FROM leads WHERE phone_key = '9810000003'").name, 'Buyer');
  const sync = await call('POST', `/api/integrations/${im.id}/sync`, {}, t.admin);
  assert.strictEqual(sync.data.imported, 1);

  const jd = await mk('justdial');
  const jdRes = await call('GET', `${new URL(jd.webhook_url).pathname}?leadid=J1&name=JD%20User&mobile=9810000004&city=Pune&category=Loans`);
  assert.strictEqual(jdRes.data, 'RECEIVED');

  const web = await mk('website');
  const wres = await call('POST', new URL(web.webhook_url).pathname, { name: 'Web User', phone: '9810000005', message: 'call me', _redirect: 'https://example.com/thanks' });
  assert.strictEqual(wres.status, 303);
  // Re-enquiry does not duplicate but bumps priority.
  await call('POST', new URL(web.webhook_url).pathname, { name: 'Web User', phone: '9810000005' });
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM leads WHERE phone_key = '9810000005'").n, 1);

  const list = (await call('GET', '/api/integrations', null, t.admin)).data;
  assert.strictEqual(list.items.find((i) => i.id === fb.id).leads_count, 1);
  // Agents cannot see integrations.
  assert.strictEqual((await call('GET', '/api/integrations', null, t.a1)).status, 403);
});

test('auto WhatsApp after disposition via WhatsApp Cloud API', async () => {
  await call('POST', '/api/integrations', { type: 'wa_cloud', config: { phone_number_id: 'PNID', access_token: 'WATOKEN' } }, t.admin);
  const interested = t.disps.find((d) => d.name === 'Interested');
  const tpl = (await call('POST', '/api/templates', { name: 'Brochure', channel: 'whatsapp', body: 'Hi {{first_name}}, here is our brochure.' }, t.admin)).data;
  const a = await call('POST', '/api/integrations/automations', {
    name: 'Brochure on interest', trigger: 'disposition', disposition_id: interested.id, channel: 'whatsapp', template_id: tpl.id,
    provider_template: 'brochure_v1', provider_lang: 'en', provider_params: '{{first_name}}',
  }, t.admin);
  assert.strictEqual(a.status, 201);
  const callId = db.run("INSERT INTO calls (company_id, lead_id, campaign_id, user_id, phone, status, connected, ended_at, duration) VALUES (?,?,?,?,?, 'ended', 1, datetime('now'), 30)",
    [t.lead.company_id, t.lead.id, t.camp, t.agentIds[0], t.lead.phone]).id;
  await call('POST', `/api/calls/${callId}/disposition`, { disposition_id: interested.id }, t.a1);
  await messaging.processQueue();
  const log = db.get('SELECT * FROM message_logs WHERE call_id = ?', [callId]);
  assert.strictEqual(log.status, 'sent', log.error);
  assert.strictEqual(log.body, 'Hi Known, here is our brochure.');
  const req = outbound.find((o) => o.url.includes('/PNID/messages'));
  const sent = JSON.parse(req.opts.body);
  assert.strictEqual(sent.to, '919811111111');
  assert.strictEqual(sent.template.name, 'brochure_v1');
  assert.strictEqual(sent.template.components[0].parameters[0].text, 'Known');
  assert.strictEqual(req.opts.headers.Authorization, 'Bearer WATOKEN');
  const msgs = (await call('GET', '/api/integrations/messages', null, t.admin)).data;
  assert.ok(msgs.length >= 1);
});

test('AI call analysis: recording → transcript → Claude summary & scores', async () => {
  const cfg = await call('POST', '/api/integrations', { type: 'ai', config: { enabled: true, auto: true, stt_provider: 'sarvam', stt_key: 'SK', anthropic_key: 'AK', model: 'claude-opus-5-5', language: 'hi-IN' } }, t.admin);
  assert.strictEqual(cfg.data.config.anthropic_key, '••••AK');
  const callId = db.run("INSERT INTO calls (company_id, lead_id, campaign_id, user_id, phone, status, connected, ended_at, duration) VALUES (?,?,?,?,?, 'ended', 1, datetime('now'), 60)",
    [t.lead.company_id, t.lead.id, t.camp, t.agentIds[0], t.lead.phone]).id;
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake audio')], { type: 'audio/mpeg' }), 'rec.mp3');
  const up = await fetch(`${base}/api/calls/${callId}/recording`, { method: 'POST', headers: { Authorization: `Bearer ${t.a1}` }, body: fd });
  assert.strictEqual(up.status, 200);
  await ai.processQueue();
  const res = (await call('GET', `/api/calls/${callId}/ai`, null, t.admin)).data;
  assert.strictEqual(res.status, 'done', res.error);
  assert.strictEqual(res.quality_score, 88);
  assert.strictEqual(res.script_score, 100, 'scores are clamped to 0-100');
  assert.strictEqual(res.sentiment, 'positive');
  assert.match(res.transcript, /20 lakh/);
  assert.strictEqual(t.claudeParams.model, 'claude-opus-5-5');
  assert.strictEqual(t.claudeParams.fallbacks, 'default');
  assert.match(t.claudeParams.messages[0].content, /<transcript>/);
  const quality = (await call('GET', '/api/reports/quality', null, t.admin)).data;
  assert.strictEqual(quality[0].analysed, 1);
  const list = (await call('GET', `/api/calls?lead_id=${t.lead.id}`, null, t.admin)).data;
  assert.ok(list.rows.some((r) => r.ai_score === 88));
});

test('pipeline board groups leads by status and moving a card updates status', async () => {
  const b = (await call('GET', '/api/leads/board', null, t.admin)).data;
  const statuses = b.columns.map((c) => c.status);
  assert.ok(statuses.includes('new') && statuses.includes('converted') && !statuses.includes('dnc'));
  const total = b.columns.reduce((s, c) => s + c.count, 0);
  assert.ok(total > 5);
  const anyLead = b.columns.find((c) => c.rows.length).rows[0];
  await call('PUT', `/api/leads/${anyLead.id}`, { status: 'converted' }, t.admin);
  const b2 = (await call('GET', '/api/leads/board', null, t.admin)).data;
  assert.ok(b2.columns.find((c) => c.status === 'converted').rows.some((r) => r.id === anyLead.id));
  // Agents only see their own leads on the board.
  const ab = (await call('GET', '/api/leads/board', null, t.a1)).data;
  const agentTotal = ab.columns.reduce((s, c) => s + c.count, 0);
  assert.ok(agentTotal < total);
});
