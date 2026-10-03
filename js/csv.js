/* Dependency-free CSV helpers. Supports RFC-style quoted values and CRLF. */

export function parseCsv(text = '') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.trim());
  return rows.filter((line) => line.some((cellValue) => String(cellValue).trim() !== '')).map((line) => Object.fromEntries(headers.map((header, index) => [header, line[index] ?? ''])));
}

function escaped(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serialiseCsv(rows = [], headers = ['id', 'name', 'mrp', 'vp', 'category', 'sku', 'min', 'max', 'active']) {
  const lines = [headers.map(escaped).join(',')];
  for (const row of rows) lines.push(headers.map((header) => escaped(row?.[header])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export const serializeCsv = serialiseCsv;

/** CSV stores MRP in rupees for people; the repository stores integer paise. */
export function productsToCsvRows(products = []) {
  return products.map((product) => ({
    id: product.id || '', name: product.name || '', mrp: ((Number(product.mrp) || 0) / 100).toFixed(2), vp: product.vp ?? 0,
    category: product.category || '', sku: product.sku || '', min: product.min ?? '', max: product.max ?? '', active: product.active !== false,
  }));
}
