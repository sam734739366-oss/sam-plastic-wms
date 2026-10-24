const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

module.exports = function register(ipcMain) {
  ipcMain.handle('issues:suggest', () => suggestNumber(getDb(), 'issue_permits'));

  ipcMain.handle('issues:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, m.name machine_name, s.name shift_name, pa.name party_name,
      (SELECT COUNT(*) FROM issue_items WHERE issue_permit_id=p.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM issue_items WHERE issue_permit_id=p.id) total_pieces
      FROM issue_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('issues:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, m.name machine_name, s.name shift_name, pa.name party_name
      FROM issue_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('التصريح غير موجود');
    doc.items = db.prepare(`SELECT ii.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name,
        w.name warehouse_name
      FROM issue_items ii JOIN items i ON i.id=ii.item_id JOIN warehouses w ON w.id=ii.warehouse_id
      WHERE ii.issue_permit_id=? ORDER BY ii.id`).all(id);
    for (const it of doc.items) {
      it.carton_ids = it.carton_ids ? JSON.parse(it.carton_ids) : [];
    }
    doc.cartons = db.prepare(`SELECT c.* FROM cartons c WHERE c.issue_permit_id=? ORDER BY c.carton_number`).all(id);
    return doc;
  });

  ipcMain.handle('issues:cartonsAvailable', (e, itemId) => {
    const db = getDb();
    return db.prepare(`SELECT c.*, p.doc_number purchase_number FROM cartons c
      LEFT JOIN purchases p ON p.id=c.purchase_id
      WHERE c.item_id=? AND c.status='in_stock' ORDER BY c.carton_number`).all(itemId);
  });

  ipcMain.handle('issues:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم التصريح مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!['own', 'customer'].includes(doc.source)) throw new Error('المصدر غير صالح');
    if (!checkDocNumber(db, 'issue_permits', number, doc.id)) throw new Error('رقم التصريح مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM issue_permits WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        const hasResults = db.prepare(`SELECT COUNT(*) c FROM production_results pr
          JOIN cartons c ON c.id=pr.carton_id WHERE c.issue_permit_id=?`).get(id).c;
        if (hasResults > 0) throw new Error('لا يمكن تعديل التصريح — توجد نتائج إنتاج مسجلة على كراتينه');
        const linkedRecv = db.prepare(`SELECT COUNT(*) c FROM receive_permits
          WHERE issue_permit_id=? AND status='active'`).get(id).c;
        if (linkedRecv > 0) throw new Error('لا يمكن تعديل التصريح — توجد تصاريح استلام مرتبطة به، ألغِها أولاً');
        oldItems = db.prepare('SELECT * FROM issue_items WHERE issue_permit_id=?').all(id);
        db.prepare(`UPDATE cartons SET status='in_stock', issue_date=NULL, issue_permit_id=NULL WHERE issue_permit_id=?`).run(id);
        db.prepare('DELETE FROM issue_items WHERE issue_permit_id=?').run(id);
        db.prepare(`UPDATE issue_permits SET doc_number=?, doc_date=?, machine_id=?, shift_id=?, receiver_name=?, source=?, party_id=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.machine_id || null, doc.shift_id || null,
            doc.receiver_name || null, doc.source, doc.party_id || null, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO issue_permits (doc_number, doc_date, machine_id, shift_id, receiver_name, source, party_id, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.machine_id || null, doc.shift_id || null,
            doc.receiver_name || null, doc.source, doc.party_id || null, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO issue_items
        (issue_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, carton_ids, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const issueCarton = db.prepare(`UPDATE cartons SET status='issued', issue_date=?, issue_permit_id=?
        WHERE carton_number=? AND status='in_stock'`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const cartonIds = (it.carton_ids || []).filter(Boolean);
        if (doc.source === 'own') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
          for (const cn of cartonIds) {
            const r = issueCarton.run(doc.doc_date, id, cn);
            if (r.changes === 0) throw new Error(`الكرتون ${cn} غير متاح في المخزن`);
          }
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg,
          cartonIds.length ? JSON.stringify(cartonIds) : null, it.notes || null, bucket);
      }
      writeMoves(db, 'issue', id, number, doc.doc_date, moves, userId);
      // أرصدة سليم/تالف/محرز: صرف المصنع يخصم سلة كل بند (وعكس القديم عند التعديل — وخام العميل بلا أثر مخزني)
      if (oldItems.length && before.source === 'own') applyBucketsDelta(db, oldItems, 1);
      applyBucketsDelta(db, moves, -1);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'issue_permit', id, before, doc);
    return { id };
  });

  ipcMain.handle('issues:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM issue_permits WHERE id=?').get(id);
    if (!before) throw new Error('التصريح غير موجود');
    const hasResults = db.prepare(`SELECT COUNT(*) c FROM production_results pr
      JOIN cartons c ON c.id=pr.carton_id WHERE c.issue_permit_id=?`).get(id).c;
    if (hasResults > 0) throw new Error('لا يمكن إلغاء التصريح — توجد نتائج إنتاج مسجلة على كراتينه، احذفها أولاً');
    const linkedRecv = db.prepare(`SELECT COUNT(*) c FROM receive_permits
      WHERE issue_permit_id=? AND status='active'`).get(id).c;
    if (linkedRecv > 0) throw new Error('لا يمكن إلغاء التصريح — توجد تصاريح استلام مرتبطة به، ألغِها أولاً');
    const oldItems = db.prepare('SELECT * FROM issue_items WHERE issue_permit_id=?').all(id);
    withTransaction(db, () => {
      db.prepare(`UPDATE cartons SET status='in_stock', issue_date=NULL, issue_permit_id=NULL WHERE issue_permit_id=?`).run(id);
      voidDoc(db, 'issue', id, userId);
      if (before.source === 'own') applyBucketsDelta(db, oldItems, 1);
      db.prepare(`UPDATE issue_permits SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'issue_permit', id, before, null);
    return { ok: true };
  });
};
