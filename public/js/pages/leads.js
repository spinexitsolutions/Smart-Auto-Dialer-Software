// Leads list: filters, bulk actions, import/export, add.
import {
  state, get, post, api, esc, html, modal, toast, toastErr, options, statusBadge, fmtDate, ago, num, download, isManager, isAdmin,
  loadRefs, confirmBox, STATUS_LABEL,
} from '../core.js';
import { openLead, newLeadModal } from './lead.js';

const q = { q: '', status: '', campaign_id: '', assigned_to: '', source: '', sort: 'created', page: 1, limit: 50, due: '' };
let selected = new Set();
let data = { rows: [], total: 0 };

export async function render(el, params) {
  await loadRefs();
  selected = new Set();
  const fromCampaign = sessionStorage.getItem('leadCampaign');
  if (fromCampaign) { sessionStorage.removeItem('leadCampaign'); Object.assign(q, { campaign_id: fromCampaign, status: '', assigned_to: '', q: '', page: 1 }); }
  paintShell(el);
  await load(el);
  if (params[0] && /^\d+$/.test(params[0])) openLead(Number(params[0]), { onChange: () => load(el) });
}

function query() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== '' && v != null) p.set(k, v);
  return p.toString();
}

function paintShell(el) {
  const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
  const mgr = isManager();
  el.innerHTML = html`
    <div class="page-head">
      <div><h1>${mgr ? 'Leads' : 'My leads'}</h1><small class="muted" id="countLbl"></small></div>
      <span class="spacer"></span>
      ${mgr ? '<button class="btn" id="importBtn">⬆ Import CSV</button><button class="btn" id="exportBtn">⬇ Export</button>' : ''}
      <button class="btn primary" id="addBtn">＋ Add lead</button>
    </div>
    <div class="card">
      <div class="card-body toolbar" style="border-bottom:1px solid var(--border)">
        <input type="search" id="fq" placeholder="Search name, phone, email, city, tag…" value="${esc(q.q)}">
        <select id="fstatus">${options(statuses.map((s) => [s, STATUS_LABEL[s] || s]), q.status, { empty: 'All statuses' })}</select>
        <select id="fcamp">${options([['none', '— No campaign —'], ...state.campaigns.map((c) => [c.id, c.name])], q.campaign_id, { empty: 'All campaigns' })}</select>
        ${mgr ? `<select id="fagent">${options([['none', '— Unassigned —'], ...state.users.map((u) => [u.id, u.name])], q.assigned_to, { empty: 'All agents' })}</select>` : ''}
        <select id="fdue">${options([['1', 'Callback due now']], q.due, { empty: 'Any callback' })}</select>
        <select id="fsort">${options([['created', 'Newest first'], ['updated', 'Recently updated'], ['priority', 'Priority'], ['next_call', 'Next callback'], ['last_called', 'Last called'], ['name', 'Name A-Z']], q.sort)}</select>
      </div>
      <div id="bulkBar" class="card-body toolbar hidden" style="background:var(--primary-soft);border-bottom:1px solid var(--border)"></div>
      <div class="table-wrap" id="tbl"></div>
      <div class="pager" id="pager"></div>
    </div>`;
  let t;
  el.querySelector('#fq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value.trim(); q.page = 1; load(el); }, 300); };
  const bindSel = (id, key) => { const n = el.querySelector(id); if (n) n.onchange = (e) => { q[key] = e.target.value; q.page = 1; load(el); }; };
  bindSel('#fstatus', 'status'); bindSel('#fcamp', 'campaign_id'); bindSel('#fagent', 'assigned_to'); bindSel('#fsort', 'sort'); bindSel('#fdue', 'due');
  el.querySelector('#addBtn').onclick = () => newLeadModal(() => load(el));
  if (mgr) {
    el.querySelector('#exportBtn').onclick = () => download(`/leads/export?${query()}`);
    el.querySelector('#importBtn').onclick = () => importModal(() => load(el));
  }
}

async function load(el) {
  try { data = await get(`/leads?${query()}`); } catch (e) { return toastErr(e); }
  const mgr = isManager();
  el.querySelector('#countLbl').textContent = `${num(data.total)} lead${data.total === 1 ? '' : 's'}`;
  const tbl = el.querySelector('#tbl');
  if (!data.rows.length) {
    tbl.innerHTML = `<div class="empty">No leads found.${mgr ? ' Import a CSV or add leads manually.' : ''}</div>`;
  } else {
    tbl.innerHTML = `<table><thead><tr>
      ${mgr ? '<th style="width:30px"><input type="checkbox" id="selAll"></th>' : ''}
      <th>Name</th><th>Phone</th><th>Status</th><th class="hide-sm">Campaign</th>${mgr ? '<th class="hide-sm">Agent</th>' : ''}
      <th class="hide-sm">Last result</th><th class="hide-sm">Attempts</th><th>Next callback</th><th></th></tr></thead><tbody>
      ${data.rows.map((l) => `<tr class="clickable" data-id="${l.id}">
        ${mgr ? `<td data-stop><input type="checkbox" data-sel="${l.id}" ${selected.has(l.id) ? 'checked' : ''}></td>` : ''}
        <td><b>${esc(l.name || '—')}</b>${l.priority > 0 ? ' <span class="badge red">★</span>' : ''}<div class="muted" style="font-size:12px">${esc([l.city, l.source].filter(Boolean).join(' · '))}</div></td>
        <td class="mono nowrap">${esc(l.phone)}</td>
        <td>${statusBadge(l.status)}</td>
        <td class="hide-sm">${esc(l.campaign_name || '—')}</td>
        ${mgr ? `<td class="hide-sm">${esc(l.assigned_name || '—')}</td>` : ''}
        <td class="hide-sm">${esc(l.last_disposition || '—')}${l.last_called_at ? `<div class="muted" style="font-size:12px">${ago(l.last_called_at)}</div>` : ''}</td>
        <td class="hide-sm">${l.attempts}</td>
        <td class="nowrap">${l.next_call_at ? `<span style="${new Date(l.next_call_at.replace(' ', 'T') + 'Z') < new Date() ? 'color:var(--red);font-weight:600' : ''}">${fmtDate(l.next_call_at)}</span>` : '<span class="faint">—</span>'}</td>
        <td class="actions" data-stop><button class="btn sm green" data-call="${l.id}" title="Call now">📞</button></td>
      </tr>`).join('')}</tbody></table>`;
  }
  const pages = Math.max(1, Math.ceil(data.total / q.limit));
  el.querySelector('#pager').innerHTML = `Page ${q.page} of ${pages}
    <button class="btn sm" id="prev" ${q.page <= 1 ? 'disabled' : ''}>‹ Prev</button><button class="btn sm" id="next" ${q.page >= pages ? 'disabled' : ''}>Next ›</button>
    <select id="limit" style="width:auto">${options([25, 50, 100, 250], q.limit)}</select>`;
  el.querySelector('#prev').onclick = () => { q.page--; load(el); };
  el.querySelector('#next').onclick = () => { q.page++; load(el); };
  el.querySelector('#limit').onchange = (e) => { q.limit = Number(e.target.value); q.page = 1; load(el); };
  tbl.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = (e) => {
    if (e.target.closest('[data-stop]')) return;
    openLead(Number(tr.dataset.id), { onChange: () => load(el) });
  }));
  tbl.querySelectorAll('[data-call]').forEach((b) => (b.onclick = () => {
    if (!state.socket?.connected) return toast('Not connected to server', 'error');
    state.socket.emit('dial', { leadId: Number(b.dataset.call) }, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); });
    location.hash = '#/agent';
  }));
  tbl.querySelectorAll('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? selected.add(Number(c.dataset.sel)) : selected.delete(Number(c.dataset.sel)); bulkBar(el); }));
  const all = tbl.querySelector('#selAll');
  if (all) {
    all.checked = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id));
    all.onchange = () => { data.rows.forEach((r) => (all.checked ? selected.add(r.id) : selected.delete(r.id))); load(el); };
  }
  bulkBar(el);
}

