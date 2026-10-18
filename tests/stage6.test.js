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
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن الإنتاج التام');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن المحرز والتالف');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)')
    .run('002-001', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('005-001', 'تالف عبوة', 5, 'حبة', 52);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, service_price) VALUES (?,?,?,?,?)')
    .run('004-001', 'أجرة نفخ عبوة 5 لتر', 4, 'حبة', 500);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('001-001', 'امبول 5.02', 1, 'امبولة', 5.02);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, pieces_per_carton) VALUES (?,?,?,?,?)')
    .run('003-001', 'امبول عميل', 3, 'امبولة', 5000);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد تجريبي', 'supplier');
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

function stockIn(db, h, warehouseId, itemId, pieces) {
  h['purchases:save'](null, {
    doc_number: `P-${Math.random().toString(36).slice(2, 8)}`, doc_date: '2026-10-18',
    items: [{ item_id: itemId, warehouse_id: warehouseId, quantity: pieces, unit: 'piece' }]
  }, 1);
}

test('sales:save moves stock out with balance check and totals', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  stockIn(db, h, 1, 1, 1000);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'piece', unit_price: 100 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 700);
  assert.equal(db.prepare('SELECT total_price FROM invoice_items WHERE invoice_id=?').get(id).total_price, 30000);
  assert.throws(() => h['sales:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', invoice_type: 'sale',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 9999, unit: 'piece' }]
  }, 1), /الرصيد غير كافٍ/);
});

test('sales:save blowing_fee requires group-4 and does not touch stock', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['sales']);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'blowing_fee', party_id: 2,
    items: [{ item_id: 3, warehouse_id: 1, quantity: 100, unit: 'piece', unit_price: 500 }]
  }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
  assert.throws(() => h['sales:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', invoice_type: 'blowing_fee',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'piece' }]
  }, 1), /المجموعة/);
});

test('sales:void restores stock and blocks when linked to active delivery', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  stockIn(db, h, 1, 1, 1000);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'piece', unit_price: 100 }]
  }, 1);
  db.prepare(`INSERT INTO customer_deliveries (doc_number, doc_date, party_id, invoice_id) VALUES ('D-1','2026-10-18',2,?)`).run(id);
  assert.throws(() => h['sales:void'](null, id, 1), /التسليم أولاً/);
  db.prepare(`UPDATE customer_deliveries SET status='void' WHERE invoice_id=?`).run(id);
  h['sales:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 1000);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(id).status, 'void');
});

test('exits:save requires driver, checks balance, void restores', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'exits']);
  stockIn(db, h, 1, 1, 500);
  assert.throws(() => h['exits:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', warehouse_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'piece' }]
  }, 1), /السائق/);
  const { id } = h['exits:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', warehouse_id: 1, driver_name: 'سائق', car_number: '1234',
    destination: 'صنعاء',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'piece' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  h['exits:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 500);
});

test('scrap:save dispositions move stock correctly', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'scrap']);
  stockIn(db, h, 1, 1, 1000);
  h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 200, weight_kg: 10.4
  }, 1);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 200);
  h['scrap:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', item_id: 1, disposition: 'sold_scrap',
    warehouse_id: 2, pieces: 100, price: 50
  }, 1);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 100);
  assert.throws(() => h['scrap:save'](null, {
    doc_number: '3', doc_date: '2026-10-18', item_id: 1, disposition: 'sold_scrap',
    warehouse_id: 2, pieces: 9999
  }, 1), /الرصيد غير كافٍ/);
});

test('scrap:save customer waste deducts from balance without stock moves', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling', 'scrap']);
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 2,
    items: [{ item_id: 5, boxes: 2, pieces_per_box: 5000 }]
  }, 1);
  h['scrap:save'](null, {
    doc_number: 'S-1', doc_date: '2026-10-18', item_id: 5, disposition: 'to_recycled',
    party_id: 2, pieces: 500
  }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
  const bal = h['tolling:balance']()[0];
  assert.equal(bal.raw_in, 10000);
  assert.equal(bal.scrap_out, 500);
  assert.equal(bal.remaining, 9500);
});

test('scrap:save to_supplier records without moves and void reverses', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  const { id } = h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_supplier',
    party_id: 1, pieces: 50
  }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
  h['scrap:void'](null, id, 1);
  assert.equal(db.prepare('SELECT status FROM scrap_movements WHERE id=?').get(id).status, 'void');
});

test('transfers:save moves between warehouses and void reverses both', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'transfers']);
  stockIn(db, h, 1, 1, 400);
  assert.throws(() => h['transfers:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 1,
    items: [{ item_id: 1, quantity: 10, unit: 'piece' }]
  }, 1), /مخزنين مختلفين/);
  const { id } = h['transfers:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 2,
    items: [{ item_id: 1, quantity: 150, unit: 'piece' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 250);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 150);
  assert.throws(() => h['transfers:save'](null, {
    doc_number: '3', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 2,
    items: [{ item_id: 1, quantity: 99999, unit: 'piece' }]
  }, 1), /مخزن المصدر/);
  h['transfers:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 400);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 0);
});
