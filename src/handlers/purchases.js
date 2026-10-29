const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber, nextCartonNumbers } = require('../docs');
const ledger = require('../ledger');

module.exports = function register(ipcMain) {
  ipcMain.handle('purchases:suggest', () => suggestNumber(getDb(), 'purchases'));

  ipcMain.handle('purchases:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, pa.name party_name,
      (SELECT COALESCE(SUM(total_price),0) FROM purchase_items WHERE purchase_id=p.id) total,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id=p.id) items_count
      FROM purchases p LEFT JOIN parties pa ON pa.id=p.party_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('purchases:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, pa.name party_name FROM purchases p
      LEFT JOIN parties pa ON pa.id=p.party_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('الفاتورة غير موجودة');
    doc.items = db.prepare(`SELECT pi.*, i.code, i.name, i.weight_grams, i.pieces_per_carton,
        i.pieces_per_shadda, i.pieces_per_bag, i.unit_name, w.name warehouse_name
      FROM purchase_items pi JOIN items i ON i.id=pi.item_id JOIN warehouses w ON w.id=pi.warehouse_id
      WHERE pi.purchase_id=? ORDER BY pi.id`).all(id);
    doc.cartons = db.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY carton_number').all(id);
    return doc;
  });

  ipcMain.handle('purchases:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم الفاتورة مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!checkDocNumber(db, 'purchases', number, doc.id)) throw new Error('رقم الفاتورة مكرر');
    const paymentMethod = doc.payment_method === 'cash' ? 'cash' : 'credit';
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM purchases WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        const issued = db.prepare(`SELECT COUNT(*) c FROM cartons WHERE purchase_id=? AND status != 'in_stock'`).get(id).c;
        if (issued > 0) throw new Error('يوجد كراتين من هذه الفاتورة صُرفت للإنتاج — ألغِ تصريح الصرف أولاً قبل التعديل');
        oldItems = db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(id);
        db.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(id);
        db.prepare('DELETE FROM cartons WHERE purchase_id=?').run(id);
        db.prepare('UPDATE purchases SET doc_number=?, doc_date=?, party_id=?, notes=?, payment_method=? WHERE id=?')
          .run(number, doc.doc_date, doc.party_id || null, doc.notes || null, paymentMethod, id);
      } else {
        id = db.prepare('INSERT INTO purchases (doc_number, doc_date, party_id, notes, payment_method, created_by) VALUES (?,?,?,?,?,?)')
          .run(number, doc.doc_date, doc.party_id || null, doc.notes || null, paymentMethod, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO purchase_items
        (purchase_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const pieces = toPieces(it.quantity, it.unit, item);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg,
          it.unit_price || null, (it.unit_price || 0) * it.quantity, it.notes || null, bucket);
        moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes });
      }
      writeMoves(db, 'purchase', id, number, doc.doc_date, moves, userId);
      // أرصدة سليم/تالف/محرز: الشراء يزيد سلة كل بند (وعكس القديم عند التعديل)
      if (oldItems.length) applyBucketsDelta(db, oldItems, -1);
      applyBucketsDelta(db, moves, 1);
      const insCarton = db.prepare(`INSERT INTO cartons (carton_number, item_id, purchase_id, pieces) VALUES (?,?,?,?)`);
      for (const it of doc.items) {
        if (it.unit !== 'كرتون') continue;
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item.pieces_per_carton) continue;
        const prefix = String(it.carton_prefix || '').trim();
        const count = Math.round(it.quantity);
        const nums = nextCartonNumbers(db, prefix, count);
        for (const n of nums) insCarton.run(n, item.id, id, item.pieces_per_carton);
      }
      // الأثر المحاسبي: ذمة للمورد + دفع نقدي إن كانت نقدية
      const total = db.prepare(`SELECT COALESCE(SUM(total_price),0) t FROM purchase_items WHERE purchase_id=?`).get(id).t;
      ledger.invoiceEffect(db, { docType: 'purchase', doc: { ...doc, id, payment_method: paymentMethod }, total, userId });
    });
    audit(db, userId, isNew ? 'create' : 'update', 'purchase', id, before, doc);
    return { id };
  });

  ipcMain.handle('purchases:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
    if (!before) throw new Error('الفاتورة غير موجودة');
    const issued = db.prepare(`SELECT COUNT(*) c FROM cartons WHERE purchase_id=? AND status != 'in_stock'`).get(id).c;
    if (issued > 0) throw new Error('يوجد كراتين من هذه الفاتورة صُرفت للإنتاج — ألغِ تصريح الصرف أولاً');
    const returned = db.prepare(`SELECT COUNT(*) c FROM purchase_returns WHERE purchase_id=? AND status='active'`).get(id).c;
    if (returned > 0) throw new Error('لا يمكن إلغاء الفاتورة — توجد مرتجعات نشطة عليها، ألغِ المرتجع أولاً');
    const oldItems = db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(id);
    withTransaction(db, () => {
      db.prepare('DELETE FROM cartons WHERE purchase_id=?').run(id);
      voidDoc(db, 'purchase', id, userId);
      applyBucketsDelta(db, oldItems, -1);
      ledger.voidDoc(db, 'purchase', id);
      db.prepare(`UPDATE purchases SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'purchase', id, before, null);
    return { ok: true };
  });
};
