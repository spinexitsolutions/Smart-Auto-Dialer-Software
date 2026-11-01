// Lead pipeline (Kanban): drag cards between status columns.
import { state, get, put, esc, html, options, toast, toastErr, money, ago, fmtDate, isManager, loadRefs, STATUS_LABEL } from '../core.js';
import { openLead } from './lead.js';

const COLORS = { new: '#2563eb', contacted: '#64748b', interested: '#16a34a', follow_up: '#7c3aed', converted: '#059669', not_interested: '#dc2626', dnc: '#111827', invalid: '#d97706' };
const q = { campaign_id: '', assigned_to: '', q: '', showClosed: false };

export async function render(el) {
  await loadRefs();
  const mgr = isManager();
  el.innerHTML = html`
    <div class="page-head"><div><h1>Lead pipeline</h1><small class="muted">Drag a card to another column to change its status</small></div><span class="spacer"></span>
      <a class="btn" href="#/leads"><i class="i i-list"></i> List view</a></div>
    <div class="toolbar mb">
      <input type="search" id="pq" placeholder="Search name, phone, city…" value="${esc(q.q)}">
      <select id="pc">${options(state.campaigns, q.campaign_id, { empty: 'All campaigns' })}</select>
      ${mgr ? `<select id="pa">${options([['none', '— Unassigned —'], ...state.users.map((u) => [u.id, u.name])], q.assigned_to, { empty: 'All agents' })}</select>` : ''}
      <label class="check"><input type="checkbox" id="pclosed" ${q.showClosed ? 'checked' : ''}> Show DNC & invalid</label>
    </div>
    <div class="board" id="board"><div class="empty">Loading…</div></div>`;
  let t;
  el.querySelector('#pq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value.trim(); load(el); }, 300); };
  el.querySelector('#pc').onchange = (e) => { q.campaign_id = e.target.value; load(el); };
  const pa = el.querySelector('#pa'); if (pa) pa.onchange = (e) => { q.assigned_to = e.target.value; load(el); };
  el.querySelector('#pclosed').onchange = (e) => { q.showClosed = e.target.checked; load(el); };
  await load(el);
}

async function load(el) {
  const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
  const p = new URLSearchParams();
  if (q.campaign_id) p.set('campaign_id', q.campaign_id);
  if (q.assigned_to) p.set('assigned_to', q.assigned_to);
  if (q.q) p.set('q', q.q);
  p.set('statuses', (q.showClosed ? statuses : statuses.filter((s) => !['dnc', 'invalid'].includes(s))).join(','));
  let data;
  try { data = await get(`/leads/board?${p}`); } catch (e) { return toastErr(e); }
  const board = el.querySelector('#board');
  board.innerHTML = data.columns.map((c) => `
    <section class="board-col" data-status="${esc(c.status)}" style="--c:${COLORS[c.status] || 'var(--primary)'}">
      <div class="board-col-head"><b>${esc(STATUS_LABEL[c.status] || c.status)} <span class="badge">${c.count}</span></b>
        <small>${c.value ? `Deal value ${money(c.value)}` : c.due ? `Due ${money(c.due)}` : '&nbsp;'}</small></div>
      <div class="board-list">${c.rows.map((l) => card(l, statuses)).join('')}
        ${c.count > c.rows.length ? `<a class="btn sm ghost" href="#/leads" data-more="${esc(c.status)}">+${c.count - c.rows.length} more in list view</a>` : ''}</div>
    </section>`).join('');
  bind(el);
}

function card(l, statuses) {
  const overdue = l.next_call_at && new Date(l.next_call_at.replace(' ', 'T') + 'Z') < new Date();
  return `<article class="board-card" draggable="true" data-id="${l.id}" data-status="${esc(l.status)}">
    <div class="t">${l.priority > 0 ? '<i class="i i-star" style="color:var(--amber)"></i>' : ''}<span class="ellipsis">${esc(l.name || l.phone)}</span></div>
    <div class="meta"><span class="mono">${esc(l.phone)}</span>${l.city ? `<span>${esc(l.city)}</span>` : ''}</div>
    ${l.deal_value || l.amount_due ? `<div><b>${money(l.deal_value || l.amount_due)}</b></div>` : ''}
    <div class="meta">${l.last_disposition ? `<span>${esc(l.last_disposition)}</span>` : ''}${l.last_called_at ? `<span>${ago(l.last_called_at)}</span>` : '<span>Not called yet</span>'}</div>
    ${l.next_call_at ? `<div class="meta" style="${overdue ? 'color:var(--red);font-weight:600' : ''}"><i class="i i-alarm"></i> ${fmtDate(l.next_call_at)}</div>` : ''}
    ${l.assigned_name || l.campaign_name ? `<div class="meta">${l.assigned_name ? `<span><i class="i i-user"></i> ${esc(l.assigned_name)}</span>` : ''}${l.campaign_name ? `<span class="ellipsis">${esc(l.campaign_name)}</span>` : ''}</div>` : ''}
    <div class="row" style="gap:6px;margin-top:2px">
      <button class="btn sm green" data-call="${l.id}" title="Call"><i class="i i-phone"></i></button>
      <select class="move" data-move="${l.id}" style="min-height:30px;height:30px;padding:2px 6px;font-size:12px;flex:1">${options(statuses.map((s) => [s, `Move to ${STATUS_LABEL[s] || s}`]), l.status)}</select>
    </div>
  </article>`;
}

async function move(el, id, status) {
  try {
    await put(`/leads/${id}`, { status });
    toast(`Moved to ${STATUS_LABEL[status] || status}`, 'success', 1500);
  } catch (e) { toastErr(e); }
  load(el);
}

function bind(el) {
  let dragId = null;
  el.querySelectorAll('.board-card').forEach((c) => {
    c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    c.addEventListener('click', (e) => {
      if (e.target.closest('button, select')) return;
      openLead(Number(c.dataset.id), { onChange: () => load(el) });
    });
  });
  el.querySelectorAll('.board-col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain') || dragId;
      const cardEl = el.querySelector(`.board-card[data-id="${CSS.escape(String(id))}"]`);
      if (!id || !cardEl || cardEl.dataset.status === col.dataset.status) return;
      col.querySelector('.board-list').prepend(cardEl);
      move(el, Number(id), col.dataset.status);
    });
  });
  el.querySelectorAll('[data-move]').forEach((s) => (s.onchange = () => move(el, Number(s.dataset.move), s.value)));
  el.querySelectorAll('[data-more]').forEach((a) => (a.onclick = () => sessionStorage.setItem('leadStatus', a.dataset.more)));
  el.querySelectorAll('[data-call]').forEach((b) => (b.onclick = () => {
    if (!state.socket?.connected) return toast('Not connected to server', 'error');
    state.socket.emit('dial', { leadId: Number(b.dataset.call) }, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); });
    location.hash = '#/agent';
  }));
}
