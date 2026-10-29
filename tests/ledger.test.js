const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
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

function ledgerRows(db, docType = null, docId = null) {
  let sql = 'SELECT * FROM party_ledger';
  const args = [];
  if (docType) { sql += ' WHERE doc_type=?'; args.push(docType); }
  if (docId != null) { sql += (docType ? ' AND' : ' WHERE') + ' doc_id=?'; args.push(docId); }
  return db.prepare(sql).all(...args);
}

test('فاتورة بيع آجلة: ذمة على العميل دون لمس النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  const rows = ledgerRows(db, 'invoice', id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'debit');
  assert.equal(rows[0].amount, 5000);
  assert.equal(rows[0].cash_in, 0);
  assert.equal(ledger.cashBalance(db), 0);
  assert.equal(ledger.partyBalance(db, 2), 5000);
});

test('فاتورة بيع نقدية: ذمة + قبض فوري للنقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), 5000);
  assert.equal(ledger.partyBalance(db, 2), 5000);
});

test('فاتورة شراء آجلة: ذمة للمورد دون لمس النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases']);
  const { id } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 10 }]
  }, 1);
  const rows = ledgerRows(db, 'purchase', id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'credit');
  assert.equal(rows[0].amount, 2000);
  assert.equal(rows[0].cash_out, 0);
  assert.equal(ledger.cashBalance(db), 0);
  assert.equal(ledger.partyBalance(db, 1), -2000);
});

test('فاتورة شراء نقدية: ذمة + خصم فوري من النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 10 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), -2000);
  assert.equal(ledger.partyBalance(db, 1), -2000);
});

test('سند قبض: يخفض ذمة العميل ويزيد النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'payments']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  h['payments:save'](null, {
    doc_number: 'K-1', doc_date: '2026-10-19', party_id: 2, direction: 'in', amount: 2000
  }, 1);
  assert.equal(ledger.partyBalance(db, 2), 3000);
  assert.equal(ledger.cashBalance(db), 2000);
});

test('سند دفع: يخفض ذمتنا للمورد وينقص النقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'payments']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 10 }]
  }, 1);
  h['payments:save'](null, {
    doc_number: 'D-1', doc_date: '2026-10-19', party_id: 1, direction: 'out', amount: 800
  }, 1);
  assert.equal(ledger.partyBalance(db, 1), -1200);
  assert.equal(ledger.cashBalance(db), -800);
});

test('حذف فاتورة بيع نقدية يمحو أثر الذمة والنقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  assert.equal(ledgerRows(db, 'invoice', id).length, 1);
  h['sales:delete'](null, id, 1);
  assert.equal(ledger.cashBalance(db), 0);
  assert.equal(ledger.partyBalance(db, 2), 0);
  assert.equal(ledgerRows(db, 'invoice', id).length, 0, 'القيد يُمحى مع مستنده لا يُعلَّم');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices WHERE id=?').get(id).c, 0);
});

test('تعديل فاتورة من آجل إلى نقدي يعيد تسجيل أثر الدفتر', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  const { id } = h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), 0);
  h['sales:save'](null, {
    id, doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  assert.equal(ledger.cashBalance(db), 5000);
  assert.equal(ledger.partyBalance(db, 2), 5000);
  // قيد واحد فقط للصافي: التعديل يمح القديمة ويعيد التسجيل مرة واحدة
  const rows = ledgerRows(db, 'invoice', id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cash_in, 5000);
  assert.equal(rows[0].amount, 5000);
});

test('حذف سند قبض يعكس أثره على النقدية والذمة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'payments']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 50 }]
  }, 1);
  const { id } = h['payments:save'](null, {
    doc_number: 'K-1', doc_date: '2026-10-19', party_id: 2, direction: 'in', amount: 2000
  }, 1);
  assert.equal(h['payments:impact'](null, id).value, 2000, 'قيمة السند في نافذة التأكيد');
  assert.equal(h['payments:impact'](null, id).deps.length, 0, 'لا شيء يتفرع إلى سند القبض');
  h['payments:delete'](null, id, 1);
  assert.equal(ledger.partyBalance(db, 2), 5000);
  assert.equal(ledger.cashBalance(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments WHERE id=?').get(id).c, 0);
  assert.equal(ledgerRows(db, 'payment', id).length, 0, 'القيد مُمحى لا ملغى');
});

test('ذمم العملاء والموردين في ملخص الحسابات', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'payments']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 400, unit: 'حبة', unit_price: 10 }]
  }, 1);
  h['purchases:save'](null, {
    doc_number: 'P-2', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 500, unit: 'حبة' }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-18', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 20 }]
  }, 1);
  const r = ledger.receivables(db);
  assert.equal(r.customers, 4000);
  assert.equal(r.suppliers, 4000);
});
