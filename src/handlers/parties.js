const { getDb } = require('../db');
const { audit } = require('../audit');

const TYPE_NAMES = { supplier: 'مورد', customer: 'عميل', both: 'كلاهما' };

module.exports = function register(ipcMain) {
  ipcMain.handle('parties:list', (e, type) => {
    const db = getDb();
    const q = type ? 'WHERE type = ?' : '';
    return db.prepare(`SELECT * FROM parties ${q} ORDER BY id`).all(...(type ? [type] : []));
  });
  ipcMain.handle('parties:save', (e, row, userId) => {
    const db = getDb();
    if (!row.name || !row.name.trim()) throw new Error('اسم الطرف مطلوب');
    if (!['supplier', 'customer', 'both'].includes(row.type)) throw new Error('نوع الطرف غير صالح');
    const before = row.id ? db.prepare('SELECT * FROM parties WHERE id=?').get(row.id) : null;
    let id = row.id;
    if (id) db.prepare('UPDATE parties SET name=?, type=?, phone=?, address=?, notes=? WHERE id=?')
      .run(row.name.trim(), row.type, row.phone || null, row.address || null, row.notes || null, id);
    else id = db.prepare('INSERT INTO parties (name, type, phone, address, notes) VALUES (?,?,?,?,?)')
      .run(row.name.trim(), row.type, row.phone || null, row.address || null, row.notes || null).lastInsertRowid;
    audit(db, userId, id ? 'update' : 'create', 'party', id, before, row);
    return { id };
  });
  ipcMain.handle('parties:delete', (e, id, userId) => {
    const db = getDb();
    const linked = [
      ['purchases', 'party_id', 'مشتريات'],
      ['invoices', 'party_id', 'فواتير'],
      ['customer_raw_receipts', 'party_id', 'استلام خام للغير'],
      ['customer_deliveries', 'party_id', 'تسليم للغير'],
      ['issue_permits', 'party_id', 'تصاريح صرف'],
      ['receive_permits', 'party_id', 'تصاريح استلام'],
      ['scrap_movements', 'party_id', 'حركات توالف'],
    ];
    for (const [table, col, label] of linked) {
      const used = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col}=?`).get(id).c;
      if (used > 0) throw new Error(`لا يمكن حذف الطرف — مرتبط بـ${label}`);
    }
    const before = db.prepare('SELECT * FROM parties WHERE id=?').get(id);
    db.prepare('DELETE FROM parties WHERE id=?').run(id);
    audit(db, userId, 'delete', 'party', id, before, null);
    return { ok: true };
  });
};
