import {
  get, post, put, del, esc, modal, confirmBox, toast, toastErr, options, formData, download, fmtDate, fmtDay, state, isAdmin, STATUS_LABEL, loadRefs,
} from '../core.js';

const TABS_ADMIN = [['general', 'General'], ['dispositions', 'Dispositions'], ['templates', 'Message Templates'], ['dnc', 'Do-Not-Call'], ['integrations', 'API & Webhooks'], ['audit', 'Audit Log']];
const TABS_MANAGER = [['general', 'General'], ['dispositions', 'Dispositions'], ['templates', 'Message Templates'], ['dnc', 'Do-Not-Call']];
const PLACEHOLDERS = ['name', 'first_name', 'phone', 'email', 'city', 'company', 'amount_due', 'due_date', 'ptp_date', 'agent_name', 'agent_phone', 'business_name'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Kathmandu', 'Asia/Colombo', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Manila', 'Europe/London', 'Africa/Lagos', 'Africa/Nairobi', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

let tab = 'general';

export async function render(el) {
  const tabs = isAdmin() ? TABS_ADMIN : TABS_MANAGER;
  if (!tabs.some((t) => t[0] === tab)) tab = 'general';
  el.innerHTML = `<div class="tabs" id="st">${tabs.map(([k, l]) => `<a data-t="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</a>`).join('')}</div><div id="sb"></div>`;
  const body = el.querySelector('#sb');
  el.querySelector('#st').onclick = (e) => {
    const t = e.target.closest('[data-t]'); if (!t) return;
    tab = t.dataset.t;
    el.querySelectorAll('#st a').forEach((a) => a.classList.toggle('active', a === t));
    show();
  };
  async function show() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    try { await VIEWS[tab](body); } catch (e) { body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
  }
  show();
}

const yes = (v) => (v ? '<span class="badge green">Yes</span>' : '<span class="muted">—</span>');
const check = (name, label, val, hint = '') => `<label class="check"><input type="checkbox" name="${name}" ${val ? 'checked' : ''}> ${esc(label)}${hint ? ` <small class="muted">${esc(hint)}</small>` : ''}</label>`;

// ------------------------------------------------------------------ general
async function general(body) {
  const d = await get('/settings');
  const s = d.settings;
  const c = d.company;
  const ro = !isAdmin();
  const expired = c.expires_at && new Date(c.expires_at + 'T23:59:59') < new Date();
  body.innerHTML = `
  <div class="grid g3 mb">
    <div class="card stat"><span class="label">Plan</span><span class="value" style="text-transform:capitalize">${esc(c.plan)}</span><span class="sub">Licence for ${c.max_agents} users</span></div>
    <div class="card stat"><span class="label">Seats used</span><span class="value">${d.usage.users} / ${c.max_agents}</span><span class="sub">Agents + managers</span></div>
    <div class="card stat"><span class="label">Licence valid till</span><span class="value" style="font-size:20px;color:${expired ? 'var(--red)' : 'inherit'}">${c.expires_at ? fmtDay(c.expires_at) : 'Lifetime'}</span><span class="sub">${d.usage.leads.toLocaleString()} leads · ${d.usage.calls.toLocaleString()} calls</span></div>
  </div>
  <form class="card" id="gf">
    <div class="card-head"><h3>Company & dialer settings</h3>${ro ? '<span class="badge amber">Read-only (admin can edit)</span>' : ''}</div>
    <fieldset ${ro ? 'disabled' : ''} style="border:0;margin:0;padding:0">
    <div class="card-body form-grid">
      <label class="field">Company name<input name="c_name" value="${esc(c.name)}"></label>
      <label class="field">Contact person<input name="c_contact_name" value="${esc(c.contact_name || '')}"></label>
      <label class="field">Contact email<input name="c_contact_email" type="email" value="${esc(c.contact_email || '')}"></label>
      <label class="field">Contact phone<input name="c_contact_phone" value="${esc(c.contact_phone || '')}"></label>
      <label class="field">Time zone<select name="timezone">${options(TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES], s.timezone)}</select></label>
      <label class="field">Default country code<input name="country_code" value="${esc(s.country_code)}" placeholder="+91"></label>
      <label class="field">Currency<input name="currency" value="${esc(s.currency)}" placeholder="INR"></label>
      <label class="field">Daily call target per agent<input name="daily_call_target" type="number" min="0" value="${esc(s.daily_call_target)}"></label>
      <label class="field">Auto-dial delay after disposition (seconds)<input name="auto_dial_delay_sec" type="number" min="0" max="120" value="${esc(s.auto_dial_delay_sec)}"></label>
      <label class="field">Delete recordings after (days, 0 = keep forever)<input name="recording_retention_days" type="number" min="0" value="${esc(s.recording_retention_days)}"></label>
      <label class="field full">Break reasons (comma separated)<input name="break_reasons" value="${esc((s.break_reasons || []).join(', '))}"></label>
      <label class="field full">Custom lead fields (comma separated)<input name="custom_fields" value="${esc((s.custom_fields || []).join(', '))}" placeholder="Loan Amount, Occupation, Budget"></label>
      <div class="full col">
        ${check('demo_mode', 'Demo mode', s.demo_mode, '– simulate calls when no phone is connected (for training & sales demos)')}
        ${check('recording_enabled', 'Upload call recordings from agent phones', s.recording_enabled)}
        ${check('mask_phone_for_agents', 'Hide customer numbers from agents', s.mask_phone_for_agents, '– agents see 98XXXXX210')}
        ${check('allow_agent_manual_dial', 'Allow agents to dial any number manually', s.allow_agent_manual_dial)}
        ${check('allow_agent_lead_create', 'Allow agents to create leads', s.allow_agent_lead_create)}
      </div>
    </div>
    ${ro ? '' : '<div class="modal-foot"><button class="btn primary" type="submit">Save settings</button></div>'}
    </fieldset>
  </form>`;
  const form = body.querySelector('#gf');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(form);
    const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const payload = {
      company: { name: f.c_name, contact_name: f.c_contact_name, contact_email: f.c_contact_email, contact_phone: f.c_contact_phone },
      settings: {
        timezone: f.timezone, country_code: f.country_code, currency: f.currency, daily_call_target: f.daily_call_target,
        auto_dial_delay_sec: f.auto_dial_delay_sec, recording_retention_days: f.recording_retention_days,
        break_reasons: list(f.break_reasons), custom_fields: list(f.custom_fields),
        demo_mode: !!f.demo_mode, recording_enabled: !!f.recording_enabled, mask_phone_for_agents: !!f.mask_phone_for_agents,
        allow_agent_manual_dial: !!f.allow_agent_manual_dial, allow_agent_lead_create: !!f.allow_agent_lead_create,
      },
    };
    try {
      const r = await put('/settings', payload);
      state.user.settings = r.settings;
      if (state.user.company) state.user.company.name = f.c_name;
      toast('Settings saved', 'success');
    } catch (err) { toastErr(err); }
  };
}

