import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, esc, renderTable, attachRowMenu, openModal, implicationsDialog } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

// ===== مرتجعات الفواتير =====
// مرتجع بضاعة من عميل على فاتورة مرحلة سابقاً: يُختار بالفاتورة برقمها،
// وتظهر أصنافها مع المتبقي القابل للإرجاع، ولا يُقبل إرجاع أكثر منه.
// السعر اختياري كما في الترحيل: بلا أسعار = أثر مخزني فقط.

register('salesreturns', {
  title: 'مرتجعات الفواتير',
  async mount(el) {
    async function load() {
      const { sales } = await api.invoke('returns:list');
      const rows = sales;
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ مرتجع فاتورة</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      const money = active.reduce((s, r) => s + (Number(r.total) || 0), 0);
      el.querySelector('#summary').innerHTML =
        `عدد المرتجعات: <b>${rows.length}</b> — النشطة: <b>${active.length}</b>${money ? ` — الإجمالي: <b>${fmtMoney(money)}</b>` : ''}`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'invoice_number', label: 'الفاتورة', render: r => `<span dir="ltr">${esc(r.invoice_number || '—')}</span>` },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
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
        const doc = await api.invoke('returns:getSale', id);
        await api.invoke('print:open', { kind: 'sale_return', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('returns:getSale', id);
        openModal(`مرتجع ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>الفاتورة:</b> <span dir="ltr">${esc(doc.invoice_number || '—')}</span>
            &nbsp; <b>العميل:</b> ${esc(doc.party_name || '—')} &nbsp; <b>طريقة الدفع:</b> ${doc.payment_method === 'cash' ? 'نقدي' : 'آجل'}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>السعر</th><th>الإجمالي</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtMoney(it.unit_price)}</td>
            <td>${fmtMoney(it.total_price)}</td></tr>`).join('')}</tbody></table>
          <p style="margin-top:8px"><b>الإجمالي العام:</b> ${fmtMoney(doc.items.reduce((a, it) => a + (Number(it.total_price) || 0), 0))}</p>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'sale_return', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('returns:getSale', id);
        if (!(await implicationsDialog('تعديل مرتجع', [
          'سيُعكس أثر المرتجع الحالي على المخزون والسلات ويُعاد تطبيقه بالقيم الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('returns:getSale', id);
        if (!(await implicationsDialog('إلغاء مرتجع', [
          `سيُلغى أثر المرتجع ${esc(doc.doc_number)} وتُخصم الكميات المرتجعة من المخزون مجدداً.`,
        ]))) return;
        await api.invoke('returns:void', { type: 'sale', id }, currentUser().id);
        toast('تم إلغاء المرتجع', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // حقل اختيار الفاتورة ببحث ذكي على رقمها واسم عميلها
    function invoiceField(invoices, selectedId) {
      const field = document.createElement('div');
      field.className = 'party-combo';
      field.innerHTML = `
        <input type="text" class="ic-input" placeholder="ابحث برقم الفاتورة أو اسم العميل…" autocomplete="off">
        <input type="hidden" class="p-invoice">
        <div class="ic-list" style="display:none"></div>`;
      const input = field.querySelector('.ic-input');
      const valueEl = field.querySelector('.p-invoice');
      const list = field.querySelector('.ic-list');
      let sel = null;
      const label = (inv) => `${inv.doc_number} — ${inv.party_name || 'بدون عميل'}`;
      function render() {
        const q = String(input.value || '').trim();
        const found = (q ? invoices.filter(i => label(i).includes(q)) : invoices).slice(0, 60);
        list.innerHTML = found.length
          ? found.map(i => `<div class="ic-opt${i.id === sel ? ' sel' : ''}" data-id="${i.id}"><span class="ic-code" dir="ltr">${esc(i.doc_number)}</span><span class="ic-name">${esc(i.party_name || '')}</span></div>`).join('')
          : '<div class="ic-empty">لا توجد فواتير مرحلة مطابقة — رحّل الفاتورة أولاً من شاشة الترحيل</div>';
        list.querySelectorAll('.ic-opt').forEach(o => {
          o.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(Number(o.dataset.id)); });
        });
        list.style.display = 'block';
      }
      function pick(id) {
        const inv = invoices.find(x => x.id === Number(id));
        if (!inv) return;
        sel = inv.id; valueEl.value = String(inv.id); input.value = label(inv); list.style.display = 'none';
        if (field._onPick) field._onPick(inv.id);
      }
      input.addEventListener('focus', () => { input.select(); render(); });
      input.addEventListener('input', () => { sel = null; valueEl.value = ''; render(); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); const first = list.querySelector('.ic-opt'); if (first) pick(Number(first.dataset.id)); }
        else if (ev.key === 'Escape') list.style.display = 'none';
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!sel) { input.value = ''; valueEl.value = ''; } list.style.display = 'none'; }, 150));
      if (selectedId) pick(selectedId);
      return { box: field, getValue: () => valueEl.value, pick };
    }

    async function form(doc) {
      const [suggest, invoicesAll, warehouses] = await Promise.all([
        doc ? Promise.resolve(null) : api.invoke('returns:suggest'),
        api.invoke('sales:list'),
        api.invoke('warehouses:list'),
      ]);
      const invoices = invoicesAll.filter(r => r.invoice_type === 'sale' && r.status === 'active');
      const whName = (id) => (warehouses.find(w => w.id === Number(id)) || {}).name || '—';
      let avail = [];

      const back = openModal(doc ? `تعديل مرتجع ${esc(doc.doc_number)}` : 'مرتجع فاتورة جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم المرتجع *</label><input id="f-num" value="${esc(doc ? doc.doc_number : (suggest ? suggest.sale : ''))}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>الفاتورة الأصلية *</label><span id="inv-box"></span></div>
          <div class="field"><label>طريقة الدفع (عند إدخال أسعار)</label>
            <select id="f-pay">
              <option value="credit" ${doc && doc.payment_method !== 'cash' ? 'selected' : ''}>آجل (يخفض ذمة العميل)</option>
              <option value="cash" ${doc && doc.payment_method === 'cash' ? 'selected' : ''}>نقدي (يُسترد نقداً)</option>
            </select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div id="avail-wrap" class="notes" style="display:none"></div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>المتبقي</th><th>السعر (اختياري)</th><th>الإجمالي</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>الإجمالي العام</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button" disabled>+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const lines = [...b.querySelectorAll('#irows .irow')].map(r => ({
              item_id: Number(r.querySelector('.r-item').value),
              warehouse_id: Number(r.querySelector('.r-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              unit_price: parseFloat(r.querySelector('.p-price').value) || 0,
              notes: r.querySelector('.p-notes').value,
            })).filter(x => x.item_id);
            const invoiceId = Number(b.querySelector('.p-invoice').value);
            if (!invoiceId) { toast('اختر الفاتورة الأصلية', 'err'); return; }
            if (!lines.length) { toast('أضف بنداً واحداً على الأقل', 'err'); return; }
            // فحص واجهة: لا يتجاوز أي بند المتبقي (في التعديل تتحقق الخلفية بالمتبقي مع استبعاد هذا المرتجع)
            if (!doc) {
              for (const ln of lines) {
                const a = avail.find(x => x.item_id === ln.item_id);
                const pieces = toPieces(ln.quantity, ln.unit, a || {});
                if (a && pieces != null && pieces > a.remain) {
                  toast(`كمية الإرجاع للصنف ${a.code} تتجاوز المتبقي (${fmtNum(a.remain, 0)} حبة)`, 'err');
                  return;
                }
              }
              const byItem = {};
              for (const ln of lines) {
                const a = avail.find(x => x.item_id === ln.item_id);
                const pieces = toPieces(ln.quantity, ln.unit, a || {}) || 0;
                byItem[ln.item_id] = (byItem[ln.item_id] || 0) + pieces;
              }
              for (const [itemId, pieces] of Object.entries(byItem)) {
                const a = avail.find(x => x.item_id === Number(itemId));
                if (a && pieces > a.remain) {
                  toast(`إجمالي الإرجاع للصنف ${a.code} يتجاوز المتبقي (${fmtNum(a.remain, 0)} حبة)`, 'err');
                  return;
                }
              }
            }
            await api.invoke('returns:save', {
              id: doc ? doc.id : null,
              type: 'sale',
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              invoice_id: invoiceId,
              party_id: null,
              payment_method: b.querySelector('#f-pay').value,
              notes: b.querySelector('#f-notes').value,
              items: lines,
            }, currentUser().id);
            b.remove(); toast('تم حفظ المرتجع', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const availWrap = back.querySelector('#avail-wrap');
      const addBtn = back.querySelector('#add-row');

      const itemOf = (id) => avail.find(x => x.item_id === Number(id));

      function updateTotal() {
        const total = [...rowsWrap.querySelectorAll('.irow')].reduce((s, r) => {
          const q = parseFloat(r.querySelector('.p-qty').value) || 0;
          const p = parseFloat(r.querySelector('.p-price').value) || 0;
          return s + q * p;
        }, 0);
        totalEl.textContent = fmtMoney(total);
      }

      function renderAvail() {
        if (!avail || !avail.length) {
          availWrap.style.display = 'none';
          addBtn.disabled = true;
          return;
        }
        const open = avail.filter(a => a.remain > 0);
        availWrap.style.display = 'block';
        availWrap.innerHTML = `<b>الأصناف المتاحة في الفاتورة:</b>
          <table class="data" style="margin-top:6px"><thead><tr><th>الصنف</th><th>المتبقي (حبة)</th><th>الوحدة</th></tr></thead>
          <tbody>${avail.map(a => `<tr><td>${esc(a.code)} — ${esc(a.name)}</td><td>${fmtNum(a.remain, 0)}</td><td>${esc(a.unit_name || a.unit || '')}</td></tr>`).join('')}</tbody></table>`;
        addBtn.disabled = !open.length;
      }

      function addRow(data = {}) {
        const open = avail.filter(a => a.remain > 0);
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td><select class="r-item"><option value="">— اختر صنفاً —</option>
            ${open.map(a => `<option value="${a.item_id}">${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select></td>
          <td><input type="hidden" class="r-wh"><span class="wh-text muted">—</span></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="rem-text muted">—</span></td>
          <td><input class="p-price num" type="number" min="0" step="any" placeholder="اختياري" value="${esc(data.unit_price ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };

        const itemSel = row.querySelector('.r-item');
        const whHidden = row.querySelector('.r-wh');
        const whText = row.querySelector('.wh-text');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
        const price = row.querySelector('.p-price');
        const remText = row.querySelector('.rem-text');
        const calc = row.querySelector('.p-calc');

        function refresh() {
          const a = itemOf(itemSel.value);
          if (!a) return;
          const cur = unitSel.value;
          const opts = unitOptionsFor(a);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
          whHidden.value = String(a.warehouse_id);
          whText.textContent = whName(a.warehouse_id);
          remText.textContent = `${fmtNum(a.remain, 0)} حبة`;
          if (!price.value && a.unit_price) price.value = a.unit_price;
          update();
        }
        function update() {
          const a = itemOf(itemSel.value);
          if (!a) return;
          const pieces = toPieces(qty.value, unitSel.value, a);
          const kg = piecesToWeightKg(pieces || 0, a?.weight_grams || 0);
          const p = parseFloat(price.value) || 0;
          const q = parseFloat(qty.value) || 0;
          calc.textContent = `${pieces != null ? fmtNum(pieces, 0) + ' حبة' + (kg ? ' — ' + fmtNum(kg) + ' كجم' : '') : '—'}${p && q ? ' — ' + fmtMoney(p * q) : ''}`;
          updateTotal();
        }
        itemSel.onchange = refresh;
        unitSel.onchange = update;
        qty.oninput = update;
        price.oninput = update;
        row._refresh = update;
        if (data.item_id) itemSel.value = String(data.item_id);
        refresh();
      }

      const invCombo = invoiceField(invoices, doc ? doc.invoice_id : null);
      invCombo.box._onPick = async (invId) => {
        try {
          avail = await api.invoke('returns:available', 'sale', invId, doc ? doc.id : null);
        } catch (e) {
          avail = [];
          toast(String(e.message || e), 'err');
        }
        renderAvail();
      };
      back.querySelector('#inv-box').appendChild(invCombo.box);
      if (doc && doc.invoice_id) invCombo.box._onPick(doc.invoice_id);

      addBtn.onclick = () => addRow();
      if (doc && doc.items && doc.items.length) {
        for (const it of doc.items) {
          addRow({ item_id: it.item_id, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes });
        }
      }
      updateTotal();
    }

    await load();
  },
});
