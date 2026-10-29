const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن المواد الخام');
  d.prepare('INSERT INTO machines (name) VALUES (?)').run('مكينة 1');
  d.prepare('INSERT INTO shifts (name) VALUES (?)').run('صباحية');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)')
    .run('001', 'امبول 5.02', 2, 'حبة', 5.02, 12800);
  return d;
}

function stubIpc(...files) {
  const handlers = {};
  for (const f of ['purchases', 'issues', ...files]) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

function buyCartons(h, n, prefix) {
  return h['purchases:save'](null, {
    doc_number: `P-${n}`, doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: n, unit: 'كرتون', carton_prefix: prefix }]
  }, 1);
}

function salem(db) {
  return db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem;
}

test('issues:save own with cartons moves stock, marks cartons and -salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 3, 'K-');
  assert.equal(salem(db), 38400);
  const { id } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own', machine_id: 1, shift_id: 1,
    receiver_name: 'علي',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_ids: ['K-1', 'K-2'] }]
  }, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 12800);
  assert.equal(salem(db), 12800);
  const cartons = db.prepare(`SELECT carton_number, status, issue_permit_id FROM cartons WHERE carton_number IN ('K-1','K-2') ORDER BY carton_number`).all();
  assert.equal(cartons[0].status, 'issued');
  assert.equal(cartons[0].issue_permit_id, id);
  assert.equal(cartons[1].status, 'issued');
  assert.equal(db.prepare("SELECT status FROM cartons WHERE carton_number='K-3'").get().status, 'in_stock');
});

test('issues:save own without cartons takes pieces from balance and salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 1, 'K-');
  h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 5000, unit: 'حبة' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 7800);
  assert.equal(salem(db), 7800);
});

test('issues:save rejects unavailable carton', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 1, 'K-');
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1', 'K-9'] }]
  }, 1), /غير متاح/);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 12800);
  assert.equal(salem(db), 12800);
});

test('issues:save rejects insufficient balance', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 1, 'K-');
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 999, unit: 'كرتون' }]
  }, 1), /رصيد السليم غير كافٍ/);
});

test('issues:save customer source does not move factory stock nor salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  // تصريح خام العميل يجب أن يحمل عميلاً: التالف يُنسب لرصيده لا لمخزون المصنع
  db.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل نفخ', 'customer');
  buyCartons(h, 2, 'K-');
  const before = getBalance(db, 1, 1).balance_pieces;
  h['issues:save'](null, {
    doc_number: 'I-2', doc_date: '2026-10-18', source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, before);
  assert.equal(salem(db), before);
  const moves = db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='issue'").get().c;
  assert.equal(moves, 0);
});

test('issues:save customer source without a party is rejected', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'I-3', doc_date: '2026-10-18', source: 'customer',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1), /اختر العميل/);
});

test('issues:delete returns cartons to stock and erases moves and salem reversal', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 3, 'K-');
  const { id } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_ids: ['K-1', 'K-2'] }]
  }, 1);
  const imp = h['issues:impact'](null, id);
  assert.equal(imp.doc_number, 'I-1');
  assert.equal(imp.value, 25600, 'القيمة المعروضة = حبات المصروفة');
  assert.equal(imp.impact[0].text.includes('001'), true);
  h['issues:delete'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 38400);
  assert.equal(salem(db), 38400);
  const cartons = db.prepare("SELECT status FROM cartons WHERE carton_number IN ('K-1','K-2') ORDER BY carton_number").all();
  assert.deepEqual(cartons.map(c => c.status), ['in_stock', 'in_stock']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM issue_permits WHERE id=?').get(id).c, 0, 'التصريح يُمحى لا يُلغى');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM issue_items WHERE issue_permit_id=?').get(id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='issue' AND doc_id=?").get(id).c, 0);
  // عكس الأثر مرّة واحدة: العدّاد يطابق صافي الحركات بعد الحذف
  const net = db.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n
    FROM stock_moves WHERE item_id=1 AND bucket='salem'`).get().n;
  assert.equal(net, salem(db), 'items.qty_salem == Σ net(stock_moves)');
});

test('issues:delete ممنوع عند وجود سند استلام إنتاج — والرسالة تذكر رقمه', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('production');
  buyCartons(h, 1, 'K-');
  const { id } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }]
  }, 1);
  const cartonId = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get().id;
  h['production:save'](null, {
    doc_number: 'PR-1', doc_date: '2026-10-18', issue_permit_id: id,
    fg_item_id: 1, warehouse_id: 1,
    cartons: [{ carton_id: cartonId, good_pieces: 100, defect_before_pieces: 0, defect_after_pieces: 0 }],
  }, 1);
  const deps = h['issues:impact'](null, id).deps;
  assert.deepEqual(deps.map((d) => [d.label, d.number]),
    [['استلام إنتاج', 'PR-1'], ['كرتون أُنتج فعلاً', 'K-1']], 'سند الاستلام وكرتونه المانعان');
  const err = (() => { try { h['issues:delete'](null, id, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /PR-1/.test(err.message) && /احذف الأحدث/.test(err.message), err && err.message);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM issue_permits WHERE id=?').get(id).c, 1);
  // حذف السند ثم التصريح: الأثر يردّ بالكامل
  const receiptId = db.prepare('SELECT id FROM production_receipts').get().id;
  h['production:delete'](null, receiptId, 1);
  assert.equal(h['issues:impact'](null, id).deps.length, 0);
  h['issues:delete'](null, id, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM cartons WHERE status='in_stock'").get().c, 1);
  assert.equal(salem(db), 12800, 'الخام كله عاد إلى المخزن');
});

test('issues:cartonsAvailable lists only in_stock', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 3, 'K-');
  h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }]
  }, 1);
  const avail = h['issues:cartonsAvailable'](null, 1);
  assert.deepEqual(avail.map(c => c.carton_number), ['K-2', 'K-3']);
});
