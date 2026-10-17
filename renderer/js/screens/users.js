import { register } from '../router.js';
import { api, currentUser, isManager } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

const roleLabel = { manager: 'مدير', clerk: 'إدخال', viewer: 'عرض' };

register('users', {
  title: 'المستخدمون',
  async mount(el) {
    el.innerHTML = `<div class="card">
      <div class="page-head"><h2>المستخدمون</h2><button id="add" class="btn primary">إضافة مستخدم</button></div>
      <div id="tbl"></div></div>`;
    async function load() {
      const rows = await api.invoke('users:list');
      renderTable(document.getElementById('tbl'),
        [{ label: 'اسم المستخدم', key: 'username' }, { label: 'الاسم الكامل', key: 'full_name' },
         { label: 'الدور', render: r => roleLabel[r.role] || r.role },
         { label: '', render: r => `<button class="btn small" data-edit="${r.id}">تعديل</button> ${r.username !== 'admin' ? `<button class="btn small danger" data-del="${r.id}">حذف</button>` : ''}` }],
        rows);
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(rows.find(r => r.id == b.dataset.edit)));
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => del(b.dataset.del));
    }
    function edit(row) {
      if (!isManager()) { toast('فقط المدير يمكنه إدارة المستخدمين', 'err'); return; }
      openModal(row ? 'تعديل مستخدم' : 'إضافة مستخدم',
        `<label class="field"><span>اسم المستخدم *</span><input id="f-username" value="${esc(row ? row.username : '')}"></label>
         <label class="field"><span>الاسم الكامل *</span><input id="f-full" value="${esc(row ? row.full_name : '')}"></label>
         <label class="field"><span>كلمة المرور ${row ? '(اتركها فارغة بدون تغيير)' : '*'}</span><input id="f-pass" type="password"></label>
         <label class="field"><span>الدور</span><select id="f-role">
           <option value="manager" ${row && row.role === 'manager' ? 'selected' : ''}>مدير (صلاحية كاملة)</option>
           <option value="clerk" ${row && row.role === 'clerk' ? 'selected' : ''}>إدخال (بدون حذف)</option>
           <option value="viewer" ${row && row.role === 'viewer' ? 'selected' : ''}>عرض فقط</option>
         </select></label>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (back) => {
          try {
            await api.invoke('users:save',
              { id: row ? row.id : null, username: back.querySelector('#f-username').value,
                full_name: back.querySelector('#f-full').value,
                password: back.querySelector('#f-pass').value,
                role: back.querySelector('#f-role').value },
              currentUser().id);
            back.remove(); toast('تم الحفظ', 'ok'); load();
          } catch (e) { toast(e.message, 'err'); }
        } }, { label: 'إلغاء', onClick: (back) => back.remove() }]);
    }
    async function del(id) {
      if (!(await confirmDialog('حذف هذا المستخدم نهائياً؟'))) return;
      try { await api.invoke('users:delete', id, currentUser().id); toast('تم الحذف', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    el.querySelector('#add').onclick = () => edit(null);
    await load();
  }
});
