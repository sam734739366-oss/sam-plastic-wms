const { audit } = require('./audit');
const { withTransaction } = require('./db');

// حركات كميات سليم/تالف/محرز المخزنة مع كل صنف.
// deltas: { salem: ±n, talef: ±n, muharraz: ±n } — ترفض النزول تحت الصفر برسالة واضحة.
function bucketsDelta(db, itemId, deltas = {}) {
  const row = db.prepare('SELECT code, name, qty_salem, qty_talef, qty_muharraz FROM items WHERE id=?').get(itemId);
  if (!row) throw new Error('صنف غير موجود');
  const d = {
    salem: Number(deltas.salem) || 0,
    talef: Number(deltas.talef) || 0,
    muharraz: Number(deltas.muharraz) || 0,
  };
  const next = {
    salem: (row.qty_salem || 0) + d.salem,
    talef: (row.qty_talef || 0) + d.talef,
    muharraz: (row.qty_muharraz || 0) + d.muharraz,
  };
  const label = (k) => ({ salem: 'السليمة', talef: 'التالفة', muharraz: 'المحرزة' }[k]);
  for (const k of ['salem', 'talef', 'muharraz']) {
    if (next[k] < 0) {
      throw new Error(`الكمية ${label(k)} للصنف ${row.code} غير كافية (المتوفر ${row['qty_' + k] || 0})`);
    }
  }
  db.prepare('UPDATE items SET qty_salem=?, qty_talef=?, qty_muharraz=? WHERE id=?')
    .run(next.salem, next.talef, next.muharraz, itemId);
  return next;
}

// تجميع دلتا سلة (سليم/تالف/محرز) لأصناف مكررة في بنود مستند: +داخل أو -خارج
// يقبل بنود المشتريات/الصرف (pieces) وحركات المخزون (qty_in_pieces / qty_out_pieces)
function applyBucketDelta(db, items, sign, key) {
  const byItem = new Map();
  for (const it of items) {
    const itemId = it.item_id;
    const pieces = Math.abs(it.pieces != null ? it.pieces : ((it.qty_in_pieces || 0) - (it.qty_out_pieces || 0)));
    if (!itemId || !pieces) continue;
    byItem.set(itemId, (byItem.get(itemId) || 0) + pieces);
  }
  for (const [itemId, pieces] of byItem) {
    bucketsDelta(db, itemId, { [key]: sign * pieces });
  }
}

function applySalemDelta(db, items, sign) { return applyBucketDelta(db, items, sign, 'salem'); }
function applyTalefDelta(db, items, sign) { return applyBucketDelta(db, items, sign, 'talef'); }

// تطبيق دلتا سلات مزدوجة (صنف × سلة) لبند قد يحوي سلات مختلفة: +داخل أو -خارج.
// يقبل بنود المستندات (pieces + bucket) وحركات المخزون (qty_in/out + bucket).
function applyBucketsDelta(db, rows, sign) {
  const byPair = new Map();
  for (const it of rows) {
    const itemId = it.item_id;
    const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket) ? it.bucket : 'salem';
    const pieces = Math.abs(it.pieces != null ? it.pieces : ((it.qty_in_pieces || 0) - (it.qty_out_pieces || 0)));
    if (!itemId || !pieces) continue;
    const key = `${itemId}:${bucket}`;
    byPair.set(key, (byPair.get(key) || 0) + pieces);
  }
  for (const [key, pieces] of byPair) {
    const [itemId, bucket] = key.split(':');
    bucketsDelta(db, Number(itemId), { [bucket]: sign * pieces });
  }
}

