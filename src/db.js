const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

let db = null;

function dataDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch { /* plain node (tests) */ }
  return path.join(__dirname, '..', 'data');
}

function setDb(d) { db = d; }

function getDb() {
  if (db) return db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'samplastic.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seed(db);
  return db;
}

function withTransaction(d, fn) {
  if (d.isTransaction) return fn();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function seed(d) {
  const admin = d.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    d.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)")
      .run('admin', 'المدير', bcrypt.hashSync('admin123', 10), 'manager');
  }
  const insertWarehouse = d.prepare('INSERT OR IGNORE INTO warehouses (name, location) VALUES (?,?)');
  insertWarehouse.run('مخزن المواد الخام', 'داخل المصنع');
  insertWarehouse.run('مخزن الإنتاج التام', 'داخل المصنع');
  insertWarehouse.run('مخزن المحرز والتالف', 'داخل المصنع');
  const insertShift = d.prepare('INSERT OR IGNORE INTO shifts (name) VALUES (?)');
  insertShift.run('صباحية');
  insertShift.run('مسائية');
  const s = d.prepare('SELECT value FROM settings WHERE key = ?');
  if (!s.get('factory_name')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('factory_name', 'سام بلاستيك');
  if (!s.get('doc_page_size')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('doc_page_size', 'A5');
  if (!s.get('report_page_size')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('report_page_size', 'A4');
  if (!s.get('currency')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('currency', 'ريال يمني');
}

module.exports = { getDb, setDb, withTransaction, dataDir };
