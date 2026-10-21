import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, openModal, esc } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

const TYPE_LABEL = { sale: 'بيع', scrap: 'خردة', blowing_fee: 'أجرة نفخ' };

register('sales', {
  title: 'فواتير البيع',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('sales:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ فاتورة بيع</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      el.querySelector('#summary').innerHTML =
        `عدد الفواتير: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — إجمالي النشطة: <b>${fmtMoney(active.reduce((a, r) => a + (Number(r.total) || 0), 0))}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'invoice_type', label: 'النوع', render: r => `<span class="tag ${r.invoice_type === 'blowing_fee' ? 'muharraz' : r.invoice_type === 'scrap' ? 'talef' : 'salem'}">${esc(TYPE_LABEL[r.invoice_type] || r.invoice_type)}</span>` },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'driver_name', label: 'السائق', render: r => r.driver_name || '—' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total', label: 'الإجمالي', render: r => fmtMoney(r.total) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغاة</span>' : '<span class="tag salem">نشطة</span>' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-print="${r.id}">طباعة</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>`,
        },
      ], rows);
      el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view(Number(b.dataset.view)));
      el.querySelectorAll('[data-print]').forEach(b => b.onclick = () => printDoc(Number(b.dataset.print)));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(Number(b.dataset.edit)));
      el.querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidDoc(Number(b.dataset.void)));
    }

    async function printDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        await api.invoke('print:open', { kind: 'invoice', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        openModal(`فاتورة ${TYPE_LABEL[doc.invoice_type]} ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>السائق:</b> ${esc(doc.driver_name || '—')} &nbsp; <b>السيارة:</b> ${esc(doc.car_number || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtMoney(it.unit_price)}</td>
            <td>${fmtMoney(it.total_price)}</td></tr>`).join('')}</tbody></table>
          <p style="margin-top:8px"><b>الإجمالي العام:</b> ${fmtMoney(doc.items.reduce((a, it) => a + (Number(it.total_price) || 0), 0))}</p>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'invoice', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        const ok = await implicationsDialog('تعديل فاتورة بيع', [
          'ستُعكس حركة المخزون وأثر السلات الحالي ويُعاد تطبيق الفاتورة بالقيم الجديدة.',
        ]);
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        if (!(await implicationsDialog('إلغاء فاتورة', [
          `سيُلغى أثر الفاتورة ${esc(doc.doc_number)} على المخزون والسلات وتُعاد الكميات.`,
        ]))) return;
        await api.invoke('sales:void', id, currentUser().id);
        toast('تم إلغاء الفاتورة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('sales:suggest');

      const back = openModal(doc ? `تعديل فاتورة ${esc(doc.doc_number)}` : 'فاتورة بيع جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
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
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>الرصيد</th><th>السعر</th><th>الإجمالي</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>الإجمالي العام</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('#irows .irow')].map(r => ({
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

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);
      const isService = () => back.querySelector('#f-type').value === 'blowing_fee';

      function updateTotal() {
        const total = [...rowsWrap.querySelectorAll('.irow')].reduce((s, r) => {
          const q = parseFloat(r.querySelector('.p-qty').value) || 0;
          const p = parseFloat(r.querySelector('.p-price').value) || 0;
          return s + q * p;
        }, 0);
        totalEl.textContent = fmtMoney(total);
      }

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td><select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select></td>
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="bal-text muted"></span></td>
          <td><input class="p-price num" type="number" min="0" step="any" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };

        const itemSel = row.querySelector('.p-item');
        const whSel = row.querySelector('.p-wh');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const balText = row.querySelector('.bal-text');
        const calc = row.querySelector('.p-calc');

        function refresh() {
          const item = itemById(Number(itemSel.value));
          if (!item) return;
          const cur = unitSel.value;
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
          update();
        }
        async function update() {
          const item = itemById(Number(itemSel.value));
          if (!item) return;
          if (!isService()) {
            balText.textContent = '…';
            try {
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
            } catch { balText.textContent = ''; }
          } else {
            balText.textContent = '';
            if (item.service_price && !price.value) price.value = item.service_price;
          }
          const pieces = toPieces(qty.value, unitSel.value, item);
          const kg = piecesToWeightKg(pieces || 0, item?.weight_grams || 0);
          const p = parseFloat(price.value) || 0;
          const q = parseFloat(qty.value) || 0;
          calc.textContent = `${pieces != null ? fmtNum(pieces, 0) + ' حبة' + (kg ? ' — ' + fmtNum(kg) + ' كجم' : '') : '—'}${p && q ? ' — ' + fmtMoney(p * q) : ''}`;
          updateTotal();
        }
        itemSel.onchange = refresh;
        whSel.onchange = update;
        unitSel.onchange = update;
        qty.oninput = update;
        price.oninput = update;
        row._refresh = update;
        if (data.item_id) itemSel.value = String(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

      back.querySelector('#f-type').onchange = () =>
        rowsWrap.querySelectorAll('.irow').forEach(r => r._refresh && r._refresh());
      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes });
        }
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
      updateTotal();
    }

    await load();
  }
});
