const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/db');
const ledger = require('../src/ledger');

// محاكاة قاعدة بيانات قديمة (قبل نظام النقد/الآجل) ثم ترحيلها
function makeOldDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, full_name TEXT, password_hash TEXT, role TEXT);
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, location TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, item_group INTEGER, unit_name TEXT, weight_grams REAL, pieces_per_carton INTEGER, pieces_per_shadda INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, invoice_type TEXT DEFAULT 'sale', driver_name TEXT, car_number TEXT, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, bucket TEXT, notes TEXT);
    CREATE TABLE scrap_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, item_id INTEGER, disposition TEXT, warehouse_id INTEGER, party_id INTEGER, pieces INTEGER, weight_kg REAL, price REAL, notes TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cartons (id INTEGER PRIMARY KEY AUTOINCREMENT, carton_number TEXT UNIQUE, item_id INTEGER, purchase_id INTEGER, pieces INTEGER, status TEXT DEFAULT 'in_stock', issue_date TEXT, issue_permit_id INTEGER, notes TEXT);
    CREATE TABLE receive_permits (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, machine_id INTEGER, shift_id INTEGER, source TEXT DEFAULT 'own', party_id INTEGER, receiver_name TEXT, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE receive_items (id INTEGER PRIMARY KEY AUTOINCREMENT, receive_permit_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
  `);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name) VALUES (?,?,?,?)').run('001', 'عبوة 1 لتر', 2, 'عبوة');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل قديم', 'customer');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد قديم', 'supplier');
  d.prepare("INSERT INTO purchases (doc_number, doc_date, party_id, status) VALUES ('P-9','2026-01-01',2,'active')").run();
  d.prepare("INSERT INTO purchase_items (purchase_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, total_price) VALUES (1,1,1,100,'حبة',100,0,5000)").run();
  d.prepare("INSERT INTO invoices (doc_number, doc_date, party_id, status) VALUES ('9','2026-01-02',1,'active')").run();
  d.prepare("INSERT INTO invoice_items (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, total_price) VALUES (1,1,1,50,'حبة',50,0,3000)").run();
  d.prepare("INSERT INTO settings (key, value) VALUES ('currency','YER')").run();
  return d;
}

test('ترحيل قاعدة قديمة: أعمدة الدفع + ترحيل الفواتير كآجلة دون فقدان البيانات', () => {
  const d = makeOldDb();
  // schema.sql ينشئ الجداول الجديدة فقط (القديمة موجودة) ثم migrate يضيف الأعمدة
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);
  const invCols = d.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  const purCols = d.prepare('PRAGMA table_info(purchases)').all().map(c => c.name);
  const recvCols = d.prepare('PRAGMA table_info(receive_permits)').all().map(c => c.name);
  assert.ok(invCols.includes('payment_method'));
  assert.ok(purCols.includes('payment_method'));
  // ربط الاستلام بتصريح الصرف (دورة الكراتين) يُضاف للقواعد القديمة
  assert.ok(recvCols.includes('issue_permit_id'));
  // البيانات القديمة باقية
  assert.equal(d.prepare('SELECT COUNT(*) c FROM purchases').get().c, 1);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM invoices').get().c, 1);
  assert.equal(d.prepare('SELECT payment_method FROM invoices WHERE id=1').get().payment_method, 'credit');
  // ترحيل الدفتر: فاتورة البيع القديمة ذمة على العميل، والشراء ذمة للمورد
  const rows = d.prepare('SELECT * FROM party_ledger ORDER BY id').all();
  assert.equal(rows.length, 2);
  const invRow = rows.find(r => r.doc_type === 'invoice');
  const purRow = rows.find(r => r.doc_type === 'purchase');
  assert.equal(invRow.side, 'debit');
  assert.equal(invRow.amount, 3000);
  assert.equal(purRow.side, 'credit');
  assert.equal(purRow.amount, 5000);
  assert.equal(ledger.partyBalance(d, 1), 3000);
  assert.equal(ledger.partyBalance(d, 2), -5000);
  assert.equal(ledger.cashBalance(d), 0);
});