// ------------------------------------------------------------------ dispositions
async function dispositions(body) {
  const rows = await get('/dispositions?all=1');
  const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
  body.innerHTML = `
  <div class="card">
    <div class="card-head"><h3>Call dispositions</h3><small class="muted hide-sm">Outcome buttons agents click after each call</small><button class="btn primary sm" id="addD">+ Add</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Sets lead status</th><th>Success</th><th>Callback</th><th>Auto-retry</th><th>Order</th><th>Active</th><th></th></tr></thead>
      <tbody>${rows.map((d) => `<tr style="${d.active ? '' : 'opacity:.5'}">
        <td><span class="dot" style="background:${esc(d.color)}"></span> <b>${esc(d.name)}</b></td>
        <td>${d.category === 'connected' ? '<span class="badge green">Connected</span>' : '<span class="badge amber">Not connected</span>'}</td>
        <td>${d.lead_status ? esc(STATUS_LABEL[d.lead_status] || d.lead_status) : '<span class="muted">No change</span>'}</td>
        <td>${yes(d.is_success)}</td><td>${yes(d.needs_callback)}</td><td>${yes(d.retry)}</td><td>${d.sort}</td><td>${yes(d.active)}</td>
        <td class="actions"><button class="btn sm" data-id="${d.id}">Edit</button></td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
  const edit = (d) => modal({
    title: d ? 'Edit disposition' : 'Add disposition',
    body: `<div class="form-grid">
      <label class="field full">Name<input name="name" required value="${esc(d?.name || '')}"></label>
      <label class="field">Type<select name="category">${options([['connected', 'Connected (customer answered)'], ['not_connected', 'Not connected']], d?.category || 'connected')}</select></label>
      <label class="field">Set lead status to<select name="lead_status">${options(statuses.map((s) => [s, STATUS_LABEL[s] || s]), d?.lead_status || '', { empty: '— No change —' })}</select></label>
      <label class="field">Colour<input type="color" name="color" value="${esc(d?.color || '#64748b')}"></label>
      <label class="field">Display order<input type="number" name="sort" value="${esc(d?.sort ?? rows.length)}"></label>
      <div class="full col">
        ${check('is_success', 'Counts as success / conversion', d?.is_success)}
        ${check('needs_callback', 'Ask for callback date & time', d?.needs_callback)}
        ${check('retry', 'Auto re-dial later (uses campaign retry gap)', d?.retry)}
        ${check('active', 'Active', d ? d.active : 1)}
      </div></div>`,
    onSubmit: async (f) => {
      if (d) await put(`/dispositions/${d.id}`, f); else await post('/dispositions', f);
      toast('Saved', 'success');
      loadRefs(true).catch(() => {});
      dispositions(body);
    },
  });
  body.querySelector('#addD').onclick = () => edit(null);
  body.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => edit(rows.find((r) => r.id === Number(b.dataset.id)))));
}

