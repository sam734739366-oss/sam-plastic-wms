// حذف بيانات الأقسام الملغاة من القاعدة الحية (بيع/خروج/مرتجع بيع/سندات/عملاء بلا ارتباط) + نسخة احتياطية قبل الحذف
// يُنفَّذ مرة واحدة بعد موافقة المستخدم. الأرصدة الحالية (العدادات والجرد) لا تتغير — الافتتاح يُمتص أثر المحذوف.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { removeNonWarehouseData } = require('../src/cleanup');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const live = path.join(__dirname, '..', 'data', 'samplastic.db');
const backup = path.join(__dirname, '..', 'data', 'backups', `سام-بلاستيك-نسخة-قبل-حذف-الأقسام-الملغاة-${ts()}.db`);

// 1) نسخة احتياطية متسقة (VACUUM INTO)
{
  const src = new DatabaseSync(live, { readOnly: true });
  src.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
  src.close();
  console.log('backup:', backup);
}

// 2) الحذف على القاعدة الحية
const db = new DatabaseSync(live);
db.exec('PRAGMA foreign_keys = ON');
const removed = removeNonWarehouseData(db);
console.log('removed:', JSON.stringify(removed, null, 2));

// 3) التحقق: كل عداد سلة == صافي حركات المخزون للسلة نفسها (الثبات بعد الحذف)
const rows = db.prepare(`SELECT item_id, bucket, COALESCE(SUM(qty_in_pieces),0)-COALESCE(SUM(qty_out_pieces),0) net
  FROM stock_moves GROUP BY item_id, bucket`).all();
let ok = true;
for (const it of db.prepare('SELECT * FROM items').all()) {
  for (const key of ['salem', 'talef', 'muharraz']) {
    const r = rows.find(x => x.item_id === it.id && x.bucket === key);
    const net = r ? r.net : 0;
    const counter = Number(it[`qty_${key}`]) || 0;
    if (net !== counter) {
      ok = false;
      console.log(`MISMATCH ${it.code} ${key}: counter=${counter} moves=${net}`);
    }
  }
}
console.log('consistent:', ok);

// 4) ملخص ما بقي في القاعدة
const cnt = (sql) => db.prepare(sql).get().c;
console.log('remaining:', JSON.stringify({
  invoices: cnt("SELECT COUNT(*) c FROM invoices"),
  sales_returns: cnt('SELECT COUNT(*) c FROM sales_returns'),
  exit_permits: cnt('SELECT COUNT(*) c FROM exit_permits'),
  payments: cnt('SELECT COUNT(*) c FROM payments'),
  parties: cnt('SELECT COUNT(*) c FROM parties'),
  purchases: cnt('SELECT COUNT(*) c FROM purchases'),
  purchase_returns: cnt('SELECT COUNT(*) c FROM purchase_returns'),
}, null, 2));
db.close();
console.log('done');
