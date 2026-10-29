const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const { getBalance } = require('../src/stock');
const templates = require('../src/print/templates');

// صنف 1: إنتاج تام مربوط بأكياس (صنف الأكياس 3) — كيس = 100 حبة
// صنف 2: إنتاج تام بلا ربط أكياس | صنف 3: الأكياس الفارغة (تُخصم منه)
// صنف 4: خام يُشترى بكراتين (10000 حبة/كرتون) ليُصرف ثم يُستلم إنتاجه
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
  d.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_carton)
    VALUES (?,?,?,?,?,?)`).run('X1', 'حبيبة PET', 1, 'كجم', 2.6, 10000);
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
const head = (db, id) => db.prepare('SELECT * FROM production_receipts WHERE id=?').get(id);
const movesOf = (db, id) => db.prepare("SELECT * FROM stock_moves WHERE doc_type='production' AND doc_id=? ORDER BY id").all(id);

function stockBags(h, db, qty) {
  h['purchases:save'](null, { doc_number: 'PB-1', doc_date: '2026-10-19',
    items: [{ item_id: 3, warehouse_id: 1, quantity: qty, unit: 'حبة' }] }, 1);
}

// شراء كراتين خام المصنع وصرفها للإنتاج: يعيد السند والتصريح والكراتين
let ownSeq = 0;
function issueOwn(h, db, n = 1, over = {}) {
  ownSeq += 1;
  const purchaseNo = over.purchaseNo || `P-${ownSeq}`;
  const issueNo = over.issueNo || `I-${ownSeq}`;
  h['purchases:save'](null, { doc_number: purchaseNo, doc_date: '2026-10-19',
    items: [{ item_id: 4, warehouse_id: 1, quantity: n, unit: 'كرتون', carton_prefix: over.prefix || `K${ownSeq}-` }] }, 1);
  const purchaseId = db.prepare('SELECT id FROM purchases WHERE doc_number=?').get(purchaseNo).id;
  const cartons = db.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(purchaseId);
  const iss = h['issues:save'](null, { doc_number: issueNo, doc_date: '2026-10-19', source: 'own',
    items: [{ item_id: 4, warehouse_id: 1, quantity: n, unit: 'كرتون',
      carton_ids: cartons.map((c) => c.carton_number) }] }, 1);
  return { issueId: iss.id, cartons };
}

// تصريح صرف من خام عميل: كراتين C- من سند خامه
function issueCustomer(h, db, n = 1) {
  h['tolling:receiptSave'](null, { doc_number: 'TR-1', doc_date: '2026-10-19', party_id: 1,
    items: [{ item_id: 4, quantity: n * 10000, unit: 'حبة' }] }, 1);
  const cartons = db.prepare("SELECT * FROM cartons WHERE source='customer' ORDER BY id").all();
  const iss = h['issues:save'](null, { doc_number: 'I-C', doc_date: '2026-10-19', source: 'customer', party_id: 1,
    items: [{ item_id: 4, warehouse_id: 1, quantity: n, unit: 'كرتون',
      carton_ids: cartons.map((c) => c.carton_number) }] }, 1);
  return { issueId: iss.id, cartons };
}

// سند استلام الإنتاج: الأكياس على رأسه والنتيجة على كراتينه
function receiveOwn(h, db, opts = {}) {
  const ctx = opts.ctx || issueOwn(h, db, 1);
  const { id } = h['production:save'](null, {
    doc_number: opts.number || 'R-1', doc_date: '2026-10-20', issue_permit_id: ctx.issueId,
    fg_item_id: opts.itemId || 1, warehouse_id: 1, bags: opts.bags, breaks: opts.breaks,
    cartons: [{ carton_id: (opts.carton || ctx.cartons[0]).id,
      good_pieces: opts.good == null ? 10000 : opts.good,
      defect_before_pieces: opts.before || 0, defect_after_pieces: opts.after || 0 }],
  }, 1);
  return { id, row: head(db, id), ctx };
}

// ------------------------------------------------------------------ حساب الكسور

test('الكمية بالحبات = مكتملة × حبات/كيس + كسور، والأكياس المستهلكة = سقف القسمة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(h, db, { bags: 80, breaks: 40 });
  assert.equal(row.bags, 80, 'العدد المدوّن يبقى عدد الأكياس المكتملة');
  assert.equal(row.breaks, 40);
  assert.equal(row.bags_used, 81, 'ceil((80×100+40)/100): كيس للكسور');
  assert.equal(row.bag_item_id, 3, 'صنف الأكياس يُخزَّن في رأس السند لعكسه بدقة');
  assert.equal(row.good_pieces, 10000, 'الأكياس لا تُخصم من حبات التام المستلَم');
  assert.equal(salem(db, 3), 919, '1000 - 81');
});

test('بلا كسور ⇒ الأكياس المستهلكة = عدد الأكياس', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { row } = receiveOwn(h, db, { bags: 80, breaks: 0 });
  assert.equal(row.breaks, 0);
  assert.equal(row.bags_used, 80);
  assert.equal(salem(db, 3), 920);
});

test('كسور تساوي أو تتجاوز حبات الكيس تُدمج في أكياس كاملة بدل أن تضيع', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { row, id } = receiveOwn(h, db, { bags: 2, breaks: 250 }); // 450 حبة
  assert.equal(row.bags, 2);
  assert.equal(row.breaks, 250);
  assert.equal(row.bags_used, 5, 'ceil(450/100) = 5');
  assert.equal(salem(db, 3), 995);
  assert.equal(salem(db, 1), 10000, 'سلّة التام المستلَم لا تتأثر بالتغليف');
  assert.equal(movesOf(db, id)[1].qty_out_pieces, 5);
});

test('كسور أو أكياس بصنف نهائي بلا «حبات/كيس» تُرفض برسالة تدل على العلاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  db.prepare(`INSERT INTO items (code, name, item_group, unit_name, weight_grams)
    VALUES ('009','صنف بلا كيس',2,'عبوة',10)`).run();
  assert.throws(() => receiveOwn(h, db, { itemId: 5, bags: 5, breaks: 10 }), /عدد القطع في الكيس/);
  assert.throws(() => receiveOwn(h, db, { itemId: 5, bags: 5 }), /عدد القطع في الكيس/);
  assert.equal(salem(db, 5), 0, 'لم يُسجَّل السند أصلاً');
  assert.equal(salem(db, 3), 1000, 'ولا مسّت الأكياس');
});

test('أكياس تتجاوز التام السليم مرفوضة: التغليف فرع من المستلَم لا أصل له', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  assert.throws(() => receiveOwn(h, db, { bags: 101, breaks: 0, good: 10000 }), /تتجاوز/);
  assert.equal(salem(db, 1), 0);
  assert.equal(salem(db, 3), 1000);
});

// ------------------------------------------------------------------ خصم الأكياس

test('استلام إنتاج المصنع يخصم الأكياس المستهلكة من رصيد صنف الأكياس', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { id, row } = receiveOwn(h, db, { bags: 80, breaks: 40 });
  assert.equal(row.bag_item_id, 3);
  assert.equal(salem(db, 3), 919, '1000 - 81');
  assert.equal(salem(db, 1), 10000, 'سلّة الصنف المستلم');
  const mv = movesOf(db, id);
  assert.equal(mv.length, 2);
  assert.deepEqual([mv[0].item_id, mv[0].qty_in_pieces, mv[0].bucket], [1, 10000, 'salem']);
  assert.deepEqual([mv[1].item_id, mv[1].qty_out_pieces, mv[1].bucket], [3, 81, 'salem']);
  assert.match(mv[1].notes, /استهلاك أكياس لتعبئة 002/);
  // الثبات: العدّاد = صافي الحركات لكل صنف × سلة
  const net = db.prepare(`SELECT item_id, bucket,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n
    FROM stock_moves GROUP BY item_id, bucket`).all();
  for (const it of db.prepare('SELECT * FROM items').all()) {
    for (const key of ['salem', 'talef', 'muharraz']) {
      const r = net.find((x) => x.item_id === it.id && x.bucket === key);
      assert.equal(r ? r.n : 0, Number(it[`qty_${key}`]) || 0, `سلة ${key} للصنف ${it.code}`);
    }
  }
});

test('صنف غير مربوط بأكياس: تدوين الأكياس مرفوض برسالة الربط', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  assert.throws(() => receiveOwn(h, db, { itemId: 2, bags: 10, breaks: 5 }), /غير مربوط بصنف أكياس/);
  assert.equal(salem(db, 3), 1000, 'لم يُمسّ رصيد الأكياس');
  assert.equal(salem(db, 2), 0, 'ولم يُسجَّل السند');
  // بلا أكياس إطلاقاً السند يمرّ
  const { row } = receiveOwn(h, db, { itemId: 2, number: 'R-2' });
  assert.equal(row.bags_used, 0);
  assert.equal(row.bag_item_id, null);
});

test('رصيد الأكياس غير كافٍ ⇒ رفض السند وعدم تحريك سلّة الإنتاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 5);
  assert.throws(() => receiveOwn(h, db, { bags: 80, breaks: 40 }), /رصيد الأكياس غير كافٍ/);
  assert.equal(salem(db, 1), 0, 'لم يُسجَّل الاستلام أصلاً');
  assert.equal(salem(db, 3), 5);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts').get().c, 0);
});

test('تعديل السند يعكس الأكياس القديمة ويخصم الجديدة بلا ازدواج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { id, ctx } = receiveOwn(h, db, { bags: 80, breaks: 40 });   // −81
  assert.equal(salem(db, 3), 919);
  h['production:save'](null, { id, doc_number: 'R-1', doc_date: '2026-10-20', issue_permit_id: ctx.issueId,
    fg_item_id: 1, warehouse_id: 1, bags: 80, breaks: 0,
    cartons: [{ carton_id: ctx.cartons[0].id, good_pieces: 10000, defect_before_pieces: 0, defect_after_pieces: 0 }] }, 1);
  assert.equal(salem(db, 3), 920, '1000 - 80: رُدّت 81 ثم خُصمت 80');
  assert.equal(salem(db, 1), 10000, 'أثر التام طُبّق مرة واحدة');
  const r = head(db, id);
  assert.equal(r.bags_used, 80);
  assert.equal(r.breaks, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipt_cartons WHERE receipt_id=?').get(id).c, 1,
    'سطر كرتون واحد بعد التعديل');
  // عكس الأكياس لا يُطبّق مرتين: الحركة الأصلية + حركتها المعكوسة ثم الجديدة
  const bagMoves = movesOf(db, id).filter((m) => m.item_id === 3);
  assert.equal(bagMoves.reduce((s, m) => s + (m.qty_in_pieces || 0) - (m.qty_out_pieces || 0), 0), -80,
    'صافي حركات الأكياس = الخصم الجديد وحده');
});

test('حذف السند يُرجع الأكياس إلى مخزنها ويمحى أثر الإنتاج', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production']);
  stockBags(h, db, 1000);
  const { id } = receiveOwn(h, db, { bags: 80, breaks: 40 });
  const res = h['production:delete'](null, id, 1);
  assert.equal(res.ok, true);
  assert.equal(salem(db, 3), 1000, 'عودة كاملة');
  assert.equal(salem(db, 1), 0);
  assert.equal(movesOf(db, id).length, 0, 'حركات السند مُمحية لا معكوسة بصفوف');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM production_receipts WHERE id=?').get(id).c, 0);
  assert.equal(getBalance(db, 3, 1).qty_salem, 1000);
});

test('خام العميل يخصم الأكياس كذلك — فهي ملك المصنع بلا النظر عن مالك الخام', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'tolling', 'scrap']);
  stockBags(h, db, 1000);
  const ctx = issueCustomer(h, db, 1);
  const { id, row } = receiveOwn(h, db, { bags: 30, breaks: 10, ctx, number: 'R-C' });
  assert.equal(row.bags_used, 31);
  assert.equal(row.bag_item_id, 3, 'الخصم يسري على خام العميل أيضًا');
  assert.equal(salem(db, 3), 969, '1000 - 31');
  assert.equal(salem(db, 1), 0, 'أما إنتاج خام العميل فلا يدخل مخزون المصنع');
  const mv = movesOf(db, id);
  assert.equal(mv.length, 1, 'حركة واحدة: استهلاك الأكياس فقط');
  assert.deepEqual([mv[0].item_id, mv[0].qty_out_pieces], [3, 31]);
  assert.equal(salem(db, 4), 0, 'خام العميل لا يمسّ سليم المصنع');
  // وحذفه يُرجع الأكياس
  h['production:delete'](null, id, 1);
  assert.equal(salem(db, 3), 1000);
});

test('المصدر موروث من التصريح: استهلاك الأكياس لا يتغيّر بين خام المصنع وخام العميل', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'tolling', 'scrap']);
  stockBags(h, db, 1000);
  const own = receiveOwn(h, db, { bags: 30, breaks: 10 });
  assert.equal(salem(db, 3), 969);
  assert.equal(own.row.source, 'own');
  assert.equal(own.row.party_id, null);
  const cust = receiveOwn(h, db, { bags: 30, breaks: 10, number: 'R-2', ctx: issueCustomer(h, db, 1) });
  assert.equal(salem(db, 3), 938, '31 كيساً في كل سند بلا نظر للمصدر');
  assert.equal(cust.row.source, 'customer', 'المصدر من التصريح لا من الواجهة');
  assert.equal(cust.row.party_id, 1);
  assert.equal(cust.row.bag_item_id, 3);
  assert.equal(head(db, own.id).bags_used, 31);
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

const doc = {
  doc_number: 'R-1', doc_date: '2026-10-20', notes: '', source: 'own', issue_number: 'I-1',
  fg_code: '002', fg_name: 'عبوة 5 لتر', unit_name: 'عبوة', warehouse_name: 'التام',
  issued_pieces: 10040, good_pieces: 10000, defect_before_pieces: 40, defect_after_pieces: 0,
  total_pieces: 10040, variance_pieces: 0, surplus_pieces: 0, bags_used: 81,
  cartons: [{ carton_number: 'K-1', raw_code: 'X1', raw_name: 'حبيبة PET', carton_pieces: 10040,
    good_pieces: 10000, defect_before_pieces: 40, defect_after_pieces: 0 }],
  machine_name: 'م1', shift_name: 'صباحية',
};
const base = { factory_name: 'سام بلاستيك', currency: 'YER', doc_page_size: 'A5' };

test('ترويسة الطباعة تحمل اسم التطبيق ورقم الهاتف في شريط ثابت يُعاد على كل صفحة', () => {
  const html = templates.productionReceiptTemplate(doc, { ...base, factory_phone: '0551234567' });
  assert.match(html, /<div class="lhead"><span class="brand">سام بلاستيك<\/span>/);
  assert.match(html, /<span class="tel">0551234567<\/span>/);
  // الثبّت هو ما يجعل Chromium يعيد الرسم على كل صفحة فيزيائية عند تقاطع المستند
  assert.match(html, /\.lhead \{ position: fixed; top: 0/);
  assert.match(html, /\.foot \{ position: fixed; bottom: 0/);
  assert.match(html, /body \{[^}]*padding: 8mm 0 7mm/);  // مساحة حتى لا يغطي الشريط المحتوى
  assert.match(html, /thead \{ display: table-header-group/);   // رؤوس الأعمدة تتكرر هي الأخرى
});

test('قالب سند الإنتاج يطبع نتيجة كل كرتون والفارق والأكياس المستهلكة', () => {
  const html = templates.productionReceiptTemplate(doc, base);
  assert.match(html, /<th>#<\/th><th>الكرتون<\/th><th>الخام<\/th><th>حبات الكرتون<\/th><th>سليم<\/th><th>تالف قبل<\/th><th>تالف بعد<\/th>/);
  assert.match(html, /<td>1<\/td><td>K-1<\/td>/, 'سطر الكرتون بقيمتيه');
  assert.match(html, /<td>10,040<\/td><td>10,000<\/td><td>40<\/td><td>0<\/td>/);
  assert.match(html, /الأكياس المستهلكة<\/td><td><b>81<\/b>/, 'الأكياس من رأس السند');
  assert.match(html, /<b>تسوية مطابقة<\/b>/, 'الحالة تُقرأ من الفارق');
  assert.match(html, /تصريح الصرف/);

  const shortDoc = { ...doc, variance_pieces: 40, total_pieces: 10000, issued_pieces: 10040, bags_used: 0 };
  const html2 = templates.productionReceiptTemplate(shortDoc, base);
  assert.match(html2, /<b>عجز 40<\/b>/);
  assert.match(html2, /<b>عجز تسوية<\/b>/);
  assert.match(html2, /الأكياس المستهلكة<\/td><td><b>0<\/b>/, 'بلا تغليف = صفر معلن لا سطر مخفي');

  const overDoc = { ...doc, variance_pieces: -60, surplus_pieces: 60, good_pieces: 10060, total_pieces: 10100 };
  const html3 = templates.productionReceiptTemplate(overDoc, base);
  assert.match(html3, /<b>فائض 60<\/b>/);
  assert.match(html3, /يُضاف للتام السليم<\/td><td><b>60<\/b>/);
});

test('بلا هاتف لا تُرسم خانة فارغة، ولا يظهر «undefined»', () => {
  const html = templates.productionReceiptTemplate(doc, base);
  assert.doesNotMatch(html, /class="tel"/);
  assert.match(html, /<span class="brand">سام بلاستيك<\/span>/);
  assert.doesNotMatch(html, /undefined|null/);
});

test('التذييل الديناميكي يرسم المواضع الثلاثة ويُهمل الفارغ منها', () => {
  const html = templates.productionReceiptTemplate(doc, {
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
  const html = templates.productionReceiptTemplate(doc, { ...base, footer_center: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('قوالب التقارير تمرر الإعدادات فتظهر العلامة والتذييل', () => {
  const html = templates.reportTemplate({ ...base, factory_phone: '123', footer_left: 'صفحة 1' },
    'تقرير الجرد', ['بند'], ['صنف'], [['x']]);
  assert.match(html, /<span class="tel">123<\/span>/);
  assert.match(html, /<span class="fl">صفحة 1<\/span>/);
});

test('قالب سند الإنتاج يحمل الترويسة والتذييل معاً', () => {
  const html = templates.productionReceiptTemplate(
    { ...doc, doc_number: 'K-1', source: 'customer', party_name: 'عميل' },
    { ...base, factory_phone: '999', footer_center: 'التوقيع' });
  assert.match(html, /class="brand"/);
  assert.match(html, /<span class="tel">999<\/span>/);
  assert.match(html, /<span class="fc">التوقيع<\/span>/);
  assert.match(html, /خام العميل — عميل \(عهدة\)/, 'المصدر والعميل مطبوعان في السند');
});

// ------------------------------------------------------------------ المخطط

test('مخطط v2: رأس سند الإنتاج يحمل الأكياس وكسورها وصنفها بقيم افتراضية', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  const cols = d.prepare('PRAGMA table_info(production_receipts)').all().map((c) => c.name);
  for (const need of ['bags', 'breaks', 'bags_used', 'bag_item_id', 'issued_pieces', 'good_pieces',
    'defect_before_pieces', 'defect_after_pieces', 'total_pieces', 'variance_pieces', 'surplus_pieces']) {
    assert.ok(cols.includes(need), `عمود ${need} مفقود من رأس السند`);
  }
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('a','a','x','manager')").run();
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('رئيسي');
  d.prepare('INSERT INTO items (code, name, unit_name) VALUES (?,?,?)').run('002', 'عبوة', 'عبوة');
  d.prepare("INSERT INTO issue_permits (doc_number, doc_date) VALUES ('I-1','2026-10-20')").run();
  d.prepare(`INSERT INTO production_receipts (doc_number, doc_date, issue_permit_id, fg_item_id, warehouse_id)
    VALUES ('R-1','2026-10-20',1,1,1)`).run();
  const r = d.prepare('SELECT * FROM production_receipts WHERE id=1').get();
  for (const k of ['bags', 'breaks', 'bags_used', 'issued_pieces', 'good_pieces', 'variance_pieces']) {
    assert.equal(r[k], 0, `${k} يفتقر إلى صفر لا إلى null`);
  }
  assert.equal(r.bag_item_id, null);
  // السلة لا تعيش في بنود استلام بعد اليوم: لا جدول receive_items ولا عمود status
  assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('receive_items','receive_permits','production_results')").get().c, 0);
  assert.deepEqual(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%status TEXT%'")
    .all().map((t) => t.name), ['cartons'], 'cartons.status الاستثناء الوحيد');
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
  const html = templates.productionReceiptTemplate(doc, s);
  assert.match(html, /<span class="tel">0500000000<\/span>/);
  assert.match(html, /<span class="fc">شكراً لتعاملكم<\/span>/);
});
