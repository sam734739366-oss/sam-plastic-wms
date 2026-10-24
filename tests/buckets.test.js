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
  return d;
}

function stubIpc(...mods) {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  for (const m of mods) require('../src/handlers/' + m)(ipc);
  return handlers;
}

test('جرد المخزون: أعمدة سليم/تالف/محرز تُحسب من حركات المخزن المحدد وليس من جدول الأصناف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, {
    code: '501', name: 'علبة صابون', unit_name: 'علبة',
    qty_salem: 5000, qty_talef: 100, qty_muharraz: 50,
  }, 1);
  // بدون فلترة: مجاميع كل المخازن تعادل أرصدة الصنف
  const all = h['reports:inventory'](null, {});
  const rowAll = all.find(r => r.id === id);
  assert.equal(rowAll.qty_salem, 5000);
  assert.equal(rowAll.qty_talef, 100);
  assert.equal(rowAll.qty_muharraz, 50);
  // فلترة بمخزن الصابون (لا حركات له): الصنف المنتهي لا يظهر في جرد المخزن
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  const soap = h['reports:inventory'](null, { warehouseId: soapWh });
  assert.ok(!soap.find(r => r.id === id), 'الصنف صفر الكمية لا يظهر في جرد المخزن المحدد');
  // فلترة بالمخزن الرئيسي (فيه الافتتاحي): تعادل أرصدة الصنف
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const main = h['reports:inventory'](null, { warehouseId: mainWh });
  const rowMain = main.find(r => r.id === id);
  assert.equal(rowMain.qty_salem, 5000);
  assert.equal(rowMain.qty_talef, 100);
  assert.equal(rowMain.qty_muharraz, 50);
});

test('النقل بين مخزنين ينقل تخصيص السليم مع الكمية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports', 'transfers');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, {
    code: '502', name: 'علبة شامبو', unit_name: 'علبة', qty_salem: 1000, qty_talef: 0, qty_muharraz: 0,
  }, 1);
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  h['transfers:save'](null, {
    doc_number: 'نقل-1', doc_date: '2026-10-21',
    from_warehouse_id: mainWh, to_warehouse_id: soapWh,
    items: [{ item_id: id, quantity: 300, unit: 'علبة' }],
  }, 1);
  const main = h['reports:inventory'](null, { warehouseId: mainWh }).find(r => r.id === id);
  const soap = h['reports:inventory'](null, { warehouseId: soapWh }).find(r => r.id === id);
  assert.equal(main.qty_salem, 700);
  assert.equal(soap.qty_salem, 300);
  assert.equal(soap.balance_pieces, 300);
  // المجموع العام لا يتغير
  const all = h['reports:inventory'](null, {}).find(r => r.id === id);
  assert.equal(all.qty_salem, 1000);
});

test('ترحيل أعمدة السلة: بنود الخردة تالف ومرتجع البيع يرث سلة فاتورته', () => {
  const db = makeDb();
  for (const t of ['purchase_items', 'issue_items', 'receive_items', 'exit_items',
    'transfer_items', 'invoice_items', 'sales_return_items', 'purchase_return_items']) {
    db.exec(`ALTER TABLE ${t} DROP COLUMN bucket`);
  }
  db.prepare("INSERT INTO items (code, name, unit_name) VALUES ('901', 'علبة', 'حبة')").run();
  db.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي')").run();
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  db.prepare("INSERT INTO invoices (doc_number, doc_date, invoice_type) VALUES ('INV-1', '2026-10-25', 'sale')").run();
  db.prepare("INSERT INTO invoices (doc_number, doc_date, invoice_type) VALUES ('INV-2', '2026-10-25', 'scrap')").run();
  db.prepare(`INSERT INTO invoice_items (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (1, 1, ${wh}, 100, 'حبة', 100, 0.5)`).run();
  db.prepare(`INSERT INTO invoice_items (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (2, 1, ${wh}, 10, 'حبة', 10, 0.05)`).run();
  db.prepare("INSERT INTO sales_returns (doc_number, doc_date, invoice_id) VALUES ('R-1', '2026-10-25', 1)").run();
  db.prepare(`INSERT INTO sales_return_items (return_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg)
    VALUES (1, 1, ${wh}, 5, 'حبة', 5, 0.025)`).run();
  const { migrate } = require('../src/db');
  migrate(db);
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=1').get().bucket, 'salem');
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=2').get().bucket, 'talef');
  assert.equal(db.prepare('SELECT bucket FROM sales_return_items WHERE return_id=1').get().bucket, 'salem');
  assert.equal(db.prepare('SELECT bucket FROM purchase_items').all().length, 0);
});

