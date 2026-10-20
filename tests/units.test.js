const test = require('node:test');
const assert = require('node:assert');
const { toPieces, unitOptions, piecesToWeightKg, formatQty } = require('../src/units');
const { fmtMoney, currencyOf } = require('../src/currency');

test('toPieces: base unit = pieces', () => {
  assert.equal(toPieces(10, 'علبة', { unit_name: 'علبة' }), 10);
  assert.equal(toPieces(7, 'امبول', { unit_name: 'امبول' }), 7);
});

test('toPieces: كرتون uses pieces_per_carton', () => {
  assert.equal(toPieces(2, 'كرتون', { unit_name: 'امبول', pieces_per_carton: 12800 }), 25600);
});

test('toPieces: شدة uses pieces_per_shadda', () => {
  assert.equal(toPieces(3, 'شدة', { unit_name: 'علبة', pieces_per_shadda: 500 }), 1500);
});

test('toPieces: كيس uses pieces_per_bag', () => {
  assert.equal(toPieces(4, 'كيس', { unit_name: 'علبة', pieces_per_bag: 250 }), 1000);
});

test('toPieces: كجم from weight_grams', () => {
  assert.equal(toPieces(5.02, 'كجم', { unit_name: 'امبول', weight_grams: 5.02 }), 1000);
});

test('toPieces: طن from weight_grams', () => {
  assert.equal(toPieces(0.023, 'طن', { unit_name: 'امبول', weight_grams: 23 }), 1000);
});

test('toPieces: unit_name wins over pack unit', () => {
  assert.equal(toPieces(5, 'كيس', { unit_name: 'كيس', pieces_per_bag: 100 }), 5);
});

test('toPieces: throws without pack size', () => {
  assert.throws(() => toPieces(2, 'كرتون', { unit_name: 'علبة' }), /عدد حبات في الكرتون/);
  assert.throws(() => toPieces(2, 'كجم', { unit_name: 'علبة' }), /وزن جرام/);
  assert.throws(() => toPieces(1, 'بالة', { unit_name: 'علبة' }), /وحدة غير معروفة/);
});

test('unitOptions: base + packs + weight', () => {
  const opts = unitOptions({ unit_name: 'امبول', pieces_per_carton: 12800, weight_grams: 5.02 });
  const values = opts.map(o => o.value);
  assert.deepEqual(values, ['امبول', 'كرتون', 'كجم', 'طن']);
  const opts2 = unitOptions({ unit_name: 'علبة', pieces_per_shadda: 500, pieces_per_bag: 250 });
  assert.deepEqual(opts2.map(o => o.value), ['علبة', 'شدة', 'كيس']);
});

test('piecesToWeightKg', () => {
  assert.equal(piecesToWeightKg(1000, 5.02), 5.02);
});

test('formatQty includes derived units', () => {
  const s = formatQty(25600, { unit_name: 'امبول', pieces_per_carton: 12800, weight_grams: 5.02 });
  assert.ok(s.includes('2 كرتون'));
  assert.ok(s.includes('25,600 امبول'));
  const s2 = formatQty(1500, { unit_name: 'علبة', pieces_per_shadda: 500 });
  assert.ok(s2.includes('3 شدة'));
});

test('currency: fmtMoney formats with symbol', () => {
  assert.equal(fmtMoney(1234.5, 'YER'), '1,234.5 ر.ي');
  assert.equal(fmtMoney(99, 'SAR'), '99 ر.س');
  assert.equal(fmtMoney(10, 'USD'), '10 $');
  assert.equal(fmtMoney(10, 'XXX'), '10 ر.ي'); // الافتراضي ريال يمني
});

test('currency: currencyOf defaults to YER', () => {
  assert.equal(currencyOf('SAR').name, 'ريال سعودي');
  assert.equal(currencyOf('nope').code, 'YER');
});
