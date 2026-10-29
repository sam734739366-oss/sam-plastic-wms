// ===== ترحيل الفواتير الخارجة ومرتجعاتها =====
// الترحيل: رقم فاتورة يدوي + عميل + بيانات مخازن، والسعر اختياري:
// بلا أسعار = خصم مخزني فقط بلا قيد محاسبي، وبأسعار = ذمة/قبض على العميل.
// المرتجع مربوط بالفاتورة الأصلية ولا يتجاوز المتبقي القابل للإرجاع.

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

function seedStock(h, qty = 500) {
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-18',
    items: [{ item_id: 1, warehouse_id: 1, quantity: qty, unit: 'حبة' }],
  }, 1);
}

function saleDoc(number = 'INV-1', items, extra = {}) {
  return {
    doc_number: number, doc_date: '2026-10-24', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: items || [{ item_id: 1, warehouse_id: 1, quantity: 30, unit: 'حبة' }],
    ...extra,
  };
}

test('sales:list يعيد مجموع حبات كل فاتورة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  h['sales:save'](null, saleDoc(), 1);
  const row = h['sales:list']().find(r => r.doc_number === 'INV-1');
  assert.equal(row.total_pieces, 30);
  assert.equal(row.items_count, 1);
});

test('ترحيل بلا أسعار: خصم مخزني فقط بلا قيود محاسبية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  const { id } = h['sales:save'](null, saleDoc(), 1);
  assert.ok(id);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 470);
  assert.equal(buckets(db).s, 470);
  const rows = db.prepare("SELECT * FROM party_ledger WHERE doc_type='invoice'").all();
  assert.equal(rows.length, 0);
  assert.equal(ledger.partyBalance(db, 2), 0);
  assert.equal(ledger.cashBalance(db), 0);
});

test('ترحيل آجل بأسعار: ذمة مدين على العميل', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  h['sales:save'](null, saleDoc('INV-2', [{ item_id: 1, warehouse_id: 1, quantity: 30, unit: 'حبة', unit_price: 50 }]), 1);
  assert.equal(ledger.partyBalance(db, 2), 1500);
  assert.equal(ledger.cashBalance(db), 0);
  const row = db.prepare("SELECT * FROM party_ledger WHERE doc_type='invoice'").get();
  assert.equal(row.side, 'debit');
  assert.equal(row.amount, 1500);
  assert.equal(row.cash_in, 0);
});

test('ترحيل نقدي بأسعار: ذمة + قبض فوري للنقدية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  h['sales:save'](null, saleDoc('INV-3', [{ item_id: 1, warehouse_id: 1, quantity: 30, unit: 'حبة', unit_price: 50 }], { payment_method: 'cash' }), 1);
  assert.equal(ledger.cashBalance(db), 1500);
  assert.equal(ledger.partyBalance(db, 2), 1500);
});

test('رقم الفاتورة مكرر مرفوض', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  h['sales:save'](null, saleDoc(), 1);
  assert.throws(() => h['sales:save'](null, saleDoc(), 1), /مكرر/);
});

test('رصيد غير كافٍ مرفوض', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h, 100);
  assert.throws(() => h['sales:save'](null, saleDoc('INV-4', [{ item_id: 1, warehouse_id: 1, quantity: 9999, unit: 'حبة' }]), 1), /رصيد السليم غير كاف/);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 100);
});

test('تعديل الفاتورة يعكس القديم ويطبق الجديد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  const { id } = h['sales:save'](null, saleDoc(), 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 470);
  h['sales:save'](null, saleDoc('INV-1', [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'حبة' }], { id }), 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 490);
  assert.equal(buckets(db).s, 490);
});

test('حذف الفاتورة يعيد الكمية ويمحو القيد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales']);
  seedStock(h);
  const { id } = h['sales:save'](null, saleDoc('INV-5', [{ item_id: 1, warehouse_id: 1, quantity: 30, unit: 'حبة', unit_price: 50 }]), 1);
  const imp = h['sales:impact'](null, id);
  assert.equal(imp.impact.length, 1);
  assert.equal(imp.value, 1500, 'قيمة المستند المعروضة في النافذة هي إجمالي الفاتورة');
  h['sales:delete'](null, id, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 500);
  assert.equal(ledger.partyBalance(db, 2), 0);
  assert.equal(ledger.cashBalance(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices WHERE id=?').get(id).c, 0, 'لا أثر «ملغى» — الصف يُمحى');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM party_ledger WHERE doc_type='invoice' AND doc_id=?").get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoice_items WHERE invoice_id=?').get(id).c, 0);
});

test('مرتجع مربوط بالفاتورة يعيد الكمية للسلة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  seedStock(h);
  const { id: invId } = h['sales:save'](null, saleDoc('INV-6', [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة' }]), 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-1', doc_date: '2026-10-25', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة' }],
  }, 1);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 350);
  assert.equal(buckets(db).s, 350);
  const avail = h['returns:available'](null, 'sale', invId);
  assert.equal(avail[0].remain, 150);
  assert.equal(ledger.partyBalance(db, 2), 0);
});

test('منع تجاوز المتبقي في المرتجع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  seedStock(h);
  const { id: invId } = h['sales:save'](null, saleDoc('INV-7', [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة' }]), 1);
  assert.throws(() => h['returns:save'](null, {
    type: 'sale', doc_number: 'R-2', doc_date: '2026-10-25', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 250, unit: 'حبة' }],
  }, 1), /المتبقي/);
  assert.equal(getBalance(db, 1, 1).balance_pieces, 300);
});

test('مرتجع بأسعار يخفض ذمة العميل', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  seedStock(h);
  const { id: invId } = h['sales:save'](null, saleDoc('INV-8', [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 30 }]), 1);
  assert.equal(ledger.partyBalance(db, 2), 6000);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-3', doc_date: '2026-10-25', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 30 }],
  }, 1);
  assert.equal(ledger.partyBalance(db, 2), 4500);
});

test('رفض حذف فاتورة عليها مرتجع — والرسالة تذكر رقم المرتجع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'returns']);
  seedStock(h);
  const { id: invId } = h['sales:save'](null, saleDoc('INV-9', [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة' }]), 1);
  h['returns:save'](null, {
    type: 'sale', doc_number: 'R-4', doc_date: '2026-10-25', invoice_id: invId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 10, unit: 'حبة' }],
  }, 1);
  const err = (() => { try { h['sales:delete'](null, invId, 1); return null; } catch (e) { return e; } })();
  assert.ok(err && /مرتجع بيع R-4/.test(err.message), 'الرسالة تذكر المرتجع برقمه');
  assert.equal(err.code, 'DEPENDENTS');
  assert.equal(/احذف الأحدث/.test(err.message), true, 'والرسالة توجّه لحذف الأحدث أولاً');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices WHERE id=?').get(invId).c, 1, 'الفاتورة باقية بعد المنع');
  // وبعد حذف المرتجع صار الحذف ممكناً
  const { id: retId } = db.prepare('SELECT id FROM sales_returns').get();
  h['returns:delete'](null, { type: 'sale', id: retId }, 1);
  assert.equal(h['sales:delete'](null, invId, 1).ok, true);
});
