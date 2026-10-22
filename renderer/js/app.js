import { currentUser } from './api.js';
import { go, setOpener } from './router.js';
import { initWM, openWindow } from './wm.js';
import { setCurrency } from './fmt.js';
import { toast } from './ui.js';

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
  warehouse: 'مخازن', accounts: 'حسابات', sales: 'مبيعات',
};
document.getElementById('current-user').textContent = `${u.full_name} (${roleLabel[u.role] || u.role})`;
document.getElementById('logout').onclick = () => { sessionStorage.clear(); location.href = 'index.html'; };

// الشاشات المتاحة لكل دور — null تعني كل الشاشات (المدير)
const ROLE_SCREENS = {
  manager: null,
  clerk: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'sales', 'returns', 'exits',
    'scrap', 'tolling', 'transfers', 'payments', 'statements', 'stock', 'reports'],
  viewer: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'sales', 'returns', 'exits',
    'scrap', 'tolling', 'transfers', 'payments', 'statements', 'stock', 'reports', 'audit'],
  warehouse: ['dashboard', 'items', 'parties', 'warehouses', 'machines', 'shifts',
    'purchases', 'issues', 'production', 'receives', 'cartons', 'scrap', 'transfers', 'stock', 'returns', 'reports'],
  sales: ['dashboard', 'items', 'parties', 'sales', 'returns', 'exits', 'tolling', 'statements', 'reports'],
  accounts: ['dashboard', 'parties', 'payments', 'statements', 'reports', 'audit'],
};
const allowed = (screen) => {
  if (screen === 'guide') return true; // دليل المستخدم متاح لكل الأدوار
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
setOpener((name) => {
  if (!allowed(name)) { toast('هذه الشاشة غير متاحة لدورك الحالي', 'err'); return; }
  openWindow(name, { refresh: true });
});
window.addEventListener('wm:focus', (e) => {
  const name = e.detail.name;
  if (name && String(name).startsWith('pop:')) return;
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.screen === name));
});

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
import './screens/sales.js';
import './screens/returns.js';
import './screens/exits.js';
import './screens/scrap.js';
import './screens/tolling.js';
import './screens/transfers.js';
import './screens/payments.js';
import './screens/statements.js';
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
