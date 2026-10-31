// Follow-ups / callbacks list.
import { state, get, put, esc, html, options, fmtDate, ago, toast, toastErr, isManager, loadRefs, statusBadge } from '../core.js';
import { openLead } from './lead.js';

let tab = 'overdue';
let who = '';

export async function render(el) {
  await loadRefs();
  const mgr = isManager();
  async function load() {
    const p = new URLSearchParams();
    if (tab === 'done') p.set('status', 'done'); else p.set('when', tab);
    if (mgr && who === 'me') p.set('mine', '1'); else if (mgr && who) p.set('user_id', who);
    let rows;
    try { rows = await get(`/followups?${p}`); } catch (e) { return toastErr(e); }
    el.innerHTML = html`
      <div class="page-head"><div><h1>Follow-ups & callbacks</h1><small class="muted">Never miss a promised call back</small></div><span class="spacer"></span>
        ${mgr ? `<select id="who" style="width:auto">${options([['me', 'Only mine'], ...state.users.map((u) => [u.id, u.name])], who, { empty: 'All agents' })}</select>` : ''}</div>
      <div class="tabs">${[['overdue', '🔴 Overdue'], ['today', 'Next 24 hours'], ['upcoming', 'Upcoming'], ['done', '✓ Done']].map(([k, l]) => `<a data-t="${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Due</th><th>Customer</th><th>Status</th><th>Note</th>${mgr ? '<th>Agent</th>' : ''}<th></th></tr></thead><tbody>
        ${rows.map((f) => `<tr><td class="nowrap"><b>${fmtDate(f.due_at)}</b><div class="muted" style="font-size:12px">${ago(f.due_at)}</div></td>
          <td><a href="#" data-lead="${f.lead_id}">${esc(f.lead_name || 'Lead')}</a><div class="mono muted" style="font-size:12px">${esc(f.phone)}</div></td>
          <td>${statusBadge(f.lead_status)}</td><td style="max-width:320px">${esc(f.note || '')}</td>${mgr ? `<td>${esc(f.user_name || '')}</td>` : ''}
          <td class="actions">${f.status === 'pending' ? `<button class="btn sm green" data-call="${f.lead_id}">📞 Call</button>
            <button class="btn sm" data-snooze="${f.id}">+1h</button><button class="btn sm" data-done="${f.id}">✓</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Nothing here 🎉</div>'}</div>`;
    el.querySelectorAll('[data-t]').forEach((a) => (a.onclick = () => { tab = a.dataset.t; load(); }));
    const w = el.querySelector('#who'); if (w) w.onchange = () => { who = w.value; load(); };
    el.querySelectorAll('[data-lead]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openLead(Number(a.dataset.lead), { onChange: load }); }));
    el.querySelectorAll('[data-done]').forEach((b) => (b.onclick = async () => { try { await put(`/followups/${b.dataset.done}`, { status: 'done' }); load(); } catch (e) { toastErr(e); } }));
    el.querySelectorAll('[data-snooze]').forEach((b) => (b.onclick = async () => {
      try { await put(`/followups/${b.dataset.snooze}`, { due_at: new Date(Date.now() + 3600000).toISOString() }); toast('Snoozed 1 hour', 'success'); load(); } catch (e) { toastErr(e); }
    }));
    el.querySelectorAll('[data-call]').forEach((b) => (b.onclick = () => {
      if (!state.socket?.connected) return toast('Not connected to server', 'error');
      state.socket.emit('dial', { leadId: Number(b.dataset.call) }, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); });
      location.hash = '#/agent';
    }));
  }
  await load();
}
