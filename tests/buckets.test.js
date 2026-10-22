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
