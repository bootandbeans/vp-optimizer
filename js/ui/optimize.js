import { escapeHtml, validateOptimizeInput } from '../validation.js';
import { formatMoney, formatVp } from '../pricing.js';
import { printInvoice, printSolutions } from '../pdf.js';

const base = () => ({
  search: '', category: '', selection: {},
  inputs: { discount: 0, gst: 18, target: 500, tolerance: 10, toleranceMode: 'percent' },
  result: null, message: '',
});
const resultIsRenderable = (result) => result && typeof result === 'object'
  && Array.isArray(result.solutions) && Array.isArray(result.closest)
  && [...result.solutions, ...result.closest].every((solution) => solution && Array.isArray(solution.lines));
// A basket restored from My History intentionally contains only its inputs and
// selection. Hydrate the missing visual state before the screen reads it.
const stateFor = (app) => {
  const local = app.session.optimize && typeof app.session.optimize === 'object' ? app.session.optimize : (app.session.optimize = {});
  const defaults = base();
  local.search ??= defaults.search;
  local.category ??= defaults.category;
  local.selection = local.selection && typeof local.selection === 'object' ? local.selection : {};
  local.inputs = { ...defaults.inputs, ...(local.inputs && typeof local.inputs === 'object' ? local.inputs : {}) };
  // Engine results are runtime-only. Older saved sessions can contain a
  // partially serialised result (for example lines: null); discard it safely.
  if (local.result && !resultIsRenderable(local.result)) local.result = null;
  local.result ??= null;
  local.message ??= '';
  return local;
};
const cats = (products) => [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const selectionOf = (local, product) => local.selection[product.id] || { mode: 'excluded', minQty: 0 };
const rangeText = (input) => {
  const target = Number(input.target); const tolerance = Number(input.tolerance);
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(tolerance) || tolerance < 0) return 'Enter a valid target and tolerance.';
  const span = input.toleranceMode === 'absolute' ? tolerance : target * tolerance / 100;
  return `${formatVp(Math.max(0, target - span))} – ${formatVp(Math.min(5000, target + span))} VP`;
};
function lines(solution) {
  const basketLines = Array.isArray(solution?.lines) ? solution.lines : [];
  if (!basketLines.length) return '<p class="result-lines-empty">Line details are unavailable for this older result. Run the search again to refresh it.</p>';
  return `<ul class="result-lines">${basketLines.map((line) => `<li><span><b>${escapeHtml(line.name)}</b> <small>× ${line.quantity}</small></span><span>${formatVp(line.vp)} VP · line MRP ${formatMoney(line.lineMrp)}</span></li>`).join('')}</ul>`;
}
function reason(solution, first, target) {
  if (!first || solution === first) return solution.difference === 0 ? 'Chosen because it hits your target exactly at the lowest payable amount.' : `Chosen for its ${formatVp(Math.abs(solution.difference))} VP distance from the ${formatVp(target)} VP target.`;
  const vp = Math.abs(solution.difference) - Math.abs(first.difference);
  const money = solution.final - first.final;
  return `${vp === 0 ? 'It is equally close to' : `It is ${formatVp(Math.abs(vp))} VP ${vp > 0 ? 'farther from' : 'closer to'}`} the target than solution #1 and ${money === 0 ? 'costs the same.' : `${formatMoney(Math.abs(money))} ${money > 0 ? 'more' : 'less'}.`}`;
}
function resultCard(solution, index, kind, target, first) {
  const valid = kind === 'valid';
  const label = solution.difference === 0 ? 'Exact' : valid ? 'Within tolerance' : 'Outside requested range';
  return `<article class="result-card ${valid ? 'valid-card' : 'reference-card'} rank-${index + 1}">
    ${valid ? '' : '<div class="invalid-ribbon">Not a valid result</div>'}
    <header><div class="rank">#${index + 1}</div><div><span class="result-label ${valid ? 'good' : 'warn'}">${escapeHtml(label)}</span><h3>${formatVp(solution.totalVP)} VP <small>(${solution.difference > 0 ? '+' : ''}${formatVp(solution.difference)} from target)</small></h3></div><div class="result-card-actions"><button class="button small subtle" data-save-basket="${kind}:${index}">☆ Save</button><button class="button small subtle" data-pdf-card="${kind}:${index}">⇩ PDF</button></div></header>
    ${lines(solution)}
    <div class="result-tiles"><div><span>Total MRP</span><b>${formatMoney(solution.totalMrp)}</b></div><div><span>Total discount</span><b>−${formatMoney(solution.totalDiscount)}</b></div><div><span>Total VP</span><b>${formatVp(solution.totalVP)}</b></div></div>
    <div class="payable"><span>Final payable <small>GST included once on the taxable total</small></span><b>${formatMoney(solution.final)}</b></div>
    <p class="selection-reason">${escapeHtml(reason(solution, first, target))}</p>
  </article>`;
}
function resultsHtml(local) {
  const result = local.result;
  if (!result) return '<section class="results-placeholder"><span>⌁</span><h2>Ready when you are</h2><p>Choose products, set a VP target, then find the most economical baskets.</p></section>';
  if (result.status === 'error') return `<section class="notice error" role="alert">${escapeHtml(result.message)}</section>`;
  const valid = Array.isArray(result.solutions) ? result.solutions.filter((solution) => Array.isArray(solution?.lines)) : [];
  const outside = Array.isArray(result.closest) ? result.closest.filter((solution) => Array.isArray(solution?.lines)) : [];
  const range = result.range || {};
  return `<section class="result-summary"><span>✓ ${valid.length} inside range</span><span>⚠ ${outside.length} outside range</span><span>Target <b>${formatVp(result.target)} VP</b></span><span>Accepted <b>${formatVp(range.low)} – ${formatVp(range.high)} VP</b></span><div class="summary-actions">${valid.length ? '<button class="button small primary" data-pdf-set="valid">Save valid as PDF</button>' : ''}${(valid.length || outside.length) ? '<button class="button small subtle" data-pdf-set="all">Save all as PDF</button>' : ''}</div></section>
    <div class="result-panels"><section class="result-panel valid-panel"><header><div><span class="panel-icon">✓</span><h2>Valid combinations <em>VALID</em></h2><p>Inside your requested VP range — these are the answers.</p></div></header>${valid.length ? valid.map((entry, index) => resultCard(entry, index, 'valid', result.target, valid[0])).join('') : `<div class="empty-panel"><b>No valid combinations</b><p>${escapeHtml(result.message)}</p></div>`}</section>
    <section class="result-panel reference-panel"><header><div><span class="panel-icon">⚠</span><h2>Reference only <em>NOT VALID</em></h2><p>Outside the accepted range; shown only to show what the catalogue can reach.</p></div></header>${outside.length ? outside.map((entry, index) => resultCard(entry, index, 'reference', result.target, valid[0] || outside[0])).join('') : '<div class="empty-panel"><b>No reference baskets needed</b><p>The valid results above are the closest available options.</p></div>'}</section></div>`;
}

