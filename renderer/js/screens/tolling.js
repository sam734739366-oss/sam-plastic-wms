import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtMoney, fmtNum, today } from '../fmt.js';

register('tolling', {
  title: 'النفخ للغير',
  async mount(el) {
    async function load(tab = 'receipts') {
      const [items, parties, receipts, deliveries, balance] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('tolling:receiptsList'),
        api.invoke('tolling:deliveriesList'),
        api.invoke('tolling:balance'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      el.innerHTML = `
        <div class="toolbar tabs">
          <button class="btn ${tab === 'receipts' ? 'primary' : ''}" id="tab-receipts">استلام خام عميل</button>
          <button class="btn ${tab === 'deliveries' ? 'primary' : ''}" id="tab-deliveries">تسليم المنفوخ</button>
          <button class="btn ${tab === 'balance' ? 'primary' : ''}" id="tab-balance">رصيد العملاء</button>
        </div>
        <div id="tab-body"></div>`;
      const body = el.querySelector('#tab-body');
      el.querySelector('#tab-receipts').onclick = () => load('receipts');
      el.querySelector('#tab-deliveries').onclick = () => load('deliveries');
      el.querySelector('#tab-balance').onclick = () => load('balance');

      if (tab === 'receipts') {
        body.innerHTML = `<div class="toolbar"><button class="btn primary" id="btn-add">+ سند استلام خام</button></div>
          <div id="summary" class="summary-line"></div><div id="table-wrap"></div>`;
        body.querySelector('#btn-add').onclick = () => receiptForm(null, customers, items);
        const active = receipts.filter(r => r.status !== 'void');
        body.querySelector('#summary').innerHTML =
          `عدد السندات: <b>${receipts.length}</b> — النشطة: <b>${active.length}</b> — إجمالي حبات النشطة: <b>${fmtNum(active.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
        renderTable(body.querySelector('#table-wrap'), [
          { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
          { key: 'doc_date', label: 'التاريخ' },
          { key: 'party_name', label: 'العميل' },
          { key: 'items_count', label: 'البنود' },
          { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
          { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : '<span class="tag salem">نشط</span>' },
          { key: 'actions', label: '', render: r => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-print="${r.id}">طباعة</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>` },
        ], receipts);
        body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => receiptView(Number(b.dataset.view)));
        body.querySelectorAll('[data-print]').forEach(b => b.onclick = async () => {
          try {
            const doc = await api.invoke('tolling:receiptGet', Number(b.dataset.print));
            await api.invoke('print:open', { kind: 'toll_receipt', doc, settings: await api.invoke('settings:get') });
          } catch (e) { toast(String(e.message || e), 'err'); }
        });
        body.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
          const doc = await api.invoke('tolling:receiptGet', Number(b.dataset.edit));
          receiptForm(doc, customers, items);
        });
        body.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
          if (!(await confirmDialog('سيُلغى السند ويُخصم من رصيد العميل. متابعة؟'))) return;
          try {
            await api.invoke('tolling:receiptVoid', Number(b.dataset.void), currentUser().id);
            toast('تم الإلغاء', 'ok'); await load('receipts');
          } catch (e) { toast(String(e.message || e), 'err'); }
        });
      } else if (tab === 'deliveries') {
        body.innerHTML = `<div class="toolbar"><button class="btn primary" id="btn-add">+ سند تسليم</button></div>
          <div id="summary" class="summary-line"></div><div id="table-wrap"></div>`;
        body.querySelector('#btn-add').onclick = () => deliveryForm(null, customers, items);
        const active = deliveries.filter(r => r.status !== 'void');
        body.querySelector('#summary').innerHTML =
          `عدد السندات: <b>${deliveries.length}</b> — النشطة: <b>${active.length}</b> — إجمالي قطع النشطة: <b>${fmtNum(active.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
        renderTable(body.querySelector('#table-wrap'), [
          { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
          { key: 'doc_date', label: 'التاريخ' },
          { key: 'party_name', label: 'العميل' },
          { key: 'total_pieces', label: 'القطع المسلمة', render: r => fmtNum(r.total_pieces, 0) },
          { key: 'invoice_number', label: 'فاتورة الأجرة', render: r => r.invoice_number || '—' },
          { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : '<span class="tag salem">نشط</span>' },
          { key: 'actions', label: '', render: r => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-print="${r.id}">طباعة</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>` },
        ], deliveries);
        body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => deliveryView(Number(b.dataset.view)));
        body.querySelectorAll('[data-print]').forEach(b => b.onclick = async () => {
          try {
            const doc = await api.invoke('tolling:deliveryGet', Number(b.dataset.print));
            await api.invoke('print:open', { kind: 'toll_delivery', doc, settings: await api.invoke('settings:get') });
          } catch (e) { toast(String(e.message || e), 'err'); }
        });
        body.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
          if (!(await confirmDialog('سيُلغى سند التسليم ويُعاد لرصيد العميل. متابعة؟'))) return;
          try {
            await api.invoke('tolling:deliveryVoid', Number(b.dataset.void), currentUser().id);
            toast('تم الإلغاء', 'ok'); await load('deliveries');
          } catch (e) { toast(String(e.message || e), 'err'); }
        });
      } else {
        renderTable(body, [
          { key: 'name', label: 'العميل' },
          { key: 'raw_in', label: 'استلم خام (حبة)', render: r => fmtNum(r.raw_in, 0) },
          { key: 'raw_kg', label: 'الوزن (كجم)', render: r => fmtNum(r.raw_kg) },
          { key: 'delivered_out', label: 'سلّمنا تام (حبة)', render: r => fmtNum(r.delivered_out, 0) },
          { key: 'scrap_out', label: 'تالف (حبة)', render: r => fmtNum(r.scrap_out, 0) },
          { key: 'remaining', label: 'الباقي لدينا', render: r => `<span class="tag ${Number(r.remaining) < 0 ? 'talef' : 'salem'}">${fmtNum(r.remaining, 0)}</span>` },
        ], balance);
        if (!balance.length) body.innerHTML = '<p class="muted">لا يوجد عملاء بعد</p>';
      }
    }

    async function receiptView(id) {
      try {
        const doc = await api.invoke('tolling:receiptGet', id);
        openModal(`سند استلام خام ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name)}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>العلب</th><th>حبات/علبة</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${fmtNum(it.boxes)}</td>
            <td>${fmtNum(it.pieces_per_box, 0)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtNum(it.weight_kg)}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'toll_receipt', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    function receiptForm(doc, customers, items) {
      const suggest = doc ? null : api.invoke('tolling:suggestReceipt');
      const back = openModal(doc ? `تعديل سند استلام ${esc(doc.doc_number)}` : 'سند استلام خام عميل', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : '')}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>عدد العلب</th><th>حبات/علبة</th><th>الحبات</th><th>الوزن كجم</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="3"><b>إجمالي الحبات المستلمة</b></td>
            <td id="f-total">0</td><td colspan="3"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              boxes: parseFloat(r.querySelector('.p-boxes').value) || 0,
              pieces_per_box: parseFloat(r.querySelector('.p-perbox').value) || 0,
              weight_kg: parseFloat(r.querySelector('.p-weight').value) || null,
              notes: r.querySelector('.p-notes').value,
            }));
            await api.invoke('tolling:receiptSave', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              party_id: Number(b.querySelector('#f-party').value),
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load('receipts');
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);
      suggest.then(n => { if (!doc && n) back.querySelector('#f-num').value = n; }).catch(() => {});

      function updateTotal() {
        let total = 0;
        for (const r of rowsWrap.querySelectorAll('.irow')) {
          total += (parseFloat(r.querySelector('.p-boxes').value) || 0) * (parseFloat(r.querySelector('.p-perbox').value) || 0);
        }
        totalEl.textContent = fmtNum(total, 0) + ' حبة';
      }

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td><select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select></td>
          <td><input class="p-boxes num" type="number" min="0" step="any" value="${esc(data.boxes ?? '')}"></td>
          <td><input class="p-perbox num" type="number" min="0" step="any" value="${esc(data.pieces_per_box ?? '')}"></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-weight num" type="number" min="0" step="any" value="${esc(data.weight_kg ?? '')}"></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };
        const itemSel = row.querySelector('.p-item');
        const perBox = row.querySelector('.p-perbox');
        const boxes = row.querySelector('.p-boxes');
        const calc = row.querySelector('.p-calc');
        const fillPerBox = () => {
          if (!perBox.value) {
            const item = itemById(Number(itemSel.value));
            if (item && item.pieces_per_carton) perBox.value = item.pieces_per_carton;
          }
          update();
        };
        function update() {
          const b = parseFloat(boxes.value) || 0;
          const p = parseFloat(perBox.value) || 0;
          calc.textContent = b && p ? fmtNum(b * p, 0) + ' حبة' : '';
          updateTotal();
        }
        itemSel.onchange = fillPerBox;
        boxes.oninput = update;
        perBox.oninput = update;
        if (data.item_id) itemSel.value = String(data.item_id);
        fillPerBox();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) addRow(it);
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
    }

    async function deliveryView(id) {
      try {
        const doc = await api.invoke('tolling:deliveryGet', id);
        openModal(`سند تسليم ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name)}
            &nbsp; <b>فاتورة الأجرة:</b> ${esc(doc.invoice_number || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtNum(it.weight_kg)}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'toll_delivery', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    function deliveryForm(doc, customers, items) {
      const suggest = doc ? null : api.invoke('tolling:suggestDelivery');
      const back = openModal(doc ? `تعديل سند تسليم ${esc(doc.doc_number)}` : 'سند تسليم منفوخ', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : '')}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <p id="bal-line" class="muted" style="margin:8px 0"></p>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>الحبات</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="3"><b>إجمالي الحبات المسلمة</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>
        <div class="field check" style="margin-top:14px">
          <label><input type="checkbox" id="f-inv"> إنشاء فاتورة أجرة نفخ مع التسليم</label>
        </div>
        <div id="inv-wrap" hidden>
          <div class="form-grid">
            <div class="field"><label>رقم الفاتورة *</label><input id="f-inv-num" dir="ltr"></div>
            <div class="field"><label>السائق</label><input id="f-inv-driver"></div>
            <div class="field"><label>رقم السيارة</label><input id="f-inv-car"></div>
          </div>
          <table class="doc-lines">
            <thead><tr>
              <th>بند الأجرة</th><th>الكمية (حبة)</th><th>السعر</th><th>الإجمالي</th><th></th>
            </tr></thead>
            <tbody id="inv-rows"></tbody>
            <tfoot><tr>
              <td colspan="3"><b>إجمالي الأجرة</b></td>
              <td id="f-inv-total">0</td><td></td>
            </tr></tfoot>
          </table>
          <button class="btn small" id="add-inv-row" type="button">+ إضافة بند أجرة</button>
        </div>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('#irows .irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
            }));
            const payload = {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              party_id: Number(b.querySelector('#f-party').value),
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
              invoice_id: doc ? doc.invoice_id : null,
            };
            if (b.querySelector('#f-inv').checked) {
              payload.invoice = {
                create: true,
                doc_number: b.querySelector('#f-inv-num').value,
                driver_name: b.querySelector('#f-inv-driver').value,
                car_number: b.querySelector('#f-inv-car').value,
                items: [...b.querySelectorAll('#inv-rows .irow')].map(r => ({
                  item_id: Number(r.querySelector('.p-item').value),
                  quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
                  unit_price: parseFloat(r.querySelector('.p-price').value) || 0,
                })),
              };
            }
            await api.invoke('tolling:deliverySave', payload, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load('deliveries');
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
      suggest.then(n => { if (!doc && n) back.querySelector('#f-num').value = n; }).catch(() => {});

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);
      const balLine = back.querySelector('#bal-line');

      function updateTotal() {
        let total = 0;
        for (const r of rowsWrap.querySelectorAll('.irow')) {
          const item = itemById(Number(r.querySelector('.p-item').value));
          total += toPieces(r.querySelector('.p-qty').value, r.querySelector('.p-unit').value, item) || 0;
        }
        totalEl.textContent = fmtNum(total, 0) + ' حبة';
      }

      async function refreshBal() {
        const pid = Number(back.querySelector('#f-party').value);
        if (!pid) { balLine.textContent = ''; return; }
        try {
          const bal = await api.invoke('tolling:balance');
          const row = bal.find(r => r.id === pid);
          balLine.textContent = row
            ? `رصيد العميل المتبقي: ${fmtNum(row.remaining, 0)} حبة (استلم ${fmtNum(row.raw_in, 0)} — سلّم ${fmtNum(row.delivered_out, 0)} — تالف ${fmtNum(row.scrap_out, 0)})`
            : '';
        } catch { balLine.textContent = ''; }
      }
      back.querySelector('#f-party').onchange = refreshBal;

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td><select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };
        const itemSel = row.querySelector('.p-item');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
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
        function update() {
          const item = itemById(Number(itemSel.value));
          const pieces = toPieces(qty.value, unitSel.value, item);
          calc.textContent = pieces != null ? fmtNum(pieces, 0) + ' حبة' : '—';
          updateTotal();
        }
        itemSel.onchange = refresh;
        unitSel.onchange = update;
        qty.oninput = update;
        if (data.item_id) itemSel.value = String(data.item_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) addRow(it);
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();

      const invWrap = back.querySelector('#inv-wrap');
      const invRows = back.querySelector('#inv-rows');
      const invTotalEl = back.querySelector('#f-inv-total');
      back.querySelector('#f-inv').onchange = () => {
        invWrap.hidden = !back.querySelector('#f-inv').checked;
      };
      function updateInvTotal() {
        let total = 0;
        for (const r of invRows.querySelectorAll('.irow')) {
          const q = parseFloat(r.querySelector('.p-qty').value) || 0;
          const p = parseFloat(r.querySelector('.p-price').value) || 0;
          total += q * p;
        }
        invTotalEl.textContent = fmtMoney(total);
      }
      function addInvRow() {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td><select class="p-item">${items.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="0"></td>
          <td><input class="p-price num" type="number" min="0" step="any" value=""></td>
          <td><span class="p-calc muted">0</span></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        invRows.appendChild(row);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateInvTotal(); };
        const update = () => {
          const q = parseFloat(row.querySelector('.p-qty').value) || 0;
          const p = parseFloat(row.querySelector('.p-price').value) || 0;
          row.querySelector('.p-calc').textContent = fmtNum(q * p);
          updateInvTotal();
        };
        row.querySelector('.p-qty').oninput = update;
        row.querySelector('.p-price').oninput = update;
        const fillPrice = () => {
          const item = items.find(i => i.id === Number(row.querySelector('.p-item').value));
          if (item && item.service_price) row.querySelector('.p-price').value = item.service_price;
          update();
        };
        row.querySelector('.p-item').onchange = fillPrice;
        fillPrice();
      }
      back.querySelector('#add-inv-row').onclick = addInvRow;
      addInvRow();
      refreshBal();
    }

    await load('receipts');
  }
});
