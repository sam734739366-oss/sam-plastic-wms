// اختبارات جوهر الإصدار 2.0.0: مخطط بلا «ملغى»، حذف فعلي يردّ الأثر، واستلام إنتاج موحّد
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dbmod = require('../src/db');
const { getBalance } = require('../src/stock');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');

// صنف 1 = خام (كرتون = 1000 حبة) | صنف 2 = تام مربوط بأكياس (كيس = 100) | صنف 3 = أكياس
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)")
    .run('X1', 'حبيبة PET', 1, 'كجم', 2.6, 1000);
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)")
    .run('002', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)")
    .run('100', 'كيس فارغ', 1, 'كيس', 20);
  d.prepare('UPDATE items SET bag_item_id = 3 WHERE id = 2').run();
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد', 'supplier');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل', 'customer');
  d.prepare("INSERT INTO machines (name) VALUES ('A1')").run();
  d.prepare("INSERT INTO shifts (name) VALUES ('صباحية')").run();
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

let bagSeq = 0;
const bucket = (db, id, key) => db.prepare(`SELECT qty_${key} q FROM items WHERE id=?`).get(id).q;
const movesFor = (db, type, id) => db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(type, id);

// دورة كاملة: شراء خام → صرف تصريح → (يُرجع السند والكراتين)
function purchaseAndIssue(h, db, { cartons = 2, purchaseNo = 'P-1', issueNo = 'IP-1', source = 'own', partyId = null } = {}) {
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const bag = db.prepare("SELECT id FROM items WHERE code='100'").get().id;
  // رصيد أكياس كافٍ للتغليف: شراء صنف الأكياس بالعدد
  const bagNo = 'P-BAG-' + (++bagSeq);
  h['purchases:save'](null, { doc_number: bagNo, doc_date: '2026-11-01', party_id: 1,
    items: [{ item_id: bag, warehouse_id: 1, quantity: 500, unit: 'حبة' }] }, 1);
  const p = h['purchases:save'](null, { doc_number: purchaseNo, doc_date: '2026-11-01', party_id: 1,
    items: [{ item_id: raw, warehouse_id: 1, quantity: cartons, unit: 'كرتون', carton_prefix: 'KR' }] }, 1);
  const list = db.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(p.id);
  const iss = h['issues:save'](null, { doc_number: issueNo, doc_date: '2026-11-01', source, party_id: partyId,
    machine_id: 1, shift_id: 1,
    items: [{ item_id: raw, warehouse_id: 1, quantity: cartons, unit: 'كرتون',
      carton_ids: list.map((c) => c.carton_number) }] }, 1);
  return { purchaseId: p.id, issueId: iss.id, cartons: list };
}

function receipt(h, over = {}) {
  return h['production:save'](null, {
    doc_number: over.doc_number || 'R-1', doc_date: '2026-11-02', fg_item_id: 2, warehouse_id: 1,
    ...over,
  }, 1);
}

// ===== المخطط =====
test('v2: لا يوجد عمود status في أي جدول مستند، والاستثناء الوحيد cartons', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  const tables = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
  const withStatus = tables.filter((t) => /\bstatus\s+TEXT/.test(t.sql)).map((t) => t.name);
  assert.deepEqual(withStatus, ['cartons'], `جداول ما زالت تحمل status: ${withStatus.join(', ')}`);
  for (const gone of ['receive_permits', 'receive_items', 'production_results']) {
    assert.equal(d.prepare('SELECT COUNT(*) c FROM sqlite_master WHERE type=? AND name=?').get('table', gone).c, 0, `${gone} يجب ألا يوجد`);
  }
  for (const need of ['production_receipts', 'production_receipt_cartons']) {
    assert.equal(d.prepare('SELECT COUNT(*) c FROM sqlite_master WHERE type=? AND name=?').get('table', need).c, 1, `${need} مفقود`);
  }
});

