const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');
const ledger = require('../src/ledger');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('001', 'عبوة 1 لتر', 2, 'عبوة', 25);
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

function buckets(db, id = 1) {
  return db.prepare('SELECT qty_salem s, qty_talef t, qty_muharraz m FROM items WHERE id=?').get(id);
}

test('مرتجع بيع آجل: يعيد البضاعة للمخزون ويخفض ذمة العميل', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  assert.equal(ledger.partyBalance(db, 2), 6000);
  const { id } = h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.ok(id);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 350);
  assert.equal(buckets(db).s, 350);
  assert.equal(ledger.partyBalance(db, 2), 4500);
  assert.equal(ledger.cashBalance(db), 0);
});

test('مرتجع بيع نقدي: يسترد العميل نقداً فتنقص النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), 6000);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), 3000);
  assert.equal(ledger.partyBalance(db, 2), 3000);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 400);
});

test('مرتجع شراء: يخرج من المخزون ويخفض ذمة المورد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'returns']);
  const { id: purId } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 400, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(ledger.partyBalance(db, 1), -4000);
  h['returns:save'](null, {
    type: 'purchase', doc_number: 'RP-1', doc_date: '2026-10-19', purchase_id: purId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  assert.equal(buckets(db).s, 300);
  assert.equal(ledger.partyBalance(db, 1), -3000);
  assert.equal(ledger.cashBalance(db), 0);
});

test('مرتجع شراء نقدي: يقبض من المورد نقداً', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'returns']);
  const { id: purId } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 400, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), -4000);
  h['returns:save'](null, {
    type: 'purchase', doc_number: 'RP-1', doc_date: '2026-10-19', purchase_id: purId,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), -3000);
  assert.equal(ledger.partyBalance(db, 1), -3000);
});

test('يمنع إرجاع كمية أكبر من الفاتورة الأصلية (مع مراعاة المرتجعات السابقة)', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 150, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.throws(() => h['returns:save'](null, {
    type: 'sale', doc_number: 'R-2', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 60, unit: 'حبة', unit_price: 30 }]
  }, 1), /المتبقي/);
  // 50 المتبقية مسموحة
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-3', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(ledger.partyBalance(db, 2), 0);
});

test('إلغاء مرتجع بيع يعكس المخزون والذمة والنقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  const { id } = h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 30 }]
  }, 1);
  h['returns:void'](null, { type: 'sale', id }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  assert.equal(buckets(db).s, 300);
  assert.equal(ledger.cashBalance(db), 6000);
  assert.equal(ledger.partyBalance(db, 2), 6000);
});

test('يمنع إلغاء فاتورة عليها مرتجع نشط', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.throws(() => h['sales:void'](null, invId, 1), /مرتجعات/);
});

test('تعديل مرتجع: يعكس القديم ويطبق الجديد بدقة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id: invId } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]
  }, 1);
  const { id } = h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(ledger.partyBalance(db, 2), 3000);
  h['returns:save'](null, {
    id, type: 'sale', doc_number: 'R-1', doc_date: '2026-10-19', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 40, unit: 'حبة', unit_price: 30 }]
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 340);
  assert.equal(ledger.partyBalance(db, 2), 4800);
  assert.equal(ledger.cashBalance(db), 0);
});
