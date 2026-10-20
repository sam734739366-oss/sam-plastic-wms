import { currentUser } from './api.js';
import { go } from './router.js';
import { setCurrency } from './fmt.js';

const u = currentUser();
if (!u) location.href = 'index.html';

const roleLabel = { manager: 'مدير', clerk: 'إدخال', viewer: 'عرض' };
document.getElementById('current-user').textContent = `${u.full_name} (${roleLabel[u.role] || u.role})`;
document.getElementById('logout').onclick = () => { sessionStorage.clear(); location.href = 'index.html'; };
document.querySelectorAll('.nav-item').forEach(a => a.onclick = () => go(a.dataset.screen));

import './screens/dashboard.js';
import './screens/items.js';
import './screens/parties.js';
import './screens/warehouses.js';
import './screens/machines.js';
import './screens/shifts.js';
import './screens/purchases.js';
import './screens/issues.js';
import './screens/production.js';
import './screens/receives.js';
import './screens/sales.js';
import './screens/exits.js';
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
