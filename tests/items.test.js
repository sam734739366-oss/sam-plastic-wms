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

test('items:save rejects unit outside the four allowed units', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['items:save'](null, { code: '103', name: 'خطأ', unit_name: 'امبولة' }, 1), /الوحدة يجب أن تكون/);
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
