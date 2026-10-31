// Campaign management: create/edit, start/pause, recycle, stats.
import { state, get, post, put, del, esc, html, modal, toast, toastErr, options, num, pct, hours, isAdmin, loadRefs, confirmBox } from '../core.js';

const TYPE = { sales: '💰 Sales', support: '🎧 Support', collection: '🧾 Collection', survey: '📋 Survey', other: '📁 Other' };
const MODE = { preview: 'Preview — agent sees lead, then clicks Call', progressive: 'Progressive — auto-dial next lead after wrap-up', power: 'Power — auto-dial, auto-skip unanswered calls' };

export async function render(el) {
  async function load() {
    const list = await get('/campaigns');
    el.innerHTML = html`
      <div class="page-head"><div><h1>Campaigns</h1><small class="muted">Group leads, assign agents and choose how they are dialed</small></div>
        <span class="spacer"></span><button class="btn primary" id="newBtn">＋ New campaign</button></div>
      ${list.length ? `<div class="grid g-auto" style="grid-template-columns:repeat(auto-fill,minmax(330px,1fr))">${list.map(card).join('')}</div>`
        : '<div class="card empty">No campaigns yet. Create one, then import leads into it.</div>'}`;
    el.querySelector('#newBtn').onclick = () => edit(null, load);
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => edit(await get(`/campaigns/${b.dataset.edit}`), load)));
    el.querySelectorAll('[data-status]').forEach((b) => (b.onclick = async () => {
      try { await put(`/campaigns/${b.dataset.id}`, { status: b.dataset.status }); toast(`Campaign ${b.dataset.status}`, 'success'); await loadRefs(true); load(); } catch (e) { toastErr(e); }
    }));
    el.querySelectorAll('[data-recycle]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox('Reset attempts so open leads (new / contacted / follow-up) are dialed again?', { ok: 'Recycle leads', danger: false }))) return;
      try { const r = await post(`/campaigns/${b.dataset.recycle}/recycle`, {}); toast(`${r.recycled} leads back in queue`, 'success'); load(); } catch (e) { toastErr(e); }
    }));
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox('Delete this campaign? Leads stay in the CRM without a campaign.'))) return;
      try { await del(`/campaigns/${b.dataset.del}`); await loadRefs(true); load(); } catch (e) { toastErr(e); }
    }));
  }
  await loadRefs();
  await load();
}

function card(c) {
  const s = c.stats || {};
  const done = pct(s.closed, s.total);
  const agents = state.users.filter((u) => c.agent_ids.includes(u.id));
  const color = { active: 'green', paused: 'amber', draft: '', completed: 'blue' }[c.status];
  return `<div class="card">
    <div class="card-head"><h3 class="ellipsis">${esc(c.name)}</h3><span class="badge ${color}">${esc(c.status)}</span></div>
    <div class="card-body col">
      <div class="row"><span class="badge">${TYPE[c.type] || esc(c.type)}</span><span class="badge primary">${esc(c.dial_mode)}</span><span class="badge">🕘 ${esc(c.call_start)}–${esc(c.call_end)}</span></div>
      ${c.description ? `<small class="muted">${esc(c.description)}</small>` : ''}
      <div><div class="row between"><small class="muted">${num(s.closed)} of ${num(s.total)} leads closed</small><small><b>${done}%</b></small></div>
        <div class="target-bar mt-s"><span style="width:${done}%"></span></div></div>
      <div class="grid g4" style="gap:6px;text-align:center">
        <div><b>${num(s.fresh)}</b><br><small class="muted">New</small></div>
        <div><b>${num(s.calls)}</b><br><small class="muted">Calls</small></div>
        <div><b>${pct(s.connected, s.calls)}%</b><br><small class="muted">Connect</small></div>
        <div><b style="color:var(--green)">${num(s.converted)}</b><br><small class="muted">Converted</small></div>
      </div>
      <small class="muted">👥 ${agents.length ? esc(agents.map((a) => a.name).join(', ')) : 'No agents assigned — only managers can dial'} · talk ${hours(s.talk_sec)}</small>
      <div class="row">
        ${c.status === 'active' ? `<button class="btn sm" data-status="paused" data-id="${c.id}">⏸ Pause</button>` : `<button class="btn sm green" data-status="active" data-id="${c.id}">▶ Activate</button>`}
        <button class="btn sm" data-edit="${c.id}">✏️ Edit</button>
        <button class="btn sm" data-recycle="${c.id}">♻ Recycle</button>
        <a class="btn sm ghost" href="#/leads" onclick="sessionStorage.setItem('leadCampaign','${c.id}')">Leads →</a>
        ${isAdmin() ? `<button class="btn sm ghost" data-del="${c.id}" style="margin-left:auto;color:var(--red)">Delete</button>` : ''}
      </div>
    </div></div>`;
}

