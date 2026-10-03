import { escapeHtml, validateProduct } from '../validation.js';
import { formatMoney, fromPaise } from '../pricing.js';
import { parseCsv, productsToCsvRows, serialiseCsv } from '../csv.js';

const stateFor = (app) => (app.session.catalogue ||= { search: '', category: '', editing: null, message: '' });
const categories = (products) => [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const download = (name, text, type = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
};

function productForm(product = {}) {
  const p = product;
  return `<form class="product-form" id="product-form" novalidate>
    <div class="form-heading"><h2>${p.id ? 'Edit product' : 'Add product'}</h2><button type="button" class="icon-button" data-close-form aria-label="Close form">×</button></div>
    <div class="form-grid">
      <label>Name <input name="name" required maxlength="120" value="${escapeHtml(p.name || '')}" placeholder="e.g. Vitamin D" /></label>
      <label>Unit MRP (₹) <input name="mrp" required min="0" step="0.01" inputmode="decimal" value="${p.mrp === undefined ? '' : (fromPaise(p.mrp)).toFixed(2)}" /></label>
      <label>Unit VP <input name="vp" required min="0" step="0.01" inputmode="decimal" value="${escapeHtml(p.vp ?? '')}" /></label>
      <label>Category <input name="category" maxlength="60" value="${escapeHtml(p.category || '')}" /></label>
      <label>SKU <input name="sku" maxlength="60" value="${escapeHtml(p.sku || '')}" /></label>
      <label>Min qty <input name="min" min="0" step="1" inputmode="numeric" value="${p.min ?? ''}" placeholder="Optional" /></label>
      <label>Max qty <input name="max" min="0" step="1" inputmode="numeric" value="${p.max ?? ''}" placeholder="Optional" /></label>
      <label class="check-label"><input name="active" type="checkbox" ${p.active !== false ? 'checked' : ''}/> Active in optimizer</label>
    </div>
    <p class="form-error" role="alert"></p>
    <div class="form-actions"><button type="button" class="button subtle" data-close-form>Cancel</button><button class="button primary">Save product</button></div>
  </form>`;
}

export function renderProducts(container, app) {
  const local = stateFor(app);
  const products = app.products;
  const needle = local.search.trim().toLowerCase();
  const filtered = products.filter((product) => (!needle || [product.name, product.sku, product.category].join(' ').toLowerCase().includes(needle)) && (!local.category || product.category === local.category));
  container.innerHTML = `<section class="view-heading"><div><p class="eyebrow">Your product data</p><h1>Catalogue</h1><p>Store unit MRP and VP once. GST is applied only when a basket is priced.</p></div><div class="heading-actions"><button class="button subtle" id="catalogue-export">⇩ Export CSV</button><label class="button subtle upload">⇧ Import CSV<input id="catalogue-import" type="file" accept=".csv,text/csv" hidden /></label><button class="button primary" id="catalogue-add">＋ Add product</button></div></section>
  ${local.message ? `<p class="notice" role="status">${escapeHtml(local.message)}</p>` : ''}
  <section class="surface filter-bar"><label>Search<input id="catalogue-search" value="${escapeHtml(local.search)}" placeholder="Name, SKU or category" /></label><label>Category<select id="catalogue-category"><option value="">All categories</option>${categories(products).map((category) => `<option ${category === local.category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select></label><span class="muted count">${filtered.length} of ${products.length} products</span></section>
  ${local.editing !== null ? `<section class="surface form-surface">${productForm(local.editing || {})}</section>` : ''}
  <section class="surface table-surface"><div class="table-wrap"><table class="catalogue-table"><thead><tr><th>Product</th><th>Category</th><th class="num">Unit MRP</th><th class="num">Unit VP</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${filtered.length ? filtered.map((product) => `<tr data-product-id="${escapeHtml(product.id)}"><td><strong>${escapeHtml(product.name)}</strong>${product.sku ? `<small>${escapeHtml(product.sku)}</small>` : ''}</td><td>${escapeHtml(product.category || '—')}</td><td class="num">${formatMoney(product.mrp)}</td><td class="num">${escapeHtml(product.vp)}</td><td><button class="status-toggle ${product.active !== false ? 'active' : ''}" data-toggle="${escapeHtml(product.id)}">${product.active !== false ? 'Active' : 'Inactive'}</button></td><td class="row-actions"><button class="link-button" data-edit="${escapeHtml(product.id)}">Edit</button><button class="link-button danger" data-delete="${escapeHtml(product.id)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">No products match this view. Add one or import a CSV.</td></tr>'}</tbody></table></div></section>`;

  const saveLocal = () => { app.persist(); };
  container.querySelector('#catalogue-search').addEventListener('input', (event) => { local.search = event.target.value; saveLocal(); renderProducts(container, app); });
  container.querySelector('#catalogue-category').addEventListener('change', (event) => { local.category = event.target.value; saveLocal(); renderProducts(container, app); });
  container.querySelector('#catalogue-add').onclick = () => { local.editing = {}; renderProducts(container, app); };
  container.querySelector('#catalogue-export').onclick = () => download('vp-optimizer-catalogue.csv', serialiseCsv(productsToCsvRows(products)));
  container.querySelector('#catalogue-import').onchange = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    let valid = []; let rejected = 0;
    try {
      for (const row of parseCsv(await file.text())) {
        const checked = validateProduct(row);
        if (checked.ok) valid.push({ ...checked.value, id: row.id || undefined }); else rejected += 1;
      }
      const added = await app.actions.saveMany(valid);
      local.message = `Imported ${added.length} product${added.length === 1 ? '' : 's'}${rejected ? `; skipped ${rejected} invalid row${rejected === 1 ? '' : 's'}` : ''}. Duplicates were not added.`;
    } catch (_) { local.message = 'That CSV could not be read.'; }
    saveLocal(); renderProducts(container, app);
  };
  container.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => { local.editing = app.products.find((p) => p.id === button.dataset.edit) || null; renderProducts(container, app); }; });
  container.querySelectorAll('[data-toggle]').forEach((button) => { button.onclick = async () => { const product = app.products.find((p) => p.id === button.dataset.toggle); if (!product) return; button.disabled = true; try { await app.actions.saveProduct({ ...product, active: product.active === false }); local.message = 'Product status updated.'; } catch (error) { local.message = error.message || 'Could not update product status.'; } renderProducts(container, app); }; });
  container.querySelectorAll('[data-delete]').forEach((button) => { button.onclick = async () => { const product = app.products.find((p) => p.id === button.dataset.delete); if (!product || !confirm(`Delete “${product.name}”?`)) return; button.disabled = true; try { await app.actions.removeProduct(product.id); local.message = 'Product deleted.'; } catch (error) { local.message = error.message || 'Could not delete product.'; } renderProducts(container, app); }; });
  container.querySelectorAll('[data-close-form]').forEach((button) => { button.onclick = () => { local.editing = null; renderProducts(container, app); }; });
  const form = container.querySelector('#product-form');
  if (form) form.onsubmit = async (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.active = form.elements.active.checked;
    if (local.editing?.id) data.id = local.editing.id;
    const checked = validateProduct(data);
    if (!checked.ok) { form.querySelector('.form-error').textContent = Object.values(checked.errors).join(' '); return; }
    const submit = form.querySelector('button[type="submit"], .primary'); submit.disabled = true;
    try { await app.actions.saveProduct(checked.value); local.editing = null; local.message = 'Product saved.'; saveLocal(); renderProducts(container, app); }
    catch (error) { submit.disabled = false; form.querySelector('.form-error').textContent = error.message || 'Could not save this product.'; }
  };
}
