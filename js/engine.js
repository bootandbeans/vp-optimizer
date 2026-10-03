/* Pure bounded-knapsack optimizer. It has no DOM, storage, or UI imports. */
import { priceBasket, priceProduct } from './pricing.js';

const MAX_TARGET = 5000;
const DEFAULT_KEEP = 3;

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const integer = (value, fallback = 0) => Math.max(0, Math.trunc(number(value, fallback)));
const vp2 = (value) => Math.round(number(value) * 100) / 100;

/** Return the smallest decimal scale needed by VP values (1, 10, or 100). */
export function vpScaleFor(items = []) {
  let decimals = 0;
  for (const raw of items) {
    const item = raw?.product || raw || {};
    const value = Math.abs(number(item.vp));
    // Precision is explicitly limited to two places for the discrete axis.
    const text = (Math.round(value * 100) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    const part = text.split('.')[1];
    decimals = Math.max(decimals, part ? part.length : 0);
  }
  return decimals === 0 ? 1 : 10 ** decimals;
}

function scaleFor(items, ...numbers) {
  let scale = vpScaleFor(items);
  for (const value of numbers) {
    const text = (Math.round(Math.abs(number(value)) * 100) / 100).toFixed(2).replace(/0+$/, '');
    const part = text.split('.')[1];
    if (part?.length === 2) scale = Math.max(scale, 100);
    else if (part?.length === 1) scale = Math.max(scale, 10);
  }
  return scale;
}
function toAxis(value, scale) { return Math.round(vp2(value) * scale); }
function fromAxis(value, scale) { return value / scale; }

function itemKey(product, ordinal) {
  if (product.id !== undefined && product.id !== null && product.id !== '') return `id:${product.id}`;
  return `row:${product.name || ''}\u0000${product.sku || ''}\u0000${product.mrp || 0}\u0000${product.vp || 0}\u0000${ordinal}`;
}

function canonicalProductKey(product) {
  // Same ID means same selected product. For imported duplicate rows without an
  // ID, the catalogue identity is name/SKU/MRP/VP.
  if (product.id !== undefined && product.id !== null && product.id !== '') return `id:${product.id}`;
  return `product:${product.name || ''}\u0000${product.sku || ''}\u0000${product.mrp || 0}\u0000${product.vp || 0}`;
}

function normalizeItems(rawItems, capAxis, scale) {
  const out = [];
  const seen = new Set();
  let order = 0;
  for (const raw of rawItems || []) {
    const product = raw?.product || raw || {};
    const mode = String(raw?.mode ?? raw?.selection ?? (raw?.required ? 'required' : 'allowed')).toLowerCase();
    if (mode === 'excluded' || raw?.selected === false || product.active === false) continue;
    const duplicateKey = canonicalProductKey(product);
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);

    const vpAxis = Math.max(0, toAxis(product.vp, scale));
    const selectedMin = integer(raw?.minQty ?? raw?.minimum ?? raw?.minQuantity, 0);
    const productMin = integer(product.min, 0);
    const requiredMin = mode === 'required' ? 1 : 0;
    const min = Math.max(productMin, selectedMin, requiredMin);
    const suppliedMax = product.max === undefined || product.max === null || product.max === ''
      ? null : integer(product.max, 0);
    if (suppliedMax !== null && suppliedMax < min) {
      return { error: `“${product.name || 'Unnamed product'}” has a maximum below its required minimum.` };
    }
    // VP-zero optional extras cannot improve VP closeness and only increase cost.
    // Required/minimum VP-zero copies remain in the seed as intended.
    let max;
    if (suppliedMax !== null) max = suppliedMax;
    else if (vpAxis > 0) max = min + Math.max(0, Math.floor(Math.max(0, capAxis) / vpAxis));
    else max = min;
    out.push({
      product,
      index: out.length,
      key: itemKey(product, order++),
      vpAxis,
      min,
      max: Math.max(min, max),
      mode,
    });
  }
  return { items: out };
}

function candidateSignature(quantities) { return quantities.join(','); }
function uniqueCount(quantities) { return quantities.reduce((count, qty) => count + (qty > 0 ? 1 : 0), 0); }

