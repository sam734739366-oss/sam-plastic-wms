-- مخطط الإصدار 2.0.0 — «الحبة هي الملك» والحذف الفعلي بلا حالة «ملغى»
-- لا يوجد عمود status في أي مستند: الحذف يمسح الصفوف فعلياً ويردّ أثرها فوراً.
-- cartons.status استثناء مقصود: هو حالة فيزيائية للكرتون (في المخزن/صرف/أنتج) لا حالة إلغاء.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','clerk','viewer','warehouse')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- الوحدة الأساس لكل الأصناف هي الحبة. الكيس والكرتون والشدة مجرد مقابلات يعرضها التطبيق،
-- وunit_name هو التسمية التي تظهر بدل كلمة «حبة» في كل الشاشات والطباعة (زجاجة/غطاء/كيس/أمبولة...).
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_group INTEGER NOT NULL DEFAULT 2 CHECK (item_group BETWEEN 1 AND 5),
  unit_name TEXT NOT NULL DEFAULT 'حبة',
  weight_grams REAL,
  pieces_per_carton INTEGER,
  pieces_per_shadda INTEGER,
  pieces_per_bag INTEGER,
  -- صنف الأكياس الفارغة الذي يُستهلك لتعبئة هذا الصنف (خصم آلي عند استلام الإنتاج التام)
  bag_item_id INTEGER REFERENCES items(id),
  qty_salem INTEGER NOT NULL DEFAULT 0,
  qty_talef INTEGER NOT NULL DEFAULT 0,
  qty_muharraz INTEGER NOT NULL DEFAULT 0,
  opening_warehouse_id INTEGER,
  service_price REAL,
  is_recycled INTEGER NOT NULL DEFAULT 0,
  brand TEXT,
  size_label TEXT,
  bale_size TEXT,
  bale_condition TEXT,
  bale_mixed INTEGER NOT NULL DEFAULT 0,
  is_complement INTEGER NOT NULL DEFAULT 0,
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
  payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit')),
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
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

CREATE TABLE IF NOT EXISTS cartons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carton_number TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  purchase_id INTEGER REFERENCES purchases(id),
  pieces INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','issued','finished')),
  issue_date TEXT,
  issue_permit_id INTEGER REFERENCES issue_permits(id),
  notes TEXT,
  -- الكرتون قد يكون من خام المصنع أو من خام عميل (النفخ للغير).
  -- كراتين العميل بلا أي أثر على مخزون المصنع وسلاته، وتُخصم من رصيد العميل.
  party_id INTEGER REFERENCES parties(id),
  source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own','customer')),
  receipt_id INTEGER REFERENCES customer_raw_receipts(id)
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
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

