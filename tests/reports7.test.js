const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

// مخزنين وصنفين ومورد وعميل — لتختبر الفلاتر الذكية والتجميع عبر المخازن
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)").run('admin', 'المدير', 'x', 'manager');
  d.prepare("INSERT INTO warehouses (name) VALUES ('المخزن الرئيسي')").run();
  d.prepare("INSERT INTO warehouses (name) VALUES ('مخزن الفرعي')").run();
  d.prepare('INSERT INTO machines (name) VALUES (?)').run('مكينة 1');
  d.prepare('INSERT INTO shifts (name) VALUES (?)').run('صباحية');
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag) VALUES (?,?,?,?,?,?,?)")
    .run('001', 'عبوة 1 لتر', 2, 'عبوة', 25, 100, 50);
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton, pieces_per_bag) VALUES (?,?,?,?,?,?,?)")
    .run('002', 'عبوة 2 لتر', 2, 'عبوة', 40, 200, 100);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد التجارب', 'supplier');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل العهدة', 'customer');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

function buy(h, number, date, itemId, warehouseId, qty, price) {
  h['purchases:save'](null, {
    doc_number: number, doc_date: date, party_id: 1,
    items: [{ item_id: itemId, warehouse_id: warehouseId, quantity: qty, unit: 'حبة', unit_price: price }],
  }, 1);
}

// ------------------------------------------------------------------ بيانات التقرير الأول

test('المشتريات على مستوى البند، مع فلترة بالمورد والتاريخ والمخزن', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);
  buy(h, 'P-2', '2026-11-05', 1, 2, 300, 6);

  const all = h['reports:purchases'](null, {});
  assert.equal(all.rows.length, 2);
  assert.equal(all.total_qty, 800);

  const oct = h['reports:purchases'](null, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(oct.rows.length, 1);
  assert.equal(oct.rows[0].doc_number, 'P-1');
  assert.equal(oct.rows[0].party_name, 'مورد التجارب');
  assert.equal(oct.rows[0].qty, 500);

  const wh2 = h['reports:purchases'](null, { warehouseId: 2 });
  assert.equal(wh2.rows.length, 1, 'مخزن بعينه يُسقط بنود المخازن الأخرى');
  assert.equal(wh2.rows[0].doc_number, 'P-2');
  assert.equal(h['reports:purchases'](null, { warehouseId: 'all' }).rows.length, 2, '«كل المخازن» يجمع الكل');
  assert.equal(h['reports:purchases'](null, { partyId: 2 }).rows.length, 0, 'فلتر المورد يعمل');
});

test('التقارير لا تحمل أي عمود وزن في أعمدتها', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'screens', 'reports.js'), 'utf8');
  const block = src.slice(src.indexOf('purchases: {'), src.indexOf('inventory: {'));
  assert.equal(/label: '[^']*وزن[^']*'/g.test(block), false, 'لا عمود وزن في التقارير السبعة');
  assert.equal(/weight_\w+/.test(block.replace(/weight: true/g, '')), false, 'لا حقول وزن في التقارير السبعة');
});

// ------------------------------------------------------------------ وحدة العرض

test('وحدة العرض تعرض كرتون/كيس وتُبقي الحساب بالحبة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);

  const pieces = h['reports:purchases'](null, { unit: 'pieces' });
  assert.equal(pieces.rows[0].qty_label, '500 حبة');
  assert.equal(pieces.rows[0].qty, 500, 'القيمة الرقمية تبقى بالحبة');

  const carton = h['reports:purchases'](null, { unit: 'carton' });
  assert.equal(carton.rows[0].qty_label, '5 كرتون', '500 ÷ 100 حبة/كرتون');

  const bag = h['reports:purchases'](null, { unit: 'bag' });
  assert.equal(bag.rows[0].qty_label, '10 كيس', '500 ÷ 50 حبة/كيس');

  // الافتراضي بلا وحدة معلّمة = حبة
  assert.equal(h['reports:purchases'](null, {}).rows[0].qty_label, '500 حبة');
  // الإجمالي العام يبقى بالحبة: جمع كرتون أصناف مختلفة غير ذي معنى
  assert.equal(carton.total_qty_label, '500 حبة');
});

