import { createRepository } from './repository.js';
import { run } from './engine.js';
import { renderProducts } from './ui/products.js?v=runtime-safety-v2-20261004';
import { renderOptimize } from './ui/optimize.js?v=runtime-safety-v2-20261004';
import { renderCalculator } from './ui/calculator.js?v=runtime-safety-v2-20261004';
import { renderHistory } from './ui/history.js?v=runtime-safety-v2-20261004';
import { renderAdmin } from './ui/admin.js?v=runtime-safety-v2-20261004';

const repo = createRepository('http', { baseUrl: '/api/products' });
const legacyRepo = createRepository('localStorage');
const ANALYTICS_CONSENT_KEY = 'vp-optimizer-analytics-consent';
const VISITOR_KEY = 'vp-optimizer-visitor-id';
const sampleCatalogue = [
  { id: 'sample-a', name: 'A — Wellness Starter', mrp: 300000, vp: 50, category: 'Wellness', sku: 'A-050', max: 4, active: true },
  { id: 'sample-b', name: 'B — Daily Essentials', mrp: 300000, vp: 100, category: 'Wellness', sku: 'B-100', max: 5, active: true },
  { id: 'sample-c', name: 'C — Balance Pack', mrp: 450000, vp: 150, category: 'Wellness', sku: 'C-150', max: 4, active: true },
  { id: 'sample-d', name: 'D — Premium Bundle', mrp: 500000, vp: 200, category: 'Wellness', sku: 'D-200', max: 5, active: true },
];
const defaultTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const validViews = ['catalogue', 'optimize', 'calculator', 'history', 'admin'];
const renderers = { catalogue: renderProducts, optimize: renderOptimize, calculator: renderCalculator, history: renderHistory, admin: renderAdmin };
const appShell = document.querySelector('.app-shell');
let googleEnabled = false;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
  return response.status === 204 ? null : response.json();
}

