const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

module.exports = function register(ipcMain) {
  ipcMain.handle('receives:suggest', () => suggestNumber(getDb(), 'receive_permits'));

  ipcMain.handle('receives:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, m.name machine_name, s.name shift_name, pa.name party_name, ip.doc_number issue_number,
      (SELECT COUNT(*) FROM receive_items WHERE receive_permit_id=p.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM receive_items WHERE receive_permit_id=p.id) total_pieces
      FROM receive_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id
      LEFT JOIN issue_permits ip ON ip.id=p.issue_permit_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('receives:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, m.name machine_name, s.name shift_name, pa.name party_name, ip.doc_number issue_number
      FROM receive_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id
      LEFT JOIN issue_permits ip ON ip.id=p.issue_permit_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('التصريح غير موجود');
    doc.items = db.prepare(`SELECT ri.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name,
        w.name warehouse_name
      FROM receive_items ri JOIN items i ON i.id=ri.item_id JOIN warehouses w ON w.id=ri.warehouse_id
      WHERE ri.receive_permit_id=? ORDER BY ri.id`).all(id);
    return doc;
  });

  ipcMain.handle('receives:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم التصريح مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!['own', 'customer'].includes(doc.source)) throw new Error('المصدر غير صالح');
    if (doc.source === 'customer' && !doc.party_id) throw new Error('اختر العميل عند الاستلام من خام عميل');
    if (!checkDocNumber(db, 'receive_permits', number, doc.id)) throw new Error('رقم التصريح مكرر');
    // ربط اختياري بتصريح الصرف لمتابعة دورة الكراتين (يجب أن يكون تصريحاً نشطاً)
    const issueId = doc.issue_permit_id ? Number(doc.issue_permit_id) : null;
    if (issueId) {
      const issue = db.prepare(`SELECT id FROM issue_permits WHERE id=? AND status='active'`).get(issueId);
      if (!issue) throw new Error('تصريح الصرف المرتبط غير موجود أو ملغى');
    }
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM receive_permits WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        oldItems = db.prepare('SELECT * FROM receive_items WHERE receive_permit_id=?').all(id);
        db.prepare('DELETE FROM receive_items WHERE receive_permit_id=?').run(id);
        db.prepare(`UPDATE receive_permits SET doc_number=?, doc_date=?, machine_id=?, shift_id=?, receiver_name=?, source=?, party_id=?, issue_permit_id=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.machine_id || null, doc.shift_id || null,
            doc.receiver_name || null, doc.source, doc.party_id || null, issueId, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO receive_permits (doc_number, doc_date, machine_id, shift_id, receiver_name, source, party_id, issue_permit_id, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.machine_id || null, doc.shift_id || null,
            doc.receiver_name || null, doc.source, doc.party_id || null, issueId, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO receive_items
        (receive_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        if (doc.source === 'own') {
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes });
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, it.notes || null, bucket);
      }
      writeMoves(db, 'receive', id, number, doc.doc_date, moves, userId);
      // استلام إنتاج المصنع يزيد سلة كل بند (وعكس القديم عند التعديل — وخام العميل بلا أثر مخزني)
      if (oldItems.length && before.source === 'own') applyBucketsDelta(db, oldItems, -1);
      applyBucketsDelta(db, moves, 1);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'receive_permit', id, before, doc);
    return { id };
  });

  ipcMain.handle('receives:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM receive_permits WHERE id=?').get(id);
    if (!before) throw new Error('التصريح غير موجود');
    const oldItems = db.prepare('SELECT * FROM receive_items WHERE receive_permit_id=?').all(id);
    withTransaction(db, () => {
      voidDoc(db, 'receive', id, userId);
      if (before.source === 'own') applyBucketsDelta(db, oldItems, -1);
      db.prepare(`UPDATE receive_permits SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'receive_permit', id, before, null);
    return { ok: true };
  });
};
