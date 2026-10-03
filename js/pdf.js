/* Print-to-PDF helper. Generates a fully self-contained light invoice in an iframe. */
import { escapeHtml } from './validation.js';
import { formatMoney, formatVp } from './pricing.js';

function linesHtml(lines = []) {
  return lines.map((line) => `<tr>
    <td>${escapeHtml(line.name || line.product?.name || 'Product')}</td>
    <td class="num">${Number(line.quantity ?? line.qty ?? 0)}</td>
    <td class="num">${formatVp(line.vp ?? ((line.product?.vp || 0) * (line.quantity || 0)))}</td>
    <td class="num">${formatMoney(line.lineMrp ?? ((line.unitMrp || line.mrp || 0) * (line.quantity || 0)))}</td>
  </tr>`).join('');
}
function totalsHtml(result) {
  return `<section class="totals">
    <p><span>Total MRP</span><b>${formatMoney(result.totalMrp)}</b></p>
    <p><span>Total discount</span><b>−${formatMoney(result.totalDiscount)}</b></p>
    <p><span>Taxable total</span><b>${formatMoney(result.totalNet ?? result.taxableTotal)}</b></p>
    <p><span>GST on total</span><b>${formatMoney(result.gst)}</b></p>
    <p><span>Total VP</span><b>${formatVp(result.totalVP ?? result.totalVp)}</b></p>
    <p class="payable"><span>Final payable</span><b>${formatMoney(result.final ?? result.finalPayable)}</b></p>
  </section>`;
}
function page(title, result, subtitle = '') {
  return `<article class="invoice">
    <header><div><small>VP OPTIMIZER</small><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="stamp">Generated ${escapeHtml(new Date().toLocaleString('en-IN'))}</div></header>
    <table><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">VP</th><th class="num">Line MRP</th></tr></thead><tbody>${linesHtml(result.lines || result.pricing?.lines)}</tbody></table>
    ${totalsHtml(result)}
  </article>`;
}

export function printInvoice({ title = 'Basket summary', result, subtitle = '' } = {}) {
  if (!result || typeof document === 'undefined') return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;right:0;bottom:0;border:0;visibility:hidden';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box} body{margin:0;background:#fff;color:#17232b;font:13px/1.45 Arial,sans-serif} .invoice{max-width:760px;margin:0 auto;padding:30px} header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #16735d;padding-bottom:18px;margin-bottom:20px} small{letter-spacing:1.8px;color:#16735d;font-weight:bold} h1{margin:4px 0;font-size:26px} p{margin:3px 0;color:#59656c}.stamp{text-align:right;color:#59656c;font-size:11px}table{border-collapse:collapse;width:100%;margin:10px 0 20px}th{background:#edf6f2;text-align:left;padding:9px;border-bottom:2px solid #a7ccbd}td{padding:9px;border-bottom:1px solid #d9e2df}.num{text-align:right;font-variant-numeric:tabular-nums}.totals{margin-left:auto;width:300px}.totals p{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #d9e2df;color:#26343a}.totals .payable{margin-top:8px;padding:12px;background:#e7f5ee;color:#0b4f3d;font-size:17px;border:2px solid #16735d}.totals b{font-variant-numeric:tabular-nums}@media print{.invoice{padding:0}@page{size:auto;margin:14mm}}</style></head><body>${page(title, result, subtitle)}</body></html>`;
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
}

export function printSolutions({ solutions = [], title = 'VP optimizer results', subtitle = '' } = {}) {
  if (!solutions.length || typeof document === 'undefined') return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;right:0;bottom:0;border:0;visibility:hidden';
  const content = solutions.map((solution, index) => page(`${title} — #${index + 1}`, solution, subtitle)).join('<div class="break"></div>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#17232b;font:13px/1.45 Arial,sans-serif}.invoice{max-width:760px;margin:0 auto;padding:30px}header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #16735d;padding-bottom:18px;margin-bottom:20px}small{letter-spacing:1.8px;color:#16735d;font-weight:bold}h1{margin:4px 0;font-size:26px}p{margin:3px 0;color:#59656c}.stamp{text-align:right;color:#59656c;font-size:11px}table{border-collapse:collapse;width:100%;margin:10px 0 20px}th{background:#edf6f2;text-align:left;padding:9px;border-bottom:2px solid #a7ccbd}td{padding:9px;border-bottom:1px solid #d9e2df}.num{text-align:right;font-variant-numeric:tabular-nums}.totals{margin-left:auto;width:300px}.totals p{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #d9e2df;color:#26343a}.totals .payable{margin-top:8px;padding:12px;background:#e7f5ee;color:#0b4f3d;font-size:17px;border:2px solid #16735d}.break{break-after:page}@media print{.invoice{padding:0}.break{break-after:page}@page{size:auto;margin:14mm}}</style></head><body>${content}</body></html>`;
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); };
}
