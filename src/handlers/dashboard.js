const { getDb } = require('../db');
const ledger = require('../ledger');

function monthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return [`${y}-${m}-01`, `${y}-${m}-31`];
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
    // كل مستند في الجدول موجود فعلاً: لا حالة «ملغى» في v2، فالمحذوف يُمحى صفّه معه
    const todayDocs = db.prepare(`SELECT
      (SELECT COUNT(*) FROM purchases WHERE doc_date=?) +
      (SELECT COUNT(*) FROM issue_permits WHERE doc_date=?) +
      (SELECT COUNT(*) FROM production_receipts WHERE doc_date=?) +
      (SELECT COUNT(*) FROM invoices WHERE doc_date=?) +
      (SELECT COUNT(*) FROM exit_permits WHERE doc_date=?) +
      (SELECT COUNT(*) FROM transfers WHERE doc_date=?) +
      (SELECT COUNT(*) FROM scrap_movements WHERE doc_date=?) +
      (SELECT COUNT(*) FROM customer_raw_receipts WHERE doc_date=?) +
      (SELECT COUNT(*) FROM customer_deliveries WHERE doc_date=?) c`)
      .get(todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr).c;
    const [from, to] = monthRange();
    const monthPurchases = db.prepare(`SELECT COALESCE(SUM(pi.total_price),0) t
      FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
      WHERE p.doc_date BETWEEN ? AND ?`).get(from, to).t;
    const monthSales = db.prepare(`SELECT COALESCE(SUM(ii.total_price),0) t
      FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id
      WHERE inv.doc_date BETWEEN ? AND ?`).get(from, to).t;
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

  ipcMain.handle('dashboard:charts', () => {
    const db = getDb();
    const now = new Date();
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const from = `${monthKey(d)}-01`;
      const to = `${monthKey(d)}-31`;
      const purchases = db.prepare(`SELECT COALESCE(SUM(pi.total_price),0) t
        FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
        WHERE p.doc_date BETWEEN ? AND ?`).get(from, to).t;
      const sales = db.prepare(`SELECT COALESCE(SUM(ii.total_price),0) t
        FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id
        WHERE inv.doc_date BETWEEN ? AND ?`).get(from, to).t;
      monthly.push({ label: AR_MONTHS[d.getMonth()], purchases, sales });
    }
    const buckets = db.prepare(`SELECT
      COALESCE(SUM(qty_salem),0) salem, COALESCE(SUM(qty_talef),0) talef, COALESCE(SUM(qty_muharraz),0) muharraz
      FROM items`).get();
    const cash = ledger.cashBalance(db);
    const recv = ledger.receivables(db);
    const topItems = db.prepare(
      'SELECT name, qty_salem q FROM items WHERE qty_salem > 0 ORDER BY qty_salem DESC LIMIT 5'
    ).all();
    return {
      monthly,
      buckets: [
        { label: 'سليم', value: buckets.salem },
        { label: 'تالف', value: buckets.talef },
        { label: 'محرز', value: buckets.muharraz },
      ],
      financial: [
        { label: 'رصيد النقدية', value: cash },
        { label: 'ذمم العملاء (لنا)', value: recv.customers },
        { label: 'ذمم الموردين (علينا)', value: recv.suppliers },
      ],
      top_items: topItems.map((t) => ({ name: t.name, qty: t.q })),
    };
  });
};
