// مسح كامل لبيانات البرنامج في القاعدة الحية (بناءً على طلب المستخدم) بعد نسخة احتياطية.
// تُحذف كل جداول الأعمال والمراجع وتُصفَّر التسلسلات، ويُستثنى جدولا النظام:
//   users (المستخدمون وكلمات المرور) و settings (إعدادات الطابعة وغيرها).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const live = path.join(__dirname, '..', 'data', 'samplastic.db');
const backup = path.join(__dirname, '..', 'data', 'backups', `سام-بلاستيك-نسخة-قبل-مسح-البيانات-${ts()}.db`);
const KEEP = ['users', 'settings'];

// 1) نسخة احتياطية متسقة (VACUUM INTO)
{
  const src = new DatabaseSync(live, { readOnly: true });
  src.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
  src.close();
  console.log('backup:', backup);
}

// 2) تحديد جداول الحذف من sqlite_master نفسها (كل الجداول عدا المستثناة)
const db = new DatabaseSync(live);
const wipe = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all().map(r => r.name).filter(t => !KEEP.includes(t));
console.log(`سيُحذف ${wipe.length} جدولاً: ${wipe.join(', ')}`);

const keptCounts = {};
for (const t of KEEP) keptCounts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

// 3) الحذف مع تعطيل قيود المفاتيح مؤقتاً ثم تصفير التسلسلات
db.exec('PRAGMA foreign_keys = OFF');
for (const t of wipe) {
  const { changes } = db.prepare(`DELETE FROM ${t}`).run();
  console.log(`  ${t}: ${changes}`);
}
if (wipe.length) {
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${wipe.map(t => `'${t}'`).join(',')})`).run();
}
db.exec('PRAGMA foreign_keys = ON');

// 4) التحقق: كل الجداول المحذوفة صفرية، والمستثناة سليمة، ولا أخطاء مفاتيح
let bad = 0;
for (const t of wipe) {
  const c = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  if (c !== 0) { bad += 1; console.log(`  ! ${t} ما زال فيه ${c} صفاً`); }
}
for (const t of KEEP) {
  const c = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  if (c !== keptCounts[t]) { bad += 1; console.log(`  ! ${t} تغير: ${keptCounts[t]} -> ${c}`); }
}
const fk = db.prepare('PRAGMA foreign_key_check').all();
if (fk.length) { bad += 1; console.log('  ! أخطاء مفاتيح أجنبية:', JSON.stringify(fk)); }

if (bad === 0) {
  console.log(`تم المسح بنجاح — كل جداول البيانات صفرية، وبقي: المستخدمون ${keptCounts.users}، الإعدادات ${keptCounts.settings}`);
} else {
  console.log(`فشل التحقق: ${bad} مشكلة`);
  process.exitCode = 1;
}
db.close();
