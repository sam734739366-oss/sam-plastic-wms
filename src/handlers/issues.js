const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, getBalance, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');
const docDelete = require('../docDelete');

// تصريح الصرف هو مصدر كراتين الإنتاج: لا يُحذف إلا بعد حذف استلام الإنتاج المرتبط به،
// وعند الحذف تعود كراتينه إلى المخزن ويُردّ ما خُصم من سلات أصنافها.
const ISSUE_SPEC = {
  table: 'issue_permits',
  auditEntity: 'issue_permit',
  docType: 'issue',
  value: (db, id) => db.prepare('SELECT COALESCE(SUM(pieces),0) t FROM issue_items WHERE issue_permit_id=?').get(id).t,
  deps: [
    (db, id) => db.prepare('SELECT doc_number FROM production_receipts WHERE issue_permit_id=?')
      .all(id).map((r) => ({ label: 'استلام إنتاج', number: r.doc_number })),
    (db, id) => db.prepare(`SELECT c.carton_number FROM cartons c
      JOIN production_receipt_cartons rc ON rc.carton_id = c.id
      WHERE c.issue_permit_id=?`).all(id).map((r) => ({ label: 'كرتون أُنتج فعلاً', number: r.carton_number })),
  ],
  beforeDelete: (db, id) => {
    db.prepare(`UPDATE cartons SET status='in_stock', issue_date=NULL, issue_permit_id=NULL WHERE issue_permit_id=?`).run(id);
  },
};

module.exports = function register(ipcMain) {
  ipcMain.handle('issues:suggest', () => suggestNumber(getDb(), 'issue_permits'));

  ipcMain.handle('issues:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, m.name machine_name, s.name shift_name, pa.name party_name,
      (SELECT COUNT(*) FROM issue_items WHERE issue_permit_id=p.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM issue_items WHERE issue_permit_id=p.id) total_pieces,
      (SELECT COUNT(*) FROM production_receipts pr WHERE pr.issue_permit_id=p.id) receipts_count
      FROM issue_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id
      ORDER BY p.id DESC`).all();
  });

  // قوائم الانتظار: تصريحات مصروفة لم يُستلم إنتاجها بعد (هي ما تفتحه شاشة استلام الإنتاج)
  ipcMain.handle('issues:openForReceipt', () => {
    const db = getDb();
    return db.prepare(`SELECT p.id, p.doc_number, p.doc_date, p.source, p.party_id,
        m.name machine_name, s.name shift_name, pa.name party_name,
        (SELECT COALESCE(SUM(pieces),0) FROM issue_items WHERE issue_permit_id=p.id) issued_pieces,
        (SELECT COUNT(*) FROM cartons c WHERE c.issue_permit_id=p.id) cartons_count,
        (SELECT COUNT(*) FROM cartons c WHERE c.issue_permit_id=p.id AND c.status='issued') pending_cartons
      FROM issue_permits p
      LEFT JOIN machines m ON m.id=p.machine_id
      LEFT JOIN shifts s ON s.id=p.shift_id
      LEFT JOIN parties pa ON pa.id=p.party_id
      WHERE EXISTS (SELECT 1 FROM cartons c WHERE c.issue_permit_id=p.id AND c.status='issued')
      ORDER BY p.doc_date, p.id`).all();
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
    doc.cartons = db.prepare(`SELECT c.*, i.code item_code, i.name item_name, i.unit_name
      FROM cartons c JOIN items i ON i.id=c.item_id
      WHERE c.issue_permit_id=? ORDER BY c.carton_number`).all(id);
    return doc;
  });

  ipcMain.handle('issues:cartonsAvailable', (e, itemId, source, partyId) => {
    const db = getDb();
    // كراتين المصنع وكراتين خام العميل لا تُخلط في قائمة الاختيار:
    // كرتونة العميل تظهر على تصريح نفس العميل فقط، وإلا تُخصم من رصيد عميل آخر.
    if (source === 'customer') {
      if (!partyId) return [];
      return db.prepare(`SELECT c.*, r.doc_number AS receipt_number FROM cartons c
        LEFT JOIN customer_raw_receipts r ON r.id=c.receipt_id
        WHERE c.item_id=? AND c.status='in_stock' AND c.source='customer' AND c.party_id=?
        ORDER BY c.carton_number`).all(itemId, partyId);
    }
    return db.prepare(`SELECT c.*, p.doc_number AS purchase_number FROM cartons c
      LEFT JOIN purchases p ON p.id=c.purchase_id
      WHERE c.item_id=? AND c.status='in_stock' AND COALESCE(c.source,'own')='own'
      ORDER BY c.carton_number`).all(itemId);
  });

  ipcMain.handle('issues:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم التصريح مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!['own', 'customer'].includes(doc.source)) throw new Error('المصدر غير صالح');
    // تصاريح خام العميل تُوجّه التالف لرصيد العميل لاحقاً — بلا عميل لا يعرف النظام أين يخصم
    if (doc.source === 'customer' && !doc.party_id) throw new Error('اختر العميل عند الصرف من خام عميل');
    if (!checkDocNumber(db, 'issue_permits', number, doc.id)) throw new Error('رقم التصريح مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM issue_permits WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        const deps = docDelete.collectDeps(db, ISSUE_SPEC, id);
        if (deps.length) throw new Error(docDelete.depsMessage(deps));
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
        WHERE carton_number=? AND status='in_stock' AND source=? AND (source='own' OR party_id=?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
        const cartonIds = (it.carton_ids || []).filter(Boolean);
        let pieces = toPieces(it.quantity, it.unit, item);
        // عند اختيار كراتين فالعبرة بحباتها الفعلية لا بعددها × «حبات/كرتون»:
        // آخر كرتونة من خام العميل قد تكون ناقصة، فالحساب بالعدد يُبالغ في الكمية.
        if (cartonIds.length) {
          const marks = cartonIds.map(() => '?').join(',');
          const found = db.prepare(`SELECT carton_number, pieces FROM cartons
            WHERE carton_number IN (${marks}) AND status='in_stock' AND source=?`)
            .all(...cartonIds, doc.source);
          if (found.length !== cartonIds.length) {
            const have = new Set(found.map(c => c.carton_number));
            const missing = cartonIds.filter(cn => !have.has(cn)).join('، ');
            throw new Error(`الكرتون ${missing} غير متاح في المخزن`);
          }
          pieces = found.reduce((s, c) => s + (Number(c.pieces) || 0), 0);
        }
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        if (doc.source === 'own') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        }
        // الكراتين تُصرف في الحالتين: فرق المصدر في الأثر المخزني لا في توثيق الكراتين،
        // فخرطوم الإنتاج يحتاج الكرتون ليتتبّع النتيجة (وتالف خام العميل يُنسب لصاحبه).
        for (const cn of cartonIds) {
          const r = issueCarton.run(doc.doc_date, id, cn, doc.source, doc.party_id || null);
          if (r.changes === 0) {
            throw new Error(doc.source === 'own'
              ? `الكرتون ${cn} غير متاح في المخزن`
              : `الكرتون ${cn} غير متاح لكرتونات خام هذا العميل`);
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

  ipcMain.handle('issues:impact', (e, id) => docDelete.impact(getDb(), ISSUE_SPEC, id));

  ipcMain.handle('issues:delete', (e, id, userId) => docDelete.hardDelete(getDb(), ISSUE_SPEC, id, userId));
};
