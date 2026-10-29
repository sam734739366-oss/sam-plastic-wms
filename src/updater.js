// التحديث التلقائي من GitHub Releases — منطق واحد يستعمله الفحص الصامت عند الإقلاع والفحص اليدوي من الواجهة
// يعمل في النسخة المثبّتة فقط؛ وأي فشل يُعاد كنتيجة نصية مقروءة بدل أن يوقف التطبيق أو يمسّ البيانات.
const { app, dialog } = require('electron');

const CHECK_TIMEOUT_MS = 45000;

let cached = null;      // autoUpdater — أو false إن لم تكن الحزمة متوفرة
let lastCheck = null;   // آخر نتيجة، تُعرض في الواجهة بلا إعادة فحص
let manualBusy = false; // قمع نافذة الفحص التلقائي أثناء فحص يدوي حتى لا تظهر رسالتان
let downloading = false; // تنزيل جارٍ الآن — يمنع بدء فحص ثانٍ فوقه

function updater() {
  if (cached !== null) return cached;
  try {
    ({ autoUpdater: cached } = require('electron-updater'));
  } catch {
    cached = false;
    return cached;
  }
  wire(cached);
  return cached;
}

function snap(state, message, remote) {
  lastCheck = { at: new Date().toISOString(), state, local: app.getVersion(), remote: remote || null, message: message || null };
  return lastCheck;
}

function wire(a) {
  a.autoDownload = false;               // لا تنزيل بلا ضغط المستخدم
  a.autoInstallOnAppQuit = true;
  a.on('error', (err) => {
    const message = String((err && err.message) || err || 'خطأ غير معروف');
    console.warn('[updater]', message);
    snap('error', message);
  });
  a.on('update-available', (info) => {
    snap('available', null, info && info.version);
    if (!manualBusy) promptDownload(info);
  });
  a.on('update-not-available', () => snap('current'));
  a.on('download-progress', (p) => {
    downloading = true;
    const base = lastCheck || snap('downloading');
    lastCheck = { ...base, state: 'downloading', progress: Math.round(num(p && p.percent) || 0) };
  });
  a.on('update-downloaded', (info) => {
    downloading = false;
    snap('downloaded', null, info && info.version);
    if (!manualBusy) promptInstall();
  });
}

function promptDownload(info) {
  dialog.showMessageBox({
    type: 'info',
    title: 'تحديث سام بلاستيك',
    message: `يوجد إصدار جديد (${(info && info.version) || 'غير معروف'}). الإصدار الحالي ${app.getVersion()}.`,
    detail: 'سيُنشأ نسخة احتياطية من البيانات تلقائياً قبل تثبيت التحديث.',
    buttons: ['تنزيل وتحديث', 'لاحقاً'],
    defaultId: 0, cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      const a = updater();
      if (a) a.downloadUpdate().catch((e) => console.warn('[updater] download', e && e.message));
    }
  }).catch(() => {});
}

function promptInstall() {
  dialog.showMessageBox({
    type: 'info', title: 'التحديث جاهز',
    message: 'سيُعاد تشغيل البرنامج لإتمام التثبيت.', buttons: ['إعادة التشغيل الآن'],
  }).then(() => {
    const a = updater();
    // قبل-إغلاق يُطلق النسخ الاحتياطي التلقائي في main.js، فتنشأ نسخة قبل التبديل
    if (a) a.quitAndInstall(false, true);
  }).catch(() => {});
}

// الفحص الصامت بعد الإقلاع — بلا إزعاج إن لا شيء جديد
function initAutoUpdater() {
  if (!app.isPackaged) return;
  const a = updater();
  if (!a) return;
  setTimeout(() => { a.checkForUpdates().catch(() => {}) }, 4000);
}

// الفحص اليدوي من الواجهة: يُرجع نتيجة نصية دائماً، ولا يرمي استثناءً
async function checkNow() {
  if (!app.isPackaged) {
    return { ok: true, state: 'dev', local: app.getVersion(), remote: null,
      message: 'التطبيق يعمل من المصدر: لا فحص تحديثات هنا. التحديث التلقائي يعمل في النسخة المثبّتة فقط.' };
  }
  const a = updater();
  if (!a) return { ok: false, state: 'unavailable', local: app.getVersion(), remote: null,
    message: 'حزمة electron-updater غير متوفرة في هذه النسخة.' };
  if (downloading) {
    const pct = lastCheck && lastCheck.progress != null ? lastCheck.progress : 0;
    return { ok: true, state: 'downloading', local: app.getVersion(), remote: (lastCheck && lastCheck.remote) || null,
      progress: pct, message: `التنزيل جارٍ (${pct}%) — يكتمل الطلب تلقائياً عند النهاية.` };
  }
  if (lastCheck && lastCheck.state === 'downloaded') {
    return { ok: true, ...lastCheck, message: `التنزيل اكتمل (إصدار ${lastCheck.remote}) — أعد التشغيل للتثبيت.` };
  }

  manualBusy = true;
  const settled = new Promise((resolve) => {
    const timer = setTimeout(() => {
      detach();
      resolve({ ok: false, state: 'timeout', local: app.getVersion(), remote: null,
        message: 'انتهت مهلة الفحص — تحقّق من الاتصال بالإنترنت ثم أعد المحاولة.' });
    }, CHECK_TIMEOUT_MS);
    // الفحص اليدوي يجب أن يُنزّل فعلاً: المستمع التلقائي مقموع هنا، فالاستدعاء الصريح هو
    // ما يفتح نافذة «تنزيل وتحديث». بدونه يعلن البرنامج وجود تحديث ثم يصمت — وهو الخطأ الذي كان.
    const onAvailable = (info) => {
      detach();
      resolve({ ok: true, state: 'available', local: app.getVersion(), remote: info && info.version, message: `يوجد إصدار جديد ${info && info.version}.` });
      promptDownload(info);
    };
    const onNotAvailable = () => { detach(); resolve({ ok: true, state: 'current', local: app.getVersion(), remote: app.getVersion(), message: 'أنت على أحدث إصدار.' }); };
    const onError = (err) => { detach(); resolve({ ok: false, state: 'error', local: app.getVersion(), remote: null, message: String((err && err.message) || err) }); };
    function detach() {
      clearTimeout(timer);
      manualBusy = false;
      a.removeListener('update-available', onAvailable);
      a.removeListener('update-not-available', onNotAvailable);
      a.removeListener('error', onError);
    }
    a.on('update-available', onAvailable);
    a.on('update-not-available', onNotAvailable);
    a.on('error', onError);
  });

  // manualBusy يمنع نافذة الفحص التلقائي من الظهور فوق نتيجة الفحص اليدوي
  a.checkForUpdates().catch(() => {});
  return settled;
}

function status() {
  return { packaged: app.isPackaged, version: app.getVersion(), name: app.getName(), downloading, lastCheck };
}

module.exports = { initAutoUpdater, checkNow, status, promptInstall };
