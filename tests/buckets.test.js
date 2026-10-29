const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { setDb } = require('../src/db');

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

test('جرد المخزون: أعمدة سليم/تالف/محرز تُحسب من حركات المخزن المحدد وليس من جدول الأصناف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, {
    code: '501', name: 'علبة صابون', unit_name: 'علبة',
    qty_salem: 5000, qty_talef: 100, qty_muharraz: 50,
  }, 1);
  // بدون فلترة: مجاميع كل المخازن تعادل أرصدة الصنف
  const all = h['reports:inventory'](null, {});
  const rowAll = all.find(r => r.id === id);
  assert.equal(rowAll.qty_salem, 5000);
  assert.equal(rowAll.qty_talef, 100);
  assert.equal(rowAll.qty_muharraz, 50);
  // فلترة بمخزن الصابون (لا حركات له): الصنف المنتهي لا يظهر في جرد المخزن
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  const soap = h['reports:inventory'](null, { warehouseId: soapWh });
  assert.ok(!soap.find(r => r.id === id), 'الصنف صفر الكمية لا يظهر في جرد المخزن المحدد');
  // فلترة بالمخزن الرئيسي (فيه الافتتاحي): تعادل أرصدة الصنف
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const main = h['reports:inventory'](null, { warehouseId: mainWh });
  const rowMain = main.find(r => r.id === id);
  assert.equal(rowMain.qty_salem, 5000);
  assert.equal(rowMain.qty_talef, 100);
  assert.equal(rowMain.qty_muharraz, 50);
});

test('النقل بين مخزنين ينقل تخصيص السليم مع الكمية', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports', 'transfers');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, {
    code: '502', name: 'علبة شامبو', unit_name: 'علبة', qty_salem: 1000, qty_talef: 0, qty_muharraz: 0,
  }, 1);
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  h['transfers:save'](null, {
    doc_number: 'نقل-1', doc_date: '2026-10-21',
    from_warehouse_id: mainWh, to_warehouse_id: soapWh,
    items: [{ item_id: id, quantity: 300, unit: 'علبة' }],
  }, 1);
  const main = h['reports:inventory'](null, { warehouseId: mainWh }).find(r => r.id === id);
  const soap = h['reports:inventory'](null, { warehouseId: soapWh }).find(r => r.id === id);
  assert.equal(main.qty_salem, 700);
  assert.equal(soap.qty_salem, 300);
  assert.equal(soap.balance_pieces, 300);
  // المجموع العام لا يتغير
  const all = h['reports:inventory'](null, {}).find(r => r.id === id);
  assert.equal(all.qty_salem, 1000);
});

