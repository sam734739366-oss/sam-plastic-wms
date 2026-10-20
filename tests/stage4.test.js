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
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)')
    .run('002', 'عبوة 5 لتر', 2, 'علبة', 52, 100);
  d.prepare("INSERT INTO machines (name) VALUES (?)").run('مكينة 1');
  d.prepare("INSERT INTO shifts (name) VALUES (?)").run('صباحية');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل تجريبي', 'customer');
  return d;
}

function stubIpc(file) {
  const handlers = {};
  require(`../src/handlers/${file}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

function seedIssuedCarton(db, h) {
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_prefix: 'K-' }]
  }, 1);
  h['issues:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', source: 'own', machine_id: 1, shift_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['K-1'] }]
  }, 1);
  return id;
}

test('production:pending lists issued cartons without results', () => {
  const db = makeDb(); setDb(db);
  const h = { ...stubIpc('purchases'), ...stubIpc('issues'), ...stubIpc('production') };
  seedIssuedCarton(db, h);
  const pending = h['production:pending']();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].carton_number, 'K-1');
  assert.equal(pending[0].issue_number, '1');
  assert.equal(pending[0].machine_name, 'مكينة 1');
});

test('production:save records result, marks carton finished, adds defects to talef', () => {
  const db = makeDb(); setDb(db);
  const h = { ...stubIpc('purchases'), ...stubIpc('issues'), ...stubIpc('production') };
  seedIssuedCarton(db, h);
  const carton = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get();
  const r = h['production:save'](null, {
    carton_id: carton.id, result_date: '2026-10-18',
    good_pieces: 12000, defect_before: 500, defect_after: 300, notes: 'جيد'
  }, 1);
  assert.equal(r.rest, 0);
  const row = db.prepare('SELECT * FROM production_results WHERE carton_id=?').get(carton.id);
  assert.equal(row.good_pieces, 12000);
  assert.equal(row.defect_before, 500);
  assert.equal(row.machine_id, 1);
  assert.equal(db.prepare('SELECT status FROM cartons WHERE id=?').get(carton.id).status, 'finished');
  assert.equal(h['production:pending']().length, 0);
  assert.equal(h['production:done']().length, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 800);
  const inStock = db.prepare(`UPDATE cartons SET status='in_stock' WHERE id=? RETURNING id`).get(carton.id);
  assert.throws(() => h['production:save'](null, {
    carton_id: inStock.id, result_date: '2026-10-18', good_pieces: 1
  }, 1), /ليس مصروفاً/);
});

test('production:save allows partial sum with rest count', () => {
  const db = makeDb(); setDb(db);
  const h = { ...stubIpc('purchases'), ...stubIpc('issues'), ...stubIpc('production') };
  seedIssuedCarton(db, h);
  const carton = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get();
  const r = h['production:save'](null, {
    carton_id: carton.id, result_date: '2026-10-18', good_pieces: 10000
  }, 1);
  assert.equal(r.rest, 2800);
});

test('production:save edit replaces result and delete restores issued and talef', () => {
  const db = makeDb(); setDb(db);
  const h = { ...stubIpc('purchases'), ...stubIpc('issues'), ...stubIpc('production') };
  seedIssuedCarton(db, h);
  const carton = db.prepare("SELECT id FROM cartons WHERE carton_number='K-1'").get();
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-18', good_pieces: 10000, defect_after: 500 }, 1);
  h['production:save'](null, { carton_id: carton.id, result_date: '2026-10-18', good_pieces: 11000, defect_after: 200 }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_results WHERE carton_id=?').get(carton.id).c, 1);
  assert.equal(db.prepare('SELECT good_pieces FROM production_results WHERE carton_id=?').get(carton.id).good_pieces, 11000);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 200);
  h['production:delete'](null, carton.id, 1);
  assert.equal(db.prepare('SELECT status FROM cartons WHERE id=?').get(carton.id).status, 'issued');
  assert.equal(h['production:pending']().length, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 0);
});

test('receives:save own moves goods into warehouse with unit conversion and +salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('receives');
  const { id } = h['receives:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 2, warehouse_id: 1, quantity: 3, unit: 'كيس' }]
  }, 1);
  const bal = getBalance(db, 2, 1);
  assert.equal(bal.balance_pieces, 300);
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=2').get().qty_salem, 300);
  const item = db.prepare('SELECT pieces, weight_kg FROM receive_items WHERE receive_permit_id=?').get(id);
  assert.equal(item.pieces, 300);
  assert.equal(Math.round(item.weight_kg * 100) / 100, 15.6);
});

test('receives:save customer source records without stock movement nor salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('receives');
  h['receives:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', source: 'customer', party_id: 1,
    items: [{ item_id: 2, warehouse_id: 1, quantity: 2, unit: 'كيس' }]
  }, 1);
  const bal = getBalance(db, 2, 1);
  assert.equal(bal.balance_pieces, 0);
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=2').get().qty_salem, 0);
  assert.throws(() => h['receives:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', source: 'customer',
    items: [{ item_id: 2, warehouse_id: 1, quantity: 1, unit: 'حبة' }]
  }, 1), /اختر العميل/);
});

test('receives:save accepts any item and void reverses moves and salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('receives');
  const { id } = h['receives:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'حبة' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 10);
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 10);
  h['receives:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 0);
  assert.equal(db.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 0);
  assert.equal(db.prepare('SELECT status FROM receive_permits WHERE id=?').get(id).status, 'void');
});
