const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

module.exports = function register(ipcMain) {
  ipcMain.handle('transfers:suggest', () => suggestNumber(getDb(), 'transfers'));

  ipcMain.handle('transfers:list', () => {
    const db = getDb();
    return db.prepare(`SELECT t.*, f.name from_name, tt.name to_name,
      (SELECT COUNT(*) FROM transfer_items WHERE transfer_id=t.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM transfer_items WHERE transfer_id=t.id) total_pieces
      FROM transfers t
      JOIN warehouses f ON f.id=t.from_warehouse_id
      JOIN warehouses tt ON tt.id=t.to_warehouse_id
      ORDER BY t.id DESC`).all();
  });

  ipcMain.handle('transfers:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT t.*, f.name from_name, tt.name to_name FROM transfers t
      JOIN warehouses f ON f.id=t.from_warehouse_id
      JOIN warehouses tt ON tt.id=t.to_warehouse_id WHERE t.id=?`).get(id);
    if (!doc) throw new Error('السند غير موجود');
    doc.items = db.prepare(`SELECT ti.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name
      FROM transfer_items ti JOIN items i ON i.id=ti.item_id WHERE ti.transfer_id=? ORDER BY ti.id`).all(id);
    return doc;
  });

  ipcMain.handle('transfers:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!doc.from_warehouse_id || !doc.to_warehouse_id) throw new Error('اختر المخزنين');
    if (doc.from_warehouse_id === doc.to_warehouse_id) throw new Error('المخزنان متطابقان — اختر مخزنين مختلفين');
    if (!checkDocNumber(db, 'transfers', number, doc.id)) throw new Error('رقم السند مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM transfers WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      if (id) {
        db.prepare('DELETE FROM transfer_items WHERE transfer_id=?').run(id);
        db.prepare(`UPDATE transfers SET doc_number=?, doc_date=?, from_warehouse_id=?, to_warehouse_id=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.from_warehouse_id, doc.to_warehouse_id, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO transfers (doc_number, doc_date, from_warehouse_id, to_warehouse_id, notes, created_by)
          VALUES (?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.from_warehouse_id, doc.to_warehouse_id, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO transfer_items
        (transfer_id, item_id, quantity, unit, pieces, weight_kg, notes)
        VALUES (?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bal = getBalance(db, it.item_id, doc.from_warehouse_id);
        if (bal.balance_pieces < pieces) throw new Error(`الرصيد غير كافٍ للصنف ${item.code} في مخزن المصدر (المتوفر ${bal.balance_pieces} حبة)`);
        moves.push({ item_id: item.id, warehouse_id: doc.from_warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket: 'salem', notes: it.notes });
        moves.push({ item_id: item.id, warehouse_id: doc.to_warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket: 'salem', notes: it.notes });
        insItem.run(id, item.id, it.quantity, it.unit, pieces, kg, it.notes || null);
      }
      writeMoves(db, 'transfer', id, number, doc.doc_date, moves, userId);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'transfer', id, before, doc);
    return { id };
  });

  ipcMain.handle('transfers:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
    if (!before) throw new Error('السند غير موجود');
    withTransaction(db, () => {
      voidDoc(db, 'transfer', id, userId);
      db.prepare(`UPDATE transfers SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'transfer', id, before, null);
    return { ok: true };
  });
};
