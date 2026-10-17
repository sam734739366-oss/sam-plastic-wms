const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('warehouses:list', () => getDb().prepare('SELECT * FROM warehouses ORDER BY id').all());
  ipcMain.handle('warehouses:save', (e, row, userId) => {
    const db = getDb();
    const before = row.id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(row.id) : null;
    if (!row.name || !row.name.trim()) throw new Error('اسم المخزن مطلوب');
    let id = row.id;
    if (id) db.prepare('UPDATE warehouses SET name=?, location=?, notes=? WHERE id=?')
      .run(row.name.trim(), row.location || 'داخل المصنع', row.notes || null, id);
    else id = db.prepare('INSERT INTO warehouses (name, location, notes) VALUES (?,?,?)')
      .run(row.name.trim(), row.location || 'داخل المصنع', row.notes || null).lastInsertRowid;
    audit(db, userId, id ? 'update' : 'create', 'warehouse', id, before, row);
    return { id };
  });
  ipcMain.handle('warehouses:delete', (e, id, userId) => {
    const db = getDb();
    const used = db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE warehouse_id=?').get(id).c;
    if (used > 0) throw new Error('لا يمكن حذف مخزن له حركات مخزون');
    const before = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
    db.prepare('DELETE FROM warehouses WHERE id=?').run(id);
    audit(db, userId, 'delete', 'warehouse', id, before, null);
    return { ok: true };
  });
};
