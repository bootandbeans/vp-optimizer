import { escapeHtml } from '../validation.js';

const stateFor = (app) => {
  const local = app.session.admin && typeof app.session.admin === 'object' ? app.session.admin : (app.session.admin = {});
  local.data ??= null;
  local.loading ??= false;
  local.error ??= '';
  local.search ??= '';
  return local;
};
const dateTime = (value) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';

export function renderAdmin(container, app) {
  if (app.auth?.role !== 'admin') { container.innerHTML = '<section class="notice error">Administrator access is required.</section>'; return; }
  const local = stateFor(app); const rawData = local.data && typeof local.data === 'object' ? local.data : {};
  const data = { summary: rawData.summary && typeof rawData.summary === 'object' ? rawData.summary : {}, users: Array.isArray(rawData.users) ? rawData.users : [], recentActivities: Array.isArray(rawData.recentActivities) ? rawData.recentActivities : [] };
  const needle = String(local.search || '').toLowerCase().trim(); const users = data.users.filter((user) => !needle || [user.email, user.displayName, user.provider].join(' ').toLowerCase().includes(needle));
  const summary = data.summary;
  container.innerHTML = `<section class="view-heading"><div><p class="eyebrow">Administrator workspace</p><h1>Users & usage</h1><p>Manage account access and review consent-based traffic for the past ${summary.days || 30} days.</p></div><div class="heading-actions"><button class="button subtle" id="admin-refresh">↻ Refresh dashboard</button></div></section>${local.error ? `<p class="notice error">${escapeHtml(local.error)}</p>` : ''}${local.loading ? '<section class="results-placeholder"><span>⌛</span><h2>Loading administrator data</h2><p>Fetching users, activities, and traffic totals.</p></section>' : `<section class="admin-metrics"><div><span>Registered users</span><b>${summary.users || 0}</b></div><div><span>Unique visitors</span><b>${summary.uniqueVisitors || 0}</b></div><div><span>Analytics events</span><b>${summary.events || 0}</b></div><div><span>Saved activities</span><b>${summary.activities || 0}</b></div></section><section class="surface admin-users"><header class="section-title"><div><p class="eyebrow">Account access</p><h2>Users</h2><p>Disable an account to immediately block its protected API access.</p></div><label class="admin-search">Search users<input id="admin-user-search" value="${escapeHtml(local.search)}" placeholder="Name or email" /></label></header><div class="table-wrap"><table class="admin-table"><thead><tr><th>User</th><th>Provider</th><th>Joined</th><th>Last sign-in</th><th class="num">Activities</th><th>Status</th></tr></thead><tbody>${users.length ? users.map((user) => `<tr><td><strong>${escapeHtml(user.displayName || user.email)}</strong><small>${escapeHtml(user.email)}</small></td><td>${escapeHtml(user.provider || 'password')}</td><td>${escapeHtml(dateTime(user.createdAt))}</td><td>${escapeHtml(dateTime(user.lastLoginAt))}</td><td class="num">${user.activityCount || 0}</td><td><button class="status-toggle ${user.active !== false ? 'active' : ''}" data-user-active="${escapeHtml(user.id)}" data-next-active="${user.active === false ? 'true' : 'false'}">${user.active === false ? 'Disabled' : 'Active'}</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">No user accounts match this search.</td></tr>'}</tbody></table></div></section><section class="surface admin-activity"><header class="section-title"><div><p class="eyebrow">Latest server activity</p><h2>Recent saved actions</h2></div></header>${data.recentActivities.length ? `<ul class="admin-activity-list">${data.recentActivities.map((activity) => `<li><span class="activity-icon">${activity.type === 'calculator' ? '⌁' : '◎'}</span><div><b>${escapeHtml(activity.userEmail)}</b><p>${activity.type === 'calculator' ? 'Saved calculator activity' : 'Saved optimizer activity'} · ${escapeHtml(dateTime(activity.at))}</p></div><span class="history-type">${escapeHtml(activity.type)}</span></li>`).join('')}</ul>` : '<div class="empty-panel"><b>No saved activity yet</b><p>Account actions appear here when users save calculator or optimizer activity.</p></div>'}</section>`}`;

  const load = async (force = false) => {
    if (local.loading || (!force && local.data)) return;
    local.loading = true; local.error = ''; renderAdmin(container, app);
    try { local.data = await app.actions.getAdminDashboard(); } catch (error) { local.error = error.message || 'Could not load administrator data.'; } finally { local.loading = false; renderAdmin(container, app); }
  };
  container.querySelector('#admin-refresh').onclick = () => load(true);
  const search = container.querySelector('#admin-user-search');
  if (search) search.oninput = (event) => { local.search = event.target.value; renderAdmin(container, app); };
  container.querySelectorAll('[data-user-active]').forEach((button) => { button.onclick = async () => { button.disabled = true; try { const updated = await app.actions.setUserActive(button.dataset.userActive, button.dataset.nextActive === 'true'); const index = Array.isArray(local.data?.users) ? local.data.users.findIndex((user) => user.id === updated.id) : -1; if (index >= 0) local.data.users[index] = { ...local.data.users[index], ...updated }; } catch (error) { local.error = error.message || 'Could not update this account.'; } renderAdmin(container, app); }; });
  // Do not loop forever on a failed API request; the Refresh button retries it.
  if (!local.data && !local.loading && !local.error) void load();
}
