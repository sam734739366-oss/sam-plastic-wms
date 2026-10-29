const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const registerDashboard = require('../src/handlers/dashboard');

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// يوم 15 من الشهر الحالي ناقص k شهراً (تفادي حدود نهاية الشهر)
function dayInMonthAgo(k) {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth() - k, 15));
}

function memDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return d;
}

function registerHandlers(d) {
  setDb(d);
  const fns = {};
  registerDashboard({ handle: (ch, fn) => { fns[ch] = fn; } });
  return fns;
}

test('dashboard:charts يعيد 6 أشهر بالمجاميع الصحيحة ويتجاهل المحذوف والخارج عن النافذة', () => {
  const d = memDb();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن 1');
  d.prepare('INSERT INTO parties (name, type) VALUES (?,?)').run('عميل أ', 'customer');
  d.prepare('INSERT INTO parties (name, type) VALUES (?,?)').run('مورد ب', 'supplier');
  const addItem = d.prepare(`INSERT INTO items (code,name,item_group,unit_name,qty_salem,qty_talef,qty_muharraz)
    VALUES (?,?,?,?,?,?,?)`);
  addItem.run('T-1', 'صنف أول', 2, 'حبة', 1000, 50, 200);
  addItem.run('T-2', 'صنف ثاني', 2, 'حبة', 300, 0, 40);
  addItem.run('T-3', 'صنف صفري', 2, 'حبة', 0, 0, 0);
  const addPur = d.prepare(`INSERT INTO purchases (doc_number, doc_date, party_id)
    VALUES (?,?,?)`);
  const addPurItem = d.prepare(`INSERT INTO purchase_items
    (purchase_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, total_price, bucket)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const addInv = d.prepare(`INSERT INTO invoices (doc_number, doc_date, party_id, invoice_type)
    VALUES (?,?,?,?)`);
  const addInvItem = d.prepare(`INSERT INTO invoice_items
    (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, total_price, bucket)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  // مشتريات: الشهر الحالي 5000، قبل شهر 3000، قبل 6 أشهر 9000 (خارج النافذة)، محذوفة 777
  const pCur = addPur.run('P-CUR', dayInMonthAgo(0), 2).lastInsertRowid;
  addPurItem.run(pCur, 1, 1, 1, 'حبة', 1, 0, 5000, 'salem');
  const pM1 = addPur.run('P-M1', dayInMonthAgo(1), 2).lastInsertRowid;
  addPurItem.run(pM1, 1, 1, 1, 'حبة', 1, 0, 3000, 'salem');
  const pM6 = addPur.run('P-M6', dayInMonthAgo(6), 2).lastInsertRowid;
  addPurItem.run(pM6, 1, 1, 1, 'حبة', 1, 0, 9000, 'salem');
  // في v2 لا يوجد «ملغى»: السند المحذوف يُمحى صفّه وحركاته، فلا يظهر في المخطط
  const pDel = addPur.run('P-DEL', dayInMonthAgo(0), 2).lastInsertRowid;
  addPurItem.run(pDel, 1, 1, 1, 'حبة', 1, 0, 777, 'salem');
  d.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(pDel);
  d.prepare('DELETE FROM purchases WHERE id=?').run(pDel);

  // مبيعات: الشهر الحالي 2000، قبل شهرين 4000
  const iCur = addInv.run('I-CUR', dayInMonthAgo(0), 1, 'sale').lastInsertRowid;
  addInvItem.run(iCur, 1, 1, 1, 'حبة', 1, 0, 2000, 'salem');
  const iM2 = addInv.run('I-M2', dayInMonthAgo(2), 1, 'sale').lastInsertRowid;
  addInvItem.run(iM2, 1, 1, 1, 'حبة', 1, 0, 4000, 'salem');

  // دفتر: ذمة عميل 1200، ذمة مورد 800، نقدية 5000 داخلة و1500 خارجة
  const addLed = d.prepare(`INSERT INTO party_ledger
    (party_id, doc_type, doc_id, doc_number, doc_date, side, amount, cash_in, cash_out, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  addLed.run(1, 'invoice', 1, 'L-1', dayInMonthAgo(0), 'debit', 1200, 0, 0, '');
  addLed.run(2, 'purchase', 2, 'L-2', dayInMonthAgo(0), 'credit', 800, 0, 0, '');
  addLed.run(null, 'receipt', 3, 'L-3', dayInMonthAgo(0), 'debit', 0, 5000, 0, '');
  addLed.run(null, 'payment', 4, 'L-4', dayInMonthAgo(0), 'credit', 0, 0, 1500, '');

  const fns = registerHandlers(d);
  const c = fns['dashboard:charts']();

  // 6 أشهر بأسماء عربية صحيحة من الأقدم (قبل 5 أشهر) إلى الشهر الحالي
  const now = new Date();
  assert.equal(c.monthly.length, 6);
  c.monthly.forEach((m, i) => {
    const dRef = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    assert.equal(m.label, AR_MONTHS[dRef.getMonth()]);
  });
  assert.equal(c.monthly[5].purchases, 5000);  // الشهر الحالي
  assert.equal(c.monthly[4].purchases, 3000);  // قبل شهر
  assert.equal(c.monthly[5].sales, 2000);
  assert.equal(c.monthly[3].sales, 4000);      // قبل شهرين
  assert.equal(c.monthly[2].purchases, 0);     // قبل 3 أشهر بلا حركة
  // الخارج عن النافذة والمحذوف لا يظهران في أي شهر
  assert.equal(c.monthly.reduce((a, m) => a + m.purchases, 0), 8000);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM purchases WHERE doc_number IN ('P-DEL','P-VOID')").get().c, 0,
    'الحذف الفعلي لا يترك صفاً معلّماً في الجدول');

  // التوزيع: مجموع سليم 1300 / تالف 50 / محرز 240
  assert.deepEqual(c.buckets, [
    { label: 'سليم', value: 1300 },
    { label: 'تالف', value: 50 },
    { label: 'محرز', value: 240 },
  ]);

  // المركز المالي: نقدية 3500، عملاء 1200، موردون 800
  assert.equal(c.financial[0].value, 3500);
  assert.equal(c.financial[1].value, 1200);
  assert.equal(c.financial[2].value, 800);

  // أعلى الأصناف: تنازلياً وحصر الأصناف ذات الرصيد الموجب
  assert.deepEqual(c.top_items, [
    { name: 'صنف أول', qty: 1000 },
    { name: 'صنف ثاني', qty: 300 },
  ]);
});

test('dashboard:charts يعمل بقاعدة فارغة دون انهيار', () => {
  const d = memDb();
  const fns = registerHandlers(d);
  const c = fns['dashboard:charts']();
  assert.equal(c.monthly.length, 6);
  assert.equal(c.monthly.every((m) => m.purchases === 0 && m.sales === 0), true);
  assert.equal(c.buckets.every((b) => b.value === 0), true);
  assert.equal(c.financial.every((f) => f.value === 0), true);
  assert.deepEqual(c.top_items, []);
});
