const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

// دورة الكراتين: دخول (شراء) ← صرف للإنتاج (تصريح) ← سند استلام إنتاج واحد يسجّل نتيجة الكرتون
// ويوزّع أثره، مع ضمان عدم تكرار الأثر على إحصائيات المخزون والمخازن

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  // خام (بري فورم) يُشترى ويُصرف بكراتين، ومنتج تام يُستلم بعد النفخ في سند واحد
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

// ثابت v2: عداد كل صنف × سلة = صافي حركاته
function assertConsistent(db, label) {
  const rows = db.prepare(`SELECT item_id, bucket,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
    FROM stock_moves GROUP BY item_id, bucket`).all();
  for (const it of db.prepare('SELECT * FROM items').all()) {
    for (const key of ['salem', 'talef', 'muharraz']) {
      const r = rows.find((x) => x.item_id === it.id && x.bucket === key);
      assert.equal(r ? r.net : 0, Number(it[`qty_${key}`]) || 0, `${label}: عداد ${key} للصنف ${it.code}`);
    }
  }
}

test('الدورة الكاملة: دخول وصرف وسند استلام مرتبط بلا تكرار في المخزون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'cartons']);
  const { issueId } = buyAndIssue(db, h);
  const k1 = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get().id;
  // نتيجة الكرتون الأول: 4800 سليم + 100 تالف قبل + 50 تالف بعد = 4950 من 5000 (نقص 50)
  const r = h['production:save'](null, {
    doc_number: 'PR-1', doc_date: '2026-10-03', issue_permit_id: issueId, fg_item_id: 2, warehouse_id: 1,
    cartons: [{ carton_id: k1, good_pieces: 4800, defect_before_pieces: 100, defect_after_pieces: 50 }],
  }, 1);

  // دورة الكراتين تعرض كل كرتون ومرحلة دورته لكل تصريح
  const cycle = h['cartons:cycle']();
  assert.equal(cycle.cartons.length, 2);
  const k1row = cycle.cartons.find((c) => c.carton_number === 'K-1');
  const k2row = cycle.cartons.find((c) => c.carton_number === 'K-2');
  assert.equal(k1row.status, 'finished');
  assert.equal(k1row.good_pieces, 4800);
  assert.equal(k1row.defect_before, 100);
  assert.equal(k1row.defect_after, 50);
  assert.equal(k1row.rest, 50, 'نقص: حبات الكرتون − المحسوب');
  assert.equal(k1row.purchase_number, 'P-1');
  assert.equal(k1row.issue_number, 'I-1');
  assert.equal(k1row.receipt_number, 'PR-1');
  assert.equal(k2row.status, 'issued');
  assert.equal(k2row.rest, null, 'غير المُنتج بلا فارق محسوب');
  assert.equal(cycle.issues.length, 1);
  assert.equal(cycle.issues[0].issued_pieces, 10000);
  assert.equal(cycle.issues[0].declared_good, 4800);
  assert.equal(cycle.issues[0].received_pieces, 4800);
  assert.equal(cycle.issues[0].receive_diff, 0);

  // السند يحمل رقم تصريح الصرف المرتبط وكراتينه
  const doc = h['production:get'](null, r.id);
  assert.equal(doc.issue_permit_id, issueId);
  assert.equal(doc.issue_number, 'I-1');
  assert.equal(doc.cartons.length, 1);
  assert.equal(doc.cartons[0].carton_number, 'K-1');

  // بلا تكرار: الخام له شراء + صرف + تالف قبل، والتام له استلامه وأثره فقط
  const rawMoves = db.prepare('SELECT doc_type FROM stock_moves WHERE item_id=1 ORDER BY id').all();
  assert.deepEqual(rawMoves.map((m) => m.doc_type), ['purchase', 'issue', 'production']);
  const finMoves = db.prepare("SELECT doc_type, qty_in_pieces, bucket FROM stock_moves WHERE item_id=2 ORDER BY id").all();
  assert.deepEqual(finMoves.map((m) => [m.doc_type, m.qty_in_pieces, m.bucket]),
    [['production', 4800, 'salem'], ['production', 50, 'talef'], ['production', 0, 'salem']],
    'العجز حركة صفرية نصّها تسوية لا كمية');

  // الأرصدة: الخام خرج كله وصار منه 100 تالفاً (قبل النفخ)، والتام دخل 4800 سليم + 50 تالف
  const rawBal = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='salem' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) salem,
      COALESCE(SUM(CASE WHEN bucket='talef' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) talef
    FROM stock_moves WHERE item_id=1 AND warehouse_id=1`).get();
  assert.equal(rawBal.salem, 0);
  assert.equal(rawBal.talef, 100, 'تالف قبل النفخ يعود خاماً تالفاً');
  const finBal = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket='salem' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) salem,
      COALESCE(SUM(CASE WHEN bucket='talef' THEN qty_in_pieces - qty_out_pieces ELSE 0 END),0) talef
    FROM stock_moves WHERE item_id=2 AND warehouse_id=1`).get();
  assert.equal(finBal.salem, 4800);
  assert.equal(finBal.talef, 50, 'تالف بعد النفخ يبقى تاماً تالفاً');
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 100);
  assertConsistent(db, 'بعد الاستلام');
});

test('سند استلام بتصريح صرف غير موجود يُرفض', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['production']);
  assert.throws(() => h['production:save'](null, {
    doc_number: 'PR-9', doc_date: '2026-10-04', issue_permit_id: 999, fg_item_id: 2, warehouse_id: 1,
    cartons: [{ carton_id: 1, good_pieces: 10 }],
  }, 1), /تصريح الصرف/);
});

test('لا يمكن حذف تصريح الصرف وعليه سند استلام — وبعد حذف السند يُسمح', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  const { issueId } = buyAndIssue(db, h);
  const k1 = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get().id;
  const r = h['production:save'](null, {
    doc_number: 'PR-1', doc_date: '2026-10-03', issue_permit_id: issueId, fg_item_id: 2, warehouse_id: 1,
    cartons: [{ carton_id: k1, good_pieces: 4800, defect_before_pieces: 100, defect_after_pieces: 50 }],
  }, 1);
  const err = (() => { try { h['issues:delete'](null, issueId, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /PR-1/.test(err.message), 'المنع يذكر رقم السند المرتبط');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM issue_permits WHERE id=?').get(issueId).c, 1);
  // حذف السند يردّ أثره ثم يصير حذف التصريح ممكناً
  const res = h['production:delete'](null, r.id, 1);
  assert.equal(res.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts WHERE id=?').get(r.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipt_cartons WHERE receipt_id=?').get(r.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production'").get().c, 0, 'الحركات مُمحية');
  assert.equal(db.prepare("SELECT status FROM cartons WHERE id=?").get(k1).status, 'issued', 'الكرتون يرجع مصروفاً بلا نتيجة');
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=2').get().qty_salem, 0);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 0);
  assertConsistent(db, 'بعد حذف السند');
  h['issues:delete'](null, issueId, 1);
  const cartons = db.prepare('SELECT status FROM cartons ORDER BY carton_number').all();
  assert.deepEqual(cartons.map((c) => c.status), ['in_stock', 'in_stock']);
  assert.equal(db.prepare("SELECT qty_salem FROM items WHERE id=1").get().qty_salem, 10000, 'الخام كله في المخزن');
  assertConsistent(db, 'بعد حذف التصريح');
});