function writeMoves(db, docType, docId, docNumber, docDate, rows, userId) {
  withTransaction(db, () => {
    const old = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
    if (old.length > 0) {
      const rev = db.prepare(`INSERT INTO stock_moves
        (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
         qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const o of old) rev.run(docType, docId, docNumber, docDate, o.item_id, o.warehouse_id,
        o.qty_out_pieces, o.qty_in_pieces, o.weight_out_kg, o.weight_in_kg, o.bucket || null, 'عكس حركة سابقة (تعديل)');
    }
    const ins = db.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
      VALUES (@doc_type,@doc_id,@doc_number,@doc_date,@item_id,@warehouse_id,
       @qty_in_pieces,@qty_out_pieces,@weight_in_kg,@weight_out_kg,@bucket,@notes)`);
    for (const r of rows) ins.run({
      doc_type: docType, doc_id: docId, doc_number: docNumber, doc_date: docDate,
      item_id: r.item_id, warehouse_id: r.warehouse_id,
      qty_in_pieces: r.qty_in_pieces || 0, qty_out_pieces: r.qty_out_pieces || 0,
      weight_in_kg: r.weight_in_kg || 0, weight_out_kg: r.weight_out_kg || 0,
      bucket: r.bucket || null,
      notes: r.notes || null
    });
    audit(db, userId, 'stock_write', docType, docId, old, rows);
  });
}

// ===== الحذف الفعلي (v2) =====
// عكس أثر حركات مستند على عدّادات السلات. تُحسب الصافي لكل (صنف × سلة) لا القيمة المطلقة
// لكل صف، لأن حركات التعديل تُخزَّن مع صفوف عكسها: الصافي هو الأثر الحقيقي،
// والمطلقة كانت ستُضاعف العكس وتمحو رصيداً لم يمسّه المستند أصلاً.
function revertMoves(db, rows, sign = -1) {
  const byPair = new Map();
  for (const r of rows) {
    const net = (Number(r.qty_in_pieces) || 0) - (Number(r.qty_out_pieces) || 0);
    if (!net) continue;
    const bucket = ['salem', 'talef', 'muharraz'].includes(r.bucket) ? r.bucket : 'salem';
    const key = `${r.item_id}:${bucket}`;
    byPair.set(key, (byPair.get(key) || 0) + net);
  }
  const applied = [];
  for (const [key, net] of byPair) {
    const [itemId, bucket] = key.split(':');
    const next = bucketsDelta(db, Number(itemId), { [bucket]: sign * net });
    applied.push({ item_id: Number(itemId), bucket, pieces: sign * net, next });
  }
  return applied;
}

// أثر المستند بصيغة يقرأها المستخدم في نافذة التأكيد: صنف/سلّة/مخزن والاتجاه
function docImpact(db, docType, docId) {
  const rows = db.prepare(`SELECT sm.item_id, i.code, i.name, i.unit_name, sm.bucket, sm.warehouse_id,
      w.name AS warehouse_name,
      COALESCE(SUM(sm.qty_in_pieces),0) AS in_pieces,
      COALESCE(SUM(sm.qty_out_pieces),0) AS out_pieces
    FROM stock_moves sm
    JOIN items i ON i.id = sm.item_id
    JOIN warehouses w ON w.id = sm.warehouse_id
    WHERE sm.doc_type=? AND sm.doc_id=?
    GROUP BY sm.item_id, sm.bucket, sm.warehouse_id
    ORDER BY i.code, sm.bucket, w.name`).all(docType, docId);
  const bucketLabel = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
  return rows.map((r) => {
    const net = r.in_pieces - r.out_pieces;
    const unit = r.unit_name || 'حبة';
    return {
      ...r,
      net,
      bucket_label: bucketLabel[r.bucket] || r.bucket,
      text: `${r.code} — ${r.name} (${bucketLabel[r.bucket] || r.bucket}) في ${r.warehouse_name}: `
        + (net >= 0 ? `+${net.toLocaleString('en-US')} ${unit}` : `${net.toLocaleString('en-US')} ${unit}`),
    };
  }).filter((r) => r.net !== 0);
}

// حذف المستند: يردّ العدّادات ثم يمحو حركاته. يُرجع ما رُدّ ليُعرض في التأكيد.
function deleteDocStock(db, docType, docId, userId, opts = {}) {
  const rows = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
  const impact = docImpact(db, docType, docId);
  if (opts.revertBuckets !== false) revertMoves(db, rows, -1);
  const removed = db.prepare('DELETE FROM stock_moves WHERE doc_type=? AND doc_id=?').run(docType, docId).changes;
  audit(db, userId, 'delete', docType, docId, rows, null);
  return { reverted: impact, removed_moves: removed };
}

function getBalance(db, itemId, warehouseId) {
  return db.prepare(`SELECT
      COALESCE(SUM(qty_in_pieces),0) in_pieces,
      COALESCE(SUM(qty_out_pieces),0) out_pieces,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) balance_pieces,
      COALESCE(SUM(weight_in_kg),0) in_kg,
      COALESCE(SUM(weight_out_kg),0) out_kg,
      COALESCE(SUM(weight_in_kg),0)-COALESCE(SUM(weight_out_kg),0) balance_kg,
      COALESCE(SUM(CASE WHEN bucket='salem' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) qty_salem,
      COALESCE(SUM(CASE WHEN bucket='talef' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) qty_talef,
      COALESCE(SUM(CASE WHEN bucket='muharraz' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) qty_muharraz
    FROM stock_moves WHERE item_id=? AND warehouse_id=?`).get(itemId, warehouseId);
}

module.exports = {
  writeMoves, getBalance, bucketsDelta, applyBucketDelta, applySalemDelta, applyTalefDelta,
  applyBucketsDelta, revertMoves, docImpact, deleteDocStock,
};
