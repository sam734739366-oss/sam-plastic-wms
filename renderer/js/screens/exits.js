import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, openModal, esc , itemCombo, bucketOptions, bucketBadge} from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtNum, today } from '../fmt.js';

register('exits', {
  title: 'تصاريح الخروج',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('exits:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تصريح خروج</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      el.querySelector('#summary').innerHTML =
        `عدد التصاريح: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — إجمالي حبات النشطة: <b>${fmtNum(active.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'warehouse_name', label: 'المخزن' },
        { key: 'driver_name', label: 'السائق' },
        { key: 'car_number', label: 'السيارة', render: r => r.car_number || '—' },
        { key: 'destination', label: 'جهة التسليم', render: r => r.destination || '—' },
        { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : '<span class="tag salem">نشط</span>' },
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
        const doc = await api.invoke('exits:get', id);
        await api.invoke('print:open', { kind: 'exit', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        openModal(`تصريح خروج ${esc(doc.doc_number)}`, `
          <p style="line-height:2"><b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المخزن:</b> ${esc(doc.warehouse_name)}
            &nbsp; <b>السائق:</b> ${esc(doc.driver_name)} &nbsp; <b>السيارة:</b> ${esc(doc.car_number || '—')}<br>
            <b>جهة التسليم:</b> ${esc(doc.destination || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${bucketBadge(it.bucket)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtNum(it.weight_kg)}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'exit', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        if (!(await implicationsDialog('تعديل تصريح خروج', [
          'ستُعكس حركة المخزون وأثر السليم الحالي ويُعاد تطبيق التصريح بالكميات الجديدة.',
        ]))) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('exits:get', id);
        if (!(await implicationsDialog('إلغاء تصريح خروج', [
          `سيُلغى أثر التصريح ${esc(doc.doc_number)} وتُعاد الكميات للمخزن وللسليم.`,
        ]))) return;
        await api.invoke('exits:void', id, currentUser().id);
        toast('تم إلغاء التصريح', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('warehouses:list'),
      ]);
      const suggest = doc ? null : await api.invoke('exits:suggest');

      const back = openModal(doc ? `تعديل تصريح خروج ${esc(doc.doc_number)}` : 'تصريح خروج جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم التصريح *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المخزن *</label>
            <select id="f-wh">${warehouses.map(w => `<option value="${w.id}" ${doc && doc.warehouse_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>اسم السائق *</label><input id="f-driver" value="${esc(doc ? doc.driver_name || '' : '')}"></div>
          <div class="field"><label>رقم السيارة</label><input id="f-car" value="${esc(doc ? doc.car_number || '' : '')}"></div>
          <div class="field"><label>جهة التسليم</label><input id="f-dest" value="${esc(doc ? doc.destination || '' : '')}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(doc ? doc.notes || '' : '')}"></div>
        </div>
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>الوحدة</th><th>الرصيد</th><th>الحبات / الوزن</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>إجمالي الحبات الخارجة</b></td>
            <td id="f-total">0</td><td colspan="2"></td>
          </tr></tfoot>
        </table>
        <button class="btn small" id="add-row" type="button">+ إضافة بند</button>`,
        [{ label: 'حفظ', class: 'primary', onClick: async (b) => {
          try {
            const itemsData = [...b.querySelectorAll('.irow')].map(r => ({
              item_id: Number(r.querySelector('.p-item').value),
              warehouse_id: Number(r.querySelector('.p-wh').value),
              quantity: parseFloat(r.querySelector('.p-qty').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
              bucket: r.querySelector('.p-bucket').value,
            })).filter(x => x.item_id);
            await api.invoke('exits:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              warehouse_id: Number(b.querySelector('#f-wh').value),
              driver_name: b.querySelector('#f-driver').value,
              car_number: b.querySelector('#f-car').value,
              destination: b.querySelector('#f-dest').value,
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
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
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
        const whSel = row.querySelector('.p-wh');
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
            const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
            const b = row.querySelector('.p-bucket').value;
            const av = bal['qty_' + b] || 0;
            const bl = { salem: 'سليم', talef: 'تالف', muharraz: 'محرز' }[b];
            balText.textContent = `الرصيد ${bl}: ${fmtNum(av, 0)} حبة`;
          } catch { balText.textContent = ''; }
          const pieces = toPieces(qty.value, unitSel.value, item);
          const kg = piecesToWeightKg(pieces || 0, item?.weight_grams || 0);
          calc.textContent = pieces != null
            ? `${fmtNum(pieces, 0)} حبة${kg ? ' — ' + fmtNum(kg) + ' كجم' : ''}`
            : '—';
          updateTotal();
        }
        itemSel.onchange = refresh;
        whSel.onchange = update;
        unitSel.onchange = update;
        qty.oninput = update;
        row.querySelector('.p-bucket').onchange = update;
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refresh();
      }

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
