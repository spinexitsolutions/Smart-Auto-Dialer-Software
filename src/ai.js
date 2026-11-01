'use strict';
/**
 * AI call analysis: speech-to-text on the call recording, then Claude reads the
 * transcript and returns a structured summary, customer sentiment and QA scores.
 *
 * Config lives in an `integrations` row of type 'ai':
 *   { enabled, auto, stt_provider: 'sarvam'|'deepgram'|'openai', stt_key, language,
 *     anthropic_key, model }
 */
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const config = require('./config');
const db = require('./db');
const { getSettings } = require('./settings');
const { sqlNow, activity } = require('./util');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (best quality)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (balanced)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (lowest cost)',
};
// Server-side refusal fallback is available for these models on the Claude API.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const Analysis = z.object({
  summary: z.string().describe('2-3 sentence summary of the call in simple English'),
  customer_sentiment: z.enum(['positive', 'neutral', 'negative']),
  customer_intent: z.string().describe('What the customer wants / their buying or paying intent, one line'),
  key_points: z.array(z.string()).describe('Important facts mentioned: budget, dates, amounts, objections'),
  next_action: z.string().describe('Single best next step for the agent'),
  suggested_outcome: z.string().describe('Which call outcome best fits the conversation'),
  quality_score: z.number().int().describe('Overall agent call quality 0-100'),
  script_adherence: z.number().int().describe('How closely the agent followed the call script 0-100 (use 50 if no script)'),
  politeness: z.number().int().describe('Agent politeness and tone 0-100'),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()).describe('Concrete coaching tips for the agent'),
  red_flags: z.array(z.string()).describe('Compliance or conduct issues: rude language, false promises, threats, sharing wrong info. Empty if none.'),
  language: z.string().describe('Main language spoken, e.g. Hindi, English, Hinglish'),
});

let anthropicFactory = (apiKey) => new Anthropic({ apiKey });
let fetchImpl = (...a) => fetch(...a);
function _setClients({ anthropic, fetch: f } = {}) { if (anthropic) anthropicFactory = anthropic; if (f) fetchImpl = f; }

const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function aiConfig(companyId) {
  const row = db.get("SELECT * FROM integrations WHERE company_id = ? AND type = 'ai' ORDER BY id DESC LIMIT 1", [companyId]);
  const cfg = row ? parseJson(row.config, {}) : {};
  return { id: row?.id || null, enabled: !!(row && row.active && cfg.enabled), auto: cfg.auto !== false, model: cfg.model || DEFAULT_MODEL, ...cfg };
}

/** Queue a call for analysis (idempotent). */
function enqueue(callId, { force = false } = {}) {
  const call = db.get('SELECT id, company_id, connected, duration, recording_path FROM calls WHERE id = ?', [callId]);
  if (!call) return false;
  const cfg = aiConfig(call.company_id);
  const demo = getSettings(call.company_id).demo_mode;
  if (!force && (!cfg.enabled || !cfg.auto)) return false;
  if (!cfg.enabled && !demo) return false;
  if (!call.recording_path && !demo) return false;
  if (!force && !call.connected && call.duration < 5) return false;
  const existing = db.get('SELECT status FROM call_ai WHERE call_id = ?', [callId]);
  if (existing && !force && existing.status !== 'failed') return false;
  db.run(`INSERT INTO call_ai (call_id, company_id, status) VALUES (?,?, 'pending')
          ON CONFLICT(call_id) DO UPDATE SET status = 'pending', error = NULL, attempts = 0, updated_at = datetime('now')`, [callId, call.company_id]);
  setTimeout(() => processQueue().catch(() => {}), 300).unref?.();
  return true;
}

// ------------------------------------------------------------------ speech to text

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.amr': 'audio/amr', '.3gp': 'audio/3gpp', '.webm': 'audio/webm' };

