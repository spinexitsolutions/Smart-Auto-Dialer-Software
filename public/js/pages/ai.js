// Shared AI call-analysis UI: score badge, sentiment icon and the analysis modal.
import { get, post, esc, modal, toast, toastErr, isManager } from '../core.js';

export function scoreBadge(score) {
  if (score == null) return '';
  const cls = score >= 75 ? 'hi' : score >= 50 ? 'mid' : 'lo';
  return `<span class="score ${cls}" title="AI quality score">${score}</span>`;
}

const SENT = { positive: ['smile', 'var(--green)', 'Positive'], neutral: ['meh', 'var(--amber)', 'Neutral'], negative: ['frown', 'var(--red)', 'Negative'] };
export function sentimentIcon(s, withLabel = false) {
  const m = SENT[s];
  if (!m) return '';
  return `<span title="Customer mood: ${m[2]}" style="color:${m[1]};display:inline-flex;align-items:center;gap:4px"><i class="i i-${m[0]}"></i>${withLabel ? m[2] : ''}</span>`;
}

/** Compact cell for tables: score + mood, or status. */
export function aiCell(row) {
  if (row.ai_status === 'done') return `<a href="#" data-ai="${row.id}" class="row" style="gap:6px;text-decoration:none">${scoreBadge(row.ai_score)}${sentimentIcon(row.ai_sentiment)}</a>`;
  if (row.ai_status === 'pending' || row.ai_status === 'processing') return '<span class="badge violet"><i class="i i-loader"></i> Analysing</span>';
  if (row.ai_status === 'failed') return `<a href="#" data-ai="${row.id}" class="badge red">Failed</a>`;
  return '';
}

export function bindAiLinks(root, onChange) {
  root.querySelectorAll('[data-ai]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openCallAI(Number(a.dataset.ai), onChange); }));
}

const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted">—</div>');

export function analysisHtml(a) {
  const d = a.data || {};
  return `<div class="col gap-lg">
    <div class="ai-box"><h4><i class="i i-sparkles"></i> AI summary${a.model === 'demo' ? ' <span class="badge">sample — demo mode</span>' : ''}</h4>
      <div>${esc(a.summary || d.summary)}</div>
      <div class="row mt-s">${sentimentIcon(a.sentiment, true)}<span class="muted">·</span><span><b>Intent:</b> ${esc(d.customer_intent || '—')}</span></div>
      <div class="mt-s"><b>Next step:</b> ${esc(d.next_action || '—')}</div></div>
    <div class="grid g3" style="gap:10px;text-align:center">
      <div class="card card-pad"><small class="muted">Call quality</small><div style="font-size:26px;font-weight:750">${a.quality_score ?? '—'}</div></div>
      <div class="card card-pad"><small class="muted">Script followed</small><div style="font-size:26px;font-weight:750">${a.script_score ?? '—'}</div></div>
      <div class="card card-pad"><small class="muted">Politeness</small><div style="font-size:26px;font-weight:750">${d.politeness ?? '—'}</div></div>
    </div>
    ${d.red_flags?.length ? `<div class="card card-pad" style="border-color:var(--red)"><h4 style="color:var(--red)"><i class="i i-alert"></i> Red flags</h4>${list(d.red_flags)}</div>` : ''}
    <div class="grid g2">
      <div><h4>Key points</h4>${list(d.key_points)}</div>
      <div><h4>Suggested outcome</h4><div>${esc(d.suggested_outcome || '—')}</div><h4 class="mt">Language</h4><div>${esc(d.language || '—')}</div></div>
      <div><h4>What went well</h4>${list(d.strengths)}</div>
      <div><h4>Coaching tips</h4>${list(d.improvements)}</div>
    </div>
    <details><summary style="cursor:pointer;font-weight:600">Transcript</summary><pre style="max-height:320px">${esc(a.transcript || '')}</pre></details>
  </div>`;
}

export async function openCallAI(callId, onChange) {
  let a;
  try { a = await get(`/calls/${callId}/ai`); } catch (e) { return toastErr(e); }
  const canRun = isManager();
  let body;
  if (a.status === 'done') body = analysisHtml(a);
  else if (a.status === 'failed') body = `<div class="badge red" style="white-space:normal;padding:10px">Analysis failed: ${esc(a.error)}</div>`;
  else if (a.status === 'pending' || a.status === 'processing') body = '<div class="empty"><i class="i i-loader"></i>Analysis in progress. Check back in a minute.</div>';
  else body = '<div class="empty"><i class="i i-brain"></i>This call has not been analysed yet.</div>';
  modal({
    title: `AI call analysis — call #${callId}`, wide: true, body,
    submit: a.status === 'done' ? 'Re-analyse' : 'Analyse now', cancel: 'Close',
    onSubmit: canRun && a.status !== 'pending' && a.status !== 'processing' ? async () => {
      await post(`/calls/${callId}/analyze`, {});
      toast('Analysis started — results appear in about a minute', 'success');
      onChange?.();
    } : undefined,
  });
}
