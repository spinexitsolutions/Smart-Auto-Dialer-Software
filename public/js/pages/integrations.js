// Integrations: lead sources, WhatsApp & SMS providers, automations, AI call analysis, message log.
import {
  state, get, post, put, del, esc, html, modal, toast, toastErr, options, fmtDate, ago, num, isAdmin, loadRefs, confirmBox,
} from '../core.js';

let tab = 'sources';
let data = null;

const SOURCE_INFO = {
  facebook: {
    icon: 'megaphone', title: 'Facebook & Instagram Lead Ads',
    fields: [['page_token', 'Page access token', 'Long-lived Page token with leads_retrieval permission', true], ['verify_token', 'Verify token', 'Any text; paste the same in Meta webhook settings'], ['app_secret', 'App secret (optional)', 'Used to verify Meta’s signature', true]],
    steps: ['In Meta for Developers, open your app → Webhooks → Page, and subscribe to the <b>leadgen</b> field.', 'Callback URL: the webhook URL below. Verify token: the one shown here.', 'Subscribe your Facebook Page to the app (Graph API: <code>/{page-id}/subscribed_apps</code>, field <code>leadgen</code>).', 'Use “Send test lead” in Meta’s Lead Ads Testing Tool to check.'],
  },
  google_ads: {
    icon: 'search', title: 'Google Ads Lead Forms',
    fields: [['google_key', 'Webhook key', 'Any secret text; paste the same in Google Ads']],
    steps: ['Google Ads → your lead form asset → Lead delivery → Webhook integration.', 'Webhook URL: the URL below. Key: the webhook key here.', 'Click “Send test data” in Google Ads — the test lead appears in Leads.'],
  },
  indiamart: {
    icon: 'building', title: 'IndiaMART Lead Manager',
    fields: [['crm_key', 'CRM key (for auto-sync)', 'Lead Manager → Import/Export → CRM integration key', true]],
    steps: ['Option 1 (recommended): paste your IndiaMART CRM key — new enquiries are pulled every 10 minutes.', 'Option 2: in IndiaMART Lead Manager, set the push API / webhook URL to the URL below.'],
  },
  justdial: {
    icon: 'phone-incoming', title: 'JustDial',
    fields: [['secret', 'Secret (optional)', 'If set, JustDial must send ?secret=… with each lead']],
    steps: ['Share the webhook URL below with your JustDial account manager and ask them to push leads to it.', 'JustDial fields name, mobile, email, city, area, category and leadid are mapped automatically.'],
  },
  website: {
    icon: 'globe', title: 'Website / Landing page form',
    fields: [['secret', 'Secret (optional)', 'If set, forms must send a hidden field “secret”']],
    steps: ['Point your form’s action (or a JSON POST) to the webhook URL below.', 'Fields: name, phone (or mobile), email, city, message. Extra fields are kept as custom fields.', 'Add a hidden field <code>_redirect</code> with your thank-you page URL to redirect after submit.'],
  },
};

const PROVIDER_INFO = {
  wa_cloud: { icon: 'message', title: 'WhatsApp Cloud API (Meta)', fields: [['phone_number_id', 'Phone number ID', 'WhatsApp Manager → API setup'], ['access_token', 'Permanent access token', 'System-user token with whatsapp_business_messaging', true]], note: 'Automations must use an approved template name (WhatsApp only allows free text within 24 hours of the customer’s last message).' },
  wa_http: { icon: 'message', title: 'WhatsApp provider (HTTP)', http: true, note: 'Works with Interakt, AiSensy, Gupshup, Wati, etc. Use placeholders {{phone}} {{phone_local}} {{message}} {{template}} {{lang}} and any key from the automation’s parameters.' },
  sms_msg91: { icon: 'mail', title: 'MSG91 SMS', fields: [['authkey', 'Auth key', 'MSG91 → API → Auth key', true]], note: 'Indian SMS needs DLT: create a Flow in MSG91 and put its Template ID on the automation. Parameters like name={{name}} fill the Flow variables.' },
  sms_http: { icon: 'mail', title: 'SMS gateway (HTTP)', http: true, note: 'Any SMS gateway with an HTTP API (Fast2SMS, Textlocal, etc.). Placeholders: {{phone}} {{phone_local}} {{message}} {{template}}.' },
};

