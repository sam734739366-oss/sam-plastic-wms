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
  // صنف الأكياس المرتبط بالصنف المُعبَّأ (يُخصم آلياً عند استلام الإنتاج التام)
  if (!cols.includes('bag_item_id')) d.exec('ALTER TABLE items ADD COLUMN bag_item_id INTEGER REFERENCES items(id)');
  // مخزن الرصيد الافتتاحي: يُحدد المستخدم أي مخزن يحتضن حركات الافتتاح
  add('opening_warehouse_id', 'opening_warehouse_id INTEGER');
  if (!cols.includes('opening_warehouse_id')) {
    d.exec(`UPDATE items SET opening_warehouse_id = COALESCE(
      (SELECT m.warehouse_id FROM stock_moves m WHERE m.doc_type='opening' AND m.item_id = items.id LIMIT 1),
      (SELECT w.id FROM warehouses w ORDER BY w.id LIMIT 1))
      WHERE opening_warehouse_id IS NULL`);
  }
  // الصنف المكمل (أغطية ونحوها): يُستبعد من جرد المخزون، وتُعلَّم الأغطية الحالية تلقائياً
  if (!cols.includes('is_complement')) {
    d.exec('ALTER TABLE items ADD COLUMN is_complement INTEGER NOT NULL DEFAULT 0');
    d.exec("UPDATE items SET is_complement=1 WHERE unit_name='غطاء'");
  }
  // كراتين خام العميل (النفخ للغير): الكرتون يحمل مالكه ومصدره وسند الاستلام الأصلي.
  // الكراتين القديمة كلها من مشتريات المصنع، فالقيمة الافتراضية 'own' صحيحة لها.
  const cartonCols = d.prepare('PRAGMA table_info(cartons)').all().map(c => c.name);
  const cartonAdd = (name, sql) => { if (!cartonCols.includes(name)) d.exec(`ALTER TABLE cartons ADD COLUMN ${sql}`); };
  cartonAdd('party_id', 'party_id INTEGER REFERENCES parties(id)');
  cartonAdd('receipt_id', 'receipt_id INTEGER REFERENCES customer_raw_receipts(id)');
  if (!cartonCols.includes('source')) {
    d.exec(`ALTER TABLE cartons ADD COLUMN source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own','customer'))`);
  }
  // سندات التالف: تخزين توزيع الخصم (تالف/سليم) لعكس الأثر بدقة عند التعديل والإلغاء
  const scrapCols = d.prepare('PRAGMA table_info(scrap_movements)').all().map(c => c.name);
  const scrapAdd = (name, sql) => { if (!scrapCols.includes(name)) d.exec(`ALTER TABLE scrap_movements ADD COLUMN ${sql}`); };
  scrapAdd('talef_take', 'talef_take INTEGER NOT NULL DEFAULT 0');
  scrapAdd('salem_take', 'salem_take INTEGER NOT NULL DEFAULT 0');
  scrapAdd('is_customer', 'is_customer INTEGER NOT NULL DEFAULT 0');
  // ربط سند التالف التلقائي بكرتون الإنتاج (لا يوجد doc_id في هذا الجدول)
  scrapAdd('prod_carton_id', 'prod_carton_id INTEGER REFERENCES cartons(id)');
  // توسيع قيد «مصير التالف» ليشمل تالف نتيجة الإنتاج بخام العميل.
  // SQLite لا يعدّل قيود الأعمدة بعد الإنشاء، فتُعاد بناء الجدول مع الحفاظ على المعرّفات
  // حتى لا تنقطع إشارات stock_moves (doc_type='scrap') ولا يتكرر تسلسل AUTOINCREMENT.
  const scrapTbl = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scrap_movements'").get();
  if (scrapTbl && !scrapTbl.sql.includes("'production_defect'")) {
    d.exec('PRAGMA foreign_keys = OFF');
    try {
      d.exec('ALTER TABLE scrap_movements RENAME TO scrap_movements_old');
      d.exec(`CREATE TABLE scrap_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_number TEXT NOT NULL UNIQUE,
        doc_date TEXT NOT NULL,
        item_id INTEGER NOT NULL REFERENCES items(id),
        disposition TEXT NOT NULL CHECK (disposition IN ('to_recycled','to_stock','to_supplier','sold_scrap','production_defect')),
        warehouse_id INTEGER REFERENCES warehouses(id),
        party_id INTEGER REFERENCES parties(id),
        pieces INTEGER NOT NULL DEFAULT 0,
        weight_kg REAL NOT NULL DEFAULT 0,
        price REAL,
        talef_take INTEGER NOT NULL DEFAULT 0,
        salem_take INTEGER NOT NULL DEFAULT 0,
        is_customer INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        prod_carton_id INTEGER REFERENCES cartons(id)
      )`);
      // قائمة الأعمدة صراحةً: SELECT * يفشل لأن الجدول الجديد عمود أكثر من القديم،
      // والقواعد الأقدم قد تفتقد أعمدة أُضيفت لاحقاً (created_at/is_customer/...) فتُستكمل بالافتراضي.
      const oldScrapCols = d.prepare('PRAGMA table_info(scrap_movements_old)').all().map(c => c.name);
      const has = (c) => oldScrapCols.includes(c);
      // عمود nullable قديم → قيمة افتراضية عند الغياب
      const val = (col, def) => (has(col) ? col : `${def} AS ${col}`);
      // الجدول الجديد يفرض NOT NULL على أعمدة كانت مسموحة بالـ NULL في القواعد القديمة،
      // فصفوف البيانات الحقيقية بقيم NULL تُستكمل بالافتراضي وإلا أجهض الترقية كلها
      const nn = (col, def) => (has(col) ? `COALESCE(${col}, ${def}) AS ${col}` : `${def} AS ${col}`);
      d.exec(`INSERT INTO scrap_movements (id, doc_number, doc_date, item_id, disposition, warehouse_id,
          party_id, pieces, weight_kg, price, talef_take, salem_take, is_customer, notes, status,
          created_by, created_at, prod_carton_id)
        SELECT id, doc_number, doc_date, item_id, disposition, ${val('warehouse_id', 'NULL')},
          ${val('party_id', 'NULL')}, ${nn('pieces', '0')}, ${nn('weight_kg', '0')}, ${val('price', 'NULL')},
          ${nn('talef_take', '0')}, ${nn('salem_take', '0')}, ${nn('is_customer', '0')},
          ${val('notes', 'NULL')}, ${nn('status', "'active'")},
          ${val('created_by', 'NULL')}, ${nn('created_at', "datetime('now','localtime')")},
          ${val('prod_carton_id', 'NULL')}
        FROM scrap_movements_old`);
      d.exec('DROP TABLE scrap_movements_old');
    } finally {
      d.exec('PRAGMA foreign_keys = ON');
    }
  }
  // الفهارس بعد الأعمدة: schema.sql يُنفَّذ قبل migrate()، فأي فهرس على عمود جديد
  // في schema.sql يُسقط التشغيل على قاعدة قديمة لأن العمود لم يُضَف بعد.
  d.exec('CREATE INDEX IF NOT EXISTS idx_cartons_source ON cartons(source, party_id, status)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cartons_receipt ON cartons(receipt_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_scrap_prod_carton ON scrap_movements(prod_carton_id)');
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
    // إعادة بناء الأرصدة الافتتاحية كصفوف مفصولة حسب السلة (سليم/تالف/محرز).
    // في القواعد القديمة كان الافتتاح صفاً واحداً لكل صنف، وعدادات الأصناف تشمل
    // أثر العمليات المنفذة (شراء/صرف/بيع...). لذلك يُحسب الافتتاح لكل سلة كالتالي:
    //   الافتتاح = العداد − صافي حركات السلة غير الافتتاحية
    // حتى لا يُضاعَف أثر العمليات في حركات المخزون ويبقى الجرد مطابقاً للعداد.
    const wh0 = d.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
    if (wh0) {
      d.prepare("DELETE FROM stock_moves WHERE doc_type='opening'").run();
      const netRows = d.prepare(`SELECT item_id, bucket,
          COALESCE(SUM(qty_in_pieces),0) - COALESCE(SUM(qty_out_pieces),0) net
        FROM stock_moves WHERE doc_type != 'opening' GROUP BY item_id, bucket`).all();
      const netOf = (itemId, bucket) => {
        const r = netRows.find(x => x.item_id === itemId && x.bucket === bucket);
        return r ? r.net : 0;
      };
      const items0 = d.prepare('SELECT * FROM items').all();
      const insOpen0 = d.prepare(`INSERT INTO stock_moves
        (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
         qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
        VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
      const today0 = new Date().toISOString().slice(0, 10);
      for (const it of items0) {
        for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
          const qty = (Number(it[`qty_${key}`]) || 0) - netOf(it.id, key);
          if (qty > 0) insOpen0.run(it.id, `افتتاحي-${it.code}`, today0, it.id, wh0.id,
            qty, qty * (Number(it.weight_grams) || 0) / 1000, key, `رصيد افتتاحي (${label})`);
        }
      }
    }
  }
  // سلة كل بند (سليم/تالف/محرز): عمود يخزن اختيار المستخدم لكل سطر في مستندات المخازن
  const bucketTables = ['purchase_items', 'issue_items', 'receive_items', 'exit_items',
    'transfer_items', 'invoice_items', 'sales_return_items', 'purchase_return_items'];
  let hadAnyBucket = false;
  for (const t of bucketTables) {
    const cols = d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (!cols.includes('bucket')) {
      d.exec(`ALTER TABLE ${t} ADD COLUMN bucket TEXT NOT NULL DEFAULT 'salem'`);
    } else {
      hadAnyBucket = true;
    }
  }
  if (!hadAnyBucket) {
    // ترحيل البيانات القديمة: بنود فواتير الخردة → تالف، ومرتجع البيع يرث سلة بند فاتورته الأصلية
    d.exec(`UPDATE invoice_items SET bucket='talef'
      WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_type='scrap')`);
    d.exec(`UPDATE sales_return_items SET bucket = COALESCE(
      (SELECT ii.bucket FROM invoice_items ii
       JOIN sales_returns sr ON sr.invoice_id = ii.invoice_id
       WHERE sr.id = sales_return_items.return_id AND ii.item_id = sales_return_items.item_id
       ORDER BY ii.id LIMIT 1), 'salem')`);
  }
  // بنود استلام الإنتاج التام: أكياس مكتملة + كسور، والأكياس المستهلكة وصنفها
  const recvItemCols = d.prepare('PRAGMA table_info(receive_items)').all().map(c => c.name);
  const riAdd = (name, sql) => { if (!recvItemCols.includes(name)) d.exec(`ALTER TABLE receive_items ADD COLUMN ${sql}`); };
  riAdd('breaks', 'breaks INTEGER NOT NULL DEFAULT 0');
  riAdd('bags_used', 'bags_used INTEGER NOT NULL DEFAULT 0');
  riAdd('bag_item_id', 'bag_item_id INTEGER REFERENCES items(id)');
  if (!recvItemCols.includes('bags_used')) {
    // ترحيل القديم: الاستلام بوحدة الكيس بلا كسور ⇒ الأكياس المستهلكة = العدد المدوّن
    d.exec(`UPDATE receive_items SET bags_used = CAST(quantity AS INTEGER) WHERE unit='كيس' AND breaks = 0`);
  }
  // أدوار المستخدمين (مدير/إدخال عام/عرض فقط/مخازن): إعادة بناء جدول المستخدمين لتوسيع قيد الأدوار
  // وإسقاط دورَي «حسابات» و«مبيعات» الملغيين — من كان دورهما يتحول إلى إدخال عام.
  const userTbl = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  const userRoles = ['manager', 'clerk', 'viewer', 'warehouse'];
  const needsUserRebuild = userTbl && (
    !userRoles.every(r => userTbl.sql.includes(`'${r}'`)) ||
    userTbl.sql.includes("'accounts'") || userTbl.sql.includes("'sales'")
  );
  if (needsUserRebuild) {
    d.exec('PRAGMA foreign_keys = OFF');
    try {
      d.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer','warehouse')),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`);
      // نسخ البيانات مع تحمل أعمدة قديمة ناقصة أو قيم فارغة (created_at مثلاً)
      // وأصحاب الأدوار الملغاة (حسابات/مبيعات) ينتقلون إلى دور «إدخال عام»
      const uCols = d.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      const hasU = (c) => uCols.includes(c);
      const sel = [
        'id',
        hasU('username') ? 'username' : "''",
        hasU('full_name') ? "COALESCE(full_name,'')" : "''",
        hasU('password_hash') ? "COALESCE(password_hash,'')" : "''",
        hasU('role') ? "CASE WHEN COALESCE(role,'clerk') IN ('accounts','sales') THEN 'clerk' ELSE COALESCE(role,'clerk') END" : "'clerk'",
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

// إصلاح لمرة واحدة للأرصدة الافتتاحية في القواعد التي تضررت من ترحيل قديم أعاد بناءها
// من عدادات تشمل أثر العمليات المنفذة (شراء/صرف/بيع...).
// الافتتاح الصحيح لكل صنف × سلة = العداد − صافي حركات السلة غير الافتتاحية.
// تُحذف صفوف الافتتاح وتُعاد كتابتها بالقيم المصححة (الوزن = الكمية × وزن الحبة).
function repairOpenings(d) {
  const wh0 = d.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  if (!wh0) return { changed: [] };
  const oldRows = d.prepare(`SELECT sm.item_id, sm.bucket, sm.qty_in_pieces - sm.qty_out_pieces qty
    FROM stock_moves sm WHERE sm.doc_type='opening'`).all();
  const oldOf = (itemId, bucket) => oldRows
    .filter(r => r.item_id === itemId && r.bucket === bucket)
    .reduce((s, r) => s + r.qty, 0);
  const netRows = d.prepare(`SELECT item_id, bucket,
      COALESCE(SUM(qty_in_pieces),0) - COALESCE(SUM(qty_out_pieces),0) net
    FROM stock_moves WHERE doc_type != 'opening' GROUP BY item_id, bucket`).all();
  const netOf = (itemId, bucket) => {
    const r = netRows.find(x => x.item_id === itemId && x.bucket === bucket);
    return r ? r.net : 0;
  };
  const changes = [];
  const items = d.prepare('SELECT * FROM items').all();
  const today = new Date().toISOString().slice(0, 10);
  withTransaction(d, () => {
    d.prepare("DELETE FROM stock_moves WHERE doc_type='opening'").run();
    const ins = d.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, bucket, notes)
      VALUES ('opening',?,?,?,?,?,?,0,?,0,?,?)`);
    for (const it of items) {
      for (const [key, label] of [['salem', 'سليم'], ['talef', 'تالف'], ['muharraz', 'محرز']]) {
        const qty = (Number(it[`qty_${key}`]) || 0) - netOf(it.id, key);
        const old = oldOf(it.id, key);
        if (qty !== old) changes.push({ item_id: it.id, item_code: it.code, bucket: key, old_qty: old, new_qty: qty });
        if (qty > 0) ins.run(it.id, `افتتاحي-${it.code}`, today, it.id, wh0.id,
          qty, qty * (Number(it.weight_grams) || 0) / 1000, key, `رصيد افتتاحي (${label})`);
      }
    }
  });
  return { changed: changes };
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
  // بيانات الترويسة والتذييل في الطباعة: تُملأ من شاشة الإعدادات، ولها قيم فارغة مبدئياً
  if (!s.get('factory_phone')) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('factory_phone', '');
  for (const k of ['footer_right', 'footer_center', 'footer_left']) {
    if (!s.get(k)) d.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(k, '');
  }
}

module.exports = { getDb, setDb, withTransaction, migrate, repairOpenings, dataDir };
