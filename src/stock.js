const { audit } = require('./audit');
const { withTransaction } = require('./db');

function writeMoves(db, docType, docId, docNumber, docDate, rows, userId) {
  withTransaction(db, () => {
    const old = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
    if (old.length > 0) {
      const rev = db.prepare(`INSERT INTO stock_moves
        (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
         qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const o of old) rev.run(docType, docId, docNumber, docDate, o.item_id, o.warehouse_id,
        o.qty_out_pieces, o.qty_in_pieces, o.weight_out_kg, o.weight_in_kg, 'عكس حركة سابقة (تعديل)');
    }
    const ins = db.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
      VALUES (@doc_type,@doc_id,@doc_number,@doc_date,@item_id,@warehouse_id,
       @qty_in_pieces,@qty_out_pieces,@weight_in_kg,@weight_out_kg,@notes)`);
    for (const r of rows) ins.run({
      doc_type: docType, doc_id: docId, doc_number: docNumber, doc_date: docDate,
      item_id: r.item_id, warehouse_id: r.warehouse_id,
      qty_in_pieces: r.qty_in_pieces || 0, qty_out_pieces: r.qty_out_pieces || 0,
      weight_in_kg: r.weight_in_kg || 0, weight_out_kg: r.weight_out_kg || 0,
      notes: r.notes || null
    });
    audit(db, userId, 'stock_write', docType, docId, old, rows);
  });
}

function voidDoc(db, docType, docId, userId) {
  withTransaction(db, () => {
    const old = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
    const rev = db.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const o of old) rev.run(docType, docId, o.doc_number, o.doc_date, o.item_id, o.warehouse_id,
      o.qty_out_pieces, o.qty_in_pieces, o.weight_out_kg, o.weight_in_kg, 'عكس حركة (إلغاء مستند)');
    audit(db, userId, 'void', docType, docId, old, null);
  });
}

function getBalance(db, itemId, warehouseId) {
  return db.prepare(`SELECT
      COALESCE(SUM(qty_in_pieces),0) in_pieces,
      COALESCE(SUM(qty_out_pieces),0) out_pieces,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) balance_pieces,
      COALESCE(SUM(weight_in_kg),0) in_kg,
      COALESCE(SUM(weight_out_kg),0) out_kg,
      COALESCE(SUM(weight_in_kg),0)-COALESCE(SUM(weight_out_kg),0) balance_kg
    FROM stock_moves WHERE item_id=? AND warehouse_id=?`).get(itemId, warehouseId);
}

module.exports = { writeMoves, voidDoc, getBalance };