test('applyBucketsDelta تجمّع دلتا كل سلة لصنف مكرر بنود بسلات مختلفة', () => {
  const db = makeDb();
  db.prepare("INSERT INTO items (code, name, unit_name) VALUES ('902', 'عبوة', 'حبة')").run();
  const { applyBucketsDelta } = require('../src/stock');
  applyBucketsDelta(db, [
    { item_id: 1, pieces: 10, bucket: 'salem' },
    { item_id: 1, pieces: 4, bucket: 'talef' },
    { item_id: 1, pieces: 2, bucket: 'talef' },
    { item_id: 1, pieces: 1, bucket: 'muharraz' },
  ], 1);
  const it = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it.qty_salem, 10);
  assert.equal(it.qty_talef, 6);
  assert.equal(it.qty_muharraz, 1);
  // عكس الإشارة يعيد العدادات للصفر
  applyBucketsDelta(db, [{ item_id: 1, pieces: 10, bucket: 'salem' }, { item_id: 1, pieces: 6, bucket: 'talef' }, { item_id: 1, pieces: 1, bucket: 'muharraz' }], -1);
  const it2 = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it2.qty_salem + it2.qty_talef + it2.qty_muharraz, 0);
});

test('فاتورة شراء بسلات مختلفة تزيد كل عداد سلة على حدة وتنعكس عند الإلغاء', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'purchases', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '601', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 0, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id: pid } = h['purchases:save'](null, {
    doc_number: 'ش-1', doc_date: '2026-10-25',
    items: [
      { item_id: id, warehouse_id: wh, quantity: 100, unit: 'حبة', unit_price: 10, bucket: 'salem' },
      { item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', unit_price: 0, bucket: 'talef' },
      { item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', unit_price: 0, bucket: 'muharraz' },
    ],
  }, 1);
  const inv = () => h['reports:inventory'](null, {}).find(r => r.id === id);
  assert.equal(inv().qty_salem, 100);
  assert.equal(inv().qty_talef, 30);
  assert.equal(inv().qty_muharraz, 5);
  const line = db.prepare('SELECT bucket FROM purchase_items WHERE purchase_id=? AND item_id=?').get(pid, id);
  assert.equal(line.bucket, 'salem');
  // إلغاء الفاتورة يعيد العدادات كلها للصفر
  h['purchases:void'](null, pid, 1);
  assert.equal(inv().qty_salem + inv().qty_talef + inv().qty_muharraz, 0);
});

test('صرف بند تالف يتجاوز الرصيد التالف يُرفض برسالة السلة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'issues');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '603', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 10, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'ص-1', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة', bucket: 'talef' }],
  }, 1), /غير كاف/);
  // صرف تالف ضمن المتاح ينجح ويخصم التالف فقط
  const { id: iid } = h['issues:save'](null, {
    doc_number: 'ص-2', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', bucket: 'talef' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 5);
  // عكس الأثر: إلغاء التصريح يعيد التالف
  h['issues:void'](null, iid, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=?').get(id).qty_talef, 10);
});

test('خروج بند محرز يتجاوز الرصيد المحرز يُرفض والمحرز المتاح يخصم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'exits');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '604', name: 'عبوة', unit_name: 'حبة', qty_salem: 50, qty_talef: 0, qty_muharraz: 20 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['exits:save'](null, {
    doc_number: 'خ-1', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', bucket: 'muharraz' }],
  }, 1), /غير كاف/);
  h['exits:save'](null, {
    doc_number: 'خ-2', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', bucket: 'muharraz' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 50);
  assert.equal(it.qty_muharraz, 10);
});
