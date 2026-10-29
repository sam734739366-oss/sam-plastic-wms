const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, getBalance, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');
const docDelete = require('../docDelete');
const ledger = require('../ledger');

const TYPE_LABEL = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' };

// الفاتورة هي أصل مرتجع البيع وسند تسليم الأجرة: كلاهما يشير إليها بصفاً حياً،
// فلا حذف ولا تعديل لكمياتها قبل حذف ما تفرع عنها (وإلا بقي المرتجع بلا فاتورة يُنسب إليها).
const INVOICE_SPEC = {
  table: 'invoices',
  docType: 'invoice',
  ledgerType: 'invoice',
  auditEntity: 'invoice',
  value: (db, id) => db.prepare('SELECT COALESCE(SUM(total_price),0) t FROM invoice_items WHERE invoice_id=?').get(id).t,
  deps: [
    (db, id) => db.prepare('SELECT doc_number FROM sales_returns WHERE invoice_id=?').all(id)
      .map((r) => ({ label: 'مرتجع بيع', number: r.doc_number })),
    (db, id) => db.prepare('SELECT doc_number FROM customer_deliveries WHERE invoice_id=?').all(id)
      .map((r) => ({ label: 'سند تسليم عميل', number: r.doc_number })),
  ],
};

module.exports = function register(ipcMain) {
  ipcMain.handle('sales:suggest', () => suggestNumber(getDb(), 'invoices'));

  ipcMain.handle('sales:list', () => {
    const db = getDb();
    return db.prepare(`SELECT p.*, pa.name party_name,
      (SELECT COALESCE(SUM(total_price),0) FROM invoice_items WHERE invoice_id=p.id) total,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id=p.id) items_count,
      (SELECT COALESCE(SUM(pieces),0) FROM invoice_items WHERE invoice_id=p.id) total_pieces
      FROM invoices p LEFT JOIN parties pa ON pa.id=p.party_id
      ORDER BY p.id DESC`).all();
  });

  ipcMain.handle('sales:get', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT p.*, pa.name party_name FROM invoices p
      LEFT JOIN parties pa ON pa.id=p.party_id WHERE p.id=?`).get(id);
    if (!doc) throw new Error('الفاتورة غير موجودة');
    doc.items = db.prepare(`SELECT pi.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag, i.unit_name, i.item_group,
        w.name warehouse_name
      FROM invoice_items pi JOIN items i ON i.id=pi.item_id JOIN warehouses w ON w.id=pi.warehouse_id
      WHERE pi.invoice_id=? ORDER BY pi.id`).all(id);
    return doc;
  });

  ipcMain.handle('sales:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم الفاتورة مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!TYPE_LABEL[doc.invoice_type]) throw new Error('نوع الفاتورة غير صالح');
    if (!checkDocNumber(db, 'invoices', number, doc.id)) throw new Error('رقم الفاتورة مكرر');
    const paymentMethod = doc.payment_method === 'cash' ? 'cash' : 'credit';
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM invoices WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        // التعديل يمسح بنود الفاتورة ويعيد كتابتها، فمرتجعاتها وتسليماتها تسقط referencesها
        const deps = docDelete.collectDeps(db, INVOICE_SPEC, id);
        if (deps.length) throw new Error(docDelete.depsMessage(deps));
        oldItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(id);
        db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
        db.prepare(`UPDATE invoices SET doc_number=?, doc_date=?, party_id=?, invoice_type=?, driver_name=?, car_number=?, notes=?, payment_method=? WHERE id=?`)
          .run(number, doc.doc_date, doc.party_id || null, doc.invoice_type,
            doc.driver_name || null, doc.car_number || null, doc.notes || null, paymentMethod, id);
      } else {
        id = db.prepare(`INSERT INTO invoices (doc_number, doc_date, party_id, invoice_type, driver_name, car_number, notes, payment_method, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.party_id || null, doc.invoice_type,
            doc.driver_name || null, doc.car_number || null, doc.notes || null, paymentMethod, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO invoice_items
        (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const price = Number(it.unit_price) || 0;
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket)
          ? it.bucket : (doc.invoice_type === 'scrap' ? 'talef' : 'salem');
        if (doc.invoice_type !== 'blowing_fee') {
          const bal = getBalance(db, it.item_id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) throw new Error(`رصيد ${bucketLabel} غير كافٍ للصنف ${item.code} (المطلوب ${pieces} حبة والمتوفر ${available})`);
          moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
        }
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, price, price * it.quantity, it.notes || null, bucket);
      }
      writeMoves(db, 'invoice', id, number, doc.doc_date, moves, userId);
      // أرصدة سليم/تالف/محرز: عكس أثر البنود القديمة ثم تطبيق الجديدة (الفاتورة تخصم سلة كل بند)
      if (oldItems.length && before.invoice_type !== 'blowing_fee') applyBucketsDelta(db, oldItems, 1);
      if (doc.invoice_type !== 'blowing_fee') applyBucketsDelta(db, moves, -1);
      // الأثر المحاسبي: ذمة على العميل + قبض نقدي إن كانت نقدية
      const total = db.prepare(`SELECT COALESCE(SUM(total_price),0) t FROM invoice_items WHERE invoice_id=?`).get(id).t;
      ledger.invoiceEffect(db, { docType: 'invoice', doc: { ...doc, id, payment_method: paymentMethod }, total, userId });
    });
    audit(db, userId, isNew ? 'create' : 'update', 'invoice', id, before, doc);
    return { id };
  });

  ipcMain.handle('sales:impact', (e, id) => docDelete.impact(getDb(), INVOICE_SPEC, id));

  ipcMain.handle('sales:delete', (e, id, userId) => docDelete.hardDelete(getDb(), INVOICE_SPEC, id, userId));
};
