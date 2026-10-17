const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { writeMoves, voidDoc, getBalance } = require('../src/stock');

function memDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن 1');
  d.prepare('INSERT INTO items (code,name,item_group,unit_name,weight_grams) VALUES (?,?,?,?,?)')
    .run('T-1', 'تجريبي', 2, 'علبة', 10);
  d.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)')
    .run('tester', 'مختبر', 'x', 'manager');
  return d;
}

test('writeMoves then balance', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18', [
    { item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }
  ], 1);
  const b = getBalance(d, 1, 1);
  assert.equal(b.balance_pieces, 1000);
  assert.equal(b.balance_kg, 10);
});

test('edit doc rewrites moves via reversal', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }], 1);
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 400, weight_in_kg: 4 }], 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 400);
});

test('voidDoc reverses everything', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }], 1);
  voidDoc(d, 'receive', 1, 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 0);
});
