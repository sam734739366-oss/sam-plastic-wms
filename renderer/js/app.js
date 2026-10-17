import { currentUser } from './api.js';
import { go } from './router.js';

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

go('dashboard');
