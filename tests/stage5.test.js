const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن المواد الخام');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, pieces_per_carton) VALUES (?,?,?,?,?)')
    .run('003-001', 'امبول عميل 5.02', 3, 'امبولة', 5000);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)')
    .run('002-001', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, service_price) VALUES (?,?,?,?,?)')
    .run('004-001', 'أجرة نفخ عبوة 5 لتر', 4, 'حبة', 500);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل تجريبي', 'customer');
  return d;
}

function stubIpc() {
  const handlers = {};
  require('../src/handlers/tolling')({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

test('tolling:receiptSave builds pieces from boxes x per-box and balance shows remaining', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 4, pieces_per_box: 5000, weight_kg: 10.04 }]
  }, 1);
  const item = db.prepare('SELECT pieces, boxes, pieces_per_box FROM customer_raw_items').get();
  assert.equal(item.pieces, 20000);
  assert.equal(item.boxes, 4);
  assert.equal(item.pieces_per_box, 5000);
  const bal = h['tolling:balance']();
  assert.equal(bal.length, 1);
  assert.equal(bal[0].raw_in, 20000);
  assert.equal(bal[0].remaining, 20000);
});

test('tolling:receiptSave defaults pieces_per_box from item and accepts any item', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  // بند بخام عميل (مجموعة 003) مع افتراض حبات/علبة من الصنف
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 2 }]
  }, 1);
  assert.equal(db.prepare('SELECT pieces FROM customer_raw_items').get().pieces, 10000);
  // أي صنف مقبول الآن (لا تقييد بالمجموعات) مع تحديد حبات/علبة يدوياً
  h['tolling:receiptSave'](null, {
    doc_number: '2', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 2, boxes: 3, pieces_per_box: 100 }]
  }, 1);
  const rows = db.prepare('SELECT pieces FROM customer_raw_items WHERE item_id=2').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pieces, 300);
});

test('tolling:deliverySave deducts balance and blocks overshoot', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 4, pieces_per_box: 5000 }]
  }, 1);
  h['tolling:deliverySave'](null, {
    doc_number: 'D-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 2, quantity: 50, unit: 'حبة' }]
  }, 1);
  let bal = h['tolling:balance']()[0];
  assert.equal(bal.delivered_out, 50);
  assert.equal(bal.remaining, 19950);
  assert.throws(() => h['tolling:deliverySave'](null, {
    doc_number: 'D-2', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 2, quantity: 99999, unit: 'حبة' }]
  }, 1), /أكبر من رصيد العميل/);
});

test('tolling:deliverySave creates linked blowing fee invoice with group-4 items', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 10, pieces_per_box: 5000 }]
  }, 1);
  const { id } = h['tolling:deliverySave'](null, {
    doc_number: 'D-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 2, quantity: 100, unit: 'حبة' }],
    invoice: { create: true, doc_number: 'F-1', driver_name: 'سائق', car_number: '1234',
      items: [{ item_id: 3, quantity: 100, unit_price: 500 }] }
  }, 1);
  const del = db.prepare('SELECT invoice_id FROM customer_deliveries WHERE id=?').get(id);
  assert.ok(del.invoice_id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(del.invoice_id);
  assert.equal(inv.invoice_type, 'blowing_fee');
  assert.equal(inv.driver_name, 'سائق');
  const invItem = db.prepare('SELECT unit, total_price FROM invoice_items WHERE invoice_id=?').get(del.invoice_id);
  assert.equal(invItem.unit, 'حبة');
  assert.equal(invItem.total_price, 50000);
  assert.throws(() => h['tolling:deliveryVoid'](null, id, 1), /ألغِ الفاتورة أولاً/);
});

test('tolling:deliveryVoid frees the balance again', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 4, pieces_per_box: 5000 }]
  }, 1);
  const { id } = h['tolling:deliverySave'](null, {
    doc_number: 'D-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 2, quantity: 50, unit: 'حبة' }]
  }, 1);
  h['tolling:deliveryVoid'](null, id, 1);
  const bal = h['tolling:balance']()[0];
  assert.equal(bal.delivered_out, 0);
  assert.equal(bal.remaining, 20000);
});

test('tolling:receiptVoid excludes voided receipts from balance', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 4, pieces_per_box: 5000 }]
  }, 1);
  h['tolling:receiptVoid'](null, id, 1);
  const bal = h['tolling:balance']()[0];
  assert.equal(bal.raw_in, 0);
  assert.equal(bal.remaining, 0);
});

test('tolling:suggestReceipt suggests the next numeric document number', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.equal(h['tolling:suggestReceipt'](), '1');
  h['tolling:receiptSave'](null, {
    doc_number: '1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 1, pieces_per_box: 5000 }]
  }, 1);
  assert.equal(h['tolling:suggestReceipt'](), '2');
});
