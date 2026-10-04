import { createRepository } from './repository.js';
import { run } from './engine.js';
import { renderProducts } from './ui/products.js';
import { renderOptimize } from './ui/optimize.js?v=segmented-ux-20261002';
import { renderCalculator } from './ui/calculator.js';

const repo = createRepository('http', { baseUrl: '/api/products' });
const legacyRepo = createRepository('localStorage'); // one-time migration only
const sampleCatalogue = [
  { id: 'sample-a', name: 'A — Wellness Starter', mrp: 300000, vp: 50, category: 'Wellness', sku: 'A-050', max: 4, active: true },
  { id: 'sample-b', name: 'B — Daily Essentials', mrp: 300000, vp: 100, category: 'Wellness', sku: 'B-100', max: 5, active: true },
  { id: 'sample-c', name: 'C — Balance Pack', mrp: 450000, vp: 150, category: 'Wellness', sku: 'C-150', max: 4, active: true },
  { id: 'sample-d', name: 'D — Premium Bundle', mrp: 500000, vp: 200, category: 'Wellness', sku: 'D-200', max: 5, active: true },
];
const defaultTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const validViews = ['catalogue', 'optimize', 'calculator'];
const renderers = { catalogue: renderProducts, optimize: renderOptimize, calculator: renderCalculator };
const appShell = document.querySelector('.app-shell');

const app = {
  products: [],
  session: { view: 'catalogue', catalogue: undefined, optimize: undefined, calculator: undefined },
  async persist() {
    try {
      await repo.setPrefs({ session: this.session, theme: document.documentElement.dataset.theme || defaultTheme });
    } catch (error) { console.warn('Could not save app preferences.', error); }
  },
  actions: {
    async saveProduct(product) { const saved = await repo.save(product); app.products = await repo.getAll(); return saved; },
    async saveMany(products) { const saved = await repo.saveMany(products); app.products = await repo.getAll(); return saved; },
    async removeProduct(id) { await repo.remove(id); app.products = await repo.getAll(); return true; },
    runOptimize(payload) { return run(payload); },
    go(view) { go(view); },
  },
};

function setAppControls(enabled) {
  document.querySelectorAll('[data-view], #theme-toggle, #logout-button').forEach((element) => { element.disabled = !enabled; });
  document.querySelector('#logout-button').hidden = !enabled;
}
function sessionFrom(prefs = {}) {
  const saved = prefs.session && typeof prefs.session === 'object' ? prefs.session : {};
  const hashView = location.hash.slice(1);
  return {
    view: validViews.includes(saved.view) ? saved.view : (validViews.includes(hashView) ? hashView : 'catalogue'),
    catalogue: saved.catalogue || undefined,
    optimize: saved.optimize || undefined,
    calculator: saved.calculator || undefined,
  };
}
function showLoading() {
  document.querySelectorAll('.app-view').forEach((view) => { view.hidden = view.id !== 'catalogue-view'; });
  document.querySelector('#catalogue-view').innerHTML = '<section class="app-loading"><span class="loading-mark">VP</span><h1>Connecting to your catalogue</h1><p>Loading the secure product store…</p></section>';
}
function showConnectionError(error) {
  setAppControls(false);
  appShell.innerHTML = `<section class="connection-error"><span>!</span><div><p class="eyebrow">Database connection needed</p><h1>VP Optimizer cannot reach its backend.</h1><p>Check MongoDB and the server environment variables, then reload this page.</p><details><summary>Technical detail</summary><pre>${String(error?.message || error)}</pre></details></div></section>`;
}
function authOverlay() {
  let overlay = document.querySelector('#auth-overlay');
  if (!overlay) {
    overlay = document.createElement('section');
    overlay.id = 'auth-overlay';
    overlay.className = 'auth-overlay';
    overlay.setAttribute('aria-live', 'polite');
    document.body.appendChild(overlay);
  }
  return overlay;
}
function showLogin(message = '') {
  setAppControls(false);
  document.body.classList.add('auth-locked');
  const overlay = authOverlay();
  overlay.hidden = false;
  overlay.innerHTML = `<form class="login-card" id="login-form" novalidate><span class="login-mark">VP</span><p class="eyebrow">Administrator access</p><h1>Sign in to VP Optimizer</h1><p>Enter the administrator password to access the catalogue, calculator, and optimization tools.</p><label>Admin password<input id="admin-password" name="password" type="password" autocomplete="current-password" required autofocus /></label><p class="form-error" id="login-error" role="alert"></p><button class="button primary large" type="submit">Sign in securely</button><small>Your password is verified by the server and is never stored in the browser.</small></form>`;
  const error = overlay.querySelector('#login-error');
  error.textContent = message;
  const form = overlay.querySelector('#login-form');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const password = form.elements.password.value;
    const button = form.querySelector('button');
    if (!password) { error.textContent = 'Enter the administrator password.'; return; }
    button.disabled = true; button.textContent = 'Signing in…'; error.textContent = '';
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not sign in.');
      await boot();
    } catch (loginError) {
      button.disabled = false; button.textContent = 'Sign in securely'; error.textContent = loginError.message || 'Could not sign in.';
      form.elements.password.select();
    }
  };
  setTimeout(() => overlay.querySelector('#admin-password')?.focus(), 0);
}
function hideLogin() {
  const overlay = document.querySelector('#auth-overlay');
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('auth-locked');
}
async function authenticated() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error('Could not verify the administrator session.');
  return Boolean((await response.json()).authenticated);
}
function render() {
  const current = app.session.view;
  for (const [name, renderer] of Object.entries(renderers)) {
    const view = document.querySelector(`#${name}-view`);
    const active = name === current;
    view.hidden = !active;
    if (active) renderer(view, app);
  }
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === current));
}
function go(view) {
  if (!renderers[view]) return;
  app.session.view = view;
  void app.persist();
  history.replaceState(null, '', `#${view}`);
  render();
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('#theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  void app.persist();
}
async function migrateAndSeed() {
  let remoteProducts = await repo.getAll();
  let remotePrefs = await repo.getPrefs();
  if (!remotePrefs.migratedLocalStorage) {
    const localProducts = legacyRepo.getAll();
    const localPrefs = legacyRepo.getPrefs();
    if (!remoteProducts.length && localProducts.length) await repo.saveMany(localProducts);
    remotePrefs = await repo.setPrefs({ ...localPrefs, ...remotePrefs, migratedLocalStorage: true });
    remoteProducts = await repo.getAll();
  }
  if (!remoteProducts.length && !remotePrefs.seeded) {
    await repo.saveMany(sampleCatalogue);
    remotePrefs = await repo.setPrefs({ seeded: true });
    remoteProducts = await repo.getAll();
  }
  return { products: remoteProducts, prefs: remotePrefs };
}
async function boot() {
  showLoading();
  try {
    if (!await authenticated()) { showLogin(); return; }
    const { products, prefs } = await migrateAndSeed();
    app.products = products;
    app.session = sessionFrom(prefs);
    hideLogin();
    setTheme(prefs.theme || document.documentElement.dataset.theme || defaultTheme);
    setAppControls(true);
    render();
  } catch (error) {
    console.error(error);
    hideLogin();
    showConnectionError(error);
  }
}
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* clear the local view either way */ }
  app.products = [];
  showLogin('You have been signed out.');
}

document.querySelectorAll('[data-view]').forEach((button) => { button.addEventListener('click', () => go(button.dataset.view)); });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); go('catalogue'); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (renderers[view] && view !== app.session.view) { app.session.view = view; render(); } });
document.querySelector('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
document.querySelector('#logout-button').addEventListener('click', logout);
setAppControls(false);
boot();
