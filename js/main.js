import { createRepository } from './repository.js';
import { run } from './engine.js';
import { renderProducts } from './ui/products.js';
import { renderOptimize } from './ui/optimize.js?v=segmented-ux-20261002';
import { renderCalculator } from './ui/calculator.js';

// The browser now talks only to the HTTP repository. The Express server serves
// both this app and /api/products, so a relative URL works in local and hosted use.
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
    } catch (error) {
      // The catalogue remains in memory for this screen; explain a later save failure.
      console.warn('Could not save app preferences.', error);
    }
  },
  actions: {
    async saveProduct(product) {
      const saved = await repo.save(product);
      app.products = await repo.getAll();
      return saved;
    },
    async saveMany(products) {
      const saved = await repo.saveMany(products);
      app.products = await repo.getAll();
      return saved;
    },
    async removeProduct(id) {
      await repo.remove(id);
      app.products = await repo.getAll();
      return true;
    },
    runOptimize(payload) { return run(payload); },
    go(view) { go(view); },
  },
};

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
  document.querySelectorAll('[data-view]').forEach((button) => { button.disabled = true; });
  appShell.innerHTML = `<section class="connection-error"><span>!</span><div><p class="eyebrow">Database connection needed</p><h1>VP Optimizer cannot reach its backend.</h1><p>Start MongoDB, then run <code>npm start</code> from this project folder. The app expects the API at this same address.</p><details><summary>Technical detail</summary><pre>${String(error?.message || error)}</pre></details></div></section>`;
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
    const { products, prefs } = await migrateAndSeed();
    app.products = products;
    app.session = sessionFrom(prefs);
    setTheme(prefs.theme || document.documentElement.dataset.theme || defaultTheme);
    render();
  } catch (error) {
    console.error(error);
    showConnectionError(error);
  }
}

document.querySelectorAll('[data-view]').forEach((button) => { button.addEventListener('click', () => go(button.dataset.view)); });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); go('catalogue'); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (renderers[view] && view !== app.session.view) { app.session.view = view; render(); } });
document.querySelector('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
boot();
