// التحديث التلقائي من GitHub Releases — منطق واحد يستعمله الفحص الصامت عند الإقلاع والفحص اليدوي من الواجهة
// يعمل في النسخة المثبّتة فقط؛ وأي فشل يُعاد كنتيجة نصية مقروءة بدل أن يوقف التطبيق أو يمسّ البيانات.
const { app, dialog } = require('electron');

const CHECK_TIMEOUT_MS = 45000;
// electron-updater لا يعرض شريط تقدّم ولا يُعلن انقطاعاً: إن مات التدفق يبقى الملف الجزئي
// في مجلد pending بلا نهاية. دقيقة كاملة بلا حدث تقدّم تعني أن التنزيل توقّف.
// المهل قابلة للضبط من المتغيرات البيئية حتى تختبرها الحزمة في أجزاء الثانية.
const DOWNLOAD_STALL_MS = num(process.env.SAM_UPDATE_STALL_MS) || 60000;
const STALL_TICK_MS = num(process.env.SAM_UPDATE_TICK_MS) || 5000;
const RELEASES_URL = 'https://github.com/sam734739366-oss/sam-plastic-wms/releases/latest';
const MB = 1024 * 1024;

// أرقام آمنة: أي قيمة غائبة أو غير رقمية تصبح صفراً بدل NaN يظهر في الواجهة أو يوقف التنزيل
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function mb(bytes) { return Math.round(num(bytes) / MB * 10) / 10; }

let cached = null;      // autoUpdater — أو false إن لم تكن الحزمة متوفرة
let lastCheck = null;   // آخر نتيجة، تُعرض في الواجهة بلا إعادة فحص
let manualBusy = false; // قمع نافذة الفحص التلقائي أثناء فحص يدوي حتى لا تظهر رسالتان
let downloading = false; // تنزيل جارٍ الآن — يمنع بدء فحص ثانٍ فوقه
let lastProgressAt = 0;  // زمن آخر حدث download-progress — أساس كشف الانقطاع
let stallTimer = null;   // مراقب الانقطاع، يعمل فقط أثناء التنزيل
// كل انقطاع يُفتح له نافذة إعادة محاولة، فلا يجوز أن تتوالى النوافذ بلا نهاية على
// خط بطيء ينقطع كل دقيقة — محاولات تلقائية محدودة وبعدها يُعرض رابط المتصفح.
const MAX_STALL_RETRIES = 2;
let stallRetries = 0;

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
    stopStallWatch();
    downloading = false;
    snap('error', message, lastCheck && lastCheck.remote);
  });
  a.on('update-available', (info) => {
    snap('available', null, info && info.version);
    if (!manualBusy) promptDownload(info);
  });
  a.on('update-not-available', () => snap('current'));
  a.on('download-progress', (p) => {
    downloading = true;
    lastProgressAt = Date.now();
    const received = num(p && p.transferred);
    const total = num(p && p.total);
    // النسبة وحدها تُعرض «0%» في أول دقائق التنزيل فتوحي بالتجمّد؛ الميجابايت أدقّ وأصدق.
    lastCheck = { ...(lastCheck || {}), at: new Date().toISOString(), state: 'downloading',
      local: app.getVersion(), remote: (lastCheck && lastCheck.remote) || null,
      progress: Math.round(num(p && p.percent)), received_mb: mb(received), total_mb: mb(total),
      speed_mb: mb(p && p.bytesPerSecond) };
    startStallWatch(a);
  });
  a.on('update-downloaded', (info) => {
    downloading = false;
    stallRetries = 0;
    stopStallWatch();
    snap('downloaded', null, info && info.version);
    if (!manualBusy) promptInstall();
  });
}

// ===== مراقبة انقطاع التنزيل =====
function startStallWatch(a) {
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    if (!downloading) { stopStallWatch(); return; }
    if (Date.now() - lastProgressAt < DOWNLOAD_STALL_MS) return;
    onStalled(a);
  }, STALL_TICK_MS);
  if (stallTimer.unref) stallTimer.unref(); // لا يُبقي العملية حيّة في الاختبارات ولا يؤخر الإقلاع
}

function stopStallWatch() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
}

function onStalled(a) {
  stopStallWatch();
  downloading = false;
  const got = (lastCheck && lastCheck.received_mb) || 0;
  const tot = (lastCheck && lastCheck.total_mb) || 0;
  const hint = stallRetries >= MAX_STALL_RETRIES
    ? `نُزِّل ${got} م.ب من ${tot} م.ب ثم انقطع مرتين. نزّل الإصدار من المتصفح:\n${RELEASES_URL}`
    : `نُزِّل ${got} م.ب من ${tot} م.ب. جرّب «إعادة المحاولة»، وإن تكرر الانقطاع نزّل الإصدار من المتصفح:\n${RELEASES_URL}`;
  snap('stalled', `توقف التنزيل عند ${got} من ${tot} م.ب — انقطاع الاتصال غالباً.`, lastCheck && lastCheck.remote);
  if (stallRetries >= MAX_STALL_RETRIES) return;  // بلا نوافذ متوالية على خط ينقطع كل دقيقة
  stallRetries++;
  dialog.showMessageBox({
    type: 'warning',
    title: 'انقطاع تنزيل التحديث',
    message: 'توقف تنزيل التحديث ولم تصل أي بيانات خلال آخر دقيقة.',
    detail: hint,
    buttons: ['إعادة المحاولة', 'لاحقاً'],
    defaultId: 0, cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) startDownload(a);
  }).catch(() => {});
}

// التنزيل في مكان واحد: يرفع علم «جارٍ» قبل البدء حتى تُقرأ الحالة صحيحاً من الواجهة،
// ويحوّل رفض electron-updater إلى رسالة مفهومة بدل أن تختفي في console.
function startDownload(a) {
  if (!a) return;
  downloading = true;
  lastProgressAt = Date.now();
  startStallWatch(a);
  snap('downloading', null, (lastCheck && lastCheck.remote) || null);
  Promise.resolve()
    .then(() => a.downloadUpdate())
    .then(() => { stopStallWatch(); })
    .catch((e) => {
      stopStallWatch();
      downloading = false;
      const message = `فشل تنزيل التحديث: ${String((e && e.message) || e || 'خطأ غير معروف')}`;
      console.warn('[updater]', message);
      snap('error', message, (lastCheck && lastCheck.remote) || null);
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
    if (response === 0) startDownload(updater());
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
    const c = lastCheck || {};
    const pct = c.progress != null ? c.progress : 0;
    const detail = c.total_mb ? `${c.received_mb || 0} من ${c.total_mb} م.ب` : `${pct}%`;
    return { ok: true, state: 'downloading', local: app.getVersion(), remote: c.remote || null,
      progress: pct, received_mb: c.received_mb || 0, total_mb: c.total_mb || 0,
      message: `التنزيل جارٍ (${detail}) — يكتمل الطلب تلقائياً عند النهاية.` };
  }
  if (lastCheck && lastCheck.state === 'downloaded') {
    return { ok: true, ...lastCheck, message: `التنزيل اكتمل (إصدار ${lastCheck.remote}) — أعد التشغيل للتثبيت.` };
  }

  manualBusy = true;
  stallRetries = 0;      // محاولة يدوية جديدة تستحق نافذتي إعادة محاولة من جديد
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
  updater(); // أول قراءة للحالة تُوصّل الأحداث، فلا يراقب شيء تنزيلاً لم يُسمع بعد
  return { packaged: app.isPackaged, version: app.getVersion(), name: app.getName(),
    downloading, lastCheck };
}

module.exports = { initAutoUpdater, checkNow, status, promptInstall };
