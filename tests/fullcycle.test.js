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
// القيم المتوقعة محسوبة من خط أساس يُقرأ من القاعدة نفسها (وليس أرقاماً ثابتة)
// كي يبقى الاختبار صالحاً مهما أضاف المستخدم مستندات جديدة للقاعدة الحية.

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
    // القاعدة الحية بعد الإصلاح: الافتتاح = العداد − صافي العمليات (يُقرأ ديناميكياً
    // لأن الحذف الوحيد للأقسام الملغاة يعيد امتصاص أثر مستنداتها في الافتتاح)
    const row1 = d.prepare('SELECT * FROM items WHERE id=1').get();
    const net1 = d.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) n
      FROM stock_moves WHERE doc_type != 'opening' AND item_id=1 AND bucket='salem'`).get().n;
    const expected = (Number(row1.qty_salem) || 0) - net1;
    const salem1 = d.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0) s FROM stock_moves
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).get().s;
    assert.equal(salem1, expected, `الافتتاح الحالي للصنف 001001 مصحح (${expected})`);
    const w = d.prepare(`SELECT weight_in_kg w FROM stock_moves
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).get().w;
    assert.ok(Math.abs(w - expected * 20.5 / 1000) < 0.001, 'وزن الافتتاح محسوب من وزن الحبة');
    assertConsistent(d, 'الأساس المصحح');
    // الإصلاح تكراراً لا يغيّر قاعدة سليمة
    assert.equal(repairOpenings(d).changed.length, 0, 'الإصلاح لا يغيّر قاعدة سليمة');
    // محاكاة خطأ الترحيل القديم (الافتتاح = العداد الكامل شاملاً العمليات) ثم الإصلاح يعيده
    const inflated = Number(row1.qty_salem) || 0;
    d.prepare(`UPDATE stock_moves SET qty_in_pieces = ?, weight_in_kg = ? * 20.5 / 1000
      WHERE doc_type='opening' AND item_id=1 AND bucket='salem'`).run(inflated, inflated);
    const { changed } = repairOpenings(d);
    assert.deepEqual(changed, [
      { item_id: 1, item_code: '001001', bucket: 'salem', old_qty: inflated, new_qty: expected },
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

    // ===== خط الأساس: يُقرأ من القاعدة الحية نفسها =====
    assertConsistent(d, 'الأساس');
    const b1 = counters(d, 1), b2 = counters(d, 2), b3 = counters(d, 3);
    const b5 = counters(d, 5), b6 = counters(d, 6), b7 = counters(d, 7);
    const pb1 = ledger.partyBalance(d, 1), pb2 = ledger.partyBalance(d, 2), pb3 = ledger.partyBalance(d, 3);
    const cb = ledger.cashBalance(d);
    const rec0 = ledger.receivables(d);
    const wh1_7 = getBalance(d, 7, 1).qty_salem, wh7_7 = getBalance(d, 7, 7).qty_salem;
    const tol0 = h['tolling:balance']().find(r => r.id === 2) || { raw_in: 0, delivered_out: 0, remaining: 0 };
    const P = d.prepare('SELECT pieces_per_carton p FROM items WHERE id=1').get().p;
    // أثر تغيّر رصيد طرف على الذمم حسب نوعه (طرف «both» يُحسب في الجهتين)
    const typeOf = (id) => d.prepare('SELECT type t FROM parties WHERE id=?').get(id).t;
    let dCust = 0, dSupp = 0;
    const applyLedger = (partyId, delta) => {
      const t = typeOf(partyId);
      if (t === 'customer' || t === 'both') dCust += delta;
      if (t === 'supplier' || t === 'both') dSupp -= delta;
    };

    // 1) شراء نقدي من المورد
    h['purchases:save'](null, {
      doc_number: 'FC-P1', doc_date: '2026-10-23', party_id: 1, payment_method: 'cash',
      items: [{ item_id: 2, warehouse_id: 1, quantity: 1000, unit: 'حبة', unit_price: 10 }],
    }, 1);
    assert.equal(counters(d, 2).s, b2.s + 1000, 'شراء نقدي يزيد سليم الصنف 001002');
    assert.equal(ledger.partyBalance(d, 1), pb1 - 10000, 'ذمة المورد تزيد بالنقدي');
    assert.equal(ledger.cashBalance(d), cb - 10000, 'النقدية تنخفض بدفع الشراء النقدي');
    assertConsistent(d, 'بعد الشراء النقدي');

    // 2) شراء آجل
    h['purchases:save'](null, {
      doc_number: 'FC-P2', doc_date: '2026-10-23', party_id: 1, payment_method: 'credit',
      items: [{ item_id: 3, warehouse_id: 1, quantity: 500, unit: 'حبة', unit_price: 20 }],
    }, 1);
    assert.equal(counters(d, 3).s, b3.s + 500, 'شراء آجل يزيد سليم الصنف 001003');
    assert.equal(ledger.partyBalance(d, 1), pb1 - 20000, 'الآجل ذمة بلا لمس النقدية');
    assert.equal(ledger.cashBalance(d), cb - 10000, 'النقدية ثابتة في الآجل');
    applyLedger(1, -10000); applyLedger(1, -10000);

    // 3) صرف خام خاص للإنتاج
    h['issues:save'](null, {
      doc_number: 'FC-I1', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 2000, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000, 'صرف الخام الخاص ينقص السليم');

    // 4) صرف من خام عميل (بلا أثر مخزني)
    h['issues:save'](null, {
      doc_number: 'FC-I2', doc_date: '2026-10-23', source: 'customer', party_id: 2,
      items: [{ item_id: 5, warehouse_id: 1, quantity: 300, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 5).s, b5.s, 'خام العميل لا يمس سليم المصنع');

    // 5) دورة الكراتين: شراء كرتين → صرف كرتون → نتيجة إنتاج
    const { id: purCarton } = h['purchases:save'](null, {
      doc_number: 'FC-P3', doc_date: '2026-10-23', party_id: 1, payment_method: 'credit',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 2, unit: 'كرتون', carton_prefix: 'FC' }],
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000 + 2 * P, 'شراء الكراتين يزيد السليم بحبات الكرتونين');
    const cartons = d.prepare('SELECT * FROM cartons WHERE purchase_id=? ORDER BY id').all(purCarton);
    assert.equal(cartons.length, 2, 'توليد كرتين');
    h['issues:save'](null, {
      doc_number: 'FC-I3', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 1, unit: 'كرتون', carton_ids: [cartons[0].carton_number] }],
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000 + P, 'صرف الكرتون يخصم حباته من السليم');
    h['production:save'](null, {
      carton_id: cartons[0].id, result_date: '2026-10-23',
      good_pieces: 12000, defect_before: 500, defect_after: 352,
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000 + P, 'نتيجة الإنتاج لا تمس السليم');
    assert.equal(counters(d, 1).t, b1.t + 852, 'تالف نتيجة الإنتاج يزيد عداد التالف');
    assert.equal(d.prepare('SELECT status FROM cartons WHERE id=?').get(cartons[0].id).status, 'finished');
    assertConsistent(d, 'بعد نتيجة الإنتاج');

    // 6) استلام تام من إنتاج المصنع
    h['receives:save'](null, {
      doc_number: 'FC-R1', doc_date: '2026-10-23', source: 'own',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 12000, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000 + P + 12000, 'استلام التام يزيد السليم');

    // 7) استلام من خام عميل (بلا أثر مخزني)
    h['receives:save'](null, {
      doc_number: 'FC-R2', doc_date: '2026-10-23', source: 'customer', party_id: 2,
      items: [{ item_id: 5, warehouse_id: 1, quantity: 500, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 5).s, b5.s, 'استلام خام العميل لا يمس السليم');

    // 8) بيع نقدي
    h['sales:save'](null, {
      doc_number: 'FC-V1', doc_date: '2026-10-23', invoice_type: 'sale', party_id: 3, payment_method: 'cash',
      items: [{ item_id: 1, warehouse_id: 1, quantity: 300, unit: 'حبة', unit_price: 100 }],
    }, 1);
    assert.equal(counters(d, 1).s, b1.s - 2000 + P + 12000 - 300, 'البيع ينقص السليم');
    assert.equal(ledger.partyBalance(d, 3), pb3 + 30000, 'ذمة العميل بالنقدي تزيد');
    assert.equal(ledger.cashBalance(d), cb - 10000 + 30000, 'قبض البيع النقدي يزيد النقدية');
    applyLedger(3, 30000);

    // 9) بيع آجل
    const { id: saleId } = h['sales:save'](null, {
      doc_number: 'FC-V2', doc_date: '2026-10-23', invoice_type: 'sale', party_id: 2, payment_method: 'credit',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 200, unit: 'حبة', unit_price: 50 }],
    }, 1);
    assert.equal(counters(d, 6).s, b6.s - 200, 'بيع آجل ينقص سليم الصنف 002004');
    assert.equal(ledger.partyBalance(d, 2), pb2 + 10000, 'ذمة العميل الآجلة');
    assert.equal(ledger.cashBalance(d), cb - 10000 + 30000, 'الآجل بلا قبض');
    applyLedger(2, 10000);

    // 10) مرتجع بيع
    h['returns:save'](null, {
      doc_number: 'FC-SR1', doc_date: '2026-10-23', type: 'sale', invoice_id: saleId,
      payment_method: 'credit',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 50, unit: 'حبة', unit_price: 50 }],
    }, 1);
    assert.equal(counters(d, 6).s, b6.s - 150, 'مرتجع البيع يعيد السليم');
    assert.equal(ledger.partyBalance(d, 2), pb2 + 7500, 'مرتجع البيع يخفض ذمة العميل');
    applyLedger(2, -2500);

    // 11) مرتجع شراء
    h['returns:save'](null, {
      doc_number: 'FC-PR1', doc_date: '2026-10-23', type: 'purchase',
      purchase_id: d.prepare("SELECT id FROM purchases WHERE doc_number='FC-P2'").get().id,
      payment_method: 'credit',
      items: [{ item_id: 3, warehouse_id: 1, quantity: 100, unit: 'حبة', unit_price: 20 }],
    }, 1);
    assert.equal(counters(d, 3).s, b3.s + 400, 'مرتجع الشراء ينقص السليم');
    assert.equal(ledger.partyBalance(d, 1), pb1 - 18000, 'مرتجع الشراء يخفض ذمة المورد');
    applyLedger(1, 2000);

    // 12) تالف يُعاد كمحرز (الخصم من التالف أولاً ثم من السليم إن لم يكفِ)
    const tAfterProd = b1.t + 852;
    h['scrap:save'](null, {
      doc_number: 'FC-S1', doc_date: '2026-10-23', item_id: 1, disposition: 'to_recycled',
      warehouse_id: 1, pieces: 100,
    }, 1);
    const fromTalef1 = Math.min(tAfterProd, 100);
    const tAfterS1 = tAfterProd - fromTalef1;
    assert.equal(counters(d, 1).t, tAfterS1, 'التالف يخصم من السلة التالفة أولاً');
    assert.equal(counters(d, 1).m, b1.m + 100, 'المحرز يزيد');
    assert.equal(counters(d, 1).s, b1.s - 2000 + P + 12000 - 300 - (100 - fromTalef1), 'الناقص من سند التالف يخصم من السليم');

    // 13) تالف يُباع كخردة (خروج نهائي)
    h['scrap:save'](null, {
      doc_number: 'FC-S2', doc_date: '2026-10-23', item_id: 1, disposition: 'sold_scrap',
      warehouse_id: 1, pieces: 50, price: 5,
    }, 1);
    const fromTalef2 = Math.min(tAfterS1, 50);
    const tFinal = tAfterS1 - fromTalef2;
    const sFinal = b1.s - 2000 + P + 12000 - 300 - (100 - fromTalef1) - (50 - fromTalef2);
    assert.equal(counters(d, 1).t, tFinal, 'بيع الخردة يخصم التالف');
    assert.equal(counters(d, 1).s, sFinal, 'سليم الصنف 001001 بعد كل عمليات الدورة');

    // 14) نقل بين المخازن (بلا تغيير في العدادات)
    h['transfers:save'](null, {
      doc_number: 'FC-T1', doc_date: '2026-10-23', from_warehouse_id: 1, to_warehouse_id: 7,
      items: [{ item_id: 7, quantity: 100, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 7).s, b7.s, 'النقل لا يغير عداد الصنف');
    assert.equal(getBalance(d, 7, 1).qty_salem, wh1_7 - 100, 'سليم مخزن المصدر ينقص بالنقل');
    assert.equal(getBalance(d, 7, 7).qty_salem, wh7_7 + 100, 'سليم مخزن الوجهة يزيد');

    // 15) تصريح خروج
    h['exits:save'](null, {
      doc_number: 'FC-X1', doc_date: '2026-10-23', warehouse_id: 1,
      driver_name: 'سائق النقل', car_number: '1234', destination: 'صنعاء',
      items: [{ item_id: 6, warehouse_id: 1, quantity: 50, unit: 'حبة' }],
    }, 1);
    assert.equal(counters(d, 6).s, b6.s - 200, 'الخروج ينقص السليم');

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
    assert.equal(ledger.partyBalance(d, 2), pb2 + 7500 + 7000, 'فاتورة الأجرة تزيد ذمة العميل');
    assert.equal(ledger.cashBalance(d), cb - 10000 + 30000 + 7000, 'أجرة نقدية تدخل الصندوق');
    applyLedger(2, 7000);
    const tol = h['tolling:balance']().find(r => r.id === 2);
    assert.equal(tol.raw_in, tol0.raw_in + 10000, 'رصيد خام العميل');
    assert.equal(tol.delivered_out, tol0.delivered_out + 4000, 'المسلَّم من الخام');
    assert.equal(tol.remaining, tol0.remaining + 6000, 'المتبقي لدى المصنع');

    // 17) سند قبض من العميل و 18) سند دفع للمورد
    h['payments:save'](null, {
      doc_number: 'FC-PAY1', doc_date: '2026-10-23', party_id: 2, direction: 'in', amount: 5000,
    }, 1);
    h['payments:save'](null, {
      doc_number: 'FC-PAY2', doc_date: '2026-10-23', party_id: 1, direction: 'out', amount: 8000,
    }, 1);
    assert.equal(ledger.partyBalance(d, 2), pb2 + 9500, 'القبض يخفض ذمة العميل');
    assert.equal(ledger.partyBalance(d, 1), pb1 - 10000, 'الدفع يخفض ذمة المورد');
    assert.equal(ledger.cashBalance(d), cb + 24000, 'صافي النقدية بعد القبض والدفع');
    applyLedger(2, -5000); applyLedger(1, 8000);

    // النتيجة النهائية: ثبات كامل بين الحركات والعدادات وبين الجرد والتقرير
    assertConsistent(d, 'نهاية الدورة');
    const inv = h['reports:inventory'](null, {});
    const byId = Object.fromEntries(inv.map(r => [r.id, r]));
    assert.equal(byId[1].qty_salem, sFinal, 'جرد الصنف 001001 في التقرير');
    assert.equal(byId[1].qty_talef, tFinal, 'تالف 001001 في التقرير');
    assert.equal(byId[1].qty_muharraz, b1.m + 100, 'محرز 001001 في التقرير');
    assert.equal(byId[2].qty_salem, b2.s + 1000, 'جرد 001002');
    assert.equal(byId[3].qty_salem, b3.s + 400, 'جرد 001003');
    assert.equal(byId[6].qty_salem, b6.s - 200, 'جرد 002004');
    assert.equal(byId[7].qty_salem, b7.s, 'جرد 002024 (العداد لا يتغير بالنقل)');
    assert.ok(!byId[4], 'الصنف المكمل مستبعد من الجرد');
    // تقرير الحركة ينتهي برصيد مطابق لإجمالي السلات الثلاث للصنف
    const mov = h['reports:movement'](null, { itemId: 1 });
    assert.equal(mov[mov.length - 1].balance_pieces, sFinal + tFinal + (b1.m + 100), 'رصيد حركة الصنف النهائي');
    // الذمم: من خط الأساس زائد أثر عمليات الدورة حسب نوع كل طرف
    const rec = ledger.receivables(d);
    assert.equal(rec.customers, rec0.customers + dCust, 'ذمم العملاء');
    assert.equal(rec.suppliers, rec0.suppliers + dSupp, 'ذمم الموردين');
    // التدقيق سجل كل العمليات
    const auditRows = h['reports:audit'](null, {});
    assert.ok(auditRows.length >= 15, 'سجل التدقيق يشمل عمليات الدورة');
  } finally {
    d.close();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});
