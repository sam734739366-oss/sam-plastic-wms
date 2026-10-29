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
    party_id: 1, items: [{ item_id: 1, quantity: 5000, unit: 'عبوة' }] }, 1), /كراتين صُرفت للإنتاج/);
  assert.deepEqual(h['tolling:receiptImpact'](null, doc.id).deps.map((x) => x.number), ['C-1'],
    'النافذة تعرض الكرتون المانع قبل التأكيد');
  // لا تعديل ولا حذف ما دامت السلسلة قائمة
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons').get().c, 3);
});

test('حذف سند الخام يحذف كراتينه غير المصروفة ويمنع حذف المصروفة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const doc = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 10000, unit: 'عبوة' }]);
  const { id: issId } = h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19',
    source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['C-1'] }] }, 1);
  const err = (() => { try { h['tolling:receiptDelete'](null, doc.id, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /C-1/.test(err.message) && /احذف الأحدث/.test(err.message), err && err.message);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons').get().c, 2, 'لا كراتين حُذفت بالمنع');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_raw_receipts WHERE id=?').get(doc.id).c, 1);
  // بعد حذف التصريح ترجع الكراتتان وتُمحى مع السند محواً فعلياً لا تعليماً
  h['issues:delete'](null, issId, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cartons WHERE status='in_stock'").get().c, 2);
  const res = h['tolling:receiptDelete'](null, doc.id, 1);
  assert.equal(res.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_raw_receipts WHERE id=?').get(doc.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_raw_items WHERE receipt_id=?').get(doc.id).c, 0);
  assert.equal(remaining(h, 'عميل أ'), 0, 'خارج رصيد العميل محوٌ لا إلغاء');
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

// يستلم خام عميل (كراتين C-) ويصرّف كرتوناً منه للإنتاج، فيعود السند والتصريح والكرتون
function issueCustomerCarton(h, db, carton = 'C-1') {
  const rec = receive(h, 1, 'R-1', [{ item_id: 1, quantity: 12000, unit: 'عبوة' }]);
  const { id: issId } = h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19',
    source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: [carton] }] }, 1);
  const row = db.prepare('SELECT id, pieces FROM cartons WHERE carton_number=?').get(carton);
  return { recId: rec.id, issId, carton: row };
}

// سند استلام الإنتاج الموحّد: الكراتين بنتائجها والأكياس على رأسه
function receiptDoc(h, over = {}) {
  return h['production:save'](null, {
    doc_number: over.doc_number || 'PR-1', doc_date: '2026-10-20', fg_item_id: 1, warehouse_id: 1, ...over,
  }, 1);
}

// سند التالف الآلي تابع للسند كلّه لا للكرتون
const defectDoc = (db, receiptId) => db.prepare(
  'SELECT * FROM scrap_movements WHERE prod_receipt_id=?').get(receiptId);

test('تالف الإنتاج بخام العميل يخصم من رصيد العميل ولا يمس تالف المصنع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  const balBefore = remaining(h, 'عميل أ');

  const r = receiptDoc(h, { issue_permit_id: issId, cartons:
    [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 300, defect_after_pieces: 200 }] });

  assert.equal(talef(db), 0, 'سلّة تالف المصنع يجب أن تبقى صفرًا');
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 0, 'ولا سليمه');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production'").get().c, 0);
  const sc = defectDoc(db, r.id);
  assert.equal(sc.is_customer, 1);
  assert.equal(sc.party_id, 1);
  assert.equal(sc.pieces, 500, 'التالف قبل + بعد كله على العميل');
  assert.equal(sc.disposition, 'production_defect');
  assert.equal(sc.warehouse_id, null);
  assert.equal(sc.talef_take, 0);
  assert.equal(sc.salem_take, 0);
  assert.equal(sc.doc_number, 'تالف إنتاج PR-1');
  assert.equal(remaining(h, 'عميل أ'), balBefore - 500);
  assert.equal(remaining(h, 'عميل ب'), 0, 'عميل آخر لا يتأثر');
  // رصيد العميل = خام − تسليم − تالف، والدورة كلها بلا حركة مخزون
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
});

test('تعديل السند يحدّث سند التالف نفسه ولا ينشئ مستنداً مكرراً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 500, defect_after_pieces: 0 }] });
  const firstId = defectDoc(db, r.id).id;
  receiptDoc(h, { id: r.id, issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4700, defect_before_pieces: 300, defect_after_pieces: 0 }] });
  const rows = db.prepare('SELECT * FROM scrap_movements').all();
  assert.equal(rows.length, 1, 'مستند واحد للسند لا لكل تعديل');
  assert.equal(defectDoc(db, r.id).id, firstId, 'يُحدَّث في نفس الصف');
  assert.equal(defectDoc(db, r.id).pieces, 300);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts').get().c, 1);
  assert.equal(remaining(h, 'عميل أ'), 12000 - 300);
});

