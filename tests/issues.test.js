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

function stubIpc() {
  const handlers = {};
  require('../src/handlers/purchases')({ handle: (ch, fn) => { handlers[ch] = fn; } });
  require('../src/handlers/issues')({ handle: (ch, fn) => { handlers[ch] = fn; } });
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
  buyCartons(h, 2, 'K-');
  const before = getBalance(db, 1, 1).balance_pieces;
  h['issues:save'](null, {
    doc_number: 'I-2', doc_date: '2026-10-18', source: 'customer',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, before);
  assert.equal(salem(db), before);
  const moves = db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='issue'").get().c;
  assert.equal(moves, 0);
});

test('issues:void returns cartons to stock and reverses moves and salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 3, 'K-');
  const { id } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_ids: ['K-1', 'K-2'] }]
  }, 1);
  h['issues:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 38400);
  assert.equal(salem(db), 38400);
  const cartons = db.prepare("SELECT status FROM cartons WHERE carton_number IN ('K-1','K-2') ORDER BY carton_number").all();
  assert.deepEqual(cartons.map(c => c.status), ['in_stock', 'in_stock']);
  assert.equal(db.prepare('SELECT status FROM issue_permits WHERE id=?').get(id).status, 'void');
});

test('issues:void blocked when production results exist', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  buyCartons(h, 1, 'K-');
  const { id } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }]
  }, 1);
  const cartonId = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get().id;
  db.prepare(`INSERT INTO production_results (carton_id, result_date, good_pieces) VALUES (?,?,?)`)
    .run(cartonId, '2026-10-18', 100);
  assert.throws(() => h['issues:void'](null, id, 1), /نتائج إنتاج/);
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
