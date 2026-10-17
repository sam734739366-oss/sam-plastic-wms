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

test('items:save creates item with code prefix validation', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, {
    code: '001-001', name: 'امبول 5.02 وسط', item_group: 1, unit_name: 'امبولة',
    weight_grams: 5.02, pieces_per_carton: 12800
  }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.code, '001-001');
  assert.equal(row.weight_grams, 5.02);
  assert.equal(row.pieces_per_carton, 12800);
  const auditRow = db.prepare("SELECT action, entity FROM audit_log WHERE entity_id=?").get(id);
  assert.equal(auditRow.action, 'create');
});

test('items:save rejects wrong group prefix', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['items:save'](null, {
    code: '002-001', name: 'خطأ', item_group: 1
  }, 1), /يجب أن يبدأ بـ 001/);
});

test('items:save rejects duplicate code', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['items:save'](null, { code: '001-001', name: 'أ', item_group: 1 }, 1);
  assert.throws(() => h['items:save'](null, { code: '001-001', name: 'ب', item_group: 1 }, 1), /مكرر/);
});

test('items:save update keeps same code allowed', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '002-001', name: 'علبة', item_group: 2, pieces_per_bag: 250 }, 1);
  h['items:save'](null, { id, code: '002-001', name: 'علبة معدلة', item_group: 2, pieces_per_bag: 300 }, 1);
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row.name, 'علبة معدلة');
  assert.equal(row.pieces_per_bag, 300);
  const actions = db.prepare("SELECT action FROM audit_log WHERE entity='item' AND entity_id=?").all(id).map(r => r.action);
  assert.deepEqual(actions, ['create', 'update']);
});

test('items:delete blocked when stock moves exist', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['items:save'](null, { code: '003-001', name: 'خام للغير', item_group: 3 }, 1);
  db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن');
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces)
    VALUES ('receive', 1, 'R-1', '2026-10-18', ?, 1, 10)`).run(id);
  assert.throws(() => h['items:delete'](null, id, 1), /حركات مخزون/);
});

test('items:import inserts and skips duplicates', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const rows = [
    { code: '001-007', name: 'امبول العمانية', item_group: 1, weight_grams: 5.02 },
    { code: '001-008', name: 'امبول الكوسفن', item_group: 1, weight_grams: 5.02 },
    { code: '001-007', name: 'مكرر', item_group: 1 }
  ];
  const r = h['items:import'](null, rows, 1);
  assert.equal(r.imported, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, 2);
});
