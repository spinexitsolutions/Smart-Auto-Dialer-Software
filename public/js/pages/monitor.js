// Real-time agent monitoring + wallboard.
import { state, get, post, esc, html, num, hours, dur, pct, initials, AGENT_STATUS, onPage, pageInterval, toast, toastErr, promptBox, confirmBox } from '../core.js';

let snap = null;
let filter = 'all';
let wall = false;

export async function render(el) {
  snap = await get('/monitor');
  paint(el);
  onPage('monitor:update', (s) => { snap = s; paint(el); });
  onPage('socket:connect', () => state.socket.emit('monitor:get', null, (r) => { if (r?.snapshot) { snap = r.snapshot; paint(el); } }));
  // Live timers between pushes.
  pageInterval(() => {
    el.querySelectorAll('[data-since]').forEach((n) => { n.textContent = dur((Date.now() - Number(n.dataset.since)) / 1000); });
  }, 1000);
  // Safety refresh in case a push was missed.
  pageInterval(async () => { try { snap = await get('/monitor'); paint(el); } catch { /* ignore */ } }, 30000);
}

function paint(el) {
  const s = snap.summary;
  const groups = { all: () => true, active: (a) => ['dialing', 'on_call'].includes(a.status), ready: (a) => ['available', 'preview', 'idle'].includes(a.status), wrapup: (a) => a.status === 'wrapup', break: (a) => a.status === 'break', offline: (a) => a.status === 'offline' };
  const order = { on_call: 0, dialing: 1, wrapup: 2, preview: 3, available: 4, idle: 5, break: 6, offline: 7 };
  const list = snap.agents.filter(groups[filter]).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  el.innerHTML = html`
    <div class="page-head">
      <div><h1>Live agent monitor</h1><small class="muted">Updates instantly as agents dial, talk and take breaks</small></div>
      <span class="spacer"></span>
      <button class="btn" id="bcast"><i class="i i-megaphone"></i> Message all agents</button>
      <button class="btn ${wall ? 'primary' : ''}" id="wallBtn"><i class="i i-monitor"></i> ${wall ? 'Exit wallboard' : 'Wallboard'}</button>
    </div>
    <div class="grid g4 ${wall ? 'wallboard' : ''}">
      <div class="card stat"><span class="label">On call now</span><span class="value" style="color:var(--violet)">${s.on_call}</span><span class="sub">${s.online} of ${s.total} agents online</span></div>
      <div class="card stat"><span class="label">Ready / waiting</span><span class="value" style="color:var(--green)">${s.available}</span><span class="sub">${s.wrapup} in wrap-up · ${s.break} on break</span></div>
      <div class="card stat"><span class="label">Calls today</span><span class="value">${num(s.calls)}</span><span class="sub">${num(s.connected)} connected (${pct(s.connected, s.calls)}%)</span></div>
      <div class="card stat"><span class="label">Talk time today</span><span class="value">${hours(s.talk_sec)}</span><span class="sub">${num(s.success)} successful outcomes</span></div>
    </div>
    <div class="tabs mt">${[['all', 'All'], ['active', 'On call'], ['ready', 'Ready'], ['wrapup', 'Wrap-up'], ['break', 'On break'], ['offline', 'Offline']]
      .map(([k, l]) => `<a data-f="${k}" class="${filter === k ? 'active' : ''}">${l} (${snap.agents.filter(groups[k]).length})</a>`).join('')}</div>
    ${list.length ? `<div class="agent-tiles">${list.map(tile).join('')}</div>` : '<div class="card empty">No agents in this view. Add agents from the Team page.</div>'}`;
  el.querySelectorAll('[data-f]').forEach((a) => (a.onclick = () => { filter = a.dataset.f; paint(el); }));
  el.querySelector('#wallBtn').onclick = () => {
    wall = !wall;
    if (wall) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen?.();
    paint(el);
  };
  el.querySelector('#bcast').onclick = async () => {
    const text = await promptBox('Message all agents', { label: 'Shown as a pop-up on every logged-in agent screen', type: 'textarea', ok: 'Send' });
    if (text) { try { await post('/monitor/broadcast', { text }); toast('Message sent', 'success'); } catch (e) { toastErr(e); } }
  };
  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act, Number(b.dataset.id), b.dataset.name)));
}

function tile(a) {
  const busy = ['dialing', 'on_call', 'wrapup', 'preview'].includes(a.status);
  return `<div class="card agent-tile st-${esc(a.status)}">
    <div class="who"><span class="ava">${esc(initials(a.name))}</span>
      <div style="min-width:0;flex:1"><div class="nm ellipsis">${esc(a.name)}</div><small class="muted">${esc(a.team || a.role)}${a.hasDevice ? ' · <i class="i i-smartphone"></i>' : ''}</small></div>
      <div class="right"><div class="state">${esc(AGENT_STATUS[a.status] || a.status)}</div>${a.since && a.status !== 'offline' ? `<small class="mono muted" data-since="${a.since}">${dur(a.elapsed)}</small>` : ''}</div>
    </div>
    ${busy && a.lead ? `<div style="font-size:13px;color:var(--text)"><i class="i i-phone"></i> <b>${esc(a.lead.name || 'Unknown')}</b> <span class="muted">${esc(a.lead.phone || '')}</span></div>` : ''}
    ${a.status === 'break' ? `<div style="font-size:13px;color:var(--text)"><i class="i i-coffee"></i> ${esc(a.breakReason || 'Break')}</div>` : ''}
    ${a.campaign ? `<small class="muted ellipsis"><i class="i i-target"></i> ${esc(a.campaign)}</small>` : ''}
    <div class="mini"><div><b>${a.calls}</b><span>Calls</span></div><div><b>${a.connected}</b><span>Conn.</span></div><div><b>${hours(a.talk_sec)}</b><span>Talk</span></div><div><b style="color:var(--green)">${a.success}</b><span>Won</span></div></div>
    <div class="row">
      <button class="btn sm" data-act="message" data-id="${a.id}" data-name="${esc(a.name)}"><i class="i i-message"></i></button>
      ${a.status !== 'offline' ? `
        ${a.status !== 'break' && !['dialing', 'on_call'].includes(a.status) ? `<button class="btn sm" data-act="break" data-id="${a.id}" data-name="${esc(a.name)}">Break</button>` : ''}
        ${a.autoDial ? `<button class="btn sm" data-act="idle" data-id="${a.id}" data-name="${esc(a.name)}">Pause</button>` : ''}
        ${!['dialing', 'on_call'].includes(a.status) ? `<button class="btn sm" data-act="logout" data-id="${a.id}" data-name="${esc(a.name)}">Logout</button>` : ''}` : ''}
    </div>
  </div>`;
}

async function act(action, id, name) {
  try {
    if (action === 'message') {
      const text = await promptBox(`Message ${name}`, { label: 'Appears instantly on the agent screen', type: 'textarea', ok: 'Send' });
      if (!text) return;
      await post(`/monitor/agents/${id}/message`, { text });
      return toast('Sent', 'success');
    }
    if (action === 'logout' && !(await confirmBox(`Force logout ${name}?`))) return;
    await post(`/monitor/agents/${id}/${action}`, {});
    toast('Done', 'success');
  } catch (e) { toastErr(e); }
}

