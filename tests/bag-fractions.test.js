const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');
const templates = require('../src/print/templates');

// صنف 1: إنتاج تام مربوط بأكياس (id 3) — كيس = 100 حبة
// صنف 2: إنتاج تام بلا ربط أكياس
// صنف 3: صنف الأكياس الفارغة (تُخصم منه)
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن الإنتاج التام');
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag)
    VALUES (?,?,?,?,?,?)`).run('002', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag)
    VALUES (?,?,?,?,?,?)`).run('003', 'عبوة بلا ربط', 2, 'عبوة', 52, 100);
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams)
    VALUES (?,?,?,?,?)`).run('100', 'كيس فارغ', 1, 'كيس', 20);
  // الربط بعد إنشائه: عمود bag_item_id يشير إلى id 3 الذي لم يوجد بعد عند الإدراج الأول
  d.prepare('UPDATE items SET bag_item_id = 3 WHERE id = 1').run();
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل', 'customer');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

const salem = (db, id) => db.prepare('SELECT qty_salem FROM items WHERE id=?').get(id).qty_salem;
const line = (db, id) => db.prepare('SELECT * FROM receive_items WHERE receive_permit_id=?').get(id);

function stockBags(h, db, qty) {
  h['purchases:save'](null, { doc_number: 'PB-1', doc_date: '2026-10-19',
    items: [{ item_id: 3, warehouse_id: 1, quantity: qty, unit: 'حبة' }] }, 1);
}

function receiveOwn(db, h, opts = {}) {
  const { id } = h['receives:save'](null, {
    doc_number: opts.number || 'R-1', doc_date: '2026-10-20', source: opts.source || 'own',
    party_id: opts.party_id || null,
    items: [{ item_id: opts.item_id || 1, warehouse_id: 1, quantity: opts.bags, breaks: opts.breaks, unit: opts.unit || 'كيس', bucket: 'salem' }],
  }, 1);
  return { id, row: line(db, id) };
}

// ------------------------------------------------------------------ حساب الكسور

test('الكمية بالحبات = مكتملة × حبات/كيس + كسور، والأكياس المستهلكة = مكتملة + كيس للكسور', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(db, h, { bags: 80, breaks: 40 });
  assert.equal(row.pieces, 8040);
  assert.equal(row.breaks, 40);
  assert.equal(row.bags_used, 81, '80 كيساً مكتملاً + كيس للكسور');
  assert.equal(row.quantity, 80, 'الكمية المدونة تبقى عدد الأكياس المكتملة');
});

test('بلا كسور ⇒ الأكياس المستهلكة = عدد الأكياس، والحبات مضروب صحيح', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(db, h, { bags: 80, breaks: 0 });
  assert.equal(row.pieces, 8000);
  assert.equal(row.bags_used, 80);
});

test('كسور تساوي أو تتجاوز حبات الكيس تُدمج في أكياس كاملة بدل أن تضيع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(db, h, { bags: 2, breaks: 250 }); // 450 حبة
  assert.equal(row.pieces, 450);
  assert.equal(row.bags_used, 5, 'ceil(450/100) = 5');
  assert.equal(salem(db, 1), 450);
});

test('الاستلام بوحدة غير الكيس لا يقبل كسوراً برسالة واضحة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  assert.throws(() => receiveOwn(db, h, { bags: 5, breaks: 10, unit: 'عبوة' }), /الكسور تُحسب مع وحدة/);
});

test('صنف بلا «حبات/كيس» يُرفض عند وحدة الكيس برسالة تدل على العلاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  db.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES ('009','صنف بلا كيس',2,'عبوة',10)").run();
  assert.throws(() => receiveOwn(db, h, { item_id: 4, bags: 5, breaks: 0 }), /عدد القطع في الكيس/);
});

// ------------------------------------------------------------------ خصم الأكياس

test('استلام إنتاج المصنع يخصم الأكياس المستهلكة من رصيد صنف الأكياس', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { id, row } = receiveOwn(db, h, { bags: 80, breaks: 40 });
  assert.equal(row.bag_item_id, 3, 'يُخزَّن ربط الكيس في السطر لعكسه بدقة لاحقاً');
  assert.equal(salem(db, 3), 919, '1000 - 81');
  assert.equal(salem(db, 1), 8040, 'سلّة الصنف المستلم');
  const mv = db.prepare("SELECT item_id, qty_in_pieces, qty_out_pieces, bucket FROM stock_moves WHERE doc_type='receive' AND doc_id=? ORDER BY id").all(id);
  assert.equal(mv.length, 2);
  assert.deepEqual([mv[0].item_id, mv[0].qty_in_pieces], [1, 8040]);
  assert.deepEqual([mv[1].item_id, mv[1].qty_out_pieces, mv[1].bucket], [3, 81, 'salem']);
});

test('صنف غير مربوط بأكياس: يُدوَّن عدد الأكياس بلا أي خصم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(db, h, { item_id: 2, bags: 10, breaks: 5 });
  assert.equal(row.bags_used, 11);
  assert.equal(row.bag_item_id, null);
  assert.equal(salem(db, 3), 1000, 'لم يُمسّ رصيد الأكياس');
});

test('رصيد الأكياس غير كافٍ ⇒ رفض المستند وعدم تحريك سلّة الإنتاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 5);
  assert.throws(() => receiveOwn(db, h, { bags: 80, breaks: 40 }), /رصيد الأكياس غير كافٍ/);
  assert.equal(salem(db, 1), 0, 'لم يُسجَّل الاستلام أصلاً');
  assert.equal(salem(db, 3), 5);
});

test('تعديل المستند يعكس الأكياس القديمة ويخصم الجديدة بلا ازدواج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { id } = receiveOwn(db, h, { bags: 80, breaks: 40 });   // −81
  assert.equal(salem(db, 3), 919);
  h['receives:save'](null, {
    id, doc_number: 'R-1', doc_date: '2026-10-20', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 80, breaks: 0, unit: 'كيس', bucket: 'salem' }],
  }, 1);
  assert.equal(salem(db, 3), 920, '1000 - 80: رُدّت 81 ثم خُصمت 80');
  const r = line(db, id);
  assert.equal(r.pieces, 8000);
  assert.equal(r.bags_used, 80);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM receive_items').get().c, 1, 'سطر واحد بعد التعديل');
});

test('إلغاء المستند يُرجع الأكياس إلى مخزنها ويحذف أثر الإنتاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { id } = receiveOwn(db, h, { bags: 80, breaks: 40 });
  h['receives:void'](null, id, 1);
  assert.equal(salem(db, 3), 1000, 'عودة كاملة');
  assert.equal(salem(db, 1), 0);
  const net = db.prepare("SELECT COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n FROM stock_moves WHERE doc_type='receive' AND doc_id=?").get(id).n;
  assert.equal(net, 0, 'حركات الإنتاج صافية الصفر');
});

test('خام العميل يخصم الأكياس كذلك — فهي ملك المصنع بلا النظر عن مالك الخام', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(db, h, { bags: 30, breaks: 10, source: 'customer', party_id: 1 });
  assert.equal(row.bags_used, 31);
  assert.equal(row.bag_item_id, 3, 'الخصم يسري على خام العميل أيضًا');
  assert.equal(salem(db, 3), 969, '1000 - 31');
  assert.equal(salem(db, 1), 0, 'أما إنتاج خام العميل فلا يدخل مخزون المصنع');
  const mv = db.prepare("SELECT item_id, qty_in_pieces, qty_out_pieces FROM stock_moves WHERE doc_type='receive'").all();
  assert.equal(mv.length, 1, 'حركة واحدة: استهلاك الأكياس فقط');
  assert.deepEqual([mv[0].item_id, mv[0].qty_out_pieces], [3, 31]);
});

test('تبديل المصدر من مصنع إلى عميل لا يغيّر استهلاك الأكياس', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'receives']);
  stockBags(h, db, 1000);
  const { id } = receiveOwn(db, h, { bags: 30, breaks: 10 });
  assert.equal(salem(db, 3), 969);
  h['receives:save'](null, {
    id, doc_number: 'R-1', doc_date: '2026-10-20', source: 'customer', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 30, breaks: 10, unit: 'كيس', bucket: 'salem' }],
  }, 1);
  assert.equal(salem(db, 3), 969, 'عُكس القديم ثم طُبّق الجديد بالكمية نفسها');
  assert.equal(line(db, id).bag_item_id, 3);
});

test('ربط صنف الأكياس بنفسه يُرفض، وربط غير موجود يُرفض', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['items']);
  // وحدة الصنف في الحفظ يجب أن تكون من قائمة الوحدات المعروفة
  db.prepare("UPDATE items SET unit_name='حبة' WHERE id=1").run();
  assert.throws(() => h['items:save'](null, { id: 1, code: '002', name: 'عبوة', unit_name: 'حبة', bag_item_id: 1 }, 1), /بنفسه/);
  assert.throws(() => h['items:save'](null, { id: 1, code: '002', name: 'عبوة', unit_name: 'حبة', bag_item_id: 999 }, 1), /غير موجود/);
  h['items:save'](null, { id: 1, code: '002', name: 'عبوة', unit_name: 'حبة', bag_item_id: 3 }, 1);
  assert.equal(db.prepare('SELECT bag_item_id FROM items WHERE id=1').get().bag_item_id, 3);
});

// ------------------------------------------------------------------ الطباعة

const doc = { doc_number: 'R-1', doc_date: '2026-10-20', notes: '',
  items: [{ code: '002', name: 'عبوة', warehouse_name: 'التام', quantity: 80, unit: 'كيس', bucket: 'salem', pieces: 8040, weight_kg: 418 }],
  machine_name: 'م1', shift_name: 'صباحية' };
const base = { factory_name: 'سام بلاستيك', currency: 'YER', doc_page_size: 'A5' };

test('ترويسة الطباعة تحمل اسم التطبيق ورقم الهاتف في شريط ثابت يُعاد على كل صفحة', () => {
  const html = templates.receiveTemplate(doc, { ...base, factory_phone: '0551234567' });
  assert.match(html, /<div class="lhead"><span class="brand">سام بلاستيك<\/span>/);
  assert.match(html, /<span class="tel">0551234567<\/span>/);
  // الثبّت هو ما يجعل Chromium يعيد الرسم على كل صفحة فيزيائية عند تقاطع المستند
  assert.match(html, /\.lhead \{ position: fixed; top: 0/);
  assert.match(html, /\.foot \{ position: fixed; bottom: 0/);
  assert.match(html, /body \{[^}]*padding: 8mm 0 7mm/);  // مساحة حتى لا يغطي الشريط المحتوى
  assert.match(html, /thead \{ display: table-header-group/);   // رؤوس الأعمدة تتكرر هي الأخرى
});

test('عمود الكسور يظهر في قالب الاستلام مثل الشاشة، ومتجره «—» لغير الكيس', () => {
  const bagged = { ...doc, items: [{ code: '002', name: 'عبوة', warehouse_name: 'التام', quantity: 7,
    unit: 'كيس', bucket: 'salem', pieces: 1761, weight_kg: 91.5, breaks: 11, bags_used: 8 }] };
  const html = templates.receiveTemplate(bagged, base);
  assert.match(html, /<th>#<\/th><th>الصنف<\/th><th>المخزن<\/th><th>الكمية<\/th><th>كسور<\/th>/);
  assert.match(html, /<td>7<\/td><td>11<\/td><td>كيس<\/td>/);
  assert.match(html, /الأكياس المستهلكة للتعبئة: <b>8<\/b> كيس/);

  const loose = { ...doc, items: [{ code: '002', name: 'عبوة', warehouse_name: 'التام', quantity: 500,
    unit: 'عبوة', bucket: 'salem', pieces: 500, weight_kg: 26, breaks: 0, bags_used: 0 }] };
  const html2 = templates.receiveTemplate(loose, base);
  assert.match(html2, /<td>500<\/td><td>—<\/td><td>عبوة<\/td>/, 'لا كسور لغير وحدة الكيس');
  assert.doesNotMatch(html2, /الأكياس المستهلكة/, 'ولا سطر أكياس حين لا استهلاك');
});

test('بلا هاتف لا تُرسم خانة فارغة، ولا يظهر «undefined»', () => {
  const html = templates.receiveTemplate(doc, base);
  assert.doesNotMatch(html, /class="tel"/);
  assert.match(html, /<span class="brand">سام بلاستيك<\/span>/);
  assert.doesNotMatch(html, /undefined|null/);
});

test('التذييل الديناميكي يرسم المواضع الثلاثة ويُهمل الفارغ منها', () => {
  const html = templates.receiveTemplate(doc, {
    ...base, footer_right: 'سام بلاستيك — factory', footer_center: 'شكراً لتعاملكم معنا', footer_left: '',
  });
  assert.match(html, /<div class="foot">/);
  assert.match(html, /<span class="fr">سام بلاستيك — factory<\/span>/);
  assert.match(html, /<span class="fc">شكراً لتعاملكم معنا<\/span>/);
  assert.doesNotMatch(html, /class="fl"/, 'الموضع الفارغ لا يُرسم');
});

test('بلا تذييل مُعدَّ لا يظهر شريط التذييل إطلاقاً', () => {
  const html = templates.invoiceTemplate(
    { ...doc, party_name: 'مورد', invoice_type: 'sale' }, { ...base, footer_right: '', footer_center: '', footer_left: '' });
  assert.doesNotMatch(html, /<div class="foot">/);
});

test('نصوص التذييل تُهرَّب من HTML مثل بقية الحقول', () => {
  const html = templates.receiveTemplate(doc, { ...base, footer_center: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('قوالب التقارير تمرر الإعدادات فتظهر العلامة والتذييل', () => {
  const html = templates.reportTemplate({ ...base, factory_phone: '123', footer_left: 'صفحة 1' },
    'تقرير الجرد', ['بند'], ['صنف'], [['x']]);
  assert.match(html, /<span class="tel">123<\/span>/);
  assert.match(html, /<span class="fl">صفحة 1<\/span>/);
});

test('قالب نتيجة الإنتاج يحمل الترويسة والتذييل معاً', () => {
  const html = templates.productionTemplate(
    { doc_number: 'K-1', doc_date: '2026-10-20', carton_number: 'C-1', pieces: 5000, good_pieces: 4500,
      defect_before: 300, defect_after: 200, notes: '', item_name: 'عبوة', issue_number: 'I-1', machine_name: 'م1', shift_name: 'ص' },
    { ...base, factory_phone: '999', footer_center: 'التوقيع' });
  assert.match(html, /class="brand"/);
  assert.match(html, /<span class="tel">999<\/span>/);
  assert.match(html, /<span class="fc">التوقيع<\/span>/);
});

// ------------------------------------------------------------------ الترقية

test('ترقية قاعدة قديمة: أعمدة الكسور والأكياس مع ترحيل الاستلام القديم بوحدة الكيس', () => {
  const { migrate } = require('../src/db');
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, full_name TEXT, password_hash TEXT, role TEXT, created_at TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, item_group INTEGER DEFAULT 2, unit_name TEXT DEFAULT 'حبة', weight_grams REAL, pieces_per_carton INTEGER, pieces_per_shadda INTEGER, pieces_per_bag INTEGER, qty_salem INTEGER DEFAULT 0, qty_talef INTEGER DEFAULT 0, qty_muharraz INTEGER DEFAULT 0, opening_warehouse_id INTEGER, service_price REAL, is_recycled INTEGER DEFAULT 0, brand TEXT, size_label TEXT, bale_size TEXT, bale_condition TEXT, bale_mixed INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE parties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, phone TEXT, address TEXT, notes TEXT, created_at TEXT);
    CREATE TABLE warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, location TEXT DEFAULT 'داخل المصنع', notes TEXT, created_at TEXT);
    CREATE TABLE machines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, notes TEXT);
    CREATE TABLE shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, notes TEXT);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE cartons (id INTEGER PRIMARY KEY AUTOINCREMENT, carton_number TEXT UNIQUE, item_id INTEGER, purchase_id INTEGER, pieces INTEGER, status TEXT DEFAULT 'in_stock', issue_date TEXT, issue_permit_id INTEGER, notes TEXT);
    CREATE TABLE issue_permits (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, machine_id INTEGER, shift_id INTEGER, receiver_name TEXT, source TEXT DEFAULT 'own', party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE issue_items (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_permit_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, carton_ids TEXT, notes TEXT);
    CREATE TABLE production_results (id INTEGER PRIMARY KEY AUTOINCREMENT, carton_id INTEGER, issue_permit_id INTEGER, machine_id INTEGER, shift_id INTEGER, result_date TEXT, good_pieces INTEGER DEFAULT 0, defect_before INTEGER DEFAULT 0, defect_after INTEGER DEFAULT 0, notes TEXT, created_by INTEGER, created_at TEXT);
    CREATE TABLE receive_permits (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, machine_id INTEGER, shift_id INTEGER, source TEXT DEFAULT 'own', party_id INTEGER, issue_permit_id INTEGER, receiver_name TEXT, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE receive_items (id INTEGER PRIMARY KEY AUTOINCREMENT, receive_permit_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT, bucket TEXT DEFAULT 'salem');
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, invoice_type TEXT, driver_name TEXT, car_number TEXT, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, unit_price REAL, total_price REAL, notes TEXT);
    CREATE TABLE exit_permits (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE exit_items (id INTEGER PRIMARY KEY AUTOINCREMENT, exit_permit_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE customer_raw_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE customer_raw_items (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER, item_id INTEGER, boxes INTEGER, pieces_per_box INTEGER, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE customer_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, invoice_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE customer_delivery_items (id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id INTEGER, item_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE scrap_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, item_id INTEGER, disposition TEXT, warehouse_id INTEGER, party_id INTEGER, pieces INTEGER, weight_kg REAL, price REAL, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE sales_returns (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, invoice_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE sales_return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE purchase_returns (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, purchase_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER, item_id INTEGER, warehouse_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, from_warehouse_id INTEGER, to_warehouse_id INTEGER, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE transfer_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER, item_id INTEGER, quantity REAL, unit TEXT, pieces INTEGER, weight_kg REAL, notes TEXT);
    CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, item_id INTEGER, warehouse_id INTEGER, qty_in_pieces INTEGER DEFAULT 0, qty_out_pieces INTEGER DEFAULT 0, weight_in_kg REAL DEFAULT 0, weight_out_kg REAL DEFAULT 0, notes TEXT);
    CREATE TABLE party_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER, doc_type TEXT, doc_id INTEGER, doc_number TEXT, doc_date TEXT, side TEXT, amount REAL DEFAULT 0, cash_in REAL DEFAULT 0, cash_out REAL DEFAULT 0, notes TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_number TEXT, doc_date TEXT, party_id INTEGER, direction TEXT, amount REAL DEFAULT 0, method TEXT, notes TEXT, status TEXT DEFAULT 'active', created_by INTEGER, created_at TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, before_json TEXT, after_json TEXT, at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin','م','x','manager')").run();
  d.prepare("INSERT INTO warehouses (name) VALUES ('رئيسي')").run();
  d.prepare("INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES ('002','عبوة',2,'عبوة',52,100)").run();
  d.prepare("INSERT INTO receive_permits (doc_number, doc_date, source, status) VALUES ('R-9','2026-01-01','own','active')").run();
  d.prepare("INSERT INTO receive_items (receive_permit_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg) VALUES (1,1,1,25,'كيس',2500,130)").run();
  d.prepare("INSERT INTO settings (key, value) VALUES ('currency','YER')").run();

  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);

  const r = d.prepare('SELECT * FROM receive_items').get();
  assert.equal(r.breaks, 0);
  assert.equal(r.bags_used, 25, 'قديم بوحدة الكيس: الأكياس المستهلكة = العدد المدون');
  assert.equal(r.bag_item_id, null);
  assert.deepEqual(d.prepare('PRAGMA table_info(items)').all().map(c => c.name).filter(n => n === 'bag_item_id'), ['bag_item_id']);
});

// الإعدادات: settings:save يمسح الجدول ويعيد الإدراج بما يُمرَّر — فالمفتاح الجديد يجب أن يبقى
test('إعدادات الهاتف والتذييل تدور بين الحفظ والقراءة وتظهر في الطباعة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['settings']);
  h['settings:save'](null, {
    factory_name: 'سام بلاستيك', factory_phone: '0500000000', currency: 'YER',
    doc_page_size: 'A5', report_page_size: 'A4', cloud_folder: '', factory_address: '',
    footer_right: 'سام بلاستيك', footer_center: 'شكراً لتعاملكم', footer_left: 'صفحة 1',
  }, 1);
  const s = h['settings:get']();
  assert.equal(s.factory_phone, '0500000000');
  assert.equal(s.footer_right, 'سام بلاستيك');
  assert.equal(s.footer_center, 'شكراً لتعاملكم');
  assert.equal(s.footer_left, 'صفحة 1');
  const html = templates.receiveTemplate(doc, s);
  assert.match(html, /<span class="tel">0500000000<\/span>/);
  assert.match(html, /<span class="fc">شكراً لتعاملكم<\/span>/);
});
