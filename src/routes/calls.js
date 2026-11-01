'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const dialer = require('../dialer');
const { requireRole, isManager } = require('../auth');
const { h, bad, notFound, forbidden, int, toSqlDate, sendCsv, audit } = require('../util');
const ai = require('../ai');

const router = express.Router();

fs.mkdirSync(config.uploadsDir, { recursive: true });
const AUDIO_EXT = ['.mp3', '.m4a', '.amr', '.wav', '.aac', '.ogg', '.3gp', '.opus', '.webm'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadsDir, String(req.user.company_id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `call-${int(req.params.id)}-${Date.now()}${AUDIO_EXT.includes(ext) ? ext : '.bin'}`);
    },
  }),
  limits: { fileSize: config.maxRecordingMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, AUDIO_EXT.includes(ext) || /^audio\//.test(file.mimetype || ''));
  },
});

function filters(req) {
  const q = req.query;
  const where = ['c.company_id = $cid'];
  const p = { cid: req.user.company_id };
  if (!isManager(req.user)) { where.push('c.user_id = $me'); p.me = req.user.id; }
  else if (q.user_id) { where.push('c.user_id = $uid'); p.uid = int(q.user_id); }
  if (q.campaign_id) { where.push('c.campaign_id = $camp'); p.camp = int(q.campaign_id); }
  if (q.lead_id) { where.push('c.lead_id = $lead'); p.lead = int(q.lead_id); }
  if (q.from) { where.push('c.started_at >= $from'); p.from = toSqlDate(q.from); }
  if (q.to) { where.push('c.started_at < $to'); p.to = toSqlDate(q.to); }
  if (q.connected === '1') where.push('c.connected = 1');
  if (q.connected === '0') where.push('c.connected = 0');
  if (q.disposition) { where.push('c.disposition = $disp'); p.disp = q.disposition; }
  if (q.has_recording === '1') where.push('c.recording_path IS NOT NULL');
  if (q.q) { where.push('(c.phone LIKE $q OR l.name LIKE $q)'); p.q = `%${q.q}%`; }
  if (q.min_duration) { where.push('c.duration >= $mind'); p.mind = int(q.min_duration); }
  if (q.direction) { where.push('c.direction = $dir'); p.dir = q.direction === 'inbound' ? 'inbound' : 'outbound'; }
  if (q.status === 'missed') where.push("c.status = 'missed'");
  if (q.sentiment) { where.push('ca.sentiment = $sent'); p.sent = q.sentiment; }
  if (q.max_score) { where.push('ca.quality_score <= $mxs'); p.mxs = int(q.max_score); }
  return { where: where.join(' AND '), params: p };
}

const SELECT = `SELECT c.id, c.lead_id, c.campaign_id, c.user_id, c.phone, c.direction, c.mode, c.status, c.connected, c.started_at,
  c.answered_at, c.ended_at, c.duration, c.disposition, c.notes, c.sim_slot, (c.recording_path IS NOT NULL) AS has_recording,
  l.name AS lead_name, u.name AS agent_name, cp.name AS campaign_name,
  ca.status AS ai_status, ca.quality_score AS ai_score, ca.sentiment AS ai_sentiment, ca.summary AS ai_summary
  FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id
  LEFT JOIN call_ai ca ON ca.call_id = c.id`;