const TRIGGERS = { disposition: 'After a call outcome is saved', missed_call: 'After a missed incoming call', lead_created: 'When a new lead arrives (Facebook, Google, website…)' };

export async function render(el) {
  await loadRefs();
  await reload();
  paint(el);
}

async function reload() { data = await get('/integrations'); }
const items = (type) => data.items.filter((i) => i.type === type);
const lock = () => (isAdmin() ? '' : 'disabled title="Only admins can change integrations"');

function paint(el) {
  el.innerHTML = html`
    <div class="page-head"><div><h1>Integrations</h1><small class="muted">Bring leads in automatically, message customers after calls and get AI call reviews</small></div></div>
    <div class="tabs">${[['sources', 'plug', 'Lead sources'], ['messaging', 'message', 'WhatsApp & SMS'], ['automations', 'zap', 'Automations'], ['ai', 'sparkles', 'AI call analysis'], ['log', 'list', 'Message log']]
      .map(([k, i, l]) => `<a data-t="${k}" class="${tab === k ? 'active' : ''}"><i class="i i-${i}"></i> ${l}</a>`).join('')}</div>
    <div id="tabBody"></div>`;
  el.querySelectorAll('[data-t]').forEach((a) => (a.onclick = () => { tab = a.dataset.t; paint(el); }));
  const body = el.querySelector('#tabBody');
  ({ sources: renderSources, messaging: renderMessaging, automations: renderAutomations, ai: renderAI, log: renderLog })[tab](body, el);
}

function copyField(value) {
  return `<div class="copy-field"><input readonly value="${esc(value)}"><button class="btn sm" type="button" data-copy="${esc(value)}"><i class="i i-copy"></i></button></div>`;
}
function bindCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
    navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied', 'success', 1200)).catch(() => toast('Select the text and copy it', 'info'));
  }));
}

function statusLine(i) {
  if (!i.active) return '<span class="badge">Disabled</span>';
  if (i.last_error) return `<span class="badge red" title="${esc(i.last_error)}">Error: ${esc(i.last_error.slice(0, 60))}</span>`;
  return '<span class="badge green"><span class="dot"></span>Connected</span>';
}

