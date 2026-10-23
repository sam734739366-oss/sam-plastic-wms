const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { removeNonWarehouseData } = require('../src/cleanup');
const { getBalance } = require('../src/stock');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  return d;
}

function stubIpc(...mods) {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  for (const m of mods) require('../src/handlers/' + m)(ipc);
  return handlers;
}

// ثبات: عداد كل سلة == صافي حركات المخزون لهذه السلة
function assertConsistent(db, label) {
  const rows = db.prepare(`SELECT item_id, bucket,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
    FROM stock_moves GROUP BY item_id, bucket`).all();
  for (const it of db.prepare('SELECT * FROM items').all()) {
    for (const key of ['salem', 'talef', 'muharraz']) {
      const r = rows.find(x => x.item_id === it.id && x.bucket === key);
      const net = r ? r.net : 0;
      assert.equal(net, Number(it[`qty_${key}`]) || 0,
        `${label}: عداد ${key} للصنف ${it.code} لا يطابق حركات المخزون`);
    }
  }
}

// قاعدة فيها بيانات مخازن وإنتاج كاملة + بيانات الأقسام الملغاة (بيع/خروج/مرتجع بيع/دفعات)
function buildFixture() {
  const db = makeDb(); setDb(db);
  db.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي'), ('مخزن الصابون')").run();
  db.prepare(`INSERT INTO parties (name, type) VALUES
    ('مورد البلاستيك','supplier'), ('عميل تجاري','customer'),
    ('عميل نفخ','customer'), ('طرف مزدوج','both')`).run();
  db.prepare(`INSERT INTO items (code, name, unit_name, weight_grams, qty_salem)
    VALUES ('A001','عبوة','حبة',10,5000), ('B002','علبة','حبة',20,2000)`).run();
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, weight_in_kg, bucket, notes)
    VALUES ('opening',1,'افتتاحي-A001','2026-10-01',1,1,5000,50,'salem','رصيد افتتاحي (سليم)'),
           ('opening',2,'افتتاحي-B002','2026-10-01',2,1,2000,40,'salem','رصيد افتتاحي (سليم)')`).run();
  const h = stubIpc('purchases', 'issues', 'receives', 'transfers', 'scrap',
    'sales', 'exits', 'returns', 'payments', 'tolling');
  // شراء خام (يبقى)
  const { id: purId } = h['purchases:save'](null, {
    doc_number: 'CL-P1', doc_date: '2026-10-20', party_id: 1, payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1000, unit: 'حبة', unit_price: 10 }],
  }, 1);
  // بيع نقدي وآجل (يُحذف)
  h['sales:save'](null, {
    doc_number: 'CL-V1', doc_date: '2026-10-20', invoice_type: 'sale', party_id: 2, payment_method: 'cash',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 100 }],
  }, 1);
  const { id: saleId } = h['sales:save'](null, {
    doc_number: 'CL-V2', doc_date: '2026-10-20', invoice_type: 'sale', party_id: 2, payment_method: 'credit',
    items: [{ item_id: 2, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 50 }],
  }, 1);
  // تصريح خروج (يُحذف)
  h['exits:save'](null, {
    doc_number: 'CL-X1', doc_date: '2026-10-20', warehouse_id: 1,
    driver_name: 'سائق النقل', car_number: '1234', destination: 'صنعاء',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 50, unit: 'حبة' }],
  }, 1);
  // مرتجع بيع (يُحذف) ومرتجع شراء (يبقى)
  h['returns:save'](null, {
    doc_number: 'CL-SR1', doc_date: '2026-10-20', type: 'sale', invoice_id: saleId,
    payment_method: 'credit',
    items: [{ item_id: 2, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 50 }],
  }, 1);
  h['returns:save'](null, {
    doc_number: 'CL-PR1', doc_date: '2026-10-20', type: 'purchase', purchase_id: purId,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 10 }],
  }, 1);
  // تالف (يبقى) ونقل (يبقى)
  h['scrap:save'](null, {
    doc_number: 'CL-S1', doc_date: '2026-10-20', item_id: 1, disposition: 'to_recycled',
    warehouse_id: 1, pieces: 50,
  }, 1);
  h['transfers:save'](null, {
    doc_number: 'CL-T1', doc_date: '2026-10-20', from_warehouse_id: 1, to_warehouse_id: 2,
    items: [{ item_id: 1, quantity: 100, unit: 'حبة' }],
  }, 1);
  // سند قبض (يُحذف)
  h['payments:save'](null, {
    doc_number: 'CL-PAY1', doc_date: '2026-10-20', party_id: 2, direction: 'in', amount: 500,
  }, 1);
  // نفخ للغير: استلام خام من عميل (يبقى العميل لأنه مرتبط به)
  h['tolling:receiptSave'](null, {
    doc_number: 'CL-TR1', doc_date: '2026-10-20', party_id: 3,
    items: [{ item_id: 2, quantity: 500, unit: 'حبة' }],
  }, 1);
  return { db, h, saleId, purId };
}

test('حذف الأقسام الملغاة: يمسح البيع والخروج ومرتجع البيع والدفعات ويُبقي المخازن والإنتاج سليمة', () => {
  const { db } = buildFixture();
  try {
    const removed = removeNonWarehouseData(db);
    assert.equal(removed.sale_invoices, 2, 'حذف فاتورتي البيع');
    assert.equal(removed.sale_returns, 1, 'حذف مرتجع البيع');
    assert.equal(removed.exits, 1, 'حذف تصريح الخروج');
    assert.equal(removed.payments, 1, 'حذف سند القبض');
    assert.equal(removed.parties, 1, 'حذف العميل غير المرتبط بأي مستند باقٍ');

    // المستندات المحذوفة صارت صفراً
    assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, 0, 'لا فواتير بيع متبقية');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM exit_permits').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM exit_items').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM payments').get().c, 0);
    // المستندات الباقية لم تُمس
    assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases').get().c, 1, 'فاتورة الشراء باقية');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_returns').get().c, 1, 'مرتجع الشراء باقٍ');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM scrap_movements').get().c, 1, 'سند التالف باقٍ');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transfers').get().c, 1, 'سند النقل باقٍ');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_raw_receipts').get().c, 1, 'استلام خام العميل باقٍ');

    // حركات المخزون: محذوفة للأقسام الملغاة فقط
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='exit'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='sale_return'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='invoice'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='purchase'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='purchase_return'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='scrap'").get().c > 0, true);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='transfer'").get().c, 2);

    // الدفتر: بقيت حركات الشراء ومرتجع الشراء فقط
    const ledTypes = db.prepare('SELECT DISTINCT doc_type t FROM party_ledger').all().map(r => r.t).sort();
    assert.deepEqual(ledTypes, ['purchase', 'purchase_return'], 'الدفتر بلا بيع ولا سندات');

    // الأطراف: العميل التجاري حُذف، والمورد وعميل النفخ والمزدوج بقوا
    assert.equal(db.prepare('SELECT COUNT(*) c FROM parties').get().c, 3);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM parties WHERE name='عميل تجاري'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM parties WHERE name='عميل نفخ'").get().c, 1);

    // سجل التدقيق: حذفت سجلات الكيانات الملغاة وبقيت غيرها
    // (كل مستند مخزني له سطران في التدقيق: إنشاء المستند + كتابة الحركة stock_write)
    assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity IN ('invoice','exit_permit','sale_return','payment')").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='purchase' AND action='create'").get().c, 1);

    // العدادات كما هي (الكميات الحالية لا تتغير) والحركات أعيدت مطابقتها بالافتتاح
    const a = db.prepare("SELECT * FROM items WHERE code='A001'").get();
    const b = db.prepare("SELECT * FROM items WHERE code='B002'").get();
    assert.equal(a.qty_salem, 5500, 'عداد سليم A001: 5000 + 1000 شراء − 50 خروج − 100 مرتجع شراء − 50 تالف من سليم (البيع المحذوف لا يغيّر العداد)');
    assert.equal(a.qty_muharraz, 50, 'المحرز من سند التالف');
    assert.equal(b.qty_salem, 1850, 'عداد B002: 2000 − 200 بيع محذوف + 50 مرتجع بيع محذوف لا يغير العداد');
    assertConsistent(db, 'بعد الحذف');
    // الافتتاح امتص أثر المحذوف: 5500 − (شراء 1000 − مرتجع شراء 100 − تالف سليم 50) = 4650
    const openA = db.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0) s FROM stock_moves
      WHERE doc_type='opening' AND item_id=? AND bucket='salem'`).get(a.id).s;
    assert.equal(openA, 4650, 'الافتتاح الجديد يمتص أثر حركات البيع والخروج المحذوفة');
    // الجرد يعرض نفس الكميات الحالية للمخزن
    assert.equal(getBalance(db, a.id, 1).balance_pieces, 5450, 'جرد A001 بالمخزن الرئيسي (سليم 5400 + محرز 50)');
    assert.equal(getBalance(db, a.id, 2).balance_pieces, 100, 'جرد A001 بمخزن الصابون بعد النقل');
  } finally {
    db.close();
  }
});