// ------------------------------------------------------------------ templates
async function templates(body) {
  const rows = await get('/templates');
  body.innerHTML = `
  <div class="card">
    <div class="card-head"><h3>WhatsApp / SMS templates</h3><button class="btn primary sm" id="addT">+ Add</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Channel</th><th>Message</th><th></th></tr></thead>
      <tbody>${rows.map((t) => `<tr><td><b>${esc(t.name)}</b></td>
        <td><span class="badge ${t.channel === 'whatsapp' ? 'green' : t.channel === 'sms' ? 'blue' : 'violet'}">${esc(t.channel)}</span></td>
        <td style="max-width:520px"><small>${esc(t.body)}</small></td>
        <td class="actions"><button class="btn sm" data-e="${t.id}">Edit</button> <button class="btn sm" data-d="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No templates yet</td></tr>'}</tbody>
    </table></div>
    <div class="card-body"><small class="muted">Placeholders: ${PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(' ')}</small></div>
  </div>`;
  const edit = (t) => modal({
    title: t ? 'Edit template' : 'Add template',
    body: `<div class="form-grid">
      <label class="field">Name<input name="name" required value="${esc(t?.name || '')}"></label>
      <label class="field">Channel<select name="channel">${options([['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']], t?.channel || 'whatsapp')}</select></label>
      <label class="field full">Message<textarea name="body" rows="6" required>${esc(t?.body || '')}</textarea></label>
      <div class="full"><small class="muted">Click to insert: ${PLACEHOLDERS.map((p) => `<button type="button" class="btn sm" data-ph="${p}" style="margin:2px">{{${p}}}</button>`).join('')}</small></div>
    </div>`,
    onOpen: (form) => form.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = () => {
      const ta = form.body; const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + `{{${b.dataset.ph}}}` + ta.value.slice(ta.selectionEnd ?? pos);
      ta.focus();
    })),
    onSubmit: async (f) => {
      if (t) await put(`/templates/${t.id}`, f); else await post('/templates', f);
      toast('Saved', 'success');
      templates(body);
    },
  });
  body.querySelector('#addT').onclick = () => edit(null);
  body.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => edit(rows.find((r) => r.id === Number(b.dataset.e)))));
  body.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Delete this template?', { ok: 'Delete' }))) return;
    try { await del(`/templates/${b.dataset.d}`); templates(body); } catch (e) { toastErr(e); }
  }));
}

// ------------------------------------------------------------------ DNC
async function dnc(body, q = '') {
  const rows = await get(`/dnc${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  body.innerHTML = `
  <div class="grid g3">
    <div class="card span2">
      <div class="card-head"><h3>Do-Not-Call list</h3><span class="badge">${rows.length}${rows.length >= 1000 ? '+' : ''}</span>
        <input type="search" id="dq" placeholder="Search number" value="${esc(q)}" style="max-width:200px">
        <button class="btn sm" id="dx">⬇ CSV</button></div>
      <div class="table-wrap" style="max-height:560px"><table>
        <thead><tr><th>Number</th><th>Reason</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.phone)}</td><td>${esc(r.reason || '—')}</td><td>${fmtDate(r.created_at)}</td>
          <td class="actions"><button class="btn sm" data-rm="${r.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No numbers blocked</td></tr>'}</tbody>
      </table></div>
    </div>
    <form class="card" id="df">
      <div class="card-head"><h3>Add numbers</h3></div>
      <div class="card-body col">
        <label class="field">Numbers (one per line or comma separated)<textarea name="phones" rows="8" required placeholder="9876543210&#10;+919812345678"></textarea></label>
        <label class="field">Reason<input name="reason" placeholder="Customer request / TRAI DND"></label>
        <button class="btn primary" type="submit">Add to DNC</button>
        <small class="muted">Numbers on this list are never dialed, and matching leads are marked “Do not call”.</small>
      </div>
    </form>
  </div>`;
  const qi = body.querySelector('#dq');
  let t;
  qi.oninput = () => { clearTimeout(t); t = setTimeout(() => dnc(body, qi.value.trim()).then(() => { const n = body.querySelector('#dq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 350); };
  body.querySelector('#dx').onclick = () => download('/dnc?format=csv');
  body.querySelector('#df').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try { const r = await post('/dnc', f); toast(`${r.added} number(s) added`, 'success'); dnc(body); } catch (err) { toastErr(err); }
  };
  body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Remove this number from the DNC list? It may be dialed again.', { ok: 'Remove' }))) return;
    try { await del(`/dnc/${b.dataset.rm}`); dnc(body, q); } catch (err) { toastErr(err); }
  }));
}

// ------------------------------------------------------------------ integrations
async function integrations(body) {
  const [s, hooks, campaigns] = await Promise.all([get('/settings'), get('/webhooks'), get('/campaigns')]);
  const origin = location.origin;
  const key = s.api_key || '';
  const curl = `curl -X POST ${origin}/api/public/leads \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{"name":"Ravi Kumar","phone":"9876543210","email":"ravi@example.com","city":"Pune","source":"Website","campaign_id":${campaigns[0]?.id ?? 1},"message":"Need a quote"}'`;
  const formSnippet = `<form id="leadForm">
  <input name="name" placeholder="Name" required>
  <input name="phone" placeholder="Mobile" required>
  <input name="email" placeholder="Email">
  <button>Request a call back</button>
</form>
<script>
document.getElementById('leadForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.source = 'Website';
  await fetch('${origin}/api/public/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': '${key}' },
    body: JSON.stringify(data)
  });
  e.target.innerHTML = 'Thank you! We will call you shortly.';
};
<\/script>`;
  body.innerHTML = `
  <div class="card mb">
    <div class="card-head"><h3>API key</h3><small class="muted hide-sm">Push leads from your website, Facebook / Google lead forms, Zapier, IndiaMART…</small></div>
    <div class="card-body col">
      <div class="row"><input readonly class="mono" id="ak" value="${esc(key)}" style="flex:1;min-width:240px">
        <button class="btn" id="akc">Copy</button><button class="btn red" id="akr">Regenerate</button></div>
      <h4 class="mt">Example: create a lead</h4>
      <pre id="curl">${esc(curl)}</pre>
      <div class="row"><button class="btn sm" data-copy="curl">Copy cURL</button></div>
      <small class="muted">Endpoints: <code>POST /api/public/leads</code> (single lead, or <code>{"leads":[...]}</code> for bulk) · <code>GET /api/public/leads/:id</code> · <code>GET /api/public/campaigns</code>. Duplicate numbers are not re-created — they get a re-enquiry note and higher priority.</small>
      <h4 class="mt">Website form snippet</h4>
      <pre id="snip">${esc(formSnippet)}</pre>
      <div class="row"><button class="btn sm" data-copy="snip">Copy snippet</button></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>Webhooks</h3><button class="btn primary sm" id="addW">+ Add webhook</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>URL</th><th>Events</th><th>Secret</th><th>Active</th><th></th></tr></thead>
      <tbody>${hooks.map((w) => `<tr><td class="mono" style="word-break:break-all">${esc(w.url)}</td><td><code>${esc(w.events)}</code></td>
        <td class="mono"><small>${esc(w.secret || '—')}</small></td><td>${yes(w.active)}</td>
        <td class="actions"><button class="btn sm" data-we="${w.id}">Edit</button> <button class="btn sm" data-wd="${w.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No webhooks configured</td></tr>'}</tbody>
    </table></div>
    <div class="card-body"><small class="muted">We POST JSON <code>{"event","at","data"}</code> to your URL. Events: <code>call.ended</code>, <code>call.disposed</code>, <code>lead.created</code>, <code>lead.status_changed</code> (or <code>*</code> for all).
      Verify authenticity with the <code>X-Signature</code> header = HMAC-SHA256 of the raw body using the secret.</small></div>
  </div>`;
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied', 'success'); } catch { toast('Copy failed — select and copy manually', 'error'); } };
  body.querySelector('#akc').onclick = () => copy(body.querySelector('#ak').value);
  body.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy === 'curl' ? curl : formSnippet)));
  body.querySelector('#akr').onclick = async () => {
    if (!(await confirmBox('Regenerate API key? Existing integrations using the old key will stop working.', { ok: 'Regenerate' }))) return;
    try { await post('/settings/api-key'); toast('New API key generated', 'success'); integrations(body); } catch (e) { toastErr(e); }
  };
  const edit = (w) => modal({
    title: w ? 'Edit webhook' : 'Add webhook',
    body: `<div class="col">
      <label class="field">URL<input name="url" type="url" required value="${esc(w?.url || '')}" placeholder="https://example.com/hooks/dialer"></label>
      <label class="field">Events<input name="events" value="${esc(w?.events || '*')}" placeholder="* or call.ended, lead.created"></label>
      ${w ? check('active', 'Active', w.active) : '<label class="field">Secret (optional, auto-generated if empty)<input name="secret"></label>'}
    </div>`,
    onSubmit: async (f) => {
      if (w) await put(`/webhooks/${w.id}`, f); else { if (!f.secret) delete f.secret; await post('/webhooks', f); }
      toast('Saved', 'success');
      integrations(body);
    },
  });
  body.querySelector('#addW').onclick = () => edit(null);
  body.querySelectorAll('[data-we]').forEach((b) => (b.onclick = () => edit(hooks.find((h) => h.id === Number(b.dataset.we)))));
  body.querySelectorAll('[data-wd]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Delete this webhook?', { ok: 'Delete' }))) return;
    try { await del(`/webhooks/${b.dataset.wd}`); integrations(body); } catch (e) { toastErr(e); }
  }));
}

// ------------------------------------------------------------------ audit
async function audit(body) {
  const rows = await get('/audit?limit=500');
  body.innerHTML = `
  <div class="card">
    <div class="card-head"><h3>Audit log</h3><small class="muted">Last ${rows.length} security-relevant actions</small></div>
    <div class="table-wrap" style="max-height:70vh"><table>
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th><th class="hide-sm">IP</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="nowrap">${fmtDate(r.created_at)}</td><td>${esc(r.user_name || '—')}</td>
        <td><code>${esc(r.action)}</code></td><td><small class="mono" style="word-break:break-all">${esc(r.details || '')}</small></td>
        <td class="hide-sm mono"><small>${esc(r.ip || '')}</small></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No activity yet</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

const VIEWS = { general, dispositions, templates, dnc: (b) => dnc(b), integrations, audit };
