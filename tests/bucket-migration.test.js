const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/db');

// محاكاة قاعدة بيانات قديمة قبل عمود bucket في stock_moves،
// ببيانات مطابقة لما حدث في قاعدة البيانات الحية:
// صنفان لهما عمليات (شراء/صرف/بيع) وعدادات في جدول الأصناف تشمل أثر تلك العمليات.
function makePreBucketDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, full_name TEXT, password_hash TEXT, role TEXT);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, location TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT, item_group INTEGER, unit_name TEXT, weight_grams REAL, pieces_per_carton INTEGER, pieces_per_shadda INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, invoice_type TEXT DEFAULT 'sale', notes TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT UNIQUE, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, notes TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','المدير','x','manager')").run();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('المخزن الرئيسي');
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag, qty_salem, qty_talef, qty_muharraz) VALUES ('001001','امبول 20.5 وسط',2,'امبول',20.5,12852,NULL,244188,50,100)").run();
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag, qty_salem, qty_talef, qty_muharraz) VALUES ('002001','علبة الخطيب 500مل',2,'علبة',20,250,9500,100,100)").run();
  d.prepare("INSERT INTO invoices (doc_number, doc_date, invoice_type, status) VALUES ('1','2026-10-21','sale','active')").run();
  // صفوف الافتتاح القديمة (صف واحد لكل صنف = مجموع السلات وقت الإنشاء)
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces) VALUES ('opening',1,'افتتاحي-001001','2026-10-21',1,1,128720)").run();
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces) VALUES ('opening',2,'افتتاحي-002001','2026-10-21',2,1,10200)").run();
  // عمليات الصنف 1: شراء 128520 + صرف 25704 (تعديل بعكس 25704 ثم صرف 25704) + شراء 12852
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces) VALUES ('purchase',1,'1','2026-10-21',1,1,128520)").run();
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_out_pieces) VALUES ('issue',1,'1','2026-10-20',1,1,25704)").run();
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces) VALUES ('issue',1,'1','2026-10-20',1,1,25704)").run();
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_out_pieces) VALUES ('issue',1,'1','2026-10-20',1,1,25704)").run();
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces) VALUES ('purchase',2,'2','2026-10-22',1,1,12852)").run();
  // عملية الصنف 2: فاتورة بيع 500 حبة
  d.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_out_pieces) VALUES ('invoice',1,'1','2026-10-21',2,1,500)").run();
  d.prepare("INSERT INTO settings (key, value) VALUES ('currency','YER')").run();
  return d;
}

function bucketSums(d, itemId) {
  return d.prepare(`SELECT bucket, COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
    FROM stock_moves WHERE item_id=? GROUP BY bucket`).all(itemId);
}

test('ترحيل قاعدة بلا عمود bucket: الافتتاح = العداد − صافي العمليات (لا مضاعفة لأثر العمليات)', () => {
  const d = makePreBucketDb();
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);
  // كل الحركات لها سلة بعد الترحيل
  const nullBuckets = d.prepare('SELECT COUNT(*) c FROM stock_moves WHERE bucket IS NULL').get().c;
  assert.equal(nullBuckets, 0, 'كل الحركات يجب أن تحمل سلة بعد الترحيل');
  // افتتاح سليم للصنف 1 = العداد 244188 − صافي العمليات (128520+12852) = 128520
  const open1 = d.prepare("SELECT * FROM stock_moves WHERE doc_type='opening' AND item_id=1 AND bucket='salem'").get();
  assert.ok(open1, 'صف افتتاح سليم للصنف 1');
  assert.equal(open1.qty_in_pieces, 128520, 'الافتتاح يجب ألا يشمل أثر الشراء والصرف');
  assert.ok(Math.abs(open1.weight_in_kg - (128520 * 20.5) / 1000) < 0.01, 'وزن الافتتاح متناسب مع الكمية');
  // افتتاح سليم للصنف 2 = 9500 − (−500) = 10000 (الفاتورة لم تكن جزءاً من الافتتاح)
  const open5 = d.prepare("SELECT * FROM stock_moves WHERE doc_type='opening' AND item_id=2 AND bucket='salem'").get();
  assert.ok(open5, 'صف افتتاح سليم للصنف 2');
  assert.equal(open5.qty_in_pieces, 10000, 'افتتاح الصنف 2 يستعيد الـ500 المباعة');
  // سلات تالف/محرز بدون عمليات: الافتتاح = العداد
  assert.equal(d.prepare("SELECT qty_in_pieces FROM stock_moves WHERE doc_type='opening' AND item_id=1 AND bucket='talef'").get().qty_in_pieces, 50);
  assert.equal(d.prepare("SELECT qty_in_pieces FROM stock_moves WHERE doc_type='opening' AND item_id=1 AND bucket='muharraz'").get().qty_in_pieces, 100);
  // مجموع حركات كل سلة = عداد السلة (اتساق الجرد مع العداد)
  const s1 = bucketSums(d, 1);
  assert.equal(s1.find(r => r.bucket === 'salem').net, 244188, 'مجموع حركات سليم الصنف 1 = العداد');
  assert.equal(s1.find(r => r.bucket === 'talef').net, 50);
  assert.equal(s1.find(r => r.bucket === 'muharraz').net, 100);
  const s5 = bucketSums(d, 2);
  assert.equal(s5.find(r => r.bucket === 'salem').net, 9500, 'مجموع حركات سليم الصنف 2 = العداد');
});
