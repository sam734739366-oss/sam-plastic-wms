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

register('transfers', {
  title: 'نقل بين المخازن',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('transfers:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ سند نقل</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'from_name', label: 'من مخزن' },
        { key: 'to_name', label: 'إلى مخزن' },
        { key: 'items_count', label: 'البنود' },
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
        const doc = await api.invoke('transfers:get', id);
        openModal(`سند نقل ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp;
            <b>من:</b> ${esc(doc.from_name)} &nbsp; <b>إلى:</b> ${esc(doc.to_name)}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td>
            <td>${esc(it.quantity)} ${esc(it.unit)}</td><td>${Number(it.pieces).toLocaleString('en-US')}</td>
            <td>${Number(it.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'transfer', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('transfers:get', id);
        if (!(await implicationsDialog('تعديل سند نقل', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق السند بالكميات الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('transfers:get', id);
        if (!(await implicationsDialog('إلغاء سند نقل', [
          `سيُلغى أثر السند ${esc(doc.doc_number)} وتُعاد الكميات لمخزن المصدر.`,
        ]))) return;
        await api.invoke('transfers:void', id, currentUser().id);
        toast('تم إلغاء السند', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, warehouses] = await Promise.all([
        api.invoke('items:list', null),
        api.invoke('warehouses:list'),
      ]);
      const goods = items.filter(i => i.item_group !== 4);
      const suggest = doc ? null : await api.invoke('transfers:suggest');

      const back = openModal(doc ? `تعديل سند نقل ${esc(doc.doc_number)}` : 'سند نقل جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>من مخزن *</label>
            <select id="f-from">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.from_warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>إلى مخزن *</label>
            <select id="f-to">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.to_warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف</span><span>الكمية</span><span>الوحدة</span><span>رصيد المصدر</span><span>ملاحظات</span><span></span>
        </div>
        <div id="irows"></div>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
            }));
            await api.invoke('transfers:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              from_warehouse_id: Number(b.querySelector('#f-from').value),
              to_warehouse_id: Number(b.querySelector('#f-to').value),
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '880px';

      const rowsWrap = back.querySelector('#irows');
      const itemById = (id) => goods.find(i => i.id === id);
      const fromWh = () => Number(back.querySelector('#f-from').value);

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${goods.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}">
          <select class="p-unit"></select>
          <div class="p-bal"><span class="bal-text muted"></span></div>
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();

        const itemSel = row.querySelector('.p-item');
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
            const bal = await api.invoke('stock:balance', item.id, fromWh());
            balText.textContent = `الرصيد: ${Number(bal.balance_pieces).toLocaleString('en-US')} حبة`;
          } catch { balText.textContent = ''; }
        }
        itemSel.onchange = refresh;
        unitSel.onchange = refresh;
        row._refresh = refresh;
        if (data.item_id) itemSel.value = String(data.item_id);
        refresh();
      }
      back.querySelector('#f-from').onchange = () =>
        rowsWrap.querySelectorAll('.irow').forEach(r => r._refresh && r._refresh());

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
