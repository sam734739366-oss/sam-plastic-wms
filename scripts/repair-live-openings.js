// إصلاح لمرة واحدة للأرصدة الافتتاحية في القاعدة الحية + نسخة احتياطية قبل الإصلاح
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { repairOpenings } = require('../src/db');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const live = path.join(__dirname, '..', 'data', 'samplastic.db');
const backup = path.join(__dirname, '..', 'data', 'backups', `سام-بلاستيك-نسخة-قبل-إصلاح-الافتتاح-${ts()}.db`);

// 1) نسخة احتياطية متسقة (VACUUM INTO)
{
  const src = new DatabaseSync(live, { readOnly: true });
  src.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
  src.close();
  console.log('backup:', backup);
}

// 2) الإصلاح على القاعدة الحية
const db = new DatabaseSync(live);
db.exec('PRAGMA foreign_keys = ON');
const beforeRows = db.prepare(`SELECT i.code, sm.bucket, sm.qty_in_pieces - sm.qty_out_pieces qty
  FROM stock_moves sm JOIN items i ON i.id = sm.item_id WHERE sm.doc_type='opening' ORDER BY i.code, sm.bucket`).all();
const { changed } = repairOpenings(db);
console.log('changed:', JSON.stringify(changed, null, 2));

// 3) التحقق: كل عداد سلة == صافي حركات المخزون للسلة نفسها
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

// 4) عرض الافتتاح بعد الإصلاح
const afterRows = db.prepare(`SELECT i.code, sm.bucket, sm.qty_in_pieces - sm.qty_out_pieces qty
  FROM stock_moves sm JOIN items i ON i.id = sm.item_id WHERE sm.doc_type='opening' ORDER BY i.code, sm.bucket`).all();
console.log('openings after:');
for (const r of afterRows) console.log(`  ${r.code} ${r.bucket}: ${r.qty}`);
db.close();
