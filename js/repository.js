/* The only module that touches localStorage. Every storage operation is guarded. */

const PRODUCTS_KEY = 'vp-optimizer-products-v1';
const PREFS_KEY = 'vp-optimizer-prefs-v1';

const clone = (value) => JSON.parse(JSON.stringify(value));
const memory = { products: [], prefs: {} };

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
function safelyRead(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}
function safelyWrite(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) { return false; }
}
function sameCatalogIdentity(a, b) {
  return String(a.name || '').trim().toLowerCase() === String(b.name || '').trim().toLowerCase()
    && String(a.sku || '').trim().toLowerCase() === String(b.sku || '').trim().toLowerCase()
    && Number(a.mrp) === Number(b.mrp) && Number(a.vp) === Number(b.vp);
}

export function createLocalStorageRepository({ productsKey = PRODUCTS_KEY, prefsKey = PREFS_KEY } = {}) {
  let products = safelyRead(productsKey, memory.products);
  if (!Array.isArray(products)) products = memory.products;
  let prefs = safelyRead(prefsKey, memory.prefs);
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = memory.prefs;

  function persistProducts() {
    memory.products = clone(products);
    safelyWrite(productsKey, products);
  }
  function persistPrefs() {
    memory.prefs = clone(prefs);
    safelyWrite(prefsKey, prefs);
  }
  function normalise(product) {
    const cleaned = { ...product };
    cleaned.id = cleaned.id || makeId();
    cleaned.name = String(cleaned.name || '').trim();
    cleaned.mrp = Math.round(Number(cleaned.mrp) || 0);
    cleaned.vp = Math.round((Number(cleaned.vp) || 0) * 100) / 100;
    cleaned.category = String(cleaned.category || '').trim();
    cleaned.sku = String(cleaned.sku || '').trim();
    cleaned.active = cleaned.active !== false;
    if (cleaned.min !== undefined && cleaned.min !== '') cleaned.min = Math.max(0, Math.trunc(Number(cleaned.min) || 0));
    else delete cleaned.min;
    if (cleaned.max !== undefined && cleaned.max !== '') cleaned.max = Math.max(0, Math.trunc(Number(cleaned.max) || 0));
    else delete cleaned.max;
    return cleaned;
  }

  return {
    getAll() { return clone(products); },
    get(id) { const found = products.find((product) => String(product.id) === String(id)); return found ? clone(found) : null; },
    save(product) {
      const next = normalise(product || {});
      const at = products.findIndex((row) => String(row.id) === String(next.id));
      if (at >= 0) products[at] = next;
      else products.push(next);
      persistProducts();
      return clone(next);
    },
    saveMany(rows = []) {
      const added = [];
      for (const row of rows) {
        const next = normalise(row || {});
        if (!products.some((existing) => sameCatalogIdentity(existing, next))) {
          products.push(next);
          added.push(clone(next));
        }
      }
      if (added.length) persistProducts();
      return added;
    },
    remove(id) {
      const before = products.length;
      products = products.filter((product) => String(product.id) !== String(id));
      if (products.length !== before) persistProducts();
      return products.length !== before;
    },
    clear() { products = []; persistProducts(); },
    getPrefs() { return clone(prefs); },
    setPrefs(partial = {}) {
      prefs = { ...prefs, ...clone(partial) };
      persistPrefs();
      return clone(prefs);
    },
  };
}

/**
 * Async HTTP repository used by the app. It deliberately mirrors the local
 * repository interface, so UI modules stay unaware of where data is stored.
 */
export function createHttpRepository({ baseUrl = '/api/products' } = {}) {
  const request = async (path = '', options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json())?.error || ''; } catch (_) { /* response had no JSON body */ }
      throw new Error(detail || `Repository request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  };
  return {
    getAll: () => request(), get: (id) => request(`/${encodeURIComponent(id)}`),
    save: (product) => request(product.id ? `/${encodeURIComponent(product.id)}` : '', { method: product.id ? 'PUT' : 'POST', body: JSON.stringify(product) }),
    saveMany: (products) => request('/bulk', { method: 'POST', body: JSON.stringify(products) }),
    remove: (id) => request(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clear: () => request('', { method: 'DELETE' }),
    getPrefs: () => request('/prefs'), setPrefs: (prefs) => request('/prefs', { method: 'PATCH', body: JSON.stringify(prefs) }),
  };
}

export function createRepository(kind = 'localStorage', options = {}) {
  return kind === 'http' ? createHttpRepository(options) : createLocalStorageRepository(options);
}
