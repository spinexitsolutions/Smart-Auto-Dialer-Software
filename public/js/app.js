import {
  state, bus, api, post, logout, esc, toast, clearPage, initials, agentBadge, native, $, $$, loadRefs, isManager, STATUS_LABEL,
} from './core.js';

const NAV = {
  agent: [
    ['agent', '<i class="i i-phone-call"></i>', 'Dialer'], ['dashboard', '<i class="i i-dashboard"></i>', 'My Performance'], ['leads', '<i class="i i-users"></i>', 'My Leads'], ['pipeline', '<i class="i i-kanban"></i>', 'Pipeline'], ['followups', '<i class="i i-alarm"></i>', 'Follow-ups'],
    ['calls', '<i class="i i-list"></i>', 'My Calls'], ['tickets', '<i class="i i-ticket"></i>', 'Tickets'],
  ],
  manager: [
    ['dashboard', '<i class="i i-dashboard"></i>', 'Dashboard'], ['monitor', '<i class="i i-radar"></i>', 'Live Monitor'], ['agent', '<i class="i i-phone-call"></i>', 'Dialer'], '|CRM',
    ['leads', '<i class="i i-users"></i>', 'Leads'], ['pipeline', '<i class="i i-kanban"></i>', 'Pipeline'], ['campaigns', '<i class="i i-target"></i>', 'Campaigns'], ['followups', '<i class="i i-alarm"></i>', 'Follow-ups'], ['calls', '<i class="i i-list"></i>', 'Call Logs'], ['tickets', '<i class="i i-ticket"></i>', 'Tickets'],
    '|Manage', ['reports', '<i class="i i-trending-up"></i>', 'Reports'], ['team', '<i class="i i-user-cog"></i>', 'Team'], ['integrations', '<i class="i i-plug"></i>', 'Integrations'], ['settings', '<i class="i i-settings"></i>', 'Settings'],
  ],
  superadmin: [['super', '<i class="i i-building"></i>', 'Clients & Licences']],
};
NAV.admin = NAV.manager;

const PAGES = {
  dashboard: ['Dashboard', () => import('./pages/dashboard.js')],
  agent: ['Dialer', () => import('./pages/agent.js')],
  monitor: ['Live Monitor', () => import('./pages/monitor.js'), 'manager'],
  leads: ['Leads', () => import('./pages/leads.js')],
  pipeline: ['Pipeline', () => import('./pages/pipeline.js')],
  integrations: ['Integrations', () => import('./pages/integrations.js'), 'manager'],
  campaigns: ['Campaigns', () => import('./pages/campaigns.js'), 'manager'],
  followups: ['Follow-ups', () => import('./pages/followups.js')],
  calls: ['Call Logs', () => import('./pages/calls.js')],
  tickets: ['Tickets', () => import('./pages/tickets.js')],
  reports: ['Reports', () => import('./pages/reports.js'), 'manager'],
  team: ['Team', () => import('./pages/team.js'), 'manager'],
  settings: ['Settings', () => import('./pages/settings.js'), 'manager'],
  profile: ['My Profile', () => import('./pages/profile.js')],
  super: ['Clients & Licences', () => import('./pages/super.js'), 'superadmin'],
};

