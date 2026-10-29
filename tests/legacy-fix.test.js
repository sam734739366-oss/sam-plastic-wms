const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const legacy = require('../src/legacyFix');

// صنف 1 إنتاج تام مربوط بأكياس (صنف 3) — وزنه 25 جراماً
function makeDb({ migrate = true } = {}) {
  const d = new DatabaseSync(':memory:');
  if (!migrate) {
    // قاعدة لم تُرحَّل: cartons بلا source/party_id
    d.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, code TEXT, name TEXT, item_group INTEGER DEFAULT 2, unit_name TEXT DEFAULT 'حبة', weight_grams REAL, pieces_per_carton INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0);
      CREATE TABLE cartons (id INTEGER PRIMARY KEY, carton_number TEXT UNIQUE, item_id INTEGER, purchase_id INTEGER, pieces INTEGER, status TEXT DEFAULT 'in_stock', issue_date TEXT, issue_permit_id INTEGER, notes TEXT);
      CREATE TABLE issue_permits (id INTEGER PRIMARY KEY, doc_number TEXT, doc_date TEXT, source TEXT DEFAULT 'own', party_id INTEGER, status TEXT DEFAULT 'active');
      CREATE TABLE stock_moves (id INTEGER PRIMARY KEY, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, bucket TEXT, notes TEXT);`);
    return d;
  }
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)").run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن');
  d.prepare('INSERT INTO machines (name) VALUES (?)').run('م1');
  d.prepare('INSERT INTO shifts (name) VALUES (?)').run('صباحية');
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag) VALUES (?,?,?,?,?,?,?)`)
    .run('001', 'عبوة', 2, 'عبوة', 25, 5000, 100);
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton) VALUES (?,?,?,?,?,?)`)
    .run('002', 'عبوة صغيرة', 2, 'عبوة', 10, 1000);
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)`)
    .run('100', 'كيس فارغ', 1, 'كيس', 20);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل أ', 'customer');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد', 'supplier');
  return d;
}

// زراعة حالة الخلل القديم: تالف نتيجة على كرتون عميل دخل عداد المصنع وحركته
function plant(db, { carton, itemId, permitSource, cartonSource, partyId, defects, talefCounter }) {
  db.prepare(`INSERT INTO issue_permits (doc_number, doc_date, source, party_id, status) VALUES (?,'2026-10-01',?,?, 'active')`)
    .run(`I-${carton}`, permitSource, partyId || null);
  const ip = db.prepare('SELECT id FROM issue_permits WHERE doc_number=?').get(`I-${carton}`).id;
  db.prepare(`INSERT INTO cartons (carton_number, item_id, pieces, status, issue_permit_id, source, party_id)
    VALUES (?,?,5000,'finished',?,?,?)`).run(carton, itemId, ip, cartonSource, partyId || null);
  const cid = db.prepare('SELECT id FROM cartons WHERE carton_number=?').get(carton).id;
  db.prepare(`INSERT INTO production_results (carton_id, issue_permit_id, result_date, good_pieces, defect_before, defect_after)
    VALUES (?,?,'2026-10-02',?,?,0)`).run(cid, ip, 5000 - defects, defects);
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
      qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
    VALUES ('production',?,?,?,?,1,?,0,?,0,'talef','تالف مسجل في نتيجة الإنتاج')`)
    .run(cid, carton, '2026-10-02', itemId, defects, defects * 25 / 1000);
  if (talefCounter != null) db.prepare('UPDATE items SET qty_talef=? WHERE id=?').run(Number(talefCounter) || 0, itemId);
  return { cartonId: cid };
}

// ------------------------------------------------------------------ التحليل

test('يكتشف تالف الكرتون المملوك لعميل ويتجاهل كرتون المصنع', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=500 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 500 });
  plant(db, { carton: 'K-1', itemId: 2, permitSource: 'own', cartonSource: 'own', partyId: null, defects: 300, talefCounter: 300 });

  const r = legacy.analyze(db);
  assert.equal(r.rowCount, 1, 'حركة العميل فقط');
  assert.equal(r.cartonCount, 1);
  assert.equal(r.totalDefects, 500);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].code, '001');
  assert.equal(r.items[0].cartons[0].cartonNumber, 'C-1');
  assert.equal(r.items[0].cartons[0].owner, 'عميل أ');
  assert.equal(r.items[0].cartons[0].viaCarton, true);
  assert.equal(r.items[0].shortfall, false);
  assert.equal(db.prepare("SELECT qty_talef FROM items WHERE id=2").get().qty_talef, 300, 'تالف المصنع لا يُمس');
});

test('يعتبر الكرتون للعميل إذا كان تصريح الصرف عميلياً ولو لم تُعلَّم الكرتونة', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=200 WHERE id=1').run();
  plant(db, { carton: 'C-9', itemId: 1, permitSource: 'customer', cartonSource: 'own', partyId: 1, defects: 200, talefCounter: 200 });
  const r = legacy.analyze(db);
  assert.equal(r.rowCount, 1);
  assert.equal(r.items[0].cartons[0].viaCarton, false, 'المصدر: تصريح العميل لا الكرتونة');
});

test('الصنف الذي لا يتّسع عدّاده يُوسم بالنقص ولا يُحذف صفّه', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=10 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 10 });
  const r = legacy.analyze(db);
  assert.equal(r.items[0].shortfall, true);
  assert.equal(r.items[0].after, -490);
  assert.equal(r.insufficient.length, 1);
});

test('قاعدة غير مرحّلة تُرفض برسالة تشرح الترقية لا بانكسار غامض', () => {
  const db = makeDb({ migrate: false }); setDb(db);
  assert.throws(() => legacy.analyze(db), /لم تُرحَّل/);
});

// ------------------------------------------------------------------ التنفيذ

test('يخصم العدّاد ويحذف الحركة ويُبقي الثبات: العدّاد = صافي حركات السلة', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=800 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 800 });
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, qty_out_pieces, bucket)
    VALUES ('opening',0,'افتتاحي','2026-01-01',1,1,300,0,'talef')`).run();  // 300 افتتاحي + 500 القديمة = 800

  const r = legacy.apply(db, {});
  assert.equal(r.removed, 1);
  assert.equal(r.subtracted, 500);
  assert.equal(r.createdScrap, 0, 'بلا createScrap لا تُنشأ سندات');
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 300);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production' AND bucket='talef'").get().c, 0);
  const v = legacy.verify(db, [1]);
  assert.equal(v.residual, 0);
  assert.equal(v.perItem[0].match, true, 'عدّاد=300 وصافي الحركات=300');
});

