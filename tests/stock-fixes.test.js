const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const ledger = require('../src/ledger');

// اختبارات أخطاء المعالجات المكتشفة بالفحص الشامل للعمليات المخزنية والمحاسبية
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  d.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي')").run(); // 1
  d.prepare("INSERT INTO warehouses (name) VALUES ('مخزن الصابون')").run();   // 2
  d.prepare("INSERT INTO parties (name, type) VALUES ('مورد','supplier')").run();   // 1
  d.prepare("INSERT INTO parties (name, type) VALUES ('عميل','customer')").run();   // 2
  d.prepare("INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_carton,qty_salem,qty_talef,qty_muharraz) VALUES ('A001','امبول',2,'امبول',10,1000,5000,300,200)").run();
  d.prepare("INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_bag,qty_salem,qty_talef,qty_muharraz) VALUES ('B002','علبة',2,'علبة',20,100,2000,100,100)").run();
  const ins = d.prepare(`INSERT INTO stock_moves
    (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, weight_in_kg, bucket, notes)
    VALUES ('opening',?,?,?,?,?,?,?,?,?)`);
  ins.run(1, 'افتتاحي-A001', '2026-10-01', 1, 1, 5000, 50, 'salem', 'افتتاح');
  ins.run(1, 'افتتاحي-A001', '2026-10-01', 1, 1, 300, 3, 'talef', 'افتتاح');
  ins.run(1, 'افتتاحي-A001', '2026-10-01', 1, 1, 200, 2, 'muharraz', 'افتتاح');
  ins.run(2, 'افتتاحي-B002', '2026-10-01', 2, 1, 2000, 40, 'salem', 'افتتاح');
  ins.run(2, 'افتتاحي-B002', '2026-10-01', 2, 1, 100, 2, 'talef', 'افتتاح');
  ins.run(2, 'افتتاحي-B002', '2026-10-01', 2, 1, 100, 2, 'muharraz', 'افتتاح');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

const salem = (db, id) => db.prepare('SELECT qty_salem s FROM items WHERE id=?').get(id).s;

test('تعديل استلام من خام عميل لا يمس رصيد السليم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['receives']);
  const { id } = h['receives:save'](null, {
    doc_number: 'R-C1', doc_date: '2026-10-02', source: 'customer', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }],
  }, 1);
  assert.equal(salem(db, 1), 5000, 'استلام خام العميل لا يزيد السليم');
  // تعديل بنود الاستلام (كمية أقل) — يجب ألا يغيّر السليم إطلاقاً
  h['receives:save'](null, {
    id, doc_number: 'R-C1', doc_date: '2026-10-02', source: 'customer', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة' }],
  }, 1);
  assert.equal(salem(db, 1), 5000, 'تعديل استلام العميل يجب ألا ينقص السليم');
});

test('تعديل وإلغاء صرف من خام عميل لا يمس رصيد السليم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['issues']);
  const { id } = h['issues:save'](null, {
    doc_number: 'I-C1', doc_date: '2026-10-02', source: 'customer', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }],
  }, 1);
  assert.equal(salem(db, 1), 5000, 'صرف خام العميل لا ينقص السليم');
  h['issues:save'](null, {
    id, doc_number: 'I-C1', doc_date: '2026-10-02', source: 'customer', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة' }],
  }, 1);
  assert.equal(salem(db, 1), 5000, 'تعديل صرف العميل يجب ألا يزيد السليم');
  h['issues:void'](null, id, 1);
  assert.equal(salem(db, 1), 5000, 'إلغاء صرف العميل يجب ألا يزيد السليم');
});

test('تعديل مرتجع شراء لا يخصم السليم مرتين', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'returns']);
  const { id: purId } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-02', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1000, unit: 'حبة', unit_price: 5 }],
  }, 1);
  assert.equal(salem(db, 1), 6000);
  const { id: retId } = h['returns:save'](null, {
    doc_number: 'PR-1', doc_date: '2026-10-03', type: 'purchase', purchase_id: purId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 5 }],
  }, 1);
  assert.equal(salem(db, 1), 5700, 'مرتجع الشراء يخصم السليم مرة واحدة');
  // تعديل نفس المرتجع بنفس الكمية: عكس الأثر القديم ثم تطبيق الجديد = صافي الخصم مرة واحدة
  h['returns:save'](null, {
    id: retId, doc_number: 'PR-1', doc_date: '2026-10-03', type: 'purchase', purchase_id: purId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 5 }],
  }, 1);
  assert.equal(salem(db, 1), 5700, 'تعديل المرتجع يجب ألا يضاعف الخصم');
});

