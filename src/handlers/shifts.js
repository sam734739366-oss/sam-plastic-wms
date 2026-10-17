const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('shifts:list', () => getDb().prepare('SELECT * FROM shifts ORDER BY id').all());
  ipcMain.handle('shifts:save', (e, row, userId) => {
    const db = getDb();
    const before = row.id ? db.prepare('SELECT * FROM shifts WHERE id=?').get(row.id) : null;
    if (!row.name || !row.name.trim()) throw new Error('اسم الوردية مطلوب');
    const dup = db.prepare('SELECT id FROM shifts WHERE name=? AND id IS NOT ?').get(row.name.trim(), row.id || -1);
    if (dup) throw new Error('اسم الوردية مكرر');
    let id = row.id;
    if (id) db.prepare('UPDATE shifts SET name=?, notes=? WHERE id=?')
      .run(row.name.trim(), row.notes || null, id);
    else id = db.prepare('INSERT INTO shifts (name, notes) VALUES (?,?)')
      .run(row.name.trim(), row.notes || null).lastInsertRowid;
    audit(db, userId, id ? 'update' : 'create', 'shift', id, before, row);
    return { id };
  });
  ipcMain.handle('shifts:delete', (e, id, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
    db.prepare('DELETE FROM shifts WHERE id=?').run(id);
    audit(db, userId, 'delete', 'shift', id, before, null);
    return { ok: true };
  });
};
