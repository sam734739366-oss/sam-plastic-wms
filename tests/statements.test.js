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

test('كشف حساب طرف: رصيد افتتاحي ومتحرك وختامي بترتيب التاريخ', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'payments', 'ledger']);
  // شراء آجل يهيّئ رصيد الصنف (على المورد، لا يمس كشف العميل)
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-09', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 20 }]
  }, 1);
  // فاتورة آجلة على العميل (مدين 5000) ثم سند قبض (دائن 2000)
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-10', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  h['payments:save'](null, {
    doc_number: 'Q-1', doc_date: '2026-10-15', party_id: 2, direction: 'in', amount: 2000
  }, 1);
  const st = h['ledger:statement'](null, 2, null, null);
  assert.equal(st.party.name, 'عميل تجريبي');
  assert.equal(st.opening, 0);
  assert.equal(st.rows.length, 2);
  assert.equal(st.rows[0].side, 'debit');
  assert.equal(st.rows[0].running, 5000);
  assert.equal(st.rows[1].side, 'credit');
  assert.equal(st.rows[1].running, 3000);
  assert.equal(st.closing, 3000);
});

test('كشف حساب طرف: الفترة تحسب رصيداً افتتاحياً قبلها', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'payments', 'ledger']);
  // شراء آجل يهيّئ رصيد الصنف (على المورد، لا يمس كشف العميل)
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-09-30', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 20 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-01', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  h['payments:save'](null, {
    doc_number: 'Q-1', doc_date: '2026-10-15', party_id: 2, direction: 'in', amount: 2000
  }, 1);
  const st = h['ledger:statement'](null, 2, '2026-10-10', null);
  assert.equal(st.opening, 5000); // فاتورة 1 أكتوبر قبل الفترة
  assert.equal(st.rows.length, 1); // سند القبض فقط داخل الفترة
  assert.equal(st.rows[0].running, 3000);
  assert.equal(st.closing, 3000);
});

test('ملخص الذمم: عميل مدين ومورد دائن وصافي لكل طرف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'ledger']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-01', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 20 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-02', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 60 }]
  }, 1);
  const sum = h['ledger:parties-summary']();
  const supplier = sum.find(r => r.id === 1);
  const customer = sum.find(r => r.id === 2);
  assert.equal(supplier.credit, 4000);
  assert.equal(supplier.net, -4000); // علينا
  assert.equal(customer.debit, 3000);
  assert.equal(customer.net, 3000); // لنا
});

test('تقرير النقدية: وارد وصادر وصافي في الفترة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'ledger']);
  // شراء آجل يهيّئ رصيد الصنف دون لمس النقدية
  h['purchases:save'](null, {
    doc_number: 'P-0', doc_date: '2026-10-04', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 10 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-05', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 30 }]
  }, 1);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-06', party_id: 1, payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 10 }]
  }, 1);
  const rep = h['ledger:cash-report'](null, null, null);
  assert.equal(rep.totalIn, 3000);
  assert.equal(rep.totalOut, 1000);
  assert.equal(rep.net, 2000);
  assert.equal(rep.rows.length, 2);
  // الفترة تحد من الحركات
  const part = h['ledger:cash-report'](null, '2026-10-06', null);
  assert.equal(part.totalIn, 0);
  assert.equal(part.totalOut, 1000);
});
