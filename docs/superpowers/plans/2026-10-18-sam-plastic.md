# سام بلاستيك — خطة التنفيذ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan stage-by-stage. Steps use checkbox (`- [ ]`) syntax for tracking. **Checkpoint after each Stage: the user runs the app and approves before the next Stage.**

**Goal:** برنامج سطح مكتب ويندوز «سام بلاستيك» لإدارة مصنع نفخ عبوات بلاستيكية: مخازن، مشتريات، مبيعات، تصاريح صرف/استلام، نفخ للغير، تقارير وطباعة.

**Architecture:** Electron (main + preload + renderer بدون bundler) مع SQLite. كل منطق الأعمال (تحويلات الوحدات، حركات المخزون) في وحدات JS نقية قابلة للاختبار بـ node:test. الأرصدة تُحسب من دفتر `stock_moves` (append-only مع reversals). الطباعة عبر نافذة print.html + قوالب HTML بمقاس A4/A5.

**Tech Stack:** Electron (أحدث إصدار مستقر)، SQLite، bcryptjs، node:test. بدون إطار عمل للواجهة — HTML/CSS/JS عربي RTL.

> **قرار تقني (نُفّذ في المرحلة 1):** قاعدة البيانات عبر `node:sqlite` المدمج (DatabaseSync) بدل better-sqlite3 — الجهاز لا يملك مترجم MSVC والوحدة الأصلية لا تملك ملفات مبنية جاهزة لإصدار Electron الحالي. بديل `db.transaction()` هو `withTransaction(db, fn)` من `src/db.js` (BEGIN IMMEDIATE/COMMIT/ROLLBACK يدوي). كل `require('better-sqlite3')` في هذه الخطة يُقرأ `require('node:sqlite')` مع `DatabaseSync`، وكل `db.pragma(x)` يصبح `db.exec('PRAGMA ' + x)`.

**Spec:** `docs/superpowers/specs/2026-10-18-sam-plastic-design.md`

**جذر المشروع:** `C:\Users\Elite\Desktop\سام بلاستيك` (أمر المستخدم الصريح).

## Global Constraints

- الواجهة عربية RTL بالكامل — كل النصوص الظاهرة للمستخدم عربية.
- العملة: ريال يمني — كل المبالغ بصيغة `1,234.56`.
- الوحدات: جرام/كجم/طن + حبة/علبة/كيس/كرتون — التحويل من وزن الحبة (جرام).
- ترقيم المستندات **يدوي** (المستخدم يدخل الرقم) مع فحص عدم التكرار لكل نوع مستند + اقتراح الرقم التالي.
- التكويد **يدوي**: كود الصنف نص مثل `001-001` مع فحص التكرار.
- كل مستند له حقل `ملاحظات` (notes) وكل شاشة بيانات أساسية كذلك.
- المدير: صلاحية كاملة (تعديل/حذف/إلغاء مع نافذة تداعيات). أدوار إضافية: clerk (إدخال فقط، بدون حذف)، viewer (عرض فقط).
- الإلغاء (void) بدل الحذف للمستندات المرتبطة بعمليات؛ reversals في stock_moves تحفظ سلامة الأرصدة.
- سجل تدقيق لكل create/update/void/delete/print.
- Windows 10/11 فقط. Node ≥ 20 مطلوب للبناء.

## بنية الملفات

```
سام بلاستيك/
├── package.json
├── .gitignore                # node_modules, data/*.db*, dist
├── تشغيل البرنامج.bat        # chcp 65001 && npm start
├── main.js                   # نافذة رئيسية + تسجيل ipcMain + فتح نافذة الطباعة
├── preload.js                # contextBridge → window.api
├── src/
│   ├── db.js                 # فتح DB + schema + seed
│   ├── schema.sql            # كل الجداول (كامل منذ المرحلة 1)
│   ├── units.js              # تحويلات الوحدات (نقية)
│   ├── stock.js              # كاتب stock_moves مع reversals + حسابات الرصيد
│   ├── audit.js              # كاتب سجل التدقيق
│   ├── docs.js               # أرقام المستندات اليدوية: اقتراح + فحص تكرار
│   ├── ipc.js                # تسجيل كل معالجات IPC
│   ├── handlers/             # معالج لكل مجال (auth, settings, warehouses, ...)
│   └── print/templates.js    # قوالب HTML للمستندات
├── renderer/
│   ├── index.html            # تسجيل الدخول
│   ├── app.html              # الهيكل الرئيسي (شريط جانبي + شاشات)
│   ├── print/print.html      # مضيف الطباعة (معاينة + طباعة)
│   ├── css/app.css           # الثيم العربي RTL
│   └── js/
│       ├── api.js            # غلاف window.api
│       ├── fmt.js            # تنسيق أرقام/وحدات
│       ├── ui.js             # جدول/نموذج/توست/حوار تأكيد/نافذة تداعيات
│       └── screens/*.js      # شاشة لكل مجال
├── tests/
│   ├── units.test.js
│   └── stock.test.js
└── data/                     # samplastic.db (مستبعد من git)
```

---

## Stage 1: الأساس — قاعدة البيانات، الدخول، الإعدادات، المخازن/المكائن/الورديات

**Deliverable:** البرنامج يعمل، دخول بمدير افتراضي، إدارة المخازن والمكائن والورديات والمستخدمين، إعدادات المصنع، لوحة رئيسية فارغة البيانات.

### Task 1.1: الهيكل والمشروع

**Files:**
- Create: `package.json`, `.gitignore`, `تشغيل البرنامج.bat`, `main.js`, `preload.js`
- Bash: `git init` في جذر المشروع (أول أمر قبل أي ملف)

- [ ] **Step 1: تهيئة git وإنشاء package.json**

```bash
cd "/c/Users/Elite/Desktop/سام بلاستيك" && git init -b main
```

`package.json`:
```json
{
  "name": "sam-plastic",
  "version": "0.1.0",
  "description": "برنامج سام بلاستيك لإدارة مصنع نفخ العبوات البلاستيكية",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test tests/",
    "rebuild": "electron-rebuild -f -w better-sqlite3",
    "dist": "electron-builder"
  },
  "build": {
    "appId": "com.samplastic.app",
    "productName": "سام بلاستيك",
    "files": ["main.js", "preload.js", "src/**/*", "renderer/**/*", "package.json"],
    "win": { "target": "nsis" }
  },
  "devDependencies": {
    "electron": "latest",
    "@electron/rebuild": "latest",
    "electron-builder": "latest"
  },
  "dependencies": {
    "better-sqlite3": "latest",
    "bcryptjs": "latest"
  }
}
```

- [ ] **Step 2: التثبيت وإعادة بناء الوحدة الأصلية**

```bash
npm install && npx electron-rebuild -f -w better-sqlite3
```

- [ ] **Step 3: `.gitignore`**

```
node_modules/
data/
dist/
```

- [ ] **Step 4: `تشغيل البرنامج.bat`**

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
npm start
```

- [ ] **Step 5: `main.js` — النافذة الرئيسية**

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1366, height: 850, minWidth: 1100, minHeight: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 6: `preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  openPrint: (payload) => ipcRenderer.invoke('print:open', payload)
});
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold electron project"
```

### Task 1.2: قاعدة البيانات — schema كامل + seed

**Files:**
- Create: `src/schema.sql`, `src/db.js`
- Test: `tests/units.test.js` (لا يعتمد على DB)

**Interfaces:**
- Produces: `getDb()` → better-sqlite3 Database مفتوح بـ WAL. يستدعيه كل handlers عبر `require('./db').getDb()`.

- [ ] **Step 1: `src/schema.sql`** — كل الجداول من القسم 4 في الـ spec:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_group INTEGER NOT NULL CHECK (item_group BETWEEN 1 AND 5),
  unit_name TEXT NOT NULL DEFAULT 'حبة',
  weight_grams REAL,
  pieces_per_carton INTEGER,
  pieces_per_bag INTEGER,
  service_price REAL,
  is_recycled INTEGER NOT NULL DEFAULT 0,
  brand TEXT,
  size_label TEXT,
  bale_size TEXT,
  bale_condition TEXT,
  bale_mixed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('supplier','customer','both')),
  phone TEXT, address TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL DEFAULT 'داخل المصنع',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER REFERENCES parties(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  unit_price REAL,
  total_price REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS cartons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carton_number TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  purchase_id INTEGER REFERENCES purchases(id),
  pieces INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','issued','finished')),
  issue_date TEXT,
  issue_permit_id INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS issue_permits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  machine_id INTEGER REFERENCES machines(id),
  shift_id INTEGER REFERENCES shifts(id),
  receiver_name TEXT,
  source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own','customer')),
  party_id INTEGER REFERENCES parties(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS issue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_permit_id INTEGER NOT NULL REFERENCES issue_permits(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  carton_ids TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS production_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carton_id INTEGER NOT NULL UNIQUE REFERENCES cartons(id),
  issue_permit_id INTEGER REFERENCES issue_permits(id),
  machine_id INTEGER REFERENCES machines(id),
  shift_id INTEGER REFERENCES shifts(id),
  result_date TEXT NOT NULL,
  good_pieces INTEGER NOT NULL DEFAULT 0,
  defect_before INTEGER NOT NULL DEFAULT 0,
  defect_after INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS receive_permits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  machine_id INTEGER REFERENCES machines(id),
  shift_id INTEGER REFERENCES shifts(id),
  source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own','customer')),
  party_id INTEGER REFERENCES parties(id),
  receiver_name TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS receive_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receive_permit_id INTEGER NOT NULL REFERENCES receive_permits(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER REFERENCES parties(id),
  invoice_type TEXT NOT NULL DEFAULT 'sale' CHECK (invoice_type IN ('sale','scrap','blowing_fee')),
  driver_name TEXT,
  car_number TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  unit_price REAL,
  total_price REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS exit_permits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  driver_name TEXT,
  car_number TEXT,
  destination TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS exit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exit_permit_id INTEGER NOT NULL REFERENCES exit_permits(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customer_raw_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS customer_raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES customer_raw_receipts(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  boxes INTEGER NOT NULL,
  pieces_per_box INTEGER,
  pieces INTEGER NOT NULL,
  weight_kg REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customer_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  invoice_id INTEGER REFERENCES invoices(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS customer_delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES customer_deliveries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS scrap_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('to_recycled','to_stock','to_supplier','sold_scrap')),
  warehouse_id INTEGER REFERENCES warehouses(id),
  party_id INTEGER REFERENCES parties(id),
  pieces INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL NOT NULL DEFAULT 0,
  price REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  doc_number TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty_in_pieces INTEGER NOT NULL DEFAULT 0,
  qty_out_pieces INTEGER NOT NULL DEFAULT 0,
  weight_in_kg REAL NOT NULL DEFAULT 0,
  weight_out_kg REAL NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_moves(item_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_doc ON stock_moves(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

- [ ] **Step 2: `src/db.js`**

```js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

