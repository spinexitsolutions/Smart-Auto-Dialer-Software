// Core helpers shared by all pages: API client, state, events, UI primitives, native bridge.

export const state = {
  token: localStorage.getItem('sad_token') || null,
  user: null,
  socket: null,
  agent: null, // live agent state from server
  dispositions: [],
  users: [],
  campaigns: [],
  native: !!window.AndroidDialer,
};

// ----------------------------------------------------------------- event bus
const listeners = new Map();
export const bus = {
  on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt)?.delete(fn); },
  emit(evt, data) { for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } } },
};

// Page-scoped subscriptions that are cleared on navigation.
let pageSubs = [];
export function onPage(evt, fn) { pageSubs.push(bus.on(evt, fn)); }
let pageTimers = [];
export function pageInterval(fn, ms) { const t = setInterval(fn, ms); pageTimers.push(t); return t; }
export function clearPage() { pageSubs.forEach((u) => u()); pageSubs = []; pageTimers.forEach(clearInterval); pageTimers = []; }

// ----------------------------------------------------------------- API
export async function api(path, { method = 'GET', body, form, raw } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && state.token && !path.startsWith('/auth/login')) { logout('Session expired, please login again'); }
    if (res.status === 402) { logout(data?.error || 'Licence problem'); }
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });

/** Open an authenticated download (CSV export) in a new tab. */
export function download(path) {
  const sep = path.includes('?') ? '&' : '?';
  window.open(`/api${path}${sep}token=${encodeURIComponent(state.token)}`, '_blank');
}
export const authUrl = (path) => `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(state.token)}`;

export function logout(reason) {
  localStorage.removeItem('sad_token');
  try { window.AndroidDialer?.setAuthToken(''); } catch { /* not in app */ }
  state.token = null; state.user = null;
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  if (reason) sessionStorage.setItem('sad_logout_reason', reason);
  location.hash = '#/login';
  location.reload();
}

