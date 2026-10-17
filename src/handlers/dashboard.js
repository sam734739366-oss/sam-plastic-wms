const { getDb } = require('../db');

module.exports = function register(ipcMain) {
  ipcMain.handle('dashboard:summary', () => {
    const db = getDb();
    const raw = db.prepare('SELECT COUNT(*) c FROM items WHERE item_group=1').get().c;
    const fg = db.prepare('SELECT COUNT(*) c FROM items WHERE item_group=2').get().c;
    const today = db.prepare(`SELECT
      (SELECT COUNT(*) FROM purchases WHERE doc_date=date('now','localtime') AND status='active') +
      (SELECT COUNT(*) FROM issue_permits WHERE doc_date=date('now','localtime') AND status='active') +
      (SELECT COUNT(*) FROM receive_permits WHERE doc_date=date('now','localtime') AND status='active') +
      (SELECT COUNT(*) FROM invoices WHERE doc_date=date('now','localtime') AND status='active') c`).get().c;
    const fgb = db.prepare(`SELECT COALESCE(SUM(sm.qty_in_pieces)-SUM(sm.qty_out_pieces),0) c FROM stock_moves sm
      JOIN items i ON i.id=sm.item_id WHERE i.item_group=2`).get().c;
    return { raw_items: raw, fg_items: fg, today_docs: today, fg_balance: fgb };
  });
};
