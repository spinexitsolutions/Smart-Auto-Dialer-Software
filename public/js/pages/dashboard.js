import { get, esc, html, barChart, hBars, hours, num, pct, money, isManager, state, pageInterval, STATUS_LABEL } from '../core.js';

function delta(a, b) {
  if (!b) return '';
  const d = Math.round(((a - b) / b) * 100);
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '<i class="i i-arrow-up"></i>' : '<i class="i i-arrow-down"></i>'} ${Math.abs(d)}%</span> vs yesterday`;
}

export async function render(el) {
  async function load() {
    const d = await get('/reports/dashboard');
    const t = d.today, y = d.yesterday;
    const hourly = Array.from({ length: 24 }, (_, h) => d.hourly.find((x) => x.hour === h) || { hour: h, calls: 0, connected: 0 })
      .filter((x, i, arr) => x.calls || (i >= 8 && i <= 21) || arr.slice(0, i).some((p) => p.calls));
    const mgr = isManager();
    const totalLeads = d.leadsByStatus.reduce((s, x) => s + x.n, 0);
    el.innerHTML = html`
      <div class="page-head">
        <div><h1>${mgr ? 'Team overview' : `Hi ${esc(state.user.name.split(' ')[0])}`}</h1><small class="muted">Today's numbers update every 30 seconds</small></div>
        <span class="spacer"></span>
        ${mgr ? '<a class="btn" href="#/monitor"><i class="i i-radar"></i> Live monitor</a><a class="btn" href="#/reports"><i class="i i-trending-up"></i> Reports</a>' : '<a class="btn primary" href="#/agent"><i class="i i-phone"></i> Open dialer</a>'}
      </div>
      <div class="grid g4">
        <div class="card stat"><span class="icon"><i class="i i-phone"></i></span><span class="label">Calls today</span><span class="value">${num(t.calls)}</span><span class="sub">${delta(t.calls, y.calls)}</span></div>
        <div class="card stat"><span class="icon"><i class="i i-check-circle"></i></span><span class="label">Connected</span><span class="value">${num(t.connected)}</span><span class="sub">${pct(t.connected, t.calls)}% connect rate</span></div>
        <div class="card stat"><span class="icon"><i class="i i-timer"></i></span><span class="label">Talk time</span><span class="value">${hours(t.talk_sec)}</span><span class="sub">avg ${t.connected ? Math.round(t.talk_sec / t.connected) : 0}s per connected call</span></div>
        <div class="card stat"><span class="icon"><i class="i i-trophy"></i></span><span class="label">Successful outcomes</span><span class="value" style="color:var(--green)">${num(t.success)}</span><span class="sub">${pct(t.success, t.connected)}% of connected · ${delta(t.success, y.success)}</span></div>
      </div>
      <div class="grid g4 mt">
        <a class="card stat" href="#/followups" style="color:inherit;text-decoration:none"><span class="label">Follow-ups overdue</span><span class="value" style="color:${d.followups.overdue ? 'var(--red)' : 'inherit'}">${num(d.followups.overdue)}</span><span class="sub">${num(d.followups.today)} more due in next 24h</span></a>
        <div class="card stat"><span class="label">New leads today</span><span class="value">${num(d.leadsToday)}</span><span class="sub">${num(totalLeads)} leads ${mgr ? 'in CRM' : 'assigned to you'}</span></div>
        <a class="card stat" href="#/tickets" style="color:inherit;text-decoration:none"><span class="label">Open tickets</span><span class="value">${num(d.openTickets)}</span><span class="sub">Support queue</span></a>
        <div class="card stat"><span class="label">Collections (PTP)</span><span class="value">${money(d.collections.ptp)}</span><span class="sub">${num(d.collections.ptp_count)} promises · ${money(d.collections.due)} outstanding</span></div>
      </div>
      <div class="grid g3 mt">
        <div class="card span2"><div class="card-head"><h3>Calls by hour</h3><div class="legend"><span><i style="background:var(--primary)"></i>Calls</span><span><i style="background:#06b6d4"></i>Connected</span></div></div>
          <div class="card-body">${barChart(hourly, { label: (x) => `${x.hour}:00`, value: (x) => x.calls, value2: (x) => x.connected })}</div></div>
        <div class="card"><div class="card-head"><h3>Outcomes today</h3></div>
          <div class="card-body">${hBars(d.dispositions, { label: (x) => x.name, value: (x) => x.n, color: (x) => x.color })}</div></div>
      </div>
      <div class="grid ${mgr ? 'g2' : 'g1'} mt">
        ${mgr ? `<div class="card"><div class="card-head"><h3><i class="i i-award"></i> Top agents today</h3></div>
          ${d.topAgents.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Agent</th><th class="right">Calls</th><th class="right">Connected</th><th class="right">Talk</th><th class="right">Success</th></tr></thead><tbody>
          ${d.topAgents.map((a, i) => `<tr><td><span class="rank r${i + 1}">${i + 1}</span></td><td><b>${esc(a.name)}</b></td><td class="right">${a.calls}</td><td class="right">${a.connected}</td><td class="right">${hours(a.talk_sec)}</td><td class="right"><b style="color:var(--green)">${a.success}</b></td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No calls yet today</div>'}</div>` : ''}
        <div class="card"><div class="card-head"><h3>Lead pipeline</h3><a class="btn sm ghost" href="#/leads">View leads <i class="i i-chevron-right"></i></a></div>
          <div class="card-body">${hBars(d.leadsByStatus, { label: (x) => STATUS_LABEL[x.status] || x.status, value: (x) => x.n, color: (x) => ({ converted: 'var(--green)', interested: '#22c55e', follow_up: 'var(--violet)', not_interested: 'var(--red)', dnc: '#111827', invalid: 'var(--amber)', new: 'var(--blue)' }[x.status] || 'var(--faint)') })}</div></div>
      </div>`;
  }
  await load();
  pageInterval(() => load().catch(() => {}), 30000);
}
