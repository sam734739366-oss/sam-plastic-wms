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
  require('../src/handlers/parties')({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

test('parties:save requires name', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['parties:save'](null, { name: '  ', type: 'supplier' }, 1), /اسم الطرف مطلوب/);
});

test('parties:save rejects invalid type', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['parties:save'](null, { name: 'أحمد', type: 'x' }, 1), /نوع الطرف غير صالح/);
});

test('parties:save creates and lists with filter', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['parties:save'](null, { name: 'مورد أ', type: 'supplier', phone: '777' }, 1);
  h['parties:save'](null, { name: 'عميل ب', type: 'customer' }, 1);
  assert.equal(h['parties:list'](null).length, 2);
  assert.equal(h['parties:list'](null, 'customer').length, 1);
  assert.equal(h['parties:list'](null, 'customer')[0].name, 'عميل ب');
});

test('parties:delete blocked when linked to invoices', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['parties:save'](null, { name: 'عميل', type: 'customer' }, 1);
  db.prepare("INSERT INTO invoices (doc_number, doc_date, party_id) VALUES ('INV-1', '2026-10-18', ?)").run(id);
  assert.throws(() => h['parties:delete'](null, id, 1), /مرتبط/);
});

test('parties:delete works when free', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const { id } = h['parties:save'](null, { name: 'حر', type: 'both' }, 1);
  const r = h['parties:delete'](null, id, 1);
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM parties').get().c, 0);
});