test('v2: إعادة التهيئة تؤرشف قاعدة v1 وتبني أخرى نظيفة بلا فقدان ملف', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-v2-'));
  try {
    const file = path.join(dir, 'samplastic.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('factory_name','قديمة')");
    old.close();
    fs.writeFileSync(path.join(dir, 'samplastic.db-wal'), 'wal');
    const r = dbmod.ensureFreshDatabase(dir);
    assert.equal(r.reset, true);
    assert.equal(r.from, 1);
    assert.ok(fs.existsSync(r.backup), 'النسخة القديمة يجب أن تبقى على القرص');
    assert.equal(fs.existsSync(file), false, 'الملف الحالي يجب أن يُزال ليُبنى جديد');
    assert.equal(fs.existsSync(path.join(dir, 'samplastic.db-wal')), false, 'ملف WAL يجب أن ينتقل مع قاعدته');
    assert.ok(fs.existsSync(path.join(dir, 'backups')), 'نسخة احتياط في backups');
    // قاعدة جديدة بلا schema_version تُعتبر قديمة مرة أخرى، وقاعدة v2 لا تُلمَس
    const fresh = new DatabaseSync(file);
    fresh.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    fresh.prepare("INSERT INTO settings VALUES ('schema_version', ?)").run(String(dbmod.SCHEMA_VERSION));
    fresh.close();
    assert.equal(dbmod.ensureFreshDatabase(dir).reset, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===== الحذف الفعلي =====
test('حذف فاتورة شراء يردّ العدّادات ويمحو الحركات والكراتين', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'items']);
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const { purchaseId } = purchaseAndIssue(h, db, { cartons: 1 });
  // الشراء أضاف 1000 والصرف خصمها: العدّاد صفر وصافي الحركات صفر
  assert.equal(bucket(db, raw, 'salem'), 0);
  assert.equal(getBalance(db, raw, 1).qty_salem, 0);
  assert.equal(movesFor(db, 'purchase', purchaseId).length, 1);
  const imp = h['purchases:impact'](null, purchaseId);
  assert.equal(imp.impact.length, 1);
  assert.match(imp.impact[0].text, /X1/);
  // الكرتون مصروف بالفعل: هذا مانع صريح يجب أن يظهر في النافذة قبل التأكيد
  assert.equal(imp.deps.length, 1);
  assert.match(imp.deps[0].number, /KR1/);
  // التصريح المرتبط يمنع الحذف أولاً
  const err = (() => { try { h['purchases:delete'](null, purchaseId, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /KR1/.test(err.message) && /احذف الأحدث/.test(err.message), 'يجب أن يمنع الحذف ويذكر الكرتون المانع');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases WHERE id=?').get(purchaseId).c, 1, 'المستند باقٍ بعد المنع');
  h['issues:delete'](null, h['issues:list']()[0].id, 1);
  assert.equal(h['purchases:impact'](null, purchaseId).deps.length, 0, 'بعد حذف التصريح لا موانع');
  const r = h['purchases:delete'](null, purchaseId, 1);
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases WHERE id=?').get(purchaseId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons WHERE purchase_id=?').get(purchaseId).c, 0);
  assert.equal(movesFor(db, 'purchase', purchaseId).length, 0);
  const bag = db.prepare("SELECT id FROM items WHERE code='100'").get().id;
  assert.equal(bucket(db, raw, 'salem'), 0, 'الخام: أثر الشراء انعدم بعد حذف التصريح ثم الفاتورة');
  assert.equal(bucket(db, bag, 'salem'), 500, 'شراء الأكياس لم يمسّه الحذف');
});

test('حذف تصريح صرف يعيد كراتينه إلى المخزن ويردّ المخصوم', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues']);
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const { issueId } = purchaseAndIssue(h, db, { cartons: 2 });
  assert.equal(bucket(db, raw, 'salem'), 0, 'صرف كل الخام: صفير');
  h['issues:delete'](null, issueId, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cartons WHERE status='issued'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cartons WHERE status='in_stock'").get().c, 2);
  assert.equal(getBalance(db, raw, 1).qty_salem, 2000);
});

// ===== استلام الإنتاج الموحّد =====
test('توزيع سليم/تالف قبل/تالف بعد: تام سليم + خام تالف + تام تالف', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const { issueId, cartons } = purchaseAndIssue(h, db);
  const before = { rawTalef: bucket(db, raw, 'talef'), fg: bucket(db, 2, 'salem') };
  const r = receipt(h, {
    issue_permit_id: issueId,
    cartons: [
      { carton_id: cartons[0].id, good_pieces: 900, defect_before_pieces: 50, defect_after_pieces: 50 },
      { carton_id: cartons[1].id, good_pieces: 950, defect_before_pieces: 30, defect_after_pieces: 20 },
    ],
  });
  assert.equal(r.issued, 2000);
  assert.equal(r.total, 2000);
  assert.equal(r.variance, 0);
  assert.equal(bucket(db, 2, 'salem'), before.fg + 1850, 'السليم يذهب للتام السليم');
  assert.equal(bucket(db, 2, 'talef'), 70, 'تالف بعد النفخ = تام تالف');
  assert.equal(bucket(db, raw, 'talef'), before.rawTalef + 80, 'تالف قبل النفخ = خام تالف');
  const head = db.prepare('SELECT * FROM production_receipts WHERE id=?').get(r.id);
  assert.equal(head.good_pieces, 1850);
  assert.equal(head.defect_before_pieces, 80);
  assert.equal(head.defect_after_pieces, 70);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipt_cartons WHERE receipt_id=?').get(r.id).c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cartons WHERE status='finished'").get().c, 2);
});

test('العجز يُسجَّل بلا حركة، والفائض يُضاف إلى التام السليم', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 1 });
  const short = receipt(h, { doc_number: 'R-S', issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 800, defect_before_pieces: 50, defect_after_pieces: 50 }] });
  assert.equal(short.variance, 100, 'مصروف 1000 مقابل منتج 900 = عجز 100');
  assert.equal(short.surplus, 0);
  assert.equal(bucket(db, 2, 'salem'), 800);
  const notes = movesFor(db, 'production', short.id).filter((m) => /عجز تسوية/.test(m.notes || ''));
  assert.equal(notes.length, 1, 'العجز يُسجَّل نصاً في الحركات');
  assert.equal(Number(notes[0].qty_in_pieces), 0, 'العجز لا يحرّك مخزوناً');

  const db2 = makeDb(); dbmod.setDb(db2);
  const h2 = stubIpc(['purchases', 'issues', 'production']);
  const ctx = purchaseAndIssue(h2, db2, { cartons: 1 });
  const over = receipt(h2, { doc_number: 'R-X', issue_permit_id: ctx.issueId, fg_item_id: 2, warehouse_id: 1,
    cartons: [{ carton_id: ctx.cartons[0].id, good_pieces: 1000, defect_before_pieces: 100, defect_after_pieces: 100 }] });
  assert.equal(over.variance, -200);
  assert.equal(over.surplus, 200);
  assert.equal(over.good, 1200, 'الفائض يدخل التام السليم');
  assert.equal(bucket(db2, 2, 'salem'), 1200);
  assert.equal(bucket(db2, 2, 'talef'), 100);
});