// ----------------------------------------------------------------- formatting
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function dur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function hours(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
/** Server timestamps are UTC 'YYYY-MM-DD HH:MM:SS'. */
export function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
  return new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
}
export function fmtDate(s, opts = {}) {
  const d = parseDate(s);
  if (!d || isNaN(d)) return '—';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...opts });
}
export function fmtDay(s) {
  const d = parseDate(s);
  if (!d || isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
export function ago(s) {
  const d = parseDate(s);
  if (!d) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const f = abs < 60 ? `${Math.round(abs)}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return diff >= 0 ? `${f} ago` : `in ${f}`;
}
export function money(n) {
  if (n == null || n === '') return '—';
  const cur = state.user?.settings?.currency || 'INR';
  try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return String(n); }
}
export const num = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
/** Value for <input type=datetime-local> from a Date. */
export function localInput(d) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 16);
}
export const today = () => localInput(new Date()).slice(0, 10);
export function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return localInput(d).slice(0, 10); }

export const STATUS_LABEL = {
  new: 'New', contacted: 'Contacted', interested: 'Interested', follow_up: 'Follow-up', converted: 'Converted',
  not_interested: 'Not interested', dnc: 'Do not call', invalid: 'Invalid',
};
const STATUS_COLOR = { new: 'blue', contacted: '', interested: 'green', follow_up: 'violet', converted: 'green', not_interested: 'red', dnc: 'red', invalid: 'amber' };
export const statusBadge = (s) => `<span class="badge ${STATUS_COLOR[s] ?? ''}">${esc(STATUS_LABEL[s] || s)}</span>`;
export const AGENT_STATUS = {
  offline: 'Offline', idle: 'Logged in', available: 'Ready', preview: 'Preview', dialing: 'Dialing', on_call: 'On call', wrapup: 'Wrap-up', break: 'On break',
};
export const agentBadge = (s, extra = '') => `<span class="badge st-${esc(s)}" style="background:color-mix(in srgb, currentColor 13%, transparent)"><span class="dot ${s === 'on_call' || s === 'dialing' ? 'pulse' : ''}"></span>${esc(AGENT_STATUS[s] || s)}${extra}</span>`;
export const isManager = () => ['admin', 'manager'].includes(state.user?.role);
export const isAdmin = () => state.user?.role === 'admin';

// ----------------------------------------------------------------- DOM helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join('') : vals[i] ?? '') : ''), '');
}
export function options(list, selected, { empty } = {}) {
  const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
    list.map((o) => {
      const [v, l] = Array.isArray(o) ? o : typeof o === 'object' ? [o.id, o.name] : [o, o];
      return `<option value="${esc(v)}" ${sel.includes(String(v)) ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('');
}
/** Read a form into an object. Checkboxes become 1/0, multi-selects arrays. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) { (out[el.name] ||= []); if (el.checked) out[el.name].push(isNaN(el.value) ? el.value : Number(el.value)); }
      else out[el.name] = el.checked ? 1 : 0;
    } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function toast(message, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div>${esc(message)}</div><span class="x" title="Close"><i class="i i-x"></i></span>`;
  el.querySelector('.x').onclick = () => el.remove();
  document.getElementById('toasts').appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
export const toastErr = (e) => toast(e?.message || String(e), 'error', 5000);

/** Show a modal. `body` is HTML; returns { el, close }. onSubmit(form data, el) may return false to keep open. */
export function modal({ title, body, wide = false, submit = 'Save', cancel = 'Cancel', onSubmit, onOpen, danger = false, footer }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<form class="modal ${wide ? 'wide' : ''}" novalidate>
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost icon" data-close><i class="i i-x"></i></button></div>
    <div class="modal-body">${body}</div>
    ${footer !== undefined ? footer : `<div class="modal-foot">${cancel ? `<button type="button" class="btn" data-close>${esc(cancel)}</button>` : ''}${onSubmit ? `<button type="submit" class="btn ${danger ? 'red' : 'primary'}">${esc(submit)}</button>` : ''}</div>`}
  </form>`;
  const form = ov.querySelector('form');
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const r = await onSubmit(formData(form), form);
      if (r !== false) close();
    } catch (err) { toastErr(err); } finally { if (btn) btn.disabled = false; }
  };
  document.body.appendChild(ov);
  onOpen?.(form, close);
  setTimeout(() => form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus(), 30);
  return { el: form, close };
}

export function confirmBox(message, { title = 'Please confirm', ok = 'Yes, continue', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title, body: `<p style="margin:0">${esc(message)}</p>`, submit: ok, danger, onSubmit: () => { done = true; resolve(true); } });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

export function promptBox(title, { label = '', value = '', type = 'text', ok = 'OK' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, submit: ok,
      body: `<label class="field">${esc(label)}${type === 'textarea' ? `<textarea name="v">${esc(value)}</textarea>` : `<input name="v" type="${type}" value="${esc(value)}">`}</label>`,
      onSubmit: (d) => { done = true; resolve(d.v); },
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(null); } });
    obs.observe(document.body, { childList: true });
  });
}

// ----------------------------------------------------------------- charts
export function barChart(data, { label = (d) => d.label, value = (d) => d.value, value2, color = 'var(--primary)', height = 180 } = {}) {
  const max = Math.max(1, ...data.map((d) => Number(value(d)) || 0));
  if (!data.length) return '<div class="empty">No data yet</div>';
  return `<div class="bars" style="height:${height}px">${data.map((d) => {
    const v = Number(value(d)) || 0; const v2 = value2 ? Number(value2(d)) || 0 : 0;
    return `<div class="bar" title="${esc(label(d))}: ${v}${value2 ? ' / ' + v2 : ''}"><span class="val">${v || ''}</span>
      <div class="stack"><div class="fill" style="height:${(v / max) * 100}%;background:${color}">${value2 ? `<div class="fill alt" style="position:absolute;bottom:0;left:0;right:0;height:${v ? (v2 / v) * 100 : 0}%"></div>` : ''}</div></div>
      <span class="lbl">${esc(label(d))}</span></div>`;
  }).join('')}</div>`;
}
export function hBars(data, { label = (d) => d.label, value = (d) => d.value, color = () => 'var(--primary)' } = {}) {
  if (!data.length) return '<div class="empty">No data yet</div>';
  const max = Math.max(1, ...data.map((d) => Number(value(d)) || 0));
  return `<div class="hbars">${data.map((d) => `<div class="hbar"><span class="ellipsis" title="${esc(label(d))}">${esc(label(d))}</span>
    <div class="track"><span style="width:${((Number(value(d)) || 0) / max) * 100}%;background:${color(d)}"></span></div><b class="right">${num(value(d))}</b></div>`).join('')}</div>`;
}

// ----------------------------------------------------------------- reference data cache
export async function loadRefs(force = false) {
  if (!force && state.refsLoaded) return;
  const [dispositions, users, campaigns] = await Promise.all([get('/dispositions'), get('/users'), get('/campaigns')]);
  Object.assign(state, { dispositions, users, campaigns, refsLoaded: true });
}

// ----------------------------------------------------------------- native bridge (Android app)
export const native = {
  available: () => !!window.AndroidDialer,
  call(fn, ...args) { try { return window.AndroidDialer?.[fn]?.(...args); } catch (e) { console.warn('native', fn, e); return null; } },
  sims() { try { return JSON.parse(this.call('getSims') || '[]'); } catch { return []; } },
  device() { try { return JSON.parse(this.call('getDeviceInfo') || '{}'); } catch { return {}; } },
};

/** Open WhatsApp chat with prefilled text (native app or web). */
export function openWhatsApp(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const cc = (state.user?.settings?.country_code || '+91').replace(/\D/g, '');
  const full = digits.length === 10 ? cc + digits : digits;
  if (native.available()) return native.call('openWhatsApp', full, text || '');
  window.open(`https://wa.me/${full}?text=${encodeURIComponent(text || '')}`, '_blank');
}
export function openSms(phone, text) {
  if (native.available()) return native.call('sendSms', phone, text || '');
  location.href = `sms:${phone}?body=${encodeURIComponent(text || '')}`;
}