-- ===== استلام الإنتاج (المستند الموحّد) =====
-- يدمج «نتيجة الإنتاج» و«استلام التام» في مستند واحد: يُختار تصريح الصرف، وتُسجَّل
-- نتيجة كل كرتون (سليم/تالف قبل/تالف بعد)، فيُوزَّع الأثر تلقائياً:
--   سليم (+الفائض)   → تام سليم   في مخزن الاستلام
--   تالف بعد         → تام تالف
--   تالف قبل         → خام تالف    (صنف الخام الذي جاء منه الكرتون)
--   عجز (مصروف > منتج) → يُسجَّل في الفارق فقط، بلا حركة مخزون
CREATE TABLE IF NOT EXISTS production_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  issue_permit_id INTEGER NOT NULL REFERENCES issue_permits(id),
  machine_id INTEGER REFERENCES machines(id),
  shift_id INTEGER REFERENCES shifts(id),
  receiver_name TEXT,
  -- مصدر الخام: own = خام المصنع، customer = النفخ للغير (عهدة عميل)
  source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own','customer')),
  party_id INTEGER REFERENCES parties(id),
  -- الصنف النهائي المنتَج ومخزنه: الاستلام كلّه لصنف واحد (دفعة ماكينة/وردية واحدة)
  fg_item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  -- الأرصدة المحسوبة المخزّنة للتقرير والتسوية (الحبات هي الوحدة المرجعية)
  issued_pieces INTEGER NOT NULL DEFAULT 0,
  good_pieces INTEGER NOT NULL DEFAULT 0,
  defect_before_pieces INTEGER NOT NULL DEFAULT 0,
  defect_after_pieces INTEGER NOT NULL DEFAULT 0,
  total_pieces INTEGER NOT NULL DEFAULT 0,
  -- موجب = عجز (مصروف أكثر من المنتج)، سالب = فائض أُضيف إلى التام السليم
  variance_pieces INTEGER NOT NULL DEFAULT 0,
  surplus_pieces INTEGER NOT NULL DEFAULT 0,
  -- تعبئة التام: أكياس مكتملة + كسور، والأكياس المستهلكة = مكتملة + كيس للكسور
  bags INTEGER NOT NULL DEFAULT 0,
  breaks INTEGER NOT NULL DEFAULT 0,
  bags_used INTEGER NOT NULL DEFAULT 0,
  bag_item_id INTEGER REFERENCES items(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS production_receipt_cartons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES production_receipts(id) ON DELETE CASCADE,
  carton_id INTEGER NOT NULL REFERENCES cartons(id),
  good_pieces INTEGER NOT NULL DEFAULT 0,
  defect_before_pieces INTEGER NOT NULL DEFAULT 0,
  defect_after_pieces INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER REFERENCES parties(id),
  invoice_type TEXT NOT NULL DEFAULT 'sale' CHECK (invoice_type IN ('sale','scrap','blowing_fee')),
  payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit')),
  driver_name TEXT,
  car_number TEXT,
  notes TEXT,
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
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
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
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

CREATE TABLE IF NOT EXISTS customer_raw_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS customer_raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES customer_raw_receipts(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  boxes REAL NOT NULL DEFAULT 0,
  pieces_per_box INTEGER,
  pieces INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'علبة',
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
  -- production_defect: تالف استلام إنتاج بخام عميل — سند يُدار آلياً مع الاستلام
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
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- سند التالف التلقائي تابع لاستلام إنتاج بعينه (عكس prod_carton_id القديم على مستوى الكرتون)
  prod_receipt_id INTEGER REFERENCES production_receipts(id) ON DELETE CASCADE
);

-- مرتجعات البيع: إرجاع العميل بضاعة من فاتورة بيع (ترجع للمخزون وتخفض ذمة العميل)
CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  party_id INTEGER REFERENCES parties(id),
  payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  unit_price REAL,
  total_price REAL,
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

-- مرتجعات الشراء: إرجاع المصنع بضاعة للمورد (تخرج من المخزون وتخفض ذمة المورد)
CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  party_id INTEGER REFERENCES parties(id),
  payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  pieces INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  unit_price REAL,
  total_price REAL,
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  notes TEXT,
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
  notes TEXT,
  bucket TEXT NOT NULL DEFAULT 'salem' CHECK (bucket IN ('salem','talef','muharraz'))
);

-- دفتر الحركة المخزني: يُحذف مع مستنده عند الحذف الفعلي، ويُعاد بناء الأثر للعدّادات
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
  bucket TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_moves(item_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_doc ON stock_moves(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_stock_date ON stock_moves(doc_date);

CREATE TABLE IF NOT EXISTS party_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER REFERENCES parties(id),
  doc_type TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  doc_number TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount REAL NOT NULL DEFAULT 0,
  cash_in REAL NOT NULL DEFAULT 0,
  cash_out REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_party ON party_ledger(party_id);
CREATE INDEX IF NOT EXISTS idx_ledger_doc ON party_ledger(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount REAL NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

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

-- فهارس تُبنى بعد المخطط مباشرة (لا حاجة لترحيلها في db.js لأن المخطط جديد بالكامل)
CREATE INDEX IF NOT EXISTS idx_cartons_source ON cartons(source, party_id, status);
CREATE INDEX IF NOT EXISTS idx_cartons_receipt ON cartons(receipt_id);
CREATE INDEX IF NOT EXISTS idx_cartons_issue ON cartons(issue_permit_id);
CREATE INDEX IF NOT EXISTS idx_receipt_cartons ON production_receipt_cartons(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_carton ON production_receipt_cartons(carton_id);
CREATE INDEX IF NOT EXISTS idx_receipt_issue ON production_receipts(issue_permit_id);
CREATE INDEX IF NOT EXISTS idx_scrap_prod_receipt ON scrap_movements(prod_receipt_id);