test('الأكياس: تُستهلك عند الاستلام وتُردّ عند حذف السند', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const bag = db.prepare("SELECT id FROM items WHERE code='100'").get().id;
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 1 });
  const r = receipt(h, { issue_permit_id: issueId, bags: 9, breaks: 50,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 1000, defect_before_pieces: 0, defect_after_pieces: 0 }] });
  assert.equal(bucket(db, bag, 'salem'), 500 - 10, '9 أكياس + كيس للكسور = 10');
  const head = db.prepare('SELECT * FROM production_receipts WHERE id=?').get(r.id);
  assert.equal(head.bags_used, 10);
  assert.equal(head.breaks, 50);
  h['production:delete'](null, r.id, 1);
  assert.equal(bucket(db, bag, 'salem'), 500, 'الأكياس تعود مع حذف السند');
  assert.equal(bucket(db, 2, 'salem'), 0);
});

test('أكياس تتجاوز السليم مرفوضة، وبلا ربط صنف أكياس مرفوض', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 1 });
  const line = [{ carton_id: cartons[0].id, good_pieces: 500, defect_before_pieces: 0, defect_after_pieces: 0 }];
  assert.throws(() => receipt(h, { issue_permit_id: issueId, bags: 9, breaks: 50, cartons: line }), /تتجاوز/);
  db.prepare('UPDATE items SET bag_item_id = NULL WHERE id=2').run();
  assert.throws(() => receipt(h, { issue_permit_id: issueId, bags: 1, cartons: line }), /غير مربوط بصنف أكياس/);
});

