const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb, migrate } = require('../src/db');

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

test('ترحيل قاعدة قديمة بقيد الأدوار القديم: يوسع الأدوار ويحافظ على المستخدمين', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, full_name TEXT, password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer')), created_at TEXT);
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, location TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, item_group INTEGER, unit_name TEXT, weight_grams REAL, pieces_per_carton INTEGER, pieces_per_shadda INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, invoice_type TEXT DEFAULT 'sale', notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, bucket TEXT, notes TEXT);
    CREATE TABLE scrap_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, item_id INTEGER, disposition TEXT, warehouse_id INTEGER, party_id INTEGER, pieces INTEGER, weight_kg REAL, price REAL, notes TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('old','قديم','x','clerk')").run();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);
  // المستخدمون القدامى باقون بأدوارهم
  assert.equal(d.prepare("SELECT COUNT(*) c FROM users").get().c, 2);
  assert.equal(d.prepare("SELECT role FROM users WHERE username='old'").get().role, 'clerk');
  // الدور الجديد أصبح مقبولاً بعد الترحيل
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('store2','مخازن','x','warehouse')").run();
  assert.equal(d.prepare("SELECT role FROM users WHERE username='store2'").get().role, 'warehouse');
  // والقيد الجديد يرفض ما ليس دوراً معروفاً
  assert.throws(() => d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('bad','سيئ','x','admin')").run());
});

test('ترحيل قاعدة بدورَي حسابات ومبيعات: يتحول أصحابهما إلى إدخال عام ويُسقط الدوران من القيد', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, full_name TEXT, password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer','warehouse','accounts','sales')), created_at TEXT);
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, location TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, item_group INTEGER, unit_name TEXT, weight_grams REAL, pieces_per_carton INTEGER, pieces_per_shadda INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, invoice_type TEXT DEFAULT 'sale', notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, bucket TEXT, notes TEXT);
    CREATE TABLE scrap_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, item_id INTEGER, disposition TEXT, warehouse_id INTEGER, party_id INTEGER, pieces INTEGER, weight_kg REAL, price REAL, notes TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('acc','محاسب','x','accounts')").run();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('sell','مندوب','x','sales')").run();
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('store','أمين','x','warehouse')").run();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);
  // أصحاب الدورين الملغيين صاروا إدخال عام، والبقية على أدوارهم
  assert.equal(d.prepare("SELECT role FROM users WHERE username='acc'").get().role, 'clerk');
  assert.equal(d.prepare("SELECT role FROM users WHERE username='sell'").get().role, 'clerk');
  assert.equal(d.prepare("SELECT role FROM users WHERE username='store'").get().role, 'warehouse');
  assert.equal(d.prepare("SELECT role FROM users WHERE username='admin'").get().role, 'manager');
  // القيد الجديد يرفض الدورين الملغيين
  assert.throws(() => d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('a2','X','x','accounts')").run());
  assert.throws(() => d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('s2','X','x','sales')").run());
});
