const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('users:list', () => getDb().prepare('SELECT id, username, full_name, role, created_at FROM users ORDER BY id').all());
  ipcMain.handle('users:save', (e, row, userId) => {
    const db = getDb();
    if (!row.username || !row.username.trim()) throw new Error('اسم المستخدم مطلوب');
    if (!row.full_name || !row.full_name.trim()) throw new Error('الاسم الكامل مطلوب');
    const before = row.id ? db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(row.id) : null;
    const dup = db.prepare('SELECT id FROM users WHERE username=? AND id IS NOT ?').get(row.username.trim(), row.id || -1);
    if (dup) throw new Error('اسم المستخدم مكرر');
    let id = row.id;
    if (id) {
      if (row.password) {
        db.prepare('UPDATE users SET username=?, full_name=?, role=?, password_hash=? WHERE id=?')
          .run(row.username.trim(), row.full_name.trim(), row.role || 'clerk', bcrypt.hashSync(String(row.password), 10), id);
      } else {
        db.prepare('UPDATE users SET username=?, full_name=?, role=? WHERE id=?')
          .run(row.username.trim(), row.full_name.trim(), row.role || 'clerk', id);
      }
    } else {
      if (!row.password) throw new Error('كلمة المرور مطلوبة للمستخدم الجديد');
      id = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)')
        .run(row.username.trim(), row.full_name.trim(), bcrypt.hashSync(String(row.password), 10), row.role || 'clerk').lastInsertRowid;
    }
    audit(db, userId, id ? 'update' : 'create', 'user', id, before, row);
    return { id };
  });
  ipcMain.handle('users:delete', (e, id, userId) => {
    const db = getDb();
    const u = db.prepare('SELECT username FROM users WHERE id=?').get(id);
    if (!u) throw new Error('المستخدم غير موجود');
    if (u.username === 'admin') throw new Error('لا يمكن حذف المستخدم المدير الأساسي');
    if (id === userId) throw new Error('لا يمكنك حذف حسابك الحالي');
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    audit(db, userId, 'delete', 'user', id, u, null);
    return { ok: true };
  });
};
