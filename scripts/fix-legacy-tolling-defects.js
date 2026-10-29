// واجهة سطر الأوامر لأداة إصلاح التالف التاريخي على كراتين خام العميل.
// المنطق نفسه في src/legacyFix.js — وهو الذي يستدعيه زر «إصلاح البيانات القديمة» في التطبيق،
// فلا ضرورة لفتح طرفية إطلاقاً؛ هذا الملف لمنفضّل التشغيل اليدوي.
//
// الاستخدام:
//   node scripts/fix-legacy-tolling-defects.js                 عرض تفصيلي بلا كتابة
//   node scripts/fix-legacy-tolling-defects.js --apply         تنفيذ الإصلاح بعد نسخة احتياطية
//   node scripts/fix-legacy-tolling-defects.js --apply --create-scrap
//                                                              + إنشاء سندات تالف العملاء
//   node scripts/fix-legacy-tolling-defects.js --db "C:\\مسار\\القاعدة.db"   قاعدة أخرى

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const legacy = require('../src/legacyFix');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const optValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const APPLY = has('--apply');
const CREATE_SCRAP = has('--create-scrap');
const dbPath = optValue('--db') || path.join(__dirname, '..', 'data', 'samplastic.db');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(dbPath)) {
  console.error(`قاعدة البيانات غير موجودة: ${dbPath}`);
  console.error('مرّر المسار الصحيح بـ --db "مسار الملف"');
  process.exit(1);
}

console.log('القاعدة:', dbPath);
console.log('النمط :', APPLY ? 'كتابة (سيُنشأ نسخة احتياطية أولاً)' : 'عرض فقط — لا تتغير البيانات');
if (CREATE_SCRAP && !APPLY) console.log('تنبيه : --create-scrap مفعّل لكنه لن يُكتب في وضع العرض.');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

let report;
try {
  report = legacy.analyze(db);
} catch (err) {
  console.error(String(err.message || err));
  db.close();
  process.exit(1);
}

console.log('\n' + '='.repeat(64));
console.log(`حركات تالف قديمة على كراتين عملاء : ${report.rowCount}`);
console.log(`كراتين متأثرة                     : ${report.cartonCount}`);
console.log('.'.repeat(64));

if (!report.items.length) {
  console.log('لا شيء يُصلح — لا توجد حركات تالف قديمة على كراتين خام عميل.');
  db.close();
  process.exit(0);
}

for (const g of report.items) {
  console.log(`صنف ${g.code || '—'} ${g.name}: qty_talef ${g.qty_talef} − ${g.total} = ${g.after}${g.shortfall ? '  ⚠ عدّاد التالف لا يكفي — يحتاج مراجعة يدوية' : ''}`);
  for (const c of g.cartons) {
    console.log(`    ${c.cartonNumber}: ${c.defects} حبة  [${c.viaCarton ? 'كرتون عميل' : 'تصريح عميل'} | ${c.owner || 'بلا عميل'}]${c.hasScrapDoc ? ' | سند التالف موجود' : ''}`);
  }
}

console.log('.'.repeat(64));
console.log(`كراتين بلا نتيجة إنتاج محفوظة (تالف يتيم) : ${report.orphans.length}`);
console.log(`كراتين تحتاج سند تالف للعميل            : ${report.missingScrap.length}`);
console.log('='.repeat(64));

if (!APPLY) {
  console.log('\nوضع العرض: لم تتغيّر أي بيانات. نفّذ الإصلاح بـ:');
  console.log('  node scripts/fix-legacy-tolling-defects.js --apply');
  console.log('ولإنشاء سندات تالف العملاء في نفس التمريرة أضف --create-scrap');
  console.log('أو من داخل التطبيق: شاشة «النسخ الاحتياطي» ← زر «إصلاح البيانات القديمة».');
  db.close();
  process.exit(0);
}

const backupDir = path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `سام-بلاستيك-نسخة-قبل-إصلاح-تالف-العملاء-${ts()}.db`);
{
  const src = new DatabaseSync(dbPath, { readOnly: true });
  src.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
  src.close();
  console.log('\nنسخة احتياطية:', backup);
}

const done = legacy.apply(db, { createScrap: CREATE_SCRAP });
console.log(`\nتم: حذف ${done.removed} حركة تالف قديمة، وخصم ${done.subtracted} حبة من عدّادات التالف.`);
if (CREATE_SCRAP) console.log(`سندات تالف جديدة للعملاء: ${done.createdScrap}`);
if (done.skipped.length) {
  console.log('\n⚠ أصناف تجاوز الخصم عدّادها — تُركت بلا تغيير وتحتاج مراجعة يدوية:');
  for (const s of done.skipped) console.log(`   ${s.code}: العدّاد ${s.counter} والمطلوب خصمه ${s.need}`);
}

const check = legacy.verify(db, done.perItem.map((p) => p.itemId));
console.log('\nالتحقق — عدّاد تالف كل صنف مقابل صافي حركات السلة (يشمل الافتتاحي):');
for (const p of check.perItem) {
  console.log(`  ${p.code}: عدّاد=${p.counter} صافي الحركات=${p.net} ${p.match ? 'متطابق' : '⚠ غير متطابق'}`);
}
console.log(`الحركات القديمة المتبقية على كراتين العملاء: ${check.residual} (المطلوب 0${done.skipped.length ? ' — عدا الأصناف المتروكة للمراجعة' : ''})`);
console.log('النتيجة:', check.perItem.every((p) => p.match) && check.residual === 0 ? 'سليمة' : 'تحتاج مراجعة — قارن القيم أعلاه قبل الاعتماد');

db.close();
