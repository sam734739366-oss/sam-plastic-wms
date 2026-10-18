import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, implicationsDialog, renderTable, openModal, esc } from '../ui.js';

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

function calcKg(pieces, item) {
  return item.weight_grams ? pieces * item.weight_grams / 1000 : 0;
}

register('purchases', {
  title: 'فواتير الشراء',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('purchases:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ فاتورة شراء</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'المورد', render: r => r.party_name || '—' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total', label: 'الإجمالي (ريال)', render: r => Number(r.total || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغاة</span>' : 'نشطة' },
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
        const doc = await api.invoke('purchases:get', id);
        openModal(`فاتورة شراء ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المورد:</b> ${esc(doc.party_name || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${esc(it.quantity)} ${esc(it.unit)}</td><td>${esc(it.pieces)}</td><td>${esc(it.weight_kg)}</td>
            <td>${esc(it.unit_price ?? '')}</td><td>${esc(it.total_price ?? '')}</td></tr>`).join('')}</tbody></table>
          ${doc.cartons.length ? `<p style="margin-top:10px"><b>الكراتين:</b> ${doc.cartons.map(c => `<span class="tag new">${esc(c.carton_number)}</span>`).join(' ')}</p>` : ''}
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'purchase', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('purchases:get', id);
        const issued = doc.cartons.filter(c => c.status !== 'in_stock');
        if (issued.length) {
          toast('لا يمكن تعديل الفاتورة — كراتين صُرفت للإنتاج، ألغِ تصريح الصرف أولاً', 'err');
          return;
        }
        if (doc.cartons.length) {
          const ok = await implicationsDialog('تعديل فاتورة لها كراتين', [
            'سيتم حذف الكراتين التالية وإعادة إنشائها بنفس البادئة:',
            doc.cartons.map(c => c.carton_number).join(' ، '),
          ]);
          if (!ok) return;
        }
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('purchases:get', id);
        if (doc.cartons.some(c => c.status !== 'in_stock')) {
          toast('لا يمكن إلغاء الفاتورة — كراتين صُرفت للإنتاج، ألغِ تصريح الصرف أولاً', 'err');
          return;
        }
        const lines = ['سيُلغى أثر الفاتورة على المخزون نهائياً.'];
        if (doc.cartons.length) lines.push(`ستُحذف الكراتين: ${doc.cartons.map(c => c.carton_number).join(' ، ')}`);
        if (!(await implicationsDialog('إلغاء فاتورة شراء', lines))) return;
        await api.invoke('purchases:void', id, currentUser().id);
        toast('تم إلغاء الفاتورة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, warehouses] = await Promise.all([
        api.invoke('items:list', 1),
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      const suppliers = parties.filter(p => p.type === 'supplier' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('purchases:suggest');

      const back = openModal(doc ? `تعديل فاتورة شراء ${esc(doc.doc_number)}` : 'فاتورة شراء جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المورد</label>
            <select id="f-party"><option value="">— بدون مورد —</option>
              ${suppliers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف</span><span>المخزن</span><span>الكمية</span><span>الوحدة</span><span>الحبات / الوزن</span>
          <span>سعر الوحدة</span><span>الإجمالي</span><span>ملاحظات</span><span></span>
        </div>
        <div id="prows"></div>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.prow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              warehouse_id: Number(r.querySelector('.p-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              unit_price: parseFloat(r.querySelector('.p-price').value) || null,
              notes: r.querySelector('.p-notes').value,
              carton_prefix: r.querySelector('.p-prefix') ? r.querySelector('.p-prefix').value : '',
            }));
            await api.invoke('purchases:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              party_id: b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '980px';

      const rowsWrap = back.querySelector('#prows');
      const itemById = (id) => items.find(i => i.id === id);

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'prow';
        row.innerHTML = `
          <select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}">
          <select class="p-unit"></select>
          <span class="p-calc muted"></span>
          <input class="p-price" type="number" min="0" step="any" value="${esc(data.unit_price ?? '')}">
          <span class="p-total muted"></span>
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <div class="p-prefix-wrap"><input class="p-prefix" placeholder="بادئة مثل K-" value="${esc(data.carton_prefix || '')}"></div>
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();

        const itemSel = row.querySelector('.p-item');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const calc = row.querySelector('.p-calc');
        const total = row.querySelector('.p-total');
        const prefixWrap = row.querySelector('.p-prefix-wrap');

        function refresh() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitsFor(item);
          unitSel.innerHTML = opts.map(u => `<option value="${u}">${UNIT_LABELS[u]}</option>`).join('');
          if (opts.includes(cur)) unitSel.value = cur;
          else if (data.unit && opts.includes(data.unit)) unitSel.value = data.unit;
          update();
        }
        function update() {
          const item = itemById(Number(itemSel.value));
          const pieces = calcPieces(qty.value, unitSel.value, item);
          const kg = calcKg(pieces, item);
          calc.textContent = pieces ? `${pieces.toLocaleString('en-US')} حبة${kg ? ' — ' + kg.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' كجم' : ''}` : '';
          const p = parseFloat(price.value) || 0;
          const q = parseFloat(qty.value) || 0;
          total.textContent = p && q ? (p * q).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
          prefixWrap.style.display = unitSel.value === 'carton' ? '' : 'none';
        }
        itemSel.onchange = refresh;
        unitSel.onchange = update;
        qty.oninput = update;
        price.oninput = update;
        if (data.item_id) itemSel.value = String(data.item_id);
        if (data.warehouse_id) row.querySelector('.p-wh').value = String(data.warehouse_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({
            item_id: it.item_id, warehouse_id: it.warehouse_id,
            quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes,
            carton_prefix: doc.cartons.length ? (doc.cartons[0].carton_number.match(/^\D*/) || [''])[0] : '',
          });
        }
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
    }

    await load();
  }
});