let db = null;

function getDb() {
  if (db) return db;
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'samplastic.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seed(db);
  return db;
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

module.exports = { getDb };
```

- [ ] **Step 3: تشغيل فحص سريع**

```bash
node -e "const {getDb}=require('./src/db'); const d=getDb(); console.log(d.prepare('SELECT COUNT(*) c FROM warehouses').get()); console.log(d.prepare('SELECT COUNT(*) c FROM users').get());"
```
Expected: `{ c: 3 }` ثم `{ c: 1 }`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: sqlite schema and seed (stage 1)"
```

### Task 1.3: تحويلات الوحدات (units.js) مع اختبارات

**Files:**
- Create: `src/units.js`
- Test: `tests/units.test.js`

**Interfaces:**
- Produces:
  - `toPieces(quantity, unit, item, piecesPerBox)` → integer
  - `piecesToWeightKg(pieces, weightGrams)` → number
  - `formatQty(pieces, item)` → نص عربي بالوحدات المشتقة

- [ ] **Step 1: كتابة الاختبار الفاشل `tests/units.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { toPieces, piecesToWeightKg, formatQty } = require('../src/units');

test('toPieces: piece', () => assert.equal(toPieces(10, 'piece', {}), 10));
test('toPieces: carton uses pieces_per_carton', () =>
  assert.equal(toPieces(2, 'carton', { pieces_per_carton: 12800 }), 25600));
test('toPieces: bag uses pieces_per_bag', () =>
  assert.equal(toPieces(3, 'bag', { pieces_per_bag: 250 }), 750));
test('toPieces: kg from weight_grams', () =>
  assert.equal(toPieces(5.02, 'kg', { weight_grams: 5.02 }), 1000));
test('toPieces: ton', () =>
  assert.equal(toPieces(0.023, 'ton', { weight_grams: 23 }), 1000));
test('toPieces: box with piecesPerBox', () =>
  assert.equal(toPieces(4, 'box', {}, 300), 1200));
test('piecesToWeightKg', () =>
  assert.equal(piecesToWeightKg(1000, 5.02), 5.02));
test('formatQty: carton-capable item', () => {
  const s = formatQty(25600, { pieces_per_carton: 12800, weight_grams: 5.02 });
  assert.ok(s.includes('2') && s.includes('كرتون') && s.includes('25,600'));
});
test('formatQty: bag item', () => {
  const s = formatQty(750, { pieces_per_bag: 250 });
  assert.ok(s.includes('3') && s.includes('كيس'));
});
```

- [ ] **Step 2: تشغيل للتأكد من الفشل**

```bash
npm test
```
Expected: FAIL — module غير موجود.

- [ ] **Step 3: `src/units.js`**

```js
const GRAMS_PER_KG = 1000;

function toPieces(quantity, unit, item = {}, piecesPerBox = null) {
  const q = Number(quantity);
  switch (unit) {
    case 'piece': return Math.round(q);
    case 'carton': return Math.round(q * (item.pieces_per_carton || 0));
    case 'bag': return Math.round(q * (item.pieces_per_bag || 0));
    case 'kg': return weightToPieces(q, item.weight_grams);
    case 'ton': return weightToPieces(q * 1000, item.weight_grams);
    case 'box': return Math.round(q * (piecesPerBox || 0));
    case 'bale': return Math.round(q);
    default: throw new Error(`وحدة غير معروفة: ${unit}`);
  }
}

function weightToPieces(weightKg, weightGrams) {
  if (!weightGrams) throw new Error('الصنف ليس له وزن جرام — أدخل الكمية بالعدد');
  return Math.round((weightKg * GRAMS_PER_KG) / weightGrams);
}

function piecesToWeightKg(pieces, weightGrams) {
  return (pieces * weightGrams) / GRAMS_PER_KG;
}

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatQty(pieces, item = {}) {
  const parts = [`${fmt(pieces)} ${item.unit_name || 'حبة'}`];
  if (item.pieces_per_carton && pieces >= item.pieces_per_carton) {
    const c = Math.floor(pieces / item.pieces_per_carton);
    const r = pieces % item.pieces_per_carton;
    parts.push(r > 0 ? `${fmt(c)} كرتون + ${fmt(r)} حبة` : `${fmt(c)} كرتون`);
  }
  if (item.pieces_per_bag && pieces >= item.pieces_per_bag) {
    const b = Math.floor(pieces / item.pieces_per_bag);
    const r = pieces % item.pieces_per_bag;
    parts.push(r > 0 ? `${fmt(b)} كيس + ${fmt(r)} حبة` : `${fmt(b)} كيس`);
  }
  if (item.weight_grams) {
    const kg = piecesToWeightKg(pieces, item.weight_grams);
    parts.push(kg >= 1000 ? `${fmt(kg / 1000, 3)} طن` : `${fmt(kg, 3)} كجم`);
  }
  return parts.join(' — ');
}

module.exports = { toPieces, piecesToWeightKg, formatQty, fmt };
```

- [ ] **Step 4: تشغيل الاختبارات**

```bash
npm test
```
Expected: PASS 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: units conversion with tests"
```

### Task 1.4: دفتر المخزون (stock.js) مع اختبارات

**Files:**
- Create: `src/stock.js`, `src/audit.js`
- Test: `tests/stock.test.js`

**Interfaces:**
- Produces:
  - `writeMoves(db, docType, docId, docNumber, docDate, rows, userId)` — يكتب حركات مع reversals تلقائياً عند التعديل/الإلغاء. `rows` = مصفوفة من `{item_id, warehouse_id, qty_in_pieces?, qty_out_pieces?, weight_in_kg?, weight_out_kg?, notes?}`.
  - `voidDoc(db, docType, docId, userId)` — يكتب reversals ويعيد null.
  - `getBalance(db, itemId, warehouseId)` → `{in_pieces, out_pieces, balance_pieces, in_kg, out_kg, balance_kg}`
  - `audit(db, userId, action, entity, entityId, before, after)` من audit.js

- [ ] **Step 1: الاختبار الفاشل `tests/stock.test.js`** (قاعدة بيانات في الذاكرة)

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { writeMoves, voidDoc, getBalance } = require('../src/stock');

function memDb() {
  const d = new Database(':memory:');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  d.prepare('INSERT INTO warehouses (name) VALUES (?)').run('مخزن 1');
  d.prepare('INSERT INTO items (code,name,item_group,unit_name,weight_grams) VALUES (?,?,?,?,?)')
    .run('T-1', 'تجريبي', 2, 'علبة', 10);
  return d;
}

test('writeMoves then balance', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18', [
    { item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }
  ], 1);
  const b = getBalance(d, 1, 1);
  assert.equal(b.balance_pieces, 1000);
  assert.equal(b.balance_kg, 10);
});

test('edit doc rewrites moves via reversal', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }], 1);
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 400, weight_in_kg: 4 }], 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 400);
});

test('voidDoc reverses everything', () => {
  const d = memDb();
  writeMoves(d, 'receive', 1, 'R-1', '2026-10-18',
    [{ item_id: 1, warehouse_id: 1, qty_in_pieces: 1000, weight_in_kg: 10 }], 1);
  voidDoc(d, 'receive', 1, 1);
  assert.equal(getBalance(d, 1, 1).balance_pieces, 0);
});
```

- [ ] **Step 2: تشغيل للتأكد من الفشل** — `npm test` → FAIL.

- [ ] **Step 3: `src/stock.js` + `src/audit.js`**

```js
function writeMoves(db, docType, docId, docNumber, docDate, rows, userId) {
  const tx = db.transaction(() => {
    const old = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
    if (old.length > 0) {
      const rev = db.prepare(`INSERT INTO stock_moves
        (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
         qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const o of old) rev.run(docType, docId, docNumber, docDate, o.item_id, o.warehouse_id,
        o.qty_out_pieces, o.qty_in_pieces, o.weight_out_kg, o.weight_in_kg, 'عكس حركة سابقة (تعديل)');
    }
    const ins = db.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
      VALUES (@doc_type,@doc_id,@doc_number,@doc_date,@item_id,@warehouse_id,
       @qty_in_pieces,@qty_out_pieces,@weight_in_kg,@weight_out_kg,@notes)`);
    for (const r of rows) ins.run({
      doc_type: docType, doc_id: docId, doc_number: docNumber, doc_date: docDate,
      item_id: r.item_id, warehouse_id: r.warehouse_id,
      qty_in_pieces: r.qty_in_pieces || 0, qty_out_pieces: r.qty_out_pieces || 0,
      weight_in_kg: r.weight_in_kg || 0, weight_out_kg: r.weight_out_kg || 0,
      notes: r.notes || null
    });
    audit(db, userId, 'stock_write', docType, docId, old, rows);
  });
  tx();
}

function voidDoc(db, docType, docId, userId) {
  const tx = db.transaction(() => {
    const old = db.prepare('SELECT * FROM stock_moves WHERE doc_type=? AND doc_id=?').all(docType, docId);
    const rev = db.prepare(`INSERT INTO stock_moves
      (doc_type, doc_id, doc_number, doc_date, item_id, warehouse_id,
       qty_in_pieces, qty_out_pieces, weight_in_kg, weight_out_kg, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const o of old) rev.run(docType, docId, o.doc_number, o.doc_date, o.item_id, o.warehouse_id,
      o.qty_out_pieces, o.qty_in_pieces, o.weight_out_kg, o.weight_in_kg, 'عكس حركة (إلغاء مستند)');
    audit(db, userId, 'void', docType, docId, old, null);
  });
  tx();
}

