import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function calcPieces(qty, unit, item) {
  const q = parseFloat(qty) || 0;
  switch (unit) {
    case 'piece': return Math.round(q);
    case 'carton': return Math.round(q * (item.pieces_per_carton || 0));
    case 'bag': return Math.round(q * (item.pieces_per_bag || 0));
    case 'kg': return item.weight_grams ? Math.round(q * 1000 / item.weight_grams) : 0;
    case 'ton': return item.weight_grams ? Math.round(q * 1000000 / item.weight_grams) : 0;
  }
  return 0;
}

register('tolling', {
  title: 'النفخ للغير',
  async mount(el) {
    async function load(tab = 'receipts') {
      const [rawItems, goodsItems, feeItems, parties, receipts, deliveries, balance] = await Promise.all([
        api.invoke('items:list', 3),
        api.invoke('items:list', 2),
        api.invoke('items:list', 4),
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
        body.innerHTML = `<div class="toolbar"><button class="btn primary" id="btn-add">+ سند استلام خام</button></div><div id="table-wrap"></div>`;
        body.querySelector('#btn-add').onclick = () => receiptForm(null, customers, rawItems);
        renderTable(body.querySelector('#table-wrap'), [
          { key: 'doc_number', label: 'الرقم' },
          { key: 'doc_date', label: 'التاريخ' },
          { key: 'party_name', label: 'العميل' },
          { key: 'items_count', label: 'البنود' },
          { key: 'total_pieces', label: 'الحبات', render: r => Number(r.total_pieces).toLocaleString('en-US') },
          { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : 'نشط' },
          { key: 'actions', label: '', render: r => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>` },
        ], receipts);
        body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => receiptView(Number(b.dataset.view)));
        body.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
          const doc = await api.invoke('tolling:receiptGet', Number(b.dataset.edit));
          receiptForm(doc, customers, rawItems);
        });
        body.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
          if (!(await confirmDialog('سيُلغى السند ويُخصم من رصيد العميل. متابعة؟'))) return;
          try {
            await api.invoke('tolling:receiptVoid', Number(b.dataset.void), currentUser().id);
            toast('تم الإلغاء', 'ok'); await load('receipts');
          } catch (e) { toast(String(e.message || e), 'err'); }
        });
      } else if (tab === 'deliveries') {
        body.innerHTML = `<div class="toolbar"><button class="btn primary" id="btn-add">+ سند تسليم</button></div><div id="table-wrap"></div>`;
        body.querySelector('#btn-add').onclick = () => deliveryForm(null, customers, goodsItems, feeItems);
        renderTable(body.querySelector('#table-wrap'), [
          { key: 'doc_number', label: 'الرقم' },
          { key: 'doc_date', label: 'التاريخ' },
          { key: 'party_name', label: 'العميل' },
          { key: 'total_pieces', label: 'القطع المسلمة', render: r => Number(r.total_pieces).toLocaleString('en-US') },
          { key: 'invoice_number', label: 'فاتورة الأجرة', render: r => r.invoice_number || '—' },
          { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : 'نشط' },
          { key: 'actions', label: '', render: r => `<button class="btn mini" data-view="${r.id}">عرض</button>
            <button class="btn mini danger" data-void="${r.id}">إلغاء</button>` },
        ], deliveries);
        body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => deliveryView(Number(b.dataset.view)));
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
          { key: 'raw_in', label: 'استلم خام (حبة)', render: r => Number(r.raw_in).toLocaleString('en-US') },
          { key: 'raw_kg', label: 'الوزن (كجم)', render: r => Number(r.raw_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) },
          { key: 'delivered_out', label: 'سلّمنا تام (حبة)', render: r => Number(r.delivered_out).toLocaleString('en-US') },
          { key: 'scrap_out', label: 'تالف (حبة)', render: r => Number(r.scrap_out).toLocaleString('en-US') },
          { key: 'remaining', label: 'الباقي لدينا', render: r => `<b>${Number(r.remaining).toLocaleString('en-US')}</b>` },
        ], balance);
      }
    }

    async function receiptView(id) {
      try {
        const doc = await api.invoke('tolling:receiptGet', id);
        openModal(`سند استلام خام ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>العميل:</b> ${esc(doc.party_name)}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>العلب</th><th>حبات/علبة</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.boxes)}</td>
            <td>${esc(it.pieces_per_box || '—')}</td><td>${Number(it.pieces).toLocaleString('en-US')}</td>
            <td>${Number(it.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'toll_receipt', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    function receiptForm(doc, customers, rawItems) {
      const back = openModal(doc ? `تعديل سند استلام ${esc(doc.doc_number)}` : 'سند استلام خام عميل', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : '')}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <div class="prows-head">
          <span>الصنف (خام عميل)</span><span>عدد العلب</span><span>حبات/علبة</span><span>الوزن كجم (اختياري)</span><span>ملاحظات</span><span></span>
        </div>
        <div id="irows"></div>
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
      back.querySelector('.modal').style.minWidth = '860px';
      const rowsWrap = back.querySelector('#irows');
      const itemById = (id) => rawItems.find(i => i.id === id);

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${rawItems.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <input class="p-boxes" type="number" min="0" step="any" value="${esc(data.boxes ?? '')}">
          <input class="p-perbox" type="number" min="0" step="any" value="${esc(data.pieces_per_box ?? '')}">
          <input class="p-weight" type="number" min="0" step="any" value="${esc(data.weight_kg ?? '')}">
          <input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}">
          <button class="btn mini danger p-del" type="button">×</button>`;
        rowsWrap.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();
        const itemSel = row.querySelector('.p-item');
        const perBox = row.querySelector('.p-perbox');
        const fillPerBox = () => {
          if (!perBox.value) {
            const item = itemById(Number(itemSel.value));
            if (item && item.pieces_per_carton) perBox.value = item.pieces_per_carton;
          }
        };
        itemSel.onchange = fillPerBox;
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
            <td>${esc(it.quantity)} ${esc(it.unit)}</td><td>${Number(it.pieces).toLocaleString('en-US')}</td>
            <td>${Number(it.weight_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'toll_delivery', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    function deliveryForm(doc, customers, goodsItems, feeItems) {
      const back = openModal(doc ? `تعديل سند تسليم ${esc(doc.doc_number)}` : 'سند تسليم منفوخ', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : '')}"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <p id="bal-line" class="muted"></p>
        <div class="prows-head">
          <span>الصنف (تام)</span><span>الكمية</span><span>الوحدة</span><span>الحبات</span><span>ملاحظات</span><span></span>
        </div>
        <div id="irows"></div>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>
        <div class="field check" style="margin-top:14px">
          <label><input type="checkbox" id="f-inv"> إنشاء فاتورة أجرة نفخ مع التسليم</label>
        </div>
        <div id="inv-wrap" hidden>
          <div class="form-grid">
            <div class="field"><label>رقم الفاتورة *</label><input id="f-inv-num"></div>
            <div class="field"><label>السائق</label><input id="f-inv-driver"></div>
            <div class="field"><label>رقم السيارة</label><input id="f-inv-car"></div>
          </div>
          <div class="prows-head">
            <span>خدمة النفخ</span><span>الكمية (حبة)</span><span>السعر</span><span>الإجمالي</span><span></span>
          </div>
          <div id="inv-rows"></div>
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
            const invWrap = b.querySelector('#inv-wrap');
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
      back.querySelector('.modal').style.minWidth = '860px';

      const rowsWrap = back.querySelector('#irows');
      const itemById = (id) => goodsItems.find(i => i.id === id);
      const balLine = back.querySelector('#bal-line');

      async function refreshBal() {
        const pid = Number(back.querySelector('#f-party').value);
        if (!pid) { balLine.textContent = ''; return; }
        try {
          const bal = await api.invoke('tolling:balance');
          const row = bal.find(r => r.id === pid);
          balLine.textContent = row
            ? `رصيد العميل المتبقي: ${Number(row.remaining).toLocaleString('en-US')} حبة (استلم ${Number(row.raw_in).toLocaleString('en-US')} — سلّم ${Number(row.delivered_out).toLocaleString('en-US')} — تالف ${Number(row.scrap_out).toLocaleString('en-US')})`
            : '';
        } catch { balLine.textContent = ''; }
      }
      back.querySelector('#f-party').onchange = refreshBal;

      function addRow(data = {}) {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${goodsItems.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
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
        const unitsFor = (item) => {
          const u = ['piece'];
          if (item.pieces_per_carton) u.push('carton');
          if (item.pieces_per_bag) u.push('bag');
          u.push('kg', 'ton');
          return u;
        };
        const LABELS = { piece: 'حبة', carton: 'كرتون', bag: 'كيس', kg: 'كجم', ton: 'طن' };
        const refresh = () => {
          const item = itemById(Number(itemSel.value));
          const opts = unitsFor(item);
          unitSel.innerHTML = opts.map(u => `<option value="${u}">${LABELS[u]}</option>`).join('');
          if (opts.includes(unitSel.value)) { /* keep */ } else if (data.unit && opts.includes(data.unit)) unitSel.value = data.unit;
          const pieces = calcPieces(qty.value, unitSel.value, item);
          balText.textContent = pieces > 0 ? `${pieces.toLocaleString('en-US')} حبة` : '';
        };
        itemSel.onchange = refresh;
        unitSel.onchange = refresh;
        qty.oninput = refresh;
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
      back.querySelector('#f-inv').onchange = () => {
        invWrap.hidden = !back.querySelector('#f-inv').checked;
      };
      function addInvRow() {
        const row = document.createElement('div');
        row.className = 'irow';
        row.innerHTML = `
          <select class="p-item">${feeItems.map(i => `<option value="${i.id}">${esc(i.code)} — ${esc(i.name)}</option>`).join('')}</select>
          <input class="p-qty" type="number" min="0" step="any" value="0">
          <input class="p-price" type="number" min="0" step="any" value="">
          <span class="p-calc muted">0</span>
          <button class="btn mini danger p-del" type="button">×</button>`;
        invRows.appendChild(row);
        row.querySelector('.p-del').onclick = () => row.remove();
        const update = () => {
          const q = parseFloat(row.querySelector('.p-qty').value) || 0;
          const p = parseFloat(row.querySelector('.p-price').value) || 0;
          row.querySelector('.p-calc').textContent = (q * p).toLocaleString('en-US', { maximumFractionDigits: 2 });
        };
        row.querySelector('.p-qty').oninput = update;
        row.querySelector('.p-price').oninput = update;
        const fillPrice = () => {
          const item = feeItems.find(i => i.id === Number(row.querySelector('.p-item').value));
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