function bulkBar(el) {
  const bar = el.querySelector('#bulkBar');
  if (!isManager() || !selected.size) { bar.classList.add('hidden'); return; }
  const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
  bar.classList.remove('hidden');
  bar.innerHTML = `<b>${selected.size} selected</b>
    ${data.total > selected.size ? `<button class="btn sm ghost" id="selMatching">Select all ${num(data.total)} matching</button>` : ''}
    <select data-bulk="assign">${options(state.users.filter((u) => u.active !== 0).map((u) => [u.id, u.name]), '', { empty: 'Assign to…' })}<option value="0">— Unassign —</option></select>
    <button class="btn sm" data-bulk-btn="distribute">Distribute equally…</button>
    <select data-bulk="campaign">${options(state.campaigns.map((c) => [c.id, c.name]), '', { empty: 'Move to campaign…' })}</select>
    <select data-bulk="status">${options(statuses.map((s) => [s, STATUS_LABEL[s] || s]), '', { empty: 'Set status…' })}</select>
    <select data-bulk="priority"><option value="">Priority…</option><option value="0">Normal</option><option value="1">High</option><option value="2">Urgent</option></select>
    <button class="btn sm" data-bulk-btn="tag">🏷 Tag</button>
    <button class="btn sm" data-bulk-btn="dnc">⛔ DNC</button>
    ${isAdmin() ? '<button class="btn sm red" data-bulk-btn="delete">Delete</button>' : ''}
    <button class="btn sm ghost" id="clearSel">Clear</button>`;
  let allMatching = false;
  const ids = () => [...selected];
  const run = async (action, value, label) => {
    const body = allMatching ? { action, value, all_matching: true, filters: Object.fromEntries(new URLSearchParams(query())) } : { action, value, ids: ids() };
    try {
      const r = await post('/leads/bulk', body);
      toast(`${label}: ${r.changed} lead(s) updated`, 'success');
      selected.clear(); load(el);
    } catch (e) { toastErr(e); }
  };
  const sm = bar.querySelector('#selMatching');
  if (sm) sm.onclick = () => { allMatching = true; sm.outerHTML = `<span class="badge primary">All ${num(data.total)} matching leads</span>`; };
  bar.querySelectorAll('[data-bulk]').forEach((s) => (s.onchange = () => {
    if (s.value === '') return;
    const v = s.dataset.bulk === 'status' ? s.value : Number(s.value);
    run(s.dataset.bulk, s.dataset.bulk === 'assign' && v === 0 ? null : v, s.selectedOptions[0].textContent);
  }));
  bar.querySelectorAll('[data-bulk-btn]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.bulkBtn;
    if (a === 'distribute') {
      modal({
        title: 'Distribute leads equally (round robin)',
        body: `<p class="muted" style="margin-top:0">Selected leads are shared one-by-one between the agents you tick.</p>
          <div class="col">${state.users.filter((u) => u.active !== 0 && u.role === 'agent').map((u) => `<label class="check"><input type="checkbox" name="agents" data-multi value="${u.id}" checked> ${esc(u.name)}</label>`).join('')}</div>`,
        submit: 'Distribute',
        onSubmit: (d) => run('distribute', d.agents || [], 'Distributed'),
      });
    } else if (a === 'tag') {
      const { promptBox } = await import('../core.js');
      const t = await promptBox('Add tag', { label: 'Tag name', ok: 'Add tag' });
      if (t) run('tag', t, 'Tagged');
    } else if (a === 'dnc') {
      if (await confirmBox('Add the selected numbers to the Do-Not-Call list?')) run('dnc', null, 'Added to DNC');
    } else if (a === 'delete') {
      if (await confirmBox(`Permanently delete ${allMatching ? data.total : selected.size} lead(s)?`)) run('delete', null, 'Deleted');
    }
  }));
  bar.querySelector('#clearSel').onclick = () => { selected.clear(); load(el); };
}

