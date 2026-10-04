import { escapeHtml } from '../validation.js';
import { formatMoney, formatVp } from '../pricing.js';

const stateFor = (app) => (app.session.history ||= { data: null, loading: false, error: '' });
const dateTime = (value) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
function basketSummary(basket) {
  const data = basket.data || {};
  if (basket.type === 'calculator') return `${formatVp(data.totalVP)} VP · ${formatMoney(data.final)} payable`;
  const result = data.result || data;
  return `Target ${formatVp(data.inputs?.target)} VP · ${formatVp(result.totalVP)} VP · ${formatMoney(result.final)} payable`;
}
function activitySummary(activity) {
  const data = activity.data || {};
  if (activity.type === 'calculator') return `${formatVp(data.totalVP)} VP · final ${formatMoney(data.final)}`;
  return `Target ${formatVp(data.inputs?.target)} VP · ${data.validResults?.length || 0} valid result${data.validResults?.length === 1 ? '' : 's'}`;
}

export function renderHistory(container, app) {
  const local = stateFor(app);
  const rawData = local.data && typeof local.data === 'object' ? local.data : {};
  const data = { baskets: Array.isArray(rawData.baskets) ? rawData.baskets : [], activities: Array.isArray(rawData.activities) ? rawData.activities : [] };
  container.innerHTML = `<section class="view-heading"><div><p class="eyebrow">Personal workspace</p><h1>My History</h1><p>Reopen your saved baskets and review recent calculator or optimizer activity.</p></div><div class="heading-actions"><button class="button subtle" id="history-refresh">↻ Refresh</button></div></section>${local.error ? `<p class="notice error">${escapeHtml(local.error)}</p>` : ''}${local.loading ? '<section class="results-placeholder"><span>⌛</span><h2>Loading your history</h2><p>Fetching saved baskets and activity from your secure account.</p></section>' : `<section class="history-grid"><section class="surface history-panel"><header><div><p class="eyebrow">Saved favourites</p><h2>Saved baskets</h2></div><span class="history-count">${data.baskets.length}</span></header>${data.baskets.length ? `<div class="history-list">${data.baskets.map((basket) => `<article class="history-card"><div><span class="history-type">${basket.type === 'calculator' ? 'Calculator basket' : 'Optimizer basket'}</span><h3>${escapeHtml(basket.name)}</h3><p>${escapeHtml(basketSummary(basket))}</p><small>Saved ${escapeHtml(dateTime(basket.updatedAt || basket.createdAt))}</small></div><div class="history-actions"><button class="button small primary" data-open-basket="${escapeHtml(basket.id)}">Open</button><button class="button small subtle danger-outline" data-delete-basket="${escapeHtml(basket.id)}">Delete</button></div></article>`).join('')}</div>` : '<div class="empty-panel"><b>No saved baskets yet</b><p>Save a calculator basket or optimizer result to reopen it here.</p></div>'}</section><section class="surface history-panel"><header><div><p class="eyebrow">Recent account activity</p><h2>Optimizer & calculator</h2></div><span class="history-count">${data.activities.length}</span></header>${data.activities.length ? `<div class="history-list">${data.activities.map((activity, index) => `<article class="activity-row"><span class="activity-icon">${activity.type === 'calculator' ? '⌁' : '◎'}</span><div><b>${activity.type === 'calculator' ? 'Calculator activity' : 'Optimizer search'}</b><p>${escapeHtml(activitySummary(activity))}</p><small>${escapeHtml(dateTime(activity.at))}</small></div><button class="button small subtle" data-open-activity="${index}">Reuse</button></article>`).join('')}</div>` : '<div class="empty-panel"><b>No activity saved yet</b><p>Run an optimization or save a calculator basket to build your history.</p></div>'}</section></section>`}`;

  const load = async (force = false) => {
    if (local.loading) return;
    if (!force && local.data) return;
    local.loading = true; local.error = ''; renderHistory(container, app);
    try { local.data = await app.actions.getHistory(); } catch (error) { local.error = error.message || 'Could not load your history.'; } finally { local.loading = false; renderHistory(container, app); }
  };
  container.querySelector('#history-refresh').onclick = () => load(true);
  container.querySelectorAll('[data-open-basket]').forEach((button) => { button.onclick = () => { const basket = data.baskets.find((item) => item.id === button.dataset.openBasket); if (basket) app.actions.openSavedBasket(basket); }; });
  container.querySelectorAll('[data-delete-basket]').forEach((button) => { button.onclick = async () => { const basket = data.baskets.find((item) => item.id === button.dataset.deleteBasket); if (!basket || !confirm(`Delete saved basket “${basket.name}”?`)) return; button.disabled = true; try { await app.actions.removeBasket(basket.id); local.data.baskets = local.data.baskets.filter((item) => item.id !== basket.id); } catch (error) { local.error = error.message || 'Could not delete that basket.'; } renderHistory(container, app); }; });
  container.querySelectorAll('[data-open-activity]').forEach((button) => { button.onclick = () => { const activity = data.activities[Number(button.dataset.openActivity)]; if (activity) app.actions.openSavedBasket({ type: activity.type, data: activity.data }); }; });
  if (!local.data && !local.loading && !local.error) void load();
}
