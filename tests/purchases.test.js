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
    .run('001-001', 'امبول 5.02', 1, 'امبولة', 5.02, 12800);
  return d;
}

function stubIpc() {
  const handlers = {};
  require('../src/handlers/purchases')({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

test('purchases:save creates moves and numbered cartons', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: null,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'carton', unit_price: 100, carton_prefix: 'K-' }]
  }, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 25600);
  assert.equal(Math.round(bal.balance_kg * 100) / 100, 128.51);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=? ORDER BY carton_number').all(id);
  assert.deepEqual(cartons.map(c => c.carton_number), ['K-1', 'K-2']);
  const item = db.prepare('SELECT total_price FROM purchase_items WHERE purchase_id=?').get(id);
  assert.equal(item.total_price, 200);
});

test('purchases:save continues carton numbering after existing prefix', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-2', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=? ORDER BY carton_number').all(id);
  assert.deepEqual(cartons.map(c => c.carton_number), ['K-2', 'K-3']);
});

test('purchases:save rejects duplicate number and empty items', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton' }]
  }, 1);
  assert.throws(() => h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton' }]
  }, 1), /مكرر/);
  assert.throws(() => h['purchases:save'](null, {
    doc_number: 'P-2', doc_date: '2026-10-18', items: []
  }, 1), /بنداً واحداً/);
});

test('purchases:edit rewrites items and in_stock cartons', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  h['purchases:save'](null, {
    id, doc_number: 'P-1', doc_date: '2026-10-19',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 12800);
  const cartons = db.prepare('SELECT carton_number FROM cartons WHERE purchase_id=?').all(id);
  assert.equal(cartons.length, 1);
  assert.equal(cartons[0].carton_number, 'K-1');
});

test('purchases:edit blocked when cartons issued', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  db.prepare(`UPDATE cartons SET status='issued' WHERE purchase_id=?`).run(id);
  assert.throws(() => h['purchases:save'](null, {
    id, doc_number: 'P-1', doc_date: '2026-10-19',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton' }]
  }, 1), /ألغِ تصريح الصرف أولاً/);
});

test('purchases:void reverses moves and deletes cartons, blocked when issued', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'carton', carton_prefix: 'K-' }]
  }, 1);
  db.prepare(`UPDATE cartons SET status='issued' WHERE purchase_id=?`).run(id);
  assert.throws(() => h['purchases:void'](null, id, 1), /ألغِ تصريح الصرف أولاً/);
  db.prepare(`UPDATE cartons SET status='in_stock' WHERE purchase_id=?`).run(id);
  h['purchases:void'](null, id, 1);
  const bal = getBalance(db, 1, 1);
  assert.equal(bal.balance_pieces, 0);
  assert.equal(db.prepare('SELECT status FROM purchases WHERE id=?').get(id).status, 'void');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cartons WHERE purchase_id=?').get(id).c, 0);
});

test('purchases:suggest starts at 1 and increments', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.equal(h['purchases:suggest'](), '1');
  h['purchases:save'](null, {
    doc_number: '1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'carton' }]
  }, 1);
  assert.equal(h['purchases:suggest'](), '2');
});
