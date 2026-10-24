import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, implicationsDialog, renderTable, attachRowMenu, openModal, esc , itemCombo} from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtNum, today } from '../fmt.js';

register('issues', {
  title: 'تصاريح الصرف للإنتاج',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('issues:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تصريح صرف</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      const own = active.filter(r => r.source === 'own');
      el.querySelector('#summary').innerHTML =
        `عدد التصاريح: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — حبات الصرف من خام المصنع: <b>${fmtNum(own.reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'source', label: 'المصدر', render: r => r.source === 'customer' ? '<span class="tag new">خام عميل</span>' : '<span class="tag salem">خام المصنع</span>' },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'machine_name', label: 'المكينة', render: r => r.machine_name || '—' },
        { key: 'shift_name', label: 'الوردية', render: r => r.shift_name || '—' },
        { key: 'receiver_name', label: 'المستلم', render: r => r.receiver_name || '—' },
        { key: 'total_pieces', label: 'الحبات', render: r => fmtNum(r.total_pieces, 0) },
        { key: 'status', label: 'الحالة', render: r => r.status === 'void' ? '<span class="void-badge">ملغى</span>' : '<span class="tag salem">نشط</span>' },
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
        const doc = await api.invoke('issues:get', id);
        await api.invoke('print:open', { kind: 'issue', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('issues:get', id);
        openModal(`تصريح صرف ${esc(doc.doc_number)}`, `
          <p style="line-height:2">
            <b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المصدر:</b> ${doc.source === 'customer' ? 'خام عميل' : 'خام المصنع'}
            ${doc.party_name ? `&nbsp; <b>العميل:</b> ${esc(doc.party_name)}` : ''}<br>
            <b>المكينة:</b> ${esc(doc.machine_name || '—')} &nbsp; <b>الوردية:</b> ${esc(doc.shift_name || '—')} &nbsp; <b>المستلم:</b> ${esc(doc.receiver_name || '—')}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th><th>الكراتين</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td><td>${fmtNum(it.weight_kg)}</td>
            <td>${it.carton_ids.map(c => `<span class="tag recycled">${esc(c)}</span>`).join(' ') || '—'}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'issue', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('issues:get', id);
        if (doc.cartons.some(c => c.status === 'finished')) {
          toast('لا يمكن تعديل التصريح — توجد نتائج إنتاج على كراتينه', 'err');
          return;
        }
        if (doc.cartons.length) {
          const ok = await implicationsDialog('تعديل تصريح صرف', [
            'ستُعاد الكراتين التالية للمخزن ثم يُعاد تطبيق التصريح بعد التعديل:',
            doc.cartons.map(c => c.carton_number).join(' ، '),
          ]);
          if (!ok) return;
        }
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('issues:get', id);
        if (doc.cartons.some(c => c.status === 'finished')) {
          toast('لا يمكن إلغاء التصريح — توجد نتائج إنتاج على كراتينه، احذفها أولاً', 'err');
          return;
        }
        const lines = ['سيُلغى أثر التصريح على المخزون وأرصدة سليم، وتُعاد الكراتين للمخزن.'];
        if (!(await implicationsDialog('إلغاء تصريح صرف', lines))) return;
        await api.invoke('issues:void', id, currentUser().id);
        toast('تم إلغاء التصريح', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, machines, shifts, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('machines:list'),
        api.invoke('shifts:list'),
        api.invoke('warehouses:list'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      const suggest = doc ? null : await api.invoke('issues:suggest');

      const back = openModal(doc ? `تعديل تصريح صرف ${esc(doc.doc_number)}` : 'تصريح صرف جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم التصريح *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المصدر</label>
            <select id="f-source">
              <option value="own" ${doc && doc.source === 'own' ? 'selected' : ''}>خام المصنع</option>
              <option value="customer" ${doc && doc.source === 'customer' ? 'selected' : ''}>خام عميل</option>
            </select></div>
          <div class="field" id="w-party"><label>العميل</label>
            <select id="f-party"><option value="">— بدون عميل —</option>
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
        <table class="doc-lines">
          <thead><tr>
            <th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>الرصيد / الكراتين</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="4"><b>إجمالي الحبات المصروفة</b></td>
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
              carton_ids: r._cartons || [],
              notes: r.querySelector('.p-notes').value,
            })).filter(x => x.item_id);
            await api.invoke('issues:save', {
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

      const rowsWrap = back.querySelector('#irows');
      const totalEl = back.querySelector('#f-total');
      const itemById = (id) => items.find(i => i.id === id);
      const isCustomer = () => back.querySelector('#f-source').value === 'customer';

      function updateTotal() {
        let total = 0;
        for (const r of rowsWrap.querySelectorAll('.irow')) {
          const item = itemById(Number(r.querySelector('.p-item').value));
          total += toPieces(r.querySelector('.p-qty').value, r.querySelector('.p-unit').value, item) || 0;
        }
        totalEl.textContent = fmtNum(total, 0) + ' حبة';
      }

      const applySource = () => {
        back.querySelector('#w-party').style.display = isCustomer() ? '' : 'none';
        [...rowsWrap.querySelectorAll('.irow')].forEach(r => r._refresh && r._refresh());
      };
      back.querySelector('#f-source').onchange = applySource;

      function addRow(data = {}) {
        const row = document.createElement('tr');
        row.className = 'irow';
        row.innerHTML = `
          <td class="p-item-td"></td>
          <td><select class="p-wh">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></td>
          <td><input class="p-qty num" type="number" min="0" step="any" value="${esc(data.quantity ?? '')}"></td>
          <td><select class="p-unit"></select></td>
          <td><div class="p-bal"><span class="bal-text muted"></span><button class="btn mini pick-btn" type="button" hidden>اختيار كراتين</button><div class="carton-tags"></div></div></td>
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
        const pickBtn = row.querySelector('.pick-btn');
        const tags = row.querySelector('.carton-tags');
        row._cartons = data.carton_ids || [];

        function refreshUnits() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
        }

        function renderTags() {
          tags.innerHTML = row._cartons.map(c => `<span class="tag recycled">${esc(c)}</span>`).join(' ');
          pickBtn.textContent = row._cartons.length ? `الكراتين (${row._cartons.length})` : 'اختيار كراتين';
          qty.readOnly = row._cartons.length > 0;
          if (row._cartons.length) qty.value = row._cartons.length;
          updateTotal();
        }

        async function refreshRow() {
          refreshUnits();
          renderTags();
          const item = itemById(Number(itemSel.value));
          const showPick = !isCustomer() && unitSel.value === 'كرتون' && item.pieces_per_carton;
          pickBtn.hidden = !showPick;
          if (isCustomer()) {
            balText.textContent = 'لا يمس مخزون المصنع';
          } else {
            balText.textContent = '…';
            try {
              const bal = await api.invoke('stock:balance', item.id, Number(whSel.value));
              const kg = piecesToWeightKg(bal.balance_pieces, item.weight_grams);
              balText.textContent = `الرصيد: ${fmtNum(bal.balance_pieces, 0)} حبة${kg ? ' — ' + fmtNum(kg) + ' كجم' : ''}`;
            } catch { balText.textContent = ''; }
          }
          updateTotal();
        }

        pickBtn.onclick = async () => {
          const item = itemById(Number(itemSel.value));
          const avail = await api.invoke('issues:cartonsAvailable', item.id);
          openModal(`كراتين متاحة — ${esc(item.name)}`, `
            <div style="max-height:300px;overflow:auto;line-height:2.2">
              ${avail.length ? avail.map(c => `<label class="check" style="display:block;cursor:pointer">
                <input type="checkbox" value="${esc(c.carton_number)}" ${row._cartons.includes(c.carton_number) ? 'checked' : ''}>
                ${esc(c.carton_number)} (${esc(c.pieces)} حبة — فاتورة ${esc(c.purchase_number || '—')})</label>`).join('')
                : '<p class="muted">لا توجد كراتين متاحة لهذا الصنف</p>'}
            </div>`,
            [{ label: 'تأكيد', class: 'primary', onClick: (b) => {
              row._cartons = [...b.querySelectorAll('input:checked')].map(c => c.value);
              b.remove(); renderTags();
            } }, { label: 'إلغاء', onClick: (b) => b.remove() }]);
        };

        itemSel.onchange = refreshRow;
        whSel.onchange = refreshRow;
        unitSel.onchange = refreshRow;
        qty.oninput = updateTotal;
        row._refresh = refreshRow;
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) whSel.value = String(data.warehouse_id);
        refreshRow();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({
            item_id: it.item_id, warehouse_id: it.warehouse_id,
            quantity: it.quantity, unit: it.unit, notes: it.notes, carton_ids: it.carton_ids,
          });
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
