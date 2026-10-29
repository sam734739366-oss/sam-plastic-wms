const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { suggestNumber, checkDocNumber } = require('../docs');
const docDelete = require('../docDelete');
const ledger = require('../ledger');

// سند القبض/الدفع: دفتر نقدي وذمم فقط — بلا أي حركة مخزون، فالحذف يمح قيده من الدفتر
// ولا يمسّ العدّادات. لا شيء يتفرع إلى السند، لذا حذفه مباشر.
const PAYMENT_SPEC = {
  table: 'payments',
  moveTypes: [],
  ledgerType: 'payment',
  auditEntity: 'payment',
  value: (db, id) => db.prepare('SELECT COALESCE(amount,0) a FROM payments WHERE id=?').get(id).a,
  deps: [],
};

// سندات القبض والدفع النقدي:
// قبض (in): يخفض ذمة العميل ويضيف للنقدية — دفع (out): يخفض ذمتنا للمورد ويخصم من النقدية
module.exports = function register(ipcMain) {
  ipcMain.handle('payments:suggest', () => suggestNumber(getDb(), 'payments'));

  ipcMain.handle('payments:list', () => {
    const db = getDb();
    return db.prepare(`SELECT py.*, pa.name party_name
      FROM payments py LEFT JOIN parties pa ON pa.id=py.party_id
      ORDER BY py.id DESC`).all();
  });

  ipcMain.handle('payments:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT py.*, pa.name party_name FROM payments py
      LEFT JOIN parties pa ON pa.id=py.party_id WHERE py.id=?`).get(id);
    if (!doc) throw new Error('السند غير موجود');
    return doc;
  });

  ipcMain.handle('payments:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.party_id) throw new Error('اختر الطرف (عميل/مورد)');
    const amount = Number(doc.amount) || 0;
    if (amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
    if (!['in', 'out'].includes(doc.direction)) throw new Error('نوع السند غير صالح');
    if (!checkDocNumber(db, 'payments', number, doc.id)) throw new Error('رقم السند مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM payments WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      if (id) {
        db.prepare('UPDATE payments SET doc_number=?, doc_date=?, party_id=?, direction=?, amount=?, notes=? WHERE id=?')
          .run(number, doc.doc_date, doc.party_id, doc.direction, amount, doc.notes || null, id);
      } else {
        id = db.prepare('INSERT INTO payments (doc_number, doc_date, party_id, direction, amount, notes, created_by) VALUES (?,?,?,?,?,?,?)')
          .run(number, doc.doc_date, doc.party_id, doc.direction, amount, doc.notes || null, userId).lastInsertRowid;
      }
      // الأثر المحاسبي: القبض يخفض ذمة الطرف ويزيد النقدية، والدفع عكسه
      ledger.deleteDoc(db, 'payment', id);
      if (doc.direction === 'in') {
        ledger.write(db, {
          party_id: doc.party_id, doc_type: 'payment', doc_id: id,
          doc_number: number, doc_date: doc.doc_date,
          side: 'credit', amount,
          cash_in: amount, cash_out: 0,
          notes: `سند قبض ${doc.notes ? `— ${doc.notes}` : ''}`.trim(),
        }, userId);
      } else {
        ledger.write(db, {
          party_id: doc.party_id, doc_type: 'payment', doc_id: id,
          doc_number: number, doc_date: doc.doc_date,
          side: 'debit', amount,
          cash_in: 0, cash_out: amount,
          notes: `سند دفع ${doc.notes ? `— ${doc.notes}` : ''}`.trim(),
        }, userId);
      }
    });
    audit(db, userId, isNew ? 'create' : 'update', 'payment', id, before, doc);
    return { id };
  });

  ipcMain.handle('payments:impact', (e, id) => docDelete.impact(getDb(), PAYMENT_SPEC, id));

  ipcMain.handle('payments:delete', (e, id, userId) => docDelete.hardDelete(getDb(), PAYMENT_SPEC, id, userId));
};
