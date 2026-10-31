import {
  get, post, put, esc, modal, toast, toastErr, options, fmtDate, ago, state, loadRefs,
} from '../core.js';

const STATUS = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']];
const PRIORITY = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']];
const ST_COLOR = { open: 'blue', in_progress: 'violet', resolved: 'green', closed: '' };
const PR_COLOR = { low: '', medium: 'blue', high: 'amber', urgent: 'red' };
const label = (list, v) => (list.find((x) => x[0] === v) || [v, v])[1];

const f = { status: '', priority: '', q: '' };

export async function render(el, params = []) {
  await loadRefs().catch(() => {});
  el.innerHTML = `
    <div class="page-head">
      <div class="toolbar" id="tf">
        <input type="search" name="q" placeholder="Search subject, customer, phone" value="${esc(f.q)}">
        <select name="status">${options(STATUS, f.status, { empty: 'All statuses' })}</select>
        <select name="priority">${options(PRIORITY, f.priority, { empty: 'All priorities' })}</select>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" id="newT">+ New ticket</button>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Subject</th><th>Customer</th><th>Priority</th><th>Status</th><th class="hide-sm">Assigned</th><th class="hide-sm">Updated</th><th></th></tr></thead>
      <tbody id="tb"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
    </table></div></div>`;
  const bar = el.querySelector('#tf');
  let timer;
  bar.addEventListener('input', (e) => { if (e.target.name === 'q') { f.q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 300); } });
  bar.addEventListener('change', (e) => { if (e.target.name && e.target.name !== 'q') { f[e.target.name] = e.target.value; load(); } });
  el.querySelector('#newT').onclick = () => edit(null);

  let rows = [];
  async function load() {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    try { rows = await get(`/tickets?${p}`); } catch (e) { return toastErr(e); }
    const tb = el.querySelector('#tb');
    tb.innerHTML = rows.map((t) => `<tr>
      <td class="muted">#${t.id}</td>
      <td><b>${esc(t.subject)}</b>${t.description ? `<br><small class="muted ellipsis" style="display:block;max-width:360px">${esc(t.description)}</small>` : ''}</td>
      <td>${t.lead_id ? `${esc(t.lead_name || 'Lead #' + t.lead_id)}<br><small class="muted">${esc(t.lead_phone || '')}</small>` : '<span class="muted">—</span>'}</td>
      <td><span class="badge ${PR_COLOR[t.priority]}">${esc(label(PRIORITY, t.priority))}</span></td>
      <td><select data-st="${t.id}" style="width:auto;min-height:30px;padding:3px 8px">${options(STATUS, t.status)}</select></td>
      <td class="hide-sm">${esc(t.assigned_name || '—')}</td>
      <td class="hide-sm" title="${esc(fmtDate(t.updated_at))}">${ago(t.updated_at)}</td>
      <td class="actions"><button class="btn sm" data-e="${t.id}">Open</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No tickets found</td></tr>';
    tb.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => edit(rows.find((r) => r.id === Number(b.dataset.e)))));
    tb.querySelectorAll('[data-st]').forEach((s) => (s.onchange = async () => {
      try { await put(`/tickets/${s.dataset.st}`, { status: s.value }); toast('Status updated', 'success'); load(); } catch (e) { toastErr(e); }
    }));
  }

  function edit(t, prefill = {}) {
    const users = (state.users || []).filter((u) => u.active !== 0);
    const v = t || { priority: 'medium', status: 'open', assigned_to: state.user.id, ...prefill };
    modal({
      title: t ? `Ticket #${t.id}` : 'New ticket',
      wide: true,
      body: `<div class="form-grid">
        <label class="field full">Subject<input name="subject" required value="${esc(v.subject || '')}"></label>
        <label class="field full">Description<textarea name="description" rows="5">${esc(v.description || '')}</textarea></label>
        <label class="field">Priority<select name="priority">${options(PRIORITY, v.priority)}</select></label>
        <label class="field">Status<select name="status">${options(STATUS, v.status)}</select></label>
        <label class="field">Assigned to<select name="assigned_to">${options(users, v.assigned_to, { empty: '— Unassigned —' })}</select></label>
        <label class="field">Lead ID (optional)<input name="lead_id" type="number" min="1" value="${esc(v.lead_id || '')}"></label>
        ${t ? `<div class="full"><small class="muted">Created by ${esc(t.created_by_name || '—')} · ${fmtDate(t.created_at)} · Updated ${fmtDate(t.updated_at)}</small></div>` : ''}
      </div>`,
      onSubmit: async (d) => {
        d.assigned_to = d.assigned_to ? Number(d.assigned_to) : null;
        d.lead_id = d.lead_id ? Number(d.lead_id) : null;
        if (t) await put(`/tickets/${t.id}`, d); else await post('/tickets', d);
        toast(t ? 'Ticket updated' : 'Ticket created', 'success');
        load();
      },
    });
  }

  await load();
  // Deep link: #/tickets/new?lead=12
  const first = params[0] || '';
  if (first.startsWith('new')) {
    const lead = new URLSearchParams(first.split('?')[1] || '').get('lead');
    edit(null, lead ? { lead_id: Number(lead) } : {});
  }
}
