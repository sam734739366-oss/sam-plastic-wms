const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');
const templates = require('../src/print/templates');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
    .run('admin', 'المدير', 'x', 'manager');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن الإنتاج التام');
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن المحرز');
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams, pieces_per_bag) VALUES (?,?,?,?,?,?)')
    .run('002-001', 'عبوة 5 لتر', 2, 'عبوة', 52, 100);
  d.prepare('INSERT INTO items (code, name, item_group, unit_name, weight_grams) VALUES (?,?,?,?,?)')
    .run('005-001', 'تالف عبوة', 5, 'حبة', 52);
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('مورد تجريبي', 'supplier');
  d.prepare("INSERT INTO parties (name, type) VALUES (?,?)").run('عميل تجريبي', 'customer');
  return d;
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) {
    require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  }
  return handlers;
}

function stockIn(db, h, warehouseId, itemId, pieces) {
  h['purchases:save'](null, {
    doc_number: `P-${Math.random().toString(36).slice(2, 8)}`, doc_date: '2026-10-18',
    items: [{ item_id: itemId, warehouse_id: warehouseId, quantity: pieces, unit: 'حبة' }]
  }, 1);
}

test('reports:inventory returns balances with labels and warehouse filter', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  stockIn(db, h, 1, 1, 1500);
  const all = h['reports:inventory'](null, {});
  const row = all.find(r => r.id === 1);
  assert.equal(row.balance_pieces, 1500);
  assert.ok(row.balance_label.includes('عبوة'));
  const wh = h['reports:inventory'](null, { warehouseId: 2 });
  assert.ok(!wh.find(r => r.id === 1), 'الصنف صفر الكمية لا يظهر في جرد المخزن المحدد');
  // الصنف ذو الرصيد في المخزن يظهر
  stockIn(db, h, 2, 2, 300);
  assert.equal(h['reports:inventory'](null, { warehouseId: 2 }).find(r => r.id === 2).balance_pieces, 300);
});

test('reports:inventory excludes complement items', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  db.prepare('UPDATE items SET is_complement=1 WHERE id=2').run();
  stockIn(db, h, 1, 1, 1500);
  stockIn(db, h, 1, 2, 300);
  const all = h['reports:inventory'](null, {});
  assert.ok(all.find(r => r.id === 1));
  assert.ok(!all.find(r => r.id === 2));
});

test('reports:inventory يعرض أسماء الموردين والعملاء لكل صنف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'reports']);
  // شراء الصنف 1 من المورد 1 ثم بيعه للعميل 2
  h['purchases:save'](null, {
    doc_number: 'P-SUP', doc_date: '2026-10-18', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1000, unit: 'حبة' }],
  }, 1);
  h['sales:save'](null, {
    doc_number: 'S-CUS', doc_date: '2026-10-19', invoice_type: 'sale', party_id: 2,
    payment_method: 'credit',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 10 }],
  }, 1);
  const row = h['reports:inventory'](null, {}).find(r => r.id === 1);
  assert.ok(String(row.suppliers || '').includes('مورد تجريبي'), `الموردون: ${row.suppliers}`);
  assert.ok(String(row.customers || '').includes('عميل تجريبي'), `العملاء: ${row.customers}`);
  // صنف بلا تعاملات تبقى حقوله فارغة
  const row2 = h['reports:inventory'](null, {}).find(r => r.id === 2);
  assert.ok(!row2.suppliers && !row2.customers);
});

test('reports:movement computes running balance in date order', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'reports']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-10',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 1000, unit: 'حبة' }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-12', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 400, unit: 'حبة', unit_price: 10 }]
  }, 1);
  const rows = h['reports:movement'](null, { itemId: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].balance_pieces, 1000);
  assert.equal(rows[1].balance_pieces, 600);
  assert.equal(rows[1].doc_type, 'invoice');
});

test('reports:production lists per-carton rows with accounted and variance', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'issues', 'production', 'reports']);
  db.prepare('UPDATE items SET pieces_per_carton=100 WHERE id=1').run();
  const { id: purchaseId } = h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-10', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'KR' }]
  }, 1);
  const cartons = db.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(purchaseId);
  assert.equal(cartons.length, 2);
  const { id: issueId } = h['issues:save'](null, {
    doc_number: 'I-1', doc_date: '2026-10-11', source: 'own',
    items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_ids: cartons.map(c => c.carton_number) }]
  }, 1);
  assert.equal(issueId > 0, true);
  h['production:save'](null, {
    carton_id: cartons[0].id, result_date: '2026-10-11',
    good_pieces: 90, defect_before: 5, defect_after: 4
  }, 1);
  const data = h['reports:production'](null, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(data.rows.length, 1);
  const row = data.rows[0];
  assert.equal(row.carton_number, cartons[0].carton_number);
  assert.equal(row.carton_pieces, 100);
  assert.equal(row.accounted, 99);
  assert.equal(row.variance, 1, 'الفارق = حبات الكرتون − (سليم + تالف قبل + تالف بعد)');
  assert.equal(row.good_pieces_label, '90 حبة');
  assert.equal(data.total_good, 90);
  assert.equal(data.total_defect, 9);
  assert.equal(data.total_variance, 1);
  assert.equal(h['reports:production'](null, { from: '2026-11-01' }).rows.length, 0);
});

