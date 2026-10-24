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
  issue_permit_id INTEGER REFERENCES issue_permits(id),
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
  payment_method TEXT NOT NULL DEFAULT 'credit' CHECK (payment_method IN ('cash','credit')),
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
  talef_take INTEGER NOT NULL DEFAULT 0,
  salem_take INTEGER NOT NULL DEFAULT 0,
  is_customer INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
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
  notes TEXT
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
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
  notes TEXT
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
  bucket TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_moves(item_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_doc ON stock_moves(doc_type, doc_id);

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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
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
