import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, attachRowMenu, openModal, esc } from '../ui.js';

register('shifts', {
  title: 'الورديات',
  async mount(el) {
    let rows = [];

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة وردية</button>
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    el.querySelector('#btn-add').onclick = () => edit(null, refresh);

    function renderTableData() {
      el.querySelector('#summary').innerHTML = `عدد الورديات: <b>${rows.length}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'name', label: 'الاسم' },
        { key: 'notes', label: 'ملاحظات', render: r => r.notes || '—' },
      ], rows);

      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = rows[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, refresh) },
          { label: 'حذف', danger: true, onClick: async () => {
            if (!(await confirmDialog(`حذف الوردية «${esc(r.name)}»؟`))) return;
            try {
              await api.invoke('shifts:delete', r.id, currentUser().id);
              toast('تم الحذف', 'ok');
              await refresh();
            } catch (e) {
              toast(String(e.message || e), 'err');
            }
          } },
        ];
      });
    }

    async function refresh() {
      rows = await api.invoke('shifts:list');
      renderTableData();
    }

    function view(row) {
      openModal(`عرض وردية ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field full"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }

    function edit(row, onSaved) {
      const back = openModal(row ? 'تعديل وردية' : 'إضافة وردية',
        `<div class="form-grid">
          <div class="field full"><label>الاسم *</label><input id="f-name" value="${esc(row?.name || '')}" autofocus></div>
          <div class="field full"><label>ملاحظات</label><textarea id="f-notes" rows="2">${esc(row?.notes || '')}</textarea></div>
        </div>`,
        [
          {
            label: 'حفظ', class: 'primary',
            onClick: async (b) => {
              try {
                await api.invoke('shifts:save', {
                  id: row ? row.id : null,
                  name: b.querySelector('#f-name').value,
                  notes: b.querySelector('#f-notes').value,
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
