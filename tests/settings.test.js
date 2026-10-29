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
  require('../src/handlers/settings')(ipc);
  return handlers;
}

test('settings:get returns map with default currency YER', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  const s = h['settings:get']();
  assert.equal(s.currency, 'YER');
});

test('settings:save persists values and keeps currency code', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['settings:save'](null, { currency: 'SAR', factory_name: 'سام', doc_page_size: 'A4' }, 1);
  const s = h['settings:get']();
  assert.equal(s.currency, 'SAR');
  assert.equal(s.factory_name, 'سام');
  assert.equal(s.doc_page_size, 'A4');
});

test('settings:save rejects unknown currency', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  assert.throws(() => h['settings:save'](null, { currency: 'EUR' }, 1), /العملة المختارة غير معروفة/);
});

test('settings:get normalizes legacy currency value to YER', () => {
  const db = makeDb(); setDb(db);
  db.prepare("UPDATE settings SET value='ريال يمني' WHERE key='currency'").run();
  const h = stubIpc();
  const s = h['settings:get']();
  assert.equal(s.currency, 'YER');
});

test('حفظ الإعدادات لا يمسح المفاتيح البرمجية التي لا تعرفها الشاشة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  db.prepare("INSERT INTO settings (key,value) VALUES ('feature_flag','x-on')").run();
  h['settings:save'](null, {
    factory_name: 'سام بلاستيك', factory_phone: '775158678', factory_address: '', cloud_folder: '',
    currency: 'YER', doc_page_size: 'A5', report_page_size: 'A4',
    footer_right: '', footer_center: 'شكراً', footer_left: '',
  }, 1);
  const after = h['settings:get']();
  assert.equal(after.feature_flag, 'x-on', 'مفتاح برمجي لم تمرّره الواجهة يجب أن يبقى');
  assert.equal(after.factory_phone, '775158678');
  assert.equal(after.footer_center, 'شكراً');
});

test('مفتاح واجهة أسقطته الشاشة يُحذف، وقيمة فارغة تبقى محفوظة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc();
  h['settings:save'](null, { factory_name: 'أ', footer_center: 'وسيط' }, 1);
  h['settings:save'](null, { factory_name: 'أ' }, 1);
  const after = h['settings:get']();
  assert.equal('footer_center' in after, false, 'footer_* من مفاتيح الواجهة، وإسقاطه من الحفظ يعني حذفه');
});
