// اختبارات المُحدِّث — «electron» و«electron-updater» مزيفان عبر require.cache، لأن هذا المنطق
// نفسه هو ما يُبقي التنزيل حيّاً أو يعلن موته، ولا يصح أن يعتمد الاختبار على نسخة مثبّتة.
// سبب وجود هذا الملف: مستكشف «نسبة التنزيل» كان يستدعي دالة غير معرّفة، فارتفع استثناء داخل
// حدث download-progress ذاته — أي داخل تدفق التنزيل — فتوقف عند 105 كيلوبايت وبدا للمستخدم
// أن الزر لا يعمل. أول اختبار هنا يمنع تكرار ذلك.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// مهل قصيرة: انقطاع بعد 40ms ومراقبة كل 10ms بدل دقيقة وكل خمس ثوانٍ
process.env.SAM_UPDATE_STALL_MS = '40';
process.env.SAM_UPDATE_TICK_MS = '10';

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== مزيف electron-updater =====
const fakeAuto = new EventEmitter();
const calls = { checkForUpdates: 0, downloadUpdate: 0, quitAndInstall: 0 };
let downloadShouldFail = null;

Object.assign(fakeAuto, {
  autoDownload: null, autoInstallOnAppQuit: null,
  checkForUpdates() {
    calls.checkForUpdates++;
    return new Promise((resolve) => setTimeout(() => {
      fakeAuto.emit('update-available', { version: fakeAuto.__nextVersion || '9.9.9' });
      resolve({ version: fakeAuto.__nextVersion || '9.9.9' });
    }, 1));
  },
  downloadUpdate() {
    calls.downloadUpdate++;
    // التنزيل الحقيقي لا ينتهي هنا: يبقى معلّقاً ليتحكّم الاختبار بأحداث التقدّم
    return downloadShouldFail ? Promise.reject(new Error(downloadShouldFail)) : new Promise(() => {});
  },
  quitAndInstall() { calls.quitAndInstall++; },
});

// ===== مزيف electron =====
const dialogs = [];
let dialogResponse = 1;            // 1 = «لاحقاً» — يمنع حلقات إعادة محاولة أثناء الاختبارات
const fakeElectron = {
  app: { getVersion: () => '1.1.3', getName: () => 'sam-plastic', isPackaged: true },
  dialog: { showMessageBox: (opts) => { dialogs.push(opts); return Promise.resolve({ response: dialogResponse }); } },
};

function seed(id, exports) {
  const filename = require.resolve(id);
  require.cache[filename] = { id: filename, filename, paths: [], children: [], exports,
    hot: { isActive: false }, loaded: true };
}
seed('electron', fakeElectron);
seed('electron-updater', { autoUpdater: fakeAuto });

const updater = require('../src/updater');
// أول قراءة للحالة تُوصّل المستمعات، فصار إرسال الأحداث بعده ذا معنى
updater.status();

const progress = (transferred, total, percent, speed = MB) =>
  fakeAuto.emit('download-progress', { transferred, total, percent, bytesPerSecond: speed });

// ===== الخطأ الأصلي: حدث التقدّم لا يرمي، والميجابايت تُقرأ =====
test('download-progress لا يرمي استثناءً ويُسجَّل بالميجابايت (تراجُع عن الدالة غير المعرّفة)', () => {
  assert.doesNotThrow(() => progress(105941, 111984951, 0.0947, 4096));
  const c = updater.status().lastCheck;
  assert.equal(c.state, 'downloading');
  assert.equal(c.progress, 0);        // 0.09% تصبح صفرًا — لهذا بدت الواجهة متجمّدة
  assert.equal(c.received_mb, 0.1);   // والميجابايت تُثبت أن تنزيلًا جرى فعلاً
  assert.equal(c.total_mb, 106.8);
  assert.equal(updater.status().downloading, true);
});

test('الحقول الناقصة أو غير الرقمية لا تُنتج NaN في التسمية', () => {
  assert.doesNotThrow(() => fakeAuto.emit('download-progress', { transferred: undefined, total: null, percent: 'x' }));
  const c = updater.status().lastCheck;
  assert.equal(c.progress, 0);
  assert.equal(c.received_mb, 0);
  assert.equal(c.total_mb, 0);
});

test('تدفّق التقدّم المستمر لا يُعلَن انقطاعًا', async () => {
  progress(1 * MB, 10 * MB, 10);
  await sleep(30);
  progress(3 * MB, 10 * MB, 30);
  await sleep(20);
  progress(6 * MB, 10 * MB, 60);
  assert.equal(updater.status().lastCheck.state, 'downloading');
  assert.equal(updater.status().downloading, true);
});