test('مع --create-scrap يُنشأ سند تالف على العميل ويُخفض رصيده', () => {
  const db = makeDb(); setDb(db);
  const H = {};
  require('../src/handlers/tolling')({ handle: (c, fn) => { H[c] = fn; } });
  db.prepare('UPDATE items SET qty_talef=500 WHERE id=1').run();
  db.prepare("INSERT INTO customer_raw_receipts (doc_number, doc_date, party_id, status) VALUES ('R-1','2026-10-01',1,'active')").run();
  db.prepare("INSERT INTO customer_raw_items (receipt_id, item_id, boxes, pieces, unit, weight_kg) VALUES (1,1,2,10000,'كرتون',250)").run();
  const before = H['tolling:balance']()[0].remaining;
  assert.equal(before, 10000);

  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 500 });
  const r = legacy.apply(db, { createScrap: true });
  assert.equal(r.createdScrap, 1);

  const sc = db.prepare("SELECT * FROM scrap_movements WHERE prod_carton_id IS NOT NULL").get();
  assert.equal(sc.pieces, 500);
  assert.equal(sc.party_id, 1);
  assert.equal(sc.is_customer, 1);
  assert.equal(sc.disposition, 'production_defect');
  assert.equal(sc.warehouse_id, null, 'بلا مخزن: لا أثر على مخزون المصنع');
  assert.equal(sc.talef_take, 0, 'لا يلمس سلّة تالف المصنع');
  assert.equal(sc.status, 'active');
  assert.equal(Math.round(sc.weight_kg * 1000) / 1000, 12.5, '500 حبة × 25 جرام');
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 0);
  assert.equal(H['tolling:balance']()[0].remaining, before - 500, 'التالف صار على رصيد العميل');
});

test('لا يُنشئ سنداً مكرراً لكرتون له سند موجود', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=500 WHERE id=1').run();
  const { cartonId } = plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 500 });
  db.prepare(`INSERT INTO scrap_movements (doc_number, doc_date, item_id, disposition, party_id, pieces, is_customer, prod_carton_id)
    VALUES ('موجود','2026-10-02',1,'production_defect',1,500,1,?)`).run(cartonId);

  const r = legacy.apply(db, { createScrap: true });
  assert.equal(r.removed, 1, 'الحركة القديمة تُمحى رغم وجود السند');
  assert.equal(r.createdScrap, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 1);
});

test('يترك الصنف الناقص كاملاً ويُسجّله في المتخطّى', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=10 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 10 });
  const r = legacy.apply(db, { createScrap: true });
  assert.equal(r.removed, 0);
  assert.equal(r.subtracted, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].code, '001');
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 10, 'لم يهبط تحت الصفر');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production'").get().c, 1, 'وحركته باقية');
});

test('التكرار لا يُنتج شيئاً (idempotent)', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=500 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 500 });
  const first = legacy.apply(db, { createScrap: true });
  const second = legacy.apply(db, { createScrap: true });
  assert.equal(first.removed, 1);
  assert.equal(second.removed, 0);
  assert.equal(second.items.length, 0);
  assert.equal(second.skipped.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=1').get().qty_talef, 0);
});

test('كرتون بلا نتيجة إنتاج يستخدم تاريخ اليوم ولا يفشل', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=400 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 400, talefCounter: 400 });
  db.prepare('DELETE FROM production_results').run();
  const r = legacy.apply(db, { createScrap: true });
  assert.equal(r.createdScrap, 1);
  assert.match(db.prepare('SELECT doc_date FROM scrap_movements').get().doc_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.orphans.length, 1);
});

// ------------------------------------------------------------------ معالج التطبيق

test('معالج backup:legacyReport يعيد التقرير بلا كتابة، وlegacyFix ينسخ احتياطياً', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET qty_talef=500 WHERE id=1').run();
  plant(db, { carton: 'C-1', itemId: 1, permitSource: 'customer', cartonSource: 'customer', partyId: 1, defects: 500, talefCounter: 500 });
  const H = {};
  require('../src/handlers/backup')({ handle: (c, fn) => { H[c] = fn; } });
  const view = H['backup:legacyReport']();
  assert.equal(view.rowCount, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='production'").get().c, 1, 'التقرير لا يغير شيئاً');
  // التنفيذ الفعلي يتطلب ملف قاعدة حقيقي للنسخة الاحتياطية — يُتحقّق منه في سطر الأوامر
  assert.equal(typeof H['backup:legacyFix'], 'function');
});