test('الحذف تكراراً لا يغيّر قاعدة نظيفة', () => {
  const { db } = buildFixture();
  try {
    removeNonWarehouseData(db);
    const removed2 = removeNonWarehouseData(db);
    assert.equal(removed2.sale_invoices, 0);
    assert.equal(removed2.sale_returns, 0);
    assert.equal(removed2.exits, 0);
    assert.equal(removed2.payments, 0);
    assert.equal(removed2.parties, 0);
    assertConsistent(db, 'بعد التكرار');
  } finally {
    db.close();
  }
});

test('الحذف على قاعدة بلا بيانات ملغاة: لا يحذف شيئاً ولا يخرب الأرصدة', () => {
  const db = makeDb(); setDb(db);
  db.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي')").run();
  db.prepare("INSERT INTO parties (name,type) VALUES ('مورد','supplier')").run();
  db.prepare("INSERT INTO items (code, name, unit_name, weight_grams, qty_salem) VALUES ('A001','عبوة','حبة',10,5000)").run();
  db.prepare(`INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, weight_in_kg, bucket)
    VALUES ('opening',1,'افتتاحي','2026-10-01',1,1,5000,50,'salem')`).run();
  try {
    const removed = removeNonWarehouseData(db);
    assert.deepEqual(removed, { sale_invoices: 0, sale_returns: 0, exits: 0, payments: 0, parties: 0 });
    assertConsistent(db, 'قاعدة نظيفة');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM parties').get().c, 1, 'المورد باقٍ');
  } finally {
    db.close();
  }
});
