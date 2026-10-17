import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

register('shifts', {
  title: 'الورديات',
  async mount(el) {
    el.innerHTML = `<div class="card">
      <div class="page-head"><h2>الورديات</h2><button id="add" class="btn primary">إضافة وردية</button></div>
      <div id="tbl"></div></div>`;
    async function load() {
      const rows = await api.invoke('shifts:list');
      renderTable(document.getElementById('tbl'),
        [{ label: 'الاسم', key: 'name' }, { label: 'ملاحظات', key: 'notes' },
         { label: '', render: r => `<button class="btn small" data-edit="${r.id}">تعديل</button> <button class="btn small danger" data-del="${r.id}">حذف</button>` }],
        rows);
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(rows.find(r => r.id == b.dataset.edit)));
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => del(b.dataset.del));
    }
    function edit(row) {
      openModal(row ? 'تعديل وردية' : 'إضافة وردية',
        `<label class="field"><span>الاسم *</span><input id="f-name" value="${esc(row ? row.name : '')}"></label>
         <label class="field"><span>ملاحظات</span><textarea id="f-notes">${esc(row ? row.notes || '' : '')}</textarea></label>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (back) => {
          try {
            await api.invoke('shifts:save',
              { id: row ? row.id : null, name: back.querySelector('#f-name').value, notes: back.querySelector('#f-notes').value },
              currentUser().id);
            back.remove(); toast('تم الحفظ', 'ok'); load();
          } catch (e) { toast(e.message, 'err'); }
        } }, { label: 'إلغاء', onClick: (back) => back.remove() }]);
    }
    async function del(id) {
      if (!(await confirmDialog('حذف هذه الوردية نهائياً؟'))) return;
      try { await api.invoke('shifts:delete', id, currentUser().id); toast('تم الحذف', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
    el.querySelector('#add').onclick = () => edit(null);
    await load();
  }
});