const app = {
  products: [], auth: null,
  session: { view: 'catalogue', catalogue: undefined, optimize: undefined, calculator: undefined, history: undefined, admin: undefined },
  async persist() {
    // Optimizer result cards are derived runtime data. Persisting their nested
    // lines creates stale/partial results after a backend round-trip.
    const session = {
      ...this.session,
      optimize: this.session.optimize ? { ...this.session.optimize, result: null } : undefined,
      history: this.session.history ? { ...this.session.history, data: null, loading: false, error: '' } : undefined,
      admin: this.session.admin ? { ...this.session.admin, data: null, loading: false, error: '' } : undefined,
    };
    try { await repo.setPrefs({ session, theme: document.documentElement.dataset.theme || defaultTheme }); } catch (error) { console.warn('Could not save app preferences.', error); }
  },
  actions: {
    async saveProduct(product) { const saved = await repo.save(product); app.products = await repo.getAll(); return saved; },
    async saveMany(products) { const saved = await repo.saveMany(products); app.products = await repo.getAll(); return saved; },
    async removeProduct(id) { await repo.remove(id); app.products = await repo.getAll(); return true; },
    runOptimize(payload) { return run(payload); },
    go(view) { go(view); },
    async recordActivity(type, data) { try { await api('/api/activity', { method: 'POST', body: JSON.stringify({ type, data }) }); } catch (error) { console.warn('Could not save activity.', error); } },
    async saveBasket(basket) { return api('/api/me/baskets', { method: 'POST', body: JSON.stringify(basket) }); },
    async getHistory() { const [activities, baskets] = await Promise.all([api('/api/me/activities'), api('/api/me/baskets')]); return { activities, baskets }; },
    async removeBasket(id) { await api(`/api/me/baskets/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async getTrafficSummary() { return api('/api/admin/traffic-summary'); },
    async getAdminDashboard() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try { return await api('/api/admin/dashboard', { signal: controller.signal }); }
      catch (error) { throw error.name === 'AbortError' ? new Error('The dashboard request timed out. Restart the backend and try again.') : error; }
      finally { clearTimeout(timeout); }
    },
    async setUserActive(id, active) { return api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active }) }); },
    openSavedBasket(saved) {
      if (saved.type === 'calculator') {
        const calculator = app.session.calculator ||= {}; calculator.quantities = Object.fromEntries((saved.data?.lines || []).map((line) => [line.productId, line.quantity])); calculator.discount = saved.data?.discount ?? 0; calculator.gst = saved.data?.gst ?? 18; go('calculator');
      } else {
        const optimize = app.session.optimize ||= {}; optimize.inputs = { ...(optimize.inputs || {}), ...(saved.data?.inputs || {}) }; optimize.selection = Object.fromEntries((saved.data?.selection || []).map((line) => [line.productId, { mode: line.mode || 'allowed', minQty: line.minQty || 0 }])); go('optimize');
      }
    },
  },
};

function isAdmin() { return app.auth?.role === 'admin'; }
function setAppControls(enabled) {
  document.querySelectorAll('[data-view], #theme-toggle, #logout-button').forEach((element) => { element.disabled = !enabled; });
  const account = document.querySelector('#account-indicator'); account.hidden = !enabled; account.textContent = enabled ? (isAdmin() ? 'Administrator' : app.auth?.displayName || app.auth?.email || 'User') : '';
  document.querySelector('#logout-button').hidden = !enabled;
  const adminNav = document.querySelector('[data-admin-nav]'); if (adminNav) adminNav.hidden = !enabled || !isAdmin();
}
function sessionFrom(prefs = {}) {
  const saved = prefs.session && typeof prefs.session === 'object' ? prefs.session : {}; const hashView = location.hash.slice(1);
  const candidate = validViews.includes(saved.view) ? saved.view : (validViews.includes(hashView) ? hashView : 'catalogue');
  const optimize = saved.optimize && typeof saved.optimize === 'object' ? { ...saved.optimize, result: null } : undefined;
  const history = saved.history && typeof saved.history === 'object' ? { ...saved.history, data: null, loading: false, error: '' } : undefined;
  const admin = saved.admin && typeof saved.admin === 'object' ? { ...saved.admin, data: null, loading: false, error: '' } : undefined;
  return { view: candidate === 'admin' && !isAdmin() ? 'catalogue' : candidate, catalogue: saved.catalogue || undefined, optimize, calculator: saved.calculator || undefined, history, admin };
}
function showLoading() { document.querySelectorAll('.app-view').forEach((view) => { view.hidden = view.id !== 'catalogue-view'; }); document.querySelector('#catalogue-view').innerHTML = '<section class="app-loading"><span class="loading-mark">VP</span><h1>Connecting to your catalogue</h1><p>Loading the secure product store…</p></section>'; }
function showConnectionError(error) {
  setAppControls(false);
  appShell.innerHTML = `<section class="connection-error"><span>!</span><div><p class="eyebrow">Startup needs attention</p><h1>VP Optimizer could not finish starting.</h1><p>This can happen when the backend is unavailable or an older saved browser session no longer matches the latest app version.</p><div class="startup-error-actions"><button class="button subtle" id="reset-browser-session">Reset browser session</button><button class="button primary" id="retry-startup">Retry</button></div><details><summary>Technical detail</summary><pre>${String(error?.message || error)}</pre></details></div></section>`;
  document.querySelector('#reset-browser-session').onclick = () => { try { localStorage.removeItem('vp-optimizer-prefs-v1'); localStorage.removeItem('vp-optimizer-analytics-consent'); } catch (_) { /* storage may be blocked */ } location.replace('/'); };
  document.querySelector('#retry-startup').onclick = () => boot();
}
function authOverlay() { let overlay = document.querySelector('#auth-overlay'); if (!overlay) { overlay = document.createElement('section'); overlay.id = 'auth-overlay'; overlay.className = 'auth-overlay'; overlay.setAttribute('aria-live', 'polite'); document.body.appendChild(overlay); } return overlay; }
function authMessageFromUrl() {
  const code = new URLSearchParams(location.search).get('auth'); if (!code) return '';
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  return ({ 'google-not-configured': 'Google Sign-In has not been configured yet.', 'google-cancelled': 'Google Sign-In was cancelled.', 'google-state-error': 'Google Sign-In expired. Please try again.', 'google-success': 'Google Sign-In completed but this browser did not keep the session. Check your local cookie settings and try again.', 'google-error': 'Google Sign-In could not be completed. Please try again.', 'account-disabled': 'This account has been disabled.' }[code] || 'Google Sign-In could not be completed.');
}
function showLogin(message = '') {
  setAppControls(false); document.body.classList.add('auth-locked'); const overlay = authOverlay(); overlay.hidden = false;
  overlay.innerHTML = `<div class="login-card"><span class="login-mark">VP</span><p class="eyebrow">VP Optimizer workspace</p><h1>Welcome</h1><p class="auth-subtitle">Use your account to optimize, calculate, save baskets, and view your personal history.</p><p class="auth-admin-hint"><span>⌁</span><span><b>Administrator?</b> Choose the <strong>Admin</strong> tab to manage the shared catalogue and user dashboard.</span></p><div class="auth-tabs" role="tablist"><button type="button" data-auth-tab="signin" class="active" role="tab" aria-selected="true">Sign in</button><button type="button" data-auth-tab="register" role="tab" aria-selected="false">Create account</button><button type="button" data-auth-tab="admin" role="tab" aria-selected="false">Admin</button></div><form id="signin-form" class="auth-form" novalidate>${googleEnabled ? '<a class="google-signin" href="/api/auth/google"><span>G</span> Continue with Google</a><div class="auth-divider"><span>or use email</span></div>' : ''}<label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Password<input name="password" type="password" autocomplete="current-password" required /></label><button class="button primary large" type="submit">Sign in</button></form><form id="register-form" class="auth-form" hidden novalidate>${googleEnabled ? '<a class="google-signin" href="/api/auth/google"><span>G</span> Continue with Google</a><div class="auth-divider"><span>or create with email</span></div>' : ''}<label>Name <small>Optional</small><input name="displayName" maxlength="80" autocomplete="name" /></label><label>Email<input name="email" type="email" autocomplete="email" required /></label><label>Create password <small>At least 10 characters</small><input name="password" type="password" autocomplete="new-password" required /></label><label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" required /></label><label class="consent-choice"><input name="analyticsConsent" type="checkbox" /> Allow anonymous usage analytics to help improve VP Optimizer</label><button class="button primary large" type="submit">Create account</button></form><form id="admin-form" class="auth-form" hidden novalidate><div class="admin-login-note"><b>Administrator sign-in</b>Enter the private password configured as <code>ADMIN_PASSWORD</code>. No email is needed.</div><label>Administrator password<input name="password" type="password" autocomplete="current-password" required /></label><button class="button primary large" type="submit">Open administrator workspace</button></form><p class="form-error" id="login-error" role="alert"></p><small class="login-note">Google never shares your Google password with VP Optimizer. Email passwords are verified by the server and never stored in browser storage.</small></div>`;
  const error = overlay.querySelector('#login-error'); error.textContent = message;
  const selectTab = (name) => { overlay.querySelectorAll('[data-auth-tab]').forEach((button) => { const active = button.dataset.authTab === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); overlay.querySelectorAll('.auth-form').forEach((form) => { form.hidden = form.id !== `${name}-form`; }); error.textContent = ''; setTimeout(() => overlay.querySelector(`#${name}-form input`)?.focus(), 0); };
  overlay.querySelectorAll('[data-auth-tab]').forEach((button) => { button.onclick = () => selectTab(button.dataset.authTab); });
  const submitAuth = async (form, endpoint, payload) => {
    const button = form.querySelector('button'); const label = button.textContent; button.disabled = true; button.textContent = 'Please wait…'; error.textContent = '';
    try { const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const responseData = await response.json().catch(() => ({})); if (!response.ok) throw new Error(responseData.error || 'Could not sign in.'); if (payload.analyticsConsent) { try { localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted'); } catch (_) { /* optional */ } } await boot(); } catch (loginError) { button.disabled = false; button.textContent = label; error.textContent = loginError.message || 'Could not sign in.'; form.querySelector('input')?.focus(); }
  };
  overlay.querySelector('#signin-form').onsubmit = (event) => { event.preventDefault(); const form = event.currentTarget; submitAuth(form, '/api/auth/login', Object.fromEntries(new FormData(form))); };
  overlay.querySelector('#register-form').onsubmit = (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); if (data.password !== data.confirmPassword) { error.textContent = 'The two passwords do not match.'; return; } submitAuth(form, '/api/auth/register', { email: data.email, password: data.password, displayName: data.displayName, analyticsConsent: form.elements.analyticsConsent.checked }); };
  overlay.querySelector('#admin-form').onsubmit = (event) => { event.preventDefault(); const form = event.currentTarget; submitAuth(form, '/api/auth/admin-login', { password: form.elements.password.value }); };
  setTimeout(() => overlay.querySelector('#signin-form input')?.focus(), 0);
}
function hideLogin() { const overlay = document.querySelector('#auth-overlay'); if (overlay) overlay.hidden = true; document.body.classList.remove('auth-locked'); }
async function authenticated() { const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' }); if (response.status === 401) return null; if (!response.ok) throw new Error('Could not verify the current session.'); return response.json(); }
async function loadHealth() { const health = await api('/api/health'); googleEnabled = Boolean(health.googleSignIn); }
function visitorId() { try { let value = localStorage.getItem(VISITOR_KEY); if (!value) { value = globalThis.crypto?.randomUUID?.() || `v-${Date.now()}-${Math.random().toString(36).slice(2)}`; localStorage.setItem(VISITOR_KEY, value); } return value; } catch (_) { return null; } }
function analyticsAllowed() { try { return localStorage.getItem(ANALYTICS_CONSENT_KEY) === 'granted'; } catch (_) { return false; } }
function setAnalyticsConsent(consent) { try { localStorage.setItem(ANALYTICS_CONSENT_KEY, consent ? 'granted' : 'denied'); } catch (_) { /* optional */ } if (app.auth?.role === 'user') void api('/api/me/analytics-consent', { method: 'PATCH', body: JSON.stringify({ consent }) }).catch(() => {}); }
function track(type, details = {}) { if (!analyticsAllowed()) return; void fetch('/api/telemetry', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, visitorId: visitorId(), path: location.pathname, view: app.session.view, ...details }) }).catch(() => {}); }
function analyticsNotice() {
  try { if (app.auth?.analyticsConsent && !localStorage.getItem(ANALYTICS_CONSENT_KEY)) localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted'); } catch (_) { /* optional */ }
  if (analyticsAllowed()) { track('page_view'); return; }
  try { if (localStorage.getItem(ANALYTICS_CONSENT_KEY) === 'denied') return; } catch (_) { return; }
  let notice = document.querySelector('#analytics-notice'); if (notice) return;
  notice = document.createElement('aside'); notice.id = 'analytics-notice'; notice.className = 'analytics-notice'; notice.innerHTML = '<p><b>Help improve VP Optimizer?</b> With your permission, we store anonymous page/feature usage. Your saved baskets and activity stay tied to your signed-in account.</p><div><button class="button small primary" data-analytics="yes">Allow analytics</button><button class="button small subtle" data-analytics="no">No thanks</button></div>';
  document.body.appendChild(notice); notice.querySelectorAll('[data-analytics]').forEach((button) => { button.onclick = () => { const consent = button.dataset.analytics === 'yes'; setAnalyticsConsent(consent); if (consent) track('page_view'); notice.remove(); }; });
}
function render() { const current = app.session.view; for (const [name, renderer] of Object.entries(renderers)) { const view = document.querySelector(`#${name}-view`); const active = name === current; view.hidden = !active; if (active) renderer(view, app); } document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === current)); }
function go(view) { if (!renderers[view] || (view === 'admin' && !isAdmin())) return; app.session.view = view; void app.persist(); history.replaceState(null, '', `#${view}`); render(); track('view_change', { view }); }
function setTheme(theme) { document.documentElement.dataset.theme = theme; document.querySelector('#theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`); void app.persist(); }
async function migrateAndSeed() {
  let remoteProducts = await repo.getAll(); let remotePrefs = await repo.getPrefs();
  // A malformed/legacy API response should never break the UI renderer.
  if (!Array.isArray(remoteProducts)) remoteProducts = [];
  if (!remotePrefs || typeof remotePrefs !== 'object' || Array.isArray(remotePrefs)) remotePrefs = {};
  if (!remotePrefs.migratedLocalStorage) { const localProducts = legacyRepo.getAll(); const localPrefs = legacyRepo.getPrefs(); if (!remoteProducts.length && localProducts.length && isAdmin()) await repo.saveMany(localProducts); remotePrefs = await repo.setPrefs({ ...localPrefs, ...remotePrefs, migratedLocalStorage: true }); remoteProducts = await repo.getAll(); if (!Array.isArray(remoteProducts)) remoteProducts = []; }
  if (!remoteProducts.length && !remotePrefs.seeded && isAdmin()) { await repo.saveMany(sampleCatalogue); remotePrefs = await repo.setPrefs({ seeded: true }); remoteProducts = await repo.getAll(); if (!Array.isArray(remoteProducts)) remoteProducts = []; }
  return { products: Array.isArray(remoteProducts) ? remoteProducts : [], prefs: remotePrefs || {} };
}
async function boot() {
  showLoading();
  try { await loadHealth(); const auth = await authenticated(); if (!auth) { showLogin(authMessageFromUrl()); return; } app.auth = auth; googleEnabled = Boolean(auth.googleSignIn); const { products, prefs } = await migrateAndSeed(); app.products = Array.isArray(products) ? products : []; app.session = sessionFrom(prefs || {}); hideLogin(); setTheme(prefs.theme || document.documentElement.dataset.theme || defaultTheme); setAppControls(true); render(); analyticsNotice(); } catch (error) { console.error(error); hideLogin(); showConnectionError(error); }
}
async function logout() { try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* clear visible app even if network failed */ } app.products = []; app.auth = null; document.querySelector('#analytics-notice')?.remove(); showLogin('You have been signed out.'); }

document.querySelectorAll('[data-view]').forEach((button) => { button.addEventListener('click', () => go(button.dataset.view)); });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); go('catalogue'); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (renderers[view] && view !== app.session.view && !(view === 'admin' && !isAdmin())) { app.session.view = view; render(); } });
document.querySelector('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
document.querySelector('#logout-button').addEventListener('click', logout);
setAppControls(false); boot();