function getBalance(db, itemId, warehouseId) {
  return db.prepare(`SELECT
      COALESCE(SUM(qty_in_pieces),0) in_pieces,
      COALESCE(SUM(qty_out_pieces),0) out_pieces,
      COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) balance_pieces,
      COALESCE(SUM(weight_in_kg),0) in_kg,
      COALESCE(SUM(weight_out_kg),0) out_kg,
      COALESCE(SUM(weight_in_kg),0)-COALESCE(SUM(weight_out_kg),0) balance_kg
    FROM stock_moves WHERE item_id=? AND warehouse_id=?`).get(itemId, warehouseId);
}

module.exports = { writeMoves, voidDoc, getBalance };
```

`src/audit.js`:
```js
function audit(db, userId, action, entity, entityId, before, after) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json)
    VALUES (?,?,?,?,?,?)`).run(userId || null, action, entity, entityId || null,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
module.exports = { audit };
```

- [ ] **Step 4: تشغيل الاختبارات** — `npm test` → PASS 12 tests.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: stock ledger with reversals and audit"`

### Task 1.5: أرقام المستندات (docs.js) + معالج IPC عام

**Files:**
- Create: `src/docs.js`, `src/ipc.js`, `src/handlers/auth.js`, `src/handlers/settings.js`, `src/handlers/warehouses.js`, `src/handlers/machines.js`, `src/handlers/shifts.js`, `src/handlers/users.js`

**Interfaces:**
- Produces:
  - `suggestNumber(db, table)` → `{number, next}` — آخر رقم مستند موجود + 1 (يدوي الطابع).
  - `checkDocNumber(db, table, number, excludeId)` → boolean فريد.
  - `registerIpc(ipcMain)` من ipc.js — كل القنوات بصيغة `domain:action`.

- [ ] **Step 1: `src/docs.js`**

```js
function suggestNumber(db, table) {
  const row = db.prepare(`SELECT doc_number FROM ${table}
    WHERE doc_number GLOB '[0-9]*' ORDER BY CAST(doc_number AS INTEGER) DESC, doc_number DESC LIMIT 1`).get();
  if (!row) return '1';
  const n = parseInt(row.doc_number, 10);
  return Number.isNaN(n) ? '' : String(n + 1);
}
function checkDocNumber(db, table, number, excludeId = null) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE doc_number = ?`).get(number);
  return !row || (excludeId !== null && row.id === excludeId);
}
module.exports = { suggestNumber, checkDocNumber };
```

- [ ] **Step 2: handlers — نمط موحد (مثال warehouses.js كاملاً، والباقي بنفس النمط مع جداول حقولها)**

`src/handlers/warehouses.js`:
```js
const { getDb } = require('../db');
const { audit } = require('../audit');

module.exports = function register(ipcMain) {
  ipcMain.handle('warehouses:list', () => getDb().prepare('SELECT * FROM warehouses ORDER BY id').all());
  ipcMain.handle('warehouses:save', (e, row, userId) => {
    const db = getDb();
    const before = row.id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(row.id) : null;
    if (!row.name || !row.name.trim()) throw new Error('اسم المخزن مطلوب');
    let id = row.id;
    if (id) db.prepare('UPDATE warehouses SET name=?, location=?, notes=? WHERE id=?')
      .run(row.name.trim(), row.location || 'داخل المصنع', row.notes || null, id);
    else id = db.prepare('INSERT INTO warehouses (name, location, notes) VALUES (?,?,?)')
      .run(row.name.trim(), row.location || 'داخل المصنع', row.notes || null).lastInsertRowid;
    audit(db, userId, id ? 'update' : 'create', 'warehouse', id, before, row);
    return { id };
  });
  ipcMain.handle('warehouses:delete', (e, id, userId) => {
    const db = getDb();
    const used = db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE warehouse_id=?').get(id).c;
    if (used > 0) throw new Error('لا يمكن حذف مخزن له حركات — استخدم إخفاءه أو عدّل اسمه');
    const before = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
    db.prepare('DELETE FROM warehouses WHERE id=?').run(id);
    audit(db, userId, 'delete', 'warehouse', id, before, null);
    return { ok: true };
  });
};
```

جداول حقول باقي handlers (نفس النمط بالضبط — list/save/delete):

| handler | جدول | الحقول (بجانب id) | فحص فريد |
|---|---|---|---|
| machines | machines | name, notes | name |
| shifts | shifts | name, notes | name |
| users | users | username, full_name, password_hash (bcryptjs عند الإدخال — فارغ يعني بدون تغيير), role | username — لا حذف ذاتي، admin لا يُحذف |
| settings | settings | key/value — save كلياً: factory_name, factory_phone, factory_address, doc_page_size, report_page_size, currency | — |

`src/handlers/auth.js`:
```js
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
```

- [ ] **Step 3: `src/ipc.js`**

```js
const fs = require('fs');
const path = require('path');
module.exports = function registerAll(ipcMain) {
  const dir = path.join(__dirname, 'handlers');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) require(path.join(dir, f))(ipcMain);
  }
};
```

وفى `main.js` أضف بعد `app.whenReady`:
```js
const { getDb } = require('./src/db');
const registerAll = require('./src/ipc');
app.whenReady().then(() => { getDb(); registerAll(ipcMain); createMainWindow(); ... });
```

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: ipc handlers for stage1 data domains"`

### Task 1.6: واجهة تسجيل الدخول والهيكل الرئيسي

**Files:**
- Create: `renderer/index.html`, `renderer/app.html`, `renderer/css/app.css`, `renderer/js/api.js`, `renderer/js/fmt.js`, `renderer/js/ui.js`, `renderer/js/router.js`

**Interfaces:**
- Produces: `window.api.invoke(channel, ...args)` (من preload). `Router.register(name, {title, mount})`. `ui.toast(msg, type)`, `ui.confirm(msg)` → Promise<bool>, `ui.renderTable(el, columns, rows)`, `ui.formFields(...)`.

- [ ] **Step 1: `renderer/index.html`** — صفحة دخول عربية كاملة:

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"><title>سام بلاستيك — تسجيل الدخول</title>
<link rel="stylesheet" href="css/app.css">
</head>
<body class="login-body">
  <div class="login-card">
    <h1>سام بلاستيك</h1>
    <p class="subtitle">نظام إدارة مصنع نفخ العبوات البلاستيكية</p>
    <form id="login-form">
      <label>اسم المستخدم <input id="username" autocomplete="username" required></label>
      <label>كلمة المرور <input id="password" type="password" autocomplete="current-password" required></label>
      <p id="login-error" class="error hidden">اسم المستخدم أو كلمة المرور غير صحيحة</p>
      <button type="submit" class="btn primary">دخول</button>
    </form>
  </div>
