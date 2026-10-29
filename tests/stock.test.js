const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { writeMoves, getBalance, applyBucketsDelta, deleteDocStock } = require('../src/stock');

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

const line = (qtyIn) => [{ item_id: 1, warehouse_id: 1, qty_in_pieces: qtyIn, weight_in_kg: qtyIn / 100, bucket: 'salem' }];

test('writeMoves then balance', () => {
  const d = memDb();
  writeMoves(d, 'production', 1, 'PR-1', '2026-10-18', line(1000), 1);
  const b = getBalance(d, 1, 1);
  assert.equal(b.balance_pieces, 1000);
  assert.equal(b.balance_kg, 10);
});

test('edit doc rewrites moves via reversal', () => {
  const d = memDb();
  writeMoves(d, 'production', 1, 'PR-1', '2026-10-18', line(1000), 1);
  writeMoves(d, 'production', 1, 'PR-1', '2026-10-18', line(400), 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 400);
  // الأثر الصافي للحركات يبقى هو المرجع: صف عكس + صف جديد
  assert.equal(d.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production' AND doc_id=1").get().c, 3);
});

test('deleteDocStock يردّ العدّادات ويمحو الحركات فعلاً (لا حالة «ملغى»)', () => {
  const d = memDb();
  const rows = line(1000);
  writeMoves(d, 'production', 1, 'PR-1', '2026-10-18', rows, 1);
  applyBucketsDelta(d, rows, 1);
  assert.equal(d.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 1000);
  const r = deleteDocStock(d, 'production', 1, 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 0, 'الحركات مُحصيّاً صافي الصفر');
  assert.equal(d.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production' AND doc_id=1").get().c, 0,
    'الصفوف مُمحية لا معلَّمة');
  assert.equal(d.prepare('SELECT qty_salem FROM items WHERE id=1').get().qty_salem, 0, 'العدّاد رُدّ');
  assert.equal(r.removed_moves, 1);
  assert.deepEqual(r.reverted.map((x) => [x.bucket, x.net]), [['salem', 1000]], 'الأثر المعروض للعكس هو صافي الحركات');
});
