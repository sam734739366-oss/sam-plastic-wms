const { fmt } = require('../units');
const { fmtMoney } = require('../currency');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(n, d = 0) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
}

function money(n, settings) {
  return fmtMoney(n, settings.currency);
}

function docShell(title, body, pageSize, withSig = true) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">
  <style>
    @page { size: ${pageSize || 'A5'}; margin: 10mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px; color: #0f172a; margin: 0; }
    .head { background: linear-gradient(135deg, #1e3a8a, #3450b8); color: #fff; border-radius: 10px; padding: 13px 16px; margin-bottom: 12px; }
    .head h1 { margin: 0; font-size: 20px; letter-spacing: .3px; text-align: center; }
    .head .sub { font-size: 12.5px; margin-top: 4px; opacity: .93; text-align: center; }
    .meta { line-height: 2; margin-bottom: 6px; font-size: 12.5px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: center; }
    th { background: #1e3a8a; color: #fff; font-weight: 600; }
    tr:nth-child(even) td { background: #f8fafc; }
    .totals td { font-weight: bold; background: #e0e7ff !important; }
    .notes { margin-top: 10px; font-size: 12px; color: #334155; }
    .sig { display: flex; justify-content: space-between; margin-top: 34px; font-size: 12px; color: #1e3a8a; }
    .sig span { border-top: 2px solid #1e3a8a; padding: 4px 18px 0; }
  </style></head><body>
  <div class="head"><h1>${esc(title[0])}</h1><div class="sub">${esc(title[1])}</div></div>
  ${body}
  ${withSig ? '<div class="sig"><span>المستلم</span><span>الطرف الآخر</span><span>المدير</span></div>' : ''}
  </body></html>`;
}

function tableHtml(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function meta(doc, extra = '') {
  return `<div class="meta">${extra}
    <b>الرقم:</b> ${esc(doc.doc_number)} &nbsp; <b>التاريخ:</b> ${esc(doc.doc_date)}
    ${doc.party_name ? `&nbsp; <b>الطرف:</b> ${esc(doc.party_name)}` : ''}
    ${doc.driver_name ? `&nbsp; <b>السائق:</b> ${esc(doc.driver_name)}` : ''}
    ${doc.car_number ? `&nbsp; <b>السيارة:</b> ${esc(doc.car_number)}` : ''}</div>`;
}

function purchaseTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2),
    money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'فاتورة شراء'],
    meta(doc) + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم', 'السعر', 'الإجمالي'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function issueTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2),
    (r.carton_ids || []).map(esc).join(' ، ') || '—']);
  return docShell([settings.factory_name || 'سام بلاستيك', 'تصريح صرف للإنتاج'],
    meta(doc, `${doc.machine_name ? `<b>المكينة:</b> ${esc(doc.machine_name)} &nbsp;` : ''}${doc.shift_name ? `<b>الوردية:</b> ${esc(doc.shift_name)} &nbsp;` : ''}${doc.receiver_name ? `<b>المستلم:</b> ${esc(doc.receiver_name)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم', 'الكراتين'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function receiveTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'تصريح استلام إنتاج تام'],
    meta(doc, `${doc.machine_name ? `<b>المكينة:</b> ${esc(doc.machine_name)} &nbsp;` : ''}${doc.shift_name ? `<b>الوردية:</b> ${esc(doc.shift_name)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function invoiceTemplate(doc, settings) {
  const typeLabel = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' }[doc.invoice_type] || doc.invoice_type;
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', `فاتورة ${typeLabel}`],
    meta(doc) + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السعر', 'الإجمالي'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function exitTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'تصريح خروج'],
    meta(doc, `${doc.warehouse_name ? `<b>المخزن:</b> ${esc(doc.warehouse_name)} &nbsp;` : ''}${doc.destination ? `<b>جهة التسليم:</b> ${esc(doc.destination)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function tollReceiptTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    num(r.boxes), num(r.pieces_per_box), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند استلام خام (نفخ للغير)'],
    meta(doc) + tableHtml(['#', 'الصنف', 'العلب', 'حبات/علبة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function tollDeliveryTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند تسليم منفوخ (نفخ للغير)'],
    meta(doc, `${doc.invoice_number ? `<b>فاتورة الأجرة:</b> ${esc(doc.invoice_number)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function scrapTemplate(doc, settings) {
  const disp = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' }[doc.disposition] || doc.disposition;
  const rows = [[`${esc(doc.item_code)} ${esc(doc.item_name)}`, disp, num(doc.pieces), fmt(doc.weight_kg, 2),
    doc.price != null ? money(doc.price, settings) : '—']];
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند تالف ومصيره'],
    meta(doc, `${doc.warehouse_name ? `<b>المخزن:</b> ${esc(doc.warehouse_name)} &nbsp;` : ''}`)
    + tableHtml(['الصنف', 'المصير', 'الحبات', 'الوزن كجم', 'السعر'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function transferTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند نقل بين المخازن'],
    meta(doc, `<b>من:</b> ${esc(doc.from_name)} &nbsp; <b>إلى:</b> ${esc(doc.to_name)} &nbsp;`)
    + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size);
}

function reportTemplate(settings, title, metaLines, headers, rows, foot = '') {
  return docShell([settings.factory_name || 'سام بلاستيك', title],
    `<div class="meta">${metaLines.map(esc).join(' &nbsp; ')}</div>${tableHtml(headers, rows)}${foot}`,
    settings.report_page_size || 'A4', false);
}

module.exports = {
  purchaseTemplate, issueTemplate, receiveTemplate, invoiceTemplate, exitTemplate,
  tollReceiptTemplate, tollDeliveryTemplate, scrapTemplate, transferTemplate, reportTemplate,
};
