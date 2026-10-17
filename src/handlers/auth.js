const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('auth:login', (e, username, password) => {
    const db = getDb();
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return null;
    audit(db, u.id, 'login', 'user', u.id, null, null);
    return { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
  });
};
