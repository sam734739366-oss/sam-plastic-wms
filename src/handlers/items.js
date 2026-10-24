const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');

const UNITS = ['علبة', 'حبة', 'غطاء', 'كيس', 'كرتون', 'امبول'];
const AR_DIGITS = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

function normalizeCode(v) {
  return String(v || '').trim().replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || d);
}

// مزامنة الرصيد الافتتاحي: تُحذف حركات الافتتاح القديمة للصنف وتُكتب حركة لكل سلة
// (سليم/تالف/محرز) في أول مخزن، فتظهر الكميات في الجرد والتقارير لكل مخزن على حدة
// وتصبح قابلة للصرف والبيع. تُستدعى عند إنشاء الصنف وتعديل أرصدته الافتتاحية.
function syncOpeningMoves(db, itemId, userId) {
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
  if (!item) return;
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  if (!wh) return;
  db.prepare("DELETE FROM stock_moves WHERE doc_type='opening' AND doc_id=?").run(itemId);
  const buckets = [
    ['salem', Number(item.qty_salem) || 0, 'سليم'],
    ['talef', Number(item.qty_talef) || 0, 'تالف'],
    ['muharraz', Number(item.qty_muharraz) || 0, 'محرز'],
  ];
  const ins = db.prepare(`INSERT INTO stock_moves
    (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
     qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
    VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
  for (const [key, qty, label] of buckets) {
    if (qty > 0) ins.run(itemId, `افتتاحي-${item.code}`, new Date().toISOString().slice(0, 10), itemId, wh.id,
      qty, qty * (Number(item.weight_grams) || 0) / 1000, key, `رصيد افتتاحي (${label})`);
  }
  audit(db, userId, 'stock_write', 'opening', itemId, null, { pieces: buckets.reduce((s, b) => s + b[1], 0) });
}

module.exports = function register(ipcMain) {
  ipcMain.handle('items:list', () => {
    return getDb().prepare(`SELECT i.*,
        EXISTS(SELECT 1 FROM stock_moves m WHERE m.item_id = i.id AND m.doc_type != 'opening') has_moves
      FROM items i ORDER BY i.code`).all();
  });

  ipcMain.handle('items:save', (e, row, userId) => {
    const db = getDb();
    const code = normalizeCode(row.code);
    if (!code) throw new Error('كود الصنف مطلوب');
    if (!/^\d+$/.test(code)) throw new Error('كود الصنف يجب أن يكون أرقامًا فقط');
    const name = String(row.name || '').trim();
    if (!name) throw new Error('اسم الصنف مطلوب');
    const unit = String(row.unit_name || '').trim() || 'حبة';
    if (!UNITS.includes(unit)) throw new Error('الوحدة يجب أن تكون: علبة، حبة، غطاء، كيس، كرتون، أو امبول');
    const dup = db.prepare('SELECT id FROM items WHERE code=? AND id IS NOT ?').get(code, row.id || -1);
    if (dup) throw new Error('كود الصنف مكرر — اختر كوداً آخر');

    const isNew = !row.id;
    const before = isNew ? null : db.prepare('SELECT * FROM items WHERE id=?').get(row.id);
    if (!isNew && !before) throw new Error('الصنف غير موجود');
    // الكميات قابلة للتعديل دائماً: لأصناف لها حركات يُستوعب الفرق في الحركة
    // الافتتاحية (الافتتاح = العداد − صافي الحركات) ويُعاد حساب الأوزان المخزنة.
    const hasMoves = !isNew && db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE item_id=? AND doc_type != 'opening'").get(row.id).c > 0;
    let id = row.id;
    const fields = {
      code, name, unit_name: unit,
      weight_grams: row.weight_grams || null,
      pieces_per_carton: row.pieces_per_carton || null,
      pieces_per_shadda: row.pieces_per_shadda || null,
      pieces_per_bag: row.pieces_per_bag || null,
      qty_salem: Number(row.qty_salem) || 0,
      qty_talef: Number(row.qty_talef) || 0,
      qty_muharraz: Number(row.qty_muharraz) || 0,
      is_complement: row.is_complement ? 1 : 0,
      notes: row.notes || null,
    };
    let netOf = () => 0;
    if (hasMoves) {
      const netRows = db.prepare(`SELECT bucket, COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
        FROM stock_moves WHERE doc_type != 'opening' AND item_id=? GROUP BY bucket`).all(row.id);
      netOf = (bucket) => { const r = netRows.find(x => x.bucket === bucket); return r ? r.net : 0; };
      for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
        const counter = fields[`qty_${key}`];
        const net = netOf(key);
        if (counter < net) throw new Error(`رصيد ${label} المطلوب (${counter}) أقل من صافي حركات السلة (${net}) — اعكس الحركات أولاً أو ارفع الرصيد`);
      }
    }
    if (id) {
      db.prepare(`UPDATE items SET code=@code,name=@name,unit_name=@unit_name,weight_grams=@weight_grams,
        pieces_per_carton=@pieces_per_carton,pieces_per_shadda=@pieces_per_shadda,pieces_per_bag=@pieces_per_bag,
        qty_salem=@qty_salem,qty_talef=@qty_talef,qty_muharraz=@qty_muharraz,
        is_complement=@is_complement,notes=@notes WHERE id=@id`).run({ ...fields, id });
    } else {
      id = db.prepare(`INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_carton,
        pieces_per_shadda,pieces_per_bag,qty_salem,qty_talef,qty_muharraz,is_complement,notes)
        VALUES (@code,@name,2,@unit_name,@weight_grams,@pieces_per_carton,@pieces_per_shadda,@pieces_per_bag,
        @qty_salem,@qty_talef,@qty_muharraz,@is_complement,@notes)`)
        .run(fields).lastInsertRowid;
    }
    if (hasMoves) {
      const qtyChanged = ['salem', 'talef', 'muharraz'].some(k => Number(before[`qty_${k}`]) !== fields[`qty_${k}`]);
      const weightChanged = Number(before.weight_grams || 0) !== Number(fields.weight_grams || 0);
      // وزن الحبة الجديد ينعكس على كل حركات الصنف المخزنة (الحبات × الوزن / 1000)
      if (weightChanged && Number(fields.weight_grams) > 0) {
        db.prepare(`UPDATE stock_moves SET weight_in_kg = qty_in_pieces * ? / 1000,
          weight_out_kg = qty_out_pieces * ? / 1000 WHERE item_id=?`).run(fields.weight_grams, fields.weight_grams, row.id);
      }
      // فرق الكميات يُستوعب في الحركة الافتتاحية لكل سلة
      if (qtyChanged || weightChanged) {
        const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
        if (wh) {
          const today = new Date().toISOString().slice(0, 10);
          const ins = db.prepare(`INSERT INTO stock_moves
            (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
             qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
            VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
          const upd = db.prepare('UPDATE stock_moves SET qty_in_pieces=?, weight_in_kg=? WHERE id=?');
          for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
            const qty = fields[`qty_${key}`] - netOf(key);
            const w = qty * (Number(fields.weight_grams) || 0) / 1000;
            const existing = db.prepare(`SELECT id FROM stock_moves
              WHERE doc_type='opening' AND item_id=? AND bucket=?`).get(row.id, key);
            if (qty > 0) {
              if (existing) upd.run(qty, w, existing.id);
              else ins.run(row.id, `افتتاحي-${fields.code}`, today, row.id, wh.id, qty, w, key, `رصيد افتتاحي (${label})`);
            } else if (existing) {
              db.prepare('DELETE FROM stock_moves WHERE id=?').run(existing.id);
            }
          }
          audit(db, userId, 'stock_write', 'opening', row.id, null, {
            resynced: true, qty_changed: qtyChanged, weight_changed: weightChanged,
          });
        }
      }
    } else {
      // الأرصدة الافتتاحية تنعكس كحركة مخزون حتى تظهر في الجرد والتقارير وتصبح قابلة للصرف والبيع
      syncOpeningMoves(db, id, userId);
    }
    audit(db, userId, isNew ? 'create' : 'update', 'item', id, before, fields);
    return { id };
  });

  ipcMain.handle('items:delete', (e, id, userId) => {
    const db = getDb();
    const used = db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE item_id=? AND doc_type != 'opening'").get(id).c;
    if (used > 0) throw new Error('لا يمكن حذف صنف له حركات مخزون');
    const before = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!before) throw new Error('الصنف غير موجود');
    db.prepare("DELETE FROM stock_moves WHERE item_id=? AND doc_type='opening'").run(id);
    db.prepare('DELETE FROM items WHERE id=?').run(id);
    audit(db, userId, 'delete', 'item', id, before, null);
    return { ok: true };
  });

  ipcMain.handle('items:import', (e, rows, userId) => {
    const db = getDb();
    let count = 0;
    const inserted = [];
    withTransaction(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO items (code,name,item_group,unit_name,weight_grams,
        pieces_per_carton,pieces_per_shadda,pieces_per_bag,qty_salem,qty_talef,qty_muharraz,notes)
        VALUES (?,?,2,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const code = normalizeCode(r.code);
        if (!/^\d+$/.test(code) || !String(r.name || '').trim()) continue;
        const unit = UNITS.includes(r.unit_name) ? r.unit_name : 'حبة';
        const res = ins.run(code, String(r.name).trim(), unit, r.weight_grams || null,
          r.pieces_per_carton || null, r.pieces_per_shadda || null, r.pieces_per_bag || null,
          Number(r.qty_salem) || 0, Number(r.qty_talef) || 0, Number(r.qty_muharraz) || 0,
          r.notes || null);
        if (res.changes > 0) inserted.push(res.lastInsertRowid);
        count += res.changes;
      }
    });
    // أرصدة افتتاحية للمستورد الجديد
    for (const id of inserted) syncOpeningMoves(db, id, userId);
    audit(db, userId, 'import', 'items', null, null, { imported: count });
    return { imported: count };
  });
};
