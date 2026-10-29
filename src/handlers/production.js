const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { bucketsDelta } = require('../stock');
const { checkDocNumber } = require('../docs');

// تالف نتيجة الإنتاج بخام العميل: يُسجَّل سند تالف على صاحبه، فيُخصم من رصيده في
// tolling:balance عبر scrap_out — وبلا أي أثر على سلات المصنع أو جرد مخازنه.
const DEFECT_DISP = 'production_defect';

function defectDocNumber(db, carton) {
  let n = `تالف إنتاج ${carton.carton_number}`;
  for (let i = 2; !checkDocNumber(db, 'scrap_movements', n); i++) n = `تالف إنتاج ${carton.carton_number}-${i}`;
  return n;
}

// السند المرتبط بالكرتون عبر prod_carton_id (لا doc_number نصّي: يتصادم مع مستند يدوي
// ويسقط الاستبدال على صف ملغى)، بغضّ النظر عن حالته حتى يُعاد تنشيطه عند الزيادة.
function findDefectScrap(db, cartonId) {
  return db.prepare('SELECT * FROM scrap_movements WHERE prod_carton_id=? LIMIT 1').get(cartonId);
}

function syncCustomerDefectScrap(db, { carton, partyId, defects, resultDate, userId }) {
  const existing = findDefectScrap(db, carton.id);
  if (defects <= 0) {
    if (existing && existing.status === 'active') {
      db.prepare("UPDATE scrap_movements SET status='void' WHERE id=?").run(existing.id);
    }
    return;
  }
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(carton.item_id);
  const wkg = defects * (Number(item.weight_grams) || 0) / 1000;
  const notes = `تالف مسجل في نتيجة الإنتاج — عهدة العميل (كرتون ${carton.carton_number})`;
  if (existing) {
    db.prepare(`UPDATE scrap_movements SET doc_date=?, item_id=?, pieces=?, weight_kg=?, party_id=?,
        disposition=?, status='active', is_customer=1, notes=? WHERE id=?`)
      .run(resultDate, carton.item_id, defects, wkg, partyId, DEFECT_DISP, notes, existing.id);
    return;
  }
  db.prepare(`INSERT INTO scrap_movements
      (doc_number, doc_date, item_id, disposition, warehouse_id, party_id,
       pieces, weight_kg, price, talef_take, salem_take, is_customer, notes, status, created_by, prod_carton_id)
      VALUES (?,?,?,?,NULL,?,?,?,NULL,0,0,1,?, 'active', ?, ?)`)
    .run(defectDocNumber(db, carton), resultDate, carton.item_id, DEFECT_DISP, partyId,
      defects, wkg, notes, userId, carton.id);
}

// مصدر الخام: من الكرتون (كرتون عهدة عميل) أو من تصريح الصرف. كلاهما يعني النفخ للغير،
// ويُكتفى بأحدهما على البيانات القديمة. الأسماء مُلقّبة حتى لا يظلل ip.source عمود cartons.source.
function tollingContext(carton) {
  const isTolling = carton.carton_source === 'customer' || carton.permit_source === 'customer';
  return { isTolling, partyId: carton.carton_party_id || carton.permit_party_id || null };
}

