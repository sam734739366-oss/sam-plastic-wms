const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { toPieces, piecesToWeightKg } = require('../units');
const { writeMoves, voidDoc, getBalance, bucketsDelta } = require('../stock');
const { suggestNumber, checkDocNumber } = require('../docs');

const DISP_LABEL = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' };

// حساب توزيع الخصم: يخصم من التالف أولاً والباقي من السليم.
// يُخزَّن التوزيع مع السند لعكس الأثر بدقة عند التعديل والإلغاء.
function computeDeltas(db, doc) {
  const item = db.prepare('SELECT * FROM items WHERE id=?').get(doc.item_id);
  if (!item) throw new Error('صنف غير موجود');
  let total = Math.max(0, Math.round(Number(doc.pieces) || 0));
  const weight = Math.max(0, Number(doc.weight_kg) || 0);
  if (total <= 0 && weight > 0) total = toPieces(weight, 'كجم', item);
  if (total <= 0) return { talef_take: 0, salem_take: 0 };
  const talefTake = Math.min(total, Number(item.qty_talef) || 0);
  return { talef_take: talefTake, salem_take: total - talefTake };
}

// تطبيق أثر السند المخزن على السلات (sign=1 تطبيق، sign=-1 عكس)
function applyStored(db, row, sign) {
  if (Number(row.is_customer) === 1) return;
  const d = computeStoredDeltas(row);
  bucketsDelta(db, row.item_id, {
    salem: sign * d.salem,
    talef: sign * d.talef,
    muharraz: sign * d.muharraz,
  });
}

function computeStoredDeltas(row) {
  const talefTake = Number(row.talef_take) || 0;
  const salemTake = Number(row.salem_take) || 0;
  const total = talefTake + salemTake;
  switch (row.disposition) {
    case 'to_recycled':
      return { salem: -salemTake, talef: -talefTake, muharraz: total };
    case 'to_stock':
      // عاد للتخزين كسليم: ما خرج من التالف يصبح سليماً
      return { salem: talefTake, talef: -talefTake, muharraz: 0 };
    default: // to_supplier / sold_scrap: خروج نهائي
      return { salem: -salemTake, talef: -talefTake, muharraz: 0 };
  }
}

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
    const doc = db.prepare(`SELECT s.*, i.code item_code, i.name item_name, i.weight_grams,
        i.qty_salem, i.qty_talef, i.qty_muharraz,
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
    const pieces = Math.max(0, Math.round(Number(doc.pieces) || 0));
    const weight = Math.max(0, Number(doc.weight_kg) || 0);
    if (pieces <= 0 && weight <= 0) throw new Error('أدخل كمية (حبات أو وزن)');
    const party = doc.party_id ? db.prepare('SELECT * FROM parties WHERE id=?').get(doc.party_id) : null;
    const isCustomer = party && (party.type === 'customer' || party.type === 'both') ? 1 : 0;
    if (!isCustomer && ['to_recycled', 'to_stock', 'sold_scrap', 'to_supplier'].includes(doc.disposition) && !doc.warehouse_id) {
      throw new Error('اختر المخزن');
    }
    const isNew = !doc.id;
    const before = isNew ? null : db.prepare('SELECT * FROM scrap_movements WHERE id=?').get(doc.id);
    let id = doc.id;
    withTransaction(db, () => {
      // عكس أثر السند القديم أولاً (بدقة حسب التوزيع المخزن)
      if (before) applyStored(db, before, -1);
      const d = isCustomer ? { talef_take: 0, salem_take: 0 } : computeDeltas(db, doc);
      if (id) {
        db.prepare(`UPDATE scrap_movements SET doc_number=?, doc_date=?, item_id=?, disposition=?, warehouse_id=?, party_id=?,
          pieces=?, weight_kg=?, price=?, talef_take=?, salem_take=?, is_customer=?, notes=? WHERE id=?`)
          .run(number, doc.doc_date, doc.item_id, doc.disposition, doc.warehouse_id || null,
            doc.party_id || null, pieces, weight, doc.price || null, d.talef_take, d.salem_take, isCustomer, doc.notes || null, id);
      } else {
        id = db.prepare(`INSERT INTO scrap_movements
          (doc_number, doc_date, item_id, disposition, warehouse_id, party_id, pieces, weight_kg, price,
           talef_take, salem_take, is_customer, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(number, doc.doc_date, doc.item_id, doc.disposition, doc.warehouse_id || null,
            doc.party_id || null, pieces, weight, doc.price || null,
            d.talef_take, d.salem_take, isCustomer, doc.notes || null, userId).lastInsertRowid;
      }
      const moves = [];
      const kg = weight || piecesToWeightKg(pieces, item.weight_grams || 0);
      if (!isCustomer) {
        const talefTake = Number(d.talef_take) || 0;
        const salemTake = Number(d.salem_take) || 0;
        // الخصم من سلات المخزن المحدد نفسه (لا من عداد الصنف الإجمالي) حتى لا يُسحب
        // من مخزن لا يملك الرصيد في السلة المطلوبة.
        // عند التعديل: حركات السند القديم ما زالت في الجدول حتى يُكتب عكسها، لذا إن كان
        // السند في نفس المخزن يُعاد الخصم القديم إلى الرصيد المتاح قبل الفحص.
        const bal = getBalance(db, item.id, doc.warehouse_id);
        const sameWh = before && !Number(before.is_customer) && Number(before.warehouse_id) === Number(doc.warehouse_id);
        const availTalef = bal.qty_talef + (sameWh ? (Number(before.talef_take) || 0) : 0);
        const availSalem = bal.qty_salem + (sameWh ? (Number(before.salem_take) || 0) : 0);
        if (availTalef < talefTake) {
          throw new Error(`الرصيد التالف غير كافٍ للصنف ${item.code} في المخزن المحدد (المتوفر ${availTalef} حبة)`);
        }
        if (availSalem < salemTake) {
          throw new Error(`الرصيد السليم غير كافٍ للصنف ${item.code} في المخزن المحدد (المتوفر ${availSalem} حبة)`);
        }
        const pushOut = (qty, bucket) => {
          if (qty > 0) moves.push({
            item_id: item.id, warehouse_id: doc.warehouse_id,
            qty_out_pieces: qty, weight_out_kg: kg * qty / Math.max(1, pieces),
            bucket, notes: doc.notes,
          });
        };
        if (doc.disposition === 'to_recycled' || doc.disposition === 'to_stock') {
          // إخراج التالف/السليم المأخوذ ثم إعادة إدخاله بصفته الجديدة (محرز أو سليم)
          pushOut(talefTake, 'talef');
          pushOut(salemTake, 'salem');
          moves.push({
            item_id: item.id, warehouse_id: doc.warehouse_id,
            qty_in_pieces: pieces, weight_in_kg: kg,
            bucket: doc.disposition === 'to_recycled' ? 'muharraz' : 'salem', notes: doc.notes,
          });
        } else { // sold_scrap / to_supplier: خروج نهائي
          pushOut(talefTake, 'talef');
          pushOut(salemTake, 'salem');
        }
      }
      writeMoves(db, 'scrap', id, number, doc.doc_date, moves, userId);
      // تطبيق الأثر الجديد على السلات
      const savedRow = db.prepare('SELECT * FROM scrap_movements WHERE id=?').get(id);
      applyStored(db, savedRow, 1);
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
      applyStored(db, before, -1);
      db.prepare(`UPDATE scrap_movements SET status='void' WHERE id=?`).run(id);
    });
    audit(db, userId, 'void', 'scrap_movement', id, before, null);
    return { ok: true };
  });
};
