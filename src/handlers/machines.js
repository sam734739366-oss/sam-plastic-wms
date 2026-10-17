const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('machines:list', () => getDb().prepare('SELECT * FROM machines ORDER BY id').all());
  ipcMain.handle('machines:save', (e, row, userId) => {
    const db = getDb();
    const before = row.id ? db.prepare('SELECT * FROM machines WHERE id=?').get(row.id) : null;
    if (!row.name || !row.name.trim()) throw new Error('اسم المكينة مطلوب');
    const dup = db.prepare('SELECT id FROM machines WHERE name=? AND id IS NOT ?').get(row.name.trim(), row.id || -1);
    if (dup) throw new Error('اسم المكينة مكرر');
    let id = row.id;
    if (id) db.prepare('UPDATE machines SET name=?, notes=? WHERE id=?')
      .run(row.name.trim(), row.notes || null, id);
    else id = db.prepare('INSERT INTO machines (name, notes) VALUES (?,?)')
      .run(row.name.trim(), row.notes || null).lastInsertRowid;
    audit(db, userId, id ? 'update' : 'create', 'machine', id, before, row);
    return { id };
  });
  ipcMain.handle('machines:delete', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM machines WHERE id=?').get(id);
    db.prepare('DELETE FROM machines WHERE id=?').run(id);
    audit(db, userId, 'delete', 'machine', id, before, null);
    return { ok: true };
  });
};
