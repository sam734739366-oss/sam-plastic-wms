import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

const ROLE_LABEL = {
  manager: 'مدير', clerk: 'إدخال عام', viewer: 'عرض فقط',
  warehouse: 'مخازن', accounts: 'حسابات', sales: 'مبيعات',
};
const ROLE_TAG = {
  manager: 'salem', clerk: 'new', viewer: 'muharraz',
  warehouse: 'new', accounts: 'muharraz', sales: 'recycled',
};

register('users', {
  title: 'المستخدمون',
  async mount(el) {
    let rows = [];

    el.innerHTML = `
      <div class="toolbar">
        ${isManager() ? '<button class="btn primary" id="btn-add">+ إضافة مستخدم</button>' : ''}
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    const addBtn = el.querySelector('#btn-add');
    if (addBtn) addBtn.onclick = () => edit(null, refresh);

    function renderTableData() {
      const count = (role) => rows.filter(r => r.role === role).length;
      const parts = Object.keys(ROLE_LABEL).filter(r => count(r)).map(r => `${ROLE_LABEL[r]}: <b>${count(r)}</b>`);
      el.querySelector('#summary').innerHTML = `العدد: <b>${rows.length}</b> — ${parts.join(' — ') || 'لا يوجد مستخدمون'}`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'username', label: 'اسم المستخدم', render: r => `<span dir="ltr">${esc(r.username)}</span>` },
        { key: 'full_name', label: 'الاسم الكامل' },
        { key: 'role', label: 'الدور', render: r => `<span class="tag ${ROLE_TAG[r.role] || 'muharraz'}">${ROLE_LABEL[r.role] || r.role}</span>` },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-edit="${r.id}">تعديل</button>
            ${r.username !== 'admin' ? `<button class="btn mini danger" data-del="${r.id}">حذف</button>` : ''}`,
        },
      ], rows);

      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit)), refresh);
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = rows.find(x => x.id === Number(b.dataset.del));
          if (!r) return;
          if (await confirmDialog(`حذف المستخدم «${esc(r.username)}» نهائياً؟`)) {
            try {
              await api.invoke('users:delete', r.id, currentUser().id);
              toast('تم الحذف', 'ok');
              await refresh();
            } catch (e) {
              toast(String(e.message || e), 'err');
            }
          }
        };
      });
    }

    async function refresh() {
      rows = await api.invoke('users:list');
      renderTableData();
    }

    function edit(row, onSaved) {
      if (!isManager()) { toast('فقط المدير يمكنه إدارة المستخدمين', 'err'); return; }
      const back = openModal(row ? 'تعديل مستخدم' : 'إضافة مستخدم',
        `<div class="form-grid">
          <div class="field"><label>اسم المستخدم *</label><input id="f-username" value="${esc(row?.username || '')}" autofocus dir="ltr"></div>
          <div class="field"><label>الاسم الكامل *</label><input id="f-full" value="${esc(row?.full_name || '')}"></div>
          <div class="field"><label>كلمة المرور ${row ? '(اتركها فارغة بدون تغيير)' : '*'}</label><input id="f-pass" type="password" dir="ltr"></div>
          <div class="field"><label>الدور</label><select id="f-role">
            <option value="manager" ${row?.role === 'manager' ? 'selected' : ''}>مدير (صلاحية كاملة)</option>
            <option value="warehouse" ${row?.role === 'warehouse' ? 'selected' : ''}>مخازن (الأصناف والمخازن والشراء والإنتاج والتالف والنقل)</option>
            <option value="sales" ${row?.role === 'sales' ? 'selected' : ''}>مبيعات (البيع والمرتجعات والخروج والنفخ للغير)</option>
            <option value="accounts" ${row?.role === 'accounts' ? 'selected' : ''}>حسابات (القبض والدفع والكشوفات والتقارير)</option>
            <option value="clerk" ${row?.role === 'clerk' ? 'selected' : ''}>إدخال عام (كل المستندات)</option>
            <option value="viewer" ${row?.role === 'viewer' ? 'selected' : ''}>عرض فقط</option>
          </select></div>
        </div>`,
        [
          {
            label: 'حفظ', class: 'primary',
            onClick: async (b) => {
              try {
                await api.invoke('users:save', {
                  id: row ? row.id : null,
                  username: b.querySelector('#f-username').value,
                  full_name: b.querySelector('#f-full').value,
                  password: b.querySelector('#f-pass').value,
                  role: b.querySelector('#f-role').value,
                }, currentUser().id);
                b.remove();
                toast('تم الحفظ', 'ok');
                await onSaved();
              } catch (e) {
                toast(String(e.message || e), 'err');
              }
            },
          },
          { label: 'إلغاء', onClick: (b) => b.remove() },
        ]);
      if (row) back.dataset.editId = String(row.id);
    }

    await refresh();
  }
});