module.exports = function register(ipcMain) {
  ipcMain.handle('production:pending', () => {
    const db = getDb();
    return db.prepare(`SELECT c.id carton_id, c.carton_number, c.pieces, c.issue_date, c.issue_permit_id,
        i.code item_code, i.name item_name,
        ip.doc_number issue_number, m.name machine_name, s.name shift_name
      FROM cartons c
      JOIN items i ON i.id=c.item_id
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id
      LEFT JOIN machines m ON m.id=ip.machine_id
      LEFT JOIN shifts s ON s.id=ip.shift_id
      WHERE c.status='issued' AND NOT EXISTS (SELECT 1 FROM production_results pr WHERE pr.carton_id=c.id)
      ORDER BY c.carton_number`).all();
  });

  ipcMain.handle('production:done', () => {
    const db = getDb();
    return db.prepare(`SELECT pr.*, c.carton_number, c.pieces, i.code item_code, i.name item_name,
        ip.doc_number issue_number, m.name machine_name, s.name shift_name
      FROM production_results pr
      JOIN cartons c ON c.id=pr.carton_id
      JOIN items i ON i.id=c.item_id
      LEFT JOIN issue_permits ip ON ip.id=pr.issue_permit_id
      LEFT JOIN machines m ON m.id=pr.machine_id
      LEFT JOIN shifts s ON s.id=pr.shift_id
      ORDER BY pr.id DESC`).all();
  });

  ipcMain.handle('production:get', (e, cartonId) => {
    const db = getDb();
    const row = db.prepare(`SELECT pr.*, c.carton_number, c.pieces, i.code item_code, i.name item_name,
        ip.doc_number issue_number, ip.machine_id, ip.shift_id
      FROM cartons c
      JOIN items i ON i.id=c.item_id
      LEFT JOIN production_results pr ON pr.carton_id=c.id
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id
      WHERE c.id=?`).get(cartonId);
    if (!row) throw new Error('الكرتون غير موجود');
    return row;
  });

  ipcMain.handle('production:save', (e, data, userId) => {
    const db = getDb();
    const good = Math.max(0, Number(data.good_pieces) || 0);
    const before = Math.max(0, Number(data.defect_before) || 0);
    const after = Math.max(0, Number(data.defect_after) || 0);
    if (!data.result_date) throw new Error('التاريخ مطلوب');
    const carton = db.prepare(`SELECT c.*, c.source AS carton_source, c.party_id AS carton_party_id,
        ip.machine_id, ip.shift_id, ip.source AS permit_source, ip.party_id AS permit_party_id
      FROM cartons c
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id WHERE c.id=?`).get(data.carton_id);
    if (!carton) throw new Error('الكرتون غير موجود');
    const previous = db.prepare('SELECT * FROM production_results WHERE carton_id=?').get(data.carton_id);
    if (carton.status === 'in_stock') throw new Error('الكرتون ليس مصروفاً للإنتاج');
    if (!previous && carton.status !== 'issued') throw new Error('الكرتون ليس مصروفاً أو نتيجته مسجلة');
    const { isTolling, partyId } = tollingContext(carton);
    if (isTolling && !partyId) throw new Error('تالف خام العميل بلا عميل محدد — صحّح تصريح الصرف أو سند الاستلام أولاً');
    const total = good + before + after;
    const oldDefects = previous ? (Number(previous.defect_before) || 0) + (Number(previous.defect_after) || 0) : 0;
    const newDefects = before + after;
    withTransaction(db, () => {
      if (previous) {
        db.prepare(`UPDATE production_results SET issue_permit_id=?, machine_id=?, shift_id=?, result_date=?,
          good_pieces=?, defect_before=?, defect_after=?, notes=?, created_by=? WHERE carton_id=?`)
          .run(carton.issue_permit_id, data.machine_id ?? carton.machine_id ?? null,
            data.shift_id ?? carton.shift_id ?? null, data.result_date,
            good, before, after, data.notes || null, userId, data.carton_id);
      } else {
        db.prepare(`INSERT INTO production_results
          (carton_id, issue_permit_id, machine_id, shift_id, result_date, good_pieces, defect_before, defect_after, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(data.carton_id, carton.issue_permit_id, data.machine_id ?? carton.machine_id ?? null,
            data.shift_id ?? carton.shift_id ?? null, data.result_date,
            good, before, after, data.notes || null, userId);
      }
      db.prepare(`UPDATE cartons SET status='finished' WHERE id=?`).run(data.carton_id);
      db.prepare("DELETE FROM stock_moves WHERE doc_type='production' AND doc_id=?").run(data.carton_id);
      if (isTolling) {
        // خام العميل: لا سلات للمصنع ولا حركة مخزون — التالف على رصيد العميل وحده
        syncCustomerDefectScrap(db, { carton, partyId, defects: newDefects, resultDate: data.result_date, userId });
      } else {
        // التالف المسجل في النتيجة يزيد رصيد تالف للصنف ويظهر في جرد مخزن الصرف
        if (newDefects !== oldDefects) {
          bucketsDelta(db, carton.item_id, { talef: newDefects - oldDefects });
        }
        if (newDefects > 0) {
          const ii = db.prepare('SELECT warehouse_id FROM issue_items WHERE issue_permit_id=? AND item_id=? LIMIT 1')
            .get(carton.issue_permit_id, carton.item_id);
          if (ii) {
            const item = db.prepare('SELECT * FROM items WHERE id=?').get(carton.item_id);
            const wkg = newDefects * (Number(item.weight_grams) || 0) / 1000;
            db.prepare(`INSERT INTO stock_moves
              (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
               qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
              VALUES ('production',?,?,?,?,?,?,0,?,0,'talef',?)`)
              .run(data.carton_id, carton.carton_number, data.result_date, carton.item_id, ii.warehouse_id,
                newDefects, wkg, 'تالف مسجل في نتيجة الإنتاج');
          }
        }
      }
    });
    audit(db, userId, previous ? 'update' : 'create', 'production_result', data.carton_id, previous, data);
    return { ok: true, total, carton_pieces: carton.pieces, rest: carton.pieces - total };
  });

  ipcMain.handle('production:delete', (e, cartonId, userId) => {
    const db = getDb();
    const previous = db.prepare('SELECT * FROM production_results WHERE carton_id=?').get(cartonId);
    if (!previous) throw new Error('لا توجد نتيجة لهذا الكرتون');
    const carton = db.prepare(`SELECT c.*, c.source AS carton_source, c.party_id AS carton_party_id,
        ip.source AS permit_source, ip.party_id AS permit_party_id
      FROM cartons c LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id WHERE c.id=?`).get(cartonId);
    const oldDefects = (Number(previous.defect_before) || 0) + (Number(previous.defect_after) || 0);
    const { isTolling } = tollingContext(carton);
    withTransaction(db, () => {
      db.prepare('DELETE FROM production_results WHERE carton_id=?').run(cartonId);
      db.prepare(`UPDATE cartons SET status='issued' WHERE id=?`).run(cartonId);
      db.prepare("DELETE FROM stock_moves WHERE doc_type='production' AND doc_id=?").run(cartonId);
      if (isTolling) {
        // حذف النتيجة يُسقط سند التالف التابع للعميل، فيعود رصيده كاملاً
        const existing = findDefectScrap(db, cartonId);
        if (existing && existing.status === 'active') {
          db.prepare("UPDATE scrap_movements SET status='void' WHERE id=?").run(existing.id);
        }
      } else if (oldDefects > 0) {
        bucketsDelta(db, carton.item_id, { talef: -oldDefects });
      }
    });
    audit(db, userId, 'delete', 'production_result', cartonId, previous, null);
    return { ok: true };
  });
};
