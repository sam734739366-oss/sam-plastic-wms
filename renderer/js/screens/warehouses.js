import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, attachRowMenu, openModal, esc } from '../ui.js';

register('warehouses', {
  title: 'المخازن',
  async mount(el) {
    let rows = [];

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة مخزن</button>
        <span class="spacer"></span>
        <button class="btn" id="btn-print">طباعة القائمة</button>
      </div>
      <div id="help" class="summary-line" style="line-height:2">
        <b>كيف تعمل المخازن؟</b> البرنامج يعمل بمخزن واحد افتراضي «المخزن الرئيسي» تُسجَّل فيه كل الكميات
        (المشتريات، الإنتاج، الأرصدة الافتتاحية) وتخرج منه (الصرف، البيع، الخروج).
        أضف مخازن إضافية فقط إذا أردت فصل مواقع تخزين حقيقية، ثم استخدم «نقل بين المخازن» لتحريك الكميات بينها.
        حذف المخزن غير ممكن إلا إذا لم تكن له أي حركات.
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    el.querySelector('#btn-add').onclick = () => edit(null, refresh);
    el.querySelector('#btn-print').onclick = async () => {
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: 'قائمة المخازن',
          metaLines: ['عدد المخازن: ' + rows.length, 'تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: ['الاسم', 'الموقع', 'ملاحظات'],
          rows: rows.map(r => [esc(r.name), esc(r.location || '—'), esc(r.notes || '—')]),
          foot: '',
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    function renderTableData() {
      el.querySelector('#summary').innerHTML =
        `عدد المخازن: <b>${rows.length}</b> — داخل المصنع: <b>${rows.filter(r => r.location === 'داخل المصنع').length}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'name', label: 'الاسم' },
        { key: 'location', label: 'الموقع', render: r => `<span class="tag ${r.location === 'داخل المصنع' ? 'salem' : 'new'}">${esc(r.location || '—')}</span>` },
        { key: 'notes', label: 'ملاحظات', render: r => r.notes || '—' },
      ], rows);

      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = rows[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, refresh) },
          { label: 'حذف', danger: true, onClick: async () => {
            if (!(await confirmDialog(`حذف المخزن «${esc(r.name)}»؟`))) return;
            try {
              await api.invoke('warehouses:delete', r.id, currentUser().id);
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
      rows = await api.invoke('warehouses:list');
      renderTableData();
    }

    function view(row) {
      openModal(`عرض مخزن ${esc(row.name)}`, `
        <div class="form-grid">
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>الموقع</label><span class="muted">${esc(row.location || '—')}</span></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
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
