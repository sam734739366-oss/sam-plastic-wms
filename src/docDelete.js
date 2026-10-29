// ===== طبقة الحذف الفعلي المشتركة (v2) =====
// كل مستند مخزني يُعرَّف بمواصفاته هنا، فتمر عملية الحذف بمسار واحد:
//   1) فحص المستندات الأحدث المرتبطة به → منع برسالة تذكر أرقامها
//   2) ردّ عدّادات السلات من صافي حركاته
//   3) محو حركات المخزون وقيود الدفتر ثم صفوف المستند (البند يتبعه ON DELETE CASCADE)
// لا يوجد «إلغاء» في النظام بعد اليوم: ما يُحذف يُمحى، وما يُمحى يُردّ أثره في نفس اللحظة.
const { docImpact, revertMoves } = require('./stock');
const { audit } = require('./audit');
const { withTransaction } = require('./db');

const BUCKET_LABEL = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };

// deps: دوال تُرجع [{ label, number }] — كل صفة تعني سبباً للمنع
function collectDeps(db, spec, id) {
  const out = [];
  for (const fn of (spec.deps || [])) out.push(...fn(db, id));
  return out.filter(Boolean);
}

function depsMessage(deps) {
  const lines = deps.map((d) => `• ${d.label}${d.number ? ' ' + d.number : ''}`);
  return `لا يمكن حذف المستند — مرتبط بمستندات أحدث:\n${lines.join('\n')}\nاحذف الأحدث أولاً ثم أعد المحاولة.`;
}

// ما سيحدث عند الحذف، بصيغة يعرضها التطبيق في نافذة التأكيد
function impact(db, spec, id) {
  const doc = db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(id);
  if (!doc) throw new Error('المستند غير موجود');
  const rows = spec.moveTypes
    ? spec.moveTypes.flatMap((t) => docImpact(db, t, id))
    : docImpact(db, spec.docType, id);
  const value = spec.value ? spec.value(db, id) : null;
  return {
    doc_number: doc.doc_number || null,
    impact: rows,
    value,
    deps: collectDeps(db, spec, id),
    blocked: false,
  };
}

function hardDelete(db, spec, id, userId) {
  const doc = db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(id);
  if (!doc) throw new Error('المستند غير موجود');
  const deps = collectDeps(db, spec, id);
  if (deps.length) { const e = new Error(depsMessage(deps)); e.code = 'DEPENDENTS'; throw e; }

  const moveTypes = spec.moveTypes || [spec.docType];
  let reverted = [];
  withTransaction(db, () => {
    for (const t of moveTypes) {
      const moves = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(t, id);
      reverted = reverted.concat(revertMoves(db, moves, -1));
      db.prepare('DELETE FROM stock_moves WHERE doc_type=? AND doc_id=?').run(t, id);
    }
    for (const lt of (spec.ledgerTypes || (spec.ledgerType ? [spec.ledgerType] : []))) {
      db.prepare('DELETE FROM party_ledger WHERE doc_type=? AND doc_id=?').run(lt, id);
    }
    if (spec.beforeDelete) spec.beforeDelete(db, id, doc);
    db.prepare(`DELETE FROM ${spec.table} WHERE id=?`).run(id);
    if (spec.afterDelete) spec.afterDelete(db, id, doc);
  });
  audit(db, userId, 'delete', spec.auditEntity || spec.table, id, doc, null);
  return { ok: true, deleted: spec.table, doc_number: doc.doc_number || null, reverted: reverted.length };
}

module.exports = { impact, hardDelete, collectDeps, depsMessage, BUCKET_LABEL };
