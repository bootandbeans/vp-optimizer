import { toPaise } from './pricing.js';

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

/** Plain text only: remove control characters and any markup-like brackets. */
export function sanitizeText(value, maxLength = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function numberInRange(value, { min = -Infinity, max = Infinity, decimals = 2, label = 'Value', required = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? { ok: false, error: `${label} is required.` } : { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.` };
  if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  const scale = 10 ** decimals;
  return { ok: true, value: Math.round(n * scale) / scale };
}

export function integerInRange(value, { min = 0, max = Infinity, label = 'Quantity', required = false } = {}) {
  const result = numberInRange(value, { min, max, decimals: 0, label, required });
  if (!result.ok || result.value === null) return result;
  if (!Number.isInteger(Number(value))) return { ok: false, error: `${label} must be a whole number.` };
  return { ok: true, value: result.value };
}

export function validateRates({ discount = 0, gst = 0 } = {}) {
  const errors = {};
  const d = numberInRange(discount, { min: 0, max: 100, decimals: 2, label: 'Discount' });
  const g = numberInRange(gst, { min: 0, decimals: 2, label: 'GST' });
  if (!d.ok) errors.discount = d.error;
  if (!g.ok) errors.gst = g.error;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { discount: d.value, gst: g.value } };
}

/** Validate a stored product; incoming MRP is rupees, output MRP is paise. */
export function validateProduct(input = {}, { inputMrpIsPaise = false } = {}) {
  const errors = {};
  const name = sanitizeText(input.name, 120);
  if (!name) errors.name = 'Name is required.';
  const mrp = inputMrpIsPaise ? Math.round(Number(input.mrp)) : toPaise(input.mrp);
  if (!Number.isFinite(mrp) || mrp < 0) errors.mrp = 'MRP must be zero or more.';
  const vpCheck = numberInRange(input.vp, { min: 0, decimals: 2, label: 'VP' });
  if (!vpCheck.ok) errors.vp = vpCheck.error;
  const minCheck = integerInRange(input.min, { min: 0, label: 'Minimum quantity', required: false });
  const maxCheck = integerInRange(input.max, { min: 0, label: 'Maximum quantity', required: false });
  if (!minCheck.ok) errors.min = minCheck.error;
  if (!maxCheck.ok) errors.max = maxCheck.error;
  if (minCheck.ok && maxCheck.ok && minCheck.value !== null && maxCheck.value !== null && minCheck.value > maxCheck.value) {
    errors.max = 'Maximum quantity must be at least the minimum.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(input.id ? { id: String(input.id) } : {}),
      name,
      mrp,
      vp: vpCheck.value,
      category: sanitizeText(input.category, 60),
      sku: sanitizeText(input.sku, 60),
      ...(minCheck.value !== null ? { min: minCheck.value } : {}),
      ...(maxCheck.value !== null ? { max: maxCheck.value } : {}),
      active: input.active !== false && input.active !== 'false' && input.active !== '0',
    },
  };
}

export function validateOptimizeInput(input = {}) {
  const rates = validateRates(input);
  const errors = { ...(rates.errors || {}) };
  const target = numberInRange(input.target, { min: 0, max: 5000, decimals: 2, label: 'Target VP' });
  const tolerance = numberInRange(input.tolerance, { min: 0, decimals: 2, label: 'Tolerance' });
  if (!target.ok) errors.target = target.error;
  if (!tolerance.ok) errors.tolerance = tolerance.error;
  const mode = String(input.toleranceMode || 'percent').toLowerCase();
  if (!['percent', 'absolute', 'vp'].includes(mode)) errors.toleranceMode = 'Tolerance mode is invalid.';
  return Object.keys(errors).length ? { ok: false, errors } : {
    ok: true,
    value: { discount: rates.value.discount, gst: rates.value.gst, target: target.value, tolerance: tolerance.value, toleranceMode: mode === 'vp' ? 'absolute' : mode },
  };
}