// ----------------------------------------------------------------- theme
function applyTheme() {
  const t = localStorage.getItem('sad_theme');
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme();

// ----------------------------------------------------------------- login
function renderLogin() {
  const reason = sessionStorage.getItem('sad_logout_reason');
  sessionStorage.removeItem('sad_logout_reason');
  const brand = esc(window.BRAND || 'Smart Auto Dialer');
  $('#app').innerHTML = `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="row"><img src="/img/logo.svg" width="44" height="44" alt=""><b style="font-size:18px">${brand}</b></div>
      <h1>Call more customers.<br>Close more deals.</h1>
      <p style="opacity:.9;font-size:15px;max-width:520px">SIM-based auto dialer with built-in CRM, live agent monitoring and reports — for sales, telecalling, support and collection teams.</p>
      <ul>
        <li><i class="i i-sim"></i>Auto-dial leads from your agents' own SIM cards</li>
        <li><i class="i i-activity"></i>Real-time monitoring of every agent & call</li>
        <li><i class="i i-users"></i>Lead management, follow-ups, WhatsApp & SMS</li>
        <li><i class="i i-bar-chart"></i>Call recordings, dispositions & performance reports</li>
      </ul>
    </div>
    <div class="auth-form">
      <form class="auth-card card card-pad" id="loginForm" style="padding:26px">
        <h2>Sign in</h2>
        <p class="muted" style="margin:0">Use the login given by your admin.</p>
        ${reason ? `<div class="badge red" style="white-space:normal;padding:8px 12px">${esc(reason)}</div>` : ''}
        <label class="field">Email<input name="email" type="email" autocomplete="username" required></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary lg block" type="submit">Login</button>
        <div class="demo-logins muted" id="demoLogins"></div>
      </form>
    </div>
  </div>`;
  const form = $('#loginForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await post('/auth/login', { email: form.email.value, password: form.password.value });
      localStorage.setItem('sad_token', r.token);
      state.token = r.token;
      state.user = r.user;
      native.call('setAuthToken', r.token);
      location.hash = r.user.role === 'superadmin' ? '#/super' : r.user.role === 'agent' ? '#/agent' : '#/dashboard';
      boot();
    } catch (err) {
      toast(err.message, 'error');
    } finally { btn.disabled = false; }
  };
  // Demo shortcuts only when the demo data set exists on this server.
  if (location.hostname === 'localhost' || new URLSearchParams(location.search).has('demo')) {
    $('#demoLogins').innerHTML = 'Demo logins: ' + [['admin@demo.com', 'Admin'], ['manager@demo.com', 'Manager'], ['agent1@demo.com', 'Agent'], ['owner@smartdialer.local', 'Super admin']]
      .map(([e, l]) => `<button type="button" class="btn sm" data-e="${e}">${l}</button>`).join('');
    $$('#demoLogins button').forEach((b) => (b.onclick = () => {
      form.email.value = b.dataset.e; form.password.value = b.dataset.e.startsWith('owner') ? 'owner123' : 'demo123'; form.requestSubmit();
    }));
  }
}

// ----------------------------------------------------------------- socket
function connectSocket() {
  if (state.socket || state.user.role === 'superadmin' || typeof io === 'undefined') return;
  const socket = io({ auth: { token: state.token, native: native.available() }, transports: ['websocket', 'polling'] });
  state.socket = socket;
  socket.on('connect', () => {
    bus.emit('socket:connect');
    flushNativeQueue();
    native.call('flushEvents');
    updateConn(true);
    if (native.available()) socket.emit('device:info', { sims: native.sims(), device: native.device() });
  });
  socket.on('disconnect', () => { updateConn(false); bus.emit('socket:disconnect'); });
  socket.on('connect_error', (e) => {
    updateConn(false);
    if (/expired|login|licen|suspend/i.test(e.message)) logout(e.message);
  });
  const fwd = ['agent:state', 'call:start', 'call:resume', 'call:update', 'call:ended', 'call:done', 'lead:preview', 'dialer:empty', 'dialer:error', 'monitor:update'];
  for (const evt of fwd) socket.on(evt, (d) => bus.emit(evt, d));
  socket.on('agent:state', (s) => { state.agent = s; renderAgentChip(); });
  socket.on('dialer:error', (d) => toast(d.message, 'error', 6000));
  socket.on('supervisor:message', (d) => toast(`${d.from}: ${d.text}`, 'msg', 0));
  socket.on('force:logout', (d) => logout(d.reason));
  // Native SIM dialing: only the Android app executes calls.
  const startNative = (p) => {
    if (p.executor === 'native' && native.available()) native.call('dial', String(p.call.id), p.call.phone, Number(p.simSlot ?? p.call.sim_slot ?? -1));
  };
  socket.on('call:start', (p) => {
    startNative(p);
    if (!location.hash.startsWith('#/agent')) location.hash = '#/agent';
  });
  socket.on('call:hangup', () => native.call('endCall'));
  socket.on('incoming:ring', (d) => showIncoming(d));
  socket.on('incoming:end', (d) => { if (d.answered) { hideIncoming(); location.hash = '#/agent'; } else if (!incomingMissedShown) hideIncoming(); });
  socket.on('incoming:missed', (d) => showMissed(d));
}

