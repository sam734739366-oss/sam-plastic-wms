const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

let db = null;

// إصدار المخطط: أي قاعدة أقل من هذا الإصدار تُؤرشف وتُبنى قاعدة جديدة نظيفة.
// القفز إلى 2 يعني نهاية حالة «ملغى» ونهاية ترحيلات v1 — فلا معنى لمحاولة ترقية بيانات v1.
const SCHEMA_VERSION = 2;
const DB_FILE = 'samplastic.db';
const V1_BACKUP_FILE = 'samplastic_v1_backup.db';

function dataDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch { /* plain node (tests) */ }
  return path.join(__dirname, '..', 'data');
}

function setDb(d) { db = d; }

// يقرأ settings.schema_version من ملف موجود. قاعدة بلا جدول settings أو بلا المفتاح = v1.
// قاعدة لا تُفتح (تالفة/مقفلة) تُعامَل كقديمة حتى لا يُجهض الإقلاع، وتُحفظ بامتداد خاص.
function readSchemaVersion(file) {
  let probe = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const row = probe.prepare("SELECT value FROM settings WHERE key='schema_version'").get();
    const v = Number(row && row.value);
    return Number.isFinite(v) ? v : 1;
  } catch {
    return 0;
  } finally {
    try { probe && probe.close(); } catch { /* ignore */ }
  }
}

function sideFiles(file) {
  return [file, `${file}-wal`, `${file}-shm`].filter((f) => fs.existsSync(f));
}

function freeTarget(base) {
  if (!fs.existsSync(base)) return base;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return base.replace(/\.db$/, `-at-${stamp}.db`);
}

// إعادة التهيئة الآمنة: نسخ إلى backups/ ثم إعادة تسمية القاعدة القديمة و-WAL/-shm معها،
// فتُبنى القاعدة الجديدة من الصفر في الخطوة التالية. لا حذف لأي ملف في أي مسار.
function ensureFreshDatabase(dir) {
  const file = path.join(dir, DB_FILE);
  if (!fs.existsSync(file)) return { reset: false, reason: 'new' };
  const version = readSchemaVersion(file);
  if (version >= SCHEMA_VERSION) return { reset: false, reason: 'current', version };

  const backup = freeTarget(path.join(dir, V1_BACKUP_FILE));
  const moved = [];
  let copiedTo = null;
  try {
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    copiedTo = path.join(bdir, `قبل-ترقية-v${SCHEMA_VERSION}-${path.basename(backup)}`);
    fs.copyFileSync(file, copiedTo);
  } catch { /* النسخ احتياط إضافي: إعادة التسمية وحدها تكفي لحفظ البيانات */ }

  for (const f of sideFiles(file)) {
    const to = f === file ? backup : freeTarget(`${path.dirname(backup)}\\${path.basename(f).replace(DB_FILE, path.basename(backup))}`);
    fs.renameSync(f, to);
    moved.push(to);
  }
  return { reset: true, from: version, backup, copiedTo, moved };
}

// ترحيلات داخل نفس إصدار المخطط فقط. الترقية بين الإصدارات لا تمرّ من هنا:
// قاعدة v1 تُؤرشف ويُبنى بديلها الجديد من schema.sql مباشرة.
function migrate(d) {
  d.exec('CREATE INDEX IF NOT EXISTS idx_stock_date ON stock_moves(doc_date)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cartons_issue ON cartons(issue_permit_id)');
  const cur = d.prepare("SELECT value FROM settings WHERE key='currency'").get();
  if (cur && !['YER', 'SAR', 'USD'].includes(cur.value)) {
    d.prepare("UPDATE settings SET value='YER' WHERE key='currency'").run();
  }
}

function getDb() {
  if (db) return db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const reset = ensureFreshDatabase(dir);
  if (reset.reset) {
    // مخرج قياسي واحد يوثّق أن البيانات القديمة محفوظة ولم تُحذف
    console.log(`[db] قاعدة أقدم (إصدار ${reset.from || 'مجهول'}) أُرشفت إلى ${path.basename(reset.backup)}`);
  }
  db = new DatabaseSync(path.join(dir, DB_FILE));
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
  const put = d.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
  // المفتاح يُكتب أولاً: وجوده هو ما يميّز قاعدة v2 عن أي قاعدة أقدم عند الإقلاع التالي
  if (!s.get('schema_version')) put.run('schema_version', String(SCHEMA_VERSION));
  if (!s.get('factory_name')) put.run('factory_name', 'سام بلاستيك');
  if (!s.get('doc_page_size')) put.run('doc_page_size', 'A5');
  if (!s.get('report_page_size')) put.run('report_page_size', 'A4');
  if (!s.get('currency')) put.run('currency', 'YER');
  // بيانات الترويسة والتذييل في الطباعة: تُملأ من شاشة الإعدادات، ولها قيم فارغة مبدئياً
  if (!s.get('factory_phone')) put.run('factory_phone', '');
  if (!s.get('factory_address')) put.run('factory_address', '');
  for (const k of ['footer_right', 'footer_center', 'footer_left']) {
    if (!s.get(k)) put.run(k, '');
  }
}

module.exports = {
  getDb, setDb, withTransaction, migrate, seed, dataDir,
  ensureFreshDatabase, readSchemaVersion, SCHEMA_VERSION, DB_FILE, V1_BACKUP_FILE,
};
