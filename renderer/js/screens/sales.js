import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, openModal, esc } from '../ui.js';

const UNIT_LABELS = { piece: 'حبة', carton: 'كرتون', bag: 'كيس', kg: 'كجم', ton: 'طن', bale: 'بالة' };
const TYPE_LABEL = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' };

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

function calcPieces(qty, unit, item) {
  const q = parseFloat(qty) || 0;
  switch (unit) {
    case 'piece': return Math.round(q);
    case 'carton': return Math.round(q * (item.pieces_per_carton || 0));
    case 'bag': return Math.round(q * (item.pieces_per_bag || 0));
    case 'kg': return item.weight_grams ? Math.round(q * 1000 / item.weight_grams) : 0;
    case 'ton': return item.weight_grams ? Math.round(q * 1000000 / item.weight_grams) : 0;
    case 'bale': return Math.round(q);
  }
  return 0;
}

register('sales', {
  title: 'فواتير البيع',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('sales:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ فاتورة بيع</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'invoice_type', label: 'النوع', render: r => TYPE_LABEL[r.invoice_type] || r.invoice_type },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'driver_name', label: 'السائق', render: r => r.driver_name || '—' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total', label: 'الإجمالي (ريال)', render: r => Number(r.total || 0).toLocaleString('en-US') },
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
        const doc = await api.invoke('sales:get', id);
        openModal(`فاتورة ${TYPE_LABEL[doc.invoice_type]} ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>السائق:</b> ${esc(doc.driver_name || '—')} &nbsp; <b>السيارة:</b> ${esc(doc.car_number || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${esc(it.quantity)} ${esc(it.unit)}</td><td>${Number(it.pieces).toLocaleString('en-US')}</td>
            <td>${Number(it.unit_price || 0).toLocaleString('en-US')}</td>
            <td>${Number(it.total_price || 0).toLocaleString('en-US')}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        const ok = await implicationsDialog('تعديل فاتورة بيع', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق الفاتورة بالكميات الجديدة.',
        ]);
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        if (!(await implicationsDialog('إلغاء فاتورة', [
          `سيُلغى أثر الفاتورة ${esc(doc.doc_number)} على المخزون وتُعاد الكميات للمخزن.`,
        ]))) return;
        await api.invoke('sales:void', id, currentUser().id);
        toast('تم إلغاء الفاتورة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [parties, warehouses] = await Promise.all([
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('sales:suggest');

      const back = openModal(doc ? `تعديل فاتورة ${esc(doc.doc_number)}` : 'فاتورة بيع جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>النوع *</label>
            <select id="f-type">
              <option value="sale" ${doc && doc.invoice_type === 'sale' ? 'selected' : ''}>بيع</option>
              <option value="scrap" ${doc && doc.invoice_type === 'scrap' ? 'selected' : ''}>خردة</option>
              <option value="blowing_fee" ${doc && doc.invoice_type === 'blowing_fee' ? 'selected' : ''}>أجرة نفخ</option>
            </select></div>
          <div class="field"><label>العميل</label>
            <select id="f-party"><option value="">— بدون —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>السائق</label><input id="f-driver" value="${esc(doc ? doc.driver_name || '' : '')}"></div>
          <div class="field"><label>رقم السيارة</label><input id="f-car" value="${esc(doc ? doc.car_number || '' : '')}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف</span><span>المخزن</span><span>الكمية</span><span>الوحدة</span><span>الرصيد</span><span>السعر</span><span>الإجمالي</span><span>ملاحظات</span><span></span>
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
              unit_price: parseFloat(r.querySelector('.p-price').value) || 0,
              notes: r.querySelector('.p-notes').value,
            }));
            await api.invoke('sales:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              invoice_type: b.querySelector('#f-type').value,
              party_id: b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null,
              driver_name: b.querySelector('#f-driver').value,
              car_number: b.querySelector('#f-car').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '980px';

      const rowsWrap = back.querySelector('#irows');
      const GROUP_FOR = { sale: 2, scrap: 5, blowing_fee: 4 };
      let items = [];
      const itemById = (id) => items.find(i => i.id === id);
      const isService = () => back.querySelector('#f-type').value === 'blowing_fee';
      const initialRows = (doc && doc.items.length)
        ? doc.items.map(it => ({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes }))
        : [{}];

      async function refreshAll() {
        items = await api.invoke('items:list', GROUP_FOR[back.querySelector('#f-type').value]);
        rowsWrap.innerHTML = '';
        for (const r of initialRows) addRow(r);
      }
      back.querySelector('#f-type').onchange = () => {
        initialRows.length = 0; initialRows.push({});
        refreshAll();
      };

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}">
          <select class="p-unit"></select>
          <div class="p-bal"><span class="bal-text muted"></span></div>
          <input class="p-price" type="number" min="0" step="any" value="${esc(data.unit_price ?? '')}">
          <span class="p-calc muted"></span>
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();

        const itemSel = row.querySelector('.p-item');
        const whSel = row.querySelector('.p-wh');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const balText = row.querySelector('.bal-text');
        const calc = row.querySelector('.p-calc');

        async function refresh() {
          const item = itemById(Number(itemSel.value));
          if (!item) return;
          const cur = unitSel.value;
          const opts = unitsFor(item);
          unitSel.innerHTML = opts.map(u => `<option value="${u}">${UNIT_LABELS[u]}</option>`).join('');
          if (opts.includes(cur)) unitSel.value = cur;
          else if (data.unit && opts.includes(data.unit)) unitSel.value = data.unit;
          if (!isService()) {
            balText.textContent = '…';
            try {
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              balText.textContent = `الرصيد: ${Number(bal.balance_pieces).toLocaleString('en-US')} حبة`;
            } catch { balText.textContent = ''; }
          } else {
            balText.textContent = '';
            if (item.service_price && !price.value) price.value = item.service_price;
          }
          const pieces = calcPieces(qty.value, unitSel.value, item);
          calc.textContent = pieces ? `${pieces.toLocaleString('en-US')} حبة` : '';
        }
        itemSel.onchange = refresh;
        whSel.onchange = refresh;
        unitSel.onchange = refresh;
        qty.oninput = refresh;
        if (data.item_id) itemSel.value = String(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

      await refreshAll();
      back.querySelector('#add-row').onclick = () => addRow({});
    }

    await load();
  }
});
