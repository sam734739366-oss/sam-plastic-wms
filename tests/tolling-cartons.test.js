const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');

// كمية خام العميل 12000 حبة، والصنف عبوة وكرتونُه 5000 حبة
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare('INSERT INTO machines (name) VALUES (?)').run('مكينة 1');
  d.prepare('INSERT INTO shifts (name) VALUES (?)').run('صباحية');
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag)
    VALUES (?,?,?,?,?,?,?)`).run('001', 'عبوة 1 لتر', 2, 'عبوة', 25, 5000, 100);
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams)
    VALUES (?,?,?,?,?)`).run('NOPPC', 'صنف بلا قياس كرتون', 1, 'عبوة', 10);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل أ', 'customer');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل ب', 'customer');
  return d;
}

function stubIpc() {
  const handlers = {};
  for (const f of ['purchases', 'issues', 'production', 'tolling', 'scrap']) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

const talef = (db) => db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef;
const remaining = (h, name) => h['tolling:balance']().find(r => r.name === name).remaining;

/** يستلم سند خام عميل ويعيد قائمة الكراتين */
function receive(h, partyId, number, items) {
  const { id } = h['tolling:receiptSave'](null, { doc_number: number, doc_date: '2026-10-18', party_id: partyId, items }, 1);
  return h['tolling:receiptGet'](null, id);
}

// ---------------------------------------------------------------- [A] فائض الكراتين

test('كراتين خام العميل تغطي الكمية كاملة مع كرتونة ناقصة أخيرة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const doc = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 12000, unit: 'عبوة' }]);
  assert.deepEqual(doc.cartons.map(c => c.carton_number), ['C-1', 'C-2', 'C-3']);
  assert.deepEqual(doc.cartons.map(c => c.pieces), [5000, 5000, 2000]);
  const sum = doc.cartons.reduce((s, c) => s + c.pieces, 0);
  assert.equal(sum, 12000, 'لا يجوز أن تضيع حبات بين الكمية والكراتين');
  for (const c of doc.cartons) {
    assert.equal(c.source, 'customer');
    assert.equal(c.party_id, 1);
    assert.equal(c.status, 'in_stock');
    assert.equal(c.receipt_id, doc.id);
  }
});

test('الكراتين تستأنف الترقيم من آخر C- سابق ولا تتصادم مع كراتين المصنع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, { doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }] }, 1);
  const a = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 10000, unit: 'عبوة' }]);
  const b = receive(h, 1, 'R-2', [{ item_id: 1, quantity: 5000, unit: 'عبوة' }]);
  assert.deepEqual(a.cartons.map(c => c.carton_number), ['C-1', 'C-2']);
  assert.deepEqual(b.cartons.map(c => c.carton_number), ['C-3']);
  assert.deepEqual(db.prepare("SELECT carton_number FROM cartons WHERE source='own' ORDER BY carton_number").all()
    .map(r => r.carton_number), ['K-1', 'K-2']);
});

test('صنف بلا «حبات/كرتون» لا يُولّد كراتين ولا يفشل السند', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const doc = receive(h, 1, 'R-1', [{ item_id: 2, quantity: 700, unit: 'عبوة' }]);
  assert.equal(doc.cartons.length, 0);
  assert.equal(doc.items[0].pieces, 700);
});

test('تعديل سند الخام يعيد توليد الكراتين، ويُمتنع بعد الصرف للإنتاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const doc = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 10000, unit: 'عبوة' }]);
  h['tolling:receiptSave'](null, { id: doc.id, doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 15000, unit: 'عبوة' }] }, 1);
  const after = h['tolling:receiptGet'](null, doc.id);
  assert.deepEqual(after.cartons.map(c => c.pieces), [5000, 5000, 5000]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons').get().c, 3, 'الكراتين القديمة حُذفت لا تكرّرت');

  h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['C-1'] }] }, 1);
  assert.throws(() => h['tolling:receiptSave'](null, { id: doc.id, doc_number: 'R-1', doc_date: '2026-10-18',
    party_id: 1, items: [{ item_id: 1, quantity: 5000, unit: 'عبوة' }] }, 1), /كراتين مصروفة للإنتاج/);
});