<script type="module" src="js/login.js"></script>
</body>
</html>
```

`renderer/js/login.js`:
```js
const form = document.getElementById('login-form');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const u = await window.api.invoke('auth:login',
    document.getElementById('username').value, document.getElementById('password').value);
  if (!u) { document.getElementById('login-error').classList.remove('hidden'); return; }
  sessionStorage.setItem('user', JSON.stringify(u));
  location.href = 'app.html';
});
```

- [ ] **Step 2: `renderer/app.html`** — هيكل بشريط جانبي:

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"><title>سام بلاستيك</title>
<link rel="stylesheet" href="css/app.css">
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">سام بلاستيك</div>
    <nav id="nav">
      <a data-screen="dashboard" class="nav-item">الرئيسية</a>
      <div class="nav-group">البيانات الأساسية</div>
      <a data-screen="items" class="nav-item">الأصناف</a>
      <a data-screen="parties" class="nav-item">الموردون والعملاء</a>
      <a data-screen="warehouses" class="nav-item">المخازن</a>
      <a data-screen="machines" class="nav-item">المكائن</a>
      <a data-screen="shifts" class="nav-item">الورديات</a>
      <div class="nav-group">الحركات</div>
      <a data-screen="purchases" class="nav-item">فواتير الشراء</a>
      <a data-screen="issues" class="nav-item">تصاريح الصرف للإنتاج</a>
      <a data-screen="production" class="nav-item">نتيجة الإنتاج</a>
      <a data-screen="receives" class="nav-item">استلام الإنتاج التام</a>
      <a data-screen="sales" class="nav-item">فواتير البيع</a>
      <a data-screen="exits" class="nav-item">تصاريح الخروج</a>
      <a data-screen="scrap" class="nav-item">التالف ومصيره</a>
      <a data-screen="tolling" class="nav-item">النفخ للغير</a>
      <a data-screen="transfers" class="nav-item">نقل بين المخازن</a>
      <div class="nav-group">التقارير</div>
      <a data-screen="stock" class="nav-item">المخزون</a>
      <a data-screen="reports" class="nav-item">التقارير</a>
      <a data-screen="audit" class="nav-item">سجل التدقيق</a>
      <div class="nav-group">النظام</div>
      <a data-screen="users" class="nav-item">المستخدمون</a>
      <a data-screen="settings" class="nav-item">الإعدادات</a>
    </nav>
    <div class="sidebar-footer"><span id="current-user"></span><button id="logout" class="btn small">خروج</button></div>
  </aside>
  <main id="screen" class="screen"></main>
</div>
<script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: `renderer/css/app.css`** — متغيرات عربية:

```css
:root {
  --bg: #f4f6f9; --card: #ffffff; --primary: #0d6e6e; --primary-dark: #0a5656;
  --text: #1f2937; --muted: #6b7280; --border: #e5e7eb; --danger: #b91c1c; --ok: #15803d;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; background: var(--bg); color: var(--text); }
.login-body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login-card { background: var(--card); padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.08); width: 380px; text-align: center; }
.login-card h1 { color: var(--primary); font-size: 28px; margin-bottom: 6px; }
.login-card label { display: block; text-align: right; margin: 14px 0 4px; font-weight: 600; font-size: 14px; }
.login-card input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 15px; }
.layout { display: flex; height: 100vh; }
.sidebar { width: 240px; background: #123; color: #e2e8f0; display: flex; flex-direction: column; overflow-y: auto; }
.brand { font-size: 20px; font-weight: 700; padding: 18px 16px; color: #fff; border-bottom: 1px solid rgba(255,255,255,.12); }
.nav-group { padding: 14px 16px 4px; font-size: 11px; color: #7d8ea8; }
.nav-item { display: block; padding: 9px 16px; cursor: pointer; font-size: 14px; }
.nav-item:hover { background: rgba(255,255,255,.08); }
.nav-item.active { background: var(--primary); color: #fff; }
.sidebar-footer { margin-top: auto; padding: 12px 16px; font-size: 13px; border-top: 1px solid rgba(255,255,255,.12); display: flex; justify-content: space-between; align-items: center; }
.screen { flex: 1; overflow: auto; padding: 22px; }
.card { background: var(--card); border-radius: 10px; border: 1px solid var(--border); padding: 18px; margin-bottom: 16px; }
.card h2 { font-size: 18px; margin-bottom: 12px; color: var(--primary-dark); }
table.data { width: 100%; border-collapse: collapse; font-size: 14px; }
table.data th { background: #f1f5f9; padding: 9px 10px; text-align: right; border-bottom: 2px solid var(--border); }
table.data td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
.btn { border: 1px solid var(--border); background: #fff; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-family: inherit; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.small { padding: 4px 10px; font-size: 12px; }
label.field { display: block; margin-bottom: 12px; font-size: 14px; }
label.field span { display: block; font-weight: 600; margin-bottom: 4px; }
input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; }
textarea { min-height: 56px; resize: vertical; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.hidden { display: none !important; }
.error { color: var(--danger); font-size: 13px; }
.toast { position: fixed; bottom: 20px; left: 20px; background: #1f2937; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 14px; z-index: 99; }
.toast.ok { background: var(--ok); }
.toast.err { background: var(--danger); }
.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 12px; padding: 22px; min-width: 460px; max-width: 90vw; max-height: 88vh; overflow: auto; }
.modal h3 { margin-bottom: 14px; color: var(--primary-dark); }
.actions { display: flex; gap: 8px; justify-content: flex-start; margin-top: 14px; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.stat .num { font-size: 24px; font-weight: 700; color: var(--primary); }
.stat .lbl { color: var(--muted); font-size: 13px; }
```

- [ ] **Step 4: `renderer/js/api.js` + `fmt.js` + `ui.js` + `router.js` + `app.js`**

`api.js`:
```js
export const api = window.api;
export function currentUser() { return JSON.parse(sessionStorage.getItem('user') || 'null'); }
```

`fmt.js`:
```js
export function fmtNum(n, d = 2) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d }); }
export function fmtMoney(n) { return fmtNum(n, 2) + ' ريال'; }
export function today() { return new Date().toISOString().slice(0, 10); }
```

`ui.js`:
```js
export function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
export function confirmDialog(msg) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="min-width:340px"><h3>تأكيد</h3>
      <p style="line-height:1.8">${msg}</p>
      <div class="actions"><button class="btn danger" id="c-yes">نعم</button>
      <button class="btn" id="c-no">إلغاء</button></div></div>`;
    back.querySelector('#c-yes').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#c-no').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}
export function implicationsDialog(title, lines) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"><h3>${title}</h3>
      <ul style="padding-right:20px;line-height:2">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
      <div class="actions"><button class="btn primary" id="i-ok">فهمت، متابعة</button>
      <button class="btn" id="i-cancel">إلغاء العملية</button></div></div>`;
    back.querySelector('#i-ok').onclick = () => { back.remove(); resolve(true); };
    back.querySelector('#i-cancel').onclick = () => { back.remove(); resolve(false); };
    document.body.appendChild(back);
  });
}
export function renderTable(el, columns, rows) {
  el.innerHTML = `<table class="data"><thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r) : (r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function openModal(title, bodyHtml, buttons) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><h3>${title}</h3>${bodyHtml}<div class="actions"></div></div>`;
  const act = back.querySelector('.actions');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.class || ''}`; btn.textContent = b.label;
    btn.onclick = () => b.onClick(back);
    act.appendChild(btn);
  }
  document.body.appendChild(back);
  return back;
}
```

`router.js`:
```js
const screens = {};
export function register(name, def) { screens[name] = def; }
export async function go(name) {
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.screen === name));
  const el = document.getElementById('screen');
  el.innerHTML = '';
  const def = screens[name];
  if (def) await def.mount(el);
}
```

`app.js`:
```js
import { currentUser } from './js/api.js';
import { go } from './js/router.js';
const u = currentUser();
if (!u) location.href = 'index.html';
document.getElementById('current-user').textContent = `${u.full_name} (${u.role === 'manager' ? 'مدير' : u.role})`;
document.getElementById('logout').onclick = () => { sessionStorage.clear(); location.href = 'index.html'; };
document.querySelectorAll('.nav-item').forEach(a => a.onclick = () => go(a.dataset.screen));
go('dashboard');
```

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: login and app shell with RTL theme"`

### Task 1.7: شاشات المرحلة 1 (مخازن/مكائن/ورديات/مستخدمون/إعدادات/رئيسية)

**Files:**
- Create: `renderer/js/screens/dashboard.js`, `warehouses.js`, `machines.js`, `shifts.js`, `users.js`, `settings.js`

**Interfaces:**
- Consumes: `register(name, {title, mount})`, `api.invoke`, `ui.*`, `fmt.*`.

- [ ] **Step 1: نمط شاشة CRUD كامل (warehouses.js) — وباقي شاشات القوائم بنفس النمط حرفياً مع اختلاف الحقول والقناة:**

```js
import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { ui } from '../ui.js';
import { toast, confirmDialog, renderTable, openModal } from '../ui.js';

register('warehouses', {
  title: 'المخازن',
  async mount(el) {
    el.innerHTML = `<div class="card"><h2>المخازن</h2>
      <div id="tbl"></div>
      <div class="actions"><button id="add" class="btn primary">إضافة مخزن</button></div></div>`;
    async function load() {
      const rows = await api.invoke('warehouses:list');
      renderTable(document.getElementById('tbl'),
        [{ label: 'الاسم', key: 'name' }, { label: 'الموقع', key: 'location' }, { label: 'ملاحظات', key: 'notes' },
         { label: '', render: r => `<button class="btn small" data-edit="${r.id}">تعديل</button> <button class="btn small danger" data-del="${r.id}">حذف</button>` }],
        rows);
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(rows.find(r => r.id == b.dataset.edit)));
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => del(b.dataset.del));
    }
    function edit(row) {
      const back = openModal(row ? 'تعديل مخزن' : 'إضافة مخزن',
        `<label class="field"><span>الاسم *</span><input id="f-name" value="${row ? row.name : ''}"></label>
         <label class="field"><span>الموقع</span><select id="f-loc">
           <option value="داخل المصنع" ${row && row.location === 'داخل المصنع' ? 'selected' : ''}>داخل المصنع</option>
           <option value="خارج المصنع" ${row && row.location === 'خارج المصنع' ? 'selected' : ''}>خارج المصنع</option>
         </select></label>
         <label class="field"><span>ملاحظات</span><textarea id="f-notes">${row ? row.notes || '' : ''}</textarea></label>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (back) => {
          try {
            await api.invoke('warehouses:save',
              { id: row ? row.id : null, name: back.querySelector('#f-name').value,
                location: back.querySelector('#f-loc').value, notes: back.querySelector('#f-notes').value },
              currentUser().id);
            back.remove(); toast('تم الحفظ', 'ok'); load();
          } catch (e) { toast(e.message, 'err'); }
        } }, { label: 'إلغاء', onClick: (back) => back.remove() }]);
    }
    async function del(id) {
      if (!(await confirmDialog('حذف هذا المخزن نهائياً؟'))) return;
      try { await api.invoke('warehouses:delete', id, currentUser().id); toast('تم الحذف', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    el.querySelector('#add').onclick = () => edit(null);
    await load();
  }
});
```

- [ ] **Step 2: `machines.js` و `shifts.js`** — نفس النمط، حقلان فقط (name, notes)، القنوات `machines:*` و `shifts:*`.

- [ ] **Step 3: `users.js`** — أعمدة: username, full_name, role (عرض عربي: مدير/إدخال/عرض). النموذج: username*, full_name*, password (فارغ = بدون تغيير), role select. زر حذف معطّل لـ admin. القنوات `users:*`.

- [ ] **Step 4: `settings.js`** — نموذج واحد بحقول: اسم المصنع، الهاتف، العنوان، مقاس طباعة المستندات (A4/A5)، مقاس التقارير (A4/A5)، العملة (نص، افتراضي "ريال يمني"). زر حفظ واحد → `settings:save`.

`src/handlers/settings.js`:
```js
module.exports = function register(ipcMain) {
  ipcMain.handle('settings:get', () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  });
  ipcMain.handle('settings:save', (e, values, userId) => {
    const db = getDb();
    const before = db.prepare('SELECT key, value FROM settings').all();
    const tx = db.transaction(() => {
      const del = db.prepare('DELETE FROM settings');
      const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
      del.run();
      for (const [k, v] of Object.entries(values)) ins.run(k, String(v ?? ''));
    });
    tx();
    audit(db, userId, 'update', 'settings', null, before, values);
    return { ok: true };
  });
};
```

- [ ] **Step 5: `dashboard.js`** — بطاقات إحصائية (تعرض أصفاراً في هذه المرحلة، تُربط فعلياً في Stage 7):

```js
import { register } from '../router.js';
import { api } from '../api.js';

