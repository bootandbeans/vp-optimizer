import { escapeHtml, validateRates } from '../validation.js';
import { formatMoney, formatVp, priceBasket } from '../pricing.js';
import { printInvoice } from '../pdf.js';

const base = () => ({ search: '', category: '', quantities: {}, discount: 0, gst: 18 });
// Saved baskets may restore only quantities/rates. Fill every omitted UI field
// before rendering so opening history always works after a refresh.
const stateFor = (app) => {
  const local = app.session.calculator && typeof app.session.calculator === 'object' ? app.session.calculator : (app.session.calculator = {});
  const defaults = base();
  local.search ??= defaults.search;
  local.category ??= defaults.category;
  local.quantities = local.quantities && typeof local.quantities === 'object' ? local.quantities : {};
  local.discount ??= defaults.discount;
  local.gst ??= defaults.gst;
  return local;
};
const cats = (products) => [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function basketFor(app, local) {
  return priceBasket(app.products.filter((product) => Number(local.quantities[product.id]) > 0).map((product) => ({ product, quantity: Number(local.quantities[product.id]) })), { discount: local.discount, gst: local.gst });
}

export function renderCalculator(container, app) {
  const local = stateFor(app);
  const active = (Array.isArray(app.products) ? app.products : []).filter((product) => product.active !== false);
  const needle = local.search.trim().toLowerCase();
  const filtered = active.filter((product) => (!needle || [product.name, product.sku, product.category].join(' ').toLowerCase().includes(needle)) && (!local.category || product.category === local.category));
  const basket = basketFor(app, local);
  container.innerHTML = `<section class="view-heading"><div><p class="eyebrow">Your chosen basket</p><h1>Calculator</h1><p>Pick quantities yourself, then price the taxable total and GST exactly once.</p></div><div class="heading-actions"><button class="button subtle" id="calculator-pdf" ${basket.lines.length ? '' : 'disabled'}>⇩ Save as PDF</button><button class="button subtle" id="save-calculator-activity" ${basket.lines.length ? '' : 'disabled'}>◷ Save activity</button><button class="button subtle" id="save-calculator-basket" ${basket.lines.length ? '' : 'disabled'}>☆ Save basket</button><button class="button primary" id="send-to-optimizer" ${basket.totalVP === 0 ? 'disabled' : ''}>◎ Use total VP as optimizer target</button></div></section>
  <section class="surface calculator-controls"><div class="filter-bar compact"><label>Search<input id="calc-search" value="${escapeHtml(local.search)}" placeholder="Name, SKU or category" /></label><label>Category<select id="calc-category"><option value="">All categories</option>${cats(active).map((category) => `<option ${category === local.category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select></label><label>Discount %<input id="calc-discount" min="0" max="100" step="0.01" inputmode="decimal" value="${escapeHtml(local.discount)}" /></label><label>GST %<input id="calc-gst" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(local.gst)}" /></label></div><p class="form-error" id="calc-error" role="alert"></p></section>
  <section class="surface calculator-products"><div class="section-title"><div><h2>Products</h2><p>${filtered.length} available product${filtered.length === 1 ? '' : 's'}. Use the stepper to add quantities.</p></div></div><div class="calculator-list">${filtered.length ? filtered.map((product) => { const quantity = Math.max(0, Number(local.quantities[product.id]) || 0); const atMax = product.max !== undefined && product.max !== '' && quantity >= Number(product.max); return `<article class="calculator-row"><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category || 'Uncategorised')} · unit MRP ${formatMoney(product.mrp)} · ${formatVp(product.vp)} VP</small></div><div class="line-values"><span>${formatVp(product.vp * quantity)} VP</span><b>${formatMoney(product.mrp * quantity)}</b></div><div class="stepper"><button aria-label="Remove one ${escapeHtml(product.name)}" data-step="-1" data-id="${escapeHtml(product.id)}" ${quantity <= 0 ? 'disabled' : ''}>−</button><input aria-label="Quantity for ${escapeHtml(product.name)}" data-qty="${escapeHtml(product.id)}" type="number" min="0" step="1" value="${quantity}" /><button aria-label="Add one ${escapeHtml(product.name)}" data-step="1" data-id="${escapeHtml(product.id)}" ${atMax ? 'disabled' : ''}>＋</button></div></article>`; }).join('') : '<p class="empty">No active products match the filter.</p>'}</div></section>
  <section class="basket-summary"><div class="summary-copy"><p class="eyebrow">Basket total</p><h2>${basket.lines.length ? `${basket.lines.length} line${basket.lines.length === 1 ? '' : 's'} selected` : 'No products selected'}</h2><p>Discount is applied per product. GST is rounded on the grouped basket total.</p></div><div class="summary-tiles"><div><span>Total MRP</span><b>${formatMoney(basket.totalMrp)}</b></div><div><span>Total discount</span><b>−${formatMoney(basket.totalDiscount)}</b></div><div><span>Taxable total</span><b>${formatMoney(basket.totalNet)}</b></div><div><span>GST on total</span><b>${formatMoney(basket.gst)}</b></div><div><span>Total VP</span><b>${formatVp(basket.totalVP)}</b></div><div><span>Cost per VP</span><b>${basket.costPerVP === null ? '—' : formatMoney(Math.round(basket.costPerVP))}</b></div></div><div class="calculator-payable"><span>Final payable</span><b>${formatMoney(basket.final)}</b></div></section>`;
  const persist = () => app.persist();
  container.querySelector('#calc-search').oninput = (event) => { local.search = event.target.value; persist(); renderCalculator(container, app); };
  container.querySelector('#calc-category').onchange = (event) => { local.category = event.target.value; persist(); renderCalculator(container, app); };
  const ratesChanged = () => { const check = validateRates({ discount: document.querySelector('#calc-discount').value, gst: document.querySelector('#calc-gst').value }); if (!check.ok) { document.querySelector('#calc-error').textContent = Object.values(check.errors).join(' '); return; } local.discount = check.value.discount; local.gst = check.value.gst; persist(); renderCalculator(container, app); };
  container.querySelector('#calc-discount').onchange = ratesChanged; container.querySelector('#calc-gst').onchange = ratesChanged;
  const setQuantity = (id, value) => { const product = app.products.find((row) => row.id === id); const maximum = product?.max === undefined || product?.max === '' ? Infinity : Number(product.max); local.quantities[id] = Math.max(0, Math.min(maximum, Math.trunc(Number(value) || 0))); persist(); renderCalculator(container, app); };
  container.querySelectorAll('[data-step]').forEach((button) => { button.onclick = () => setQuantity(button.dataset.id, (Number(local.quantities[button.dataset.id]) || 0) + Number(button.dataset.step)); });
  container.querySelectorAll('[data-qty]').forEach((input) => { input.onchange = () => setQuantity(input.dataset.qty, input.value); });
  const activityData = () => ({ discount: Number(local.discount), gst: Number(local.gst), lines: basket.lines.map((line) => ({ productId: line.id, quantity: line.quantity, vp: line.vp, lineMrp: line.lineMrp })), totalVP: basket.totalVP, final: basket.final });
  container.querySelector('#calculator-pdf').onclick = () => { if (basket.lines.length) printInvoice({ title: 'VP calculator basket', result: basket, subtitle: `${formatVp(basket.totalVP)} total VP` }); };
  container.querySelector('#save-calculator-activity').onclick = async (event) => { if (!basket.lines.length) return; const button = event.currentTarget; button.disabled = true; button.textContent = 'Saved ✓'; await app.actions.recordActivity('calculator', activityData()); setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = '◷ Save activity'; } }, 1200); };
  container.querySelector('#save-calculator-basket').onclick = async (event) => { if (!basket.lines.length) return; const name = prompt('Name this calculator basket:', `VP ${formatVp(basket.totalVP)} basket`); if (!name?.trim()) return; const button = event.currentTarget; button.disabled = true; try { await app.actions.saveBasket({ name: name.trim(), type: 'calculator', data: activityData() }); button.textContent = 'Saved ✓'; } catch (error) { alert(error.message || 'Could not save this basket.'); button.disabled = false; } };
  container.querySelector('#send-to-optimizer').onclick = () => { if (basket.totalVP === 0) return; void app.actions.recordActivity('calculator', activityData()); const optimize = app.session.optimize ||= {}; optimize.inputs ||= {}; optimize.inputs.target = Math.round(basket.totalVP * 100) / 100; app.persist(); app.actions.go('optimize'); };
}
