const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');

// استلام الإنتاج الموحّد (v2): يُختار تصريح الصرف فتظهر كراتينه، ويُسجَّل لكل كرتون
// سليم/تالف قبل/تالف بعد، فيُوزَّع الأثر تلقائياً ويُحذف المستند فيردّ كل أثره.

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن المواد الخام');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)')
    .run('001', 'امبول 5.02', 1, 'حبة', 5.02, 12800);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)')
    .run('002', 'عبوة 5 لتر', 2, 'علبة', 52, 100);
  d.prepare('INSERT INTO machines (name) VALUES (?)').run('مكينة 1');
  d.prepare('INSERT INTO shifts (name) VALUES (?)').run('صباحية');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل تجريبي', 'customer');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

function seedIssuedCartons(db, h, cartons = 1, over = {}) {
  h['purchases:save'](null, {
    doc_number: over.purchaseNo || 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: cartons, unit: 'كرتون', carton_prefix: over.prefix || 'K-' }]
  }, 1);
  const list = db.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(
    db.prepare('SELECT id FROM purchases WHERE doc_number=?').get(over.purchaseNo || 'P-1').id);
  const iss = h['issues:save'](null, {
    doc_number: over.issueNo || '1', doc_date: '2026-10-18', source: over.source || 'own',
    party_id: over.partyId || null, machine_id: 1, shift_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: cartons, unit: 'كرتون',
      carton_ids: list.map((c) => c.carton_number) }]
  }, 1);
  return { issueId: iss.id, cartons: list };
}

const receipt = (h, over = {}) => h['production:save'](null, {
  doc_number: over.doc_number || 'PR-1', doc_date: '2026-10-18', fg_item_id: 2, warehouse_id: 1,
  ...over,
}, 1);

const bucket = (db, id, key) => db.prepare(`SELECT qty_${key} q FROM items WHERE id=?`).get(id).q;
const movesFor = (db, id) => db.prepare("SELECT * FROM stock_moves WHERE doc_type='production' AND doc_id=? ORDER BY id").all(id);

test('قائمة الانتظار وكراتين التصريح: الاستلام يفتح ما لم تُسجَّل نتيجته', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 2);
  assert.equal(h['production:suggest'](), '1', 'ترقيم يدوي يبدأ من 1');
  const open = h['issues:openForReceipt']();
  assert.equal(open.length, 1);
  assert.equal(open[0].doc_number, '1');
  assert.equal(open[0].pending_cartons, 2);
  assert.equal(open[0].issued_pieces, 25600);
  const list = h['production:cartonsForIssue'](null, issueId);
  assert.deepEqual(list.map((c) => [c.carton_number, c.pieces]), [['K-1', 12800], ['K-2', 12800]]);
  assert.equal(list[0].raw_code, '001');
  assert.equal(h['production:list']().length, 0);
  // بعد استلام كرتون واحد يبقى الآخران في الانتظار
  receipt(h, { issue_permit_id: issueId, cartons: [{ carton_id: cartons[0].id, good_pieces: 12000 }] });
  assert.deepEqual(h['production:cartonsForIssue'](null, issueId).map((c) => c.carton_number), ['K-2']);
  assert.equal(h['issues:openForReceipt']()[0].pending_cartons, 1);
  assert.equal(h['production:list']()[0].cartons_count, 1);
  assert.equal(h['production:suggest'](), '1', 'الأرقام الحرفية لا تدخل في التتابع الرقمي');
  receipt(h, { doc_number: '12', issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[1].id, good_pieces: 12800 }] });
  assert.equal(h['production:suggest'](), '13', 'والترقيم اليدوي يقترح التالي');
});

