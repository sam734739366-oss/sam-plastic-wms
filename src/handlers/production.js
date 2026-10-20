const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { bucketsDelta } = require('../stock');

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
    const carton = db.prepare(`SELECT c.*, ip.machine_id, ip.shift_id FROM cartons c
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id WHERE c.id=?`).get(data.carton_id);
    if (!carton) throw new Error('الكرتون غير موجود');
    const previous = db.prepare('SELECT * FROM production_results WHERE carton_id=?').get(data.carton_id);
    if (carton.status === 'in_stock') throw new Error('الكرتون ليس مصروفاً للإنتاج');
    if (!previous && carton.status !== 'issued') throw new Error('الكرتون ليس مصروفاً أو نتيجته مسجلة');
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
      // التالف المسجل في النتيجة يزيد رصيد تالف للصنف
      if (newDefects !== oldDefects) {
        bucketsDelta(db, carton.item_id, { talef: newDefects - oldDefects });
      }
    });
    audit(db, userId, previous ? 'update' : 'create', 'production_result', data.carton_id, previous, data);
    return { ok: true, total, carton_pieces: carton.pieces, rest: carton.pieces - total };
  });

  ipcMain.handle('production:delete', (e, cartonId, userId) => {
    const db = getDb();
    const previous = db.prepare('SELECT * FROM production_results WHERE carton_id=?').get(cartonId);
    if (!previous) throw new Error('لا توجد نتيجة لهذا الكرتون');
    const carton = db.prepare('SELECT * FROM cartons WHERE id=?').get(cartonId);
    const oldDefects = (Number(previous.defect_before) || 0) + (Number(previous.defect_after) || 0);
    withTransaction(db, () => {
      db.prepare('DELETE FROM production_results WHERE carton_id=?').run(cartonId);
      db.prepare(`UPDATE cartons SET status='issued' WHERE id=?`).run(cartonId);
      if (oldDefects > 0) bucketsDelta(db, carton.item_id, { talef: -oldDefects });
    });
    audit(db, userId, 'delete', 'production_result', cartonId, previous, null);
    return { ok: true };
  });
};
