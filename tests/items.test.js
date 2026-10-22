const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return d;
}

function stubIpc() {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  require('../src/handlers/items')(ipc);
  return handlers;
}

test('items:save creates item with numeric code, unit, weight and quantities', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, {
    code: '101', name: 'علبة شامبو 500مل', unit_name: 'علبة',
    weight_grams: 26.5, pieces_per_carton: 400, pieces_per_shadda: 20,
    qty_salem: 5000, qty_talef: 120, qty_muharraz: 300
  }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.code, '101');
  assert.equal(row.name, 'علبة شامبو 500مل');
  assert.equal(row.unit_name, 'علبة');
  assert.equal(row.weight_grams, 26.5);
  assert.equal(row.pieces_per_carton, 400);
  assert.equal(row.pieces_per_shadda, 20);
  assert.equal(row.qty_salem, 5000);
  assert.equal(row.qty_talef, 120);
  assert.equal(row.qty_muharraz, 300);
  const auditRow = db.prepare("SELECT action, entity FROM audit_log WHERE entity_id=?").get(id);
  assert.equal(auditRow.action, 'create');
});

test('items:save normalizes Arabic-Indic digits in code', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '١٠٢', name: 'غطاء', unit_name: 'غطاء' }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.code, '102');
});

test('items:save rejects non-numeric code', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['items:save'](null, { code: 'A12', name: 'خطأ' }, 1), /أرقامًا فقط/);
  assert.throws(() => h['items:save'](null, { code: '12-3', name: 'خطأ' }, 1), /أرقامًا فقط/);
  assert.throws(() => h['items:save'](null, { code: '', name: 'خطأ' }, 1), /كود الصنف مطلوب/);
});

test('items:save rejects unit outside the six allowed units', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['items:save'](null, { code: '103', name: 'خطأ', unit_name: 'بالة' }, 1), /الوحدة يجب أن تكون/);
});

test('items:save accepts carton as a unit', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '108', name: 'علب مشروب', unit_name: 'كرتون' }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.unit_name, 'كرتون');
});

test('items:save accepts ampoule as a unit', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '109', name: 'امبول ماء مقطر', unit_name: 'امبول', weight_grams: 5.02 }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.unit_name, 'امبول');
});

test('items:save rejects duplicate code', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['items:save'](null, { code: '101', name: 'أ', unit_name: 'حبة' }, 1);
  assert.throws(() => h['items:save'](null, { code: '101', name: 'ب', unit_name: 'حبة' }, 1), /مكرر/);
});

test('items:save update keeps code and updates new fields', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '104', name: 'كيس نفايات', unit_name: 'كيس', pieces_per_bag: 250 }, 1);
  h['items:save'](null, { id, code: '104', name: 'كيس نفايات كبير', unit_name: 'كيس', pieces_per_bag: 300, qty_salem: 9000 }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.name, 'كيس نفايات كبير');
  assert.equal(row.pieces_per_bag, 300);
  assert.equal(row.qty_salem, 9000);
  const actions = db.prepare("SELECT action FROM audit_log WHERE entity='item' AND entity_id=?").all(id).map(r => r.action);
  assert.deepEqual(actions, ['create', 'update']);
});

test('items:list returns has_moves flag', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '110', name: 'علبة ماء', unit_name: 'علبة', qty_salem: 50 }, 1);
  let rows = h['items:list']();
  assert.equal(rows.find(r => r.id === id).has_moves, 0);
  db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن');
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces)
    VALUES ('receive', 1, 'R-1', '2026-10-18', ?, 1, 10)`).run(id);
  rows = h['items:list']();
  assert.equal(rows.find(r => r.id === id).has_moves, 1);
});

test('items:save update ignores qty fields when item has stock moves', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '111', name: 'علبة زيت', unit_name: 'علبة', qty_salem: 100, qty_talef: 5, qty_muharraz: 0 }, 1);
  db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن');
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces)
    VALUES ('receive', 1, 'R-1', '2026-10-18', ?, 1, 10)`).run(id);
  h['items:save'](null, { id, code: '111', name: 'علبة زيت محسن', unit_name: 'علبة', qty_salem: 999, qty_talef: 999, qty_muharraz: 999 }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.name, 'علبة زيت محسن');
  assert.equal(row.qty_salem, 100); // الأرصدة تُحفظ من الحركات فقط
  assert.equal(row.qty_talef, 5);
  assert.equal(row.qty_muharraz, 0);
});