test('صنف بلا حجم تعبئة يرجع للحبة بدل قسمة على صفر', () => {
  const db = makeDb(); setDb(db);
  db.prepare('UPDATE items SET pieces_per_carton = NULL, pieces_per_bag = NULL WHERE id = 1').run();
  const h = stubIpc(['purchases', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 300, 5);
  assert.equal(h['reports:purchases'](null, { unit: 'carton' }).rows[0].qty_label, '300 حبة');
});

// ------------------------------------------------------------------ المنصرف للإنتاج

test('المنصرف للإنتاج يجمع المخزن والمصدر بلا مكينة ولا وردية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);
  db.prepare("UPDATE items SET pieces_per_carton = 500 WHERE id = 1").run();
  h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-11', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة' }],
  }, 1);
  const data = h['reports:issues'](null, { from: '2026-10-01' });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].doc_number, 'I-1');
  assert.equal(data.rows[0].qty, 200);
  assert.equal(data.rows[0].source, 'own');
  assert.equal(data.total_qty, 200);
  assert.equal(Object.keys(data.rows[0]).includes('machine_name'), false, 'لا مكينة ولا وردية كما طُلب');
  assert.equal(h['reports:issues'](null, { warehouseId: 2 }).rows.length, 0);
});

// ------------------------------------------------------------------ الخروج للعملاء

test('الخروج للعملاء: فواتير البيع فقط، بقيمة البند بالريال', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-12', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 40, unit: 'حبة', unit_price: 12 }],
  }, 1);
  // فاتورة أجرة نفخ يجب ألا تدخل في تقرير الخروج للعملاء
  h['sales:save'](null, {
    doc_number: '2', doc_date: '2026-10-13', invoice_type: 'blowing_fee', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 5, unit: 'حبة', unit_price: 1 }],
  }, 1);
  const data = h['reports:sales'](null, {});
  assert.equal(data.rows.length, 1, 'فواتير البيع فقط');
  assert.equal(data.rows[0].qty, 40);
  assert.equal(data.rows[0].value, 480);
  assert.equal(data.total, 480);
  assert.equal(data.rows[0].party_name, 'عميل العهدة');
});

// ------------------------------------------------------------------ العهَد (للغير)

test('تقرير العهَد: خام وتسليم وتالف العميل والرصيد المتبقي', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling', 'scrap', 'reports']);
  h['tolling:receiptSave'](null, { doc_number: 'R-1', doc_date: '2026-10-05', party_id: 2,
    items: [{ item_id: 1, quantity: 10000, unit: 'عبوة' }] }, 1);
  h['tolling:deliverySave'](null, { doc_number: 'D-1', doc_date: '2026-10-20', party_id: 2,
    items: [{ item_id: 1, quantity: 3000, unit: 'عبوة' }] }, 1);
  h['scrap:save'](null, { doc_number: 'S-1', doc_date: '2026-10-21', item_id: 1,
    disposition: 'sold_scrap', party_id: 2, pieces: 500, weight_kg: 12.5 }, 1);

  const data = h['reports:tolling'](null, {});
  const row = data.rows.find(r => r.party_name === 'عميل العهدة');
  assert.equal(row.raw_in, 10000);
  assert.equal(row.delivered, 3000);
  assert.equal(row.customer_defects, 500);
  assert.equal(row.remaining, 6500, 'الرصيد = خام − تسليم − تالف');
  // صنف واحد لكل العميل ⇒ التحويل لوحدات التعبئة له معنى
  assert.equal(h['reports:tolling'](null, { unit: 'carton' }).rows.find(r => r.party_name === 'عميل العهدة').raw_in_label, '100 كرتون');

  // نطاق زمني يستبعد التالف خارج المدى
  const early = h['reports:tolling'](null, { to: '2026-10-10' });
  const r2 = early.rows.find(r => r.party_name === 'عميل العهدة');
  assert.equal(r2.raw_in, 10000);
  assert.equal(r2.delivered, 0);
  assert.equal(r2.customer_defects, 0);
  assert.equal(r2.remaining, 10000);
});

test('العهَد لعميل بخام من صنفين لا يحوّل الإجمالي إلى كرتون', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['tolling', 'reports']);
  h['tolling:receiptSave'](null, { doc_number: 'R-1', doc_date: '2026-10-05', party_id: 2,
    items: [{ item_id: 1, quantity: 1000, unit: 'عبوة' }, { item_id: 2, quantity: 600, unit: 'عبوة' }] }, 1);
  const row = h['reports:tolling'](null, { unit: 'carton' }).rows.find(r => r.party_name === 'عميل العهدة');
  assert.equal(row.raw_in_label, '1,600 حبة', 'حجمان مختلفان للكرتون لا يُجمعان في رقم واحد');
});

// ------------------------------------------------------------------ التالف