test('إلغاء سند الخام يحذف كراتينه غير المصروفة ويمنع إلغاء المصروفة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const doc = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 10000, unit: 'عبوة' }]);
  h['tolling:receiptVoid'](null, doc.id, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons').get().c, 0);
  assert.equal(db.prepare('SELECT status FROM customer_raw_receipts WHERE id=?').get(doc.id).status, 'void');
});

// ---------------------------------------------------------------- [B] عزل المصادر

test('قائمة الكراتين لا تخلط كراتين العميل بكراتين المصنع ولا بعهدة عميل آخر', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, { doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }] }, 1);
  receive(h, 1, 'R-A', [{ item_id: 1, quantity: 5000, unit: 'عبوة' }]);
  receive(h, 2, 'R-B', [{ item_id: 1, quantity: 5000, unit: 'عبوة' }]);

  const own = h['issues:cartonsAvailable'](null, 1, 'own').map(c => c.carton_number);
  const a = h['issues:cartonsAvailable'](null, 1, 'customer', 1).map(c => c.carton_number);
  const b = h['issues:cartonsAvailable'](null, 1, 'customer', 2).map(c => c.carton_number);
  assert.deepEqual(own, ['K-1']);
  assert.deepEqual(a, ['C-1']);
  assert.deepEqual(b, ['C-2']);
  assert.deepEqual(h['issues:cartonsAvailable'](null, 1, 'customer', null), [], 'بلا عميل لا كراتين');
});

test('لا يجوز صرف كرتونة عميل على تصريح خام المصنع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  receive(h, 1, 'R-1', [{ item_id: 1, quantity: 5000, unit: 'عبوة' }]);
  assert.throws(() => h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['C-1'] }] }, 1), /غير متاح/);
});

test('الكمية المصروفة تُحسب من حبات الكراتين الفعلية لا من عددها', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  receive(h, 1, 'R-1', [{ item_id: 1, quantity: 12000, unit: 'عبوة' }]);
  const { id } = h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'customer', party_id: 1,
    // 3 كراتين منها الناقصة (2000) — الحساب بالعدد كان يعطي 15000
    items: [{ item_id: 1, warehouse_id: 1, quantity: 3, unit: 'كرتون', carton_ids: ['C-1', 'C-2', 'C-3'] }] }, 1);
  const li = db.prepare('SELECT pieces FROM issue_items WHERE issue_permit_id=?').get(id);
  assert.equal(li.pieces, 12000);
  assert.deepEqual(db.prepare("SELECT status FROM cartons ORDER BY carton_number").all().map(r => r.status),
    ['issued', 'issued', 'issued']);
});

test('صرف كراتين العميل لا يحرّك مخزون المصنع ولا سلاته', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  receive(h, 1, 'R-1', [{ item_id: 1, quantity: 5000, unit: 'عبوة' }]);
  const before = getBalance(db, 1, 1);
  h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['C-1'] }] }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, before.balance_pieces);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves").get().c, 0);
  assert.equal(talef(db), 0);
});

// -------------------------------------------------- [C]+[D] توجيه التالف لرصيد العميل

function issueCustomerCarton(h, db, carton = 'C-1') {
  receive(h, 1, 'R-1', [{ item_id: 1, quantity: 12000, unit: 'عبوة' }]);
  h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: [carton] }] }, 1);
  return db.prepare('SELECT id, pieces FROM cartons WHERE carton_number=?').get(carton);
}

const defectDoc = (db, cartonId) => db.prepare(
  "SELECT * FROM scrap_movements WHERE prod_carton_id=?").get(cartonId);

test('تالف الإنتاج بخام العميل يخصم من رصيد العميل ولا يمس تالف المصنع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  const balBefore = remaining(h, 'عميل أ');

  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20',
    good_pieces: 4500, defect_before: 300, defect_after: 200 }, 1);

  assert.equal(talef(db), 0, 'سلّة تالف المصنع يجب أن تبقى صفرًا');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production'").get().c, 0);
  const sc = defectDoc(db, carton.id);
  assert.equal(sc.is_customer, 1);
  assert.equal(sc.party_id, 1);
  assert.equal(sc.pieces, 500);
  assert.equal(sc.disposition, 'production_defect');
  assert.equal(sc.warehouse_id, null);
  assert.equal(sc.talef_take, 0);
  assert.equal(remaining(h, 'عميل أ'), balBefore - 500);
  assert.equal(remaining(h, 'عميل ب'), 0, 'عميل آخر لا يتأثر');
});

