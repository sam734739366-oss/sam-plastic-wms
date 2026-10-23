// ===== حذف بيانات الأقسام الملغاة =====
// البرنامج أصبح خاصاً بالمخازن والإنتاج فقط، وهذه الوحدة تحذف نهائياً بيانات:
// فواتير البيع، تصاريح الخروج، مرتجعات البيع، سندات القبض والدفع،
// والعملاء الذين لا يرتبطون بأي مستند باقٍ.
// عدادات الأصناف (qty_salem/talef/muharraz) تبقى كما هي — أي أن الكميات
// الحالية في المخازن لا تتغير — وتُعاد بناء الأرصدة الافتتاحية لتمتص أثر
// الحركات المحذوفة ويعود التطابق التام بين العدادات وحركات المخزون.

const { withTransaction, repairOpenings } = require('./db');

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

    // 2) فواتير البيع (تبقى فواتير الخردة وأجرة النفخ المرتبطة بالتالف والنفخ للغير)
    const saleIds = d.prepare("SELECT id FROM invoices WHERE invoice_type='sale'").all().map(r => r.id);
    removed.sale_invoices = saleIds.length;
    if (saleIds.length) {
      const ph = saleIds.map(() => '?').join(',');
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
        UNION ALL SELECT 1 FROM receive_permits rp WHERE rp.party_id = p.id
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
    repairOpenings(d);
  });
  return removed;
}

module.exports = { removeNonWarehouseData };