function insertBucket(map, axis, candidate, keep) {
  let bucket = map.get(axis);
  if (!bucket) {
    map.set(axis, [candidate]);
    return;
  }
  const signature = candidateSignature(candidate.quantities);
  const previous = bucket.findIndex((entry) => candidateSignature(entry.quantities) === signature);
  if (previous >= 0) {
    if (bucket[previous].netCost <= candidate.netCost) return;
    bucket.splice(previous, 1);
  }
  bucket.push(candidate);
  bucket.sort((a, b) => a.netCost - b.netCost || uniqueCount(a.quantities) - uniqueCount(b.quantities)
    || candidateSignature(a.quantities).localeCompare(candidateSignature(b.quantities)));
  if (bucket.length > keep) bucket.length = keep;
}

function makeComparator(ranking, targetAxis) {
  const keys = Array.isArray(ranking) && ranking.length ? ranking : ['withinRange', 'absDistance', 'cost', 'uniqueProducts'];
  return (a, b) => {
    for (const key of keys) {
      let diff = 0;
      if (key === 'withinRange') diff = Number(b.withinRange) - Number(a.withinRange);
      else if (key === 'absDistance' || key === 'distance') diff = Math.abs(a.axis - targetAxis) - Math.abs(b.axis - targetAxis);
      else if (key === 'cost' || key === 'final' || key === 'finalPayable') diff = a.pricing.final - b.pricing.final;
      else if (key === 'net' || key === 'taxable') diff = a.pricing.totalNet - b.pricing.totalNet;
      else if (key === 'uniqueProducts' || key === 'products') diff = a.uniqueProducts - b.uniqueProducts;
      if (diff) return diff;
    }
    return candidateSignature(a.quantities).localeCompare(candidateSignature(b.quantities));
  };
}

function enrich(candidate, items, scale, targetAxis, lowAxis, highAxis, overrides) {
  const inputLines = [];
  for (let index = 0; index < items.length; index += 1) {
    const quantity = candidate.quantities[index];
    if (quantity) inputLines.push({ product: items[index].product, quantity });
  }
  const pricing = priceBasket(inputLines, overrides);
  const totalVP = fromAxis(candidate.axis, scale);
  const difference = fromAxis(candidate.axis - targetAxis, scale);
  return {
    ...pricing,
    pricing,
    quantities: candidate.quantities.slice(),
    products: pricing.lines.map((line) => ({
      id: line.id, name: line.name, quantity: line.quantity, qty: line.quantity, vp: line.vp,
        unitVP: vp2(line.product.vp), lineMrp: line.lineMrp, unitMrp: line.unitMrp })),
    totalVP,
    totalVp: totalVP,
    difference,
    absDistance: Math.abs(difference),
    withinRange: candidate.axis >= lowAxis && candidate.axis <= highAxis,
    uniqueProducts: uniqueCount(candidate.quantities),
    axis: candidate.axis,
  };
}

/**
 * Find up to K in-range solutions and up to K out-of-range reference baskets.
 * All quantity minima are put in a seed state, then residual bounded quantities
 * are processed through binary-split 0/1 bundles.
 */
