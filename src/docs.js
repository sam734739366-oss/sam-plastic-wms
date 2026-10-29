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

// ===== الحذف الفعلي (v2) =====
// لا حالة «ملغى»: المستند يُحذف هو وحركاته وقيوده وتُردّ عدّاداته فوراً.
// قبل الحذف يُفحص ما تفرّع عنه، فيُمنع برسالة تذكر أرقام المستندات الأحدث بالاسم.

// checks: [{ label, sql, params }] — كل استعلام يُرجع صفاً واحداً على الأقل = مانع
function dependencies(db, checks = []) {
  const found = [];
  for (const c of checks) {
    const rows = db.prepare(c.sql).all(...(c.params || []));
    for (const r of rows) {
      const number = r.doc_number ?? r.carton_number ?? r.number ?? '';
      found.push({ label: c.label, number });
    }
  }
  return found;
}

function assertNoDependencies(db, checks = []) {
  const deps = dependencies(db, checks);
  if (!deps.length) return;
  const lines = deps.map((d) => `• ${d.label}${d.number ? ' ' + d.number : ''}`);
  throw new Error(`لا يمكن الحذف — المستند مرتبط بمستندات أحدث:\n${lines.join('\n')}\nاحذف الأحدث أولاً ثم أعد المحاولة.`);
}

module.exports = { suggestNumber, checkDocNumber, nextCartonNumbers, dependencies, assertNoDependencies };
