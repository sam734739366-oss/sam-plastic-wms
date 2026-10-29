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
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)')
    .run('001', 'امبول 5.02', 2, 'حبة', 5.02, 12800);
  return d;
}

function stubIpc() {
  const handlers = {};
  require('../src/handlers/purchases')({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

function salem(db, id = 1) {
  return db.prepare('SELECT qty_salem FROM items WHERE id=?').get(id).qty_salem;
}

test('purchases:save creates moves, numbered cartons and +salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: null,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', unit_price: 100, carton_prefix: 'K-' }]
  }, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 25600);
  assert.equal(Math.round(bal.balance_kg * 100) / 100, 128.51);
  assert.equal(salem(db), 25600);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=? ORDER BY carton_number').all(id);
  assert.deepEqual(cartons.map(c => c.carton_number), ['K-1', 'K-2']);
  const item = db.prepare('SELECT total_price FROM purchase_items WHERE purchase_id=?').get(id);
  assert.equal(item.total_price, 200);
});

test('purchases:save by kg converts via weight_grams', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 5.02, unit: 'كجم' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 1000);
  assert.equal(salem(db), 1000);
});

test('purchases:save continues carton numbering after existing prefix', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-2', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=? ORDER BY carton_number').all(id);
  assert.deepEqual(cartons.map(c => c.carton_number), ['K-2', 'K-3']);
});

test('purchases:save rejects duplicate number and empty items', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1);
  assert.throws(() => h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1), /مكرر/);
  assert.throws(() => h['purchases:save'](null, {
    doc_number: 'P-2', doc_date: '2026-10-18', items: []
  }, 1), /بنداً واحداً/);
});

test('purchases:edit rewrites items, in_stock cartons and salem balance', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  h['purchases:save'](null, {
    id, doc_number: 'P-1', doc_date: '2026-10-19',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 12800);
  assert.equal(salem(db), 12800);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=?').all(id);
  assert.equal(cartons.length, 1);
  assert.equal(cartons[0].carton_number, 'K-1');
});

test('purchases:edit blocked when cartons issued', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  db.prepare(`UPDATE cartons SET status='issued' WHERE purchase_id=?`).run(id);
  assert.throws(() => h['purchases:save'](null, {
    id, doc_number: 'P-1', doc_date: '2026-10-19',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1), /احذف تصريح الصرف أولاً/);
});

test('purchases:delete يردّ الحركات والعدّادات ويمحو الكراتين؛ والمصروفة تمنع الحذف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  db.prepare(`UPDATE cartons SET status='issued' WHERE purchase_id=?`).run(id);
  // النافذة التحذيرية تعرض المانع قبل التأكيد، ثم الحذف يرفضه
  const imp = h['purchases:impact'](null, id);
  assert.equal(imp.deps.length, 2, 'كرتونان مصروفان = مانعان');
  assert.match(imp.deps[0].number, /^K-/);
  assert.equal(imp.impact.length, 1, 'الأثر المعروض = حركة الشراء واحدة');
  assert.throws(() => h['purchases:delete'](null, id, 1), /K-1/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases WHERE id=?').get(id).c, 1, 'الفاتورة باقية بعد المنع');
  db.prepare(`UPDATE cartons SET status='in_stock' WHERE purchase_id=?`).run(id);
  const res = h['purchases:delete'](null, id, 1);
  assert.equal(res.ok, true);
  assert.equal(res.deleted, 'purchases');
  assert.equal(res.reverted, 1, 'حركة واحدة رُدّت');
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 0);
  assert.equal(salem(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases WHERE id=?').get(id).c, 0, 'لا صف «ملغى» — يُمحى');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE doc_type=? AND doc_id=?').get('purchase', id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons WHERE purchase_id=?').get(id).c, 0);
});

test('purchases:suggest starts at 1 and increments', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.equal(h['purchases:suggest'](), '1');
  h['purchases:save'](null, {
    doc_number: '1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1);
  assert.equal(h['purchases:suggest'](), '2');
});
