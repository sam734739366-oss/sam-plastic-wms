import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

register('warehouses', {
  title: 'المخازن',
  async mount(el) {
    let rows = [];

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة مخزن</button>
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    el.querySelector('#btn-add').onclick = () => edit(null, refresh);

    function renderTableData() {
      el.querySelector('#summary').innerHTML =
        `عدد المخازن: <b>${rows.length}</b> — داخل المصنع: <b>${rows.filter(r => r.location === 'داخل المصنع').length}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'name', label: 'الاسم' },
        { key: 'location', label: 'الموقع', render: r => `<span class="tag ${r.location === 'داخل المصنع' ? 'salem' : 'new'}">${esc(r.location || '—')}</span>` },
        { key: 'notes', label: 'ملاحظات', render: r => r.notes || '—' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-del="${r.id}">حذف</button>`,
        },
      ], rows);

      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit)), refresh);
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = rows.find(x => x.id === Number(b.dataset.del));
          if (!r) return;
          if (await confirmDialog(`حذف المخزن «${esc(r.name)}»؟`)) {
            try {
              await api.invoke('warehouses:delete', r.id, currentUser().id);
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
      rows = await api.invoke('warehouses:list');
      renderTableData();
    }

    function edit(row, onSaved) {
      const back = openModal(row ? 'تعديل مخزن' : 'إضافة مخزن',
        `<div class="form-grid">
          <div class="field"><label>الاسم *</label><input id="f-name" value="${esc(row?.name || '')}" autofocus></div>
          <div class="field"><label>الموقع</label><select id="f-loc">
            <option value="داخل المصنع" ${row?.location === 'داخل المصنع' ? 'selected' : ''}>داخل المصنع</option>
            <option value="خارج المصنع" ${row?.location === 'خارج المصنع' ? 'selected' : ''}>خارج المصنع</option>
          </select></div>
          <div class="field full"><label>ملاحظات</label><textarea id="f-notes" rows="2">${esc(row?.notes || '')}</textarea></div>
        </div>`,
        [
          {
            label: 'حفظ', class: 'primary',
            onClick: async (b) => {
              try {
                await api.invoke('warehouses:save', {
                  id: row ? row.id : null,
                  name: b.querySelector('#f-name').value,
                  location: b.querySelector('#f-loc').value,
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