register('dashboard', {
  title: 'الرئيسية',
  async mount(el) {
    el.innerHTML = `<div class="stats">
      <div class="stat"><div class="num" id="s-raw">0</div><div class="lbl">أصناف الخام</div></div>
      <div class="stat"><div class="num" id="s-fg">0</div><div class="lbl">أصناف الإنتاج التام</div></div>
      <div class="stat"><div class="num" id="s-today">0</div><div class="lbl">مستندات اليوم</div></div>
      <div class="stat"><div class="num" id="s-balance">0</div><div class="lbl">رصيد التام (حبة)</div></div>
    </div>`;
    try {
      const d = await api.invoke('dashboard:summary');
      el.querySelector('#s-raw').textContent = d.raw_items;
      el.querySelector('#s-fg').textContent = d.fg_items;
      el.querySelector('#s-today').textContent = d.today_docs;
      el.querySelector('#s-balance').textContent = d.fg_balance;
    } catch { /* شاشات المراحل اللاحقة ستغذيها */ }
  }
});
```

`src/handlers/dashboard.js`:
```js
module.exports = function register(ipcMain) {
  ipcMain.handle('dashboard:summary', () => {
    const db = getDb();
    const raw = db.prepare("SELECT COUNT(*) c FROM items WHERE item_group=1").get().c;
    const fg = db.prepare("SELECT COUNT(*) c FROM items WHERE item_group=2").get().c;
    const today = db.prepare("SELECT (SELECT COUNT(*) FROM purchases WHERE doc_date=date('now','localtime')) + (SELECT COUNT(*) FROM issue_permits WHERE doc_date=date('now','localtime')) + (SELECT COUNT(*) FROM receive_permits WHERE doc_date=date('now','localtime')) + (SELECT COUNT(*) FROM invoices WHERE doc_date=date('now','localtime')) c").get().c;
    const fgb = db.prepare(`SELECT COALESCE(SUM(qty_in_pieces)-SUM(qty_out_pieces),0) c FROM stock_moves sm
      JOIN items i ON i.id=sm.item_id WHERE i.item_group=2`).get().c;
    return { raw_items: raw, fg_items: fg, today_docs: today, fg_balance: fgb };
  });
};
```

- [ ] **Step 6: تشغيل البرنامج وفحص شامل**

```bash
npm start
```
تحقق: دخول بـ admin/admin123، كل شاشات المرحلة تعمل، إضافة/تعديل/حذف مخزن، حفظ الإعدادات، الخروج والدخول.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: stage1 screens (warehouses, machines, shifts, users, settings, dashboard)"`

**⏸ CHECKPOINT — المستخدم يشغّل «تشغيل البرنامج.bat» ويفحص المرحلة 1.**

---

## Stage 2: الأصناف (المجموعات الخمس) + الموردون والعملاء + استيراد ملف الأصناف

**Deliverable:** إدارة كاملة للأصناف بحقول كل مجموعة مع التحويلات، دفتر موردين وعملاء، استيراد ملف الأصناف (CSV من PDF المستخدم) بزر واحد.

### Task 2.1: معالج الأصناف (items handler)

**Files:**
- Create: `src/handlers/items.js`

**Interfaces:**
- Produces: `items:list` (فلتر group)، `items:save` (فحص فريدية الكود + فحص أن كود المجموعة يطابق بادئتها)، `items:delete` (يمنع إذا له حركات)، `items:import` (مصفوفة صفوف → إدراج متعدد).

- [ ] **Step 1: `src/handlers/items.js`**

```js
const { getDb } = require('../db');
const { audit } = require('../audit');

const GROUP_PREFIX = { 1: '001', 2: '002', 3: '003', 4: '004', 5: '005' };

module.exports = function register(ipcMain) {
  ipcMain.handle('items:list', (e, group) => {
    const q = group ? 'WHERE item_group = ?' : '';
    return getDb().prepare(`SELECT * FROM items ${q} ORDER BY code`).all(...(group ? [group] : []));
  });
  ipcMain.handle('items:save', (e, row, userId) => {
    const db = getDb();
    const code = String(row.code || '').trim();
    if (!code) throw new Error('كود الصنف مطلوب');
    if (!row.name || !row.name.trim()) throw new Error('اسم الصنف مطلوب');
    const prefix = GROUP_PREFIX[row.item_group];
    if (!code.startsWith(prefix)) throw new Error(`كود المجموعة ${row.item_group} يجب أن يبدأ بـ ${prefix}`);
    const dup = db.prepare('SELECT id FROM items WHERE code=? AND id IS NOT ?').get(code, row.id || -1);
    if (dup) throw new Error('كود الصنف مكرر — اختر كوداً آخر');
    const before = row.id ? db.prepare('SELECT * FROM items WHERE id=?').get(row.id) : null;
    let id = row.id;
    const fields = { code, name: row.name.trim(), item_group: row.item_group, unit_name: row.unit_name || 'حبة',
      weight_grams: row.weight_grams || null, pieces_per_carton: row.pieces_per_carton || null,
      pieces_per_bag: row.pieces_per_bag || null, service_price: row.service_price || null,
      is_recycled: row.is_recycled ? 1 : 0, brand: row.brand || null, size_label: row.size_label || null,
      bale_size: row.bale_size || null, bale_condition: row.bale_condition || null,
      bale_mixed: row.bale_mixed ? 1 : 0, notes: row.notes || null };
    if (id) {
      db.prepare(`UPDATE items SET code=@code,name=@name,item_group=@item_group,unit_name=@unit_name,
        weight_grams=@weight_grams,pieces_per_carton=@pieces_per_carton,pieces_per_bag=@pieces_per_bag,
        service_price=@service_price,is_recycled=@is_recycled,brand=@brand,size_label=@size_label,
        bale_size=@bale_size,bale_condition=@bale_condition,bale_mixed=@bale_mixed,notes=@notes WHERE id=@id`)
        .run({ ...fields, id });
    } else {
      id = db.prepare(`INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_carton,
        pieces_per_bag,service_price,is_recycled,brand,size_label,bale_size,bale_condition,bale_mixed,notes)
        VALUES (@code,@name,@item_group,@unit_name,@weight_grams,@pieces_per_carton,@pieces_per_bag,
        @service_price,@is_recycled,@brand,@size_label,@bale_size,@bale_condition,@bale_mixed,@notes)`)
        .run(fields).lastInsertRowid;
    }
    audit(db, userId, id ? 'update' : 'create', 'item', id, before, fields);
    return { id };
  });
  ipcMain.handle('items:delete', (e, id, userId) => {
    const db = getDb();
    const used = db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE item_id=?').get(id).c;
    if (used > 0) throw new Error('لا يمكن حذف صنف له حركات مخزون');
    const before = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    db.prepare('DELETE FROM items WHERE id=?').run(id);
    audit(db, userId, 'delete', 'item', id, before, null);
    return { ok: true };
  });
  ipcMain.handle('items:import', (e, rows, userId) => {
    const db = getDb();
    let count = 0;
    const tx = db.transaction(() => {
      const ins = db.prepare(`INSERT OR IGNORE INTO items (code,name,item_group,unit_name,weight_grams,
        pieces_per_carton,pieces_per_bag,service_price,is_recycled,brand,size_label,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const res = ins.run(r.code, r.name, r.item_group, r.unit_name || 'حبة', r.weight_grams || null,
          r.pieces_per_carton || null, r.pieces_per_bag || null, r.service_price || null,
          r.is_recycled ? 1 : 0, r.brand || null, r.size_label || null, r.notes || null);
        count += res.changes;
      }
    });
    tx();
    audit(db, userId, 'import', 'items', null, null, { imported: count });
    return { imported: count };
  });
};
```

- [ ] **Step 2: Commit** — `git add -A && git commit -m "feat: items handler with group validation and import"`

### Task 2.2: شاشة الأصناف

**Files:**
- Create: `renderer/js/screens/items.js`

- [ ] **Step 1: الشاشة** — فلتر مجموعات (الكل/1..5)، جدول أعمدة: كود، اسم، مجموعة (عربي)، وحدة، وزن جرام، كرتون، كيس، نوع (جديد/محرز)، ملاحظات، أزرار تعديل/حذف. زر "إضافة صنف" + زر "استيراد من ملف".

النموذج — حقول تتبدل حسب المجموعة (إخفاء غير المناسب):
- مشترك: كود*، اسم*، المجموعة (select 1-5)، الوحدة (select: حبة/علبة/امبولة/كيس/كرتون/بالة)، ملاحظات
- مجموعات 1/2/3: وزن الحبة/العلبة (جرام)
- مجموعة 1 (غير محرز أغطية): عدد حبات الكرتون. مجموعة 2: عدد حبات الكيس. مجموعة 3: بدون (يُدخل عند الاستلام)
- محرز: checkbox "محرز"
- مجموعة 4: سعر أجرة النفخ (ريال)
- مجموعة 5: بدون حقول إضافية
- حقول اختيارية (بالات): حجم البالة، حالة البالة، مخلطة checkbox

`src/units.js` — تعرض الشاشة معاينة التحويل فور إدخال الوزن: "وزن 1000 حبة = X كجم".

- [ ] **Step 2: الاستيراد** — نافذة تلصق فيها بيانات CSV (كود،اسم،مجموعة،وحدة،وزن،كرتون،كيس،سعر،محرز،علامة،مقاس،ملاحظات) وتحليل سطورها ثم `items:import` — مع عرض "تم استيراد N صنف (تجاهل المكرر: M)".

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: items screen with group-specific form and CSV import"`