test('reports:scrap lists active scrap rows with a source label', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'scrap', 'reports']);
  stockIn(db, h, 1, 2, 300);
  h['scrap:save'](null, {
    doc_number: 'S-1', doc_date: '2026-10-15', item_id: 2,
    disposition: 'to_recycled', warehouse_id: 1, pieces: 50, weight_kg: 2.6
  }, 1);
  const data = h['reports:scrap'](null, {});
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].disposition, 'to_recycled');
  assert.equal(data.rows[0].qty, 50);
  assert.equal(data.rows[0].source_label, 'سند يدوي', 'غير مرتبط بأي نتيجة إنتاج');
  assert.equal(data.total_qty, 50);
});

test('reports:purchases (item lines) and reports:sales (value per line) totals', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'reports']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-10', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 5 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-12', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 40, unit: 'حبة', unit_price: 12 }]
  }, 1);
  const p = h['reports:purchases'](null, { from: '2026-10-01' });
  assert.equal(p.rows.length, 1, 'سطر لكل بند صنف، لا لكل فاتورة');
  assert.equal(p.rows[0].qty, 100);
  assert.equal(p.rows[0].party_name, 'مورد تجريبي');
  assert.equal(p.rows[0].doc_number, 'P-1');
  assert.equal(p.total_qty, 100);
  assert.equal(p.total_qty_label, '100 حبة');
  const s = h['reports:sales'](null, { from: '2026-10-01' });
  assert.equal(s.total, 480);
  assert.equal(s.rows[0].qty, 40);
  assert.equal(s.rows[0].value, 480);
  assert.equal(h['reports:sales'](null, { partyId: 1 }).rows.length, 0);
});

test('reports:audit returns audit rows with user name', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'reports']);
  stockIn(db, h, 1, 1, 100);
  const rows = h['reports:audit'](null, { from: '2026-10-01' });
  assert.ok(rows.length >= 1);
  const top = rows[0];
  assert.equal(top.entity, 'purchase');
  assert.equal(top.user_name, 'المدير');
  assert.equal(h['reports:audit'](null, { userId: 999 }).length, 0);
});

test('reports:partyStatement lists invoices as debit and purchases as credit', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'reports']);
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: '2026-10-10', party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 5 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: '2026-10-12', invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 40, unit: 'حبة', unit_price: 12 }]
  }, 1);
  const sup = h['reports:partyStatement'](null, { partyId: 1 });
  assert.equal(sup.party.name, 'مورد تجريبي');
  assert.equal(sup.total_credit, 500);
  assert.equal(sup.total_debit, 0);
  assert.equal(sup.net, 500);
  const cust = h['reports:partyStatement'](null, { partyId: 2 });
  assert.equal(cust.total_debit, 480);
  assert.equal(cust.net, -480);
  assert.equal(cust.rows[0].label, 'فاتورة بيع');
  assert.throws(() => h['reports:partyStatement'](null, {}), /اختر الطرف/);
});

test('dashboard:summary reports counts, buckets and month totals without groups', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc(['purchases', 'sales', 'scrap', 'dashboard']);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  h['purchases:save'](null, {
    doc_number: 'P-1', doc_date: todayStr, party_id: 1,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 5 }]
  }, 1);
  h['sales:save'](null, {
    doc_number: '1', doc_date: todayStr, invoice_type: 'sale', party_id: 2,
    items: [{ item_id: 1, warehouse_id: 1, quantity: 20, unit: 'حبة', unit_price: 12 }]
  }, 1);
  const s = h['dashboard:summary']();
  assert.equal(s.items_count, 2);
  assert.equal(s.salem_pieces, 80);
  assert.equal(s.talef_pieces, 0);
  assert.equal(s.muharraz_pieces, 0);
  assert.equal(s.today_docs, 2);
  assert.equal(s.month_purchases, 500);
  assert.equal(s.month_sales, 240);
  assert.equal(s.pending_cartons, 0);
});

test('print templates escape values and use factory settings', () => {
  const settings = { factory_name: 'مصنع سام بلاستيك', doc_page_size: 'A5' };
  const doc = {
    doc_number: 'P-1', doc_date: '2026-10-10', party_name: 'مورد <b>غريب</b>',
    notes: '<script>alert(1)</script>',
    items: [{ code: '002-001', name: 'عبوة 5 لتر', quantity: 10, unit: 'كرتون', pieces: 1000, weight_kg: 52, unit_price: 500, total_price: 5000 }]
  };
  const html = templates.purchaseTemplate(doc, settings);
  assert.ok(html.includes('مصنع سام بلاستيك'));
  assert.ok(html.includes('فاتورة شراء'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<b>غريب</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('المستلم'));
  // العملة الافتراضية ريال يمني وتظهر بالرمز
  assert.ok(html.includes('ر.ي'));
  const sar = templates.purchaseTemplate(doc, { ...settings, currency: 'SAR' });
  assert.ok(sar.includes('ر.س'));
  const usd = templates.purchaseTemplate(doc, { ...settings, currency: 'USD' });
  assert.ok(usd.includes('$'));
  // ترويسة الديزاين الجديد (كحلي)
  assert.ok(html.includes('#1e3a8a'));
  const report = templates.reportTemplate(settings, 'جرد', ['تاريخ: 2026-10-10'], ['الصنف', 'الرصيد'], [['عبوة', '100']]);
  assert.ok(report.includes('جرد'));
  assert.ok(!report.includes('المستلم'));
  const issue = templates.issueTemplate({ doc_number: 'I-1', doc_date: '2026-10-11', machine_name: 'مكينة 1', shift_name: 'صباح', items: [{ code: '002-001', name: 'عبوة', quantity: 1, unit: 'كرتون', pieces: 100, weight_kg: 5.2, carton_ids: ['KR-001'] }] }, settings);
  assert.ok(issue.includes('KR-001'));
  assert.ok(issue.includes('مكينة 1'));
});
