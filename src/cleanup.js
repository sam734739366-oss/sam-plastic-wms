// ===== حذف بيانات الأقسام الملغاة =====
// البرنامج أصبح خاصاً بالمخازن والإنتاج فقط، وهذه الوحدة تحذف نهائياً بيانات:
// فواتير البيع، تصاريح الخروج، مرتجعات البيع، سندات القبض والدفع،
// والعملاء الذين لا يرتبطون بأي مستند باقٍ.
// عدادات الأصناف (qty_salem/talef/muharraz) تبقى كما هي — أي أن الكميات
// الحالية في المخازن لا تتغير — وتُعاد بناء حركات الافتتاح لتمتص أثر
// الحركات المحذوفة ويعود التطابق التام بين العدادات وحركات المخزون.
// v2: لا حالة «ملغى» — الحذف هنا حذف مادي مثل شاشة المستندات، بلا صفوف عكس.

const { withTransaction } = require('./db');

// إعادة بناء حركات الافتتاح لكل صنف × سلة حتى يساوي صافي الحركات عدّاد الصنف.
// الفارق الموجب يُفتَّح كوارد، والسالب كمنصرف (افتتاح سلبي يمتص أثر الحركات الخارجة
// التي حُذف مستندها) — فتعود القاعدة متسقة بلا لمس للعدادات.
function rebuildOpenings(d) {
  d.prepare("DELETE FROM stock_moves WHERE doc_type='opening'").run();
  const firstWh = d.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const nets = d.prepare(`SELECT item_id, bucket, warehouse_id,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
    FROM stock_moves WHERE doc_type != 'opening'
    GROUP BY item_id, bucket, warehouse_id
    ORDER BY item_id, bucket, warehouse_id`).all();
  const netOf = (itemId, bucket) => nets
    .filter((r) => r.item_id === itemId && r.bucket === bucket)
    .reduce((s, r) => s + (Number(r.net) || 0), 0);
  // مخزن الافتتاح البديل: أكثر مخزن حركةً للصنف، وتُكسر التعادلة بأصغر رقم مخزن.
  // الاعتماد على آخر صف من GROUP BY بلا ترتيب كان يجعل المكان عشوائياً بين تشغيلين،
  // فيستيقظ الصنف برصيد افتتاحي في مخزن غير الذي فيه حركته الحقيقية.
  const homeWhOf = (itemId) => {
    const byWh = new Map();
    for (const r of nets) {
      if (r.item_id !== itemId) continue;
      byWh.set(r.warehouse_id, (byWh.get(r.warehouse_id) || 0) + Math.abs(Number(r.net) || 0));
    }
    let best = null, bestVol = -1;
    for (const [whId, vol] of [...byWh.entries()].sort((a, b) => a[0] - b[0])) {
      if (vol > bestVol) { best = whId; bestVol = vol; }
    }
    return best;
  };
  const ins = d.prepare(`INSERT INTO stock_moves
    (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
     qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
    VALUES ('opening',?,?,?,?,?,?,?,?,?,?,?)`);
  const today = new Date().toISOString().slice(0, 10);
  const labels = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' };
  for (const item of d.prepare('SELECT * FROM items').all()) {
    const wh = item.opening_warehouse_id || homeWhOf(item.id) || (firstWh && firstWh.id) || null;
    if (!wh) continue;
    const per = Number(item.weight_grams) || 0;
    for (const key of ['salem', 'talef', 'muharraz']) {
      const need = (Number(item[`qty_${key}`]) || 0) - netOf(item.id, key);
      if (!need) continue;
      const abs = Math.abs(need);
      const kg = abs * per / 1000;
      ins.run(item.id, `افتتاحي-${item.code}`, today, item.id, wh,
        need > 0 ? abs : 0, need > 0 ? 0 : abs,
        need > 0 ? kg : 0, need > 0 ? 0 : kg,
        key, `رصيد افتتاحي (${labels[key]}) — امتص أثر الأقسام المحذوفة`);
    }
  }
}

