// ===== استلام الإنتاج — المستند الموحّد (v2) =====
// يدمج «نتيجة الإنتاج» و«استلام التام» في شاشة واحدة: يُختار تصريح الصرف فتظهر كراتينه،
// ويُدخل للمشغّل سليم/تالف قبل/تالف بعد لكل كرتون. الحساب بالحبة دائماً، والتوزيع تلقائي:
//   سليم (+الفائض) → تام سليم   |   تالف بعد → تام تالف   |   تالف قبل → خام تالف
//   عجز (مصروف > منتج) → يُسجَّل في الفارق بلا حركة مخزون
// وكراتين خام العميل (النفخ للغير) لا تمسّ سلات المصنع: تالفها يُنسب لصاحبه في سند تالف آلي.
const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { piecesToWeightKg } = require('../units');
const { bucketsDelta, getBalance, writeMoves, revertMoves, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');
const docDelete = require('../docDelete');

const DEFECT_DISP = 'production_defect';

// ===== حساب الأكياس: quantity = الأكياس المكتملة، و breaks = الحبات المفردة بعدها =====
function bagMath(item, bags, breaks) {
  const per = Number(item.pieces_per_bag) || 0;
  if (per <= 0) throw new Error(`الصنف ${item.code} ليس له «عدد القطع في الكيس» — أضفه من شاشة الأصناف أو اترك الأكياس فارغة`);
  const loose = Math.max(0, Math.round(Number(breaks) || 0));
  const full = Math.max(0, Math.round(Number(bags) || 0));
  const total = full * per + loose;
  return { pieces: total, breaks: loose, usedBags: Math.ceil(total / per) };
}

// أكياس التغليف ملك المصنع وتُستهلك في الحالتين: إنتاج المصنع وخام العميل على السواء.
// اتجاهها معاكس لبنود الصنف في نفس المستند، لذلك تُخصَّم هنا لا في applyBucketsDelta.
function applyBagDelta(db, row, sign) {
  const bags = Number(row.bags_used) || 0;
  if (!row.bag_item_id || bags <= 0) return;
  bucketsDelta(db, Number(row.bag_item_id), { salem: sign * bags });
}

function assertBagStock(db, bagItem, warehouseId, need) {
  const avail = getBalance(db, bagItem.id, warehouseId).qty_salem || 0;
  if (avail < need) {
    throw new Error(`رصيد الأكياس غير كافٍ (المطلوب ${need} والمتوفر ${avail}) لصنف الأكياس ${bagItem.code}`);
  }
}

function defectDocNumber(db, receiptNumber) {
  let n = `تالف إنتاج ${receiptNumber}`;
  for (let i = 2; !checkDocNumber(db, 'scrap_movements', n); i++) n = `تالف إنتاج ${receiptNumber}-${i}`;
  return n;
}

// سند التالف الآلي لخام العميل: يُحدَّث مع كل تعديل ويُمحى مع المستند (CASCADE)،
// فيعود رصيد العميل كاملاً بلا أي تدخل يدوي.
function syncCustomerDefectScrap(db, { receiptId, docNumber, docDate, partyId, rawItemId, defects, userId }) {
  const existing = db.prepare('SELECT * FROM scrap_movements WHERE prod_receipt_id=?').get(receiptId);
  if (defects <= 0) {
    if (existing) db.prepare('DELETE FROM scrap_movements WHERE id=?').run(existing.id);
    return;
  }
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(rawItemId);
  const wkg = defects * (Number(item && item.weight_grams) || 0) / 1000;
  const notes = `تالف استلام الإنتاج ${docNumber} — عهدة العميل`;
  if (existing) {
    db.prepare(`UPDATE scrap_movements SET doc_date=?, item_id=?, pieces=?, weight_kg=?, party_id=?, notes=? WHERE id=?`)
      .run(docDate, rawItemId, defects, wkg, partyId, notes, existing.id);
    return;
  }
  db.prepare(`INSERT INTO scrap_movements
      (doc_number, doc_date, item_id, disposition, warehouse_id, party_id,
       pieces, weight_kg, price, talef_take, salem_take, is_customer, notes, created_by, prod_receipt_id)
      VALUES (?,?,?,?,NULL,?,?,?,NULL,0,0,1,?,?,?)`)
    .run(defectDocNumber(db, docNumber), docDate, rawItemId, DEFECT_DISP, partyId,
      defects, wkg, notes, userId, receiptId);
}

const RECEIPT_SPEC = {
  table: 'production_receipts',
  docType: 'production',
  auditEntity: 'production_receipt',
  value: (db, id) => db.prepare('SELECT total_pieces t FROM production_receipts WHERE id=?').get(id).t,
  deps: [],
  beforeDelete: (db, id, doc) => {
    // الكراتين تعود مصروفة بلا نتيجة، فيمكن استلامها من جديد
    db.prepare(`UPDATE cartons SET status='issued' WHERE id IN
      (SELECT carton_id FROM production_receipt_cartons WHERE receipt_id=?)`).run(id);
    db.prepare('DELETE FROM production_receipt_cartons WHERE receipt_id=?').run(id);
    // سند التالف الآلي التابع للعميل يُمحى مع السند فيعود رصيد العميل كاملاً
    db.prepare('DELETE FROM scrap_movements WHERE prod_receipt_id=?').run(id);
    void doc;
  },
};

// حركات المستند من رأسه المخزّن — تُستعمل للعكس عند التعديل وللمحو عند الحذف
function receiptMoves(db, id) {
  return db.prepare(`SELECT sm.*, i.code, i.name FROM stock_moves sm JOIN items i ON i.id=sm.item_id
    WHERE sm.doc_type='production' AND sm.doc_id=?`).all(id);
}

module.exports = function register(ipcMain) {
  ipcMain.handle('production:suggest', () => suggestNumber(getDb(), 'production_receipts'));

  ipcMain.handle('production:list', () => {
    const db = getDb();
    return db.prepare(`SELECT r.*, i.code fg_code, i.name fg_name, i.unit_name,
        ip.doc_number issue_number, m.name machine_name, s.name shift_name, pa.name party_name,
        (SELECT COUNT(*) FROM production_receipt_cartons rc WHERE rc.receipt_id=r.id) cartons_count
      FROM production_receipts r
      JOIN items i ON i.id=r.fg_item_id
      LEFT JOIN issue_permits ip ON ip.id=r.issue_permit_id
      LEFT JOIN machines m ON m.id=r.machine_id
      LEFT JOIN shifts s ON s.id=r.shift_id
      LEFT JOIN parties pa ON pa.id=r.party_id
      ORDER BY r.id DESC`).all();
  });

  ipcMain.handle('production:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT r.*, i.code fg_code, i.name fg_name, i.unit_name, i.pieces_per_bag,
        ip.doc_number issue_number, m.name machine_name, s.name shift_name, pa.name party_name,
        w.name warehouse_name
      FROM production_receipts r
      JOIN items i ON i.id=r.fg_item_id
      LEFT JOIN issue_permits ip ON ip.id=r.issue_permit_id
      LEFT JOIN machines m ON m.id=r.machine_id
      LEFT JOIN shifts s ON s.id=r.shift_id
      LEFT JOIN parties pa ON pa.id=r.party_id
      LEFT JOIN warehouses w ON w.id=r.warehouse_id WHERE r.id=?`).get(id);
    if (!doc) throw new Error('السند غير موجود');
    doc.cartons = db.prepare(`SELECT rc.*, c.carton_number, c.pieces AS carton_pieces,
        ri.code raw_code, ri.name raw_name, ri.unit_name raw_unit
      FROM production_receipt_cartons rc
      JOIN cartons c ON c.id=rc.carton_id
      JOIN items ri ON ri.id=c.item_id
      WHERE rc.receipt_id=? ORDER BY c.carton_number`).all(id);
    doc.moves = receiptMoves(db, id);
    return doc;
  });

  // الكراتين الجاهزة للاستلام على تصريح بعينه (لم يُسجَّل لها نتيجة بعد)
  ipcMain.handle('production:cartonsForIssue', (e, issuePermitId) => {
    const db = getDb();
    return db.prepare(`SELECT c.id carton_id, c.carton_number, c.pieces, c.source, c.party_id,
        i.code raw_code, i.name raw_name, i.unit_name raw_unit, i.weight_grams
      FROM cartons c JOIN items i ON i.id=c.item_id
      WHERE c.issue_permit_id=? AND c.status='issued'
      ORDER BY c.carton_number`).all(issuePermitId);
  });

  ipcMain.handle('production:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!checkDocNumber(db, 'production_receipts', number, doc.id)) throw new Error('رقم السند مكرر');
    const issue = db.prepare('SELECT * FROM issue_permits WHERE id=?').get(Number(doc.issue_permit_id));
    if (!issue) throw new Error('اختر تصريح الصرف أولاً');
    const fgItem = db.prepare('SELECT * FROM items WHERE id=?').get(Number(doc.fg_item_id));
    if (!fgItem) throw new Error('اختر الصنف النهائي المنتَج');
    const warehouseId = Number(doc.warehouse_id) || null;
    if (!warehouseId || !db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouseId)) {
      throw new Error('اختر مخزن استلام التام');
    }
    const lines = (doc.cartons || []).filter((l) => l && l.carton_id);
    if (!lines.length) throw new Error('أضف كرتوناً واحداً على الأقل');

    // المصدر والعميل يُورَثان من تصريح الصرف: استلام إنتاج بخام عميل لا يقبل مصدراً آخر
    const source = issue.source;
    const partyId = source === 'customer' ? (issue.party_id || null) : null;
    if (source === 'customer' && !partyId) throw new Error('بلا عميل محدد — صحّح تصريح الصرف أولاً');

    let good = 0, before = 0, after = 0, issued = 0;
    const rawDefects = new Map();   // صنف الخام → تالف قبل
    const prepared = [];
    for (const l of lines) {
      const carton = db.prepare(`SELECT c.*, i.code, i.name, i.unit_name, i.weight_grams
        FROM cartons c JOIN items i ON i.id=c.item_id WHERE c.id=?`).get(Number(l.carton_id));
      if (!carton) throw new Error('كرتون غير موجود');
      if (carton.issue_permit_id !== issue.id) {
        throw new Error(`الكرتون ${carton.carton_number} ليس ضمن تصريح الصرف ${issue.doc_number}`);
      }
      // الكرتون المُنتَج فعلاً لا يدخل سنداً ثانياً — وإلا ضوعفت حباته في العدّادات
      if (carton.status !== 'issued') {
        const owner = db.prepare(`SELECT r.doc_number FROM production_receipt_cartons rc
          JOIN production_receipts r ON r.id = rc.receipt_id
          WHERE rc.carton_id=? AND rc.receipt_id != ?`).get(carton.id, doc.id || 0);
        if (owner) throw new Error(`الكرتون ${carton.carton_number} مستلم فعلاً في السند ${owner.doc_number} — احذفه أولاً`);
      }
      const g = Math.max(0, Math.round(Number(l.good_pieces) || 0));
      const b = Math.max(0, Math.round(Number(l.defect_before_pieces) || 0));
      const a = Math.max(0, Math.round(Number(l.defect_after_pieces) || 0));
      if (g + b + a <= 0) throw new Error(`أدخل نتيجة الكرتون ${carton.carton_number} (سليم أو تالف)`);
      good += g; before += b; after += a;
      issued += Number(carton.pieces) || 0;
      rawDefects.set(carton.item_id, (rawDefects.get(carton.item_id) || 0) + b);
      prepared.push({ carton, good: g, defect_before: b, defect_after: a, notes: l.notes || null });
    }
    const total = good + before + after;
    const variance = issued - total;                 // موجب = عجز، سالب = فائض
    const surplus = variance < 0 ? -variance : 0;
    const fgGoodReceived = good + surplus;

    let bags = 0, breaks = 0, usedBags = 0, bagItemId = null;
    if (Number(doc.bags) > 0 || Number(doc.breaks) > 0) {
      const m = bagMath(fgItem, doc.bags, doc.breaks);
      bags = Math.max(0, Math.round(Number(doc.bags) || 0));
      breaks = m.breaks;
      usedBags = m.usedBags;
      if (m.pieces > fgGoodReceived) {
        throw new Error(`الأكياس المُدخلة (${m.pieces} حبة) تتجاوز التام السليم (${fgGoodReceived} حبة)`);
      }
      bagItemId = fgItem.bag_item_id ? Number(fgItem.bag_item_id) : null;
      if (!bagItemId) throw new Error(`الصنف ${fgItem.code} غير مربوط بصنف أكياس — اربطه من شاشة الأصناف أو اترك الأكياس فارغة`);
    }

    const isNew = !doc.id;
    const before0 = isNew ? null : db.prepare('SELECT * FROM production_receipts WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      // 1) عكس الأثر القديم كاملاً (سلات + أكياس + حركات) ثم بناء المستند من جديد
      if (id) {
        const oldMoves = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all('production', id);
        // revertMoves يردّ كل حركات السند بما فيها حركة الأكياس، فلا حاجة لعكس منفصل
        // لأكياس المستند القديم — عكسها مرتين كان ينفخ عدّاد الأكياس مع كل تعديل.
        revertMoves(db, oldMoves, -1);
        db.prepare('DELETE FROM stock_moves WHERE doc_type=? AND doc_id=?').run('production', id);
        db.prepare(`UPDATE cartons SET status='issued' WHERE id IN
          (SELECT carton_id FROM production_receipt_cartons WHERE receipt_id=?)`).run(id);
        db.prepare('DELETE FROM production_receipt_cartons WHERE receipt_id=?').run(id);
        db.prepare(`UPDATE production_receipts SET doc_number=?, doc_date=?, issue_permit_id=?, machine_id=?, shift_id=?,
            receiver_name=?, source=?, party_id=?, fg_item_id=?, warehouse_id=?, issued_pieces=?, good_pieces=?,
            defect_before_pieces=?, defect_after_pieces=?, total_pieces=?, variance_pieces=?, surplus_pieces=?,
            bags=?, breaks=?, bags_used=?, bag_item_id=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, issue.id, doc.machine_id || issue.machine_id || null,
            doc.shift_id || issue.shift_id || null, doc.receiver_name || null, source, partyId,
            fgItem.id, warehouseId, issued, good, before, after, total, variance, surplus,
            bags, breaks, usedBags, bagItemId, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO production_receipts
            (doc_number, doc_date, issue_permit_id, machine_id, shift_id, receiver_name, source, party_id,
             fg_item_id, warehouse_id, issued_pieces, good_pieces, defect_before_pieces, defect_after_pieces,
             total_pieces, variance_pieces, surplus_pieces, bags, breaks, bags_used, bag_item_id, notes, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, issue.id, doc.machine_id || issue.machine_id || null,
            doc.shift_id || issue.shift_id || null, doc.receiver_name || null, source, partyId,
            fgItem.id, warehouseId, issued, good, before, after, total, variance, surplus,
            bags, breaks, usedBags, bagItemId, doc.notes || null, userId).lastInsertRowid;
      }

      // 2) الكراتين تُقفل كـ«أُنتجت» وتُربط بسند الاستلام
      const insLine = db.prepare(`INSERT INTO production_receipt_cartons
        (receipt_id, carton_id, good_pieces, defect_before_pieces, defect_after_pieces, notes) VALUES (?,?,?,?,?,?)`);
      const finish = db.prepare(`UPDATE cartons SET status='finished' WHERE id=? AND status IN ('issued','finished')`);
      for (const l of prepared) {
        finish.run(l.carton.id);
        insLine.run(id, l.carton.id, l.good, l.defect_before, l.defect_after, l.notes);
      }

      // 3) الأثر المخزني
      if (source === 'own') {
        const moves = [];
        const whOf = (rawItemId) => {
          const ii = db.prepare('SELECT warehouse_id FROM issue_items WHERE issue_permit_id=? AND item_id=? LIMIT 1')
            .get(issue.id, rawItemId);
          return ii ? ii.warehouse_id : warehouseId;
        };
        if (fgGoodReceived > 0) {
          moves.push({ item_id: fgItem.id, warehouse_id: warehouseId, qty_in_pieces: fgGoodReceived,
            weight_in_kg: piecesToWeightKg(fgGoodReceived, fgItem.weight_grams || 0), bucket: 'salem',
            notes: surplus > 0 ? `تام سليم (${good} + فائض ${surplus})` : 'تام سليم' });
        }
        if (after > 0) {
          moves.push({ item_id: fgItem.id, warehouse_id: warehouseId, qty_in_pieces: after,
            weight_in_kg: piecesToWeightKg(after, fgItem.weight_grams || 0), bucket: 'talef', notes: 'تالف بعد الإنتاج — تام تالف' });
        }
        for (const [rawItemId, qty] of rawDefects) {
          if (qty <= 0) continue;
          const raw = db.prepare('SELECT * FROM items WHERE id=?').get(rawItemId);
          moves.push({ item_id: rawItemId, warehouse_id: whOf(rawItemId), qty_in_pieces: qty,
            weight_in_kg: piecesToWeightKg(qty, raw.weight_grams || 0), bucket: 'talef',
            notes: `تالف قبل الإنتاج — خام تالف (${raw.code})` });
        }
        if (variance > 0) {
          // العجز يُسجَّل نصاً في الحركات حتى يظهر في الجرد والتقرير بلا لمس للعدّادات
          moves.push({ item_id: fgItem.id, warehouse_id: warehouseId, qty_in_pieces: 0, qty_out_pieces: 0,
            weight_in_kg: 0, weight_out_kg: 0, bucket: 'salem',
            notes: `عجز تسوية: مصروف ${issued} مقابل منتج ${total}` });
        }
        if (usedBags > 0 && bagItemId) {
          const bagItem = db.prepare('SELECT * FROM items WHERE id=?').get(bagItemId);
          if (!bagItem) throw new Error('صنف الأكياس المرتبط غير موجود — حدّث الربط في شاشة الأصناف');
          assertBagStock(db, bagItem, warehouseId, usedBags);
          // isBag علامة محلية فقط: الحركة تُدفتر في stock_moves، لكن عدّادات السلات تُطبَّق
          // على بنود الأصناف وحدها — وإلا جمع applyBucketsDelta القيمةَ المطلقة للأكياس
          // فزادها ثم خصمها applyBagDelta، فتتباعد العدّادات عن صافي الحركات مع كل تعديل.
          moves.push({ item_id: bagItem.id, warehouse_id: warehouseId, qty_out_pieces: usedBags,
            weight_out_kg: piecesToWeightKg(usedBags, bagItem.weight_grams || 0), bucket: 'salem',
            isBag: true, notes: `استهلاك أكياس لتعبئة ${fgItem.code}` });
        }
        writeMoves(db, 'production', id, number, doc.doc_date, moves, userId);
        // writeMoves يعكس القديم تلقائياً عند التعديل، والعدّادات رُدّت في الخطوة 1 ثم تُطبَّق الآن
        const bucketRows = moves.filter((m) => !m.isBag && ((m.qty_in_pieces || 0) + (m.qty_out_pieces || 0) > 0));
        applyBucketsDelta(db, bucketRows, 1);
        applyBagDelta(db, { bag_item_id: bagItemId, bags_used: usedBags }, -1);
      } else {
        // خام العميل: لا سلات للمصنع — التالف على رصيد العميل، والأكياس تُستهلك كما في المصنع
        const rawItemId = prepared.length ? prepared[0].carton.item_id : null;
        syncCustomerDefectScrap(db, {
          receiptId: id, docNumber: number, docDate: doc.doc_date, partyId,
          rawItemId, defects: before + after, userId,
        });
        if (usedBags > 0 && bagItemId) {
          const bagItem = db.prepare('SELECT * FROM items WHERE id=?').get(bagItemId);
          assertBagStock(db, bagItem, warehouseId, usedBags);
          writeMoves(db, 'production', id, number, doc.doc_date, [{
            item_id: bagItem.id, warehouse_id: warehouseId, qty_out_pieces: usedBags,
            weight_out_kg: piecesToWeightKg(usedBags, bagItem.weight_grams || 0), bucket: 'salem',
            notes: `استهلاك أكياس لتعبئة ${fgItem.code} (خام عميل)`,
          }], userId);
          applyBagDelta(db, { bag_item_id: bagItemId, bags_used: usedBags }, -1);
        }
      }
    });
    audit(db, userId, isNew ? 'create' : 'update', 'production_receipt', id, before0, doc);
    return { id, issued, total, variance, surplus, good: fgGoodReceived, defect_before: before, defect_after: after };
  });

  // ملخّص تسوية سريع للشاشة (بلا حفظ): يعيد الأرقام نفسها التي سيحسبها الحفظ
  ipcMain.handle('production:reconcile', (e, payload) => {
    const db = getDb();
    const lines = (payload && payload.cartons) || [];
    let good = 0, before = 0, after = 0, issued = 0;
    for (const l of lines) {
      const c = db.prepare('SELECT pieces FROM cartons WHERE id=?').get(Number(l.carton_id));
      if (!c) continue;
      issued += Number(c.pieces) || 0;
      good += Math.max(0, Math.round(Number(l.good_pieces) || 0));
      before += Math.max(0, Math.round(Number(l.defect_before_pieces) || 0));
      after += Math.max(0, Math.round(Number(l.defect_after_pieces) || 0));
    }
    const total = good + before + after;
    const variance = issued - total;
    return { issued, good, defect_before: before, defect_after: after, total, variance,
      surplus: variance < 0 ? -variance : 0, shortage: variance > 0 ? variance : 0,
      fg_good: good + (variance < 0 ? -variance : 0) };
  });

  ipcMain.handle('production:impact', (e, id) => docDelete.impact(getDb(), RECEIPT_SPEC, id));

  ipcMain.handle('production:delete', (e, id, userId) => docDelete.hardDelete(getDb(), RECEIPT_SPEC, id, userId));
};