### Task 2.3: الموردون والعملاء

**Files:**
- Create: `src/handlers/parties.js`, `renderer/js/screens/parties.js`

- [ ] **Step 1: handler** — list/save/delete بنمط warehouses مع فحص: الاسم مطلوب، النوع (supplier/customer/both). الحذف ممنوع إذا كان مرتبطاً بفواتير (purchases/invoices/customer_raw_receipts).

- [ ] **Step 2: الشاشة** — فلتر نوع، جدول: اسم، نوع (مورد/عميل/كلاهما)، هاتف، عنوان، ملاحظات، تعديل/حذف. نموذج: اسم*، نوع، هاتف، عنوان، ملاحظات.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: parties screen"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 2 ويدخل ملف أصنافه.**

---

## Stage 3: الشراء والصرف للإنتاج

**Deliverable:** فاتورة شراء تُنشئ كراتين مرقمة، تصريح صرف يصرف كراتين بأرقامها أو وزناً، والمخزون يتحرك صحيحاً.

### Task 3.1: فواتير الشراء

**Files:**
- Create: `src/handlers/purchases.js`, `renderer/js/screens/purchases.js`

**Interfaces:**
- Consumes: `suggestNumber`, `checkDocNumber`, `toPieces`, `piecesToWeightKg`, `writeMoves`, `voidDoc`.
- Produces: `purchases:list`, `purchases:get(id)` (مع البنود والكراتين)، `purchases:save(doc, userId)`، `purchases:void(id, userId)`.

- [ ] **Step 1: منطق الحفظ في `src/handlers/purchases.js`**

```js
ipcMain.handle('purchases:save', (e, doc, userId) => {
  const db = getDb();
  const number = String(doc.doc_number || '').trim();
  if (!number) throw new Error('رقم الفاتورة مطلوب (ترقيم يدوي)');
  if (!doc.doc_date) throw new Error('التاريخ مطلوب');
  if (!doc.items || doc.items.length === 0) throw new Error('أضف بنداً واحداً على الأقل');
  if (!checkDocNumber(db, 'purchases', number, doc.id)) throw new Error('رقم الفاتورة مكرر');
  const tx = db.transaction(() => {
    let id = doc.id;
    if (id) {
      db.prepare('UPDATE purchases SET doc_number=?, doc_date=?, party_id=?, notes=? WHERE id=?')
        .run(number, doc.doc_date, doc.party_id || null, doc.notes || null, id);
      db.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(id);
    } else {
      id = db.prepare('INSERT INTO purchases (doc_number, doc_date, party_id, notes, created_by) VALUES (?,?,?,?,?)')
        .run(number, doc.doc_date, doc.party_id || null, doc.notes || null, userId).lastInsertRowid;
    }
    const moves = [];
    for (const it of doc.items) {
      const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
      if (!item) throw new Error('صنف غير موجود');
      const pieces = toPieces(it.quantity, it.unit, item);
      const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
      db.prepare(`INSERT INTO purchase_items (purchase_id, item_id, warehouse_id, quantity, unit, pieces, weight_kg, unit_price, total_price, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, item.id, it.warehouse_id, it.quantity, it.unit, pieces, kg,
        it.unit_price || null, (it.unit_price || 0) * it.quantity, it.notes || null);
      moves.push({ item_id: item.id, warehouse_id: it.warehouse_id, qty_in_pieces: pieces, weight_in_kg: kg, notes: it.notes });
    }
    writeMoves(db, 'purchase', id, number, doc.doc_date, moves, userId);
    // كراتين مرقمة لكل بند بالكرتون
    for (const it of doc.items) {
      if (it.unit !== 'carton') continue;
      const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
      const perCarton = item.pieces_per_carton;
      if (!perCarton) continue;
      const cartonCount = Math.round(it.quantity);
      const seq = db.prepare(`SELECT COUNT(*) c FROM cartons WHERE carton_number GLOB ?`)
        .get((String(it.carton_prefix || '') || '') + '*').c;
      const ins = db.prepare(`INSERT INTO cartons (carton_number, item_id, purchase_id, pieces, notes) VALUES (?,?,?,?,?)`);
      for (let i = 1; i <= cartonCount; i++) {
        const num = `${it.carton_prefix || ''}${seq + i}`;
        ins.run(num, item.id, id, perCarton, null);
      }
    }
  });
  tx();
  return { id };
});
```

قاعدة ترقيم الكراتين: الشاشة تطلب "بادئة رقم الكرتون" لكل بند كرتون (مثل `K-` أو `001-`)، والأرقام تُكمل تلقائياً بعد آخر كرتون بنفس البادئة — **ويبقى الرقم قابلاً للتعديل اليدوي** من شاشة الكراتين.

- [ ] **Step 2: شاشة `purchases.js`** — قائمة فواتير (رقم، تاريخ، مورد، إجمالي، حالة، أزرار: عرض/تعديل/إلغاء/طباعة). النموذج: رقم (اقتراح تلقائي)، تاريخ (افتراضي اليوم)، المورد (select من parties type supplier/both)، جدول بنود: صنف (select)، مخزن، كمية + وحدة (select حسب الصنف: حبة/كرتون/كجم/طن/بالة)، عرض محسوب فوري (حبات/وزن)، سعر الوحدة، إجمالي، ملاحظات، بادئة كرتون عند الوحدة=كرتون. زر إضافة بند. حفظ.

**تداعيات التعديل:** عند تعديل/إلغاء فاتورة لها كراتين صُرفت → نافذة تداعيات تعرض أرقام الكراتين المتأثرة، والإلغاء يمنع إذا وُجد كرتون من الفاتورة بحالة issued/finished (يُطلب إلغاء التصريح أولاً).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: purchase invoices with numbered cartons"`

### Task 3.2: تصاريح الصرف للإنتاج

**Files:**
- Create: `src/handlers/issues.js`, `renderer/js/screens/issues.js`

**Interfaces:**
- Produces: `issues:list`, `issues:get(id)`, `issues:cartonsAvailable(itemId, warehouseId)` → كراتين in_stock ببندها، `issues:save(doc, userId)`، `issues:void(id, userId)`.

- [ ] **Step 1: منطق الحفظ** — المصدر `own`: اختيار كراتين محددة (تُمرر أرقامها في `carton_ids` كـ JSON) أو وزن/عدد من الرصيد. عند الحفظ: تحديث الكراتين المختارة → status='issued', issue_date=doc_date, issue_permit_id=id. المصدر `customer`: نفس الشكل لكن بدون كراتين (يخصم من رصيد العميل عند التسليم فقط — **الصرف للعميل لا يحرك مخزون المصنع**، يُسجل على التصريح فقط للرجوع).

