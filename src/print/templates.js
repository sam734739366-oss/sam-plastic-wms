const { fmt } = require('../units');
const { fmtMoney } = require('../currency');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(n, d = 0) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
}

const BUCKET_LABEL = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
function bucketCell(bucket) {
  const b = BUCKET_LABEL[bucket] ? bucket : 'salem';
  const color = { salem: '#15803d', talef: '#b91c1c', muharraz: '#b45309' }[b];
  return `<b style="color:${color}">${BUCKET_LABEL[b]}</b>`;
}

function money(n, settings) {
  return fmtMoney(n, settings.currency);
}

// العلامة التجارية إلزامية في كل مستند مطبوع: شريط علوي ثابت (اسم التطبيق + الهاتف) وتذييل
// ثابت بثلاثة مواضع. الثبّت بـ position: fixed يجعل Chromium يعيد رسم الشريطين على كل صفحة
// فيزيائية عند تقاطع المستند، لا على الأولى والأخيرة فقط.
const APP_NAME = 'سام بلاستيك';

function brandBar(settings) {
  const phone = String(settings.factory_phone || '').trim();
  return `<div class="lhead"><span class="brand">${esc(APP_NAME)}</span>`
    + (phone ? `<span class="tel">${esc(phone)}</span>` : '')
    + '</div>';
}

function footerBar(settings) {
  const cells = [
    ['fr', settings.footer_right],
    ['fc', settings.footer_center],
    ['fl', settings.footer_left],
  ].filter(([, t]) => String(t || '').trim());
  if (!cells.length) return '';
  return `<div class="foot">${cells.map(([cls, t]) => `<span class="${cls}">${esc(t)}</span>`).join('')}</div>`;
}

