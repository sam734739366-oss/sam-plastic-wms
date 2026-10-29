function suggestNumber(db, table) {
  const row = db.prepare(`SELECT doc_number FROM ${table}
    WHERE doc_number GLOB '[0-9]*' ORDER BY CAST(doc_number AS INTEGER) DESC, doc_number DESC LIMIT 1`).get();
  if (!row) return '1';
  const n = parseInt(row.doc_number, 10);
  return Number.isNaN(n) ? '' : String(n + 1);
}

function checkDocNumber(db, table, number, excludeId = null) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE doc_number = ?`).get(number);
  return !row || (excludeId !== null && row.id === excludeId);
}

// ترقيم الكراتين المتسلسل داخل بادئة واحدة: مشتريات المصنع وكراتين خام العميل
// يتقاسمان الجدول نفسه، فالدالة مشتركة حتى لا يتصادم ترقيم مصدرين مختلفين.
function nextCartonNumbers(db, prefix, count) {
  const rows = db.prepare(`SELECT carton_number FROM cartons WHERE carton_number LIKE ? || '%'`).all(prefix);
  let max = 0;
  for (const r of rows) {
    const m = String(r.carton_number).slice(prefix.length).match(/^\d+/);
    if (m) max = Math.max(max, parseInt(m[0], 10));
  }
  const nums = [];
  for (let i = 1; i <= count; i++) nums.push(`${prefix}${max + i}`);
  return nums;
}

module.exports = { suggestNumber, checkDocNumber, nextCartonNumbers };