test('تقرير التالف يميّز مصدر السند: نتيجة إنتاج أم يدوي', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'tolling', 'issues', 'production', 'scrap', 'reports']);
  // كرتون عميل بتالف 300 قبل + 200 بعد ⇒ سند آلي بمصدر مركّب
  h['tolling:receiptSave'](null, { doc_number: 'R-1', doc_date: '2026-10-01', party_id: 2,
    items: [{ item_id: 1, quantity: 10000, unit: 'عبوة' }] }, 1);
  const c = db.prepare("SELECT id FROM cartons WHERE carton_number = 'C-1'").get();
  h['issues:save'](null, { doc_number: 'I-C', doc_date: '2026-10-02', source: 'customer', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: ['C-1'] }] }, 1);
  h['production:save'](null, { carton_id: c.id, result_date: '2026-10-03', good_pieces: 4500, defect_before: 300, defect_after: 200 }, 1);
  // وسند يدوي على مخزون المصنع
  buy(h, 'P-1', '2026-10-05', 1, 1, 500, 5);
  h['scrap:save'](null, { doc_number: 'S-9', doc_date: '2026-10-06', item_id: 1,
    disposition: 'to_recycled', warehouse_id: 1, pieces: 50, weight_kg: 1.25 }, 1);

  const data = h['reports:scrap'](null, {});
  const auto = data.rows.find(r => r.doc_number === 'تالف إنتاج C-1');
  assert.ok(auto, 'السند الآلي يظهر في التقرير');
  assert.equal(auto.source_label, 'تالف قبل + بعد');
  assert.equal(auto.qty, 500);
  const manual = data.rows.find(r => r.doc_number === 'S-9');
  assert.equal(manual.source_label, 'سند يدوي');
  // فلتر المخزن يُسقط سند العميل (بلا مخزن) لأن مخزنه null
  assert.equal(h['reports:scrap'](null, { warehouseId: 1 }).rows.map(r => r.doc_number).join(','), 'S-9');
});

// ------------------------------------------------------------------ أرصدة المخازن

test('أرصدة المخازن تفصّل لكل مخزن وتجمع عند «كل المخازن»', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);
  buy(h, 'P-2', '2026-10-11', 1, 2, 300, 5);
  buy(h, 'P-3', '2026-10-12', 2, 1, 200, 5);

  const one = h['reports:stockBalances'](null, { warehouseId: 1 });
  assert.deepEqual(one.rows.map(r => r.code).sort(), ['001', '002']);
  assert.equal(one.total_pieces, 700);

  const all = h['reports:stockBalances'](null, { warehouseId: 'all' });
  assert.equal(all.rows.length, 3, 'سطر لكل مخزن × صنف');
  assert.equal(all.total_pieces, 1000);

  const item1 = h['reports:stockBalances'](null, { itemId: 1, warehouseId: 'all' });
  assert.equal(item1.rows.length, 2);
  assert.equal(item1.total_pieces, 800);
  assert.equal(item1.rows[0].qty_salem_label, '500 حبة');
  assert.equal(item1.rows[0].qty_talef, 0);
  assert.equal(item1.rows[0].qty_muharraz, 0);
  assert.equal(item1.rows[0].total_pieces_label, '500 حبة');
});

test('الأرصدة تُخفي الأصناف المكمّلة والصفوف صفرية الرصيد', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  buy(h, 'P-1', '2026-10-10', 1, 1, 500, 5);
  db.prepare('INSERT INTO items (code, name, item_group, unit_name, is_complement) VALUES (?, ?, 2, ?, 1)')
    .run('900', 'غطاء', 'غطاء');
  db.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, bucket) VALUES ('purchase',9,'X','2026-10-10',3,1,50,'salem')").run();
  // رصيد صفر في مخزن ثانٍ لنفس الصنف ⇒ لا يظهر
  db.prepare("INSERT INTO stock_moves (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id, qty_in_pieces, qty_out_pieces, bucket) VALUES ('purchase',9,'X','2026-10-10',1,2,40,40,'salem')").run();
  const data = h['reports:stockBalances'](null, { warehouseId: 'all' });
  assert.equal(data.rows.some(r => r.code === '900'), false, 'الصنف المكمّل مستثنى');
  assert.equal(data.rows.filter(r => r.code === '001').length, 1, 'سطر المخزن الصفر مستثنى');
});

// ------------------------------------------------------------------ بيانات الوصف

test('reports:meta يعيد المخزن الرئيسي لتضعه الواجهة مختارًا افتراضيًا', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['reports']);
  assert.equal(h['reports:meta']().mainWarehouseId, 1);
});
