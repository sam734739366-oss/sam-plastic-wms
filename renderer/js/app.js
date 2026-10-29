import { currentUser } from './api.js';
import { go, currentScreen } from './router.js';
import { initWM } from './wm.js';
import { setCurrency } from './fmt.js';
import { explainDialog, toast } from './ui.js';
import { helpFor } from './help.js';

// ===== تحسين خانات التاريخ =====
// كروميوم يرسم تلميح التاريخ الفارغ (يوم/شهر/سنة) بأحرف معكوسة لا يتأثر بأي CSS،
// لذا يُخفى تلميحه عند عدم التركيز ويُعرض مكانه تلميح عربي سليم،
// ويظهر التلميح الداخلي طبيعيًا أثناء التركيز لتبقى الكتابة مرئية.
function enhanceDateInputs(root) {
  for (const inp of root.querySelectorAll('input[type="date"]')) {
    if (inp.dataset.dateEnhanced) continue;
    inp.dataset.dateEnhanced = '1';
    const parent = inp.parentElement;
    if (parent && parent.classList.contains('date-box')) continue;
    const wrap = document.createElement('span');
    wrap.className = 'date-box';
    parent.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const hint = document.createElement('span');
    hint.className = 'date-hint';
    hint.textContent = 'يوم/شهر/سنة';
    wrap.appendChild(hint);
    const upd = () => inp.classList.toggle('filled', !!inp.value);
    inp.addEventListener('input', upd);
    inp.addEventListener('change', upd);
    upd();
  }
}
enhanceDateInputs(document);
new MutationObserver(() => enhanceDateInputs(document)).observe(document.body, { childList: true, subtree: true });

const u = currentUser();
if (!u) location.href = 'index.html';

const roleLabel = {
  manager: 'مدير', clerk: 'إدخال عام', viewer: 'عرض فقط',
  warehouse: 'مخازن',
};
document.getElementById('current-user').textContent = `${u.full_name} (${roleLabel[u.role] || u.role})`;
document.getElementById('logout').onclick = () => { sessionStorage.clear(); location.href = 'index.html'; };

// ===== أيقونة التحقق من التحديثات =====
// الفحص اليدوي يفيد المستخدم أن يعرف حالته بلا انتظار الإقلاع التالي، ويُبيّن بوضوح
// أن النسخة التي تعمل من المصدر لا تفحص التحديثات إطلاقاً.
const updBtn = document.getElementById('check-update');
const updLabel = document.getElementById('update-label');

function setUpdState(r) {
  const pct = r && r.progress != null && r.state === 'downloading' ? ` ${r.progress}%` : '';
  const label = {
    available: 'يوجد تحديث', downloading: 'تنزيل' + pct, downloaded: 'جاهز للتثبيت',
    current: 'أحدث إصدار', dev: 'تحديثات', error: 'فشل الفحص', timeout: 'انقطع الفحص',
  }[r && r.state] || 'تحديثات';
  updLabel.textContent = label;
  updBtn.classList.toggle('updatable', !!r && (r.state === 'available' || r.state === 'downloaded'));
}

// electron-updater لا يعرض شريط تقدّم بنفسه، فيبدو التطبيق صامتًا دقائق بعد الموافقة.
// نراقب الحالة كل ثانيتين حتى يظهر «جاهز للتثبيت» فيعرف المستخدم أن التنزيل ماشي.
let watchTimer = null;
function watchDownload() {
  if (watchTimer) clearInterval(watchTimer);
  let ticks = 0;
  watchTimer = setInterval(async () => {
    if (++ticks > 900) { clearInterval(watchTimer); watchTimer = null; return; }
    try {
      const st = await window.api.invoke('app:status');
      const c = st.lastCheck;
      if (st.downloading || (c && c.state === 'downloading')) { setUpdState({ state: 'downloading', progress: c && c.progress }); return; }
      if (c && c.state === 'downloaded') { setUpdState(c); toast('اكتمل التنزيل — ستظهر نافذة إعادة التشغيل', 'ok'); }
      else if (c && c.state === 'available') { setUpdState(c); return; }
      else setUpdState(c || { state: 'current' });
      clearInterval(watchTimer); watchTimer = null;
    } catch {
      clearInterval(watchTimer); watchTimer = null;
    }
  }, 2000);
}