export function run({
  items = [], discount = 0, gst = 0, target = 0, tolerance = 0,
  toleranceMode = 'percent', ranking, keep = DEFAULT_KEEP,
} = {}) {
  const targetValue = number(target, NaN);
  const toleranceValue = number(tolerance, NaN);
  if (!Number.isFinite(targetValue) || targetValue < 0) return { status: 'error', message: 'Target VP must be zero or more.', solutions: [], closest: [] };
  if (!Number.isFinite(toleranceValue) || toleranceValue < 0) return { status: 'error', message: 'Tolerance must be zero or more.', solutions: [], closest: [] };
  if (targetValue > MAX_TARGET) return { status: 'error', message: `Target VP cannot exceed ${MAX_TARGET}.`, solutions: [], closest: [] };
  if (!Array.isArray(items) || !items.length) return { status: 'error', message: 'Please select at least one product.', solutions: [], closest: [] };

  const cleanKeep = Math.max(1, Math.min(20, integer(keep, DEFAULT_KEEP)));
  const mode = String(toleranceMode).toLowerCase();
  const toleranceVP = mode === 'absolute' || mode === 'vp' ? toleranceValue : targetValue * toleranceValue / 100;
  const low = Math.max(0, vp2(targetValue - toleranceVP));
  const high = Math.min(MAX_TARGET, vp2(targetValue + toleranceVP));
  const scale = scaleFor(items, targetValue, low, high);
  const targetAxis = toAxis(targetValue, scale);
  const lowAxis = toAxis(low, scale);
  const highAxis = toAxis(high, scale);
  const largestAxis = Math.max(0, ...items.map((raw) => toAxis((raw?.product || raw || {}).vp, scale)));
  // A point beyond high + one largest product cannot be closer than an omitted
  // product alternative. The user-facing target itself remains capped at 5000.
  const softCap = Math.min(MAX_TARGET * scale, Math.max(highAxis, 0) + largestAxis);
  const normalized = normalizeItems(items, softCap, scale);
  if (normalized.error) return { status: 'error', message: normalized.error, solutions: [], closest: [] };
  const activeItems = normalized.items;
  if (!activeItems.length) return { status: 'error', message: 'Please select at least one product.', solutions: [], closest: [] };

  const overrides = { discount: Math.max(0, number(discount)), gst: Math.max(0, number(gst)) };
  const seedQuantities = activeItems.map((item) => item.min);
  let seedAxis = 0;
  let reachableAxis = 0;
  let seedNet = 0;
  for (const item of activeItems) {
    seedAxis += item.vpAxis * item.min;
    reachableAxis += item.vpAxis * item.max;
    const unit = priceProduct(item.product, overrides).discountedUnit;
    seedNet += unit * item.min;
  }
  // Preserve an unavoidable minimum basket even if it is already over the cap.
  const capacity = Math.max(seedAxis, Math.min(reachableAxis, softCap));
  const states = new Map();
  states.set(seedAxis, [{ quantities: seedQuantities, netCost: seedNet }]);
  let transitions = 0;

  for (let itemIndex = 0; itemIndex < activeItems.length; itemIndex += 1) {
    const item = activeItems[itemIndex];
    const extra = item.max - item.min;
    if (!extra || item.vpAxis === 0) continue;
    const unitCost = priceProduct(item.product, overrides).discountedUnit;
    const bundles = [];
    let remaining = extra;
    let bit = 1;
    while (remaining > 0) {
      const amount = Math.min(bit, remaining);
      bundles.push(amount);
      remaining -= amount;
      bit *= 2;
    }
    for (const amount of bundles) {
      const vpAdd = amount * item.vpAxis;
      const costAdd = amount * unitCost;
      const keys = [...states.keys()].sort((a, b) => b - a);
      for (const currentAxis of keys) {
        const nextAxis = currentAxis + vpAdd;
        if (nextAxis > capacity) continue;
        // Snapshot prevents this bundle being reused during the same pass.
        const bucket = (states.get(currentAxis) || []).slice();
        for (const candidate of bucket) {
          const quantities = candidate.quantities.slice();
          quantities[itemIndex] += amount;
          insertBucket(states, nextAxis, { quantities, netCost: candidate.netCost + costAdd }, cleanKeep);
          transitions += 1;
        }
      }
    }
  }

  const bySignature = new Map();
  for (const [axis, bucket] of states) {
    for (const candidate of bucket) {
      const signature = candidateSignature(candidate.quantities);
      const existing = bySignature.get(signature);
      if (!existing || candidate.netCost < existing.netCost) bySignature.set(signature, { ...candidate, axis });
    }
  }
  const all = [...bySignature.values()].map((candidate) => enrich(candidate, activeItems, scale, targetAxis, lowAxis, highAxis, overrides));
  const compare = makeComparator(ranking, targetAxis);
  const valid = all.filter((entry) => entry.withinRange).sort(compare).slice(0, cleanKeep);
  const closest = all.filter((entry) => !entry.withinRange).sort(compare).slice(0, cleanKeep);
  const range = { low, high, target: vp2(targetValue), tolerance: vp2(toleranceVP), toleranceMode: mode, scale };

  return {
    status: valid.length ? 'ok' : 'none',
    message: valid.length ? `${valid.length} valid combination${valid.length === 1 ? '' : 's'} found.` : 'No combination lands inside the requested range.',
    range,
    target: vp2(targetValue),
    solutions: valid,
    closest,
    stats: { scale, capacity: fromAxis(capacity, scale), states: states.size, transitions, candidates: all.length },
  };
}

export default { run, vpScaleFor };
