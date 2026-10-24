import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, esc, renderTable, attachRowMenu, openModal, implicationsDialog, itemCombo } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

// ===== ترحيل الفواتير الخارجة =====
// الفاتورة تصدر من نظام المبيعات الخارجي، وهنا يُدخل رقمها يدوياً واسم العميل
// وبيانات الأصناف والكميات التي تؤثر على المخازن. السعر اختياري:
// بلا أسعار = خصم مخزني فقط، وبأسعار = إجمالي يُسجل على ذمة العميل.

register('posting', {
  title: 'ترحيل الفواتير',
  async mount(el) {
    async function load() {
      const rows = (await api.invoke('sales:list')).filter(r => r.invoice_type === 'sale');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ ترحيل فاتورة</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      const pieces = active.reduce((s, r) => s + (Number(r.total_pieces) || 0), 0);
      const money = active.reduce((s, r) => s + (Number(r.total) || 0), 0);
      el.querySelector('#summary').innerHTML =
        `عدد الفواتير: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — الحبات المرحلة: <b>${fmtNum(pieces, 0)} حبة</b>${money ? ` — الإجمالي: <b>${fmtMoney(money)}</b>` : ''}`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
        { key: 'total', label: 'الإجمالي', render: r => fmtMoney(r.total) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغاة</span>' : '<span class="tag salem">نشطة</span>' },
      ], rows);
      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = rows[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r.id) },
          { label: 'طباعة', onClick: () => printDoc(r.id) },
          { label: 'تعديل', onClick: () => edit(r.id) },
          { label: 'إلغاء', danger: true, onClick: () => voidDoc(r.id) },
        ];
      });
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
        openModal(`فاتورة ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>طريقة الدفع:</b> ${doc.payment_method === 'cash' ? 'نقدي' : 'آجل'}</p>
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
        if (!(await implicationsDialog('تعديل فاتورة', [
          'ستُعكس حركة المخزون وأثر السلات الحالي ويُعاد تطبيق الفاتورة بالقيم الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('sales:get', id);
        if (!(await implicationsDialog('إلغاء فاتورة', [
          `سيُلغى أثر الفاتورة ${esc(doc.doc_number)} على المخزون والسلات وتُعاد الكميات.`,
          'إن كانت بأسعار فسيُشطب أثرها المحاسبي أيضاً.',
        ]))) return;
        await api.invoke('sales:void', id, currentUser().id);
        toast('تم إلغاء الفاتورة', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // حقل عميل ببحث ذكي + زر إضافة سريعة دون مغادرة النموذج
    function partyField(parties, selectedId) {
      const field = document.createElement('div');
      field.className = 'party-combo';
      field.innerHTML = `
        <input type="text" class="ic-input" placeholder="ابحث باسم العميل…" autocomplete="off">
        <input type="hidden" class="p-party">
        <div class="ic-list" style="display:none"></div>
        <button type="button" class="btn mini" id="party-add">+ عميل جديد</button>`;
      const input = field.querySelector('.ic-input');
      const valueEl = field.querySelector('.p-party');
      const list = field.querySelector('.ic-list');
      let sel = null;
      function render() {
        const q = String(input.value || '').trim();
        const found = (q ? parties.filter(p => (p.name || '').includes(q)) : parties).slice(0, 60);
        list.innerHTML = found.length
          ? found.map(p => `<div class="ic-opt${p.id === sel ? ' sel' : ''}" data-id="${p.id}"><span class="ic-name">${esc(p.name)}</span></div>`).join('')
          : '<div class="ic-empty">لا يوجد عملاء مطابقون — أضف العميل بزر «+ عميل جديد»</div>';
        list.querySelectorAll('.ic-opt').forEach(o => {
          o.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(Number(o.dataset.id)); });
        });
        list.style.display = 'block';
      }
      function pick(id) {
        const p = parties.find(x => x.id === Number(id));
        if (!p) return;
        sel = p.id; valueEl.value = String(p.id); input.value = p.name; list.style.display = 'none';
      }
      input.addEventListener('focus', () => { input.select(); render(); });
      input.addEventListener('input', () => { sel = null; valueEl.value = ''; render(); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); const first = list.querySelector('.ic-opt'); if (first) pick(Number(first.dataset.id)); }
        else if (ev.key === 'Escape') list.style.display = 'none';
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!sel) { input.value = ''; valueEl.value = ''; } list.style.display = 'none'; }, 150));
      if (selectedId) pick(selectedId);
      field.querySelector('#party-add').onclick = () => {
        const name = String(input.value || '').trim();
        openModal('عميل جديد', `
          <div class="form-grid">
            <div class="field full"><label>اسم العميل *</label><input id="np-name" value="${esc(name)}"></div>
            <div class="field full"><label>الهاتف</label><input id="np-phone"></div>
          </div>`,
          [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
            const nm = String(b.querySelector('#np-name').value || '').trim();
            if (!nm) { toast('اسم العميل مطلوب', 'err'); return; }
            try {
              const saved = await api.invoke('parties:save', { id: null, name: nm, phone: b.querySelector('#np-phone').value, type: 'customer' }, currentUser().id);
              parties.push(saved);
              pick(saved.id);
              b.remove(); toast('تمت إضافة العميل', 'ok');
            } catch (e) { toast(String(e.message || e), 'err'); }
          } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      };
      return { box: field, getValue: () => valueEl.value };
    }

    async function form(doc) {
      const [items, partiesAll, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('warehouses:list'),
      ]);
      const parties = partiesAll.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('sales:suggest');

      const back = openModal(doc ? `تعديل فاتورة ${esc(doc.doc_number)}` : 'ترحيل فاتورة جديدة', `
        <div class="form-grid">
          <div class="field"><label>رقم الفاتورة *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل</label><span id="party-box"></span></div>
          <div class="field"><label>طريقة الدفع (عند إدخال أسعار)</label>
            <select id="f-pay">
              <option value="credit" ${doc && doc.payment_method !== 'cash' ? 'selected' : ''}>آجل (يُسجل على ذمة العميل)</option>
              <option value="cash" ${doc && doc.payment_method === 'cash' ? 'selected' : ''}>نقدي</option>
            </select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>الرصيد</th><th>السعر (اختياري)</th><th>الإجمالي</th><th>ملاحظات</th><th></th>
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
            })).filter(x => x.item_id);
            await api.invoke('sales:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              invoice_type: 'sale',
              party_id: b.querySelector('.p-party').value ? Number(b.querySelector('.p-party').value) : null,
              payment_method: b.querySelector('#f-pay').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الترحيل', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const pcombo = partyField(parties, doc ? doc.party_id : null);
      back.querySelector('#party-box').appendChild(pcombo.box);

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
          <td><span class="bal-text muted"></span></td>
          <td><input class="p-price num" type="number" min="0" step="any" placeholder="اختياري" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        const combo = itemCombo(items, () => row.querySelector('.p-item').dispatchEvent(new Event('change')));
        row.querySelector('.p-item-td').appendChild(combo.box);
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
          balText.textContent = '…';
          try {
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة`;
          } catch { balText.textContent = ''; }
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
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

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
  },
});
