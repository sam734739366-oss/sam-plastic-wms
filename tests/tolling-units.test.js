const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)')
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag)
    VALUES (?,?,?,?,?,?,?)`)
    .run('001', 'عبوة 1 لتر', 2, 'عبوة', 25, 5000, 100);
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

test('استلام خام بوحدة كرتون: تحسب الحبات بتوابع الصنف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  const { id } = h['tolling:receiptSave'](null, {
    doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 2, unit: 'كرتون', weight_kg: 250 }]
  }, 1);
  const doc = h['tolling:receiptGet'](null, id);
  assert.equal(doc.items[0].pieces, 10000);
  assert.equal(doc.items[0].unit, 'كرتون');
  assert.equal(doc.items[0].boxes, 2);
  assert.equal(doc.items[0].weight_kg, 250);
  const bal = h['tolling:balance']();
  assert.equal(bal[0].raw_in, 10000);
});

test('استلام خام بالشكل القديم (علب × حبات/علبة) ما زال مدعوماً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  const { id } = h['tolling:receiptSave'](null, {
    doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, boxes: 2, pieces_per_box: 5000 }]
  }, 1);
  const doc = h['tolling:receiptGet'](null, id);
  assert.equal(doc.items[0].pieces, 10000);
  assert.equal(doc.items[0].unit, 'عبوة');
});

test('استلام خام بوحدة كجم: تحسب الحبات من وزن القطعة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  const { id } = h['tolling:receiptSave'](null, {
    doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 5, unit: 'كجم' }]
  }, 1);
  const doc = h['tolling:receiptGet'](null, id);
  // 5 كجم = 5000 جرام ÷ 25 جرام/حبة = 200 حبة
  assert.equal(doc.items[0].pieces, 200);
});

test('وحدة بلا تحويل للصنف تُرفض برسالة واضحة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  // الصنف بلا pieces_per_shadda → وحدة شدة غير متاحة له
  assert.throws(() => h['tolling:receiptSave'](null, {
    doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 2, unit: 'شدة' }]
  }, 1), /عدد حبات/);
});

test('تعديل سند الاستلام يعيد كتابة البنود بالوحدة الجديدة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling']);
  const { id } = h['tolling:receiptSave'](null, {
    doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 2, unit: 'كرتون' }]
  }, 1);
  h['tolling:receiptSave'](null, {
    id, doc_number: 'R-1', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, quantity: 3, unit: 'كيس' }]
  }, 1);
  const doc = h['tolling:receiptGet'](null, id);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].pieces, 300);
  assert.equal(doc.items[0].unit, 'كيس');
  assert.equal(h['tolling:balance']()[0].raw_in, 300);
});