test('سلة كل بند جزء من مخطط v2: افتراضها سليم وخردة البيع تالف ومرتجع البيع يرثها', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'purchases', 'sales', 'returns');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id } = h['items:save'](null, { code: '901', name: 'علبة', unit_name: 'حبة', qty_salem: 100, qty_talef: 100 }, 1);
  // بنود الاستلام القديمة لم تعد موجودة: السلة تُكتب في حركة المخزون لا في بند استلام
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table'
    AND name IN ('receive_items','receive_permits','production_results')`).get().c, 0, 'جداول v1 زالت');
  for (const t of ['purchase_items', 'issue_items', 'exit_items', 'transfer_items',
    'invoice_items', 'sales_return_items', 'purchase_return_items']) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;
    assert.match(sql, /bucket TEXT NOT NULL DEFAULT 'salem' CHECK/, `${t}: سلة إلزامية بقيدها`);
  }
  // بند بلا سلة صريحة = سليم
  h['purchases:save'](null, { doc_number: 'ش-1', doc_date: '2026-10-25',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة' }] }, 1);
  assert.equal(db.prepare('SELECT bucket FROM purchase_items').get().bucket, 'salem');
  // فاتورة خردة: سلة البنود تالف بلا تحديدها صراحة، ومرتجع البيع يرثها
  const { id: invId } = h['sales:save'](null, { doc_number: 'ف-1', doc_date: '2026-10-25', invoice_type: 'scrap',
    items: [{ item_id: id, warehouse_id: wh, quantity: 20, unit: 'حبة', unit_price: 1 }] }, 1);
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=?').get(invId).bucket, 'talef');
  h['returns:save'](null, { type: 'sale', doc_number: 'مر-1', doc_date: '2026-10-25', invoice_id: invId,
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة' }] }, 1);
  assert.equal(db.prepare('SELECT bucket FROM sales_return_items').get().bucket, 'talef', 'مرتجع البيع يرث سلة سطر الفاتورة');
  // القيد يرفض سلة غير معروفة على مستوى القاعدة
  assert.throws(() => db.prepare(`INSERT INTO invoice_items
    (invoice_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, bucket)
    VALUES (${invId}, ${id}, ${wh}, 1, 'حبة', 1, 0, 'bogus')`).run(), /CHECK/);
});

test('applyBucketsDelta تجمّع دلتا كل سلة لصنف مكرر بنود بسلات مختلفة', () => {
  const db = makeDb();
  db.prepare("INSERT INTO items (code, name, unit_name) VALUES ('902', 'عبوة', 'حبة')").run();
  const { applyBucketsDelta } = require('../src/stock');
  applyBucketsDelta(db, [
    { item_id: 1, pieces: 10, bucket: 'salem' },
    { item_id: 1, pieces: 4, bucket: 'talef' },
    { item_id: 1, pieces: 2, bucket: 'talef' },
    { item_id: 1, pieces: 1, bucket: 'muharraz' },
  ], 1);
  const it = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it.qty_salem, 10);
  assert.equal(it.qty_talef, 6);
  assert.equal(it.qty_muharraz, 1);
  // عكس الإشارة يعيد العدادات للصفر
  applyBucketsDelta(db, [{ item_id: 1, pieces: 10, bucket: 'salem' }, { item_id: 1, pieces: 6, bucket: 'talef' }, { item_id: 1, pieces: 1, bucket: 'muharraz' }], -1);
  const it2 = db.prepare('SELECT * FROM items WHERE id=1').get();
  assert.equal(it2.qty_salem + it2.qty_talef + it2.qty_muharraz, 0);
});

test('فاتورة شراء بسلات مختلفة تزيد كل عداد سلة على حدة وتنعكس عند الحذف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'purchases', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '601', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 0, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id: pid } = h['purchases:save'](null, {
    doc_number: 'ش-1', doc_date: '2026-10-25',
    items: [
      { item_id: id, warehouse_id: wh, quantity: 100, unit: 'حبة', unit_price: 10, bucket: 'salem' },
      { item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', unit_price: 0, bucket: 'talef' },
      { item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', unit_price: 0, bucket: 'muharraz' },
    ],
  }, 1);
  const inv = () => h['reports:inventory'](null, {}).find(r => r.id === id);
  assert.equal(inv().qty_salem, 100);
  assert.equal(inv().qty_talef, 30);
  assert.equal(inv().qty_muharraz, 5);
  const lines = db.prepare('SELECT bucket FROM purchase_items WHERE purchase_id=? AND item_id=? ORDER BY id').all(pid, id);
  assert.deepEqual(lines.map(l => l.bucket), ['salem', 'talef', 'muharraz']);
  // نافذة الأثر تعرض الثلاث سلات قبل التأكيد
  const imp = h['purchases:impact'](null, pid);
  assert.equal(imp.impact.length, 3);
  assert.deepEqual(imp.impact.map((r) => r.bucket).sort(), ['muharraz', 'salem', 'talef']);
  assert.deepEqual(imp.impact.map((r) => r.net).sort((a, b) => a - b), [5, 30, 100]);
  // حذف الفاتورة يعيد العدادات كلها للصفر ويمحو بنودها وحركاتها
  h['purchases:delete'](null, pid, 1);
  assert.equal(inv().qty_salem + inv().qty_talef + inv().qty_muharraz, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchases WHERE id=?').get(pid).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_items WHERE purchase_id=?').get(pid).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='purchase' AND doc_id=?").get(pid).c, 0);
});

test('صرف بند تالف يتجاوز الرصيد التالف يُرفض برسالة السلة وينعكس عند الحذف', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'issues');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '603', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 10, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['issues:save'](null, {
    doc_number: 'ص-1', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة', bucket: 'talef' }],
  }, 1), /غير كاف/);
  // صرف تالف ضمن المتاح ينجح ويخصم التالف فقط
  const { id: iid } = h['issues:save'](null, {
    doc_number: 'ص-2', doc_date: '2026-10-25', source: 'own',
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة', bucket: 'talef' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 5);
  // عكس الأثر: حذف التصريح يعيد التالف ويمحو حركته
  h['issues:delete'](null, iid, 1);
  assert.equal(db.prepare('SELECT qty_talef FROM items WHERE id=?').get(id).qty_talef, 10);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE doc_type='issue' AND doc_id=?").get(iid).c, 0);
  // والثبات: عداد كل سلة = صافي حركاتها
  const net = db.prepare(`SELECT bucket, COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n
    FROM stock_moves WHERE item_id=? GROUP BY bucket`).all(id);
  for (const key of ['salem', 'talef', 'muharraz']) {
    const r = net.find((x) => x.bucket === key);
    assert.equal(r ? r.n : 0, Number(db.prepare(`SELECT qty_${key} q FROM items WHERE id=?`).get(id).q),
      `ثبات سلة ${key} بعد الحذف`);
  }
});

test('خروج بند محرز يتجاوز الرصيد المحرز يُرفض والمحرز المتاح يخصم', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'exits');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '604', name: 'عبوة', unit_name: 'حبة', qty_salem: 50, qty_talef: 0, qty_muharraz: 20 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  assert.throws(() => h['exits:save'](null, {
    doc_number: 'خ-1', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', bucket: 'muharraz' }],
  }, 1), /غير كاف/);
  h['exits:save'](null, {
    doc_number: 'خ-2', doc_date: '2026-10-25', warehouse_id: wh, driver_name: 'أحمد',
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', bucket: 'muharraz' }],
  }, 1);
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 50);
  assert.equal(it.qty_muharraz, 10);
});

test('نقل بند تالف بين مخزنين ينقل السلة مع الكمية دون تغيير العدادات', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'reports', 'transfers');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  h['warehouses:save'](null, { name: 'مخزن الصابون' }, 1);
  const { id } = h['items:save'](null, { code: '605', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 500, qty_muharraz: 0 }, 1);
  const mainWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const soapWh = db.prepare("SELECT id FROM warehouses WHERE name='مخزن الصابون'").get().id;
  h['transfers:save'](null, {
    doc_number: 'نقل-2', doc_date: '2026-10-21',
    from_warehouse_id: mainWh, to_warehouse_id: soapWh,
    items: [{ item_id: id, quantity: 200, unit: 'حبة', bucket: 'talef' }],
  }, 1);
  const main = h['reports:inventory'](null, { warehouseId: mainWh }).find(r => r.id === id);
  const soap = h['reports:inventory'](null, { warehouseId: soapWh }).find(r => r.id === id);
  assert.equal(main.qty_talef, 300);
  assert.equal(soap.qty_talef, 200);
  // نقل تالف أكثر من المتاح يُرفض
  assert.throws(() => h['transfers:save'](null, {
    doc_number: 'نقل-3', doc_date: '2026-10-21',
    from_warehouse_id: soapWh, to_warehouse_id: mainWh,
    items: [{ item_id: id, quantity: 500, unit: 'حبة', bucket: 'talef' }],
  }, 1), /غير كاف/);
});

test('فاتورة خردة تخصم التالف افتراضياً وبيع بسلة مختلفة يخصم سلة البند', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'sales', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '606', name: 'عبوة', unit_name: 'حبة', qty_salem: 100, qty_talef: 100, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  h['sales:save'](null, {
    doc_number: 'ف-1', doc_date: '2026-10-25', invoice_type: 'scrap',
    items: [{ item_id: id, warehouse_id: wh, quantity: 20, unit: 'حبة', unit_price: 1 }],
  }, 1);
  let it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 80);
  // بيع يخصم سلة البند (تالف هنا) بدل السليم
  h['sales:save'](null, {
    doc_number: 'ف-2', doc_date: '2026-10-25', invoice_type: 'sale',
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', unit_price: 0.5, bucket: 'talef' }],
  }, 1);
  it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 100);
  assert.equal(it.qty_talef, 70);
});

test('مرتجع بيع لبند خردة يزيد التالف ومرتجع شراء يخصم السلة المختارة', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'sales', 'purchases', 'returns', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const { id } = h['items:save'](null, { code: '607', name: 'عبوة', unit_name: 'حبة', qty_salem: 0, qty_talef: 50, qty_muharraz: 0 }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id: invId } = h['sales:save'](null, {
    doc_number: 'ف-9', doc_date: '2026-10-25', invoice_type: 'scrap',
    items: [{ item_id: id, warehouse_id: wh, quantity: 50, unit: 'حبة', unit_price: 1 }],
  }, 1);
  // مرتجع بيع على فاتورة خردة بلا تحديد سلة يرث التالف من سطر الفاتورة
  const { id: rid } = h['returns:save'](null, {
    type: 'sale', doc_number: 'مر-1', doc_date: '2026-10-25', invoice_id: invId,
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة' }],
  }, 1);
  let it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_talef, 10);
  assert.equal(db.prepare('SELECT bucket FROM sales_return_items WHERE return_id=?').get(rid).bucket, 'talef');
  // مرتجع شراء بلا سلة محدد يفترض السليم ويخصمه بعد فحص كفايته
  const { id: pid } = h['purchases:save'](null, {
    doc_number: 'ش-9', doc_date: '2026-10-25',
    items: [{ item_id: id, warehouse_id: wh, quantity: 30, unit: 'حبة', bucket: 'salem' }],
  }, 1);
  h['returns:save'](null, {
    type: 'purchase', doc_number: 'مر-2', doc_date: '2026-10-25', purchase_id: pid,
    items: [{ item_id: id, warehouse_id: wh, quantity: 5, unit: 'حبة' }],
  }, 1);
  it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_salem, 25);
  assert.equal(it.qty_talef, 10);
});

test('فاتورة بيع (ترحيل) بسلة تالف محددة تُخصم التالف وتُحفظ السلة في البند', () => {
  const db = makeDb(); setDb(db);
  const h = stubIpc('warehouses', 'items', 'purchases', 'sales', 'reports');
  h['warehouses:save'](null, { name: 'المخزن الرئيسي' }, 1);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id;
  const { id } = h['items:save'](null, {
    code: '701', name: 'قنينة لتر', unit_name: 'حبة', qty_salem: 0, qty_talef: 0, qty_muharraz: 0,
  }, 1);
  // رصيد تالف 40 عبر شراء بسلة تالف
  h['purchases:save'](null, {
    doc_number: 'ش-10', doc_date: '2026-10-25',
    items: [{ item_id: id, warehouse_id: wh, quantity: 40, unit: 'حبة', unit_price: 1, bucket: 'talef' }],
  }, 1);
  // فاتورة بيع بسلة تالف محددة في البند
  const { id: invId } = h['sales:save'](null, {
    doc_number: 'INV-11', doc_date: '2026-10-25', invoice_type: 'sale', party_id: null,
    items: [{ item_id: id, warehouse_id: wh, quantity: 10, unit: 'حبة', unit_price: 2, bucket: 'talef' }],
  }, 1);
  assert.equal(db.prepare('SELECT bucket FROM invoice_items WHERE invoice_id=?').get(invId).bucket, 'talef');
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(it.qty_talef, 30);
  assert.equal(it.qty_salem, 0);
});
