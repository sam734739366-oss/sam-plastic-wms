const { getDb } = require('../db');
const ledger = require('../ledger');

// استعلامات الحسابات: أرصدة الأطراف والنقدية وكشف حساب طرف
module.exports = function register(ipcMain) {
  ipcMain.handle('ledger:party-balance', (e, partyId) => {
    const db = getDb();
    return ledger.partyBalance(db, partyId);
  });

  ipcMain.handle('ledger:cash-balance', () => {
    const db = getDb();
    return ledger.cashBalance(db);
  });

  ipcMain.handle('ledger:receivables', () => {
    const db = getDb();
    return ledger.receivables(db);
  });

  ipcMain.handle('ledger:party-statement', (e, partyId) => {
    const db = getDb();
    return db.prepare(`SELECT l.*, p.name party_name
      FROM party_ledger l JOIN parties p ON p.id = l.party_id
      WHERE l.party_id = ? AND l.status = 'active'
      ORDER BY l.doc_date, l.id`).all(partyId);
  });

  // كشف حساب طرف كامل: رصيد افتتاحي + حركات متسلسلة برصيد متحرك
  ipcMain.handle('ledger:statement', (e, partyId, dateFrom, dateTo) => {
    const db = getDb();
    const party = db.prepare('SELECT id, name, type FROM parties WHERE id=?').get(partyId);
    if (!party) throw new Error('الطرف غير موجود');
    const opening = dateFrom
      ? db.prepare(`SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0) o
          FROM party_ledger WHERE party_id=? AND status='active' AND doc_date < ?`)
        .get(partyId, dateFrom).o
      : 0;
    let sql = `SELECT l.*, p.name party_name FROM party_ledger l JOIN parties p ON p.id=l.party_id
      WHERE l.party_id=? AND l.status='active'`;
    const args = [partyId];
    if (dateFrom) { sql += ' AND l.doc_date >= ?'; args.push(dateFrom); }
    if (dateTo) { sql += ' AND l.doc_date <= ?'; args.push(dateTo); }
    sql += ' ORDER BY l.doc_date, l.id';
    const rows = db.prepare(sql).all(...args);
    let running = Number(opening) || 0;
    const withRun = rows.map(r => {
      running += r.side === 'debit' ? Number(r.amount) : -Number(r.amount);
      return { ...r, running };
    });
    return { party, opening: Number(opening) || 0, rows: withRun, closing: running };
  });

  // ملخص ذمم كل الأطراف (مدين/دائن/صافي)
  ipcMain.handle('ledger:parties-summary', () => {
    const db = getDb();
    return db.prepare(`SELECT p.id, p.name, p.type,
        COALESCE(SUM(CASE WHEN l.side='debit' THEN l.amount ELSE 0 END),0) debit,
        COALESCE(SUM(CASE WHEN l.side='credit' THEN l.amount ELSE 0 END),0) credit,
        COALESCE(SUM(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0) net
      FROM parties p LEFT JOIN party_ledger l ON l.party_id=p.id AND l.status='active'
      GROUP BY p.id ORDER BY p.name`).all()
      .map(r => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), net: Number(r.net) }));
  });

  // تقرير النقدية: حركات الوارد والصادر في فترة مع الإجماليات
  ipcMain.handle('ledger:cash-report', (e, dateFrom, dateTo) => {
    const db = getDb();
    let sql = `SELECT l.*, p.name party_name FROM party_ledger l JOIN parties p ON p.id=l.party_id
      WHERE l.status='active' AND (l.cash_in > 0 OR l.cash_out > 0)`;
    const args = [];
    if (dateFrom) { sql += ' AND l.doc_date >= ?'; args.push(dateFrom); }
    if (dateTo) { sql += ' AND l.doc_date <= ?'; args.push(dateTo); }
    sql += ' ORDER BY l.doc_date, l.id';
    const rows = db.prepare(sql).all(...args);
    const totalIn = rows.reduce((s, r) => s + (Number(r.cash_in) || 0), 0);
    const totalOut = rows.reduce((s, r) => s + (Number(r.cash_out) || 0), 0);
    return { rows, totalIn, totalOut, net: totalIn - totalOut };
  });
};
