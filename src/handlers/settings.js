const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { CURRENCIES } = require('../currency');

module.exports = function register(ipcMain) {
  ipcMain.handle('settings:get', () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!CURRENCIES[map.currency]) map.currency = 'YER';
    return map;
  });
  ipcMain.handle('settings:save', (e, values, userId) => {
    const db = getDb();
    if (values.currency && !CURRENCIES[values.currency]) {
      throw new Error('العملة المختارة غير معروفة — اختر ريال يمني أو ريال سعودي أو دولار');
    }
    const before = db.prepare('SELECT key, value FROM settings').all();
    withTransaction(db, () => {
      const del = db.prepare('DELETE FROM settings');
      const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
      del.run();
      for (const [k, v] of Object.entries(values)) ins.run(k, String(v ?? ''));
    });
    audit(db, userId, 'update', 'settings', null, before, values);
    return { ok: true };
  });
};
