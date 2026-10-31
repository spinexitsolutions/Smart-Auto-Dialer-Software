import { post, put, esc, toast, toastErr, options, formData, state, native } from '../core.js';

const SIM_OPTS = [[-1, 'Default / ask every time'], [0, 'SIM 1'], [1, 'SIM 2']];

export async function render(el) {
  const u = state.user;
  const sims = native.available() ? native.sims() : [];
  const dev = native.available() ? native.device() : null;
  el.innerHTML = `
  <div class="grid g2">
    <form class="card" id="pf">
      <div class="card-head"><h3>My profile</h3></div>
      <div class="card-body col">
        <dl class="kv"><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Role</dt><dd style="text-transform:capitalize">${esc(u.role)}</dd>
          ${u.company ? `<dt>Company</dt><dd>${esc(u.company.name)}</dd>` : ''}${u.team ? `<dt>Team</dt><dd>${esc(u.team)}</dd>` : ''}</dl>
        <label class="field">Name<input name="name" required value="${esc(u.name)}"></label>
        <label class="field">Mobile<input name="phone" value="${esc(u.phone || '')}"></label>
        ${u.role !== 'superadmin' ? `<label class="field">SIM used for calls<select name="sim_slot">${options(SIM_OPTS, u.sim_slot ?? -1)}</select></label>` : ''}
        <div><button class="btn primary" type="submit">Save profile</button></div>
      </div>
    </form>
    <form class="card" id="pw">
      <div class="card-head"><h3>Change password</h3></div>
      <div class="card-body col">
        <label class="field">Current password<input name="current_password" type="password" autocomplete="current-password" required></label>
        <label class="field">New password<input name="new_password" type="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field">Confirm new password<input name="confirm" type="password" autocomplete="new-password" minlength="6" required></label>
        <div><button class="btn primary" type="submit">Update password</button></div>
        <small class="muted">Changing your password logs you out on all other devices.</small>
      </div>
    </form>
    ${u.role !== 'superadmin' ? `<div class="card span2">
      <div class="card-head"><h3>📱 Phone / SIM calling</h3>${native.available() ? '<span class="badge green">Android app connected</span>' : '<span class="badge">Browser</span>'}</div>
      <div class="card-body col">
        ${native.available() ? `
          <dl class="kv"><dt>Device</dt><dd>${esc([dev?.manufacturer, dev?.model].filter(Boolean).join(' ') || '—')} ${dev?.android ? `· Android ${esc(dev.android)}` : ''}</dd>
          <dt>App version</dt><dd>${esc(dev?.appVersion || '—')}</dd>
          <dt>SIM cards</dt><dd>${sims.length ? sims.map((s) => `<span class="badge primary" style="margin-right:6px">SIM ${s.slot + 1}: ${esc(s.label || 'SIM')}${s.number ? ' · ' + esc(s.number) : ''}</span>`).join('') : '<span class="muted">No SIM detected (grant phone permission in the app)</span>'}</dd></dl>`
        : `<p style="margin:0">To auto-dial from your own SIM card, install the <b>${esc(window.BRAND)} Android app</b> on your phone and login with the same email. Calls will then be placed from the phone's SIM automatically, and call duration &amp; recordings are synced here.</p>
           <ol style="margin:0;padding-left:20px" class="muted">
             <li>Ask your admin for the APK download link (see <code>docs/</code> and <code>android/README.md</code> in the software package).</li>
             <li>Install, open the app, enter this server address: <code>${esc(location.origin)}</code></li>
             <li>Allow Phone, Call log and Notification permissions, then login.</li>
           </ol>
           <p class="muted" style="margin:0">Without the app you can still work in manual mode: click the number to call from any phone, then mark the call answered / ended.</p>`}
      </div>
    </div>` : ''}
  </div>`;

  el.querySelector('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.sim_slot !== undefined) d.sim_slot = Number(d.sim_slot);
    try {
      const r = await put('/auth/profile', d);
      Object.assign(state.user, { name: r.name, phone: r.phone, sim_slot: r.sim_slot });
      toast('Profile saved', 'success');
    } catch (err) { toastErr(err); }
  };
  el.querySelector('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.new_password !== d.confirm) return toast('New passwords do not match', 'error');
    try {
      const r = await post('/auth/change-password', { current_password: d.current_password, new_password: d.new_password });
      localStorage.setItem('sad_token', r.token);
      state.token = r.token;
      native.call('setAuthToken', r.token);
      // Reconnect the live socket with the new token (old one is now invalid).
      if (state.socket) { state.socket.auth = { ...(state.socket.auth || {}), token: r.token }; state.socket.disconnect().connect(); }
      e.target.reset();
      toast('Password updated', 'success');
    } catch (err) { toastErr(err); }
  };
}
