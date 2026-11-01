// Call logs with filters, recordings and export.
import { state, get, esc, html, options, fmtDate, dur, num, download, authUrl, isManager, loadRefs, today, daysAgo, toastErr } from '../core.js';
import { openLead } from './lead.js';

const q = { from: '', to: '', user_id: '', campaign_id: '', connected: '', disposition: '', has_recording: '', q: '', page: 1, limit: 50 };

export async function render(el) {
  await loadRefs();
  if (!q.from) { q.from = daysAgo(6); q.to = today(); }
  const mgr = isManager();
  el.innerHTML = html`
    <div class="page-head"><div><h1>${mgr ? 'Call logs' : 'My calls'}</h1><small class="muted" id="cnt"></small></div><span class="spacer"></span>
      ${mgr ? '<button class="btn" id="exp"><i class="i i-download"></i> Export CSV</button>' : ''}</div>
    <div class="card">
      <div class="card-body toolbar" style="border-bottom:1px solid var(--border)">
        <input type="date" id="from" value="${q.from}"> <input type="date" id="to" value="${q.to}">
        <input type="search" id="fq" placeholder="Phone or name" value="${esc(q.q)}">
        ${mgr ? `<select id="user_id">${options(state.users, q.user_id, { empty: 'All agents' })}</select>` : ''}
        <select id="campaign_id">${options(state.campaigns, q.campaign_id, { empty: 'All campaigns' })}</select>
        <select id="connected">${options([['1', 'Connected'], ['0', 'Not connected']], q.connected, { empty: 'All calls' })}</select>
        <select id="disposition">${options(state.dispositions.map((d) => [d.name, d.name]), q.disposition, { empty: 'All outcomes' })}</select>
        <select id="has_recording">${options([['1', 'With recording']], q.has_recording, { empty: 'Recording: any' })}</select>
      </div>
      <div class="table-wrap" id="tbl"></div><div class="pager" id="pager"></div>
    </div>`;
  const range = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== '' && k !== 'from' && k !== 'to') p.set(k, v);
    if (q.from) p.set('from', new Date(q.from + 'T00:00:00').toISOString());
    if (q.to) p.set('to', new Date(new Date(q.to + 'T00:00:00').getTime() + 86400000).toISOString());
    return p.toString();
  };
  async function load() {
    let d;
    try { d = await get(`/calls?${range()}`); } catch (e) { return toastErr(e); }
    el.querySelector('#cnt').textContent = `${num(d.total)} calls`;
    el.querySelector('#tbl').innerHTML = d.rows.length ? `<table><thead><tr><th>Time</th>${mgr ? '<th>Agent</th>' : ''}<th>Customer</th><th class="hide-sm">Campaign</th><th>Result</th><th>Duration</th><th>Recording</th></tr></thead><tbody>
      ${d.rows.map((c) => `<tr><td class="nowrap">${fmtDate(c.started_at)}</td>${mgr ? `<td>${esc(c.agent_name || '—')}</td>` : ''}
        <td>${c.lead_id ? `<a href="#" data-lead="${c.lead_id}">${esc(c.lead_name || 'Lead')}</a>` : '<span class="muted">Manual</span>'}<div class="mono muted" style="font-size:12px">${esc(c.phone)}</div></td>
        <td class="hide-sm">${esc(c.campaign_name || '—')}</td>
        <td>${c.connected ? '<span class="badge green">Connected</span>' : c.status === 'failed' ? '<span class="badge red">Failed</span>' : '<span class="badge">No answer</span>'} ${esc(c.disposition || '')}
          ${c.notes ? `<div class="muted" style="font-size:12px;max-width:320px">${esc(c.notes)}</div>` : ''}</td>
        <td class="mono">${dur(c.duration)}</td>
        <td>${c.has_recording ? `<audio controls preload="none" src="${authUrl(`/calls/${c.id}/recording`)}"></audio> <a href="${authUrl(`/calls/${c.id}/recording?download=1`)}" title="Download"><i class="i i-download"></i></a>` : '<span class="faint">—</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No calls in this period</div>';
    const pages = Math.max(1, Math.ceil(d.total / q.limit));
    el.querySelector('#pager').innerHTML = `Page ${q.page} of ${pages} <button class="btn sm" id="prev" ${q.page <= 1 ? 'disabled' : ''}>‹ Prev</button><button class="btn sm" id="next" ${q.page >= pages ? 'disabled' : ''}>Next ›</button>`;
    el.querySelector('#prev').onclick = () => { q.page--; load(); };
    el.querySelector('#next').onclick = () => { q.page++; load(); };
    el.querySelectorAll('[data-lead]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openLead(Number(a.dataset.lead), { onChange: load }); }));
  }
  for (const k of ['from', 'to', 'user_id', 'campaign_id', 'connected', 'disposition', 'has_recording']) {
    const n = el.querySelector('#' + k);
    if (n) n.onchange = () => { q[k] = n.value; q.page = 1; load(); };
  }
  let t;
  el.querySelector('#fq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value.trim(); q.page = 1; load(); }, 300); };
  if (mgr) el.querySelector('#exp').onclick = () => download(`/calls/export?${range()}`);
  await load();
}
