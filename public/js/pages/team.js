import {
  get, post, put, del, esc, modal, confirmBox, toast, toastErr, options, agentBadge, fmtDate, state, isAdmin, loadRefs, onPage,
} from '../core.js';

const ROLE_BADGE = { admin: 'violet', manager: 'blue', agent: '' };
const SIM_OPTS = [[-1, 'Default / ask'], [0, 'SIM 1'], [1, 'SIM 2']];

export async function render(el) {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let users = [];
  let info = null;
  let campaigns = [];
  let showInactive = false;

  async function load() {
    [users, info, campaigns] = await Promise.all([get('/users'), get('/settings'), get('/campaigns')]);
    draw();
  }

  function draw() {
    const used = info.usage.users;
    const max = info.company.max_agents;
    const list = users.filter((u) => showInactive || u.active);
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Team</h1>
          <small class="muted">Seats used: <b style="color:${used >= max ? 'var(--red)' : 'inherit'}">${used} / ${max}</b> (agents + managers) · Plan: ${esc(info.company.plan)}</small>
        </div>
        <div class="spacer"></div>
        <label class="check"><input type="checkbox" id="inact" ${showInactive ? 'checked' : ''}> Show disabled</label>
        <button class="btn primary" id="add">+ Add user</button>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th class="hide-sm">Phone</th><th>Role</th><th class="hide-sm">Team</th><th>Live</th><th class="hide-sm">Last login</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((u) => `<tr>
          <td><b>${esc(u.name)}</b></td>
          <td>${esc(u.email)}</td>
          <td class="hide-sm">${esc(u.phone || '—')}</td>
          <td><span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.role)}</span></td>
          <td class="hide-sm">${esc(u.team || '—')}</td>
          <td>${agentBadge(u.live_status || 'offline')}</td>
          <td class="hide-sm">${u.last_login_at ? fmtDate(u.last_login_at) : '<span class="muted">Never</span>'}</td>
          <td>${u.active ? '<span class="badge green">Active</span>' : '<span class="badge red">Disabled</span>'}</td>
          <td class="actions">
            <button class="btn sm" data-edit="${u.id}">Edit</button>
            ${u.id !== state.user.id ? `<button class="btn sm" data-toggle="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}
          </td></tr>`).join('') || '<tr><td colspan="9" class="empty">No users</td></tr>'}</tbody>
      </table></div></div>`;
    el.querySelector('#inact').onchange = (e) => { showInactive = e.target.checked; draw(); };
    el.querySelector('#add').onclick = () => edit(null);
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => edit(Number(b.dataset.edit))));
    el.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => toggle(users.find((u) => u.id === Number(b.dataset.toggle)))));
  }

  async function toggle(u) {
    if (u.active && !(await confirmBox(`Disable ${u.name}? They will be logged out immediately and cannot login until enabled again.`, { ok: 'Disable' }))) return;
    try {
      await put(`/users/${u.id}`, { active: u.active ? 0 : 1 });
      toast(u.active ? 'User disabled' : 'User enabled', 'success');
      await load();
      loadRefs(true).catch(() => {});
    } catch (e) { toastErr(e); }
  }

  async function edit(id) {
    let u = { role: 'agent', sim_slot: -1, campaign_ids: [] };
    if (id) { try { u = await get(`/users/${id}`); } catch (e) { return toastErr(e); } }
    const roles = isAdmin() ? [['agent', 'Agent'], ['manager', 'Manager / Supervisor'], ['admin', 'Admin']] : [['agent', 'Agent']];
    const self = id === state.user.id;
    modal({
      title: id ? `Edit ${u.name}` : 'Add user',
      wide: true,
      body: `<div class="form-grid">
        <label class="field">Full name<input name="name" required value="${esc(u.name || '')}"></label>
        <label class="field">Email (login)<input name="email" type="email" required value="${esc(u.email || '')}"></label>
        <label class="field">Mobile<input name="phone" value="${esc(u.phone || '')}"></label>
        <label class="field">Role<select name="role" ${self ? 'disabled' : ''}>${options(roles, u.role)}</select></label>
        <label class="field">Team<input name="team" value="${esc(u.team || '')}" placeholder="Sales, Collections, Support…"></label>
        <label class="field">Default SIM for calls<select name="sim_slot">${options(SIM_OPTS, u.sim_slot)}</select></label>
        <label class="field full">${id ? 'New password (leave blank to keep)' : 'Password'}<input name="password" type="password" autocomplete="new-password" ${id ? '' : 'required'} minlength="6"></label>
        <div class="field full">Campaigns
          <div class="row" style="gap:6px 16px">${campaigns.map((c) => `<label class="check"><input type="checkbox" data-multi name="campaign_ids" value="${c.id}" ${u.campaign_ids?.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="muted">No campaigns yet</span>'}</div>
        </div>
        ${id && isAdmin() && !self ? '<div class="full"><button type="button" class="btn sm red" id="delUser">Delete user</button> <small class="muted">Deleting keeps call history; the login is disabled permanently.</small></div>' : ''}
      </div>`,
      onOpen: (form, close) => {
        const b = form.querySelector('#delUser');
        if (b) b.onclick = async () => {
          if (!(await confirmBox(`Delete ${u.name}?`, { ok: 'Delete' }))) return;
          try { await del(`/users/${id}`); toast('User deleted', 'success'); close(); load(); } catch (e) { toastErr(e); }
        };
      },
      onSubmit: async (d) => {
        d.campaign_ids = d.campaign_ids || [];
        d.sim_slot = Number(d.sim_slot);
        if (!d.password) delete d.password;
        if (self) delete d.role;
        if (id) await put(`/users/${id}`, d); else await post('/users', d);
        toast(id ? 'User updated' : 'User created', 'success');
        await load();
        loadRefs(true).catch(() => {});
      },
    });
  }

  onPage('monitor:update', (snap) => {
    let changed = false;
    for (const a of snap.agents || []) {
      const u = users.find((x) => x.id === a.id);
      if (u && u.live_status !== a.status) { u.live_status = a.status; changed = true; }
    }
    if (changed && !document.querySelector('.overlay')) draw();
  });

  try { await load(); } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
