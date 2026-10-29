const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const dbmod = require('../src/db');

// v2: لا سلسلة ترحيل ALTER بين الإصدارات — قاعدة v1 تُؤرشف ويُبنى بديلها من schema.sql
// (يغطّيه tests/v2-core.test.js). ما يبقى من migrate() هو ترميم نفس الإصدار فقط:
// فهارس إضافية وتسوية عملة الإعدادات.

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');

function v2Db() {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

test('migrate يوحّد عملة الإعدادات على الرموز المعروفة ويُبقي الصحيح منها', () => {
  const d = v2Db();
  dbmod.seed(d);
  d.prepare("UPDATE settings SET value=? WHERE key='currency'").run('ريال يمني');
  dbmod.migrate(d);
  assert.equal(d.prepare("SELECT value FROM settings WHERE key='currency'").get().value, 'YER');
  // عمدة معروفة لا تُمسّ، والإعداد الفارغ لا يُخترع له بدل
  d.prepare("UPDATE settings SET value='SAR' WHERE key='currency'").run();
  dbmod.migrate(d);
  assert.equal(d.prepare("SELECT value FROM settings WHERE key='currency'").get().value, 'SAR');
  // قيمة معلّمة فارغة: تُسوّى على الافتراضية بدل أن تُترك مجهولة للواجهة
  d.prepare("UPDATE settings SET value=NULL WHERE key='currency'").run();
  dbmod.migrate(d);
  assert.equal(d.prepare("SELECT value FROM settings WHERE key='currency'").get().value, 'YER',
    'العملة الفارغة تُسوّى على الريال اليمني');
});

test('migrate مكرَّر الآمن: يبني فهارسه ولا يضيف ولا يمسح أي عمود', () => {
  const d = v2Db();
  dbmod.seed(d);
  d.prepare("INSERT INTO items (code, name, unit_name, qty_salem) VALUES ('001','عبوة','عبوة',10)").run();
  d.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, bucket)
    VALUES ('opening',1,'افتتاحي','2026-11-01',1,1,10,'salem')`).run();
  const colsBefore = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((t) => `${t.name}:${d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name).join(',')}`);
  dbmod.migrate(d);
  dbmod.migrate(d);
  const colsAfter = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((t) => `${t.name}:${d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name).join(',')}`);
  assert.deepEqual(colsAfter, colsBefore, 'لا ALTER ولا أعمدة حالة تُضاف عند إعادة التهيئة');
  for (const idx of ['idx_stock_date', 'idx_cartons_issue']) {
    assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?").get(idx).c, 1,
      `${idx} موجود بعد migrate`);
  }
  // البيانات والمخطط لا يتأثران بإعادة migrate
  assert.equal(d.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, 1);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM settings').get().c > 0, true);
});
