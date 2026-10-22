const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

// دورة الكراتين: دخول (شراء) ← صرف للإنتاج (تصريح) ← نتيجة كل كرتون ← استلام تام مرتبط بالتصريح
// مع ضمان عدم تكرار الأثر على إحصائيات المخزون والمخازن

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  // خام (بري فورم) يُشترى ويُصرف بكراتين، ومنتج تام يُستلم بعد النفخ
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)')
    .run('001', 'بري فورم 1 لتر', 1, 'حبة', 25, 5000);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('002', 'عبوة 1 لتر تامة', 2, 'حبة', 25);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد تجريبي', 'supplier');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

function buyAndIssue(db, h) {
  const { id: purchaseId } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-01', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  const { id: issueId } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-02', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_ids: ['K-1', 'K-2'] }]
  }, 1);
  return { purchaseId, issueId };
}

test('الدورة الكاملة: دخول وصرف ونتيجة واستلام مرتبط بلا تكرار في المخزون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'receives', 'cartons']);
  const { issueId } = buyAndIssue(db, h);
  const k1 = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get().id;
  // نتيجة الكرتون الأول: 4800 سليم + 100 تالف قبل + 50 تالف بعد = 4950 من 5000 (نقص 50)
  h['production:save'](null, {
    carton_id: k1, result_date: '2026-10-03',
    good_pieces: 4800, defect_before: 100, defect_after: 50
  }, 1);
  // استلام تام مرتبط بنفس تصريح الصرف: 4800 عبوة تامة
  const { id: recvId } = h['receives:save'](null, {
    doc_number: 'R-1', doc_date: '2026-10-04', source: 'own', issue_permit_id: issueId,
    items: [{ item_id: 2, warehouse_id: 1, quantity: 4800, unit: 'حبة' }]
  }, 1);

  // دورة الكراتين تعرض كل كرتون ومرحلة دورة كل تصريح
  const cycle = h['cartons:cycle']();
  assert.equal(cycle.cartons.length, 2);
  const k1row = cycle.cartons.find(c => c.carton_number === 'K-1');
  const k2row = cycle.cartons.find(c => c.carton_number === 'K-2');
  assert.equal(k1row.status, 'finished');
  assert.equal(k1row.good_pieces, 4800);
  assert.equal(k1row.defect_before, 100);
  assert.equal(k1row.defect_after, 50);
  assert.equal(k1row.rest, 50); // نقص
  assert.equal(k1row.purchase_number, 'P-1');
  assert.equal(k1row.issue_number, 'I-1');
  assert.equal(k2row.status, 'issued');
  assert.equal(cycle.issues.length, 1);
  assert.equal(cycle.issues[0].issued_pieces, 10000);
  assert.equal(cycle.issues[0].declared_good, 4800);
  assert.equal(cycle.issues[0].received_pieces, 4800);
  assert.equal(cycle.issues[0].receive_diff, 0);

  // الاستلام يحمل رقم تصريح الصرف المرتبط
  const recvDoc = h['receives:get'](null, recvId);
  assert.equal(recvDoc.issue_permit_id, issueId);
  assert.equal(recvDoc.issue_number, 'I-1');

  // بلا تكرار: حركات الخام 3 فقط (شراء + صرف + تالف النتيجة) والمنتج التام حركة واحدة
  const rawMoves = db.prepare("SELECT doc_type FROM stock_moves WHERE item_id=1 ORDER BY id").all();
  assert.deepEqual(rawMoves.map(m => m.doc_type), ['purchase', 'issue', 'production']);
  const finMoves = db.prepare("SELECT doc_type FROM stock_moves WHERE item_id=2 ORDER BY id").all();
  assert.deepEqual(finMoves.map(m => m.doc_type), ['receive']);
  // الأرصدة: الخام خرج كله وصار منه 150 تالف، والمنتج التام دخل 4800
  const rawBal = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='salem' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) salem,
      COALESCE(SUM(CASE WHEN bucket='talef' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) talef
    FROM stock_moves WHERE item_id=1 AND warehouse_id=1`).get();
  assert.equal(rawBal.salem, 0);
  assert.equal(rawBal.talef, 150);
  const finBal = db.prepare(`SELECT COALESCE(SUM(qty_in_pieces - qty_out_pieces),0) b
    FROM stock_moves WHERE item_id=2 AND warehouse_id=1`).get();
  assert.equal(finBal.b, 4800);
});

test('استلام مرتبط بتصريح صرف غير موجود يُرفض', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['receives']);
  assert.throws(() => h['receives:save'](null, {
    doc_number: 'R-9', doc_date: '2026-10-04', source: 'own', issue_permit_id: 999,
    items: [{ item_id: 2, warehouse_id: 1, quantity: 10, unit: 'حبة' }]
  }, 1), /تصريح الصرف/);
});

test('لا يمكن إلغاء تصريح الصرف وعليه استلام نشط — وبعد إلغاء الاستلام يُسمح', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'receives']);
  const { issueId } = buyAndIssue(db, h);
  const { id: recvId } = h['receives:save'](null, {
    doc_number: 'R-1', doc_date: '2026-10-04', source: 'own', issue_permit_id: issueId,
    items: [{ item_id: 2, warehouse_id: 1, quantity: 4800, unit: 'حبة' }]
  }, 1);
  assert.throws(() => h['issues:void'](null, issueId, 1), /استلام/);
  h['receives:void'](null, recvId, 1);
  const res = h['issues:void'](null, issueId, 1);
  assert.equal(res.ok, true);
  const cartons = db.prepare('SELECT status FROM cartons ORDER BY carton_number').all();
  assert.deepEqual(cartons.map(c => c.status), ['in_stock', 'in_stock']);
});