test('سند تالف يرفض الخصم من مخزن بلا رصيد في السلة المطلوبة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  // تالف الصنف موجود في المخزن الرئيسي فقط (300)، ومخزن الصابون بلا أي رصيد
  assert.throws(() => h['scrap:save'](null, {
    doc_number: 'S-9', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 200,
  }, 1), /الرصيد التالف غير كافٍ/, 'يجب رفض الخصم من مخزن بلا تالف');
  // الحالة الصحيحة في المخزن الرئيسي تمر وتنقل تالفاً إلى محرز
  h['scrap:save'](null, {
    doc_number: 'S-1', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 1, pieces: 100,
  }, 1);
  const it = db.prepare('SELECT qty_talef t, qty_muharraz m FROM items WHERE id=1').get();
  assert.equal(it.t, 200);
  assert.equal(it.m, 300);
});

test('تعديل سند التالف يعيد الخصم القديم للرصيد قبل فحص المخزن الجديد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  const { getBalance } = require('../src/stock');
  // سند إرجاع محرز في المخزن الرئيسي: تالف 300 → 200 ومحرز 200 → 300
  const { id } = h['scrap:save'](null, {
    doc_number: 'S-1', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 1, pieces: 100,
  }, 1);
  // تعديل في نفس المخزن بكمية أكبر: الخصم القديم (100) يعود للرصيد المتاح قبل الفحص
  h['scrap:save'](null, {
    id, doc_number: 'S-1', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 1, pieces: 250,
  }, 1);
  let it = db.prepare('SELECT qty_talef t, qty_muharraz m FROM items WHERE id=1').get();
  assert.equal(it.t, 50, 'التعديل يخصم 250 تالفاً (300 − 250)');
  assert.equal(it.m, 450, 'الإرجاع المحرز 250');
  // نقل السند إلى مخزن الصابون (فارغ) يجب أن يُرفض لأنه لا يملك التالف
  assert.throws(() => h['scrap:save'](null, {
    id, doc_number: 'S-1', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 50,
  }, 1), /الرصيد التالف غير كافٍ/, 'مخزن بلا رصيد تالف يرفض السند');
  // تزويد مخزن الصابون بتالف ثم نقل السند إليه بنجاح
  db.prepare(`INSERT INTO stock_moves
    (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, bucket)
    VALUES ('opening',1,'تالف-صابون','2026-10-01',1,2,100,'talef')`).run();
  h['scrap:save'](null, {
    id, doc_number: 'S-1', doc_date: '2026-10-02', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 50,
  }, 1);
  it = db.prepare('SELECT qty_talef t, qty_muharraz m FROM items WHERE id=1').get();
  assert.equal(it.t, 250, 'الخصم القديم (250) عاد بالكامل عند نقل المخزن ثم خصم 50 فقط');
  assert.equal(it.m, 250, 'المحرز 200 + 50');
  const wh1 = getBalance(db, 1, 1), wh2 = getBalance(db, 1, 2);
  assert.equal(wh1.qty_talef, 300, 'المخزن الرئيسي استعاد تالفه بعد نقل السند');
  assert.equal(wh2.qty_talef, 50, 'مخزن الصابون خصم منه 50 تالفاً');
  assert.equal(wh2.qty_muharraz, 50, 'المحرز الجديد في مخزن الصابون');
});

test('فاتورة أجرة النفخ المنشأة من سند التسليم تسجل في دفتر الأطراف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  h['tolling:receiptSave'](null, {
    doc_number: 'TR-1', doc_date: '2026-10-02', party_id: 2,
    items: [{ item_id: 1, quantity: 1000, unit: 'حبة' }],
  }, 1);
  h['tolling:deliverySave'](null, {
    doc_number: 'TD-1', doc_date: '2026-10-03', party_id: 2,
    items: [{ item_id: 2, quantity: 500, unit: 'حبة' }],
    invoice: { create: true, doc_number: 'F-1', doc_date: '2026-10-03', items: [{ item_id: 2, quantity: 1, unit_price: 7000 }] },
  }, 1);
  const row = db.prepare("SELECT * FROM party_ledger WHERE doc_type='invoice' AND doc_id=(SELECT id FROM invoices WHERE doc_number='F-1')").get();
  assert.ok(row, 'يجب تسجيل أثر فاتورة الأجرة في الدفتر');
  assert.equal(row.side, 'debit');
  assert.equal(row.amount, 7000);
  assert.equal(ledger.partyBalance(db, 2), 7000, 'ذمة العميل تزيد بقيمة الأجرة');
  assert.equal(ledger.cashBalance(db), 0, 'فاتورة آجلة لا تلمس النقدية');
});
