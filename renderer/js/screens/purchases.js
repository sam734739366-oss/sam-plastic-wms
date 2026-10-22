import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, implicationsDialog, renderTable, openModal, esc , itemCombo} from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

register('purchases', {
  title: 'فواتير الشراء',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('purchases:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ فاتورة شراء</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      el.querySelector('#summary').innerHTML =
        `عدد الفواتير: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — إجمالي النشطة: <b>${fmtMoney(active.reduce((a, r) => a + (Number(r.total) || 0), 0))}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'المورد', render: r => r.party_name || '—' },
        { key: 'payment_method', label: 'الدفع', render: r => r.payment_method === 'cash' ? '<span class="tag muharraz">نقدي</span>' : '<span class="tag">آجل</span>' },
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
        const doc = await api.invoke('purchases:get', id);
        await api.invoke('print:open', { kind: 'purchase', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('purchases:get', id);
        openModal(`فاتورة شراء ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المورد:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>طريقة الدفع:</b> ${doc.payment_method === 'cash' ? 'نقدي' : 'آجل'}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td><td>${fmtNum(it.weight_kg)}</td>
            <td>${it.unit_price != null ? fmtMoney(it.unit_price) : '—'}</td><td>${it.total_price != null ? fmtMoney(it.total_price) : '—'}</td></tr>`).join('')}</tbody></table>
          ${doc.items.length ? `<p style="margin-top:8px"><b>الإجمالي العام:</b> ${fmtMoney(doc.items.reduce((a, it) => a + (Number(it.total_price) || 0), 0))}</p>` : ''}
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
        const lines = ['سيُلغى أثر الفاتورة على المخزون وأرصدة سليم نهائياً.', 'وسيُعكس أثرها المحاسبي: تُشطب ذمة المورد أو الدفع النقدي المسجل لها.'];
        if (doc.cartons.length) lines.push(`ستُحذف الكراتين: ${doc.cartons.map(c => c.carton_number).join(' ، ')}`);
        if (!(await implicationsDialog('إلغاء فاتورة شراء', lines))) return;
        await api.invoke('purchases:void', id, currentUser().id);
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
      const suppliers = parties.filter(p => p.type === 'supplier' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('purchases:suggest');

      const back = openModal(doc ? `تعديل فاتورة شراء ${esc(doc.doc_number)}` : 'فاتورة شراء جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المورد</label>
            <select id="f-party"><option value="">— بدون مورد —</option>
              ${suppliers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>طريقة الدفع *</label>
            <select id="f-pay">
              <option value="credit" ${doc && doc.payment_method !== 'cash' ? 'selected' : ''}>آجل (يُسجل ذمة على المصنع للمورد)</option>
              <option value="cash" ${doc && doc.payment_method === 'cash' ? 'selected' : ''}>نقدي (يُدفع فوراً من النقدية)</option>
            </select></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>الحبات / الوزن</th>
            <th>سعر الوحدة</th><th>الإجمالي</th><th>ملاحظات</th><th>بادئة الكراتين</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>الإجمالي العام</b></td>
            <td id="f-total">0</td><td colspan="3"></td>
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
              unit_price: parseFloat(r.querySelector('.p-price').value) || null,
              notes: r.querySelector('.p-notes').value,
              carton_prefix: r.querySelector('.p-prefix') ? r.querySelector('.p-prefix').value : '',
            })).filter(x => x.item_id);
            await api.invoke('purchases:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              party_id: b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null,
              payment_method: b.querySelector('#f-pay').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);

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
          <td class="p-item-td"></td>
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-price num" type="number" min="0" step="any" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-total muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td><input class="p-prefix" placeholder="مثل K-" value="${esc(data.carton_prefix || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        const combo = itemCombo(items, () => row.querySelector('.p-item').dispatchEvent(new Event('change')));
        row.querySelector('.p-item-td').appendChild(combo.box);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };

        const itemSel = row.querySelector('.p-item');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const calc = row.querySelector('.p-calc');
        const total = row.querySelector('.p-total');
        const prefix = row.querySelector('.p-prefix');

        function refresh() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
          update();
        }
        function update() {
          const item = itemById(Number(itemSel.value));
          const pieces = toPieces(qty.value, unitSel.value, item);
          const kg = piecesToWeightKg(pieces || 0, item?.weight_grams || 0);
          calc.textContent = pieces != null
            ? `${fmtNum(pieces, 0)} حبة${kg ? ' — ' + fmtNum(kg) + ' كجم' : ''}`
            : '—';
          const p = parseFloat(price.value) || 0;
          const q = parseFloat(qty.value) || 0;
          total.textContent = p && q ? fmtMoney(p * q) : '';
          prefix.disabled = unitSel.value !== 'كرتون';
          updateTotal();
        }
        itemSel.onchange = refresh;
        unitSel.onchange = update;
        qty.oninput = update;
        price.oninput = update;
        if (data.item_id) combo.setValue(data.item_id);
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
      updateTotal();
    }

    await load();
  }
});