// ----------------------------------------------------------------- incoming call pop-up
let incomingEl = null;
let incomingMissedShown = false;
let incomingTimer = null;
function incomingBox() {
  if (!incomingEl) {
    incomingEl = document.createElement('div');
    incomingEl.className = 'incoming-pop';
    document.body.appendChild(incomingEl);
  }
  clearTimeout(incomingTimer);
  return incomingEl;
}
function hideIncoming() { incomingEl?.remove(); incomingEl = null; incomingMissedShown = false; }
function leadDetails(l) {
  if (!l) return '<div class="muted">New number — not in your CRM yet. A lead will be created automatically.</div>';
  const rows = [
    ['Status', esc(STATUS_LABEL[l.status] || l.status)], ['Last result', esc(l.last_disposition || '—')], ['Owner', esc(l.owner || '—')], ['Campaign', esc(l.campaign || '—')],
    l.amount_due ? ['Amount due', esc(l.amount_due)] : null, l.city ? ['City', esc(l.city)] : null,
  ].filter(Boolean);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
function showIncoming(d) {
  incomingMissedShown = false;
  const el = incomingBox();
  const l = d.lead;
  el.innerHTML = `<div class="incoming-head ring-bg"><i class="i i-phone-incoming"></i> ${d.state === 'answered' ? 'On incoming call' : 'Incoming call'}<button class="btn ghost icon sm" data-x><i class="i i-x"></i></button></div>
    <div class="incoming-body"><div class="name">${esc(l?.name || (d.phone ? 'Unknown caller' : 'Caller'))}</div><div class="mono muted">${esc(l?.phone || d.phone || 'Number shown after the call')}</div>
    ${leadDetails(l)}
    ${l ? `<button class="btn sm primary" data-open="${l.id}">Open full profile</button>` : ''}</div>`;
  el.querySelector('[data-x]').onclick = hideIncoming;
  const ob = el.querySelector('[data-open]');
  if (ob) ob.onclick = async () => { const { openLead } = await import('./pages/lead.js'); openLead(Number(ob.dataset.open)); };
}
function showMissed(d) {
  incomingMissedShown = true;
  const el = incomingBox();
  const l = d.lead;
  el.innerHTML = `<div class="incoming-head missed"><i class="i i-phone-missed"></i> Missed call<button class="btn ghost icon sm" data-x><i class="i i-x"></i></button></div>
    <div class="incoming-body"><div class="name">${esc(l?.name || 'Unknown caller')}</div><div class="mono muted">${esc(d.phone)}</div>
    <div class="muted">A call-back follow-up has been added.</div>
    ${l ? `<button class="btn sm green" data-cb="${l.id}"><i class="i i-phone"></i> Call back now</button>` : ''}</div>`;
  el.querySelector('[data-x]').onclick = hideIncoming;
  const cb = el.querySelector('[data-cb]');
  if (cb) cb.onclick = () => { state.socket?.emit('dial', { leadId: Number(cb.dataset.cb) }, (r) => { if (r && !r.ok && r.error) toast(r.error, 'error'); }); hideIncoming(); location.hash = '#/agent'; };
  incomingTimer = setTimeout(hideIncoming, 60000);
}

// Called by the Android app with JSON strings. Events are buffered until the server connection is up.
const nativeQueue = [];
function sendNative(evt, data) {
  if (state.socket?.connected) state.socket.emit(evt, data);
  else nativeQueue.push([evt, data]);
}
function flushNativeQueue() { while (nativeQueue.length && state.socket?.connected) state.socket.emit(...nativeQueue.shift()); }
const seenIncoming = new Set();
window.SADNative = {
  onCallState(json) {
    let d; try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
    bus.emit('native:call', d);
    sendNative('call:state', { callId: d.callId, state: d.state, durationSec: d.durationSec, connected: d.connected });
  },
  onIncomingCall(json) {
    let d; try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
    const key = `${d.id}|${d.state}|${d.phone}`;
    if (seenIncoming.has(key)) return; // at-least-once delivery from the app
    seenIncoming.add(key);
    sendNative('call:incoming', d);
  },
};

function updateConn(ok) {
  const el = $('#connDot');
  if (el) { el.className = `badge ${ok ? 'green' : 'red'}`; el.innerHTML = `<span class="dot"></span>${ok ? 'Live' : 'Reconnecting…'}`; }
}
function renderAgentChip() {
  const el = $('#agentChip');
  if (el && state.agent) el.innerHTML = agentBadge(state.agent.status);
}

// ----------------------------------------------------------------- layout & router
function renderLayout() {
  const u = state.user;
  const nav = NAV[u.role] || [];
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><img src="/img/logo.svg" alt=""><div>${esc(window.BRAND)}<small class="muted">${esc(u.company?.name || 'Vendor console')}</small></div></div>
      <nav class="nav">${nav.map((n) => typeof n === 'string'
        ? `<div class="nav-section">${esc(n.slice(1))}</div>`
        : `<a href="#/${n[0]}" data-route="${n[0]}"><span class="ico">${n[1]}</span>${esc(n[2])}${n[0] === 'followups' ? '<span class="badge red hidden" id="fuBadge"></span>' : ''}</a>`).join('')}</nav>
      <div class="sidebar-foot">
        <a href="#/profile" class="row" style="color:inherit;text-decoration:none">
          <span class="badge primary" style="width:34px;height:34px;justify-content:center;padding:0;font-size:13px">${esc(initials(u.name))}</span>
          <span style="min-width:0"><b class="ellipsis" style="display:block">${esc(u.name)}</b><small class="muted">${esc(u.role)}</small></span>
        </a>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn ghost icon menu-btn" id="menuBtn" aria-label="Menu"><i class="i i-menu"></i></button>
        <div class="title" id="pageTitle"></div>
        ${u.role !== 'superadmin' ? '<span id="agentChip" class="hide-sm"></span><span id="connDot" class="badge"><span class="dot"></span>…</span>' : ''}
        ${u.company?.expires_at && (new Date(u.company.expires_at) - Date.now()) < 15 * 86400000 ? `<span class="badge amber hide-sm">Licence expires ${esc(u.company.expires_at)}</span>` : ''}
        <button class="btn ghost icon" id="themeBtn" title="Light / dark theme"><i class="i i-moon"></i></button>
        <button class="btn sm" id="logoutBtn">Logout</button>
      </header>
      <main class="content" id="page"></main>
    </div>
  </div>`;
  $('#logoutBtn').onclick = () => logout();
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#themeBtn').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    localStorage.setItem('sad_theme', dark ? 'light' : 'dark');
    applyTheme();
  };
  renderAgentChip();
}

let navToken = 0;
async function route() {
  if (!state.user) return;
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const def = state.user.role === 'superadmin' ? 'super' : state.user.role === 'agent' ? 'agent' : 'dashboard';
  let page = PAGES[name] ? name : def;
  const need = PAGES[page][2];
  if (need === 'superadmin' && state.user.role !== 'superadmin') page = def;
  if (need === 'manager' && !isManager()) page = def;
  if (state.user.role === 'superadmin' && page !== 'super' && page !== 'profile') page = 'super';
  if (page !== name) { location.hash = `#/${page}`; return; }
  clearPage();
  const my = ++navToken;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === page));
  $('#sidebar')?.classList.remove('open');
  $('#pageTitle').textContent = PAGES[page][0];
  document.title = `${PAGES[page][0]} · ${window.BRAND}`;
  const el = $('#page');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const mod = await PAGES[page][1]();
    if (my !== navToken) return;
    await mod.render(el, rest);
  } catch (e) {
    console.error(e);
    if (my === navToken) el.innerHTML = `<div class="card empty">Could not load this page: ${esc(e.message)}</div>`;
  }
}

async function refreshFollowupBadge() {
  if (!state.user || state.user.role === 'superadmin') return;
  try {
    const rows = await api(`/followups?when=today${isManager() ? '' : '&mine=1'}`);
    const b = $('#fuBadge');
    if (b) { b.textContent = rows.length; b.classList.toggle('hidden', !rows.length); }
  } catch { /* ignore */ }
}

async function boot() {
  if (!state.token) { renderLogin(); return; }
  try {
    state.user = await api('/auth/me');
  } catch (e) {
    if (e.status === 401 || e.status === 402) return; // api() already logged out
    $('#app').innerHTML = `<div class="boot">Cannot reach server: ${esc(e.message)} <button class="btn sm" onclick="location.reload()">Retry</button></div>`;
    return;
  }
  native.call('setAuthToken', state.token);
  renderLayout();
  if (state.user.role !== 'superadmin') {
    // Load the dialer workspace first so it receives call events even when another page is open.
    await import('./pages/agent.js').catch((e) => console.error(e));
    connectSocket();
    loadRefs().catch(() => {});
    refreshFollowupBadge();
    setInterval(refreshFollowupBadge, 60000);
  }
  window.onhashchange = route;
  route();
}

boot();