async function transcribe(cfg, file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const lang = cfg.language || 'hi-IN';
  if (!cfg.stt_key) throw new Error('Speech-to-text API key is not set (Integrations → AI)');
  if (cfg.stt_provider === 'deepgram') {
    const res = await fetchImpl(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=${lang.startsWith('en') ? 'en' : 'multi'}`, {
      method: 'POST', headers: { Authorization: `Token ${cfg.stt_key}`, 'Content-Type': type }, body: buf, signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.err_msg || `Deepgram error ${res.status}`);
    const alt = data.results?.channels?.[0]?.alternatives?.[0] || {};
    return alt.paragraphs?.transcript || alt.transcript || '';
  }
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), path.basename(file));
  if (cfg.stt_provider === 'openai') {
    form.append('model', 'whisper-1');
    const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${cfg.stt_key}` }, body: form, signal: AbortSignal.timeout(180000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Transcription error ${res.status}`);
    return data.text || '';
  }
  // Sarvam AI (Indian languages, Hinglish) - default
  form.append('language_code', cfg.language === 'auto' ? 'unknown' : lang);
  if (cfg.stt_model) form.append('model', cfg.stt_model);
  const res = await fetchImpl('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': cfg.stt_key }, body: form, signal: AbortSignal.timeout(180000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `Sarvam error ${res.status}`);
  return data.transcript || '';
}

// ------------------------------------------------------------------ analysis

function buildPrompt(ctx) {
  return [
    `You are a call-quality analyst for an Indian ${ctx.campaignType || 'sales'} telecalling team.`,
    'Analyse the phone call transcript below between our agent and a customer. The transcript may be in Hindi, English or Hinglish and may contain speech-recognition errors; infer meaning sensibly.',
    'Write the summary, key points and coaching in simple English. Be fair and specific; base every judgement on the transcript only.',
    '',
    `Business: ${ctx.business}`,
    `Campaign: ${ctx.campaign || 'n/a'} (${ctx.campaignType || 'n/a'})`,
    `Agent: ${ctx.agent || 'n/a'}`,
    `Customer: ${ctx.customer || 'n/a'}`,
    `Outcome selected by agent: ${ctx.disposition || 'not yet selected'}`,
    `Call duration: ${ctx.duration}s`,
    '',
    ctx.script ? `<call_script>\n${ctx.script}\n</call_script>` : '<call_script>No script provided.</call_script>',
    '',
    `<transcript>\n${ctx.transcript}\n</transcript>`,
  ].join('\n');
}

async function analyze(cfg, ctx) {
  if (!cfg.anthropic_key) throw new Error('Claude API key is not set (Integrations → AI)');
  const client = anthropicFactory(cfg.anthropic_key);
  const model = MODELS[cfg.model] ? cfg.model : DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(Analysis) },
    messages: [{ role: 'user', content: buildPrompt(ctx) }],
  };
  const response = FALLBACK_MODELS.has(model)
    ? await client.beta.messages.parse({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.parse(params);
  if (response.stop_reason === 'refusal') throw new Error('The AI declined to analyse this call');
  if (!response.parsed_output) throw new Error('AI returned an unreadable answer');
  const out = response.parsed_output;
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  return { ...out, quality_score: clamp(out.quality_score), script_adherence: clamp(out.script_adherence), politeness: clamp(out.politeness), model: response.model || model };
}

/** Deterministic sample analysis for demo companies without API keys. */
function demoAnalysis(ctx, seed) {
  const r = (n) => Math.abs(Math.sin(seed * 9301 + n * 49297)) % 1;
  const sentiment = ctx.success ? 'positive' : r(1) < 0.5 ? 'neutral' : 'negative';
  const q = Math.round(55 + r(2) * 40);
  return {
    summary: `${ctx.customer || 'The customer'} spoke with ${ctx.agent || 'the agent'} about ${ctx.campaign || 'our offer'}. The call ended with "${ctx.disposition || 'no outcome yet'}".`,
    customer_sentiment: sentiment,
    customer_intent: sentiment === 'positive' ? 'Interested and wants to proceed' : sentiment === 'neutral' ? 'Wants more information before deciding' : 'Not interested at the moment',
    key_points: ['Customer confirmed their requirement', 'Asked about pricing / charges', 'Prefers communication on WhatsApp'],
    next_action: sentiment === 'negative' ? 'Close politely; retry after 30 days' : 'Send details on WhatsApp and call back tomorrow',
    suggested_outcome: ctx.disposition || 'Call Back Later',
    quality_score: q, script_adherence: Math.round(50 + r(3) * 45), politeness: Math.round(70 + r(4) * 30),
    strengths: ['Clear introduction', 'Polite tone throughout'],
    improvements: q < 75 ? ['Ask more discovery questions before pitching', 'Confirm the next step and time before ending the call'] : ['Summarise the offer once more before closing'],
    red_flags: [], language: 'Hinglish', model: 'demo',
  };
}

function callContext(call, transcript) {
  const lead = call.lead_id ? db.get('SELECT name FROM leads WHERE id = ?', [call.lead_id]) : null;
  const camp = call.campaign_id ? db.get('SELECT name, type, script FROM campaigns WHERE id = ?', [call.campaign_id]) : null;
  const agent = call.user_id ? db.get('SELECT name FROM users WHERE id = ?', [call.user_id]) : null;
  const disp = call.disposition_id ? db.get('SELECT name, is_success FROM dispositions WHERE id = ?', [call.disposition_id]) : null;
  const company = db.get('SELECT name FROM companies WHERE id = ?', [call.company_id]);
  return {
    business: company?.name, campaign: camp?.name, campaignType: camp?.type, script: camp?.script, agent: agent?.name, customer: lead?.name,
    disposition: disp?.name || call.disposition, success: !!disp?.is_success, duration: call.duration, transcript,
  };
}

async function processOne(row) {
  const call = db.get('SELECT * FROM calls WHERE id = ?', [row.call_id]);
  if (!call) { db.run('DELETE FROM call_ai WHERE call_id = ?', [row.call_id]); return; }
  const cfg = aiConfig(call.company_id);
  const demo = getSettings(call.company_id).demo_mode;
  let transcript = row.transcript;
  let result;
  const useDemo = demo && (!cfg.enabled || !cfg.anthropic_key || (!call.recording_path && !transcript));
  if (useDemo) {
    transcript = transcript || '(Demo mode: no real recording — sample analysis shown)';
    result = demoAnalysis(callContext(call, transcript), call.id);
  } else {
    if (!transcript) {
      if (!call.recording_path) throw new Error('No recording for this call');
      const file = path.resolve(config.uploadsDir, call.recording_path);
      if (!file.startsWith(path.resolve(config.uploadsDir)) || !fs.existsSync(file)) throw new Error('Recording file missing');
      transcript = await transcribe(cfg, file);
      db.run('UPDATE call_ai SET transcript = ? WHERE call_id = ?', [transcript, call.id]);
    }
    if (!transcript || transcript.trim().length < 5) throw new Error('Recording had no detectable speech');
    result = await analyze(cfg, callContext(call, transcript));
  }
  const { model, ...data } = result;
  db.run(`UPDATE call_ai SET status = 'done', transcript = ?, summary = ?, sentiment = ?, quality_score = ?, script_score = ?, data = ?, model = ?, error = NULL, updated_at = ? WHERE call_id = ?`,
    [transcript, data.summary, data.customer_sentiment, data.quality_score, data.script_adherence, JSON.stringify(data), model, sqlNow(), call.id]);
  if (call.lead_id) activity(call.company_id, call.lead_id, null, 'ai', `AI summary: ${data.summary}${data.next_action ? ' Next: ' + data.next_action : ''}`.slice(0, 900));
}

let running = false;
async function processQueue(limit = 3) {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const rows = db.all("SELECT * FROM call_ai WHERE status = 'pending' ORDER BY created_at LIMIT ?", [limit]);
    for (const row of rows) {
      db.run("UPDATE call_ai SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE call_id = ?", [sqlNow(), row.call_id]);
      try {
        await processOne(row);
      } catch (e) {
        const retry = row.attempts + 1 < 3 && !/not set|No recording|missing|declined|no detectable/.test(e.message);
        db.run('UPDATE call_ai SET status = ?, error = ?, updated_at = ? WHERE call_id = ?', [retry ? 'pending' : 'failed', String(e.message).slice(0, 500), sqlNow(), row.call_id]);
      }
      n++;
    }
  } finally { running = false; }
  return n;
}

function getAnalysis(callId) {
  const row = db.get('SELECT * FROM call_ai WHERE call_id = ?', [callId]);
  if (!row) return null;
  return { ...row, data: parseJson(row.data, null) };
}

module.exports = { MODELS, DEFAULT_MODEL, Analysis, aiConfig, enqueue, processQueue, getAnalysis, demoAnalysis, buildPrompt, _setClients };