test('تعديل النتيجة يحدّث السند نفسه ولا ينشئ مستنداً مكرراً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_before: 500 }, 1);
  const firstId = defectDoc(db, carton.id).id;
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-21', good_pieces: 4700, defect_before: 300 }, 1);
  const rows = db.prepare('SELECT * FROM scrap_movements').all();
  assert.equal(rows.length, 1, 'مستند واحد لكل كرتون');
  assert.equal(defectDoc(db, carton.id).id, firstId);
  assert.equal(defectDoc(db, carton.id).pieces, 300);
  assert.equal(remaining(h, 'عميل أ'), 12000 - 300);
});

test('تصفير التالف يُلغي السند فيعود رصيد العميل، ثم يُعاد تنشيطه بالزيادة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_after: 500 }, 1);
  assert.equal(remaining(h, 'عميل أ'), 11500);

  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 5000 }, 1);
  assert.equal(defectDoc(db, carton.id).status, 'void');
  assert.equal(remaining(h, 'عميل أ'), 12000, 'التالف صفر ⇒ الخصم صفر');

  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-21', good_pieces: 4800, defect_after: 200 }, 1);
  const sc = defectDoc(db, carton.id);
  assert.equal(sc.status, 'active', 'سند ملغى سابقاً يجب أن يعود نشطاً وإلا ضاع التالف');
  assert.equal(sc.pieces, 200);
  assert.equal(remaining(h, 'عميل أ'), 11800);
});

test('حذف النتيجة يُلغي سند تالف العميل ويعيد رصيده', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_before: 500 }, 1);
  assert.equal(remaining(h, 'عميل أ'), 11500);
  h['production:delete'](null, carton.id, 1);
  assert.equal(defectDoc(db, carton.id).status, 'void');
  assert.equal(remaining(h, 'عميل أ'), 12000);
  assert.equal(talef(db), 0);
});

test('عدد المستند المُولّد لا يتصادم مع مستند تالف يدوي بنفس الاسم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  // مستند يدوي يشغل الاسم الذي كان التوليد القديم سيستخدمه (تالف عميل بلا فحص رصيد)
  h['scrap:save'](null, { doc_number: 'تالف إنتاج C-1', doc_date: '2026-10-19', item_id: 1,
    disposition: 'sold_scrap', party_id: 1, pieces: 10, weight_kg: 0.25 }, 1);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_before: 500 }, 1);
  const sc = defectDoc(db, carton.id);
  assert.equal(sc.doc_number, 'تالف إنتاج C-1-2');
  assert.equal(db.prepare("SELECT pieces FROM scrap_movements WHERE doc_number='تالف إنتاج C-1'").get().pieces, 10,
    'المستند اليدوي لم يُمس');
});

test('سندات التالف الآلية محمية من التعديل والإلغاء اليدوي', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const carton = issueCustomerCarton(h, db);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_before: 500 }, 1);
  const sc = defectDoc(db, carton.id);
  assert.throws(() => h['scrap:save'](null, { id: sc.id, doc_number: 'X', doc_date: '2026-10-20', item_id: 1,
    disposition: 'sold_scrap', warehouse_id: 1, pieces: 99, weight_kg: 1 }, 1), /آلي/);
  assert.throws(() => h['scrap:void'](null, sc.id, 1), /آلي/);
});

// ---------------------------------------------------------------- ترقية قاعدة قديمة
// انظر tests/migration.test.js: ترقية قاعدة قديمة إلى كراتين العميل وقيد المصير الجديد

// ---------------------------------------------------------- عدم الانحراف عن خام المصنع

test('تالف خام المصنع ما زال يزيد سلّة التالف ويكتب حركة مخزون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, { doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }] }, 1);
  h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }] }, 1);
  const carton = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get();
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-20', good_pieces: 4500, defect_before: 500 }, 1);
  assert.equal(talef(db), 500);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM scrap_movements").get().c, 0);
  const mv = db.prepare("SELECT qty_in_pieces, bucket FROM stock_moves WHERE doc_type='production'").get();
  assert.equal(mv.qty_in_pieces, 500);
  assert.equal(mv.bucket, 'talef');
  // تعديل ثم تصفير يعكس السلّة بدقة
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-21', good_pieces: 5000 }, 1);
  assert.equal(talef(db), 0);
});
