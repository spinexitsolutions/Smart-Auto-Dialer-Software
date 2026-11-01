import {
  get, post, put, del, esc, modal, confirmBox, promptBox, toast, toastErr, options, fmtDate, fmtDay, num,
} from '../core.js';

function expiryBadge(exp) {
  if (!exp) return '<span class="badge green">Lifetime</span>';
  const days = Math.floor((new Date(exp + 'T23:59:59') - Date.now()) / 86400000);
  if (days < 0) return `<span class="badge red">Expired ${esc(fmtDay(exp))}</span>`;
  if (days < 15) return `<span class="badge amber">${esc(fmtDay(exp))} · ${days}d left</span>`;
  return `<span class="badge">${esc(fmtDay(exp))}</span>`;
}

export async function render(el) {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let plans = {};
  let rows = [];
  let q = '';

  async function load() {
    const [stats, companies, p] = await Promise.all([get('/super/stats'), get('/super/companies'), get('/super/plans')]);
    plans = p; rows = companies;
    el.innerHTML = `
      <div class="page-head"><div><h1>Clients & Licences</h1><small class="muted">Create client accounts, set seats and validity, renew or suspend.</small></div>
        <div class="spacer"></div><input type="search" id="sq" placeholder="Search client" style="max-width:240px" value="${esc(q)}">
        <button class="btn primary" id="addC"><i class="i i-plus"></i> New client</button></div>
      <div class="grid g4 mb">
        <div class="card stat"><span class="label">Clients</span><span class="value">${num(stats.companies)}</span><span class="sub">${num(stats.active)} active</span><span class="icon"><i class="i i-building"></i></span></div>
        <div class="card stat"><span class="label">Expiring in 15 days</span><span class="value" style="color:${stats.expiring ? 'var(--amber)' : 'inherit'}">${num(stats.expiring)}</span><span class="sub">Follow up for renewal</span><span class="icon"><i class="i i-alarm"></i></span></div>
        <div class="card stat"><span class="label">Licensed seats</span><span class="value">${num(stats.seats)}</span><span class="sub">${num(stats.users)} users created</span><span class="icon"><i class="i i-id-card"></i></span></div>
        <div class="card stat"><span class="label">Calls today</span><span class="value">${num(stats.calls_today)}</span><span class="sub">Across all clients</span><span class="icon"><i class="i i-phone"></i></span></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Client</th><th>Plan</th><th>Seats</th><th>Valid till</th><th>Status</th><th class="right">Leads</th><th class="right">Calls (30d)</th><th class="hide-sm">Last active</th><th></th></tr></thead>
        <tbody id="ct"></tbody></table></div></div>`;
    drawRows();
    el.querySelector('#addC').onclick = create;
    el.querySelector('#sq').oninput = (e) => { q = e.target.value; drawRows(); };
  }

  function drawRows() {
    const s = q.trim().toLowerCase();
    const list = rows.filter((c) => !s || [c.name, c.contact_name, c.contact_email, c.contact_phone].some((v) => String(v || '').toLowerCase().includes(s)));
    const tb = el.querySelector('#ct');
    tb.innerHTML = list.map((c) => `<tr>
      <td><b>${esc(c.name)}</b><br><small class="muted">${esc([c.contact_name, c.contact_email, c.contact_phone].filter(Boolean).join(' · ') || '—')}</small></td>
      <td><span class="badge primary">${esc(plans[c.plan]?.label || c.plan)}</span></td>
      <td class="nowrap"><b style="color:${c.users >= c.max_agents ? 'var(--red)' : 'inherit'}">${c.users}</b> / ${c.max_agents}</td>
      <td>${expiryBadge(c.expires_at)}</td>
      <td>${c.active ? '<span class="badge green">Active</span>' : '<span class="badge red">Suspended</span>'}</td>
      <td class="right">${num(c.leads)}</td><td class="right">${num(c.calls_30d)}</td>
      <td class="hide-sm">${c.last_active ? fmtDate(c.last_active) : '<span class="muted">Never</span>'}</td>
      <td class="actions">
        <button class="btn sm" data-a="edit" data-id="${c.id}">Edit</button>
        <button class="btn sm" data-a="ext30" data-id="${c.id}">+30d</button>
        <button class="btn sm" data-a="ext365" data-id="${c.id}">+1yr</button>
        <button class="btn sm" data-a="reset" data-id="${c.id}" title="Reset admin password"><i class="i i-key"></i></button>
        <button class="btn sm" data-a="toggle" data-id="${c.id}">${c.active ? 'Suspend' : 'Activate'}</button>
        <button class="btn sm red" data-a="delete" data-id="${c.id}" title="Delete"><i class="i i-trash"></i></button>
      </td></tr>`).join('') || '<tr><td colspan="9" class="empty">No clients yet — click “New client” to sell your first licence.</td></tr>';
    tb.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => action(b.dataset.a, rows.find((c) => c.id === Number(b.dataset.id)))));
  }

  const planOpts = () => Object.entries(plans).map(([k, v]) => [k, `${v.label} (${v.max_agents} users)`]);

  function create() {
    const exp = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    modal({
      title: 'New client company',
      wide: true,
      submit: 'Create client',
      body: `<div class="form-grid">
        <label class="field full">Company name<input name="name" required></label>
        <label class="field">Contact person<input name="contact_name"></label>
        <label class="field">Contact phone<input name="contact_phone"></label>
        <label class="field full">Contact email<input name="contact_email" type="email"></label>
        <label class="field">Plan<select name="plan">${options(planOpts(), 'starter')}</select></label>
        <label class="field">Max users (seats)<input name="max_agents" type="number" min="1" value="${plans.starter?.max_agents ?? 5}"></label>
        <label class="field">Licence valid till<input name="expires_at" type="date" value="${exp}"></label>
        <div></div>
        <h4 class="full mt">Client admin login</h4>
        <label class="field">Admin name<input name="admin_name"></label>
        <label class="field">Admin email<input name="admin_email" type="email" required></label>
        <label class="field">Admin password<input name="admin_password" type="text" required minlength="6" value="${Math.random().toString(36).slice(2, 10)}"></label>
      </div>`,
      onOpen: (form) => {
        form.plan.onchange = () => {
          form.max_agents.value = plans[form.plan.value]?.max_agents ?? form.max_agents.value;
          if (form.plan.value === 'trial') form.expires_at.value = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        };
      },
      onSubmit: async (d) => {
        await post('/super/companies', d);
        modal({
          title: 'Client created',
          body: `<p>Share these login details with your client:</p><pre>URL:      ${esc(location.origin)}\nEmail:    ${esc(d.admin_email)}\nPassword: ${esc(d.admin_password)}</pre>`,
          cancel: 'Close',
        });
        await load();
      },
    });
  }

  async function action(a, c) {
    try {
      if (a === 'edit') {
        modal({
          title: `Edit ${c.name}`,
          wide: true,
          body: `<div class="form-grid">
            <label class="field full">Company name<input name="name" required value="${esc(c.name)}"></label>
            <label class="field">Contact person<input name="contact_name" value="${esc(c.contact_name || '')}"></label>
            <label class="field">Contact phone<input name="contact_phone" value="${esc(c.contact_phone || '')}"></label>
            <label class="field full">Contact email<input name="contact_email" type="email" value="${esc(c.contact_email || '')}"></label>
            <label class="field">Plan<select name="plan">${options(planOpts(), c.plan)}</select></label>
            <label class="field">Max users (seats)<input name="max_agents" type="number" min="1" value="${c.max_agents}"></label>
            <label class="field">Licence valid till<input name="expires_at" type="date" value="${esc(c.expires_at || '')}"></label>
            <label class="check" style="align-self:end"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Active</label>
          </div>`,
          onSubmit: async (d) => { await put(`/super/companies/${c.id}`, d); toast('Client updated', 'success'); await load(); },
        });
      } else if (a === 'ext30' || a === 'ext365') {
        const days = a === 'ext30' ? 30 : 365;
        if (!(await confirmBox(`Extend ${c.name}'s licence by ${days} days?`, { ok: 'Extend', danger: false }))) return;
        const r = await post(`/super/companies/${c.id}/extend`, { days });
        toast(`Valid till ${r.expires_at}`, 'success');
        await load();
      } else if (a === 'reset') {
        const pw = await promptBox(`Reset admin password for ${c.name}`, { label: 'New password (min 6 characters)', value: Math.random().toString(36).slice(2, 10), ok: 'Reset' });
        if (!pw) return;
        const r = await post(`/super/companies/${c.id}/reset-admin`, { password: pw });
        modal({ title: 'Password reset', body: `<pre>Email:    ${esc(r.email)}\nPassword: ${esc(pw)}</pre>`, cancel: 'Close' });
      } else if (a === 'toggle') {
        if (c.active && !(await confirmBox(`Suspend ${c.name}? All their users will be logged out and cannot login until re-activated.`, { ok: 'Suspend' }))) return;
        await put(`/super/companies/${c.id}`, { active: c.active ? 0 : 1 });
        toast(c.active ? 'Client suspended' : 'Client activated', 'success');
        await load();
      } else if (a === 'delete') {
        const name = await promptBox(`Delete ${c.name}?`, { label: `This permanently deletes ALL leads, calls and users. Type the company name "${c.name}" to confirm.`, ok: 'Delete forever' });
        if (name == null) return;
        await del(`/super/companies/${c.id}`, { confirm: name });
        toast('Client deleted', 'success');
        await load();
      }
    } catch (e) { toastErr(e); }
  }

  try { await load(); } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