test('تصفير التالف يمحو السند فيعيد رصيد العميل، ثم يُنشأ من جديد بالزيادة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 0, defect_after_pieces: 500 }] });
  assert.equal(remaining(h, 'عميل أ'), 11500);

  receiptDoc(h, { id: r.id, issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 5000, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 0, 'بلا تالف ⇒ بلا سند');
  assert.equal(remaining(h, 'عميل أ'), 12000, 'التالف صفر ⇒ الخصم صفر');

  receiptDoc(h, { id: r.id, issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4800, defect_before_pieces: 0, defect_after_pieces: 200 }] });
  const sc = defectDoc(db, r.id);
  assert.equal(sc.pieces, 200, 'يُنشأ سند جديد بحباته الحالية لا يُضاف على القديم');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 1, 'ولا يتضاعف التالف');
  assert.equal(remaining(h, 'عميل أ'), 11800);
});

test('حذف السند يمحى سند تالف العميل ويعيد رصيده كاملاً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 500, defect_after_pieces: 0 }] });
  assert.equal(remaining(h, 'عميل أ'), 11500);
  const res = h['production:delete'](null, r.id, 1);
  assert.equal(res.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 0, 'السند يُمحى مع الاستلام');
  assert.equal(remaining(h, 'عميل أ'), 12000);
  assert.equal(talef(db), 0);
  assert.equal(db.prepare('SELECT status FROM cartons WHERE id=?').get(carton.id).status, 'issued');
});

test('ترقيم السند المُولّد لا يتصادم مع مستند تالف يدوي بنفس الاسم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  // سند يدوي يشغل الاسم الذي سيولّده الاستلام PR-1
  h['scrap:save'](null, { doc_number: 'تالف إنتاج PR-1', doc_date: '2026-10-19', item_id: 1,
    disposition: 'sold_scrap', party_id: 1, pieces: 10, weight_kg: 0.25 }, 1);
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 500, defect_after_pieces: 0 }] });
  const sc = defectDoc(db, r.id);
  assert.equal(sc.doc_number, 'تالف إنتاج PR-1-2', 'الحاء التصادم بإضافة لاحقة');
  assert.equal(db.prepare("SELECT pieces FROM scrap_movements WHERE doc_number='تالف إنتاج PR-1'").get().pieces, 10,
    'المستند اليدوي لم يُمس');
  assert.equal(remaining(h, 'عميل أ'), 12000 - 10 - 500, 'وكلاهما يخصم رصيده');
});

test('سندات التالف الآلية محمية من التعديل والحذف اليدوي', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { issId, carton } = issueCustomerCarton(h, db);
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 500, defect_after_pieces: 0 }] });
  const sc = defectDoc(db, r.id);
  assert.throws(() => h['scrap:save'](null, { id: sc.id, doc_number: 'X', doc_date: '2026-10-20', item_id: 1,
    disposition: 'sold_scrap', warehouse_id: 1, pieces: 99, weight_kg: 1 }, 1), /آلي/);
  const err = (() => { try { h['scrap:delete'](null, sc.id, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /آلي/.test(err.message) && /PR-1/.test(err.message), err && err.message,
    'الرسالة تذكر رقم الاستلام الذي أنشأه');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements WHERE id=?').get(sc.id).c, 1, 'السند باقٍ');
  // ولا يُحذف إلا بحذف الاستلام صاحبهِ
  h['production:delete'](null, r.id, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements WHERE id=?').get(sc.id).c, 0);
});

// ---------------------------------------------------------- عدم الانحراف عن خام المصنع

test('تالف خام المصنع ما زال يزيد سلّة التالف ويكتب حركة مخزون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, { doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }] }, 1);
  const { id: issId } = h['issues:save'](null, { doc_number: 'I-1', doc_date: '2026-10-19', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }] }, 1);
  const carton = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get();
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 0, 'الخام خرج كله بالصرف');
  const r = receiptDoc(h, { issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 4500, defect_before_pieces: 500, defect_after_pieces: 0 }] });
  assert.equal(talef(db), 500);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 0, 'لا سند آلي لخام المصنع');
  const mv = db.prepare("SELECT qty_in_pieces, bucket FROM stock_moves WHERE doc_type='production' AND bucket='talef'").get();
  assert.equal(mv.qty_in_pieces, 500);
  assert.equal(mv.bucket, 'talef');
  assert.equal(db.prepare("SELECT qty_in_pieces q FROM stock_moves WHERE doc_type='production' AND bucket='salem'").get().q, 4500);
  // تعديل ثم تصفير يعكس السلّة بدقة
  receiptDoc(h, { id: r.id, issue_permit_id: issId,
    cartons: [{ carton_id: carton.id, good_pieces: 5000, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(talef(db), 0, 'التالف انعكس كله');
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 5000);
});
