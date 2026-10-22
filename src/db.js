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
  // عمود تصنيف الحركة (سليم/تالف/محرز): يجعل أعمدة الجرد محسوبة لكل مخزن على حدة
  const moveCols = d.prepare('PRAGMA table_info(stock_moves)').all().map(c => c.name);
  const hadBucket = moveCols.includes('bucket');
  if (!hadBucket) {
    d.exec('ALTER TABLE stock_moves ADD COLUMN bucket TEXT');
    // ترحيل الحركات القائمة: توزيع السلات حسب نوع المستند
    d.exec(`UPDATE stock_moves SET bucket='salem' WHERE doc_type IN ('purchase','issue','exit','receive','transfer') AND bucket IS NULL`);
    d.exec(`UPDATE stock_moves SET bucket='talef' WHERE doc_type='invoice' AND doc_id IN (SELECT id FROM invoices WHERE invoice_type='scrap') AND bucket IS NULL`);
    d.exec(`UPDATE stock_moves SET bucket='salem' WHERE doc_type='invoice' AND doc_id IN (SELECT id FROM invoices WHERE invoice_type='sale') AND bucket IS NULL`);
    d.exec(`UPDATE stock_moves SET bucket='muharraz' WHERE doc_type='scrap' AND doc_id IN (SELECT id FROM scrap_movements WHERE disposition='to_recycled') AND bucket IS NULL`);
    d.exec(`UPDATE stock_moves SET bucket='salem' WHERE doc_type='scrap' AND doc_id IN (SELECT id FROM scrap_movements WHERE disposition='to_stock') AND bucket IS NULL`);
    d.exec(`UPDATE stock_moves SET bucket='talef' WHERE doc_type='scrap' AND bucket IS NULL AND doc_id IN (SELECT id FROM scrap_movements WHERE talef_take > 0)`);
    d.exec(`UPDATE stock_moves SET bucket='salem' WHERE bucket IS NULL`);
    // إعادة بناء الأرصدة الافتتاحية كصفوف مفصولة حسب السلة (سليم/تالف/محرز)
    const wh0 = d.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
    if (wh0) {
      d.prepare("DELETE FROM stock_moves WHERE doc_type='opening'").run();
      const items0 = d.prepare('SELECT * FROM items').all();
      const insOpen0 = d.prepare(`INSERT INTO stock_moves
        (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
         qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
        VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
      const today0 = new Date().toISOString().slice(0, 10);
      for (const it of items0) {
        for (const [key, qty, label] of [
          ['salem', Number(it.qty_salem) || 0, 'سليم'],
          ['talef', Number(it.qty_talef) || 0, 'تالف'],
          ['muharraz', Number(it.qty_muharraz) || 0, 'محرز'],
        ]) {
          if (qty > 0) insOpen0.run(it.id, `افتتاحي-${it.code}`, today0, it.id, wh0.id,
            qty, qty * (Number(it.weight_grams) || 0) / 1000, key, `رصيد افتتاحي (${label})`);
        }
      }
    }
  }
  // أدوار المستخدمين الجديدة (مخازن/حسابات/مبيعات): إعادة بناء جدول المستخدمين لتوسيع قيد الأدوار
  const userTbl = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  const userRoles = ['manager', 'clerk', 'viewer', 'warehouse', 'accounts', 'sales'];
  const needsUserRebuild = userTbl && !userRoles.every(r => userTbl.sql.includes(`'${r}'`));
  if (needsUserRebuild) {
    d.exec('PRAGMA foreign_keys = OFF');
    try {
      d.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer','warehouse','accounts','sales')),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`);
      // نسخ البيانات مع تحمل أعمدة قديمة ناقصة أو قيم فارغة (created_at مثلاً)
      const uCols = d.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      const hasU = (c) => uCols.includes(c);
      const sel = [
        'id',
        hasU('username') ? 'username' : "''",
        hasU('full_name') ? "COALESCE(full_name,'')" : "''",
        hasU('password_hash') ? "COALESCE(password_hash,'')" : "''",
        hasU('role') ? "COALESCE(role,'clerk')" : "'clerk'",
        hasU('created_at') ? "COALESCE(created_at, datetime('now','localtime'))" : "datetime('now','localtime')",
      ].join(', ');
      d.exec(`INSERT INTO users_new (id, username, full_name, password_hash, role, created_at)
        SELECT ${sel} FROM users`);
      d.exec('DROP TABLE users');
      d.exec('ALTER TABLE users_new RENAME TO users');
    } finally {
      d.exec('PRAGMA foreign_keys = ON');
    }
  }
  // طريقة الدفع (نقدي/آجل) للفواتير + دفتر حركات الأطراف والنقدية
  const invCols2 = d.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!invCols2.includes('payment_method')) {
    d.exec(`ALTER TABLE invoices ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit'))`);
  }
  const purCols2 = d.prepare('PRAGMA table_info(purchases)').all().map(c => c.name);
  if (!purCols2.includes('payment_method')) {
    d.exec(`ALTER TABLE purchases ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit'))`);
  }
  // عمود الوحدة في بنود استلام خام العميل (النفخ للغير): اختيار وحدة الصنف وتوابعه
  const rawItemCols = d.prepare('PRAGMA table_info(customer_raw_items)').all().map(c => c.name);
  if (!rawItemCols.includes('unit')) {
    d.exec(`ALTER TABLE customer_raw_items ADD COLUMN unit TEXT NOT NULL DEFAULT 'علبة'`);
  }
  // ربط تصريح الاستلام بتصريح الصرف: متابعة دورة الكراتين (نقص/زيادة المستلم مقابل المصروف)
  const recvCols = d.prepare('PRAGMA table_info(receive_permits)').all().map(c => c.name);
  if (!recvCols.includes('issue_permit_id')) {
    d.exec(`ALTER TABLE receive_permits ADD COLUMN issue_permit_id INTEGER REFERENCES issue_permits(id)`);
  }
  // ترحيل الفواتير القديمة للدفتر كآجلة (بلا لمس النقدية بأثر رجعي)
  const ledCount = d.prepare('SELECT COUNT(*) c FROM party_ledger').get().c;
  if (ledCount === 0) {
    d.exec(`INSERT INTO party_ledger (party_id, doc_type, doc_id, doc_number, doc_date, side, amount, cash_in, cash_out, notes)
      SELECT p.party_id, 'invoice', p.id, p.doc_number, p.doc_date, 'debit',
        COALESCE((SELECT SUM(total_price) FROM invoice_items WHERE invoice_id=p.id),0), 0, 0,
        'فاتورة ' || p.invoice_type
      FROM invoices p WHERE p.status='active' AND p.party_id IS NOT NULL`);
    d.exec(`INSERT INTO party_ledger (party_id, doc_type, doc_id, doc_number, doc_date, side, amount, cash_in, cash_out, notes)
      SELECT p.party_id, 'purchase', p.id, p.doc_number, p.doc_date, 'credit',
        COALESCE((SELECT SUM(total_price) FROM purchase_items WHERE purchase_id=p.id),0), 0, 0,
        'فاتورة شراء'
      FROM purchases p WHERE p.status='active' AND p.party_id IS NOT NULL`);
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

module.exports = { getDb, setDb, withTransaction, migrate, dataDir };
