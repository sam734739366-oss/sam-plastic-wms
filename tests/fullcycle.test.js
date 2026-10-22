const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setDb, migrate, repairOpenings } = require('../src/db');
const ledger = require('../src/ledger');
const { getBalance } = require('../src/stock');

// دورة كاملة على نسخة من القاعدة الحية: إصلاح الأرصدة الافتتاحية ثم تنفيذ كل
// العمليات المخزنية والمحاسبية عبر المعالجات الحقيقية مع فحص التطابق في كل مرحلة:
//   عداد الصنف (سليم/تالف/محرز) == صافي حركات المخزون للسلة نفسها.

function liveCopy() {
  const live = path.join(__dirname, '..', 'data', 'samplastic.db');
  const tmp = path.join(os.tmpdir(), `fullcycle-${process.pid}-${Date.now()}.db`);
  const src = new DatabaseSync(live, { readOnly: true });
  src.exec(`VACUUM INTO '${tmp.replace(/\\/g, '/')}'`);
  src.close();
  const d = new DatabaseSync(tmp);
  d.exec('PRAGMA foreign_keys = ON');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  migrate(d);
  return { d, tmp };
}

function stubIpc(files) {
  const handlers = {};
  for (const f of files) require(`../src/handlers/${f}`)({ handle: (ch, fn) => { handlers[ch] = fn; } });
  return handlers;
}

const counters = (db, id) => db.prepare('SELECT qty_salem s, qty_talef t, qty_muharraz m FROM items WHERE id=?').get(id);

// ثبات رئيسي: كل عداد سلة == صافي حركات المخزون لهذه السلة (بكل المخازن)
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

test('إصلاح الأرصدة الافتتاحية: مصححة في القاعدة الحية ويعيد بناء أي تضخم قديم', () => {
  const { d, tmp } = liveCopy();
  try {
    setDb(d);
    // القاعدة الحية بعد الإصلاح: الافتتاح = العداد − صافي العمليات
    const salem1 = d.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0) s FROM stock_moves
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).get().s;
    assert.equal(salem1, 128520, 'الافتتاح الحالي للصنف 001001 مصحح (128520)');
    const w = d.prepare(`SELECT weight_in_kg w FROM stock_moves
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).get().w;
    assert.ok(Math.abs(w - 128520 * 20.5 / 1000) < 0.001, 'وزن الافتتاح محسوب من وزن الحبة');
    assertConsistent(d, 'الأساس المصحح');
    // الإصلاح تكراراً لا يغيّر قاعدة سليمة
    assert.equal(repairOpenings(d).changed.length, 0, 'الإصلاح لا يغيّر قاعدة سليمة');
    // محاكاة خطأ الترحيل القديم (الافتتاح = العداد الكامل شاملاً العمليات) ثم الإصلاح يعيده
    d.prepare(`UPDATE stock_moves SET qty_in_pieces = 244188, weight_in_kg = 244188 * 20.5 / 1000
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).run();
    const { changed } = repairOpenings(d);
    assert.deepEqual(changed, [
      { item_id: 1, item_code: '001001', bucket: 'salem', old_qty: 244188, new_qty: 128520 },
    ], 'الإصلاح يعيد الافتتاح المتضخم إلى العداد ناقص صافي العمليات');
    assertConsistent(d, 'بعد إعادة الإصلاح');
  } finally {
    d.close();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});

