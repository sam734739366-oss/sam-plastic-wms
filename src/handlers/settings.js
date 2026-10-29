const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');
const { CURRENCIES } = require('../currency');

// المفاتيح التي تملكها شاشة الإعدادات وحدها. غيرها برمجي (مثل footer_* قبل إضافتها للواجهة،
// أو أي مفتاح تضيفه ميزة لاحقة) — المسح الكامل كان يحذفه بصمت عند أول «حفظ الإعدادات».
const UI_KEYS = ['factory_name', 'factory_phone', 'factory_address', 'cloud_folder',
  'currency', 'doc_page_size', 'report_page_size', 'footer_right', 'footer_center', 'footer_left'];

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
      const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      for (const [k, v] of Object.entries(values)) upsert.run(k, String(v ?? ''));
      // يُحذف من مفاتيح الواجهة فقط ما أسقطته الشاشة عمداً، ولا يُمسّ ما لا تعرفه
      const del = db.prepare('DELETE FROM settings WHERE key = ?');
      for (const k of UI_KEYS) if (!(k in values)) del.run(k);
    });
    audit(db, userId, 'update', 'settings', null, before, values);
    return { ok: true };
  });
};
