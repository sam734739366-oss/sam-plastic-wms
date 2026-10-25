import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, attachRowMenu, openModal, esc, itemCombo, bucketOptions, bucketBadge } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

// مرتجعات الشراء: بضاعة تعيدها للمورد — تخرج من المخزون وتنقص ذمتك له (أو يقبض منك نقد)
register('returns', {
  title: 'مرتجعات الشراء',
  async mount(el) {
    async function load() {
      const data = await api.invoke('returns:list');
      const purchases = data.purchases || [];
      const purchasesActive = purchases.filter(r => r.status !== 'void');
      el.innerHTML = `
        <div class="toolbar">
          <button class="btn primary" id="btn-purchase">+ مرتجع شراء</button>
        </div>
        <div class="help-card" style="margin-bottom:12px">مرتجع الشراء: بضاعة تعيدها أنت للمورد — تخرج من المخزون وتنقص ذمتك له، أو يقبض منك نقد إن كانت الفاتورة نقدية. لا يمكن إرجاع كمية أكبر من الكمية الأصلية، ولا إلغاء فاتورة شراء عليها مرتجع نشط — ألغِ المرتجع أولاً.</div>
        <h3 class="sec-title">مرتجعات الشراء</h3>
        <div id="sum-purchase" class="summary-line"></div>
        <div id="table-purchase"></div>`;
      el.querySelector('#btn-purchase').onclick = () => form(null);
      el.querySelector('#sum-purchase').innerHTML =
        `عدد المرتجعات: <b>${purchases.length}</b> — إجمالي النشطة: <b>${fmtMoney(purchasesActive.reduce((a, r) => a + (Number(r.total) || 0), 0))}</b>`;
      const cols = [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'party_name', label: 'المورد', render: r => r.party_name || '—' },
        { key: 'purchase_number', label: 'فاتورة الشراء الأصلية', render: r => `<span dir="ltr">${esc(r.purchase_number || '—')}</span>` },
        { key: 'payment_method', label: 'التسوية', render: r => r.payment_method === 'cash' ? '<span class="tag muharraz">نقد مسترد</span>' : '<span class="tag">آجل</span>' },
        { key: 'total', label: 'الإجمالي', render: r => fmtMoney(r.total) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : '<span class="tag salem">نشط</span>' },
      ];
      renderTable(el.querySelector('#table-purchase'), cols, purchases);
      attachRowMenu(el.querySelector('#table-purchase'), (ri) => {
        const r = purchases[ri];
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
        const doc = await api.invoke('returns:getPurchase', id);
        await api.invoke('print:open', {
          kind: 'purchase_return',
          doc: { ...doc, type: 'purchase' }, settings: await api.invoke('settings:get'),
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('returns:getPurchase', id);
        openModal(`مرتجع شراء ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المورد:</b> ${esc(doc.party_name || '—')}
            &nbsp; <b>فاتورة الشراء الأصلية:</b> ${esc(doc.purchase_number || '—')}
            &nbsp; <b>التسوية:</b> ${doc.payment_method === 'cash' ? 'نقد مسترد' : 'آجل'}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>الحبات</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${bucketBadge(it.bucket)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtMoney(it.unit_price)}</td><td>${fmtMoney(it.total_price)}</td></tr>`).join('')}</tbody></table>
          <p style="margin-top:8px"><b>الإجمالي:</b> ${fmtMoney(doc.items.reduce((a, it) => a + (Number(it.total_price) || 0), 0))}</p>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await printDoc(id); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('returns:getPurchase', id);
        if (!(await implicationsDialog('تعديل مرتجع', [
          'سيُعكس أثر المرتجع الحالي على المخزون والحسابات ويُعاد تسجيله بالقيم الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('returns:getPurchase', id);
        if (!(await implicationsDialog('إلغاء مرتجع', [
          `سيُعكس أثر المرتجع ${esc(doc.doc_number)}: تُعكس حركة المخزون وتسوية الحساب تلقائياً.`,
        ]))) return;
        await api.invoke('returns:void', { type: 'purchase', id }, currentUser().id);
        toast('تم إلغاء المرتجع', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [warehouses, suggest] = await Promise.all([
        api.invoke('warehouses:list'),
        doc ? null : api.invoke('returns:suggest'),
      ]);
      const sourceList = (await api.invoke('purchases:list')).filter(r => r.status !== 'void');
      const back = openModal(doc ? `تعديل مرتجع شراء ${esc(doc.doc_number)}` : 'مرتجع شراء جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم المرتجع *</label><input id="f-num" value="${esc(doc ? doc.doc_number : (suggest ? suggest.purchase : ''))}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field full"><label>فاتورة الشراء الأصلية *</label>
            <select id="f-src"><option value="">— اختر فاتورة —</option>
              ${sourceList.map(s => `<option value="${s.id}" ${doc && doc.purchase_id === s.id ? 'selected' : ''}>${esc(s.doc_number)} — ${esc(s.party_name || 'بدون طرف')} — ${fmtMoney(s.total)}</option>`).join('')}
            </select></div>
          <div class="field"><label>طريقة التسوية *</label>
            <select id="f-pay">
              <option value="credit">آجل (تخفيض ذمة المورد)</option>
              <option value="cash">نقدي (قبض نقد من المورد)</option>
            </select></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>الوحدة</th><th>المتبقي</th><th>السعر</th><th>الإجمالي</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr><td colspan="7"><b>الإجمالي العام</b></td><td id="f-total">0</td><td colspan="2"></td></tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const srcId = Number(b.querySelector('#f-src').value);
            if (!srcId) throw new Error('اختر فاتورة الشراء الأصلية');
            const itemsData = [...b.querySelectorAll('#irows .irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              warehouse_id: Number(r.querySelector('.p-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              unit_price: parseFloat(r.querySelector('.p-price').value) || 0,
              notes: r.querySelector('.p-notes').value,
              bucket: r.querySelector('.p-bucket').value,
            })).filter(x => x.item_id);
            await api.invoke('returns:save', {
              id: doc ? doc.id : null,
              type: 'purchase',
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              purchase_id: srcId,
              payment_method: b.querySelector('#f-pay').value,
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      let srcItems = [];
      let srcMeta = null;

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
        row._bucketTouched = false;
        row.innerHTML = `
          <td class="p-item-td"></td>
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="p-left muted"></span></td>
          <td><input class="p-price num" type="number" min="0" step="any" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        const combo = itemCombo(srcItems, () => row.querySelector('.p-item').dispatchEvent(new Event('change')));
        row.querySelector('.p-item-td').appendChild(combo.box);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };
        row.querySelector('.p-bucket').addEventListener('change', () => { row._bucketTouched = true; });

        const itemSel = row.querySelector('.p-item');
        const whSel = row.querySelector('.p-wh');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const leftEl = row.querySelector('.p-left');
        const calc = row.querySelector('.p-calc');

        function refresh() {
          const src = srcItems.find(i => i.id === Number(itemSel.value));
          if (!src) return;
          if (!row._bucketTouched && src.bucket) row.querySelector('.p-bucket').value = src.bucket;
          const cur = unitSel.value;
          const item = { ...src };
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
          if (src.unit_price != null && !price.value) price.value = src.unit_price;
          leftEl.textContent = `${fmtNum(src.remain, 0)} حبة`;
          update();
        }
        function update() {
          const src = srcItems.find(i => i.id === Number(itemSel.value));
          if (!src) return;
          const pieces = toPieces(qty.value, unitSel.value, src);
          const kg = piecesToWeightKg(pieces || 0, src?.weight_grams || 0);
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
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

      async function loadSource(srcId) {
        srcItems = [];
        rowsWrap.innerHTML = '';
        if (!srcId) { updateTotal(); return; }
        try {
          srcMeta = await api.invoke('purchases:get', srcId);
          srcItems = await api.invoke('returns:available', 'purchase', srcId, doc ? doc.id : null);
          const fPay = back.querySelector('#f-pay');
          if (!doc && srcMeta.payment_method) fPay.value = srcMeta.payment_method;
          addRow();
        } catch (e) { toast(String(e.message || e), 'err'); }
      }

      back.querySelector('#f-src').onchange = () => loadSource(Number(back.querySelector('#f-src').value));
      back.querySelector('#add-row').onclick = () => addRow();
      if (doc) {
        await loadSource(doc.purchase_id);
        if (doc.items.length) {
          rowsWrap.innerHTML = '';
          for (const it of doc.items) {
            addRow({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes, bucket: it.bucket });
          }
        }
        back.querySelector('#f-pay').value = doc.payment_method;
      } else {
        addRow();
      }
      updateTotal();
    }

    await load();
  }
});