// ===== الانقطاع يُعلَن بدل أن يبقى صامتًا =====
test('تنزيل يتوقف عن إرسال التقدّم يُعلَن منقطعًا وتظهر نافذة إعادة المحاولة', async () => {
  const before = calls.downloadUpdate;
  dialogs.length = 0;
  progress(5 * MB, 100 * MB, 5);
  await sleep(150);                       // لا حدث تقدّم بعد الآن
  const st = updater.status();
  assert.equal(st.downloading, false);
  assert.equal(st.lastCheck.state, 'stalled');
  assert.match(st.lastCheck.message, /توقف التنزيل عند 5 من 100 م\.ب/);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'انقطاع تنزيل التحديث');
  assert.deepEqual(dialogs[0].buttons, ['إعادة المحاولة', 'لاحقاً']);
  assert.match(dialogs[0].detail, /releases\/latest/);
  assert.equal(calls.downloadUpdate, before, '«لاحقاً» لا تُنزّل من جديد');
});

test('قبول إعادة المحاولة يبدأ تنزيلًا فعليًا ويتوقف عند حد المحاولات', async () => {
  const before = calls.downloadUpdate;
  dialogs.length = 0;
  dialogResponse = 0;                     // المستخدم يضغط «إعادة المحاولة»
  progress(7 * MB, 100 * MB, 7);
  await sleep(150);                       // انقطاع → نافذة → إعادة محاولة → انقطاع → نافذة → …
  assert.ok(calls.downloadUpdate >= before + 1, 'أُعيد بدء التنزيل');
  assert.ok(calls.downloadUpdate <= before + 2, 'المحاولات الذاتية محدودة بلا نوافذ لا تنتهي');
  assert.ok(dialogs.length <= 2, 'عدد النوافذ محدود');
  dialogResponse = 1;
  fakeAuto.emit('update-downloaded', { version: '9.9.9' });  // يُسكِت المراقب للاختبار التالي
  await sleep(5);
});

test('اكتمال التنزيل يرفع الحالة إلى جاهز للتثبيت ويصفّر المحاولات', () => {
  const st = updater.status();
  assert.equal(st.downloading, false);
  assert.equal(st.lastCheck.state, 'downloaded');
  assert.equal(st.lastCheck.remote, '9.9.9');
});

test('خطأ من electron-updater ينهي علم التنزيل ويظهر برسالة مقروءة', () => {
  dialogs.length = 0;
  const q = calls.quitAndInstall;
  fakeAuto.emit('error', new Error('404 Not Found'));
  const st = updater.status();
  assert.equal(st.downloading, false);
  assert.equal(st.lastCheck.state, 'error');
  assert.match(st.lastCheck.message, /404 Not Found/);
  assert.equal(calls.quitAndInstall, q, 'الخطأ لا يُعيد تشغيل الجهاز لتثبيت شيء');
});

// ===== المسار اليدوي من الواجهة =====
test('الفحص اليدوي يفتح نافذة التنزيل ويزرّها فعلاً', async () => {
  dialogs.length = 0;
  const before = calls.downloadUpdate;
  dialogResponse = 0;                     // المستخدم يضغط «تنزيل وتحديث»
  fakeAuto.__nextVersion = '1.2.0';
  const r = await updater.checkNow();
  await sleep(10);
  assert.equal(r.state, 'available');
  assert.equal(r.remote, '1.2.0');
  assert.equal(calls.checkForUpdates >= 1, true);
  assert.deepEqual(dialogs[0].buttons, ['تنزيل وتحديث', 'لاحقاً']);
  assert.equal(calls.downloadUpdate, before + 1);
  assert.equal(updater.status().downloading, true);
});

test('الفحص أثناء تنزيل جارٍ يعرض الميجابايت المنزّلة ولا يبدأ فحصًا ثانيًا', async () => {
  const before = calls.checkForUpdates;
  progress(30 * MB, 100 * MB, 30);
  const r = await updater.checkNow();
  assert.equal(r.state, 'downloading');
  assert.equal(r.received_mb, 30);
  assert.equal(r.total_mb, 100);
  assert.match(r.message, /30 من 100 م\.ب/);
  assert.equal(calls.checkForUpdates, before, 'لا فحص فوق تنزيل قائم');
});

test('تنزيل مرفوض يظهر كخطأ مفصّل بدل أن يختفي في console', async () => {
  updater.status();                       // المستمعات موصّلة والعلم ما زال «جارٍ» من الاختبار السابق
  downloadShouldFail = 'certificate has expired';
  dialogs.length = 0;
  dialogResponse = 0;                     // قبول إعادة المحاولة بعد الانقطاع
  await sleep(150);                       // انقطاع صامت ← نافذة ← إعادة محاولة ← رفض
  const c = updater.status().lastCheck;
  assert.equal(c.state, 'error');
  assert.match(c.message, /فشل تنزيل التحديث/);
  assert.match(c.message, /certificate has expired/);
  assert.equal(updater.status().downloading, false);
  downloadShouldFail = null;
  dialogResponse = 1;
});

test('لا تثبيت ولا تنزيل ذاتي بلا إذن المستخدم', () => {
  assert.equal(fakeAuto.autoDownload, false, 'autoDownload يجب أن يبقى مقموعًا');
  assert.equal(fakeAuto.autoInstallOnAppQuit, true);
  assert.equal(typeof updater.promptInstall, 'function');
});
