const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, getBalance, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');
const docDelete = require('../docDelete');

// تصريح الخروج مستند نهائي: لا شيء يتفرع عنه، فالحذف مباشر.
// الحذف يردّ الخصم الذي أحدثه على سلات أصنافه ثم يمحو حركاته.
const EXIT_SPEC = {
  table: 'exit_permits',
  docType: 'exit',
  auditEntity: 'exit_permit',
  value: (db, id) => db.prepare('SELECT COALESCE(SUM(pieces),0) t FROM exit_items WHERE exit_permit_id=?').get(id).t,
  deps: [],
};

module.exports = function register(ipcMain) {
  ipcMain.handle('exits:suggest', () => suggestNumber(getDb(), 'exit_permits'));

  ipcMain.handle('exits:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, w.name warehouse_name,
      (SELECT COUNT(*) FROM exit_items WHERE exit_permit_id=p.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM exit_items WHERE exit_permit_id=p.id) total_pieces
      FROM exit_permits p LEFT JOIN warehouses w ON w.id=p.warehouse_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('exits:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, w.name warehouse_name FROM exit_permits p
      LEFT JOIN warehouses w ON w.id=p.warehouse_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('التصريح غير موجود');
    doc.items = db.prepare(`SELECT ei.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name,
        w.name warehouse_name
      FROM exit_items ei JOIN items i ON i.id=ei.item_id JOIN warehouses w ON w.id=ei.warehouse_id
      WHERE ei.exit_permit_id=? ORDER BY ei.id`).all(id);
    return doc;
  });

  ipcMain.handle('exits:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم التصريح مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!doc.driver_name || !doc.driver_name.trim()) throw new Error('اسم السائق مطلوب');
    if (!checkDocNumber(db, 'exit_permits', number, doc.id)) throw new Error('رقم التصريح مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM exit_permits WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        oldItems = db.prepare('SELECT * FROM exit_items WHERE exit_permit_id=?').all(id);
        db.prepare('DELETE FROM exit_items WHERE exit_permit_id=?').run(id);
        db.prepare(`UPDATE exit_permits SET doc_number=?, doc_date=?, warehouse_id=?, driver_name=?, car_number=?, destination=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.warehouse_id, doc.driver_name, doc.car_number || null,
            doc.destination || null, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO exit_permits (doc_number, doc_date, warehouse_id, driver_name, car_number, destination, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.warehouse_id, doc.driver_name, doc.car_number || null,
            doc.destination || null, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO exit_items
        (exit_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bal = getBalance(db, it.item_id, it.warehouse_id);
        const available = bal[`qty_${bucket}`] || 0;
        const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
        if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
        moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, it.notes || null, bucket);
      }
      writeMoves(db, 'exit', id, number, doc.doc_date, moves, userId);
      // الخروج يخصم سلة كل بند: عكس أثر البنود القديمة ثم تطبيق الجديدة
      if (oldItems.length) applyBucketsDelta(db, oldItems, 1);
      applyBucketsDelta(db, moves, -1);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'exit_permit', id, before, doc);
    return { id };
  });

  ipcMain.handle('exits:impact', (e, id) => docDelete.impact(getDb(), EXIT_SPEC, id));

  ipcMain.handle('exits:delete', (e, id, userId) => docDelete.hardDelete(getDb(), EXIT_SPEC, id, userId));
};