test('سند الاستلام يوزّع سليم/تالف قبل/تالف بعد ويقفل الكرتون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 1);
  const r = receipt(h, { issue_permit_id: issueId, receiver_name: 'علي', notes: 'جيد',
    cartons: [{ carton_id: cartons[0].id, good_pieces: 12000, defect_before_pieces: 500, defect_after_pieces: 300 }] });
  assert.equal(r.issued, 12800);
  assert.equal(r.total, 12800);
  assert.equal(r.variance, 0);
  assert.equal(r.good, 12000);
  assert.equal(r.defect_before, 500);
  assert.equal(r.defect_after, 300);
  //_source والمصدر والمكينة والوردية تُورَّث من تصريح الصرف
  const head = db.prepare('SELECT * FROM production_receipts WHERE id=?').get(r.id);
  assert.equal(head.machine_id, 1);
  assert.equal(head.shift_id, 1);
  assert.equal(head.source, 'own');
  assert.equal(head.party_id, null);
  assert.equal(head.receiver_name, 'علي');
  assert.equal(head.issued_pieces, 12800);
  assert.equal(head.variance_pieces, 0);
  // التوزيع: تام سليم + تام تالف (بعد) + خام تالف (قبل)
  assert.equal(bucket(db, 2, 'salem'), 12000);
  assert.equal(bucket(db, 2, 'talef'), 300);
  assert.equal(bucket(db, 1, 'talef'), 500);
  assert.equal(bucket(db, 1, 'salem'), 0, 'الصرف خصم الخام كله');
  // الكرتون أُقفل كمُنتَج
  assert.equal(db.prepare('SELECT status FROM cartons WHERE id=?').get(cartons[0].id).status, 'finished');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipt_cartons WHERE receipt_id=?').get(r.id).c, 1);
  // حركة المستند: صافي كل سلة يطابق العدّاد، والوزن من وزن الحبة
  const mv = movesFor(db, r.id);
  assert.deepEqual(mv.map((m) => [m.item_id, m.qty_in_pieces, m.qty_out_pieces, m.bucket]),
    [[2, 12000, 0, 'salem'], [2, 300, 0, 'talef'], [1, 500, 0, 'talef']]);
  assert.equal(Math.round(getBalance(db, 2, 1).qty_salem * 100) / 100, 12000);
  assert.equal(Math.round(getBalance(db, 2, 1).balance_kg * 100) / 100, 639.6, '(12000+300) × 52 غم');
  const doc = h['production:get'](null, r.id);
  assert.equal(doc.cartons[0].carton_number, 'K-1');
  assert.equal(doc.cartons[0].raw_code, '001');
  assert.equal(doc.moves.length, 3);
});

test('العجز يُسجَّل نصاً بلا حركة، والفائض يُضاف إلى التام السليم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 1);
  const short = receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 10000, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(short.variance, 2800, 'مصروف 12800 مقابل منتج 10000');
  assert.equal(short.surplus, 0);
  assert.equal(short.good, 10000);
  assert.equal(bucket(db, 2, 'salem'), 10000);
  const notes = movesFor(db, short.id).filter((m) => /عجز تسوية/.test(m.notes || ''));
  assert.equal(notes.length, 1);
  assert.equal(Number(notes[0].qty_in_pieces), 0, 'العجز لا يحرّك مخزوناً');
  // التسوية تُحسب قبل الحفظ وتعيد الأرقام نفسها
  const rec = h['production:reconcile'](null, { cartons: [{ carton_id: cartons[0].id, good_pieces: 10000 }] });
  assert.deepEqual([rec.issued, rec.total, rec.variance, rec.shortage, rec.surplus], [12800, 10000, 2800, 2800, 0]);

  const db2 = makeDb(); setDb(db2);
  const h2 = stubIpc(['purchases', 'issues', 'production']);
  const c2 = seedIssuedCartons(db2, h2, 1);
  const over = receipt(h2, { issue_permit_id: c2.issueId,
    cartons: [{ carton_id: c2.cartons[0].id, good_pieces: 12000, defect_before_pieces: 800, defect_after_pieces: 800 }] });
  assert.equal(over.variance, -800);
  assert.equal(over.surplus, 800);
  assert.equal(over.good, 12800, 'الفائض يدخل التام السليم');
  assert.equal(bucket(db2, 2, 'salem'), 12800);
  assert.equal(bucket(db2, 2, 'talef'), 800);
  assert.equal(bucket(db2, 1, 'talef'), 800);
  assert.equal(h2['production:reconcile'](null, { cartons: [{ carton_id: c2.cartons[0].id, good_pieces: 12000,
    defect_before_pieces: 800, defect_after_pieces: 800 }] }).fg_good, 12800);
});

test('تعديل السند يستبدل النتيجة بلا مضاعفة وحذفه يرجع الكرتون مصروفاً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 1);
  const r = receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 10000, defect_before_pieces: 800, defect_after_pieces: 500 }] });
  assert.equal(bucket(db, 2, 'salem'), 10000);
  // تعديل بنفس الرقم: عكس الأثر القديم كاملاً ثم تطبيق الجديد مرة واحدة
  const again = h['production:save'](null, { id: r.id, doc_number: 'PR-1', doc_date: '2026-10-18',
    issue_permit_id: issueId, fg_item_id: 2, warehouse_id: 1,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 11000, defect_before_pieces: 500, defect_after_pieces: 200 }] }, 1);
  assert.equal(again.id, r.id);
  assert.equal(bucket(db, 2, 'salem'), 11000);
  assert.equal(bucket(db, 2, 'talef'), 200);
  assert.equal(bucket(db, 1, 'talef'), 500);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipt_cartons WHERE receipt_id=?').get(r.id).c, 1);
  // الحذف الفعلي: لا صفاً «ملغى» ولا حركة باقية
  const del = h['production:delete'](null, r.id, 1);
  assert.equal(del.ok, true);
  assert.equal(del.deleted, 'production_receipts');
  assert.equal(bucket(db, 2, 'salem'), 0);
  assert.equal(bucket(db, 2, 'talef'), 0);
  assert.equal(bucket(db, 1, 'talef'), 0);
  assert.equal(movesFor(db, r.id).length, 0);
  assert.equal(db.prepare("SELECT status FROM cartons WHERE id=?").get(cartons[0].id).status, 'issued');
  // والكرتون يرجع للاستلام من جديد
  const again2 = receipt(h, { doc_number: 'PR-2', issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 9000, defect_before_pieces: 1000, defect_after_pieces: 1000 }] });
  assert.equal(bucket(db, 1, 'talef'), 1000);
  assert.equal(again2.good, 9000);
  // نافذة الأثر قبل التأكيد
  const imp = h['production:impact'](null, again2.id);
  assert.equal(imp.doc_number, 'PR-2');
  assert.equal(imp.value, 11000, 'قيمة السند = إجمالي المنتج');
  assert.deepEqual(imp.impact.map((x) => [x.code, x.bucket, x.net]),
    [['001', 'talef', 1000], ['002', 'salem', 9000], ['002', 'talef', 1000]]);
});

