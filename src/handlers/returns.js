const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance, applyBucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');
const ledger = require('../ledger');

// مرتجعات البيع: البضاعة تعود للمخزون + تخفيض ذمة العميل (أو استرداد نقد)
// مرتجعات الشراء: البضاعة تخرج من المخزون + تخفيض ذمة المورد (أو قبض نقد)
const TYPE_BUCKET = { sale: 'salem', scrap: 'talef' };

function saleBucketOf(db, invoiceId) {
  const inv = db.prepare('SELECT invoice_type FROM invoices WHERE id=?').get(invoiceId);
  return inv ? TYPE_BUCKET[inv.invoice_type] : null;
}

// سلة بند فاتورة البيع المطابق للصنف — يرثها مرتجع البيع افتراضياً
function saleLineBucketOf(db, invoiceId, itemId) {
  const line = db.prepare(`SELECT bucket FROM invoice_items WHERE invoice_id=? AND item_id=? ORDER BY id LIMIT 1`)
    .get(invoiceId, itemId);
  return line && line.bucket ? line.bucket : (saleBucketOf(db, invoiceId) || 'salem');
}

function maxReturnable(db, table, refCol, refId, itemId, excludeId = null) {
  const orig = db.prepare(`SELECT COALESCE(SUM(pieces),0) p FROM ${table} WHERE ${refCol}=? AND item_id=?`)
    .get(refId, itemId).p;
  const ret = db.prepare(`SELECT COALESCE(SUM(ri.pieces),0) p
    FROM ${table === 'invoice_items' ? 'sales_return_items' : 'purchase_return_items'} ri
    JOIN ${table === 'invoice_items' ? 'sales_returns' : 'purchase_returns'} r ON r.id = ri.return_id
    WHERE r.${refCol}=? AND r.status='active' AND ri.item_id=? ${excludeId != null ? 'AND r.id != ?' : ''}`)
    .get(refId, itemId, ...(excludeId != null ? [excludeId] : [])).p;
  return orig - ret;
}