test('items:list returns all items without group filtering', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['items:save'](null, { code: '105', name: 'علبة زيت', unit_name: 'علبة' }, 1);
  h['items:save'](null, { code: '106', name: 'حبة غطاء', unit_name: 'غطاء' }, 1);
  const rows = h['items:list'](null, 2); // معامل المجموعة القديم يُتجاهل
  assert.equal(rows.length, 2);
});

test('items:delete blocked when stock moves exist', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '107', name: 'علبة ماء', unit_name: 'علبة' }, 1);
  db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن');
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces)
    VALUES ('receive', 1, 'R-1', '2026-10-18', ?, 1, 10)`).run(id);
  assert.throws(() => h['items:delete'](null, id, 1), /حركات مخزون/);
});

test('items:import inserts valid rows and skips invalid or duplicate ones', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const rows = [
    { code: '201', name: 'امبولة 5مل', unit_name: 'حبة', weight_grams: 5.02, qty_salem: 100 },
    { code: '202', name: 'غطاء 28', unit_name: 'غطاء', pieces_per_bag: 500, qty_muharraz: 50 },
    { code: 'AB', name: 'كود غير صالح' },
    { code: '201', name: 'مكرر', unit_name: 'حبة' },
  ];
  const r = h['items:import'](null, rows, 1);
  assert.equal(r.imported, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, 2);
  const imported = db.prepare('SELECT * FROM items WHERE code=?').get('202');
  assert.equal(imported.unit_name, 'غطاء');
  assert.equal(imported.pieces_per_bag, 500);
  assert.equal(imported.qty_muharraz, 50);
});

test('items:save writes opening stock moves per bucket when a warehouse exists', () => {
  const db = makeDb(); setDb(db);
  db.prepare('INSERT INTO warehouses (name, location) VALUES (?,?)').run('المخزن الرئيسي', 'داخل المصنع');
  const h = stubIpc();
  const { id } = h['items:save'](null, {
    code: '301', name: 'علبة ماء', unit_name: 'علبة', weight_grams: 10,
    qty_salem: 5000, qty_talef: 100, qty_muharraz: 50,
  }, 1);
  const rows = db.prepare("SELECT * FROM stock_moves WHERE doc_type='opening' AND doc_id=?").all(id);
  assert.equal(rows.length, 3);
  const byBucket = Object.fromEntries(rows.map(r => [r.bucket, r.qty_in_pieces]));
  assert.deepEqual(byBucket, { salem: 5000, talef: 100, muharraz: 50 });
  assert.equal(rows[0].weight_in_kg, 50); // 5000 × 10جم / 1000
  assert.equal(rows[0].warehouse_id, 1);
  const listed = h['items:list']().find(r => r.id === id);
  assert.equal(listed.has_moves, 0); // الحركة الافتتاحية لا تقفل تعديل الأرصدة
});

test('items:save update refreshes the opening move without duplicates', () => {
  const db = makeDb(); setDb(db);
  db.prepare('INSERT INTO warehouses (name, location) VALUES (?,?)').run('المخزن الرئيسي', 'داخل المصنع');
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '302', name: 'غطاء', unit_name: 'غطاء', qty_salem: 100 }, 1);
  h['items:save'](null, { id, code: '302', name: 'غطاء محسن', unit_name: 'غطاء', qty_salem: 250 }, 1);
  const rows = db.prepare("SELECT * FROM stock_moves WHERE doc_type='opening' AND doc_id=?").all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty_in_pieces, 250);
  assert.equal(rows[0].bucket, 'salem');
});

test('items:delete allows deleting an item with only opening moves and removes them', () => {
  const db = makeDb(); setDb(db);
  db.prepare('INSERT INTO warehouses (name, location) VALUES (?,?)').run('المخزن الرئيسي', 'داخل المصنع');
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '303', name: 'امبول', unit_name: 'امبول', qty_salem: 10 }, 1);
  const r = h['items:delete'](null, id, 1);
  assert.ok(r.ok);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='opening'").get().c, 0);
});

test('items:import writes opening moves for imported quantities', () => {
  const db = makeDb(); setDb(db);
  db.prepare('INSERT INTO warehouses (name, location) VALUES (?,?)').run('المخزن الرئيسي', 'داخل المصنع');
  const h = stubIpc();
  h['items:import'](null, [{ code: '304', name: 'كيس', unit_name: 'كيس', qty_salem: 300 }], 1);
  const it = db.prepare('SELECT * FROM items WHERE code=?').get('304');
  const m = db.prepare("SELECT * FROM stock_moves WHERE doc_type='opening' AND doc_id=?").get(it.id);
  assert.ok(m, 'يجب إنشاء حركة افتتاحية للصنف المستورد');
  assert.equal(m.qty_in_pieces, 300);
});
