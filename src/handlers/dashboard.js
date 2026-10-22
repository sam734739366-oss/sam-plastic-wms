const { getDb } = require('../db');
const ledger = require('../ledger');

function monthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return [`${y}-${m}-01`, `${y}-${m}-31`];
}

module.exports = function register(ipcMain) {
  ipcMain.handle('dashboard:summary', () => {
    const db = getDb();
    const itemsCount = db.prepare('SELECT COUNT(*) c FROM items').get().c;
    const buckets = db.prepare(`SELECT
      COALESCE(SUM(qty_salem),0) salem, COALESCE(SUM(qty_talef),0) talef, COALESCE(SUM(qty_muharraz),0) muharraz
      FROM items`).get();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayDocs = db.prepare(`SELECT
      (SELECT COUNT(*) FROM purchases WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM issue_permits WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM receive_permits WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM invoices WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM exit_permits WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM transfers WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM scrap_movements WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM customer_raw_receipts WHERE doc_date=? AND status='active') +
      (SELECT COUNT(*) FROM customer_deliveries WHERE doc_date=? AND status='active') c`)
      .get(todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr).c;
    const [from, to] = monthRange();
    const monthPurchases = db.prepare(`SELECT COALESCE(SUM(pi.total_price),0) t
      FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
      WHERE p.status='active' AND p.doc_date BETWEEN ? AND ?`).get(from, to).t;
    const monthSales = db.prepare(`SELECT COALESCE(SUM(ii.total_price),0) t
      FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id
      WHERE inv.status='active' AND inv.doc_date BETWEEN ? AND ?`).get(from, to).t;
    const pendingCartons = db.prepare(`SELECT COUNT(*) c FROM cartons WHERE status='in_stock'`).get().c;
    const cash = ledger.cashBalance(db);
    const recv = ledger.receivables(db);
    return {
      items_count: itemsCount,
      salem_pieces: buckets.salem,
      talef_pieces: buckets.talef,
      muharraz_pieces: buckets.muharraz,
      today_docs: todayDocs,
      month_purchases: monthPurchases,
      month_sales: monthSales,
      pending_cartons: pendingCartons,
      cash_balance: cash,
      customers_due: recv.customers,
      suppliers_due: recv.suppliers,
    };
  });
};
