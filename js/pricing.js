/* Money and tax maths. Amounts are integer paise everywhere in this module. */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export const round = (number) => Math.round(Number(number) || 0);

/** Convert a rupee input to paise, rounding only at the storage boundary. */
export function toPaise(value) {
  const text = String(value ?? '').trim().replace(/[₹,\s]/g, '');
  if (!text || !/^[-+]?\d*(?:\.\d*)?$/.test(text)) return NaN;
  return Math.round(Number(text) * 100);
}

export function fromPaise(value) {
  return (Number(value) || 0) / 100;
}

export function formatMoney(paise, fallback = '—') {
  return Number.isFinite(Number(paise)) ? INR.format(fromPaise(paise)) : fallback;
}

export function formatVp(value, maximumFractionDigits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(n);
}

/** Percentage to hundredths-of-a-percent. 18.5% becomes 1850. */
export function rateToBasisPoints(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : Math.round(fallback * 100);
}

function rateFrom(source, names, fallback) {
  if (!source || typeof source !== 'object') return fallback;
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== '') {
      const n = Number(source[name]);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

/**
 * Resolve optional per-product rates without forcing callers to know the
 * eventual field names. rates.discount/rates.gst are the preferred names.
 */
export function resolveRates(product = {}, overrides = {}) {
  const globalDiscount = rateFrom(overrides, ['discount', 'discountPct'], 0);
  const globalGst = rateFrom(overrides, ['gst', 'gstPct'], 0);
  const local = product.rates || {};
  return {
    discount: rateFrom(local, ['discount', 'discountPct'], globalDiscount),
    gst: rateFrom(local, ['gst', 'gstPct', 'tax'], globalGst),
  };
}

/** Price one product at a quantity. GST is deliberately not charged here. */
export function priceProduct(product = {}, overrides = {}) {
  const quantity = Math.max(0, Math.trunc(Number(overrides.quantity ?? overrides.qty ?? 1) || 0));
  const mrp = Math.max(0, Math.round(Number(product.mrp) || 0));
  const rates = resolveRates(product, overrides);
  const discountBP = Math.max(0, Math.min(10000, rateToBasisPoints(rates.discount)));
  // Discount happens to this product's unit MRP, before multiplication.
  const discountedUnit = Math.round((mrp * (10000 - discountBP)) / 10000);
  const unitDiscount = mrp - discountedUnit;
  return {
    product,
    id: product.id,
    name: product.name || '',
    quantity,
    qty: quantity,
    mrp,
    unitMrp: mrp,
    discountedUnit,
    discounted: discountedUnit,
    unitNet: discountedUnit,
    unitDiscount,
    lineMrp: mrp * quantity,
    lineNet: discountedUnit * quantity,
    taxable: discountedUnit * quantity,
    lineDiscount: unitDiscount * quantity,
    vp: (Math.round((Number(product.vp) || 0) * 100) / 100) * quantity,
    rates,
  };
}

/** Round GST once for a group of lines carrying the same GST rate. */
export function gstOnTotal(totalNet, gst = 0) {
  const net = Math.max(0, Math.round(Number(totalNet) || 0));
  const gstBP = Math.max(0, rateToBasisPoints(gst));
  return Math.round((net * gstBP) / 10000);
}

/**
 * Price a basket. Lines can be products ({...product, quantity}) or
 * { product, quantity }. Tax is calculated from grouped taxable totals once.
 */
export function priceBasket(lines = [], overrides = {}) {
  const pricedLines = [];
  const groups = new Map();
  let totalMrp = 0;
  let totalNet = 0;
  let totalDiscount = 0;
  let totalVP = 0;

  for (const source of lines || []) {
    const product = source?.product || source || {};
    const quantity = source?.quantity ?? source?.qty ?? product.quantity ?? product.qty ?? 1;
    const line = priceProduct(product, { ...overrides, quantity });
    if (!line.quantity) continue;
    pricedLines.push(line);
    totalMrp += line.lineMrp;
    totalNet += line.lineNet;
    totalDiscount += line.lineDiscount;
    totalVP += line.vp;
    const rate = Math.max(0, rateToBasisPoints(line.rates.gst));
    const group = groups.get(rate) || { rate: rate / 100, net: 0 };
    group.net += line.lineNet;
    groups.set(rate, group);
  }

  const gstGroups = [...groups.values()].map((group) => ({
    ...group,
    gst: gstOnTotal(group.net, group.rate),
  }));
  const gst = gstGroups.reduce((sum, group) => sum + group.gst, 0);
  const final = totalNet + gst;
  const costPerVP = totalVP === 0 ? null : final / totalVP;

  return {
    lines: pricedLines,
    totalMrp,
    totalDiscount,
    totalNet,
    taxableTotal: totalNet,
    gst,
    totalGst: gst,
    gstGroups,
    final,
    totalFinal: final,
    finalPayable: final,
    totalVP,
    totalVp: totalVP,
    costPerVP,
  };
}
