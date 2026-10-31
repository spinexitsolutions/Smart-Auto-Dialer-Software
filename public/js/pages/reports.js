import {
  get, esc, options, download, barChart, hBars, dur, hours, fmtDate, num, money, state, loadRefs, today, daysAgo, toastErr, pct,
} from '../core.js';

const TABS = [
  ['agents', 'Agent Performance'], ['campaigns', 'Campaigns'], ['dispositions', 'Dispositions'], ['hourly', 'Hourly'],
  ['daily', 'Daily Trend'], ['attendance', 'Attendance'], ['sources', 'Lead Sources'],
];

const f = { from: daysAgo(6), to: today(), campaign_id: '', user_id: '', tab: 'agents' };

function query(extra = {}) {
  const p = new URLSearchParams();
  for (const k of ['from', 'to', 'campaign_id', 'user_id']) if (f[k]) p.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

function table(cols, rows) {
  if (!rows.length) return '<div class="empty">No data for the selected period</div>';
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.right ? 'right' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.right ? 'right nowrap' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const n = (v) => num(v);
const p = (v) => `${v ?? 0}%`;

const VIEWS = {
  agents: (rows) => table([
    { key: 'name', label: 'Agent', fmt: (v, r) => `<b>${esc(v)}</b>${r.team ? `<br><small class="muted">${esc(r.team)}</small>` : ''}` },
    { key: 'calls', label: 'Calls', right: 1, fmt: n }, { key: 'connected', label: 'Connected', right: 1, fmt: n },
    { key: 'connect_rate', label: 'Connect %', right: 1, fmt: p }, { key: 'talk_sec', label: 'Talk time', right: 1, fmt: hours },
    { key: 'avg_talk_sec', label: 'Avg talk', right: 1, fmt: dur }, { key: 'success', label: 'Success', right: 1, fmt: n },
    { key: 'conversion_rate', label: 'Conv %', right: 1, fmt: p }, { key: 'login_sec', label: 'Login time', right: 1, fmt: hours },
    { key: 'break_sec', label: 'Break', right: 1, fmt: (v, r) => `${hours(v)} <small class="muted">(${r.breaks})</small>` },
    { key: 'productive_pct', label: 'Productive', right: 1, fmt: p },
    { key: 'first_login', label: 'First login', fmt: (v) => fmtDate(v) },
  ], rows),
  campaigns: (rows) => table([
    { key: 'name', label: 'Campaign', fmt: (v, r) => `<b>${esc(v)}</b><br><small class="muted">${esc(r.type)} · ${esc(r.dial_mode)} · ${esc(r.status)}</small>` },
    { key: 'leads', label: 'Leads', right: 1, fmt: n }, { key: 'untouched', label: 'Untouched', right: 1, fmt: n },
    { key: 'penetration', label: 'Penetration', right: 1, fmt: p }, { key: 'calls', label: 'Calls', right: 1, fmt: n },
    { key: 'connected', label: 'Connected', right: 1, fmt: n }, { key: 'connect_rate', label: 'Connect %', right: 1, fmt: p },
    { key: 'talk_sec', label: 'Talk time', right: 1, fmt: hours }, { key: 'success', label: 'Success', right: 1, fmt: n },
    { key: 'converted', label: 'Converted', right: 1, fmt: n },
  ], rows),
  dispositions: (rows) => {
    const total = rows.reduce((s, r) => s + r.calls, 0);
    return `<div class="card-body">${hBars(rows, { label: (d) => d.name, value: (d) => d.calls, color: (d) => d.color })}</div>` + table([
      { key: 'name', label: 'Disposition', fmt: (v, r) => `<span class="dot" style="background:${esc(r.color)}"></span> ${esc(v)}` },
      { key: 'category', label: 'Category', fmt: (v) => (v ? esc(v.replace('_', ' ')) : '—') },
      { key: 'calls', label: 'Calls', right: 1, fmt: n }, { key: 'calls', label: 'Share', right: 1, fmt: (v) => `${pct(v, total)}%` },
      { key: 'talk_sec', label: 'Talk time', right: 1, fmt: hours },
    ], rows);
  },
  hourly: (rows) => {
    const full = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.hour === h) || { hour: h, calls: 0, connected: 0, talk_sec: 0 })
      .filter((r) => r.calls || (r.hour >= 8 && r.hour <= 21));
    return `<div class="card-body"><div class="legend"><span><i style="background:var(--primary)"></i>Calls</span><span><i style="background:#06b6d4"></i>Connected</span></div>
      ${barChart(full, { label: (d) => `${String(d.hour).padStart(2, '0')}:00`, value: (d) => d.calls, value2: (d) => d.connected })}</div>` + table([
      { key: 'hour', label: 'Hour', fmt: (v) => `${String(v).padStart(2, '0')}:00 – ${String(v + 1).padStart(2, '0')}:00` },
      { key: 'calls', label: 'Calls', right: 1, fmt: n }, { key: 'connected', label: 'Connected', right: 1, fmt: n },
      { key: 'connected', label: 'Connect %', right: 1, fmt: (v, r) => `${pct(v, r.calls)}%` }, { key: 'talk_sec', label: 'Talk time', right: 1, fmt: hours },
    ], rows);
  },
  daily: (rows) => `<div class="card-body"><div class="legend"><span><i style="background:var(--primary)"></i>Calls</span><span><i style="background:#06b6d4"></i>Connected</span></div>
    ${barChart(rows, { label: (d) => d.day.slice(5), value: (d) => d.calls, value2: (d) => d.connected })}</div>` + table([
    { key: 'day', label: 'Date' }, { key: 'calls', label: 'Calls', right: 1, fmt: n }, { key: 'connected', label: 'Connected', right: 1, fmt: n },
    { key: 'connected', label: 'Connect %', right: 1, fmt: (v, r) => `${pct(v, r.calls)}%` }, { key: 'talk_sec', label: 'Talk time', right: 1, fmt: hours },
    { key: 'success', label: 'Success', right: 1, fmt: n },
  ], rows),
  attendance: (rows) => table([
    { key: 'day', label: 'Date' }, { key: 'name', label: 'Agent', fmt: (v) => `<b>${esc(v)}</b>` },
    { key: 'first_login', label: 'First login', fmt: (v) => esc(String(v || '—').slice(11, 16)) },
    { key: 'last_logout', label: 'Last logout', fmt: (v) => esc(String(v || '—').slice(11, 16)) },
    { key: 'login_sec', label: 'Login time', right: 1, fmt: hours }, { key: 'sessions', label: 'Sessions', right: 1, fmt: n },
    { key: 'breaks', label: 'Breaks', right: 1, fmt: n }, { key: 'break_sec', label: 'Break time', right: 1, fmt: hours },
    { key: 'reasons', label: 'Break reasons', fmt: (v) => esc(v || '—') },
  ], rows),
  sources: (rows) => table([
    { key: 'source', label: 'Source', fmt: (v) => `<b>${esc(v)}</b>` }, { key: 'leads', label: 'Leads', right: 1, fmt: n },
    { key: 'called', label: 'Called', right: 1, fmt: n }, { key: 'interested', label: 'Interested', right: 1, fmt: n },
    { key: 'converted', label: 'Converted', right: 1, fmt: n }, { key: 'conversion_rate', label: 'Conv %', right: 1, fmt: p },
    { key: 'revenue', label: 'Revenue', right: 1, fmt: (v) => money(v) },
  ], rows),
};

