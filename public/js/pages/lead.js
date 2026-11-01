// Lead profile drawer: details, edit, timeline, calls with recordings, follow-ups, tickets, quick actions.
import {
  state, get, post, put, del, esc, html, modal, toast, toastErr, options, statusBadge, fmtDate, dur, money, ago, authUrl,
  isManager, loadRefs, localInput, openWhatsApp, openSms, confirmBox, STATUS_LABEL,
} from '../core.js';

const ICON = { call: '<i class="i i-phone"></i>', disposition: '<i class="i i-tag"></i>', note: '<i class="i i-note"></i>', status: '<i class="i i-refresh"></i>', followup: '<i class="i i-alarm"></i>', created: '<i class="i i-sparkles"></i>', assign: '<i class="i i-user"></i>', whatsapp: '<i class="i i-message"></i>', sms: '<i class="i i-mail"></i>', email: '<i class="i i-mail"></i>', ticket: '<i class="i i-ticket"></i>', meeting: '<i class="i i-calendar"></i>' };

export async function openLead(id, { onChange } = {}) {
  await loadRefs();
  const ov = document.createElement('div');
  ov.className = 'drawer-overlay';
  const dr = document.createElement('aside');
  dr.className = 'drawer';
  const close = () => { ov.remove(); dr.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) close(); };
  document.addEventListener('keydown', onKey);
  ov.onclick = close;
  document.body.append(ov, dr);
  dr.innerHTML = '<div class="empty">Loading…</div>';

  let changed = false;
  const notify = () => { changed = true; onChange?.(); };

  async function load() {
    let l;
    try { l = await get(`/leads/${id}`); } catch (e) { toastErr(e); close(); return; }
    const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
    const customKeys = [...new Set([...(state.user.settings?.custom_fields || []), ...Object.keys(l.custom || {})])];
    const canCall = !l.dnc && state.socket;
    dr.innerHTML = html`
      <div class="drawer-head">
        <div style="flex:1;min-width:0">
          <h2 class="ellipsis">${esc(l.name || 'Unnamed lead')}</h2>
          <div class="row muted" style="margin-top:4px">${esc(l.phone)} ${statusBadge(l.status)} ${l.dnc ? '<span class="badge red">DNC</span>' : ''}
            ${l.campaign ? `<span class="badge primary">${esc(l.campaign.name)}</span>` : ''}</div>
        </div>
        <button class="btn green" data-a="call" ${canCall ? '' : 'disabled'} title="${l.dnc ? 'Number is on DNC list' : 'Call with dialer'}"><i class="i i-phone"></i> Call</button>
        <button class="btn ghost icon" data-a="close"><i class="i i-x"></i></button>
      </div>
      <div class="drawer-body col gap-lg">
        ${l.duplicates.length ? `<div class="badge amber" style="white-space:normal;padding:8px 12px"><i class="i i-alert"></i> Same number exists in ${l.duplicates.length} other lead(s): ${l.duplicates.map((d) => `#${d.id} ${esc(d.name || '')}`).join(', ')}</div>` : ''}
        <div class="row">
          <button class="btn sm" data-a="wa"><i class="i i-message"></i> WhatsApp</button>
          <button class="btn sm" data-a="sms"><i class="i i-mail"></i> SMS</button>
          <button class="btn sm" data-a="note"><i class="i i-note"></i> Add note</button>
          <button class="btn sm" data-a="fu"><i class="i i-alarm"></i> Follow-up</button>
          <button class="btn sm" data-a="ticket"><i class="i i-ticket"></i> Ticket</button>
          ${isManager() ? '<button class="btn sm" data-a="dnc"><i class="i i-ban"></i> Add to DNC</button>' : ''}
          ${isManager() ? '<button class="btn sm red" data-a="delete" style="margin-left:auto">Delete</button>' : ''}
        </div>
        <form class="card" id="leadForm">
          <div class="card-head"><h3>Details</h3><button class="btn sm primary" type="submit">Save changes</button></div>
          <div class="card-body form-grid">
            <label class="field">Name<input name="name" value="${esc(l.name)}"></label>
            <label class="field">Phone<input name="phone" value="${esc(l.phone)}" ${l.phone_masked ? 'disabled' : ''}></label>
            <label class="field">Alternate phone<input name="alt_phone" value="${esc(l.alt_phone)}" ${l.phone_masked ? 'disabled' : ''}></label>
            <label class="field">Email<input name="email" type="email" value="${esc(l.email)}"></label>
            <label class="field">Status<select name="status">${options(statuses.map((s) => [s, STATUS_LABEL[s] || s]), l.status)}</select></label>
            <label class="field">Priority<select name="priority">${options([[0, 'Normal'], [1, 'High'], [2, 'Urgent']], Math.min(2, l.priority))}</select></label>
            <label class="field">Company<input name="company_name" value="${esc(l.company_name)}"></label>
            <label class="field">City<input name="city" value="${esc(l.city)}"></label>
            <label class="field">Source<input name="source" value="${esc(l.source)}"></label>
            <label class="field">Tags<input name="tags" value="${esc(l.tags)}" placeholder="comma separated"></label>
            ${isManager() ? `
              <label class="field">Assigned to<select name="assigned_to">${options(state.users.filter((u) => u.active !== 0), l.assigned_to, { empty: '— Unassigned —' })}</select></label>
              <label class="field">Campaign<select name="campaign_id">${options(state.campaigns, l.campaign_id, { empty: '— None —' })}</select></label>` : ''}
            <label class="field">Deal value<input name="deal_value" type="number" step="any" value="${esc(l.deal_value)}"></label>
            <label class="field">Amount due<input name="amount_due" type="number" step="any" value="${esc(l.amount_due)}"></label>
            <label class="field">Due date<input name="due_date" type="date" value="${esc(l.due_date)}"></label>
            <label class="field">Promise-to-pay date<input name="ptp_date" type="date" value="${esc(l.ptp_date)}"></label>
            <label class="field">PTP amount<input name="ptp_amount" type="number" step="any" value="${esc(l.ptp_amount)}"></label>
            ${customKeys.map((k) => `<label class="field">${esc(k)}<input data-custom="${esc(k)}" value="${esc(l.custom?.[k])}"></label>`).join('')}
          </div>
          <div class="card-body muted" style="border-top:1px solid var(--border);font-size:12.5px">
            Attempts: <b>${l.attempts}</b> · Last called: <b>${l.last_called_at ? fmtDate(l.last_called_at) : 'never'}</b> · Last disposition: <b>${esc(l.last_disposition || '—')}</b>
            · Next call: <b>${l.next_call_at ? fmtDate(l.next_call_at) : '—'}</b> · Created ${fmtDate(l.created_at)}${l.assigned ? ` · Owner: <b>${esc(l.assigned.name)}</b>` : ''}
          </div>
        </form>

        <div class="card">
          <div class="card-head"><h3>Calls (${l.calls.length})</h3></div>
          ${l.calls.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Agent</th><th>Result</th><th>Duration</th><th>Recording</th></tr></thead><tbody>
            ${l.calls.map((c) => `<tr><td class="nowrap">${fmtDate(c.started_at)}</td><td>${esc(c.agent_name || '—')}</td>
              <td>${c.connected ? '<span class="badge green">Connected</span>' : '<span class="badge">Not connected</span>'} ${esc(c.disposition || '')}${c.notes ? `<div class="muted" style="font-size:12px">${esc(c.notes)}</div>` : ''}</td>
              <td>${dur(c.duration)}</td><td>${c.recording_path ? `<audio controls preload="none" src="${authUrl(`/calls/${c.id}/recording`)}"></audio>` : '<span class="faint">—</span>'}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No calls yet</div>'}
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="card-head"><h3>Follow-ups</h3></div>
            <div class="card-body">${l.followups.length ? l.followups.map((f) => `<div class="row between" style="padding:6px 0;border-bottom:1px dashed var(--border)">
              <div><b>${fmtDate(f.due_at)}</b> <small class="muted">${ago(f.due_at)}</small><div class="muted" style="font-size:12.5px">${esc(f.note || '')} · ${esc(f.user_name || '')}</div></div>
              ${f.status === 'pending' ? `<button class="btn sm" data-done="${f.id}"><i class="i i-check"></i> Done</button>` : `<span class="badge ${f.status === 'done' ? 'green' : ''}">${esc(f.status)}</span>`}</div>`).join('') : '<div class="muted">None</div>'}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Tickets</h3></div>
            <div class="card-body">${l.tickets.length ? l.tickets.map((t) => `<div style="padding:6px 0;border-bottom:1px dashed var(--border)"><b>#${t.id}</b> ${esc(t.subject)} <span class="badge">${esc(t.status)}</span> <span class="badge ${t.priority === 'urgent' || t.priority === 'high' ? 'red' : ''}">${esc(t.priority)}</span></div>`).join('') : '<div class="muted">None</div>'}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Activity timeline</h3></div>
          <div class="card-body timeline">${l.activities.length ? l.activities.map((a) => `<div class="tl-item"><div class="tl-ico">${ICON[a.type] || '•'}</div>
            <div><div>${esc(a.text)}</div><div class="tl-meta">${esc(a.user_name || 'System')} · ${fmtDate(a.created_at)}</div></div></div>`).join('') : '<div class="muted">No activity yet</div>'}</div>
        </div>
      </div>`;

    const $a = (a) => dr.querySelector(`[data-a="${a}"]`);
    $a('close').onclick = close;
    $a('call').onclick = () => {
      state.socket.emit('dial', { leadId: l.id });
      close();
      location.hash = '#/agent';
    };
    $a('wa').onclick = () => sendTemplate(l, 'whatsapp', load);
    $a('sms').onclick = () => sendTemplate(l, 'sms', load);
    $a('note').onclick = () => modal({
      title: 'Add note', body: `<label class="field">Type<select name="type">${options([['note', 'Note'], ['meeting', 'Meeting'], ['email', 'Email sent']], 'note')}</select></label>
        <label class="field mt-s">Note<textarea name="text" required></textarea></label>`,
      onSubmit: async (d) => { await post(`/leads/${l.id}/notes`, d); toast('Note added', 'success'); notify(); load(); },
    });
    $a('fu').onclick = () => followupModal(l, () => { notify(); load(); });
    $a('ticket').onclick = () => modal({
      title: 'New support ticket',
      body: `<div class="form-grid"><label class="field full">Subject<input name="subject" required></label>
        <label class="field full">Description<textarea name="description"></textarea></label>
        <label class="field">Priority<select name="priority">${options(['low', 'medium', 'high', 'urgent'], 'medium')}</select></label>
        <label class="field">Assign to<select name="assigned_to">${options(state.users, state.user.id)}</select></label></div>`,
      onSubmit: async (d) => { await post('/tickets', { ...d, lead_id: l.id, assigned_to: Number(d.assigned_to) }); toast('Ticket created', 'success'); load(); },
    });
    if ($a('dnc')) $a('dnc').onclick = async () => {
      if (!(await confirmBox(`Add ${l.phone} to the Do-Not-Call list? It will never be dialed again.`))) return;
      try { await post('/dnc', { phones: [l.phone], reason: 'Added from lead profile' }); toast('Added to DNC', 'success'); notify(); load(); } catch (e) { toastErr(e); }
    };
    if ($a('delete')) $a('delete').onclick = async () => {
      if (!(await confirmBox('Delete this lead permanently? Call history stays in reports.'))) return;
      try { await del(`/leads/${l.id}`); toast('Lead deleted', 'success'); notify(); close(); } catch (e) { toastErr(e); }
    };
    dr.querySelectorAll('[data-done]').forEach((b) => (b.onclick = async () => {
      try { await put(`/followups/${b.dataset.done}`, { status: 'done' }); notify(); load(); } catch (e) { toastErr(e); }
    }));
    const form = dr.querySelector('#leadForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = {};
      for (const el of form.elements) if (el.name && !el.disabled) d[el.name] = el.value;
      d.priority = Number(d.priority);
      if (d.assigned_to !== undefined) d.assigned_to = d.assigned_to ? Number(d.assigned_to) : null;
      if (d.campaign_id !== undefined) d.campaign_id = d.campaign_id ? Number(d.campaign_id) : null;
      d.custom = {};
      form.querySelectorAll('[data-custom]').forEach((el) => { d.custom[el.dataset.custom] = el.value; });
      try { await put(`/leads/${l.id}`, d); toast('Lead saved', 'success'); notify(); load(); } catch (err) { toastErr(err); }
    };
  }
  await load();
  return { close, changed: () => changed };
}

export function followupModal(lead, done) {
  const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
  return modal({
    title: `Schedule follow-up — ${lead.name || lead.phone}`,
    body: `<div class="form-grid"><label class="field">Date & time<input type="datetime-local" name="due_at" value="${localInput(d)}" required></label>
      <div class="field">Quick pick<div class="row">${[['+1h', 1], ['+3h', 3], ['Tomorrow 11am', 't'], ['+2 days', 48]].map(([l, v]) => `<button type="button" class="btn sm" data-q="${v}">${l}</button>`).join('')}</div></div>
      <label class="field full">Note<textarea name="note" placeholder="What to discuss next time"></textarea></label>
      ${isManager() ? `<label class="field">For agent<select name="user_id">${options(state.users, lead.assigned_to || state.user.id)}</select></label>` : ''}</div>`,
    onOpen: (form) => form.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
      let t;
      if (b.dataset.q === 't') { t = new Date(); t.setDate(t.getDate() + 1); t.setHours(11, 0, 0, 0); } else t = new Date(Date.now() + Number(b.dataset.q) * 3600000);
      form.due_at.value = localInput(t);
    })),
    onSubmit: async (v) => {
      await post('/followups', { lead_id: lead.id, due_at: new Date(v.due_at).toISOString(), note: v.note, user_id: v.user_id ? Number(v.user_id) : undefined });
      toast('Follow-up scheduled', 'success');
      done?.();
    },
  });
}

/** Pick a WhatsApp/SMS template, render it for the lead, open WhatsApp/SMS app and log it. */
export async function sendTemplate(lead, channel, done) {
  let templates = [];
  try { templates = (await get('/templates')).filter((t) => t.channel === channel); } catch { /* none */ }
  modal({
    title: channel === 'whatsapp' ? 'Send WhatsApp message' : 'Send SMS',
    submit: channel === 'whatsapp' ? 'Open WhatsApp' : 'Open SMS app',
    body: `${templates.length ? `<label class="field">Template<select name="tpl">${options(templates, '', { empty: '— Write my own —' })}</select></label>` : ''}
      <label class="field mt-s">Message<textarea name="text" rows="5" required></textarea></label>
      <small class="muted">The message opens in ${channel === 'whatsapp' ? 'WhatsApp' : 'your SMS app'} on this device, ready to send.</small>`,
    onOpen: (form) => {
      const sel = form.tpl;
      if (!sel) return;
      sel.onchange = async () => {
        if (!sel.value) return;
        try { const r = await post(`/templates/${sel.value}/render`, { lead_id: lead.id }); form.text.value = r.text; } catch (e) { toastErr(e); }
      };
      if (templates[0]) { sel.value = templates[0].id; sel.onchange(); }
    },
    onSubmit: async (d) => {
      if (channel === 'whatsapp') openWhatsApp(lead.phone, d.text); else openSms(lead.phone, d.text);
      await post(`/leads/${lead.id}/notes`, { type: channel, text: `Sent ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}: ${d.text}` }).catch(() => {});
      done?.();
    },
  });
}

/** Quick "add lead" modal used by leads page and agent page. */
export function newLeadModal(done) {
  const statuses = state.user.settings?.lead_statuses || Object.keys(STATUS_LABEL);
  const myCampaigns = state.campaigns;
  modal({
    title: 'Add lead', wide: true,
    body: `<div class="form-grid">
      <label class="field">Name<input name="name"></label>
      <label class="field">Phone *<input name="phone" required inputmode="tel"></label>
      <label class="field">Email<input name="email" type="email"></label>
      <label class="field">City<input name="city"></label>
      <label class="field">Company<input name="company_name"></label>
      <label class="field">Source<input name="source" placeholder="e.g. Walk-in, Referral"></label>
      <label class="field">Campaign<select name="campaign_id">${options(myCampaigns, '', { empty: '— None —' })}</select></label>
      <label class="field">Status<select name="status">${options(statuses.map((s) => [s, STATUS_LABEL[s] || s]), 'new')}</select></label>
      ${isManager() ? `<label class="field">Assign to<select name="assigned_to">${options(state.users.filter((u) => u.active !== 0), '', { empty: '— Unassigned —' })}</select></label>` : ''}
      <label class="field">Deal value / Amount due<input name="deal_value" type="number" step="any"></label>
      <label class="field full">Tags<input name="tags" placeholder="comma separated"></label>
    </div>`,
    onSubmit: async (d) => {
      const body = { ...d, campaign_id: d.campaign_id ? Number(d.campaign_id) : null };
      if (d.assigned_to !== undefined) body.assigned_to = d.assigned_to ? Number(d.assigned_to) : null;
      try {
        const lead = await post('/leads', body);
        toast('Lead added', 'success');
        done?.(lead);
      } catch (e) {
        if (e.status === 409 && (await confirmBox(`${e.message}. Add anyway?`, { ok: 'Add duplicate', danger: false }))) {
          const lead = await post('/leads', { ...body, allow_duplicate: true });
          done?.(lead);
          return;
        }
        throw e;
      }
    },
  });
}

