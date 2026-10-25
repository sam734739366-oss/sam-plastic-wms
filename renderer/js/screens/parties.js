import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, attachRowMenu, openModal, esc } from '../ui.js';

const TYPE_NAMES = { supplier: 'مورد', customer: 'عميل', both: 'كلاهما' };
const TYPE_TAG = { supplier: 'salem', customer: 'new', both: 'muharraz' };

register('parties', {
  title: 'الموردون والعملاء',
  async mount(el) {
    let rows = [];
    let currentType = '';

    el.innerHTML = `
      <div class="filters" id="filters"></div>
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة طرف</button>
        <span class="spacer"></span>
        <button class="btn" id="btn-print">طباعة القائمة</button>
        <input id="f-search" placeholder="بحث بالاسم أو الهاتف…" style="width:230px">
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    const filters = [
      { t: '', label: 'الكل' },
      { t: 'supplier', label: 'موردون' },
      { t: 'customer', label: 'عملاء' },
      { t: 'both', label: 'كلاهما' },
    ];
    el.querySelector('#filters').innerHTML = filters.map(f =>
      `<button class="pill ${currentType === f.t ? 'active' : ''}" data-t="${f.t}">${esc(f.label)}</button>`).join('');
    el.querySelectorAll('.pill').forEach(p => {
      p.onclick = async () => {
        currentType = p.dataset.t;
        el.querySelectorAll('.pill').forEach(x => x.classList.toggle('active', x === p));
        await refresh();
      };
    });
    el.querySelector('#btn-add').onclick = () => edit(null, refresh);
    el.querySelector('#f-search').addEventListener('input', renderTableData);
    el.querySelector('#btn-print').onclick = async () => {
      const q = (el.querySelector('#f-search')?.value || '').trim();
      const filtered = q
        ? rows.filter(r => (r.name || '').includes(q) || (r.phone || '').includes(q))
        : rows;
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: 'قائمة الموردين والعملاء',
          metaLines: ['عدد الأطراف: ' + filtered.length, 'تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: ['الاسم', 'النوع', 'الهاتف', 'العنوان', 'ملاحظات'],
          rows: filtered.map(r => [esc(r.name), esc(TYPE_NAMES[r.type] || r.type), r.phone ? esc(r.phone) : '—', esc(r.address || '—'), esc(r.notes || '—')]),
          foot: '',
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    function renderTableData() {
      const q = (el.querySelector('#f-search')?.value || '').trim();
      const filtered = q
        ? rows.filter(r => (r.name || '').includes(q) || (r.phone || '').includes(q))
        : rows;
      const sup = filtered.filter(r => r.type === 'supplier' || r.type === 'both').length;
      const cus = filtered.filter(r => r.type === 'customer' || r.type === 'both').length;
      el.querySelector('#summary').innerHTML =
        `العدد: <b>${filtered.length}</b> — موردون: <b>${sup}</b> — عملاء: <b>${cus}</b>`;

      renderTable(el.querySelector('#table-wrap'), [
        { key: 'name', label: 'الاسم' },
        { key: 'type', label: 'النوع', render: r => `<span class="tag ${TYPE_TAG[r.type] || 'muharraz'}">${TYPE_NAMES[r.type] || r.type}</span>` },
        { key: 'phone', label: 'الهاتف', render: r => r.phone ? `<span dir="ltr">${esc(r.phone)}</span>` : '—' },
        { key: 'address', label: 'العنوان', render: r => r.address || '—' },
        { key: 'notes', label: 'ملاحظات', render: r => r.notes || '—' },
      ], filtered);

      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = filtered[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, refresh) },
          { label: 'حذف', danger: true, onClick: async () => {
            if (!(await confirmDialog(`حذف الطرف «${esc(r.name)}»؟`))) return;
            try {
              await api.invoke('parties:delete', r.id, currentUser().id);
              toast('تم الحذف', 'ok');
              await refresh();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          } },
        ];
      });
    }

    async function refresh() {
      rows = await api.invoke('parties:list', currentType || null);
      renderTableData();
    }

    function view(row) {
      openModal(`عرض طرف ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>النوع</label><span class="tag ${TYPE_TAG[row.type] || 'muharraz'}">${TYPE_NAMES[row.type] || row.type}</span></div>
          <div class="field"><label>الهاتف</label><span class="muted" dir="ltr">${esc(row.phone || '—')}</span></div>
          <div class="field full"><label>العنوان</label><span class="muted">${esc(row.address || '—')}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }

    function edit(row, onSaved) {
      const back = openModal(row ? 'تعديل طرف' : 'إضافة طرف',
        `<div class="form-grid">
          <div class="field"><label>الاسم *</label><input id="f-name" value="${esc(row?.name || '')}" autofocus></div>
          <div class="field"><label>النوع</label>
            <select id="f-type">
              <option value="supplier" ${row?.type === 'supplier' ? 'selected' : ''}>مورد</option>
              <option value="customer" ${row?.type === 'customer' ? 'selected' : ''}>عميل</option>
              <option value="both" ${row?.type === 'both' ? 'selected' : ''}>كلاهما</option>
            </select></div>
          <div class="field"><label>الهاتف</label><input id="f-phone" value="${esc(row?.phone || '')}" dir="ltr"></div>
          <div class="field"><label>العنوان</label><input id="f-address" value="${esc(row?.address || '')}"></div>
          <div class="field full"><label>ملاحظات</label><textarea id="f-notes" rows="2">${esc(row?.notes || '')}</textarea></div>
        </div>`,
        [
          {
            label: 'حفظ', class: 'primary',
            onClick: async (b) => {
              try {
                await api.invoke('parties:save', {
                  id: row ? row.id : null,
                  name: b.querySelector('#f-name').value,
                  type: b.querySelector('#f-type').value,
                  phone: b.querySelector('#f-phone').value,
                  address: b.querySelector('#f-address').value,
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
