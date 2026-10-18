import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, openModal, esc } from '../ui.js';

const UNIT_LABELS = { piece: 'حبة', carton: 'كرتون', bag: 'كيس', kg: 'كجم', ton: 'طن', bale: 'بالة' };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function unitsFor(item) {
  const u = ['piece'];
  if (item.pieces_per_carton) u.push('carton');
  if (item.pieces_per_bag) u.push('bag');
  u.push('kg', 'ton', 'bale');
  return u;
}

register('exits', {
  title: 'تصاريح الخروج',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('exits:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تصريح خروج</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'warehouse_name', label: 'المخزن' },
        { key: 'driver_name', label: 'السائق' },
        { key: 'car_number', label: 'السيارة', render: r => r.car_number || '—' },
        { key: 'destination', label: 'جهة التسليم', render: r => r.destination || '—' },
        { key: 'total_pieces', label: 'الحبات', render: r => Number(r.total_pieces || 0).toLocaleString('en-US') },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : 'نشط' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>`,
        },
      ], rows);
      el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(Number(b.dataset.view)));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(Number(b.dataset.edit)));
      el.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDoc(Number(b.dataset.void)));
    }

    async function view(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        openModal(`تصريح خروج ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المخزن:</b> ${esc(doc.warehouse_name)}
            &nbsp; <b>السائق:</b> ${esc(doc.driver_name)} &nbsp; <b>السيارة:</b> ${esc(doc.car_number || '—')}<br>
            <b>جهة التسليم:</b> ${esc(doc.destination || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${esc(it.quantity)} ${esc(it.unit)}</td><td>${Number(it.pieces).toLocaleString('en-US')}</td>
            <td>${Number(it.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        if (!(await implicationsDialog('تعديل تصريح خروج', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق التصريح بالكميات الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        if (!(await implicationsDialog('إلغاء تصريح خروج', [
          `سيُلغى أثر التصريح ${esc(doc.doc_number)} وتُعاد الكميات للمخزن.`,
        ]))) return;
        await api.invoke('exits:void', id, currentUser().id);
        toast('تم إلغاء التصريح', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, warehouses] = await Promise.all([
        api.invoke('items:list', null),
        api.invoke('warehouses:list'),
      ]);
      const goods = items.filter(i => i.item_group !== 4);
      const suggest = doc ? null : await api.invoke('exits:suggest');

      const back = openModal(doc ? `تعديل تصريح خروج ${esc(doc.doc_number)}` : 'تصريح خروج جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم التصريح *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المخزن *</label>
            <select id="f-wh">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>اسم السائق *</label><input id="f-driver" value="${esc(doc ? doc.driver_name || '' : '')}"></div>
          <div class="field"><label>رقم السيارة</label><input id="f-car" value="${esc(doc ? doc.car_number || '' : '')}"></div>
          <div class="field"><label>جهة التسليم</label><input id="f-dest" value="${esc(doc ? doc.destination || '' : '')}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف</span><span>المخزن</span><span>الكمية</span><span>الوحدة</span><span>الرصيد</span><span>ملاحظات</span><span></span>
        </div>
        <div id="irows"></div>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              warehouse_id: Number(r.querySelector('.p-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
            }));
            await api.invoke('exits:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              warehouse_id: Number(b.querySelector('#f-wh').value),
              driver_name: b.querySelector('#f-driver').value,
              car_number: b.querySelector('#f-car').value,
              destination: b.querySelector('#f-dest').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '920px';

      const rowsWrap = back.querySelector('#irows');
      const itemById = (id) => goods.find(i => i.id === id);

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${goods.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}">
          <select class="p-unit"></select>
          <div class="p-bal"><span class="bal-text muted"></span></div>
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();

        const itemSel = row.querySelector('.p-item');
        const whSel = row.querySelector('.p-wh');
        const unitSel = row.querySelector('.p-unit');
        const balText = row.querySelector('.bal-text');

        async function refresh() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitsFor(item);
          unitSel.innerHTML = opts.map(u => `<option value="${u}">${UNIT_LABELS[u]}</option>`).join('');
          if (opts.includes(cur)) unitSel.value = cur;
          else if (data.unit && opts.includes(data.unit)) unitSel.value = data.unit;
          balText.textContent = '…';
          try {
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            balText.textContent = `الرصيد: ${Number(bal.balance_pieces).toLocaleString('en-US')} حبة`;
          } catch { balText.textContent = ''; }
        }
        itemSel.onchange = refresh;
        whSel.onchange = refresh;
        unitSel.onchange = refresh;
        if (data.item_id) itemSel.value = String(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) addRow(it);
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
    }

    await load();
  }
});
