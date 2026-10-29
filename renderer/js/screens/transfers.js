import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import {
  toast, implicationsDialog, renderTable, attachRowMenu, rowActions, openModal, esc,
  itemCombo, bucketOptions, bucketBadge, canWrite, unitOf,
} from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtNum, today } from '../fmt.js';

register('transfers', {
  title: 'نقل بين المخازن',
  async mount(el) {
    const writable = canWrite();
    async function load() {
      const rows = await api.invoke('transfers:list');
      el.innerHTML = `
        <div class="toolbar">${writable ? '<button class="btn primary" id="btn-add">+ سند نقل</button>' : '<span class="muted">وضع عرض فقط — لا يمكن الإنشاء أو التعديل أو الحذف</span>'}</div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      if (writable) el.querySelector('#btn-add').onclick = () => form(null);
      el.querySelector('#summary').innerHTML =
        `عدد السندات: <b>${rows.length}</b> — إجمالي الحبات المنقولة: <b>${fmtNum(rows.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'from_name', label: 'من مخزن' },
        { key: 'to_name', label: 'إلى مخزن' },
        { key: 'items_count', label: 'البنود' },
        { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
      ], rows);
      attachRowMenu(el.querySelector('#table-wrap'), (ri) => rowActions({
        id: rows[ri].id,
        entity: 'transfers',
        valueKind: 'pieces',
        label: 'سند النقل',
        view: (id) => view(id),
        print: (id) => printDoc(id),
        edit: (id) => edit(id),
        reload: load,
        readOnly: !writable,
      }));
    }

    async function printDoc(id) {
      try {
        const doc = await api.invoke('transfers:get', id);
        await api.invoke('print:open', { kind: 'transfer', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('transfers:get', id);
        openModal(`سند نقل ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp;
            <b>من:</b> ${esc(doc.from_name)} &nbsp; <b>إلى:</b> ${esc(doc.to_name)}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>السلة</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td>
            <td>${bucketBadge(it.bucket)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtNum(it.weight_kg)}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'transfer', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('transfers:get', id);
        if (!(await implicationsDialog('تعديل سند نقل', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق السند بالكميات الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('warehouses:list'),
      ]);
      const suggest = doc ? null : await api.invoke('transfers:suggest');

      const back = openModal(doc ? `تعديل سند نقل ${esc(doc.doc_number)}` : 'سند نقل جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم السند *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>من مخزن *</label>
            <select id="f-from">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.from_warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>إلى مخزن *</label>
            <select id="f-to">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.to_warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>السلة</th><th>الكمية</th><th>الوحدة</th><th>رصيد المصدر</th><th>الحبات / الوزن</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="5"><b>إجمالي الحبات المنقولة</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
              bucket: r.querySelector('.p-bucket').value,
            })).filter(x => x.item_id);
            await api.invoke('transfers:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              from_warehouse_id: Number(b.querySelector('#f-from').value),
              to_warehouse_id: Number(b.querySelector('#f-to').value),
              notes: b.querySelector('#f-notes').value,
              items: itemsData,
            }, currentUser().id);
            b.remove(); toast('تم الحفظ', 'ok'); await load();
          } catch (e) { toast(String(e.message || e), 'err'); }
        } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);
      const fromWh = () => Number(back.querySelector('#f-from').value);

      function updateTotal() {
        let total = 0;
        for (const r of rowsWrap.querySelectorAll('.irow')) {
          const item = itemById(Number(r.querySelector('.p-item').value));
          total += toPieces(r.querySelector('.p-qty').value, r.querySelector('.p-unit').value, item) || 0;
        }
        totalEl.textContent = fmtNum(total, 0) + ' حبة';
      }

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td class="p-item-td"></td>
          <td><select class="p-bucket">${bucketOptions(data.bucket || 'salem')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><span class="bal-text muted"></span></td>
          <td><span class="p-calc muted"></span></td>
          <td><input class="p-notes" placeholder="ملاحظات" value="${esc(data.notes || '')}"></td>
          <td class="del"><button class="btn mini danger p-del" type="button">×</button></td>`;
        rowsWrap.appendChild(row);
        const combo = itemCombo(items, () => row.querySelector('.p-item').dispatchEvent(new Event('change')));
        row.querySelector('.p-item-td').appendChild(combo.box);
        row.querySelector('.p-del').onclick = () => { row.remove(); updateTotal(); };

        const itemSel = row.querySelector('.p-item');
        const unitSel = row.querySelector('.p-unit');
        const qty = row.querySelector('.p-qty');
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
            const bal = await api.invoke('stock:balance', item.id, fromWh());
            const b = row.querySelector('.p-bucket').value;
            const av = bal['qty_' + b] || 0;
            const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
            balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} ${unitOf(item)}`;
          } catch { balText.textContent = ''; }
          const pieces = toPieces(qty.value, unitSel.value, item);
          const kg = piecesToWeightKg(pieces || 0, item?.weight_grams || 0);
          calc.textContent = pieces != null
            ? `${fmtNum(pieces, 0)} ${unitOf(item)}${kg ? ' — ' + fmtNum(kg) + ' كجم' : ''}`
            : '—';
          updateTotal();
        }
        itemSel.onchange = refresh;
        unitSel.onchange = update;
        qty.oninput = update;
        row.querySelector('.p-bucket').onchange = update;
        row._refresh = update;
        if (data.item_id) combo.setValue(data.item_id);
        refresh();
      }
      back.querySelector('#f-from').onchange = () =>
        rowsWrap.querySelectorAll('.irow').forEach(r => r._refresh && r._refresh());

      if (doc && doc.items.length) {
        for (const it of doc.items) addRow(it);
      } else {
        addRow();
      }
      back.querySelector('#add-row').onclick = () => addRow();
    }

    await load();
  }
});