test('تعديل السند يردّ الأثر القديم كاملاً ثم يطبّق الجديد بلا مضاعفة', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const bag = db.prepare("SELECT id FROM items WHERE code='100'").get().id;
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 1 });
  const r = receipt(h, { issue_permit_id: issueId, bags: 5,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 900, defect_before_pieces: 50, defect_after_pieces: 50 }] });
  assert.equal(bucket(db, 2, 'salem'), 900);
  const again = h['production:save'](null, { id: r.id, doc_number: 'R-1', doc_date: '2026-11-02',
    issue_permit_id: issueId, fg_item_id: 2, warehouse_id: 1, bags: 2,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 700, defect_before_pieces: 200, defect_after_pieces: 100 }] }, 1);
  assert.equal(again.id, r.id);
  assert.equal(bucket(db, 2, 'salem'), 700);
  assert.equal(bucket(db, 2, 'talef'), 100);
  assert.equal(bucket(db, raw, 'talef'), 200);
  assert.equal(bucket(db, bag, 'salem'), 500 - 2);
  // الأثر الصافي للحركات يطابق العدّادات دائماً بعد التعديل
  assert.equal(getBalance(db, 2, 1).qty_salem, 700);
  assert.equal(getBalance(db, 2, 1).qty_talef, 100);
});

test('خام العميل: لا سلات للمصنع، والتالف سند عهدة يُحدَّث ويُمحى مع السند', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'tolling', 'scrap']);
  const raw = db.prepare("SELECT id FROM items WHERE code='X1'").get().id;
  const rec = h['tolling:receiptSave'](null, { doc_number: 'T-1', doc_date: '2026-11-01', party_id: 2,
    items: [{ item_id: raw, boxes: 2, pieces_per_box: 1000 }] }, 1);
  const custCartons = db.prepare("SELECT * FROM cartons WHERE source='customer' ORDER BY id").all();
  assert.equal(custCartons.length, 2, 'استلام الخام يولّد كراتين C-');
  const iss = h['issues:save'](null, { doc_number: 'IP-C', doc_date: '2026-11-01', source: 'customer', party_id: 2,
    machine_id: 1, shift_id: 1,
    items: [{ item_id: raw, warehouse_id: 1, quantity: 2, unit: 'كرتون',
      carton_ids: custCartons.map((c) => c.carton_number) }] }, 1);
  const salemBefore = bucket(db, raw, 'salem');
  const r = receipt(h, { doc_number: 'R-C', issue_permit_id: iss.id,
    cartons: custCartons.map((c, i) => ({ carton_id: c.id, good_pieces: 900, defect_before_pieces: i ? 40 : 60, defect_after_pieces: 50 })) });
  assert.equal(bucket(db, raw, 'salem'), salemBefore, 'خام العميل لا يمسّ سلات المصنع');
  assert.equal(bucket(db, 2, 'salem'), 0);
  const scraps = db.prepare("SELECT * FROM scrap_movements WHERE is_customer=1").all();
  assert.equal(scraps.length, 1, 'سند تالف آلي واحد للسند');
  assert.equal(scraps[0].pieces, 200, 'تالف قبل + بعد كله على العميل');
  assert.equal(scraps[0].disposition, 'production_defect');
  const bal = h['tolling:balance'](null).find((b) => b.id === 2);
  assert.equal(Number(bal.scrap_out), 200);
  // تعديل ينقص التالف → السند يتحدّث، وحذف السند → السند التالف يُمحى
  h['production:save'](null, { id: r.id, doc_number: 'R-C', doc_date: '2026-11-02', issue_permit_id: iss.id,
    fg_item_id: 2, warehouse_id: 1,
    cartons: custCartons.map((c) => ({ carton_id: c.id, good_pieces: 950, defect_before_pieces: 25, defect_after_pieces: 25 })) }, 1);
  assert.equal(db.prepare('SELECT pieces p FROM scrap_movements WHERE is_customer=1').get().p, 100);
  h['production:delete'](null, r.id, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements WHERE is_customer=1').get().c, 0);
  assert.equal(h['tolling:balance'](null).find((b) => b.id === 2).scrap_out, 0);
  void rec;
});

