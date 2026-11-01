'use strict';
/**
 * Public integration API authenticated with the company API key (header X-API-Key).
 * Lets customers push leads from websites, Facebook/Google lead forms, Zapier, IndiaMART, etc.
 */
const express = require('express');
const db = require('../db');
const dialer = require('../dialer');
const { licenseProblem } = require('../auth');
const { h, HttpError, bad, int, cleanPhone, phoneKey, isValidPhone, activity } = require('../util');
const { importRows } = require('./leads');

const router = express.Router();

router.use((req, res, next) => {
  const key = req.get('X-API-Key') || req.query.api_key;
  if (!key) return next(new HttpError(401, 'Missing X-API-Key header'));
  const company = db.get('SELECT * FROM companies WHERE api_key = ?', [String(key)]);
  if (!company) return next(new HttpError(401, 'Invalid API key'));
  const problem = licenseProblem(company);
  if (problem) return next(new HttpError(402, problem));
  req.company = company;
  next();
});

/** Create one lead (or many with { leads: [...] }). */
router.post('/leads', h((req, res) => {
  const cid = req.company.id;
  if (Array.isArray(req.body.leads)) {
    const result = importRows(cid, null, req.body.leads.slice(0, 5000), { ...req.body, source: req.body.source || 'API' });
    return res.json(result);
  }
  const b = req.body;
  const phone = cleanPhone(b.phone || b.mobile);
  if (!isValidPhone(phone)) throw bad('A valid phone is required');
  if (b.campaign_id && !db.get('SELECT id FROM campaigns WHERE id = ? AND company_id = ?', [int(b.campaign_id), cid])) throw bad('Invalid campaign_id');
  const existing = db.get('SELECT id FROM leads WHERE company_id = ? AND phone_key = ?', [cid, phoneKey(phone)]);
  if (existing) {
    activity(cid, existing.id, null, 'note', `Re-enquiry via API${b.source ? ' (' + b.source + ')' : ''}${b.message ? ': ' + b.message : ''}`);
    // Re-enquiries jump the queue.
    db.run("UPDATE leads SET priority = priority + 1, updated_at = datetime('now') WHERE id = ?", [existing.id]);
    return res.json({ ok: true, id: existing.id, duplicate: true });
  }
  const custom = typeof b.custom === 'object' && b.custom ? b.custom : {};
  if (b.message) custom.message = String(b.message);
  const id = db.insert('leads', {
    company_id: cid, campaign_id: b.campaign_id ? int(b.campaign_id) : null, name: b.name || null, phone, phone_key: phoneKey(phone),
    email: b.email || null, city: b.city || null, company_name: b.company_name || null, source: b.source || 'API', tags: b.tags || null,
    priority: int(b.priority, 1), custom: JSON.stringify(custom),
  }, ['company_id', 'campaign_id', 'name', 'phone', 'phone_key', 'email', 'city', 'company_name', 'source', 'tags', 'priority', 'custom']);
  activity(cid, id, null, 'created', `Lead captured via API (${b.source || 'API'})`);
  dialer.fireWebhook(cid, 'lead.created', db.get('SELECT * FROM leads WHERE id = ?', [id]));
  require('../messaging').runAutomations(cid, 'lead_created', { leadId: id });
  res.status(201).json({ ok: true, id });
}));

router.get('/leads/:id', h((req, res) => {
  const l = db.get('SELECT id, name, phone, email, status, last_disposition, attempts, last_called_at, next_call_at, created_at FROM leads WHERE id = ? AND company_id = ?', [int(req.params.id), req.company.id]);
  if (!l) throw new HttpError(404, 'Lead not found');
  res.json(l);
}));

router.get('/campaigns', h((req, res) => {
  res.json(db.all('SELECT id, name, type, status FROM campaigns WHERE company_id = ?', [req.company.id]));
}));

module.exports = router;
