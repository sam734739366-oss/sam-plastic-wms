const test = require('node:test');
const assert = require('node:assert');
const { toPieces, piecesToWeightKg, formatQty } = require('../src/units');

test('toPieces: piece', () => assert.equal(toPieces(10, 'piece', {}), 10));
test('toPieces: carton uses pieces_per_carton', () =>
  assert.equal(toPieces(2, 'carton', { pieces_per_carton: 12800 }), 25600));
test('toPieces: bag uses pieces_per_bag', () =>
  assert.equal(toPieces(3, 'bag', { pieces_per_bag: 250 }), 750));
test('toPieces: kg from weight_grams', () =>
  assert.equal(toPieces(5.02, 'kg', { weight_grams: 5.02 }), 1000));
test('toPieces: ton', () =>
  assert.equal(toPieces(0.023, 'ton', { weight_grams: 23 }), 1000));
test('toPieces: box with piecesPerBox', () =>
  assert.equal(toPieces(4, 'box', {}, 300), 1200));
test('piecesToWeightKg', () =>
  assert.equal(piecesToWeightKg(1000, 5.02), 5.02));
test('formatQty: carton-capable item', () => {
  const s = formatQty(25600, { pieces_per_carton: 12800, weight_grams: 5.02, unit_name: 'حبة' });
  assert.ok(s.includes('2') && s.includes('كرتون') && s.includes('25,600'));
});
test('formatQty: bag item', () => {
  const s = formatQty(750, { pieces_per_bag: 250, unit_name: 'علبة' });
  assert.ok(s.includes('3') && s.includes('كيس'));
});