// ------------------------------------------------------------------ lead sources
function renderSources(body, el) {
  body.innerHTML = `<div class="integ-grid">${Object.entries(SOURCE_INFO).map(([type, info]) => {
    const list = items(type);
    return `<div class="card integ-card">
      <div class="row"><span class="logo"><i class="i i-${info.icon}"></i></span><div style="flex:1"><b>${esc(info.title)}</b><div class="muted" style="font-size:12.5px">${list.length ? `${list.length} connection${list.length > 1 ? 's' : ''}` : 'Not connected'}</div></div>
        <button class="btn sm primary" data-new="${type}" ${lock()}><i class="i i-plus"></i> Connect</button></div>
      ${list.map((i) => `<div class="card card-pad col" style="gap:8px;background:var(--panel-2)">
        <div class="row between"><b>${esc(i.name)}</b>${statusLine(i)}</div>
        <small class="muted">${num(i.leads_count)} leads · last ${i.last_lead_at ? ago(i.last_lead_at) : 'never'}${i.campaign_id ? ` · into ${esc(state.campaigns.find((c) => c.id === i.campaign_id)?.name || 'campaign')}` : ''}${type === 'indiamart' && i.last_sync_at ? ` · synced ${ago(i.last_sync_at)}` : ''}</small>
        <label class="field">Webhook URL${copyField(i.webhook_url)}</label>
        ${type === 'facebook' ? `<label class="field">Verify token${copyField(i.config.verify_token || '')}</label>` : ''}
        <div class="row">
          <button class="btn sm" data-edit="${i.id}" ${lock()}><i class="i i-edit"></i> Edit</button>
          <button class="btn sm" data-test="${i.id}"><i class="i i-zap"></i> Send test lead</button>
          ${type === 'indiamart' ? `<button class="btn sm" data-sync="${i.id}"><i class="i i-refresh"></i> Sync now</button>` : ''}
          ${type === 'website' ? `<button class="btn sm" data-snippet="${i.id}"><i class="i i-copy"></i> Form code</button>` : ''}
          <button class="btn sm ghost" data-del="${i.id}" style="margin-left:auto;color:var(--red)" ${lock()}><i class="i i-trash"></i></button>
        </div></div>`).join('')}
    </div>`;
  }).join('')}</div>`;
  bindCopy(body);
  body.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => sourceModal(b.dataset.new, null, el)));
  body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const i = data.items.find((x) => x.id === Number(b.dataset.edit)); sourceModal(i.type, i, el); }));
  body.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => {
    try { const r = await post(`/integrations/${b.dataset.test}/test`, {}); toast(r.result.duplicate ? 'Test lead already existed — updated it' : 'Test lead created — check Leads', 'success'); await reload(); paint(el); } catch (e) { toastErr(e); }
  }));
  body.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await post(`/integrations/${b.dataset.sync}/sync`, {}); toast(`${r.imported} new IndiaMART enquiries imported`, 'success'); await reload(); paint(el); } catch (e) { toastErr(e); b.disabled = false; }
  }));
  body.querySelectorAll('[data-snippet]').forEach((b) => (b.onclick = () => {
    const i = data.items.find((x) => x.id === Number(b.dataset.snippet));
    const code = `<form action="${i.webhook_url}" method="POST">\n  <input name="name" placeholder="Your name" required>\n  <input name="phone" placeholder="Mobile number" required>\n  <input name="email" type="email" placeholder="Email">\n  <input name="city" placeholder="City">\n  <textarea name="message" placeholder="Message"></textarea>\n  <input type="hidden" name="_redirect" value="https://your-site.com/thank-you">${i.config.secret ? `\n  <input type="hidden" name="secret" value="YOUR_SECRET">` : ''}\n  <button type="submit">Request a call back</button>\n</form>`;
    modal({ title: 'Website form code', wide: true, body: `<p class="muted" style="margin-top:0">Paste this into your website. Style it as you like — only the field names matter.</p><pre>${esc(code)}</pre>`, submit: 'Copy code', onSubmit: () => navigator.clipboard?.writeText(code).then(() => toast('Copied', 'success')) });
  }));
  bindDelete(body, el);
}

function bindDelete(body, el) {
  body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Remove this integration? Its webhook URL stops working immediately.'))) return;
    try { await del(`/integrations/${b.dataset.del}`); await reload(); paint(el); } catch (e) { toastErr(e); }
  }));
}