test('الدورة الكاملة للعمليات المخزنية والمحاسبية على نسخة القاعدة الحية', () => {
  const { d, tmp } = liveCopy();
  try {
    setDb(d);
    repairOpenings(d);
    const h = stubIpc(['purchases', 'issues', 'production', 'receives', 'returns',
      'sales', 'scrap', 'transfers', 'exits', 'payments', 'tolling', 'reports']);
    // خط أساس بعد الإصلاح
    assertConsistent(d, 'الأساس');
    assert.equal(ledger.partyBalance(d, 1), -1315200, 'رصيد المورد الأساسي');
    assert.equal(ledger.partyBalance(d, 3), 6800, 'رصيد مفيد سلام الأساسي');
    assert.equal(ledger.cashBalance(d), -20000, 'النقدية بعد سند الدفع القديم');

    // 1) شراء نقدي من المورد
    h['purchases:save'](null, {
      doc_number: 'FC-P1', doc_date: '2026-10-23', party_id: 1, payment_method: 'cash',
      items: [{ item_id: 2, warehouse_id: 1, quantity: 1000, unit: 'حبة', unit_price: 10 }],
    }, 1);
    assert.equal(counters(d, 2).s, 1100, 'شراء نقدي يزيد سليم الصنف 001002');
    assert.equal(ledger.partyBalance(d, 1), -1325200, 'ذمة المورد تزيد بالنقدي');
    assert.equal(ledger.cashBalance(d), -30000, 'النقدية تنخفض بدفع الشراء النقدي');
    assertConsistent(d, 'بعد الشراء النقدي');

    // 2) شراء آجل
    h['purchases:save'](null, {
      doc_number: 'FC-P2', doc_date: '2026-10-23', party_id: 1, payment_method: 'credit',
      items: [{ item_id: 3, warehouse_id: 1, quantity: 500, unit: 'حبة', unit_price: 20 }],
    }, 1);
    assert.equal(counters(d, 3).s, 600, 'شراء آجل يزيد سليم الصنف 001003');
    assert.equal(ledger.partyBalance(d, 1), -1335200, 'الآجل ذمة بلا لمس النقدية');
    assert.equal(ledger.cashBalance(d), -30000, 'النقدية ثابتة في الآجل');

    // 3) صرف خام خاص للإنتاج
    h['issues:save'](null, {
      doc_number: 'FC-I1', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 2000, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 1).s, 242188, 'صرف الخام الخاص ينقص السليم');

    // 4) صرف من خام عميل (بلا أثر مخزني)
    h['issues:save'](null, {
      doc_number: 'FC-I2', doc_date: '2026-10-23', source: 'customer', party_id: 2,
      items: [{ item_id: 5, warehouse_id: 1, quantity: 300, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 5).s, 9500, 'خام العميل لا يمس سليم المصنع');

    // 5) دورة الكراتين: شراء كرتين → صرف كرتون → نتيجة إنتاج
    const { id: purCarton } = h['purchases:save'](null, {
      doc_number: 'FC-P3', doc_date: '2026-10-23', party_id: 1, payment_method: 'credit',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'FC' }],
    }, 1);
    const cartons = d.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(purCarton);
    assert.equal(cartons.length, 2, 'توليد كرتين');
    h['issues:save'](null, {
      doc_number: 'FC-I3', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: [cartons[0].carton_number] }],
    }, 1);
    h['production:save'](null, {
      carton_id: cartons[0].id, result_date: '2026-10-23',
      good_pieces: 12000, defect_before: 500, defect_after: 352,
    }, 1);
    assert.equal(counters(d, 1).s, 255040, 'سليم بعد دورة الكرتون');
    assert.equal(counters(d, 1).t, 902, 'تالف نتيجة الإنتاج يزيد عداد التالف');
    assert.equal(d.prepare('SELECT status FROM cartons WHERE id=?').get(cartons[0].id).status, 'finished');
    assertConsistent(d, 'بعد نتيجة الإنتاج');

    // 6) استلام تام من إنتاج المصنع
    h['receives:save'](null, {
      doc_number: 'FC-R1', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 12000, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 1).s, 267040, 'استلام التام يزيد السليم');

    // 7) استلام من خام عميل (بلا أثر مخزني)
    h['receives:save'](null, {
      doc_number: 'FC-R2', doc_date: '2026-10-23', source: 'customer', party_id: 2,
      items: [{ item_id: 5, warehouse_id: 1, quantity: 500, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 5).s, 9500, 'استلام خام العميل لا يمس السليم');

    // 8) بيع نقدي
    h['sales:save'](null, {
      doc_number: 'FC-V1', doc_date: '2026-10-23', invoice_type: 'sale', party_id: 3, payment_method: 'cash',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 100 }],
    }, 1);
    assert.equal(counters(d, 1).s, 266740, 'البيع ينقص السليم');
    assert.equal(ledger.partyBalance(d, 3), 36800, 'ذمة العميل بالنقدي تزيد');
    assert.equal(ledger.cashBalance(d), 0, 'قبض البيع النقدي يعيد النقدية للصفر');

    // 9) بيع آجل
    const { id: saleId } = h['sales:save'](null, {
      doc_number: 'FC-V2', doc_date: '2026-10-23', invoice_type: 'sale', party_id: 2, payment_method: 'credit',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 50 }],
    }, 1);
    assert.equal(counters(d, 6).s, 4800, 'بيع آجل ينقص سليم الصنف 002004');
    assert.equal(ledger.partyBalance(d, 2), 10000, 'ذمة العميل الآجلة');
    assert.equal(ledger.cashBalance(d), 0, 'الآجل بلا قبض');

    // 10) مرتجع بيع
    h['returns:save'](null, {
      doc_number: 'FC-SR1', doc_date: '2026-10-23', type: 'sale', invoice_id: saleId,
      payment_method: 'credit',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 50 }],
    }, 1);
    assert.equal(counters(d, 6).s, 4850, 'مرتجع البيع يعيد السليم');
    assert.equal(ledger.partyBalance(d, 2), 7500, 'مرتجع البيع يخفض ذمة العميل');

    // 11) مرتجع شراء
    h['returns:save'](null, {
      doc_number: 'FC-PR1', doc_date: '2026-10-23', type: 'purchase',
      purchase_id: d.prepare("SELECT id FROM purchases WHERE doc_number='FC-P2'").get().id,
      payment_method: 'credit',
      items: [{ item_id: 3, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 20 }],
    }, 1);
    assert.equal(counters(d, 3).s, 500, 'مرتجع الشراء ينقص السليم');
    assert.equal(ledger.partyBalance(d, 1), -1333200, 'مرتجع الشراء يخفض ذمة المورد');

    // 12) تالف يُعاد كمحرز
    h['scrap:save'](null, {
      doc_number: 'FC-S1', doc_date: '2026-10-23', item_id: 1, disposition: 'to_recycled',
      warehouse_id: 1, pieces: 100,
    }, 1);
    assert.equal(counters(d, 1).t, 802, 'التالف يخصم من السلة التالفة');
    assert.equal(counters(d, 1).m, 200, 'المحرز يزيد');

    // 13) تالف يُباع كخردة (خروج نهائي)
    h['scrap:save'](null, {
      doc_number: 'FC-S2', doc_date: '2026-10-23', item_id: 1, disposition: 'sold_scrap',
      warehouse_id: 1, pieces: 50, price: 5,
    }, 1);
    assert.equal(counters(d, 1).t, 752, 'بيع الخردة يخصم التالف');

    // 14) نقل بين المخازن (بلا تغيير في العدادات)
    h['transfers:save'](null, {
      doc_number: 'FC-T1', doc_date: '2026-10-23', from_warehouse_id: 1, to_warehouse_id: 7,
      items: [{ item_id: 7, quantity: 100, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 7).s, 60000, 'النقل لا يغير عداد الصنف');
    assert.equal(getBalance(d, 7, 1).qty_salem, 59900, 'سليم مخزن المصدر ينقص بالنقل');
    assert.equal(getBalance(d, 7, 7).qty_salem, 100, 'سليم مخزن الوجهة يزيد');

    // 15) تصريح خروج
    h['exits:save'](null, {
      doc_number: 'FC-X1', doc_date: '2026-10-23', warehouse_id: 1,
      driver_name: 'سائق النقل', car_number: '1234', destination: 'صنعاء',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 50, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 6).s, 4800, 'الخروج ينقص السليم');

    // 16) نفخ للغير: استلام خام وتسليم مع فاتورة أجرة نقدية
    h['tolling:receiptSave'](null, {
      doc_number: 'FC-TR1', doc_date: '2026-10-23', party_id: 2,
      items: [{ item_id: 3, quantity: 10000, unit: 'حبة' }],
    }, 1);
    h['tolling:deliverySave'](null, {
      doc_number: 'FC-TD1', doc_date: '2026-10-23', party_id: 2,
      items: [{ item_id: 3, quantity: 4000, unit: 'حبة' }],
      invoice: { create: true, doc_number: 'FC-F1', doc_date: '2026-10-23', payment_method: 'cash',
        items: [{ item_id: 3, quantity: 1, unit_price: 7000 }] },
    }, 1);
    assert.equal(ledger.partyBalance(d, 2), 14500, 'فاتورة الأجرة تزيد ذمة العميل');
    assert.equal(ledger.cashBalance(d), 7000, 'أجرة نقدية تدخل الصندوق');
    const tol = h['tolling:balance']().find(r => r.id === 2);
    assert.equal(tol.raw_in, 10000, 'رصيد خام العميل');
    assert.equal(tol.delivered_out, 4000, 'المسلَّم من الخام');
    assert.equal(tol.remaining, 6000, 'المتبقي لدى المصنع');

    // 17) سند قبض من العميل و 18) سند دفع للمورد
    h['payments:save'](null, {
      doc_number: 'FC-PAY1', doc_date: '2026-10-23', party_id: 2, direction: 'in', amount: 5000,
    }, 1);
    h['payments:save'](null, {
      doc_number: 'FC-PAY2', doc_date: '2026-10-23', party_id: 1, direction: 'out', amount: 8000,
    }, 1);
    assert.equal(ledger.partyBalance(d, 2), 9500, 'القبض يخفض ذمة العميل');
    assert.equal(ledger.partyBalance(d, 1), -1325200, 'الدفع يخفض ذمة المورد');
    assert.equal(ledger.cashBalance(d), 4000, 'صافي النقدية بعد القبض والدفع');

    // النتيجة النهائية: ثبات كامل بين الحركات والعدادات وبين الجرد والتقرير
    assertConsistent(d, 'نهاية الدورة');
    const inv = h['reports:inventory'](null, {});
    const byId = Object.fromEntries(inv.map(r => [r.id, r]));
    assert.equal(byId[1].qty_salem, 266740, 'جرد الصنف 001001 في التقرير');
    assert.equal(byId[1].qty_talef, 752, 'تالف 001001 في التقرير');
    assert.equal(byId[1].qty_muharraz, 200, 'محرز 001001 في التقرير');
    assert.equal(byId[2].qty_salem, 1100, 'جرد 001002');
    assert.equal(byId[3].qty_salem, 500, 'جرد 001003');
    assert.equal(byId[6].qty_salem, 4800, 'جرد 002004');
    assert.equal(byId[7].qty_salem, 60000, 'جرد 002024 (العداد لا يتغير بالنقل)');
    assert.ok(!byId[4], 'الصنف المكمل مستبعد من الجرد');
    // تقرير الحركة ينتهي برصيد مطابق لإجمالي السلات الثلاث للصنف
    const mov = h['reports:movement'](null, { itemId: 1 });
    assert.equal(mov[mov.length - 1].balance_pieces, 266740 + 752 + 200, 'رصيد حركة الصنف النهائي');
    // الذمم (طرف «both» يُحسب في الجهتين: ذمته المدينة 9500 تخفض صافي ذمم الموردين)
    const rec = ledger.receivables(d);
    assert.equal(rec.customers, 9500 + 36800, 'ذمم العملاء');
    assert.equal(rec.suppliers, 1325200 - 9500, 'ذمم الموردين');
    // التدقيق سجل كل العمليات
    const auditRows = h['reports:audit'](null, {});
    assert.ok(auditRows.length >= 15, 'سجل التدقيق يشمل عمليات الدورة');
  } finally {
    d.close();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});