async function loadUpdateStatus() {
  try {
    const st = await window.api.invoke('app:status');
    updBtn.title = `الإصدار ${st.version}${st.packaged ? '' : ' — يعمل من المصدر: لا فحص تحديثات'}`;
    if (st.packaged && st.lastCheck) setUpdState(st.lastCheck);
  } catch { /* الشريط يعمل بلا معلومات إصدار */ }
}

updBtn.onclick = async () => {
  updBtn.disabled = true;
  updBtn.classList.add('busy');
  updLabel.textContent = 'فحص…';
  try {
    const r = await window.api.invoke('app:checkUpdate');
    setUpdState(r);
    if (r.state === 'available') { toast(`يوجد إصدار جديد: ${r.remote || ''} — اختر «تنزيل وتحديث» من النافذة`, 'ok'); watchDownload(); }
    else if (r.state === 'downloading') { toast(r.message || 'التنزيل جارٍ', ''); watchDownload(); }
    else if (r.state === 'downloaded') toast(`اكتمل تنزيل الإصدار ${r.remote || ''} — أعد التشغيل للتثبيت`, 'ok');
    else if (!r.ok) toast(r.message || 'تعذّر التحقق من التحديثات', 'err');
    else toast(r.message || 'أنت على أحدث إصدار', 'ok');
  } catch (e) {
    updLabel.textContent = 'تحديثات';
    toast(String(e.message || e), 'err');
  } finally {
    updBtn.classList.remove('busy');
    updBtn.disabled = false;
  }
};
loadUpdateStatus();

// الشاشات المتاحة لكل دور — null تعني كل الشاشات (المدير)
const ROLE_SCREENS = {
  manager: null,
  clerk: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'returns',
    'posting', 'salesreturns',
    'scrap', 'tolling', 'transfers', 'stock', 'reports'],
  viewer: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'returns',
    'posting', 'salesreturns',
    'scrap', 'tolling', 'transfers', 'stock', 'reports', 'audit'],
  warehouse: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'scrap', 'transfers', 'stock', 'returns',
    'posting', 'salesreturns',
    'reports'],
};
const allowed = (screen) => {
  const list = ROLE_SCREENS[u.role];
  if (!list) return true;
  return list.includes(screen);
};

document.querySelectorAll('.nav-item').forEach(a => {
  if (!allowed(a.dataset.screen)) a.remove();
  else a.onclick = () => go(a.dataset.screen);
});
// إخفاء عناوين المجموعات التي صارت فارغة بعد فلترة الأدوار
document.querySelectorAll('#nav .nav-group').forEach(g => {
  let next = g.nextElementSibling;
  let hasItem = false;
  while (next && !next.classList.contains('nav-group')) {
    if (next.classList.contains('nav-item')) { hasItem = true; break; }
    next = next.nextElementSibling;
  }
  if (!hasItem) g.remove();
});

initWM(document.getElementById('desktop'), document.getElementById('taskbar'));

// زر شرح عائم أسفل يسار الشاشة: يشرح الصفحة الرئيسية الثابتة الحالية
// (الشروحات تُعرض كنافذة منبثقة بأزرار تصغير/تكبير/إغلاق).
const pageHelp = document.createElement('button');
pageHelp.className = 'page-help';
pageHelp.title = 'شرح العملية';
pageHelp.textContent = '؟';
pageHelp.onclick = () => {
  const h = helpFor(currentScreen());
  explainDialog(h.title, h.lines);
};
document.body.appendChild(pageHelp);

import './screens/dashboard.js';
import './screens/guide.js';
import './screens/items.js';
import './screens/parties.js';
import './screens/warehouses.js';
import './screens/machines.js';
import './screens/shifts.js';
import './screens/purchases.js';
import './screens/issues.js';
import './screens/production.js';
import './screens/receives.js';
import './screens/cartons.js';
import './screens/returns.js';
import './screens/posting.js';
import './screens/salesreturns.js';
import './screens/scrap.js';
import './screens/tolling.js';
import './screens/transfers.js';
import './screens/stock.js';
import './screens/reports.js';
import './screens/audit.js';
import './screens/users.js';
import './screens/settings.js';
import './screens/backup.js';

try {
  const settings = await window.api.invoke('settings:get');
  setCurrency(settings.currency || 'YER');
} catch { /* الإعدادات الافتراضية */ }

go('dashboard');

document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.nav-item, .btn');
  if (!t) return;
  const rect = t.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = size + 'px';
  span.style.left = (e.clientX - rect.left - size / 2) + 'px';
  span.style.top = (e.clientY - rect.top - size / 2) + 'px';
  t.appendChild(span);
  setTimeout(() => span.remove(), 600);
});