const NO_DATE = new Set(['sources']);

export async function render(el) {
  await loadRefs().catch(() => {});
  el.innerHTML = `
    <div class="page-head">
      <div class="toolbar" id="rf">
        <label class="row">From <input type="date" name="from" value="${esc(f.from)}"></label>
        <label class="row">To <input type="date" name="to" value="${esc(f.to)}"></label>
        <select name="campaign_id">${options(state.campaigns || [], f.campaign_id, { empty: 'All campaigns' })}</select>
        <select name="user_id">${options(state.users || [], f.user_id, { empty: 'All agents' })}</select>
        <button class="btn sm" data-r="0">Today</button><button class="btn sm" data-r="6">7 days</button><button class="btn sm" data-r="29">30 days</button>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="exp">⬇ Export CSV</button>
    </div>
    <div class="tabs" id="rt">${TABS.map(([k, l]) => `<a data-t="${k}" class="${f.tab === k ? 'active' : ''}">${esc(l)}</a>`).join('')}</div>
    <div class="card" id="rb"><div class="empty">Loading…</div></div>`;
  const bar = el.querySelector('#rf');
  bar.addEventListener('change', (e) => { if (e.target.name) { f[e.target.name] = e.target.value; load(); } });
  bar.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
    f.from = daysAgo(Number(b.dataset.r)); f.to = today();
    bar.querySelector('[name=from]').value = f.from; bar.querySelector('[name=to]').value = f.to; load();
  }));
  el.querySelector('#rt').onclick = (e) => {
    const t = e.target.closest('[data-t]'); if (!t) return;
    f.tab = t.dataset.t;
    el.querySelectorAll('#rt a').forEach((a) => a.classList.toggle('active', a === t));
    load();
  };
  el.querySelector('#exp').onclick = () => download(`/reports/${f.tab}?${query({ format: 'csv' })}`);

  let seq = 0;
  async function load() {
    const my = ++seq;
    const body = el.querySelector('#rb');
    body.innerHTML = '<div class="empty">Loading…</div>';
    bar.querySelectorAll('input[type=date]').forEach((i) => (i.disabled = NO_DATE.has(f.tab)));
    try {
      const rows = await get(`/reports/${f.tab}?${query()}`);
      if (my !== seq) return;
      body.innerHTML = VIEWS[f.tab](rows);
    } catch (e) { if (my === seq) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; toastErr(e); } }
  }
  load();
}
