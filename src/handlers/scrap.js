const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

const DISP_LABEL = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' };

module.exports = function register(ipcMain) {
  ipcMain.handle('scrap:suggest', () => suggestNumber(getDb(), 'scrap_movements'));

  ipcMain.handle('scrap:list', () => {
    const db = getDb();
    return db.prepare(`SELECT s.*, i.code item_code, i.name item_name, w.name warehouse_name, p.name party_name
      FROM scrap_movements s
      JOIN items i ON i.id=s.item_id
      LEFT JOIN warehouses w ON w.id=s.warehouse_id
      LEFT JOIN parties p ON p.id=s.party_id
      ORDER BY s.id DESC`).all();
  });

  ipcMain.handle('scrap:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT s.*, i.code item_code, i.name item_name, i.item_group, i.weight_grams,
        w.name warehouse_name, p.name party_name
      FROM scrap_movements s
      JOIN items i ON i.id=s.item_id
      LEFT JOIN warehouses w ON w.id=s.warehouse_id
      LEFT JOIN parties p ON p.id=s.party_id WHERE s.id=?`).get(id);
    if (!doc) throw new Error('السند غير موجود');
    return doc;
  });

  ipcMain.handle('scrap:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.item_id) throw new Error('اختر الصنف');
    if (!DISP_LABEL[doc.disposition]) throw new Error('اختر مصير التالف');
    if (!checkDocNumber(db, 'scrap_movements', number, doc.id)) throw new Error('رقم السند مكرر');
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(doc.item_id);
    if (!item) throw new Error('صنف غير موجود');
    if (item.item_group === 4) throw new Error('خدمات النفخ ليست تالفاً');
    const pieces = Math.max(0, Number(doc.pieces) || 0);
    const weight = Math.max(0, Number(doc.weight_kg) || 0);
    if (pieces <= 0 && weight <= 0) throw new Error('أدخل كمية (حبات أو وزن)');
    const party = doc.party_id ? db.prepare('SELECT * FROM parties WHERE id=?').get(doc.party_id) : null;
    const isCustomer = party && (party.type === 'customer' || party.type === 'both');
    if (!isCustomer && ['to_recycled', 'to_stock', 'sold_scrap'].includes(doc.disposition) && !doc.warehouse_id) {
      throw new Error('اختر المخزن');
    }
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM scrap_movements WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      if (id) {
        db.prepare(`UPDATE scrap_movements SET doc_number=?, doc_date=?, item_id=?, disposition=?, warehouse_id=?, party_id=?, pieces=?, weight_kg=?, price=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.item_id, doc.disposition, doc.warehouse_id || null,
            doc.party_id || null, pieces, weight, doc.price || null, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO scrap_movements
          (doc_number, doc_date, item_id, disposition, warehouse_id, party_id, pieces, weight_kg, price, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.item_id, doc.disposition, doc.warehouse_id || null,
            doc.party_id || null, pieces, weight, doc.price || null, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const kg = weight || piecesToWeightKg(pieces, item.weight_grams || 0);
      if (!isCustomer) {
        if (doc.disposition === 'to_recycled' || doc.disposition === 'to_stock') {
          moves.push({ item_id: item.id, warehouse_id: doc.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, notes: doc.notes });
        } else if (doc.disposition === 'sold_scrap') {
          const bal = getBalance(db, item.id, doc.warehouse_id);
          if (bal.balance_pieces < pieces) throw new Error(`الرصيد غير كافٍ للصنف ${item.code} (المتوفر ${bal.balance_pieces} حبة)`);
          moves.push({ item_id: item.id, warehouse_id: doc.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, notes: doc.notes });
        }
      }
      writeMoves(db, 'scrap', id, number, doc.doc_date, moves, userId);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'scrap_movement', id, before, doc);
    return { id };
  });

  ipcMain.handle('scrap:void', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM scrap_movements WHERE id=?').get(id);
    if (!before) throw new Error('السند غير موجود');
    withTransaction(db, () => {
      voidDoc(db, 'scrap', id, userId);
      db.prepare(`UPDATE scrap_movements SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'scrap_movement', id, before, null);
    return { ok: true };
  });
};