test('الحبة مرجع والاستلام: والوزن يُحسب من وزن الحبة في الحركة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 1);
  const r = receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 300, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(getBalance(db, 2, 1).balance_pieces, 300);
  assert.equal(bucket(db, 2, 'salem'), 300, 'سلّة الصنف المستلَم');
  const mv = movesFor(db, r.id)[0];
  assert.equal(Math.round(mv.weight_in_kg * 100) / 100, 15.6, '300 × 52 غم = 15.6 كجم');
  // رقم السند مكرر يُرفض، وبلا كرتون يُرفض
  assert.throws(() => receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 1 }] }), /مكرر/);
  assert.throws(() => receipt(h, { doc_number: 'PR-9', issue_permit_id: issueId, cartons: [] }), /كرتوناً واحداً/);
});

test('سند بخام عميل: لا أثر على مخزون المصنع وتالفة على رصيده', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'tolling', 'scrap']);
  const rec = h['tolling:receiptSave'](null, { doc_number: 'TR-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 12800, unit: 'حبة' }] }, 1);
  const custCartons = db.prepare("SELECT * FROM cartons WHERE source='customer' ORDER BY id").all();
  assert.equal(custCartons.length, 1);
  const iss = h['issues:save'](null, { doc_number: 'I-C', doc_date: '2026-10-18', source: 'customer', party_id: 1,
    machine_id: 1, shift_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: [custCartons[0].carton_number] }] }, 1);
  const s0 = bucket(db, 1, 'salem');
  const r = receipt(h, { doc_number: 'PR-C', issue_permit_id: iss.id,
    cartons: [{ carton_id: custCartons[0].id, good_pieces: 12000, defect_before_pieces: 500, defect_after_pieces: 300 }] });
  assert.equal(bucket(db, 1, 'salem'), s0, 'خام العميل لا يمسّ سلات المصنع');
  assert.equal(bucket(db, 2, 'salem'), 0);
  assert.equal(bucket(db, 2, 'talef'), 0);
  assert.equal(bucket(db, 1, 'talef'), 0);
  assert.equal(movesFor(db, r.id).length, 0, 'لا حركة مخزون لخام العميل');
  const head = db.prepare('SELECT * FROM production_receipts WHERE id=?').get(r.id);
  assert.equal(head.source, 'customer', 'المصدر موروث من التصريح');
  assert.equal(head.party_id, 1, 'والعميل موروث كذلك');
  const sc = db.prepare('SELECT * FROM scrap_movements WHERE is_customer=1').get();
  assert.equal(sc.pieces, 800);
  assert.equal(sc.disposition, 'production_defect');
  assert.equal(sc.prod_receipt_id, r.id);
  assert.equal(h['tolling:balance']()[0].remaining, 12800 - 800);
  // حذف السند يمحو سند التالف ويعيد رصيد العميل كاملاً
  h['production:delete'](null, r.id, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 0);
  assert.equal(h['tolling:balance']()[0].remaining, 12800);
  assert.equal(h['tolling:receiptGet'](null, rec.id).cartons.length, 1);
});

test('خام عميل بلا عميل في التصريح مرفوض، وأيّ صنف نهائي مقبول', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = seedIssuedCartons(db, h, 1);
  db.prepare('UPDATE issue_permits SET source=?, party_id=NULL WHERE id=?').run('customer', issueId);
  assert.throws(() => receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 100 }] }), /بلا عميل محدد/);
  db.prepare('UPDATE issue_permits SET source=?, party_id=NULL WHERE id=?').run('own', issueId);
  // الصنف النهائي ليس مقيّداً بمجموعة: الخام نفسه يصلح نتيجة (شدة/غطاء...)
  const raw = receipt(h, { doc_number: 'PR-R', issue_permit_id: issueId, fg_item_id: 1,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 1000, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(bucket(db, 1, 'salem'), 1000);
  h['production:delete'](null, raw.id, 1);
  assert.equal(bucket(db, 1, 'salem'), 0, 'الحذف يردّ حتى لو كان التام هو الخام');
});
