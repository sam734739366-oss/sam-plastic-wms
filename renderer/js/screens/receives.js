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

register('receives', {
  title: 'استلام الإنتاج التام',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('receives:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تصريح استلام</button></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم' },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'source', label: 'المصدر', render: r => r.source === 'customer' ? 'خام عميل' : 'إنتاج المصنع' },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'machine_name', label: 'المكينة', render: r => r.machine_name || '—' },
        { key: 'shift_name', label: 'الوردية', render: r => r.shift_name || '—' },
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
        const doc = await api.invoke('receives:get', id);
        openModal(`تصريح استلام ${esc(doc.doc_number)}`, `
          <p style="line-height:2">
            <b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المصدر:</b> ${doc.source === 'customer' ? 'خام عميل' : 'إنتاج المصنع'}
            ${doc.party_name ? `&nbsp; <b>العميل:</b> ${esc(doc.party_name)}` : ''}<br>
            <b>المكينة:</b> ${esc(doc.machine_name || '—')} &nbsp; <b>الوردية:</b> ${esc(doc.shift_name || '—')} &nbsp; <b>المستلم:</b> ${esc(doc.receiver_name || '—')}</p>
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
        const doc = await api.invoke('receives:get', id);
        const ok = await implicationsDialog('تعديل تصريح استلام', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق التصريح بالكميات الجديدة.',
        ]);
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('receives:get', id);
        if (!(await implicationsDialog('إلغاء تصريح استلام', [
          `سيُلغى أثر التصريح ${esc(doc.doc_number)} على المخزون (تُخصم الكميات المستلمة).`,
        ]))) return;
        await api.invoke('receives:void', id, currentUser().id);
        toast('تم إلغاء التصريح', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, machines, shifts, warehouses] = await Promise.all([
        api.invoke('items:list', 2),
        api.invoke('parties:list', null),
        api.invoke('machines:list'),
        api.invoke('shifts:list'),
        api.invoke('warehouses:list'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('receives:suggest');

      const back = openModal(doc ? `تعديل تصريح استلام ${esc(doc.doc_number)}` : 'تصريح استلام جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم التصريح *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المصدر</label>
            <select id="f-source">
              <option value="own" ${doc && doc.source === 'own' ? 'selected' : ''}>إنتاج المصنع</option>
              <option value="customer" ${doc && doc.source === 'customer' ? 'selected' : ''}>خام عميل</option>
            </select></div>
          <div class="field" id="w-party"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>المكينة</label>
            <select id="f-machine"><option value="">—</option>
              ${machines.map(m => `<option value="${m.id}" ${doc && doc.machine_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>الوردية</label>
            <select id="f-shift"><option value="">—</option>
              ${shifts.map(s => `<option value="${s.id}" ${doc && doc.shift_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>اسم المستلم</label><input id="f-receiver" value="${esc(doc ? doc.receiver_name || '' : '')}"></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف</span><span>المخزن</span><span>الكمية</span><span>الوحدة</span><span>التحويل الفوري</span><span>ملاحظات</span><span></span>
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
            await api.invoke('receives:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              source: b.querySelector('#f-source').value,
              party_id: b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null,
              machine_id: b.querySelector('#f-machine').value ? Number(b.querySelector('#f-machine').value) : null,
              shift_id: b.querySelector('#f-shift').value ? Number(b.querySelector('#f-shift').value) : null,
              receiver_name: b.querySelector('#f-receiver').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      back.querySelector('.modal').style.minWidth = '900px';

      const rowsWrap = back.querySelector('#irows');
      const itemById = (id) => items.find(i => i.id === id);
      const isCustomer = () => back.querySelector('#f-source').value === 'customer';
      const applySource = () => {
        back.querySelector('#w-party').style.display = isCustomer() ? '' : 'none';
      };
      back.querySelector('#f-source').onchange = applySource;

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}">
          <select class="p-unit"></select>
          <div class="p-bal"><span class="bal-text muted"></span></div>
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();

        const itemSel = row.querySelector('.p-item');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const balText = row.querySelector('.bal-text');

        function refreshUnits() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitsFor(item);
          unitSel.innerHTML = opts.map(u => `<option value="${u}">${UNIT_LABELS[u]}</option>`).join('');
          if (opts.includes(cur)) unitSel.value = cur;
          else if (data.unit && opts.includes(data.unit)) unitSel.value = data.unit;
        }

        function refresh() {
          refreshUnits();
          const item = itemById(Number(itemSel.value));
          const pieces = calcPieces(qty.value, unitSel.value, item);
          if (pieces > 0) {
            const kg = item.weight_grams ? Math.round(pieces * item.weight_grams / 10) / 100 : 0;
            balText.textContent = `${pieces.toLocaleString('en-US')} حبة${kg ? ' — ' + kg.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' كجم' : ''}`;
          } else {
            balText.textContent = '';
          }
        }

        itemSel.onchange = refresh;
        unitSel.onchange = refresh;
        qty.oninput = refresh;
        if (data.item_id) itemSel.value = String(data.item_id);
        if (data.warehouse_id) row.querySelector('.p-wh').value = String(data.warehouse_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, unit: it.unit, notes: it.notes });
        }
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
      applySource();
    }

    await load();
  }
});