module.exports = function register(ipcMain) {
  ipcMain.handle('returns:suggest', () => {
    const db = getDb();
    return {
      sale: suggestNumber(db, 'sales_returns'),
      purchase: suggestNumber(db, 'purchase_returns'),
    };
  });

  ipcMain.handle('returns:list', () => {
    const db = getDb();
    return {
      sales: db.prepare(`SELECT r.*, pa.name party_name, inv.doc_number invoice_number,
          (SELECT COALESCE(SUM(total_price),0) FROM sales_return_items WHERE return_id=r.id) total
        FROM sales_returns r LEFT JOIN parties pa ON pa.id=r.party_id
        LEFT JOIN invoices inv ON inv.id=r.invoice_id ORDER BY r.id DESC`).all(),
      purchases: db.prepare(`SELECT r.*, pa.name party_name, pu.doc_number purchase_number,
          (SELECT COALESCE(SUM(total_price),0) FROM purchase_return_items WHERE return_id=r.id) total
        FROM purchase_returns r LEFT JOIN parties pa ON pa.id=r.party_id
        LEFT JOIN purchases pu ON pu.id=r.purchase_id ORDER BY r.id DESC`).all(),
    };
  });

  ipcMain.handle('returns:getSale', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT r.*, pa.name party_name, inv.doc_number invoice_number, inv.invoice_type
      FROM sales_returns r LEFT JOIN parties pa ON pa.id=r.party_id
      LEFT JOIN invoices inv ON inv.id=r.invoice_id WHERE r.id=?`).get(id);
    if (!doc) throw new Error('المرتجع غير موجود');
    doc.items = db.prepare(`SELECT ri.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag,
        i.unit_name, w.name warehouse_name
      FROM sales_return_items ri JOIN items i ON i.id=ri.item_id JOIN warehouses w ON w.id=ri.warehouse_id
      WHERE ri.return_id=? ORDER BY ri.id`).all(id);
    return doc;
  });

  ipcMain.handle('returns:getPurchase', (e, id) => {
    const db = getDb();
    const doc = db.prepare(`SELECT r.*, pa.name party_name, pu.doc_number purchase_number
      FROM purchase_returns r LEFT JOIN parties pa ON pa.id=r.party_id
      LEFT JOIN purchases pu ON pu.id=r.purchase_id WHERE r.id=?`).get(id);
    if (!doc) throw new Error('المرتجع غير موجود');
    doc.items = db.prepare(`SELECT ri.*, i.code, i.name, i.weight_grams, i.pieces_per_carton, i.pieces_per_bag,
        i.unit_name, w.name warehouse_name
      FROM purchase_return_items ri JOIN items i ON i.id=ri.item_id JOIN warehouses w ON w.id=ri.warehouse_id
      WHERE ri.return_id=? ORDER BY ri.id`).all(id);
    return doc;
  });

  ipcMain.handle('returns:available', (e, type, refId, excludeId = null) => {
    const db = getDb();
    const isSale = type === 'sale';
    const items = db.prepare(`SELECT pi.*, i.code, i.name, i.weight_grams, i.pieces_per_carton,
        i.pieces_per_bag, i.unit_name
      FROM ${isSale ? 'invoice_items' : 'purchase_items'} pi JOIN items i ON i.id=pi.item_id
      WHERE pi.${isSale ? 'invoice_id' : 'purchase_id'}=? ORDER BY pi.id`).all(refId);
    const retTable = isSale ? 'sales_return_items' : 'purchase_return_items';
    const retHead = isSale ? 'sales_returns' : 'purchase_returns';
    const retCol = isSale ? 'invoice_id' : 'purchase_id';
    for (const it of items) {
      const ret = db.prepare(`SELECT COALESCE(SUM(ri.pieces),0) p
        FROM ${retTable} ri JOIN ${retHead} r ON r.id = ri.return_id
        WHERE r.${retCol}=? AND r.status='active' AND ri.item_id=? ${excludeId != null ? 'AND r.id != ?' : ''}`)
        .get(refId, it.item_id, ...(excludeId != null ? [excludeId] : [])).p;
      it.remain = Math.max(0, (Number(it.pieces) || 0) - ret);
    }
    return items;
  });

  ipcMain.handle('returns:save', (e, doc, userId) => {
    const db = getDb();
    const number = String(doc.doc_number || '').trim();
    if (!number) throw new Error('رقم المرتجع مطلوب (ترقيم يدوي)');
    if (!doc.doc_date) throw new Error('التاريخ مطلوب');
    if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
    if (!['sale', 'purchase'].includes(doc.type)) throw new Error('نوع المرتجع غير صالح');
    const paymentMethod = doc.payment_method === 'cash' ? 'cash' : 'credit';
    const isSale = doc.type === 'sale';
    const table = isSale ? 'sales_returns' : 'purchase_returns';
    const itemsTable = isSale ? 'sales_return_items' : 'purchase_return_items';
    const refTable = isSale ? 'invoices' : 'purchases';
    const refCol = isSale ? 'invoice_id' : 'purchase_id';
    if (!checkDocNumber(db, table, number, doc.id)) throw new Error('رقم المرتجع مكرر');

    const source = db.prepare(`SELECT * FROM ${refTable} WHERE id=? AND status='active'`)
      .get(isSale ? doc.invoice_id : doc.purchase_id);
    if (!source) throw new Error(isSale ? 'فاتورة البيع غير موجودة أو ملغاة' : 'فاتورة الشراء غير موجودة أو ملغاة');
    // الطرف يُرث من الفاتورة الأصلية إن لم يُحدد
    const partyId = doc.party_id != null ? doc.party_id : source.party_id;

    const isNew = !doc.id;
    const before = isNew ? null : db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      let oldItems = [];
      if (id) {
        oldItems = db.prepare(`SELECT * FROM ${itemsTable} WHERE return_id=?`).all(id);
        db.prepare(`DELETE FROM ${itemsTable} WHERE return_id=?`).run(id);
        // عكس الأثر القديم كاملاً قبل تطبيق الجديد (كل بند يحمل سلة خاصة)
        voidDoc(db, isSale ? 'sale_return' : 'purchase_return', id, userId);
        // مرتجع البيع كان +سلة فالعكس خصم، ومرتجع الشراء كان −سليم فالعكس إضافة
        applyBucketsDelta(db, oldItems, isSale ? -1 : 1);
        ledger.voidDoc(db, isSale ? 'sale_return' : 'purchase_return', id);
        db.prepare(`UPDATE ${table} SET doc_number=?, doc_date=?, ${refCol}=?, party_id=?, payment_method=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, isSale ? doc.invoice_id : doc.purchase_id,
            partyId || null, paymentMethod, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO ${table} (doc_number, doc_date, ${refCol}, party_id, payment_method, notes, created_by)
          VALUES (?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, isSale ? doc.invoice_id : doc.purchase_id,
            partyId || null, paymentMethod, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const insItem = db.prepare(`INSERT INTO ${itemsTable}
        (return_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes, bucket)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        if (!item) throw new Error('صنف غير موجود');
        const pieces = toPieces(it.quantity, it.unit, item);
        if (pieces <= 0) throw new Error(`كمية غير صالحة للصنف ${item.code}`);
        // لا يجوز إرجاع أكثر من كمية الفاتورة الأصلية (بعد خصم المرتجعات السابقة)
        const remaining = maxReturnable(db,
          isSale ? 'invoice_items' : 'purchase_items', refCol,
          isSale ? doc.invoice_id : doc.purchase_id, item.id, doc.id);
        if (pieces > remaining) {
          throw new Error(`كمية الإرجاع للصنف ${item.code} تتجاوز المتبقي من الفاتورة الأصلية (المتبقي ${remaining} حبة)`);
        }
        const bucket = ['salem', 'talef', 'muharraz'].includes(it.bucket)
          ? it.bucket
          : (isSale ? saleLineBucketOf(db, doc.invoice_id, item.id) : 'salem');
        if (!isSale) {
          const bal = getBalance(db, item.id, it.warehouse_id);
          const available = bal[`qty_${bucket}`] || 0;
          const bucketLabel = { salem: 'السليم', talef: 'التالف', muharraz: 'المحرز' }[bucket];
          if (available < pieces) {
            throw new Error(`رصيد ${bucketLabel} غير كافٍ لإرجاع الصنف ${item.code} للمورد (المطلوب ${pieces} والمتوفر ${available})`);
          }
        }
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const price = Number(it.unit_price) || 0;
        insItem.run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg, price, price * it.quantity, it.notes || null, bucket);
        moves.push(isSale
          ? { item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, bucket, notes: it.notes }
          : { item_id: item.id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg, bucket, notes: it.notes });
      }
      writeMoves(db, isSale ? 'sale_return' : 'purchase_return', id, number, doc.doc_date, moves, userId);
      // أثر السلات: مرتجع البيع يزيد سلة كل بند، ومرتجع الشراء يخصمها
      applyBucketsDelta(db, moves, isSale ? 1 : -1);
      const total = db.prepare(`SELECT COALESCE(SUM(total_price),0) t FROM ${itemsTable} WHERE return_id=?`).get(id).t;
      ledger.returnEffect(db, {
        docType: isSale ? 'sale_return' : 'purchase_return',
        doc: {
          ...doc, id, party_id: partyId, payment_method: paymentMethod,
          invoice_number: isSale ? source.doc_number : undefined,
          purchase_number: isSale ? undefined : source.doc_number,
        },
        total, userId,
      });
    });
    audit(db, userId, isNew ? 'create' : 'update', isSale ? 'sale_return' : 'purchase_return', id, before, doc);
    return { id };
  });

  ipcMain.handle('returns:void', (e, doc, userId) => {
    const db = getDb();
    if (!['sale', 'purchase'].includes(doc.type)) throw new Error('نوع المرتجع غير صالح');
    const isSale = doc.type === 'sale';
    const table = isSale ? 'sales_returns' : 'purchase_returns';
    const itemsTable = isSale ? 'sales_return_items' : 'purchase_return_items';
    const before = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(doc.id);
    if (!before) throw new Error('المرتجع غير موجود');
    const oldItems = db.prepare(`SELECT * FROM ${itemsTable} WHERE return_id=?`).all(doc.id);
    withTransaction(db, () => {
      voidDoc(db, isSale ? 'sale_return' : 'purchase_return', doc.id, userId);
      applyBucketsDelta(db, oldItems, isSale ? -1 : 1);
      ledger.voidDoc(db, isSale ? 'sale_return' : 'purchase_return', doc.id);
      db.prepare(`UPDATE ${table} SET status='void' WHERE id=?`).run(doc.id);
    });
    audit(db, userId, 'void', isSale ? 'sale_return' : 'purchase_return', doc.id, before, null);
    return { ok: true };
  });
};
