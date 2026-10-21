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

function migrate(d) {
  // إضافة أعمدة نظام الأصناف الجديد لقواعد البيانات القديمة دون فقدان بياناتها
  const cols = d.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  const add = (name, sql) => { if (!cols.includes(name)) d.exec(`ALTER TABLE items ADD COLUMN ${sql}`); };
  add('pieces_per_shadda', 'pieces_per_shadda INTEGER');
  add('qty_salem', 'qty_salem INTEGER NOT NULL DEFAULT 0');
  add('qty_talef', 'qty_talef INTEGER NOT NULL DEFAULT 0');
  add('qty_muharraz', 'qty_muharraz INTEGER NOT NULL DEFAULT 0');
  // سندات التالف: تخزين توزيع الخصم (تالف/سليم) لعكس الأثر بدقة عند التعديل والإلغاء
  const scrapCols = d.prepare('PRAGMA table_info(scrap_movements)').all().map(c => c.name);
  const scrapAdd = (name, sql) => { if (!scrapCols.includes(name)) d.exec(`ALTER TABLE scrap_movements ADD COLUMN ${sql}`); };
  scrapAdd('talef_take', 'talef_take INTEGER NOT NULL DEFAULT 0');
  scrapAdd('salem_take', 'salem_take INTEGER NOT NULL DEFAULT 0');
  scrapAdd('is_customer', 'is_customer INTEGER NOT NULL DEFAULT 0');
  // ترحيل قيمة العملة القديمة (اسم) إلى الرمز الجديد
  const cur = d.prepare("SELECT value FROM settings WHERE key='currency'").get();
  if (cur && !['YER', 'SAR', 'USD'].includes(cur.value)) {
    d.prepare("UPDATE settings SET value='YER' WHERE key='currency'").run();
  }
  // أرصدة افتتاحية: كميات سليم/تالف/محرز المحفوظة في جدول الأصناف (من إصدارات سابقة)
  // تُحوَّل إلى حركات مخزون افتتاحية حتى تظهر في الجرد والتقارير وتصبح قابلة للصرف والبيع.
  // العملية تراكمية وآمنة: تُنشئ الفرق فقط إن كان المجموع أكبر من صافي الحركات القائمة.
  const wh = d.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  if (wh) {
    const items = d.prepare('SELECT * FROM items').all();
    const balRows = d.prepare(`SELECT item_id,
        COALESCE(SUM(qty_in_pieces),0) - COALESCE(SUM(qty_out_pieces),0) bal
      FROM stock_moves GROUP BY item_id`).all();
    const balByItem = new Map(balRows.map(r => [r.item_id, r.bal]));
    const insOpen = d.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
      VALUES ('opening',?,?,?,?,?,?,0,?,0,?)`);
    const today = new Date().toISOString().slice(0, 10);
    for (const it of items) {
      const total = (Number(it.qty_salem) || 0) + (Number(it.qty_talef) || 0) + (Number(it.qty_muharraz) || 0);
      const diff = total - (balByItem.get(it.id) || 0);
      if (diff > 0) {
        insOpen.run(it.id, `افتتاحي-${it.code}`, today, it.id, wh.id, diff,
          diff * (Number(it.weight_grams) || 0) / 1000, 'رصيد افتتاحي (سليم/تالف/محرز)');
      }
    }
  }
}

function getDb() {
  if (db) return db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'samplastic.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
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
  // مخزن واحد افتراضي في بداية التشغيل؛ يمكن إضافة مخازن أخرى من شاشة المخازن عند الحاجة.
  const whCount = d.prepare('SELECT COUNT(*) c FROM warehouses').get().c;
  if (whCount === 0) {
    d.prepare('INSERT INTO warehouses (name, location) VALUES (?,?)').run('المخزن الرئيسي', 'داخل المصنع');
  }
  const insertShift = d.prepare('INSERT OR IGNORE INTO shifts (name) VALUES (?)');
  insertShift.run('صباحية');
  insertShift.run('مسائية');
  const s = d.prepare('SELECT value FROM settings WHERE key = ?');
  if (!s.get('factory_name')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('factory_name', 'سام بلاستيك');
  if (!s.get('doc_page_size')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('doc_page_size', 'A5');
  if (!s.get('report_page_size')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('report_page_size', 'A4');
  if (!s.get('currency')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('currency', 'YER');
}

module.exports = { getDb, setDb, withTransaction, dataDir };