function edit(c, done) {
  const v = c || { type: 'sales', dial_mode: 'progressive', status: 'active', wrapup_sec: 30, max_attempts: 3, retry_minutes: 60, call_start: '09:00', call_end: '21:00', sim_slot: -1, agent_ids: [] };
  const agents = state.users.filter((u) => u.active !== 0);
  modal({
    title: c ? `Edit campaign — ${c.name}` : 'New campaign', wide: true,
    body: `<div class="form-grid">
      <label class="field full">Campaign name *<input name="name" value="${esc(v.name)}" required></label>
      <label class="field">Team type<select name="type">${options(Object.entries(TYPE), v.type)}</select></label>
      <label class="field">Status<select name="status">${options(['active', 'paused', 'draft', 'completed'], v.status)}</select></label>
      <label class="field full">Dialing mode<select name="dial_mode">${options(Object.entries(MODE), v.dial_mode)}</select></label>
      <label class="field">Calling hours from<input type="time" name="call_start" value="${esc(v.call_start)}"></label>
      <label class="field">Calling hours to<input type="time" name="call_end" value="${esc(v.call_end)}"></label>
      <label class="field">Max attempts per lead<input type="number" min="1" name="max_attempts" value="${esc(v.max_attempts)}"></label>
      <label class="field">Retry unanswered after (minutes)<input type="number" min="1" name="retry_minutes" value="${esc(v.retry_minutes)}"></label>
      <label class="field">Wrap-up time (seconds)<input type="number" min="0" name="wrapup_sec" value="${esc(v.wrapup_sec)}"></label>
      <label class="field">SIM to use<select name="sim_slot">${options([[-1, "Agent's default SIM"], [0, 'SIM 1'], [1, 'SIM 2']], v.sim_slot)}</select></label>
      <label class="check full"><input type="checkbox" name="auto_skip_unanswered" ${v.auto_skip_unanswered ? 'checked' : ''}> Auto-skip unanswered calls (mark “No Answer” and dial next)</label>
      <label class="field full">Description<input name="description" value="${esc(v.description)}"></label>
      <label class="field full">Call script <small class="muted">placeholders: {{name}} {{first_name}} {{agent_name}} {{city}} {{amount_due}} {{due_date}} {{business_name}}</small>
        <textarea name="script" rows="7">${esc(v.script)}</textarea></label>
      <div class="field full">Agents on this campaign
        <div class="row" style="gap:14px">${agents.length ? agents.map((u) => `<label class="check"><input type="checkbox" name="agent_ids" data-multi value="${u.id}" ${v.agent_ids.includes(u.id) ? 'checked' : ''}> ${esc(u.name)} <small class="muted">${esc(u.role)}</small></label>`).join('') : '<span class="muted">Add agents on the Team page first.</span>'}</div></div>
    </div>`,
    onSubmit: async (d) => {
      const body = { ...d, agent_ids: d.agent_ids || [], sim_slot: Number(d.sim_slot) };
      if (c) await put(`/campaigns/${c.id}`, body); else await post('/campaigns', body);
      toast('Campaign saved', 'success');
      await loadRefs(true);
      done();
    },
  });
}