function importModal(done) {
  modal({
    title: 'Import leads from CSV', wide: true, submit: 'Import',
    body: `<div class="col">
      <div class="muted">Upload a <b>.csv</b> file (save Excel as “CSV UTF-8”). The first row must be the header.
        Columns are detected automatically: <code>name, phone/mobile, email, city, state, company, source, tags, priority, amount due, due date, deal value, status</code>.
        Any other columns are kept as custom fields. <a href="#" id="sampleCsv">Download sample</a></div>
      <label class="field">CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
      <div class="form-grid">
        <label class="field">Add to campaign<select name="campaign_id">${options(state.campaigns, '', { empty: '— No campaign —' })}</select></label>
        <label class="field">Duplicates (same number)<select name="duplicates">${options([['skip', 'Skip duplicates'], ['update', 'Update existing lead'], ['allow', 'Import anyway']], 'skip')}</select></label>
        <label class="field">Assign leads<select name="assign">${options([['none', 'Leave unassigned (shared queue)'], ['round_robin', 'Round robin between campaign agents'], ...state.users.filter((u) => u.active !== 0).map((u) => [u.id, `All to ${u.name}`])], 'none')}</select></label>
        <label class="field">Source (if not in file)<input name="source" placeholder="e.g. Facebook Ads Oct"></label>
      </div>
      <div id="impResult"></div>
    </div>`,
    onOpen: (form) => {
      form.querySelector('#sampleCsv').onclick = (e) => {
        e.preventDefault();
        const csv = 'name,phone,email,city,source,amount due,due date,Loan Amount\nRahul Sharma,9876543210,rahul@example.com,Pune,Website,,,25 Lakh\nPriya Singh,+91 98111 22233,,Delhi,Facebook,15000,2026-11-05,\n';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'sample-leads.csv'; a.click();
      };
    },
    onSubmit: async (d, form) => {
      const file = form.file.files[0];
      if (!file) { toast('Choose a CSV file', 'error'); return false; }
      const fd = new FormData();
      fd.append('file', file);
      for (const k of ['campaign_id', 'duplicates', 'assign', 'source']) if (d[k]) fd.append(k, d[k]);
      const r = await api('/leads/import', { method: 'POST', form: fd });
      form.querySelector('#impResult').innerHTML = `<div class="card card-pad" style="background:var(--green-soft)">
        <b>✓ Imported ${num(r.imported)} of ${num(r.total)} rows.</b> ${r.updated ? `Updated ${r.updated}. ` : ''}Duplicates skipped: ${r.duplicates}. Invalid numbers: ${r.invalid}. On DNC list: ${r.dnc}.
        ${r.errors.length ? `<pre>${esc(r.errors.join('\n'))}</pre>` : ''}</div>`;
      form.querySelector('button[type=submit]').classList.add('hidden');
      done();
      return false;
    },
  });
}
