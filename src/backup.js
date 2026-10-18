const path = require('path');
const fs = require('fs');
const { getDb, setDb, dataDir } = require('./db');

function backupsDir(dir) {
  const d = path.join(dir || dataDir(), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createBackup(db, dir) {
  db = db || getDb();
  const base = dir || dataDir();
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* in-memory */ }
  const name = `سام-بلاستيك-نسخة-${stamp()}.db`;
  const src = path.join(base, 'samplastic.db');
  const target = path.join(backupsDir(base), name);
  fs.copyFileSync(src, target);
  let cloudPath = null;
  const row = db.prepare("SELECT value FROM settings WHERE key='cloud_folder'").get();
  if (row && row.value && fs.existsSync(row.value)) {
    try {
      fs.copyFileSync(src, path.join(row.value, name));
      cloudPath = path.join(row.value, name);
    } catch { cloudPath = null; }
  }
  return { ok: true, name, path: target, cloud_path: cloudPath };
}

function listBackups(dir) {
  const d = backupsDir(dir);
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const s = fs.statSync(path.join(d, f));
      return { name: f, size: s.size, mtime: s.mtimeMs, path: path.join(d, f) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function restoreBackup(filePath, db, dir) {
  const d = db || getDb();
  const base = dir || dataDir();
  d.close();
  const dbPath = path.join(base, 'samplastic.db');
  fs.copyFileSync(filePath, dbPath);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  if (!db) { setDb(null); getDb(); }
  return { ok: true };
}

module.exports = { createBackup, listBackups, restoreBackup, backupsDir };