export function renderOptimize(container, app) {
  const local = stateFor(app);
  const active = (Array.isArray(app.products) ? app.products : []).filter((product) => product.active !== false);
  const needle = local.search.toLowerCase().trim();
  const filtered = active.filter((product) => (!needle || [product.name, product.sku, product.category].join(' ').toLowerCase().includes(needle)) && (!local.category || product.category === local.category));
  container.innerHTML = `<section class="view-heading"><div><p class="eyebrow">Bounded VP search</p><h1>Optimize a basket</h1><p>Only products you allow are handed to the optimizer. Required and minimum quantities are always included.</p></div></section>
  <section class="surface optimizer-selection"><div class="section-title selection-title"><div><p class="eyebrow">Build the search pool</p><h2>1. Select products</h2><p>Click a status button to include a product — no dropdown menus.</p></div><div class="inline-actions"><button class="button small subtle" id="select-all">Select all</button><button class="button small subtle" id="deselect-all">Deselect all</button></div></div><div class="selection-guide"><span><i class="guide-dot excluded"></i><b>Excluded</b> is ignored</span><span><i class="guide-dot allowed"></i><b>Allowed</b> is optional</span><span><i class="guide-dot required"></i><b>Required</b> starts at 1 unit</span></div>
    <div class="filter-bar compact"><label>Search<input id="opt-search" value="${escapeHtml(local.search)}" placeholder="Name, SKU or category" /></label><label>Category<select id="opt-category"><option value="">All categories</option>${cats(active).map((category) => `<option ${category === local.category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select></label></div>
    <div class="selection-list">${filtered.length ? filtered.map((product) => { const picked = selectionOf(local, product); const effectiveMin = Math.max(Number(product.min) || 0, Number(picked.minQty) || 0, picked.mode === 'required' ? 1 : 0); const bad = product.max !== undefined && product.max !== '' && effectiveMin > Number(product.max); return `<article class="selection-row ${picked.mode}"><div class="selection-product"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category || 'Uncategorised')} · ${formatVp(product.vp)} VP · ${formatMoney(product.mrp)}</small></div><div class="selection-use" role="group" aria-label="Use ${escapeHtml(product.name)}"><span>Use</span><div class="choice-buttons"><button type="button" data-mode-button="excluded" data-id="${escapeHtml(product.id)}" class="${picked.mode === 'excluded' ? 'selected' : ''}" aria-pressed="${picked.mode === 'excluded'}">Excluded</button><button type="button" data-mode-button="allowed" data-id="${escapeHtml(product.id)}" class="${picked.mode === 'allowed' ? 'selected' : ''}" aria-pressed="${picked.mode === 'allowed'}">Allowed</button><button type="button" data-mode-button="required" data-id="${escapeHtml(product.id)}" class="${picked.mode === 'required' ? 'selected' : ''}" aria-pressed="${picked.mode === 'required'}">Required</button></div></div><label class="min-control ${picked.mode === 'excluded' ? 'disabled' : ''}">Min qty<input data-min="${escapeHtml(product.id)}" type="number" min="0" step="1" ${picked.mode === 'excluded' ? 'disabled' : ''} value="${picked.minQty || 0}" /></label><p class="min-note ${bad ? 'error-text' : ''}">${picked.mode === 'excluded' ? 'Excluded from this search.' : bad ? `Minimum exceeds Max qty (${product.max}).` : effectiveMin ? `${effectiveMin} unit${effectiveMin === 1 ? '' : 's'} always included.` : 'Optional — may be omitted.'}</p></article>`; }).join('') : '<p class="empty">No active products match the filter.</p>'}</div></section>
  <section class="surface optimizer-inputs"><div class="section-title"><div><h2>2. Set the target</h2><p>Discount is calculated per product; GST is added once to each basket total.</p></div></div><form id="optimizer-form" class="input-grid" novalidate><label>Discount %<input name="discount" min="0" max="100" step="0.01" inputmode="decimal" value="${escapeHtml(local.inputs.discount)}" /></label><label>GST %<input name="gst" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(local.inputs.gst)}" /></label><label>Target VP<input name="target" min="0" max="5000" step="0.01" inputmode="decimal" value="${escapeHtml(local.inputs.target)}" /></label><label>Tolerance<input name="tolerance" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(local.inputs.tolerance)}" /></label><label>Tolerance type<select name="toleranceMode"><option value="percent" ${local.inputs.toleranceMode === 'percent' ? 'selected' : ''}>Percent of target</option><option value="absolute" ${local.inputs.toleranceMode === 'absolute' ? 'selected' : ''}>Absolute VP</option></select></label><div class="range-readout"><span>Acceptable range</span><b id="range-readout">${rangeText(local.inputs)}</b></div><div class="form-submit"><p class="form-error" role="alert"></p><button class="button primary large">Find best combinations</button></div></form></section>
  <section class="results-section"><div class="section-title"><div><h2>3. Results</h2><p>Final payable includes GST charged on the basket total.</p></div></div>${resultsHtml(local)}</section>`;

  const persist = () => app.persist();
  container.querySelector('#opt-search').oninput = (event) => { local.search = event.target.value; persist(); renderOptimize(container, app); };
  container.querySelector('#opt-category').onchange = (event) => { local.category = event.target.value; persist(); renderOptimize(container, app); };
  container.querySelector('#select-all').onclick = () => { active.forEach((product) => { const old = selectionOf(local, product); local.selection[product.id] = { ...old, mode: old.mode === 'required' ? 'required' : 'allowed' }; }); persist(); renderOptimize(container, app); };
  container.querySelector('#deselect-all').onclick = () => { active.forEach((product) => { local.selection[product.id] = { ...selectionOf(local, product), mode: 'excluded' }; }); persist(); renderOptimize(container, app); };
  container.querySelectorAll('[data-mode-button]').forEach((button) => { button.onclick = () => { const product = app.products.find((p) => p.id === button.dataset.id); if (!product) return; const old = selectionOf(local, product); const mode = button.dataset.modeButton; local.selection[product.id] = { mode, minQty: mode === 'required' && !Number(old.minQty) ? 1 : Number(old.minQty) || 0 }; persist(); renderOptimize(container, app); }; });
  container.querySelectorAll('[data-min]').forEach((input) => { input.onchange = () => { const product = app.products.find((p) => p.id === input.dataset.min); const old = selectionOf(local, product); local.selection[product.id] = { ...old, minQty: Math.max(0, Math.trunc(Number(input.value) || 0)) }; persist(); renderOptimize(container, app); }; });
  const form = container.querySelector('#optimizer-form');
  const syncInput = () => { const data = Object.fromEntries(new FormData(form)); local.inputs = { ...local.inputs, ...data }; container.querySelector('#range-readout').textContent = rangeText(local.inputs); persist(); };
  form.querySelectorAll('input,select').forEach((input) => input.addEventListener('input', syncInput));
  form.onsubmit = (event) => {
    event.preventDefault(); syncInput(); const checked = validateOptimizeInput(local.inputs); const error = form.querySelector('.form-error');
    if (!checked.ok) { error.textContent = Object.values(checked.errors).join(' '); return; }
    const chosen = active.map((product) => ({ product, ...selectionOf(local, product) })).filter((entry) => entry.mode !== 'excluded');
    if (!chosen.length) { error.textContent = 'Please select at least one product.'; return; }
    const invalidMinimum = chosen.find(({ product, minQty, mode }) => product.max !== undefined && product.max !== '' && Math.max(Number(product.min) || 0, Number(minQty) || 0, mode === 'required' ? 1 : 0) > Number(product.max));
    if (invalidMinimum) { error.textContent = `Minimum quantity exceeds Max qty for ${invalidMinimum.product.name}.`; return; }
    error.textContent = ''; local.inputs = checked.value; local.result = app.actions.runOptimize({ ...checked.value, items: chosen }); void app.actions.recordActivity('optimize', { inputs: checked.value, selection: chosen.map((entry) => ({ productId: entry.product.id, mode: entry.mode, minQty: entry.minQty || 0 })), status: local.result.status, validResults: local.result.solutions.map((solution) => ({ totalVP: solution.totalVP, final: solution.final })), referenceResults: local.result.closest.map((solution) => ({ totalVP: solution.totalVP, final: solution.final })) }); persist(); renderOptimize(container, app);
  };
  const result = local.result;
  container.querySelectorAll('[data-pdf-card]').forEach((button) => { button.onclick = () => { const [kind, index] = button.dataset.pdfCard.split(':'); const solution = kind === 'valid' ? result.solutions[Number(index)] : result.closest[Number(index)]; printInvoice({ title: `VP optimizer ${kind === 'valid' ? 'valid result' : 'reference basket'}`, result: solution, subtitle: `${formatVp(solution.totalVP)} VP · target ${formatVp(result.target)} VP` }); }; });
  container.querySelectorAll('[data-save-basket]').forEach((button) => { button.onclick = async () => { const [kind, index] = button.dataset.saveBasket.split(':'); const solution = kind === 'valid' ? result.solutions[Number(index)] : result.closest[Number(index)]; const name = prompt('Name this optimizer basket:', `VP ${formatVp(solution.totalVP)} basket`); if (!name?.trim()) return; button.disabled = true; try { await app.actions.saveBasket({ name: name.trim(), type: 'optimizer', data: { inputs: local.inputs, selection: Object.entries(local.selection).map(([productId, choice]) => ({ productId, mode: choice.mode, minQty: choice.minQty || 0 })), result: { totalVP: solution.totalVP, final: solution.final, lines: solution.lines.map((line) => ({ productId: line.id, quantity: line.quantity, vp: line.vp, lineMrp: line.lineMrp })) } } }); button.textContent = 'Saved ✓'; } catch (error) { alert(error.message || 'Could not save this basket.'); button.disabled = false; } }; });
  container.querySelectorAll('[data-pdf-set]').forEach((button) => { button.onclick = () => { const list = button.dataset.pdfSet === 'valid' ? result.solutions : [...result.solutions, ...result.closest]; printSolutions({ solutions: list, title: button.dataset.pdfSet === 'valid' ? 'Valid VP combinations' : 'VP combinations', subtitle: `Target ${formatVp(result.target)} VP · accepted ${formatVp(result.range.low)}–${formatVp(result.range.high)} VP` }); }; });
}