function removeNonWarehouseData(d) {
  const removed = { sale_invoices: 0, sale_returns: 0, exits: 0, payments: 0, parties: 0 };
  withTransaction(d, () => {
    // 1) مرتجعات البيع أولاً لأنها تشير إلى فواتير البيع (يبقى مرتجع الشراء)
    const srIds = d.prepare('SELECT id FROM sales_returns').all().map(r => r.id);
    removed.sale_returns = srIds.length;
    if (srIds.length) {
      const ph = srIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM sales_returns WHERE id IN (${ph})`).run(...srIds);
      d.prepare(`DELETE FROM stock_moves WHERE doc_type='sale_return' AND doc_id IN (${ph})`).run(...srIds);
      d.prepare(`DELETE FROM party_ledger WHERE doc_type='sale_return' AND doc_id IN (${ph})`).run(...srIds);
      d.prepare(`DELETE FROM audit_log WHERE entity='sale_return' AND entity_id IN (${ph})`).run(...srIds);
    }

    // 2) فواتير البيع (تبقى فواتير الخردة وأجرة النفخ المرتبطة بالتالف والنفخ للغير).
    //    سند التسليم يشير إلى الفاتورة بصفاً حياً، فيُفصل قبل الحذف لا يُلغى.
    const saleIds = d.prepare("SELECT id FROM invoices WHERE invoice_type='sale'").all().map(r => r.id);
    removed.sale_invoices = saleIds.length;
    if (saleIds.length) {
      const ph = saleIds.map(() => '?').join(',');
      d.prepare(`UPDATE customer_deliveries SET invoice_id=NULL WHERE invoice_id IN (${ph})`).run(...saleIds);
      d.prepare(`DELETE FROM invoices WHERE id IN (${ph})`).run(...saleIds); // بنودها تُحذف تلقائياً
      d.prepare(`DELETE FROM stock_moves WHERE doc_type='invoice' AND doc_id IN (${ph})`).run(...saleIds);
      d.prepare(`DELETE FROM party_ledger WHERE doc_type='invoice' AND doc_id IN (${ph})`).run(...saleIds);
      d.prepare(`DELETE FROM audit_log WHERE entity='invoice' AND entity_id IN (${ph})`).run(...saleIds);
    }

    // 3) تصاريح الخروج
    const exIds = d.prepare('SELECT id FROM exit_permits').all().map(r => r.id);
    removed.exits = exIds.length;
    if (exIds.length) {
      const ph = exIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM exit_permits WHERE id IN (${ph})`).run(...exIds);
      d.prepare(`DELETE FROM stock_moves WHERE doc_type='exit' AND doc_id IN (${ph})`).run(...exIds);
      d.prepare(`DELETE FROM audit_log WHERE entity='exit_permit' AND entity_id IN (${ph})`).run(...exIds);
    }

    // 4) سندات القبض والدفع
    const payIds = d.prepare('SELECT id FROM payments').all().map(r => r.id);
    removed.payments = payIds.length;
    if (payIds.length) {
      const ph = payIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM payments WHERE id IN (${ph})`).run(...payIds);
      d.prepare(`DELETE FROM party_ledger WHERE doc_type='payment' AND doc_id IN (${ph})`).run(...payIds);
      d.prepare(`DELETE FROM audit_log WHERE entity='payment' AND entity_id IN (${ph})`).run(...payIds);
    }

    // 5) العملاء غير المرتبطين بأي مستند باقٍ (يبقى عملاء النفخ للغير وأطراف «both»)
    const custIds = d.prepare(`SELECT p.id FROM parties p WHERE p.type='customer' AND NOT EXISTS (
        SELECT 1 FROM purchases pu WHERE pu.party_id = p.id
        UNION ALL SELECT 1 FROM issue_permits ip WHERE ip.party_id = p.id
        UNION ALL SELECT 1 FROM production_receipts pr WHERE pr.party_id = p.id
        UNION ALL SELECT 1 FROM invoices inv WHERE inv.party_id = p.id
        UNION ALL SELECT 1 FROM scrap_movements sm WHERE sm.party_id = p.id
        UNION ALL SELECT 1 FROM customer_raw_receipts cr WHERE cr.party_id = p.id
        UNION ALL SELECT 1 FROM customer_deliveries cd WHERE cd.party_id = p.id
        UNION ALL SELECT 1 FROM party_ledger pl WHERE pl.party_id = p.id
      )`).all().map(r => r.id);
    removed.parties = custIds.length;
    if (custIds.length) {
      const ph = custIds.map(() => '?').join(',');
      d.prepare(`DELETE FROM parties WHERE id IN (${ph})`).run(...custIds);
      d.prepare(`DELETE FROM audit_log WHERE entity='party' AND entity_id IN (${ph})`).run(...custIds);
    }

    // 6) إعادة بناء الأرصدة الافتتاحية: العداد يبقى كما هو والافتتاح يمتص أثر المحذوف
    rebuildOpenings(d);
  });
  return removed;
}

module.exports = { removeNonWarehouseData, rebuildOpenings };
