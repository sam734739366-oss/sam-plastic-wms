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
    .run('002', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('001', 'امبول 5.02', 1, 'امبولة', 5.02);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, pieces_per_carton) VALUES (?,?,?,?,?)')
    .run('003', 'امبول عميل', 3, 'امبول', 5000);
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
    items: [{ item_id: itemId, warehouse_id: warehouseId, quantity: pieces, unit: 'حبة' }]
  }, 1);
}

function buckets(db, id = 1) {
  return db.prepare('SELECT qty_salem s, qty_talef t, qty_muharraz m FROM items WHERE id=?').get(id);
}

// إدخال رصيد سلة فعلي في المخزن كحركات (مثل تالف نتيجة إنتاج أو رصيد افتتاحي)
function stockBucketIn(db, itemId, warehouseId, bucket, pieces) {
  db.prepare(`INSERT INTO stock_moves
    (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, bucket)
    VALUES ('opening',?,?,?,?,?,?,?)`)
    .run(itemId, `مخزون-${bucket}`, '2026-10-17', itemId, warehouseId, pieces, bucket);
}

test('sales:save sale moves stock out with balance check, totals, and deducts salem', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  stockIn(db, h, 1, 1, 1000);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 100 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 700);
  assert.equal(buckets(db).s, 700);
  assert.equal(db.prepare('SELECT total_price FROM invoice_items WHERE invoice_id=?').get(id).total_price, 30000);
  assert.throws(() => h['sales:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', invoice_type: 'sale',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 9999, unit: 'حبة' }]
  }, 1), /الرصيد غير كافٍ/);
});

test('sales:save scrap invoice deducts talef and any item is accepted', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  stockIn(db, h, 1, 1, 500);
  db.prepare('UPDATE items SET qty_talef=400 WHERE id=1').run();
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'scrap', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 400);
  assert.equal(buckets(db).t, 300);
  assert.equal(buckets(db).s, 500);
});

test('sales:save blowing_fee does not touch stock or buckets and accepts any item', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['sales']);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'blowing_fee', party_id: 2,
    items: [{ item_id: 2, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 500 }]
  }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
  assert.equal(buckets(db, 2).s + buckets(db, 2).t + buckets(db, 2).m, 0);
});

test('sales:void restores salem and blocks when linked to active delivery', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  stockIn(db, h, 1, 1, 1000);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 100 }]
  }, 1);
  db.prepare(`INSERT INTO customer_deliveries (doc_number, doc_date, party_id, invoice_id) VALUES ('D-1','2026-10-18',2,?)`).run(id);
  assert.throws(() => h['sales:void'](null, id, 1), /التسليم أولاً/);
  db.prepare(`UPDATE customer_deliveries SET status='void' WHERE invoice_id=?`).run(id);
  h['sales:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 1000);
  assert.equal(buckets(db).s, 1000);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(id).status, 'void');
});

test('exits:save requires driver, checks balance, deducts salem; void restores', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'exits']);
  stockIn(db, h, 1, 1, 500);
  assert.throws(() => h['exits:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', warehouse_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'حبة' }]
  }, 1), /السائق/);
  const { id } = h['exits:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', warehouse_id: 1, driver_name: 'سائق', car_number: '1234',
    destination: 'صنعاء',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  assert.equal(buckets(db).s, 300);
  h['exits:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 500);
  assert.equal(buckets(db).s, 500);
});

test('scrap to_recycled deducts talef first then salem, adds muharraz, edit re-applies exactly', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  db.prepare('UPDATE items SET qty_salem=300, qty_talef=100 WHERE id=1').run();
  stockBucketIn(db, 1, 2, 'salem', 300);
  stockBucketIn(db, 1, 2, 'talef', 100);
  const { id } = h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 150, weight_kg: 0
  }, 1);
  const b1 = buckets(db);
  assert.equal(b1.t, 0);
  assert.equal(b1.s, 250);
  assert.equal(b1.m, 150);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 400);
  // تعديل: عكس القديم بدقة ثم تطبيق الجديد
  h['scrap:save'](null, {
    id, doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 2, pieces: 40, weight_kg: 0
  }, 1);
  const b2 = buckets(db);
  assert.equal(b2.t, 60);
  assert.equal(b2.s, 300);
  assert.equal(b2.m, 40);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 400);
});

test('scrap to_stock returns talef as salem into warehouse', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  db.prepare('UPDATE items SET qty_salem=0, qty_talef=80 WHERE id=1').run();
  stockBucketIn(db, 1, 2, 'talef', 80);
  h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_stock',
    warehouse_id: 2, pieces: 80
  }, 1);
  const b = buckets(db);
  assert.equal(b.t, 0);
  assert.equal(b.s, 80);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 80);
});

test('scrap to_supplier moves stock out of warehouse, deducts buckets, void reverses', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['scrap']);
  db.prepare('UPDATE items SET qty_salem=200, qty_talef=100 WHERE id=1').run();
  stockBucketIn(db, 1, 2, 'talef', 100);
  const { id } = h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'to_supplier',
    party_id: 1, warehouse_id: 2, pieces: 60
  }, 1);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 40);
  assert.equal(buckets(db).t, 40);
  assert.equal(buckets(db).s, 200);
  h['scrap:void'](null, id, 1);
  assert.equal(db.prepare('SELECT status FROM scrap_movements WHERE id=?').get(id).status, 'void');
  assert.equal(buckets(db).t, 100);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 100);
});

test('scrap sold_scrap checks warehouse balance and deducts buckets', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'scrap']);
  stockIn(db, h, 2, 1, 300);
  h['scrap:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', item_id: 1, disposition: 'sold_scrap',
    warehouse_id: 2, pieces: 100, price: 50
  }, 1);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 200);
  assert.equal(buckets(db).s, 200);
  assert.throws(() => h['scrap:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', item_id: 1, disposition: 'sold_scrap',
    warehouse_id: 2, pieces: 9999
  }, 1), /الرصيد .*غير كافٍ/);
});

test('scrap customer waste records only and appears in tolling balance', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling', 'scrap']);
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 2,
    items: [{ item_id: 3, boxes: 2, pieces_per_box: 5000 }]
  }, 1);
  h['scrap:save'](null, {
    doc_number: 'S-1', doc_date: '2026-10-18', item_id: 3, disposition: 'to_recycled',
    party_id: 2, pieces: 500
  }, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 0);
  assert.equal(buckets(db, 3).s + buckets(db, 3).t + buckets(db, 3).m, 0);
  const bal = h['tolling:balance']()[0];
  assert.equal(bal.raw_in, 10000);
  assert.equal(bal.scrap_out, 500);
  assert.equal(bal.remaining, 9500);
});

test('transfers move between warehouses without bucket change and void reverses both', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'transfers']);
  stockIn(db, h, 1, 1, 400);
  assert.throws(() => h['transfers:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 1,
    items: [{ item_id: 1, quantity: 10, unit: 'حبة' }]
  }, 1), /مخزنين مختلفين/);
  const { id } = h['transfers:save'](null, {
    doc_number: '2', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 2,
    items: [{ item_id: 1, quantity: 150, unit: 'حبة' }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 250);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 150);
  assert.equal(buckets(db).s, 400);
  assert.throws(() => h['transfers:save'](null, {
    doc_number: '3', doc_date: '2026-10-18', from_warehouse_id: 1, to_warehouse_id: 2,
    items: [{ item_id: 1, quantity: 99999, unit: 'حبة' }]
  }, 1), /مخزن المصدر/);
  h['transfers:void'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 400);
  assert.equal(getBalance(db, 1, 2).balance_pieces, 0);
});
