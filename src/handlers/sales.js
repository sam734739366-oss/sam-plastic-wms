const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

const TYPE_LABEL = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' };
const TYPE_GROUP = { sale: 2, scrap: 5, blowing_fee: 4 };

module.exports = function register(ipcMain) {
  ipcMain.handle('sales:suggest', () => suggestNumber(getDb(), 'invoices'));

  ipcMain.handle('sales:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, pa.name party_name,
      (SELECT COALESCE(SUM(total_price),0) FROM invoice_items WHERE invoice_id=p.id) total,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id=p.id) items_count
      FROM invoices p LEFT JOIN parties pa ON pa.id=p.party_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('sales:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, pa.name party_name FROM invoices p
      LEFT JOIN parties pa ON pa.id=p.party_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('الفاتورة غير موجودة');
    doc.items = db.prepare(`SELECT pi.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name, i.item_group,
        w.name warehouse_name
      FROM invoice_items pi JOIN items i ON i.id=pi.item_id JOIN warehouses w ON w.id=pi.warehouse_id
      WHERE pi.invoice_id=? ORDER BY pi.id`).all(id);
    return doc;
  });

  ipcMain.handle('sales:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم الفاتورة مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!TYPE_GROUP[doc.invoice_type]) throw new Error('نوع الفاتورة غير صالح');
    if (!checkDocNumber(db, 'invoices', number, doc.id)) throw new Error('رقم الفاتورة مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM invoices WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      if (id) {
        db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
        db.prepare(`UPDATE invoices SET doc_number=?, doc_date=?, party_id=?, invoice_type=?, driver_name=?, car_number=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.party_id || null, doc.invoice_type,
            doc.driver_name || null, doc.car_number || null, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO invoices (doc_number, doc_date, party_id, invoice_type, driver_name, car_number, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.party_id || null, doc.invoice_type,
            doc.driver_name || null, doc.car_number || null, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO invoice_items
        (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const expectedGroup = TYPE_GROUP[doc.invoice_type];
        if (item.item_group !== expectedGroup) {
          throw new Error(`الصنف ${item.code} لا يناسب ${TYPE_LABEL[doc.invoice_type]} — اختر صنفاً من المجموعة ${String(expectedGroup).padStart(3, '0')}`);
        }
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const price = Number(it.unit_price) || 0;
        if (doc.invoice_type !== 'blowing_fee') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          if (bal.balance_pieces < pieces) throw new Error(`الرصيد غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${bal.balance_pieces})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, notes: it.notes });
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, price, price * it.quantity, it.notes || null);
      }
      writeMoves(db, 'invoice', id, number, doc.doc_date, moves, userId);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'invoice', id, before, doc);
    return { id };
  });

  ipcMain.handle('sales:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!before) throw new Error('الفاتورة غير موجودة');
    const linked = db.prepare(`SELECT COUNT(*) c FROM customer_deliveries WHERE invoice_id=? AND status='active'`).get(id).c;
    if (linked > 0) throw new Error('لا يمكن إلغاء الفاتورة — مرتبطة بسند تسليم نشط، ألغِ التسليم أولاً');
    withTransaction(db, () => {
      voidDoc(db, 'invoice', id, userId);
      db.prepare(`UPDATE invoices SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'invoice', id, before, null);
    return { ok: true };
  });
};
