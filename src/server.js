'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const config = require('./config');
const db = require('./db');
const dialer = require('./dialer');
const { authenticate, requireRole, userFromToken } = require('./auth');
const { getSettings } = require('./settings');
const { sqlNow } = require('./util');

function createApp() {
  db.init();
  wireHooks();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // Keep the raw body for webhook signature checks (Facebook X-Hub-Signature-256).
  app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/hooks/')) req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, name: config.brandName, time: new Date().toISOString() }));
  app.get('/api/brand', (req, res) => res.json({ name: config.brandName }));

  app.use('/api/auth', require('./routes/auth'));

  // Public API: CORS so website forms can post leads directly.
  app.use('/api/public', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, POST' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  }, require('./routes/public'));

  // Lead-source webhooks (Facebook, Google Ads, IndiaMART, JustDial, website forms).
  app.use('/api/hooks', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Secret', 'Access-Control-Allow-Methods': 'GET, POST' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  }, require('./routes/integrations').hooksRouter);

  const { settingsRouter, monitorRouter, superRouter } = require('./routes/admin');
  app.use('/api/super', authenticate, superRouter);

  const api = express.Router();
  api.use(authenticate, (req, res, next) => (req.user.role === 'superadmin' ? next(Object.assign(new Error('Use the Super Admin console'), { status: 403 })) : next()));
  api.use('/users', require('./routes/users'));
  api.use('/campaigns', require('./routes/campaigns'));
  api.use('/leads', require('./routes/leads'));
  api.use('/calls', require('./routes/calls'));
  api.use('/reports', require('./routes/reports'));
  api.use('/settings', settingsRouter);
  api.use('/monitor', monitorRouter);
  api.use('/integrations', require('./routes/integrations'));
  api.use('/', require('./routes/crm'));
  app.use('/api', api);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/__BRAND__/g, config.brandName.replace(/[<>&"]/g, ''));
    res.type('html').send(html);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    let message = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    if (err.type === 'entity.parse.failed') message = 'Invalid JSON body';
    res.status(status).json({ error: message });
  });
  return app;
}

function attachSockets(server) {
  const io = new Server(server, { cors: { origin: false }, pingInterval: 20000, pingTimeout: 20000 });
  dialer.setIo(io);

  io.use((socket, next) => {
    try {
      const user = userFromToken(socket.handshake.auth?.token);
      if (user.role === 'superadmin') return next(new Error('Super admin has no dialer'));
      socket.data.user = user;
      socket.data.native = !!socket.handshake.auth?.native;
      next();
    } catch (e) {
      next(new Error(e.message));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    dialer.onConnect(socket, user, { native: socket.data.native });
    const isMgr = user.role === 'admin' || user.role === 'manager';
    const safe = (fn) => (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      try {
        // Refresh user so disabled accounts / role changes take effect immediately.
        const fresh = db.get('SELECT id, company_id, name, role, team, active FROM users WHERE id = ?', [user.id]);
        if (!fresh || !fresh.active) { socket.disconnect(true); return; }
        const r = fn(fresh, ...args);
        if (ack) ack({ ok: true, ...(r && typeof r === 'object' ? r : {}) });
      } catch (e) {
        console.error('socket handler', e);
        if (ack) ack({ ok: false, error: e.message });
      }
    };
    socket.on('agent:ready', safe((u, d) => dialer.setReady(u, d?.campaignId)));
    socket.on('agent:notready', safe((u) => dialer.setNotReady(u)));
    socket.on('agent:break', safe((u, d) => dialer.startBreak(u, d?.reason)));
    socket.on('agent:resume', safe((u) => dialer.endBreak(u)));
    socket.on('lead:skip', safe((u) => dialer.skipPreview(u)));
    socket.on('dial', safe((u, d) => dialer.manualDial(u, d || {})));
    socket.on('call:state', safe((u, d) => dialer.callState(u.id, d || {})));
    socket.on('call:hangup', safe((u) => dialer.hangup(u)));
    socket.on('device:info', safe((u, d) => dialer.deviceInfo(u.id, d)));
    socket.on('call:incoming', safe((u, d) => dialer.incomingCall(u, d || {})));
    socket.on('monitor:get', safe((u) => (isMgr ? { snapshot: dialer.snapshot(u.company_id) } : {})));
    socket.on('disconnect', () => dialer.onDisconnect(socket, user));
  });
  return io;
}

function ensureSuperAdmin() {
  if (db.get("SELECT id FROM users WHERE role = 'superadmin'")) return;
  const email = (process.env.SUPERADMIN_EMAIL || 'owner@smartdialer.local').toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || require('crypto').randomBytes(6).toString('base64url');
  db.run("INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL, 'Software Owner', ?, ?, 'superadmin')", [email, bcrypt.hashSync(password, 10)]);
  console.log('\n================ SUPER ADMIN CREATED ================');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${process.env.SUPERADMIN_PASSWORD ? '(from SUPERADMIN_PASSWORD)' : password}`);
  console.log('  Use this login to create client companies & licences.');
  console.log('=====================================================\n');
}

/** Wire automations and AI into dialer / lead events. */
function wireHooks() {
  const messaging = require('./messaging');
  const ai = require('./ai');
  const sources = require('./leadsources');
  dialer.hooks.onDisposition = ({ companyId, callId, leadId, dispositionId, campaignId, userId }) => {
    messaging.runAutomations(companyId, 'disposition', { leadId, callId, dispositionId, campaignId, userId });
    const call = db.get('SELECT recording_path, connected FROM calls WHERE id = ?', [callId]);
    // Recordings usually arrive after the outcome; in demo mode there is no recording at all.
    if (call && (call.recording_path || getSettings(companyId).demo_mode) && call.connected) ai.enqueue(callId);
  };
  dialer.hooks.onMissedCall = ({ companyId, callId, leadId, userId }) => messaging.runAutomations(companyId, 'missed_call', { leadId, callId, userId });
  sources.hooks.onLead = (companyId, leadId) => {
    messaging.runAutomations(companyId, 'lead_created', { leadId });
    dialer.fireWebhook(companyId, 'lead.created', db.get('SELECT * FROM leads WHERE id = ?', [leadId]));
  };
}

/** Housekeeping: release stale lead locks, purge old recordings. */
function startJobs() {
  const tick = () => {
    try {
      db.run('UPDATE leads SET locked_by = NULL, locked_at = NULL WHERE locked_at < ?', [sqlNow(new Date(Date.now() - 15 * 60000))]);
      for (const c of db.all('SELECT id FROM companies')) {
        const days = Number(getSettings(c.id).recording_retention_days) || 0;
        if (days <= 0) continue;
        const old = db.all('SELECT id, recording_path FROM calls WHERE company_id = ? AND recording_path IS NOT NULL AND started_at < ? LIMIT 500',
          [c.id, sqlNow(new Date(Date.now() - days * 86400000))]);
        for (const r of old) {
          fs.rm(path.join(config.uploadsDir, r.recording_path), () => {});
          db.run('UPDATE calls SET recording_path = NULL WHERE id = ?', [r.id]);
        }
      }
    } catch (e) { console.error('jobs', e); }
  };
  setTimeout(tick, 5000).unref();
  setInterval(tick, 10 * 60000).unref();
  const messaging = require('./messaging');
  const ai = require('./ai');
  const sources = require('./leadsources');
  setInterval(() => messaging.processQueue().catch((e) => console.error('messages', e)), 20000).unref();
  setInterval(() => ai.processQueue().catch((e) => console.error('ai', e)), 15000).unref();
  setInterval(() => sources.syncAll().catch((e) => console.error('indiamart', e)), 10 * 60000).unref();
}

function start() {
  const app = createApp();
  ensureSuperAdmin();
  const server = http.createServer(app);
  attachSockets(server);
  startJobs();
  server.listen(config.port, config.host, () => {
    console.log(`${config.brandName} running on http://localhost:${config.port}`);
  });
  const shutdown = () => { server.close(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, attachSockets, ensureSuperAdmin };
