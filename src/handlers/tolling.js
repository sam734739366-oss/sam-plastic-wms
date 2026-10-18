const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { suggestNumber, checkDocNumber } = require('../docs');

function customerBalance(db, partyId) {
  return db.prepare(`SELECT
    COALESCE((SELECT SUM(i.pieces) FROM customer_raw_items i JOIN customer_raw_receipts r ON r.id=i.receipt_id
      WHERE r.party_id=p.id AND r.status='active'),0) raw_in,
    COALESCE((SELECT SUM(di.pieces) FROM customer_delivery_items di JOIN customer_deliveries d ON d.id=di.delivery_id
      WHERE d.party_id=p.id AND d.status='active'),0) delivered_out,
    COALESCE((SELECT SUM(s.pieces) FROM scrap_movements s WHERE s.party_id=p.id AND s.status='active'),0) scrap_out
    FROM parties p WHERE p.id=?`).get(partyId);
}

module.exports = function register(ipcMain) {
  ipcMain.handle('tolling:receiptsList', () => {
    const db = getDb();
    return db.prepare(`SELECT r.*, p.name party_name,
      (SELECT COUNT(*) FROM customer_raw_items WHERE receipt_id=r.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM customer_raw_items WHERE receipt_id=r.id) total_pieces
      FROM customer_raw_receipts r JOIN parties p ON p.id=r.party_id
      ORDER BY r.id DESC`).all();
  });

  ipcMain.handle('tolling:receiptGet', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT r.*, p.name party_name FROM customer_raw_receipts r
      JOIN parties p ON p.id=r.party_id WHERE r.id=?`).get(id);
    if (!doc) throw new Error('سند الاستلام غير موجود');
    doc.items = db.prepare(`SELECT ri.*, i.code, i.name, i.pieces_per_carton FROM customer_raw_items ri
      JOIN items i ON i.id=ri.item_id WHERE ri.receipt_id=? ORDER BY ri.id`).all(id);
    return doc;
  });

  ipcMain.handle('tolling:receiptSave', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.party_id) throw new Error('اختر العميل');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!checkDocNumber(db, 'customer_raw_receipts', number, doc.id)) throw new Error('رقم السند مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM customer_raw_receipts WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      if (id) {
        db.prepare('DELETE FROM customer_raw_items WHERE receipt_id=?').run(id);
        db.prepare('UPDATE customer_raw_receipts SET doc_number=?, doc_date=?, party_id=?, notes=? WHERE id=?')
          .run(number, doc.doc_date, doc.party_id, doc.notes || null, id);
      } else {
        id = db.prepare('INSERT INTO customer_raw_receipts (doc_number, doc_date, party_id, notes, created_by) VALUES (?,?,?,?,?)')
          .run(number, doc.doc_date, doc.party_id, doc.notes || null, userId).lastInsertRowid;
      }
      const ins = db.prepare(`INSERT INTO customer_raw_items
        (receipt_id, item_id, boxes, pieces_per_box, pieces, weight_kg, notes) VALUES (?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        if (item.item_group !== 3) throw new Error(`الصنف ${item.code} ليس خام عميل (مجموعة 003)`);
        const boxes = Math.max(0, Number(it.boxes) || 0);
        const perBox = Math.max(0, Number(it.pieces_per_box) || item.pieces_per_carton || 0);
        const pieces = boxes * perBox;
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const weight = Number(it.weight_kg) || null;
        ins.run(id, item.id, boxes, perBox || null, pieces, weight, it.notes || null);
      }
    });
    audit(db, userId, isNew ? 'create' : 'update', 'customer_raw_receipt', id, before, doc);
    return { id };
  });

  ipcMain.handle('tolling:receiptVoid', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM customer_raw_receipts WHERE id=?').get(id);
    if (!before) throw new Error('سند الاستلام غير موجود');
    db.prepare(`UPDATE customer_raw_receipts SET status='void' WHERE id=?`).run(id);
    audit(db, userId, 'void', 'customer_raw_receipt', id, before, null);
    return { ok: true };
  });

  ipcMain.handle('tolling:balance', () => {
    const db = getDb();
    return db.prepare(`SELECT p.id, p.name,
      COALESCE((SELECT SUM(i.pieces) FROM customer_raw_items i JOIN customer_raw_receipts r ON r.id=i.receipt_id
        WHERE r.party_id=p.id AND r.status='active'),0) raw_in,
      COALESCE((SELECT SUM(i.weight_kg) FROM customer_raw_items i JOIN customer_raw_receipts r ON r.id=i.receipt_id
        WHERE r.party_id=p.id AND r.status='active'),0) raw_kg,
      COALESCE((SELECT SUM(di.pieces) FROM customer_delivery_items di JOIN customer_deliveries d ON d.id=di.delivery_id
        WHERE d.party_id=p.id AND d.status='active'),0) delivered_out,
      COALESCE((SELECT SUM(s.pieces) FROM scrap_movements s WHERE s.party_id=p.id AND s.status='active'),0) scrap_out
      FROM parties p WHERE p.type IN ('customer','both') ORDER BY p.name`).all()
      .map(r => ({ ...r, remaining: r.raw_in - r.delivered_out - r.scrap_out }));
  });

  ipcMain.handle('tolling:deliveriesList', () => {
    const db = getDb();
    return db.prepare(`SELECT d.*, p.name party_name, inv.doc_number invoice_number,
      (SELECT COALESCE(SUM(pieces),0) FROM customer_delivery_items WHERE delivery_id=d.id) total_pieces
      FROM customer_deliveries d
      JOIN parties p ON p.id=d.party_id
      LEFT JOIN invoices inv ON inv.id=d.invoice_id
      ORDER BY d.id DESC`).all();
  });

  ipcMain.handle('tolling:deliveryGet', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT d.*, p.name party_name, inv.doc_number invoice_number
      FROM customer_deliveries d JOIN parties p ON p.id=d.party_id
      LEFT JOIN invoices inv ON inv.id=d.invoice_id WHERE d.id=?`).get(id);
    if (!doc) throw new Error('سند التسليم غير موجود');
    doc.items = db.prepare(`SELECT di.*, i.code, i.name, i.weight_grams, i.pieces_per_bag, i.pieces_per_carton, i.unit_name
      FROM customer_delivery_items di JOIN items i ON i.id=di.item_id WHERE di.delivery_id=? ORDER BY di.id`).all(id);
    return doc;
  });

  ipcMain.handle('tolling:deliverySave', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم السند مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.party_id) throw new Error('اختر العميل');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!checkDocNumber(db, 'customer_deliveries', number, doc.id)) throw new Error('رقم السند مكرر');
    if (doc.invoice && doc.invoice.create && !checkDocNumber(db, 'invoices', doc.invoice.doc_number)) throw new Error('رقم فاتورة الأجرة مكرر');
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM customer_deliveries WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      const bal = customerBalance(db, doc.party_id);
      const prevItems = id ? db.prepare(`SELECT COALESCE(SUM(pieces),0) s FROM customer_delivery_items WHERE delivery_id=?`).get(id).s : 0;
      let totalPieces = 0;
      const rows = [];
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        if (item.item_group !== 2) throw new Error(`الصنف ${item.code} ليس من الإنتاج التام`);
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        rows.push({ item_id: item.id, quantity: it.quantity, unit: it.unit, pieces, weight_kg: kg, notes: it.notes || null });
        totalPieces += pieces;
      }
      const available = bal.raw_in - bal.delivered_out - bal.scrap_out + prevItems;
      if (totalPieces > available) {
        throw new Error(`الكمية المسلمة (${totalPieces}) أكبر من رصيد العميل المتبقي (${available}) حبة`);
      }
      let invoiceId = doc.invoice_id || null;
      if (doc.invoice && doc.invoice.create) {
        const inv = doc.invoice;
        invoiceId = db.prepare(`INSERT INTO invoices (doc_number, doc_date, party_id, invoice_type, driver_name, car_number, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(inv.doc_number, inv.doc_date || doc.doc_date, doc.party_id, 'blowing_fee',
            inv.driver_name || null, inv.car_number || null, inv.notes || null, userId).lastInsertRowid;
        const insInv = db.prepare(`INSERT INTO invoice_items
          (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const it of inv.items || []) {
          const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
          if (!item) throw new Error('صنف غير موجود');
          if (item.item_group !== 4) throw new Error(`الصنف ${item.code} ليس خدمة نفخ (مجموعة 004)`);
          const qty = Number(it.quantity) || 0;
          const price = Number(it.unit_price) || 0;
          insInv.run(invoiceId, item.id, 1, qty, 'piece', Math.round(qty), 0, price, qty * price, it.notes || null);
        }
      }
      if (id) {
        db.prepare('DELETE FROM customer_delivery_items WHERE delivery_id=?').run(id);
        db.prepare('UPDATE customer_deliveries SET doc_number=?, doc_date=?, party_id=?, invoice_id=?, notes=? WHERE id=?')
          .run(number, doc.doc_date, doc.party_id, invoiceId, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO customer_deliveries (doc_number, doc_date, party_id, invoice_id, notes, created_by)
          VALUES (?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.party_id, invoiceId, doc.notes || null, userId).lastInsertRowid;
      }
      const insItem = db.prepare(`INSERT INTO customer_delivery_items
        (delivery_id, item_id, quantity, unit, pieces, weight_kg, notes) VALUES (?,?,?,?,?,?,?)`);
      for (const r of rows) insItem.run(id, r.item_id, r.quantity, r.unit, r.pieces, r.weight_kg, r.notes);
    });
    audit(db, userId, isNew ? 'create' : 'update', 'customer_delivery', id, before, doc);
    return { id };
  });

  ipcMain.handle('tolling:deliveryVoid', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM customer_deliveries WHERE id=?').get(id);
    if (!before) throw new Error('سند التسليم غير موجود');
    if (before.invoice_id) {
      const inv = db.prepare(`SELECT status FROM invoices WHERE id=?`).get(before.invoice_id);
      if (inv && inv.status === 'active') throw new Error('لا يمكن إلغاء التسليم — فاتورة الأجرة المرتبطة نشطة، ألغِ الفاتورة أولاً');
    }
    db.prepare(`UPDATE customer_deliveries SET status='void' WHERE id=?`).run(id);
    audit(db, userId, 'void', 'customer_delivery', id, before, null);
    return { ok: true };
  });
};
