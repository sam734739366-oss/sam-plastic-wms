const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb, seed, SCHEMA_VERSION } = require('../src/db');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

test('إنشاء مستخدمي مخازن وإدخال عام وعرض فقط وتخزين أدوارهم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['users']);
  h['users:save'](null, { username: 'store1', full_name: 'أمين المخزن', password: '123', role: 'warehouse' }, 1);
  h['users:save'](null, { username: 'clerk1', full_name: 'مدخل بيانات', password: '123', role: 'clerk' }, 1);
  h['users:save'](null, { username: 'view1', full_name: 'مشاهد', password: '123', role: 'viewer' }, 1);
  const rows = h['users:list']();
  assert.equal(rows.find(r => r.username === 'store1').role, 'warehouse');
  assert.equal(rows.find(r => r.username === 'clerk1').role, 'clerk');
  assert.equal(rows.find(r => r.username === 'view1').role, 'viewer');
});

test('تعديل دور مستخدم قائم إلى دور جديد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['users']);
  const { id } = h['users:save'](null, { username: 'w1', full_name: 'أمين', password: '123', role: 'clerk' }, 1);
  h['users:save'](null, { id, username: 'w1', full_name: 'أمين', role: 'warehouse' }, 1);
  assert.equal(h['users:list']().find(r => r.id === id).role, 'warehouse');
});

test('الأدوار الملغاة (حسابات/مبيعات) وأي دور غير معروف تُرفض برسالة واضحة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['users']);
  assert.throws(() => h['users:save'](null, { username: 'x1', full_name: 'X', password: '123', role: 'admin' }, 1),
    /دور المستخدم غير معروف/);
  assert.throws(() => h['users:save'](null, { username: 'x2', full_name: 'X', password: '123', role: 'accounts' }, 1),
    /دور المستخدم غير معروف/);
  assert.throws(() => h['users:save'](null, { username: 'x3', full_name: 'X', password: '123', role: 'sales' }, 1),
    /دور المستخدم غير معروف/);
});

test('قيد الأدوار في مخطط v2 يقبل الأربعة ويرفض الملغاة على مستوى القاعدة', () => {
  const d = makeDb();
  const add = (u, role) => d.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)')
    .run(u, u, 'x', role);
  for (const role of ['manager', 'clerk', 'viewer', 'warehouse']) add(`u-${role}`, role);
  assert.deepEqual(d.prepare('SELECT username, role FROM users WHERE username LIKE \'u-%\' ORDER BY username').all()
    .map((r) => `${r.username}:${r.role}`),
    ['u-clerk:clerk', 'u-manager:manager', 'u-viewer:viewer', 'u-warehouse:warehouse']);
  // الأدوار الملغاة أو المجهولة يرفضها القيد نفسه — لا ترحيل لقاعدة قديمة يحملها
  for (const role of ['admin', 'accounts', 'sales', '']) {
    assert.throws(() => add(`bad-${role || 'empty'}`, role), /CHECK constraint failed/, `دور مرفوض: ${role}`);
  }
});

test('تهيئة قاعدة v2 (seed) تُبقي مستخدميها بأدوارهم وتكتب إصدار المخطط المانع للأرشفة', () => {
  const d = makeDb();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('old','قديم','x','clerk')").run();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('store','أمين','x','warehouse')").run();
  // تهيئة الإقلاع على قاعدة v2: لا إعادة تسمية أدوار ولا فقد مستخدم — الترحيل انتهى
  seed(d);
  seed(d);
  const users = d.prepare('SELECT username, role FROM users ORDER BY id').all();
  assert.deepEqual(users.map((u) => `${u.username}:${u.role}`),
    ['admin:manager', 'old:clerk', 'store:warehouse'], 'المستخدمون بأدوارهم كما كانوا');
  // المفتاح الذي يميّز قاعدة v2: وجوده يمنع أرشفة القاعدة عند الإقلاع التالي
  assert.equal(d.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
  assert.equal(d.prepare('SELECT COUNT(*) c FROM warehouses').get().c, 1, 'مخزن واحد افتراضي');
  assert.equal(d.prepare("SELECT COUNT(*) c FROM shifts WHERE name IN ('صباحية','مسائية')").get().c, 2);
});