```js
ipcMain.handle('issues:save', (e, doc, userId) => {
  const db = getDb();
  // فحوص الرقم والتاريخ والبنود مثل الشراء
  const tx = db.transaction(() => {
    // حفظ الرأس والبنود (مثل الشراء بنمط UPDATE+DELETE+INSERT)
    if (doc.source === 'own') {
      for (const it of doc.items) {
        const item = db.prepare('SELECT * FROM items WHERE id=?').get(it.item_id);
        const pieces = toPieces(it.quantity, it.unit, item);
        const kg = piecesToWeightKg(pieces, item.weight_grams || 0);
        const bal = getBalance(db, it.item_id, it.warehouse_id);
        if (bal.balance_pieces < pieces) throw new Error(`الرصيد غير كافٍ للصنف ${item.code} (المطلوب ${pieces} والمتوفر ${bal.balance_pieces})`);
        moves.push({ item_id: it.item_id, warehouse_id: it.warehouse_id, qty_out_pieces: pieces, weight_out_kg: kg });
        if (it.carton_ids && it.carton_ids.length) {
          const upd = db.prepare(`UPDATE cartons SET status='issued', issue_date=?, issue_permit_id=? WHERE carton_number=? AND status='in_stock'`);
          for (const cn of it.carton_ids) {
            const r = upd.run(doc.doc_date, id, cn);
            if (r.changes === 0) throw new Error(`الكرتون ${cn} غير متاح في المخزن`);
          }
        }
      }
    }
    writeMoves(db, 'issue', id, number, doc.doc_date, moves, userId);
  });
  tx();
  return { id };
});
```

**إلغاء تصريح:** يعيد الكراتين إلى in_stock (voidDoc يكتب reversals). يمنع الإلغاء إذا وُجد production_results مرتبط بالكرتون (يُطلب حذف النتيجة أولاً).

- [ ] **Step 2: شاشة `issues.js`** — قائمة تصاريح + نموذج: رقم، تاريخ، مكينة (select)، وردية (select)، اسم المستلم، مصدر (خام المصنع/خام عميل + select العميل عند عميل)، جدول بنود: صنف (خام فقط مجموعة 1)، مخزن، وحدة + كمية، عند "بالكرتون" تظهر قائمة كراتين متاحة (checkbox بأرقامها مع رصيدها) أو إدخال وزن. عرض الرصيد المتوفر قبل الحفظ. ملاحظات. حفظ.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: issue permits with carton selection"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 3 ويرسل صورة نموذج تصريح الصرف لتطابق التصميم.**

---

## Stage 4: نتيجة الإنتاج + استلام التام

**Deliverable:** تسجيل نتيجة كل كرتون (سليم/تالف قبل/تالف بعد)، استلام التام بحركة دخول مخزن، كشف علاقة الكرتون بالنتيجة.

### Task 4.1: نتيجة الإنتاج

**Files:**
- Create: `src/handlers/production.js`, `renderer/js/screens/production.js`

- [ ] **Step 1: handler** — `production:pendingCartons()` → كراتين issued بلا نتيجة. `production:save(result, userId)`: فحص أن سليم+تالف قبل+تالف بعد == pieces الكرتون (تحذير وليس منع إذا أقل — الباقي يُحسب "غير محسوب"). يُحدّث carton.status='finished' ويكتب production_results (one row per carton). تداعيات التعديل: إعادة كتابة النتيجة تستبدل القديمة (DELETE+INSERT بنفس carton_id UNIQUE).

- [ ] **Step 2: شاشة `production.js`** — قائمة الكراتين المصروفة بدون نتيجة (رقم كرتون، صنف، تصريح، تاريخ صرف، عدد الحبات، مكينة/وردية من التصريح). نموذج النتيجة: حقول سليم/تالف قبل/تالف بعد (افتراضيات 0) + عرض تلقائي "المجموع مقابل عدد الحبات" + ملاحظات. حفظ.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: production results per carton"`

### Task 4.2: استلام الإنتاج التام

**Files:**
- Create: `src/handlers/receives.js`, `renderer/js/screens/receives.js`

- [ ] **Step 1: handler** — نمط issue لكن بالعكس: حركة qty_in إلى مخزن التام. بنود: صنف (مجموعة 2)، وحدة (علبة/كيس/كجم)، الكمية تُحول تلقائياً. المصدر own/customer (customer = استلام تام منفوخ لعميل — يُسجل فقط بدون حركة مخزن مصنع، ويرتبط بالتسليم لاحقاً).

- [ ] **Step 2: شاشة `receives.js`** — قائمة + نموذج: رقم، تاريخ، مكينة، وردية، المصدر، بنود بعرض التحويل الفوري (أدخل 10 أكياس → "1000 علبة — 15 كجم"). حفظ. زر طباعة (Stage 7 يفعل القوالب).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: receive permits for finished goods"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 4 ويرسل صورة نموذج تصريح الاستلام.**

---

## Stage 5: النفخ للغير

**Deliverable:** استلام خام عميل (رصيد امبولات)، تسليم منفوخ (ينقص الرصيد تلقائياً)، فاتورة أجرة نفخ، تقرير رصيد العميل.

### Task 5.1: استلام خام العميل

**Files:**
- Create: `src/handlers/tolling.js`, `renderer/js/screens/tolling.js`

- [ ] **Step 1: handler — استلام** `tolling:receiptSave(doc, userId)`: بنود لكل صنف مجموعة 3: عدد العلب (boxes) + عدد الامبولات في العلبة (pieces_per_box) → pieces = boxes × pieces_per_box + وزن اختياري. لا يمس stock_moves (خام العميل ليس ملكية المصنع). يكتب customer_raw_receipts + customer_raw_items.

- [ ] **Step 2: رصيد العميل** — SQL:
```sql
SELECT p.id, p.name,
  COALESCE((SELECT SUM(i.pieces) FROM customer_raw_items i JOIN customer_raw_receipts r ON r.id=i.receipt_id
    WHERE r.party_id=p.id AND r.status='active'),0) raw_in,
  COALESCE((SELECT SUM(di.pieces) FROM customer_delivery_items di JOIN customer_deliveries d ON d.id=di.delivery_id
    WHERE d.party_id=p.id AND d.status='active'),0) delivered_out,
  COALESCE((SELECT SUM(s.pieces) FROM scrap_movements s WHERE s.party_id=p.id AND s.status='active'),0) scrap_out
FROM parties p WHERE p.type IN ('customer','both')
```

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: customer raw receipts and balance"`

### Task 5.2: تسليم المنفوخ + فاتورة الأجرة

- [ ] **Step 1: تسليم** `tolling:deliverySave(doc, userId)`: بنود صنف مجموعة 2 (العلب المسلمة) — فحص: القطع المسلمة ≤ رصيد العميل المتبقي (raw_in − delivered_out − scrap_out). يكتب customer_deliveries + items. اختياري: ربط فاتورة أجرة نفخ (invoice_type='blowing_fee' بأصناف مجموعة 4 بأسعارها) تُنشأ بنفس العملية أو مستقلة.

- [ ] **Step 2: شاشة `tolling.js`** — ثلاث تبويبات: (1) استلام خام عميل، (2) تسليم منفوخ (+ إنشاء فاتورة أجرة)، (3) رصيد العملاء (جدول: عميل، استلم خام، سلّمنا تام، التالف، الباقي لدينا — بالأرقام + الوزن).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: customer deliveries with ampoule balance deduction"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 5.**

---

## Stage 6: البيع والخروج والتالف والنقل

**Deliverable:** فواتير بيع (بيع/خردة/أجرة نفخ)، تصاريح خروج بسائق، تسجيل التالف ومصيره (4 احتمالات)، نقل بين مخازن.

### Task 6.1: فواتير البيع وتصاريح الخروج

**Files:**
- Create: `src/handlers/sales.js`, `renderer/js/screens/sales.js`, `renderer/js/screens/exits.js`

- [ ] **Step 1: فواتير بيع** — رأس: رقم، تاريخ، عميل، نوع (بيع/خردة/أجرة نفخ)، سائق، رقم سيارة، ملاحظات. بنود: صنف (تام/تجاري/خردة)، كمية+وحدة، سعر، إجمالي. فحص رصيد كافٍ. حركة qty_out من مخزن التام/التجاري. إلغاء = reversals.

- [ ] **Step 2: تصاريح خروج** — رأس: رقم، تاريخ، مخزن، سائق، رقم سيارة، جهة التسليم، ملاحظات. بنود بدون أسعار. حركة qty_out.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: sales invoices and exit permits"`

### Task 6.2: التالف ومصيره + النقل

**Files:**
- Create: `src/handlers/scrap.js`, `renderer/js/screens/scrap.js`, `src/handlers/transfers.js`, `renderer/js/screens/transfers.js`

- [ ] **Step 1: التالف** — مستند: رقم، تاريخ، صنف (مجموعة 5 أو خام)، المصير (select): يرجع محرز (qty_in مخزن المحرز بوزن) / يرجع مخزون (qty_in قطع) / استرجاع مورد (لا حركة مخزن — سجل فقط + مورد) / بيع خردة (qty_out من مخزن التالف + سعر). للغير: party_id = العميل (تُخصم من رصيده عبر scrap_out).