function routingFields(i) {
  const agents = state.users.filter((u) => u.active !== 0 && u.role === 'agent');
  return `<label class="field">Add leads to campaign<select name="campaign_id">${options(state.campaigns, i?.campaign_id ?? '', { empty: '— No campaign —' })}</select></label>
    <div class="field full">Assign new leads (round robin)<div class="row" style="gap:14px">${agents.map((u) => `<label class="check"><input type="checkbox" name="agent_ids" data-multi value="${u.id}" ${i?.agent_ids?.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('') || '<span class="muted">No agents yet</span>'}</div>
    <small class="muted">Leave all unticked to use the campaign’s agents, or keep leads unassigned if there is no campaign.</small></div>`;
}

function configFields(fields, cfg = {}) {
  return fields.map(([k, label, hint, secret]) => `<label class="field full">${esc(label)}<input name="cfg_${k}" value="${esc(cfg[k] ?? '')}" ${secret ? 'autocomplete="off"' : ''} placeholder="${esc(hint || '')}"><small class="muted">${esc(hint || '')}</small></label>`).join('');
}
const collectCfg = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('cfg_')).map(([k, v]) => [k.slice(4), v]));

function sourceModal(type, i, el) {
  const info = SOURCE_INFO[type];
  const cfg = i?.config || (type === 'google_ads' ? { google_key: Math.random().toString(36).slice(2, 12) } : {});
  modal({
    title: `${i ? 'Edit' : 'Connect'} — ${info.title}`, wide: true,
    body: `<div class="form-grid">
      <label class="field full">Name<input name="name" value="${esc(i?.name || info.title)}"></label>
      ${configFields(info.fields, cfg)}
      ${routingFields(i)}
      ${i ? `<label class="check full"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Active</label>` : ''}
      <div class="full card card-pad" style="background:var(--panel-2)"><h4>How to set it up</h4><ol style="margin:6px 0 0;padding-left:18px">${info.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${i ? '' : '<small class="muted">The webhook URL appears after you save.</small>'}</div>
    </div>`,
    onSubmit: async (d) => {
      const bodyData = { type, name: d.name, config: collectCfg(d), campaign_id: d.campaign_id ? Number(d.campaign_id) : null, agent_ids: d.agent_ids || [] };
      if (i) { bodyData.active = d.active; await put(`/integrations/${i.id}`, bodyData); } else await post('/integrations', bodyData);
      toast('Saved', 'success');
      await reload(); paint(el);
    },
  });
}

// ------------------------------------------------------------------ messaging providers
function renderMessaging(body, el) {
  body.innerHTML = `<p class="muted" style="margin-top:0">Connect one WhatsApp and one SMS provider. Automations and the “send” buttons use the most recent active one.</p>
  <div class="integ-grid">${Object.entries(PROVIDER_INFO).map(([type, info]) => {
    const list = items(type);
    return `<div class="card integ-card">
      <div class="row"><span class="logo"><i class="i i-${info.icon}"></i></span><div style="flex:1"><b>${esc(info.title)}</b></div>
        ${list.length ? '' : `<button class="btn sm primary" data-new="${type}" ${lock()}><i class="i i-plus"></i> Connect</button>`}</div>
      <small class="muted">${esc(info.note)}</small>
      ${list.map((i) => `<div class="card card-pad col" style="gap:8px;background:var(--panel-2)"><div class="row between"><b>${esc(i.name)}</b>${statusLine(i)}</div>
        <div class="row"><button class="btn sm" data-edit="${i.id}" ${lock()}><i class="i i-edit"></i> Edit</button><button class="btn sm" data-test="${i.id}"><i class="i i-send"></i> Send test</button>
        <button class="btn sm ghost" data-del="${i.id}" style="margin-left:auto;color:var(--red)" ${lock()}><i class="i i-trash"></i></button></div></div>`).join('')}
    </div>`;
  }).join('')}</div>
  ${state.user.settings?.demo_mode ? '<div class="card card-pad mt muted">Demo mode is on: without a provider, automated messages are logged as “simulated” instead of being sent.</div>' : ''}`;
  body.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => providerModal(b.dataset.new, null, el)));
  body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const i = data.items.find((x) => x.id === Number(b.dataset.edit)); providerModal(i.type, i, el); }));
  body.querySelectorAll('[data-test]').forEach((b) => (b.onclick = () => {
    const i = data.items.find((x) => x.id === Number(b.dataset.test));
    modal({
      title: `Send a test — ${PROVIDER_INFO[i.type].title}`, submit: 'Send test',
      body: `<div class="form-grid"><label class="field full">Mobile number<input name="phone" required placeholder="98XXXXXXXX"></label>
        <label class="field full">Message (free text)<textarea name="text">Test message from ${esc(state.user.company?.name || '')}</textarea></label>
        <label class="field">Template name / ID (optional)<input name="provider_template"></label><label class="field">Language<input name="provider_lang" value="en"></label></div>`,
      onSubmit: async (d) => { const r = await post(`/integrations/${i.id}/test`, d); toast(`Sent (${r.ref})`, 'success'); },
    });
  }));
  bindDelete(body, el);
}

function providerModal(type, i, el) {
  const info = PROVIDER_INFO[type];
  const cfg = i?.config || { method: 'POST', headers: '{"Authorization": "Basic YOUR_KEY"}', body: '{"phone": "{{phone}}", "message": "{{message}}"}' };
  const fields = info.http ? [['url', 'API URL', 'https://api.provider.com/send?to={{phone}}'], ['method', 'Method', 'POST or GET'], ['headers', 'Headers (JSON)', '{"Authorization": "..."}'], ['body', 'Body template (JSON)', '{"to": "{{phone}}", "text": "{{message}}"}']] : info.fields;
  modal({
    title: `${i ? 'Edit' : 'Connect'} — ${info.title}`, wide: true,
    body: `<div class="form-grid"><label class="field full">Name<input name="name" value="${esc(i?.name || info.title)}"></label>${configFields(fields, cfg)}
      ${i ? `<label class="check full"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Active</label>` : ''}<small class="muted full">${esc(info.note)}</small></div>`,
    onSubmit: async (d) => {
      const bodyData = { type, name: d.name, config: collectCfg(d) };
      if (info.http && bodyData.config.headers) { try { JSON.parse(bodyData.config.headers); } catch { toast('Headers must be valid JSON', 'error'); return false; } }
      if (i) { bodyData.active = d.active; await put(`/integrations/${i.id}`, bodyData); } else await post('/integrations', bodyData);
      toast('Saved', 'success');
      await reload(); paint(el);
    },
  });
}

// ------------------------------------------------------------------ automations
async function renderAutomations(body, el) {
  let rules, templates;
  try { [rules, templates] = await Promise.all([get('/integrations/automations'), get('/templates')]); } catch (e) { return toastErr(e); }
  body.innerHTML = `<div class="card">
    <div class="card-head"><h3><i class="i i-zap"></i> Automatic messages</h3><button class="btn sm primary" id="newA"><i class="i i-plus"></i> New automation</button></div>
    ${rules.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>When</th><th>Send</th><th>Delay</th><th>Sent</th><th>Status</th><th></th></tr></thead><tbody>
      ${rules.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.campaign_name ? `<div class="muted" style="font-size:12px">Only ${esc(r.campaign_name)}</div>` : ''}</td>
        <td>${esc(TRIGGERS[r.trigger])}${r.disposition_name ? `: <b>${esc(r.disposition_name)}</b>` : ''}</td>
        <td><span class="badge ${r.channel === 'whatsapp' ? 'green' : 'blue'}">${r.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</span> ${esc(r.template_name || r.provider_template || '')}</td>
        <td>${r.delay_minutes ? `${r.delay_minutes} min` : 'Instantly'}</td><td>${num(r.sent_count)}</td>
        <td>${r.active ? '<span class="badge green">On</span>' : '<span class="badge">Off</span>'}</td>
        <td class="actions"><button class="btn sm" data-edit="${r.id}"><i class="i i-edit"></i></button><button class="btn sm ghost" data-del="${r.id}" style="color:var(--red)"><i class="i i-trash"></i></button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty"><i class="i i-zap"></i>No automations yet. Example: when the outcome is “Interested”, send the brochure on WhatsApp.</div>'}
  </div>`;
  const open = (r) => autoModal(r, templates, () => renderAutomations(body, el));
  body.querySelector('#newA').onclick = () => open(null);
  body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => open(rules.find((r) => r.id === Number(b.dataset.edit)))));
  body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Delete this automation?'))) return;
    try { await del(`/integrations/automations/${b.dataset.del}`); renderAutomations(body, el); } catch (e) { toastErr(e); }
  }));
}

function autoModal(r, templates, done) {
  const v = r || { trigger: 'disposition', channel: 'whatsapp', delay_minutes: 0, active: 1 };
  modal({
    title: r ? 'Edit automation' : 'New automation', wide: true,
    body: `<div class="form-grid">
      <label class="field full">Name<input name="name" value="${esc(v.name)}" required placeholder="e.g. Send brochure to interested customers"></label>
      <label class="field">When<select name="trigger">${options(Object.entries(TRIGGERS), v.trigger)}</select></label>
      <label class="field" id="dispField">Call outcome<select name="disposition_id">${options(state.dispositions, v.disposition_id ?? '', { empty: 'Any outcome' })}</select></label>
      <label class="field">Only for campaign<select name="campaign_id">${options(state.campaigns, v.campaign_id ?? '', { empty: 'All campaigns' })}</select></label>
      <label class="field">Send via<select name="channel">${options([['whatsapp', 'WhatsApp'], ['sms', 'SMS']], v.channel)}</select></label>
      <label class="field full">Message template<select name="template_id"></select><small class="muted">Manage texts in Settings → Templates. Used as the message text and in the message log.</small></label>
      <label class="field">Provider template name / DLT ID<input name="provider_template" value="${esc(v.provider_template)}" placeholder="WhatsApp approved template or MSG91 Flow ID"></label>
      <label class="field">Template language<input name="provider_lang" value="${esc(v.provider_lang || 'en')}"></label>
      <label class="field full">Template parameters<input name="provider_params" value="${esc(v.provider_params)}" placeholder="{{first_name}}, {{amount_due}}   or for MSG91: name={{name}}, amount={{amount_due}}"></label>
      <label class="field">Delay (minutes)<input type="number" min="0" name="delay_minutes" value="${esc(v.delay_minutes)}"></label>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label>
    </div>`,
    onOpen: (form) => {
      const fill = () => {
        const list = templates.filter((t) => t.channel === form.channel.value);
        form.template_id.innerHTML = options(list, v.template_id ?? '', { empty: '— None (provider template only) —' });
      };
      const toggle = () => { form.querySelector('#dispField').style.display = form.trigger.value === 'disposition' ? '' : 'none'; };
      form.channel.onchange = fill; form.trigger.onchange = toggle; fill(); toggle();
    },
    onSubmit: async (d) => {
      const b = { ...d, disposition_id: d.trigger === 'disposition' && d.disposition_id ? Number(d.disposition_id) : null, campaign_id: d.campaign_id ? Number(d.campaign_id) : null, template_id: d.template_id ? Number(d.template_id) : null };
      if (r) await put(`/integrations/automations/${r.id}`, b); else await post('/integrations/automations', b);
      toast('Automation saved', 'success');
      done();
    },
  });
}

// ------------------------------------------------------------------ AI
function renderAI(body, el) {
  const i = items('ai')[0];
  const cfg = i?.config || { enabled: true, auto: true, stt_provider: 'sarvam', language: 'hi-IN', model: 'claude-opus-5-5' };
  body.innerHTML = `<div class="grid g2" style="align-items:start">
    <form class="card" id="aiForm"><div class="card-head"><h3><i class="i i-sparkles"></i> AI call analysis</h3>${i ? statusLine(i) : '<span class="badge">Not set up</span>'}</div>
      <div class="card-body form-grid">
        <label class="check"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''} ${lock()}> Turn on AI analysis</label>
        <label class="check"><input type="checkbox" name="auto" ${cfg.auto !== false ? 'checked' : ''} ${lock()}> Analyse every recorded call automatically</label>
        <h4 class="full">1. Speech to text</h4>
        <label class="field">Provider<select name="stt_provider" ${lock()}>${options([['sarvam', 'Sarvam AI (best for Hindi / Hinglish)'], ['deepgram', 'Deepgram'], ['openai', 'OpenAI Whisper']], cfg.stt_provider)}</select></label>
        <label class="field">Language<select name="language" ${lock()}>${options([['hi-IN', 'Hindi / Hinglish'], ['en-IN', 'English (India)'], ['auto', 'Detect automatically'], ['ta-IN', 'Tamil'], ['te-IN', 'Telugu'], ['mr-IN', 'Marathi'], ['bn-IN', 'Bengali'], ['gu-IN', 'Gujarati'], ['kn-IN', 'Kannada'], ['ml-IN', 'Malayalam'], ['pa-IN', 'Punjabi']], cfg.language)}</select></label>
        <label class="field full">API key<input name="stt_key" value="${esc(cfg.stt_key || '')}" autocomplete="off" ${lock()}></label>
        <h4 class="full">2. Analysis by Claude</h4>
        <label class="field">Model<select name="model" ${lock()}>${options(Object.entries(data.models), cfg.model)}</select></label>
        <label class="field">Anthropic API key<input name="anthropic_key" value="${esc(cfg.anthropic_key || '')}" autocomplete="off" ${lock()}></label>
        <small class="muted full">Keys are stored on your server and are never shown again in full. Claude Opus 5.5 gives the best coaching; Claude Haiku 5.5 costs the least per call.</small>
        ${isAdmin() ? '<div class="full"><button class="btn primary" type="submit">Save</button></div>' : ''}
      </div></form>
    <div class="card card-pad col"><h3>What you get for every call</h3>
      <ul style="margin:0;padding-left:18px;line-height:1.8">
        <li>2–3 line summary and the customer’s intent</li><li>Customer mood: positive / neutral / negative</li>
        <li>Quality score, script-following score and politeness score</li><li>Coaching tips and red flags (rude language, false promises)</li>
        <li>Suggested next step and outcome</li><li>Full transcript, searchable in call logs</li></ul>
      <small class="muted">Needs call recordings: turn on the phone’s built-in call recorder and set the recording folder in the Android app. Results show in Call Logs, the lead profile and Reports → Call quality.</small>
      ${state.user.settings?.demo_mode ? '<div class="badge violet" style="white-space:normal;padding:8px">Demo mode: without keys, sample analyses are generated so you can show the feature.</div>' : ''}
    </div></div>`;
  const form = body.querySelector('#aiForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const config = {
      enabled: form.enabled.checked, auto: form.auto.checked, stt_provider: form.stt_provider.value, language: form.language.value,
      stt_key: form.stt_key.value, model: form.model.value, anthropic_key: form.anthropic_key.value,
    };
    try {
      if (i) await put(`/integrations/${i.id}`, { config, active: 1 }); else await post('/integrations', { type: 'ai', name: 'AI call analysis', config });
      toast('AI settings saved', 'success');
      await reload(); paint(el);
    } catch (err) { toastErr(err); }
  };
}

// ------------------------------------------------------------------ log
async function renderLog(body) {
  let rows;
  try { rows = await get('/integrations/messages'); } catch (e) { return toastErr(e); }
  const badge = { sent: 'green', simulated: 'violet', failed: 'red', queued: 'amber', sending: 'amber' };
  body.innerHTML = `<div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Channel</th><th>Message</th><th>Automation</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td class="nowrap">${fmtDate(m.created_at)}</td><td>${esc(m.lead_name || '')}<div class="mono muted" style="font-size:12px">${esc(m.phone)}</div></td>
      <td>${m.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</td><td style="max-width:340px">${esc(m.body || m.provider_template || '')}</td><td>${esc(m.automation_name || '—')}</td>
      <td><span class="badge ${badge[m.status] || ''}">${esc(m.status)}</span>${m.error ? `<div class="muted" style="font-size:12px;max-width:260px">${esc(m.error)}</div>` : ''}</td>
      <td class="actions">${m.status === 'failed' ? `<button class="btn sm" data-retry="${m.id}"><i class="i i-refresh"></i> Retry</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty"><i class="i i-inbox"></i>No messages yet</div>'}</div>`;
  body.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => {
    try { await post(`/integrations/messages/${b.dataset.retry}/retry`, {}); renderLog(body); } catch (e) { toastErr(e); }
  }));
}