test('الكرتون من تصريح آخر مرفوض، والنتيجة بلا كرتون مرفوضة', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const a = purchaseAndIssue(h, db, { cartons: 1, purchaseNo: 'P-A', issueNo: 'IP-A' });
  const b = purchaseAndIssue(h, db, { cartons: 1, purchaseNo: 'P-B', issueNo: 'IP-B' });
  assert.throws(() => receipt(h, { issue_permit_id: a.issueId,
    cartons: [{ carton_id: b.cartons[0].id, good_pieces: 100 }] }), /ليس ضمن تصريح الصرف/);
  assert.throws(() => receipt(h, { issue_permit_id: a.issueId, cartons: [] }), /كرتوناً واحداً/);
  assert.throws(() => receipt(h, { issue_permit_id: a.issueId,
    cartons: [{ carton_id: a.cartons[0].id, good_pieces: 0, defect_before_pieces: 0, defect_after_pieces: 0 }] }), /أدخل نتيجة/);
});

test('التقرير اليومي للإنتاج: سطر لكل كرتون وملخّص بلا مضاعفة للفارق', () => {  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'reports']);
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 2 });
  receipt(h, { issue_permit_id: issueId,
    cartons: cartons.map((c) => ({ carton_id: c.id, good_pieces: 900, defect_before_pieces: 50, defect_after_pieces: 30 })) });
  const rep = h['reports:production'](null, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.receipts_count, 1);
  assert.equal(rep.total_issued, 2000);
  assert.equal(rep.total_good, 1800);
  assert.equal(rep.total_defect_before, 100);
  assert.equal(rep.total_defect_after, 60);
  assert.equal(rep.total_shortage, 40, 'عجز 40 لكل كرتون = 40 على مستوى السند لا 80');
  assert.equal(rep.total_shortage_label, '40 حبة');
  assert.equal(Object.keys(rep.rows[0]).some((k) => /weight|_kg/.test(k)), false, 'لا أعمدة وزن في التقارير');
});

test('تقرير الإنتاج يلبس كل كمية وحدة صنفها: التام عبوة والخام كجم', () => {
  const db = makeDb(); dbmod.setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'reports']);
  // الخام: وحدته «كجم» وكرتونه 1000 — والتام: وحدته «عبوة» وكيسه 100 بلا كرتون للتام
  const { issueId, cartons } = purchaseAndIssue(h, db, { cartons: 1 });
  receipt(h, { issue_permit_id: issueId,
    cartons: [{ carton_id: cartons[0].id, good_pieces: 900, defect_before_pieces: 60, defect_after_pieces: 40 }] });
  const row = h['reports:production'](null, {}).rows[0];
  assert.equal(row.unit_name, 'كجم', 'الصنف في السطر هو الخام');
  assert.equal(row.fg_unit_name, 'عبوة');
  // الخطأ الذي كان يحدث: حبات التام تُنسب لوحدة الخام وحجم تعبئته
  assert.equal(row.good_pieces_label, '900 عبوة');
  assert.equal(row.defect_after_label, '40 عبوة');
  assert.equal(row.carton_pieces_label, '1,000 كجم');
  assert.equal(row.defect_before_label, '60 كجم');
  // بوحدة العرض «كرتون»: التام بلا حبات/كرتون فيبقى بوحدته، والخام يُقسم على كرتونه
  const asCarton = h['reports:production'](null, { unit: 'carton' }).rows[0];
  assert.equal(asCarton.good_pieces_label, '900 عبوة');
  assert.equal(asCarton.carton_pieces_label, '1 كرتون');
  // وبوحدة «كيس» للتام: 900 حبة ÷ 100 = 9 أكياس
  assert.equal(h['reports:production'](null, { unit: 'bag' }).rows[0].good_pieces_label, '9 كيس');
});
