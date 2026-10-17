import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

const TYPE_NAMES = { supplier: 'مورد', customer: 'عميل', both: 'كلاهما' };

register('parties', {
  title: 'الموردون والعملاء',
  async mount(el) {
    let currentType = '';

    async function load() {
      const rows = await api.invoke('parties:list', currentType || null);
      const filters = [
        { t: '', label: 'الكل' },
        { t: 'supplier', label: 'موردون' },
        { t: 'customer', label: 'عملاء' },
        { t: 'both', label: 'كلاهما' },
      ];
      el.innerHTML = `
        <div class="filters">${filters.map(f => `<button class="pill ${currentType === f.t ? 'active' : ''}" data-t="${f.t}">${esc(f.label)}</button>`).join('')}</div>
        <div class="toolbar">
          <button class="btn primary" id="btn-add">+ إضافة طرف</button>
        </div>
        <div id="table-wrap"></div>`;

      el.querySelectorAll('.pill').forEach(p => {
        p.onclick = () => { currentType = p.dataset.t; load(); };
      });
      el.querySelector('#btn-add').onclick = () => edit(null);

      renderTable(el.querySelector('#table-wrap'), [
        { key: 'name', label: 'الاسم' },
        { key: 'type', label: 'النوع', render: r => TYPE_NAMES[r.type] || r.type },
        { key: 'phone', label: 'الهاتف' },
        { key: 'address', label: 'العنوان' },
        { key: 'notes', label: 'ملاحظات' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-del="${r.id}">حذف</button>`,
        },
      ], rows);

      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit)));
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = rows.find(x => x.id === Number(b.dataset.del));
          if (!r) return;
          if (await confirmDialog(`حذف «${esc(r.name)}»؟`)) {
            try {
              await api.invoke('parties:delete', r.id, currentUser().id);
              toast('تم الحذف', 'ok');
              await load();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          }
        };
      });
    }

    function edit(row) {
      openModal(row ? 'تعديل طرف' : 'إضافة طرف',
        `<div class="form-grid">
          <div class="field"><label>الاسم *</label><input id="f-name" value="${esc(row ? row.name : '')}"></div>
          <div class="field"><label>النوع</label>
            <select id="f-type">
              <option value="supplier" ${row?.type === 'supplier' ? 'selected' : ''}>مورد</option>
              <option value="customer" ${row?.type === 'customer' ? 'selected' : ''}>عميل</option>
              <option value="both" ${row?.type === 'both' ? 'selected' : ''}>كلاهما</option>
            </select></div>
          <div class="field"><label>الهاتف</label><input id="f-phone" value="${esc(row?.phone || '')}"></div>
          <div class="field"><label>العنوان</label><input id="f-address" value="${esc(row?.address || '')}"></div>
          <div class="field full"><label>ملاحظات</label><textarea id="f-notes">${esc(row?.notes || '')}</textarea></div>
        </div>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (back) => {
          try {
            await api.invoke('parties:save', {
              id: row ? row.id : null,
              name: back.querySelector('#f-name').value,
              type: back.querySelector('#f-type').value,
              phone: back.querySelector('#f-phone').value,
              address: back.querySelector('#f-address').value,
              notes: back.querySelector('#f-notes').value,
            }, currentUser().id);
            back.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (back) => back.remove() }]);
    }

    await load();
  }
});