function docShell(title, body, pageSize, withSig = true, settings = {}) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">
  <style>
    @page { size: ${pageSize || 'A5'}; margin: 10mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px; color: #0f172a; margin: 0; padding: 8mm 0 7mm; }
    .lhead { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 1.2mm 2mm; background: linear-gradient(135deg, #1e3a8a, #3450b8); color: #fff; font-size: 10.5px; }
    .lhead .brand { font-weight: 700; letter-spacing: .4px; }
    .lhead .tel { direction: ltr; opacity: .95; }
    .head { background: linear-gradient(135deg, #1e3a8a, #3450b8); color: #fff; border-radius: 10px; padding: 13px 16px; margin-bottom: 12px; }
    .head h1 { margin: 0; font-size: 20px; letter-spacing: .3px; text-align: center; }
    .head .sub { font-size: 12.5px; margin-top: 4px; opacity: .93; text-align: center; }
    .meta { line-height: 2; margin-bottom: 6px; font-size: 12.5px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: center; }
    th { background: #1e3a8a; color: #fff; font-weight: 600; }
    tr:nth-child(even) td { background: #f8fafc; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
    .totals td { font-weight: bold; background: #e0e7ff !important; }
    /* جدول التسوية في سند استلام الإنتاج: خانتا التسمية بارزتان */
    .sum td:nth-child(1), .sum td:nth-child(3) { background: #eef2ff; font-weight: 600; width: 22%; }
    .notes { margin-top: 10px; font-size: 12px; color: #334155; }
    .sig { display: flex; justify-content: space-between; margin-top: 34px; font-size: 12px; color: #1e3a8a; }
    .sig span { border-top: 2px solid #1e3a8a; padding: 4px 18px 0; }
    .foot { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: 10px; padding-top: 1.2mm; border-top: 1px solid #cbd5e1; font-size: 10.5px; color: #334155; }
    .foot span { flex: 1; }
    .foot .fr { text-align: right; }
    .foot .fc { text-align: center; }
    .foot .fl { text-align: left; }
  </style></head><body>
  ${brandBar(settings)}
  <div class="head"><h1>${esc(title[0])}</h1><div class="sub">${esc(title[1])}</div></div>
  ${body}
  ${withSig ? '<div class="sig"><span>المستلم</span><span>الطرف الآخر</span><span>المدير</span></div>' : ''}
  ${footerBar(settings)}
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
    ${doc.payment_method ? `&nbsp; <b>الدفع:</b> ${doc.payment_method === 'cash' ? 'نقدي' : 'آجل'}` : ''}
    ${doc.driver_name ? `&nbsp; <b>السائق:</b> ${esc(doc.driver_name)}` : ''}
    ${doc.car_number ? `&nbsp; <b>السيارة:</b> ${esc(doc.car_number)}` : ''}</div>`;
}

function purchaseTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), bucketCell(r.bucket), num(r.pieces), fmt(r.weight_kg, 2),
    money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'فاتورة شراء'],
    meta(doc) + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'السلة', 'الحبات', 'الوزن كجم', 'السعر', 'الإجمالي'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function issueTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), bucketCell(r.bucket), num(r.pieces), fmt(r.weight_kg, 2),
    (r.carton_ids || []).map(esc).join(' ، ') || '—']);
  return docShell([settings.factory_name || 'سام بلاستيك', 'تصريح صرف للإنتاج'],
    meta(doc, `${doc.machine_name ? `<b>المكينة:</b> ${esc(doc.machine_name)} &nbsp;` : ''}${doc.shift_name ? `<b>الوردية:</b> ${esc(doc.shift_name)} &nbsp;` : ''}${doc.receiver_name ? `<b>المستلم:</b> ${esc(doc.receiver_name)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السلة', 'الحبات', 'الوزن كجم', 'الكراتين'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

// سند استلام الإنتاج الموحّد (v2): نتيجة كل كرتون + تسوية الفارق + توزيع الأثر في صفحة واحدة
function productionReceiptTemplate(doc, settings) {
  const lines = doc.cartons || [];
  const unit = doc.unit_name || 'حبة';
  const rows = lines.map((r, i) => {
    const accounted = (Number(r.good_pieces) || 0) + (Number(r.defect_before_pieces) || 0) + (Number(r.defect_after_pieces) || 0);
    const diff = (Number(r.carton_pieces) || 0) - accounted;
    return [i + 1, esc(r.carton_number), `${esc(r.raw_code || '')} ${esc(r.raw_name || '')}`,
      num(r.carton_pieces), num(r.good_pieces), num(r.defect_before_pieces), num(r.defect_after_pieces),
      num(accounted), diff === 0 ? '—' : num(diff)];
  });
  const issued = Number(doc.issued_pieces) || 0;
  const total = Number(doc.total_pieces) || 0;
  const variance = Number(doc.variance_pieces) || 0;
  const surplus = Number(doc.surplus_pieces) || 0;
  const fgGood = (Number(doc.good_pieces) || 0) + surplus;
  const issueInfo = doc.issue_number ? `<b>تصريح الصرف:</b> ${esc(doc.issue_number)} &nbsp;` : '';
  const src = doc.source === 'customer'
    ? `<b>المصدر:</b> خام العميل${doc.party_name ? ` — ${esc(doc.party_name)}` : ''} (عهدة)`
    : '<b>المصدر:</b> خام المصنع';
  const summaryNote = variance > 0 ? 'عجز تسوية' : variance < 0 ? 'فائض تسوية' : 'تسوية مطابقة';
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند استلام إنتاج'],
    meta(doc, `${doc.machine_name ? `<b>المكينة:</b> ${esc(doc.machine_name)} &nbsp;` : ''}${doc.shift_name ? `<b>الوردية:</b> ${esc(doc.shift_name)} &nbsp;` : ''}${doc.receiver_name ? `<b>المستلم:</b> ${esc(doc.receiver_name)} &nbsp;` : ''}${issueInfo}<br>${src} &nbsp; <b>الصنف النهائي:</b> ${esc(doc.fg_code || '')} — ${esc(doc.fg_name || '')}${doc.warehouse_name ? ` &nbsp; <b>المخزن:</b> ${esc(doc.warehouse_name)}` : ''}`)
    + tableHtml(['#', 'الكرتون', 'الخام', 'حبات الكرتون', 'سليم', 'تالف قبل', 'تالف بعد', 'المحسوب', 'الفارق'], rows)
    + `<table class="sum">
      <tr><td>المصروف (حبات الكراتين)</td><td><b>${num(issued)} ${esc(unit)}</b></td>
          <td>إجمالي المنتج</td><td><b>${num(total)} ${esc(unit)}</b></td></tr>
      <tr><td>الفارق</td><td><b>${variance > 0 ? `عجز ${num(variance)}` : variance < 0 ? `فائض ${num(-variance)}` : 'صفر'}</b></td>
          <td>يُضاف للتام السليم</td><td><b>${num(surplus)}</b></td></tr>
      <tr><td>تام سليم</td><td><b>${num(fgGood)}</b></td>
          <td>تام تالف (بعد النفخ)</td><td><b>${num(doc.defect_after_pieces)}</b></td></tr>
      <tr><td>خام تالف (قبل النفخ)</td><td><b>${num(doc.defect_before_pieces)}</b></td>
          <td>الأكياس المستهلكة</td><td><b>${num(doc.bags_used)}</b></td></tr>
    </table>`
    + `<div class="notes">الحالة: <b>${summaryNote}</b>${doc.notes ? ` — ملاحظات: ${esc(doc.notes)}` : ''}</div>`, settings.doc_page_size, true, settings);
}

function invoiceTemplate(doc, settings) {
  const typeLabel = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' }[doc.invoice_type] || doc.invoice_type;
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), bucketCell(r.bucket), money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', `فاتورة ${typeLabel}`],
    meta(doc) + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السلة', 'السعر', 'الإجمالي'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function exitTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    bucketCell(r.bucket), fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'تصريح خروج'],
    meta(doc, `${doc.warehouse_name ? `<b>المخزن:</b> ${esc(doc.warehouse_name)} &nbsp;` : ''}${doc.destination ? `<b>جهة التسليم:</b> ${esc(doc.destination)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'السلة', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function tollReceiptTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    num(r.boxes), num(r.pieces_per_box), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند استلام خام (نفخ للغير)'],
    meta(doc) + tableHtml(['#', 'الصنف', 'العلب', 'حبات/علبة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function tollDeliveryTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند تسليم منفوخ (نفخ للغير)'],
    meta(doc, `${doc.invoice_number ? `<b>فاتورة الأجرة:</b> ${esc(doc.invoice_number)} &nbsp;` : ''}`)
    + tableHtml(['#', 'الصنف', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function scrapTemplate(doc, settings) {
  const disp = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' }[doc.disposition] || doc.disposition;
  const rows = [[`${esc(doc.item_code)} ${esc(doc.item_name)}`, disp, num(doc.pieces), fmt(doc.weight_kg, 2),
    doc.price != null ? money(doc.price, settings) : '—']];
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند تالف ومصيره'],
    meta(doc, `${doc.warehouse_name ? `<b>المخزن:</b> ${esc(doc.warehouse_name)} &nbsp;` : ''}`)
    + tableHtml(['الصنف', 'المصير', 'الحبات', 'الوزن كجم', 'السعر'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function transferTemplate(doc, settings) {
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`,
    bucketCell(r.bucket), fmt(r.quantity, 3), esc(r.unit), num(r.pieces), fmt(r.weight_kg, 2)]);
  return docShell([settings.factory_name || 'سام بلاستيك', 'سند نقل بين المخازن'],
    meta(doc, `<b>من:</b> ${esc(doc.from_name)} &nbsp; <b>إلى:</b> ${esc(doc.to_name)} &nbsp;`)
    + tableHtml(['#', 'الصنف', 'السلة', 'الكمية', 'الوحدة', 'الحبات', 'الوزن كجم'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function returnTemplate(doc, settings) {
  const isSale = doc.type !== 'purchase';
  const rows = (doc.items || []).map((r, i) => [i + 1, `${esc(r.code)} ${esc(r.name)}`, esc(r.warehouse_name),
    fmt(r.quantity, 3), esc(r.unit), bucketCell(r.bucket), money(r.unit_price, settings), money(r.total_price, settings)]);
  const total = (doc.items || []).reduce((s, r) => s + (r.total_price || 0), 0);
  rows.push(['', 'الإجمالي', '', '', '', '', '', `<b>${money(total, settings)}</b>`]);
  return docShell([settings.factory_name || 'سام بلاستيك', isSale ? 'مرتجع بيع' : 'مرتجع شراء'],
    meta(doc, `${isSale ? (doc.invoice_number ? `<b>فاتورة البيع:</b> ${esc(doc.invoice_number)} &nbsp;` : '') : (doc.purchase_number ? `<b>فاتورة الشراء:</b> ${esc(doc.purchase_number)} &nbsp;` : '')}`)
    + tableHtml(['#', 'الصنف', 'المخزن', 'الكمية', 'الوحدة', 'السلة', 'السعر', 'الإجمالي'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function paymentTemplate(doc, settings) {
  const isIn = doc.direction === 'in';
  const rows = [
    [doc.party_name ? esc(doc.party_name) : '—', isIn ? 'قبض (نقد وارد)' : 'دفع (نقد صادر)', money(doc.amount, settings)],
    ['', 'الإجمالي', `<b>${money(doc.amount, settings)}</b>`],
  ];
  return docShell([settings.factory_name || 'سام بلاستيك', isIn ? 'سند قبض' : 'سند دفع'],
    meta(doc) + tableHtml(['الطرف', 'النوع', 'المبلغ'], rows)
    + `<div class="notes">ملاحظات: ${esc(doc.notes || '')}</div>`, settings.doc_page_size, true, settings);
}

function reportTemplate(settings, title, metaLines, headers, rows, foot = '') {
  return docShell([settings.factory_name || 'سام بلاستيك', title],
    `<div class="meta">${metaLines.map(esc).join(' &nbsp; ')}</div>${tableHtml(headers, rows)}${foot}`,
    settings.report_page_size || 'A4', false, settings);
}

// دليل المستخدم: صفحة غنية بأقسام وخطوات — تُطبع على A4
function guideTemplate(settings, bodyHtml) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">
  <style>
    @page { size: ${settings.report_page_size || 'A4'}; margin: 12mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px; color: #0f172a; margin: 0; line-height: 1.95; }
    .g-head { background: linear-gradient(135deg, #1e3a8a, #3450b8); color: #fff; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
    .g-head h1 { margin: 0 0 6px; font-size: 22px; text-align: center; }
    .g-head p { margin: 0; text-align: center; opacity: .95; font-size: 13px; }
    h2 { color: #1e3a8a; border-right: 4px solid #d9a441; padding-right: 10px; margin: 22px 0 8px; font-size: 17px; }
    h3 { color: #3450b8; margin: 14px 0 6px; font-size: 14.5px; }
    ol { margin: 6px 0; padding-right: 24px; }
    li { margin-bottom: 4px; }
    .g-tip { background: #fef9ec; border: 1px solid #f3ddb0; border-right: 4px solid #d9a441; border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
    .g-contact { background: linear-gradient(135deg, #f8f4ea, #fdf6e3); border: 2px solid #d9a441; border-radius: 12px; padding: 16px 18px; margin-top: 24px; text-align: center; }
    .g-contact b { color: #7c5a10; font-size: 15px; }
  </style></head><body>
  <div class="g-head"><h1>دليل المستخدم الكامل</h1><p>${esc(settings.factory_name || 'سام بلاستيك')} — نظام إدارة مصنع نفخ العبوات البلاستيكية</p></div>
  ${bodyHtml}
  </body></html>`;
}

module.exports = {
  purchaseTemplate, issueTemplate, invoiceTemplate, exitTemplate,
  tollReceiptTemplate, tollDeliveryTemplate, scrapTemplate, transferTemplate,
  productionReceiptTemplate,
  paymentTemplate, returnTemplate, reportTemplate, guideTemplate,
};