- [ ] **Step 2: النقل** — مستند: رقم، تاريخ، من مخزن، إلى مخزن، بنود (qty_out من الأول + qty_in للثاني بنفس writeMoves).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: scrap dispositions and warehouse transfers"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 6 ويرسل صورة نموذج فاتورة الخروج.**

---

## Stage 7: التقارير والطباعة

**Deliverable:** كل التقارير مع فلترة وتصدير، معاينة وطباعة A4/A5 لكل المستندات بترويسة المصنع.

### Task 7.1: نافذة الطباعة والقوالب

**Files:**
- Create: `renderer/print/print.html`, `renderer/print/print.js`, `src/print/templates.js`

- [ ] **Step 1: `src/print/templates.js`** — دالة لكل مستند تعيد HTML عربي RTL:

```js
function docShell(title, body, pageSize) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">
  <style>
    @page { size: ${pageSize}; margin: 10mm; }
    body { font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px; }
    .head { text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
    .head h1 { margin: 0; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #000; padding: 5px 7px; text-align: right; }
    th { background: #eee; }
    .totals td { font-weight: bold; }
    .notes { margin-top: 10px; font-size: 12px; }
    .sig { display: flex; justify-content: space-between; margin-top: 28px; font-size: 12px; }
  </style></head><body>${body}</body></html>`;
}

function purchaseTemplate(doc, settings, rows) {
  return docShell('فاتورة شراء', `
    <div class="head"><h1>${settings.factory_name || 'سام بلاستيك'}</h1>
      <div>فاتورة شراء رقم: ${doc.doc_number} — التاريخ: ${doc.doc_date}</div>
      <div>المورد: ${doc.party_name || ''}</div></div>
    <table><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>الحبات</th><th>الوزن كجم</th><th>السعر</th><th>الإجمالي</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.quantity}</td>
      <td>${r.unit}</td><td>${r.pieces}</td><td>${r.weight_kg}</td><td>${r.unit_price || ''}</td><td>${r.total_price || ''}</td></tr>`).join('')}</tbody></table>
    <div class="notes">ملاحظات: ${doc.notes || ''}</div>
    <div class="sig"><span>المستلم:</span><span>المورد:</span><span>المدير:</span></div>`, settings.doc_page_size || 'A5');
}
// بنفس النمط: issueTemplate, receiveTemplate, invoiceTemplate, exitTemplate, tollReceiptTemplate, tollDeliveryTemplate
module.exports = { purchaseTemplate, issueTemplate, receiveTemplate, invoiceTemplate, exitTemplate, tollReceiptTemplate, tollDeliveryTemplate };
```

- [ ] **Step 2: فتح نافذة الطباعة** — في `main.js`:

```js
ipcMain.handle('print:open', (e, payload) => {
  const win = new BrowserWindow({ width: 800, height: 1000, webPreferences: { contextIsolation: true } });
  win.webContents.on('did-finish-load', () => win.webContents.send('print:content', payload));
  win.loadFile(path.join(__dirname, 'renderer', 'print', 'print.html'));
});
```

`renderer/print/print.js`:
```js
const { ipcRenderer } = require('electron');
const { purchaseTemplate, issueTemplate, receiveTemplate, invoiceTemplate, exitTemplate, tollReceiptTemplate, tollDeliveryTemplate } = require('../../src/print/templates');
ipcRenderer.on('print:content', (e, payload) => {
  const tpls = { purchase: purchaseTemplate, issue: issueTemplate, receive: receiveTemplate, invoice: invoiceTemplate, exit: exitTemplate, toll_receipt: tollReceiptTemplate, toll_delivery: tollDeliveryTemplate };
  const html = tpls[payload.kind](payload.doc, payload.settings, payload.rows);
  const frame = document.getElementById('frame');
  frame.srcdoc = html;
  frame.onload = () => frame.contentWindow.focus();
});
document.getElementById('print-btn').onclick = () => {
  const frame = document.getElementById('frame');
  frame.contentWindow.print();
};
```

`renderer/print/print.html`: شريط علوي بزر "طباعة" + `<iframe id="frame">`.

**تنبيه أمني:** نافذة الطباعة تحمل ملف محلي مع `nodeIntegration: false` لكنها تحتاج require للقوالب — تُمرر بيانات القالب عبر `additionalArguments` أو تُبنى القوالب في main وتُرسل HTML جاهز. **القرار النهائي: تُبنى القوالب في main process (`templates.js` مطلوبة من main) ويُرسل HTML جاهز عبر IPC، فلا nodeIntegration في نافذة الطباعة إطلاقاً.**

- [ ] **Step 3: أزرار طباعة في شاشات المراحل السابقة** — كل شاشة مستند تزر "طباعة" يجلب doc+rows+settings ويفتح النافذة.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: print window with document templates"`

### Task 7.2: التقارير

**Files:**
- Create: `src/handlers/reports.js`, `renderer/js/screens/reports.js`, `renderer/js/screens/stock.js`, `renderer/js/screens/audit.js`

- [ ] **Step 1: تقارير SQL (handler reports.js)** — كل تقرير دالة SQL مع فلترة:
  - `stock:movementReport(itemId, from, to)` — حركة صنف: doc_type, doc_number, doc_date, in/out pieces+kg, running balance (تُحسب في JS بترتيب doc_date,id).
  - `reports:production(from,to,machineId)` — production_results مع كرتونها وتصريحها.
  - `reports:scrap(from,to)` — scrap_movements مع المصير.
  - `reports:purchases(from,to,partyId)` و `reports:sales(from,to,partyId)` — بإجماليات الريال.
  - `reports:inventory(warehouseId, group)` — جرد: لكل صنف balance_pieces + formatQty.
  - `reports:audit(from,to,userId)`.
  - `reports:exportCsv(reportId, params)` — نفس SQL → CSV بترميز UTF-8 BOM للعربية.

- [ ] **Step 2: شاشات** — `stock.js` (جرد بفلترة مخزن/مجموعة)، `reports.js` (قائمة تقارير + فلترة + جدول + زر طباعة A4 + زر تصدير CSV)، `audit.js` (جدول سجل التدقيق بفلترة تاريخ ومستخدم).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: reports, inventory and audit screens"`

**⏸ CHECKPOINT — المستخدم يفحص المرحلة 7 ويجرب الطباعة.**

---

## Stage 8: الحماية والإطلاق

**Deliverable:** نسخ احتياطي تلقائي ويدوي واسترجاع، مزامنة مجلد سحابي، تثبيت نهائي exe.

### Task 8.1: النسخ الاحتياطي والاسترجاع

**Files:**
- Create: `src/backup.js`, `src/handlers/backup.js`, `renderer/js/screens/backup.js`

- [ ] **Step 1: `src/backup.js`** — `createBackup()`: `db.backup(path)` إلى `backups/سام-بلاستيك-نسخة-YYYY-MM-DD-HHmm.db` + نسخ إلى مجلد سحابي من settings إن وُجد (`cloud_folder`). يُستدعى عند الإغلاق (app.on('before-quit')) ويومياً (setInterval 24h) وعبر `backup:now`. `restoreBackup(filePath)`: يغلق DB ويستبدل الملف ويعيد الفتح.

- [ ] **Step 2: شاشة backup** — زر "نسخ الآن"، قائمة النسخ (فتح مجلد)، "استرجاع" (اختيار ملف + تحذير أنه سيستبدل البيانات الحالية)، حقل "المجلد السحابي" في الإعدادات.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: backup, restore and cloud folder sync"`

### Task 8.2: التثبيت النهائي

- [ ] **Step 1: بناء المثبت** — `npm run dist` → `dist/سام بلاستيك Setup 0.1.0.exe`.

- [ ] **Step 2: فحص شامل** — تثبيت على مسار نظيف، الدخول، كل التدفقات، الطباعة، نسخ/استرجاع.

- [ ] **Step 3: Commit نهائي** — `git add -A && git commit -m "release: v0.1.0"`.

**⏸ CHECKPOINT — المستخدم يثبّت النسخة النهائية ويفحصها.**

---

## Self-Review

**1. Spec coverage:** شاشات §1 → app.html + كل screen. أصناف §2 → Task 2.1/2.2. تدفقات §3 → Stages 3-6. قاعدة بيانات §4 → schema.sql كامل. صلاحيات §5 → users + void + implicationsDialog + audit. تقارير §6 → Task 7.2. نسخ احتياطي §7 → Task 8.1. مراحل §8 → stages. نقاط مؤجلة §9 → تُعالج عند checkpoint كل مرحلة (صور النماذج).

**2. Placeholder scan:** لا TBD. كل الشاشات الباقية محددة بنمط warehouses.js الكامل + جداول حقول.

**3. Type consistency:** `writeMoves(db, docType, docId, docNumber, docDate, rows, userId)` موحدة في كل الاستخدامات. `toPieces(quantity, unit, item, piecesPerBox)` متسقة مع الاستدعاءات. القنوات بصيغة `domain:action` موحدة. `formatQty` تستخدم item.unit_name.

## Execution handoff

يُنفذ inline في هذه الجلسة (أمر المستخدم الصريح) عبر executing-plans مع **Checkpoint بعد كل Stage يفحصه المستخدم بنفسه**. تُستخدم checkbox للخطوات.
