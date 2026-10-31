'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.SUPERADMIN_EMAIL = 'owner@test.local';
process.env.SUPERADMIN_PASSWORD = 'owner123';

const { createApp, attachSockets, ensureSuperAdmin } = require('../src/server');
const db = require('../src/db');
const dialer = require('../src/dialer');
const { io: ioClient } = require('socket.io-client');

let server, base;
const tokens = {};

async function call(method, url, body, token) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { email, password })).data.token;

before(async () => {
  const app = createApp();
  console.log = () => {};
  ensureSuperAdmin();
  server = http.createServer(app);
  attachSockets(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  dialer._reset();
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('super admin creates a client company with licence', async () => {
  tokens.owner = await login('owner@test.local', 'owner123');
  assert.ok(tokens.owner);
  const r = await call('POST', '/api/super/companies', {
    name: 'Acme Telecalling', plan: 'starter', max_agents: 2, admin_email: 'admin@acme.test', admin_password: 'secret1',
  }, tokens.owner);
  assert.strictEqual(r.status, 201);
  tokens.admin = await login('admin@acme.test', 'secret1');
  const d = await call('GET', '/api/dispositions', null, tokens.admin);
  assert.ok(d.data.length > 5, 'default dispositions seeded');
  // Company users cannot reach the vendor console and vice versa.
  assert.strictEqual((await call('GET', '/api/super/companies', null, tokens.admin)).status, 403);
  assert.strictEqual((await call('GET', '/api/leads', null, tokens.owner)).status, 403);
});

test('seat limit is enforced', async () => {
  for (const n of [1, 2]) {
    const r = await call('POST', '/api/users', { name: `Agent ${n}`, email: `a${n}@acme.test`, password: 'secret1', role: 'agent' }, tokens.admin);
    assert.strictEqual(r.status, 201);
  }
  const r = await call('POST', '/api/users', { name: 'Agent 3', email: 'a3@acme.test', password: 'secret1' }, tokens.admin);
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /plan allows 2/);
  tokens.a1 = await login('a1@acme.test', 'secret1');
});

test('campaign + CSV-style import with duplicates, DNC and round robin', async () => {
  const users = (await call('GET', '/api/users', null, tokens.admin)).data;
  const agentIds = users.filter((u) => u.role === 'agent').map((u) => u.id);
  const c = await call('POST', '/api/campaigns', { name: 'Test Camp', dial_mode: 'progressive', call_start: '00:00', call_end: '23:59', agent_ids: [agentIds[0]] }, tokens.admin);
  assert.strictEqual(c.status, 201);
  tokens.campaign = c.data.id;
  await call('POST', '/api/dnc', { phones: '9000000009' }, tokens.admin);
  const rows = [
    { Name: 'Ravi', Mobile: '98765 43210', City: 'Pune', 'Loan Amount': '10L' },
    { Name: 'Ravi dup', Mobile: '+91 9876543210' },
    { Name: 'Blocked', Mobile: '9000000009' },
    { Name: 'Bad', Mobile: '12' },
    { Name: 'Sita', Mobile: '9123456780' },
  ];
  const r = await call('POST', '/api/leads/import', { rows, campaign_id: tokens.campaign, assign: 'round_robin', agent_ids: agentIds }, tokens.admin);
  assert.deepStrictEqual({ i: r.data.imported, d: r.data.duplicates, n: r.data.dnc, v: r.data.invalid }, { i: 2, d: 1, n: 1, v: 1 });
  const leads = (await call('GET', '/api/leads?q=Ravi', null, tokens.admin)).data.rows;
  assert.strictEqual(leads[0].custom['Loan Amount'], '10L');
  assert.strictEqual(leads[0].city, 'Pune');
  // Agents only see their own leads.
  const mine = (await call('GET', '/api/leads', null, tokens.a1)).data;
  assert.strictEqual(mine.total, 1);
});

test('public API captures leads with API key', async () => {
  const s = await call('GET', '/api/settings', null, tokens.admin);
  const key = s.data.api_key;
  const res = await fetch(base + '/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ name: 'Web Lead', phone: '9988776655', source: 'Website' }) });
  assert.strictEqual(res.status, 201);
  const bad = await fetch(base + '/api/public/leads', { method: 'POST', headers: { 'X-API-Key': 'nope' } });
  assert.strictEqual(bad.status, 401);
});

function connect(token, auth = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token, ...auth }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const once = (s, evt) => new Promise((r) => s.once(evt, r));

test('auto-dial flow: native device dials, call ends, disposition, next lead', async () => {
  // Enable "SIM" executor by connecting as the Android app.
  const web = await connect(tokens.a1);
  const phone = await connect(tokens.a1, { native: true });
  const started = once(phone, 'call:start');
  web.emit('agent:ready', { campaignId: tokens.campaign });
  const p = await started;
  assert.strictEqual(p.executor, 'native');
  assert.ok(p.lead && p.call.id);
  const ended = once(web, 'call:ended');
  phone.emit('call:state', { callId: String(p.call.id), state: 'offhook' });
  phone.emit('call:state', { callId: String(p.call.id), state: 'ended', durationSec: 42, connected: true });
  const e = await ended;
  assert.strictEqual(e.durationSec, 42);
  const disps = (await call('GET', '/api/dispositions', null, tokens.a1)).data;
  const callback = disps.find((d) => d.needs_callback);
  const when = new Date(Date.now() + 3600000).toISOString();
  const r = await call('POST', `/api/calls/${p.call.id}/disposition`, { disposition_id: callback.id, notes: 'Call tomorrow', callback_at: when, stop_dialing: true }, tokens.a1);
  assert.strictEqual(r.status, 200);
  const lead = (await call('GET', `/api/leads/${p.lead.id}`, null, tokens.a1)).data;
  assert.strictEqual(lead.status, 'follow_up');
  assert.strictEqual(lead.attempts, 1);
  assert.strictEqual(lead.followups.length, 1);
  assert.strictEqual(dialer.getAgent(lead.assigned_to).status, 'idle');
  // Reports reflect the call.
  const rep = (await call('GET', '/api/reports/agents', null, tokens.admin)).data;
  const row = rep.find((x) => x.name === 'Agent 1');
  assert.strictEqual(row.calls, 1);
  assert.strictEqual(row.talk_sec, 42);
  const snap = (await call('GET', '/api/monitor', null, tokens.admin)).data;
  assert.strictEqual(snap.summary.online, 1);
  web.close(); phone.close();
});

test('DNC numbers are never dialed manually', async () => {
  const s = await connect(tokens.a1);
  const err = once(s, 'dialer:error');
  s.emit('dial', { phone: '9000000009' });
  assert.match((await err).message, /Do-Not-Call/);
  s.close();
});

test('expired licence blocks login', async () => {
  const companies = (await call('GET', '/api/super/companies', null, tokens.owner)).data;
  await call('PUT', `/api/super/companies/${companies[0].id}`, { expires_at: '2020-01-01' }, tokens.owner);
  const r = await call('POST', '/api/auth/login', { email: 'admin@acme.test', password: 'secret1' });
  assert.strictEqual(r.status, 402);
  const ext = await call('POST', `/api/super/companies/${companies[0].id}/extend`, { days: 30 }, tokens.owner);
  assert.ok(ext.data.expires_at > new Date().toISOString().slice(0, 10));
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'admin@acme.test', password: 'secret1' })).status, 200);
});