router.get('/', h((req, res) => {
  const { where, params } = filters(req);
  const limit = Math.min(500, Math.max(1, int(req.query.limit, 50)));
  const page = Math.max(1, int(req.query.page, 1));
  const total = db.get(`SELECT COUNT(*) AS n FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN call_ai ca ON ca.call_id = c.id WHERE ${where}`, params).n;
  const rows = db.all(`${SELECT} WHERE ${where} ORDER BY c.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
  res.json({ total, page, limit, rows });
}));

router.get('/export', requireRole('manager'), h((req, res) => {
  const { where, params } = filters(req);
  const rows = db.all(`${SELECT} WHERE ${where} ORDER BY c.id DESC LIMIT 200000`, params);
  audit(req, 'call.export', { count: rows.length });
  sendCsv(res, `calls-${new Date().toISOString().slice(0, 10)}.csv`, rows,
    ['id', 'started_at', 'direction', 'agent_name', 'campaign_name', 'lead_name', 'phone', 'mode', 'status', 'connected', 'duration', 'disposition', 'notes', 'has_recording', 'ai_score', 'ai_sentiment', 'ai_summary']);
}));

function loadCall(req) {
  const c = db.get('SELECT * FROM calls WHERE id = ? AND company_id = ?', [int(req.params.id), req.user.company_id]);
  if (!c) throw notFound('Call');
  if (!isManager(req.user) && c.user_id !== req.user.id) throw forbidden();
  return c;
}

router.get('/:id', h((req, res) => {
  const c = loadCall(req);
  res.json(db.get(`${SELECT} WHERE c.id = ?`, [c.id]));
}));

router.get('/:id/ai', h((req, res) => {
  const c = loadCall(req);
  res.json(ai.getAnalysis(c.id) || { status: 'none' });
}));

router.post('/:id/analyze', requireRole('manager'), h((req, res) => {
  const c = loadCall(req);
  const cfg = ai.aiConfig(c.company_id);
  const demo = require('../settings').getSettings(c.company_id).demo_mode;
  if (!cfg.enabled && !demo) throw bad('Turn on AI call analysis in Integrations first');
  if (!c.recording_path && !demo) throw bad('This call has no recording to analyse');
  ai.enqueue(c.id, { force: true });
  res.json({ ok: true, status: 'pending' });
}));

router.post('/:id/disposition', h((req, res) => {
  loadCall(req);
  res.json(dialer.applyDisposition(req.user, int(req.params.id), req.body || {}));
}));

/** Update notes/disposition after the fact (managers / call owner). */
router.put('/:id', h((req, res) => {
  const c = loadCall(req);
  if (req.body.notes !== undefined) db.run('UPDATE calls SET notes = ? WHERE id = ?', [String(req.body.notes), c.id]);
  res.json(db.get(`${SELECT} WHERE c.id = ?`, [c.id]));
}));

router.post('/:id/recording', (req, res, next) => {
  try { loadCall(req); } catch (e) { return next(e); }
  upload.single('file')(req, res, (e) => {
    if (e) return next(Object.assign(e, { status: 400 }));
    if (!req.file) return next(bad('Upload an audio file in field "file"'));
    const call = db.get('SELECT recording_path FROM calls WHERE id = ?', [int(req.params.id)]);
    if (call.recording_path) fs.rm(path.join(config.uploadsDir, call.recording_path), () => {});
    const rel = path.relative(config.uploadsDir, req.file.path);
    db.run('UPDATE calls SET recording_path = ? WHERE id = ?', [rel, int(req.params.id)]);
    ai.enqueue(int(req.params.id));
    res.json({ ok: true });
  });
});

router.get('/:id/recording', h((req, res) => {
  const c = loadCall(req);
  if (!c.recording_path) throw notFound('Recording');
  const file = path.resolve(config.uploadsDir, c.recording_path);
  if (!file.startsWith(path.resolve(config.uploadsDir)) || !fs.existsSync(file)) throw notFound('Recording');
  if (req.query.download) res.attachment(`call-${c.id}-${c.phone}${path.extname(file)}`);
  res.sendFile(file);
}));

router.delete('/:id/recording', requireRole('admin'), h((req, res) => {
  const c = loadCall(req);
  if (c.recording_path) fs.rm(path.join(config.uploadsDir, c.recording_path), () => {});
  db.run('UPDATE calls SET recording_path = NULL WHERE id = ?', [c.id]);
  audit(req, 'call.recording_delete', { id: c.id });
  res.json({ ok: true });
}));

module.exports = router;
