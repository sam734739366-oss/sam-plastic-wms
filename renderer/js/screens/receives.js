import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, implicationsDialog, renderTable, attachRowMenu, openModal, esc , itemCombo, bucketOptions, bucketBadge} from '../ui.js';
import { unitOptionsFor, toPieces, piecesToWeightKg } from '../units.js';
import { fmtNum, today } from '../fmt.js';

register('receives', {
  title: 'استلام الإنتاج التام',
  async mount(el) {
    async function load() {
      const rows = await api.invoke('receives:list');
      el.innerHTML = `
        <div class="toolbar"><button class="btn primary" id="btn-add">+ تصريح استلام</button></div>
        <div id="summary" class="summary-line"></div>
        <div id="table-wrap"></div>`;
      el.querySelector('#btn-add').onclick = () => form(null);
      const active = rows.filter(r => r.status !== 'void');
      el.querySelector('#summary').innerHTML =
        `عدد التصاريح: <b>${rows.length}</b> — النشطة: <b>${active.length}</b> — حبات الاستلام من إنتاج المصنع: <b>${fmtNum(active.filter(r => r.source === 'own').reduce((a, r) => a + (Number(r.total_pieces) || 0), 0), 0)}</b>`;
      renderTable(el.querySelector('#table-wrap'), [
        { key: 'doc_number', label: 'الرقم', render: r => `<span dir="ltr">${esc(r.doc_number)}</span>` },
        { key: 'doc_date', label: 'التاريخ' },
        { key: 'source', label: 'المصدر', render: r => r.source === 'customer' ? '<span class="tag new">خام عميل</span>' : '<span class="tag salem">إنتاج المصنع</span>' },
        { key: 'party_name', label: 'العميل', render: r => r.party_name || '—' },
        { key: 'machine_name', label: 'المكينة', render: r => r.machine_name || '—' },
        { key: 'shift_name', label: 'الوردية', render: r => r.shift_name || '—' },
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
        const doc = await api.invoke('receives:get', id);
        await api.invoke('print:open', { kind: 'receive', doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function view(id) {
      try {
        const doc = await api.invoke('receives:get', id);
        openModal(`تصريح استلام ${esc(doc.doc_number)}`, `
          <p style="line-height:2">
            <b>التاريخ:</b> ${esc(doc.doc_date)} &nbsp; <b>المصدر:</b> ${doc.source === 'customer' ? 'خام عميل' : 'إنتاج المصنع'}
            ${doc.party_name ? `&nbsp; <b>العميل:</b> ${esc(doc.party_name)}` : ''}<br>
            <b>المكينة:</b> ${esc(doc.machine_name || '—')} &nbsp; <b>الوردية:</b> ${esc(doc.shift_name || '—')} &nbsp; <b>المستلم:</b> ${esc(doc.receiver_name || '—')}<br>
            ${doc.issue_number ? `<b>تصريح الصرف المرتبط:</b> <span dir="ltr">${esc(doc.issue_number)}</span>` : ''}</p>
          <table class="data"><thead><tr><th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>الحبات</th><th>الوزن كجم</th></tr></thead>
          <tbody>${doc.items.map(it => `<tr><td>${esc(it.code)} — ${esc(it.name)}</td><td>${esc(it.warehouse_name)}</td>
            <td>${bucketBadge(it.bucket)}</td>
            <td>${fmtNum(it.quantity)} ${esc(it.unit)}</td><td>${fmtNum(it.pieces, 0)}</td>
            <td>${fmtNum(it.weight_kg)}</td></tr>`).join('')}</tbody></table>
          ${doc.notes ? `<p style="margin-top:8px"><b>ملاحظات:</b> ${esc(doc.notes)}</p>` : ''}`,
          [{ label: 'طباعة', onClick: async (b) => { try { b.disabled = true; await api.invoke('print:open', { kind: 'receive', doc, settings: await api.invoke('settings:get') }); } catch (e) { toast(String(e.message || e), 'err'); } b.disabled = false; } },
            { label: 'إغلاق', onClick: (b) => b.remove() }]);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function edit(id) {
      try {
        const doc = await api.invoke('receives:get', id);
        const ok = await implicationsDialog('تعديل تصريح استلام', [
          'ستُعكس حركة المخزون الحالية ويُعاد تطبيق التصريح بالكميات الجديدة.',
        ]);
        if (!ok) return;
        form(doc);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function voidDoc(id) {
      try {
        const doc = await api.invoke('receives:get', id);
        if (!(await implicationsDialog('إلغاء تصريح استلام', [
          `سيُلغى أثر التصريح ${esc(doc.doc_number)} على المخزون (تُخصم الكميات المستلمة).`,
        ]))) return;
        await api.invoke('receives:void', id, currentUser().id);
        toast('تم إلغاء التصريح', 'ok');
        await load();
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    async function form(doc) {
      const [items, parties, machines, shifts, warehouses, issues] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('parties:list', null),
        api.invoke('machines:list'),
        api.invoke('shifts:list'),
        api.invoke('warehouses:list'),
        api.invoke('issues:list'),
      ]);
      const customers = parties.filter(p => p.type === 'customer' || p.type === 'both');
      const activeIssues = issues.filter(p => p.status !== 'void');
      const suggest = doc ? null : await api.invoke('receives:suggest');

      const back = openModal(doc ? `تعديل تصريح استلام ${esc(doc.doc_number)}` : 'تصريح استلام جديد', `
        <div class="form-grid">
          <div class="field"><label>رقم التصريح *</label><input id="f-num" value="${esc(doc ? doc.doc_number : suggest)}" dir="ltr"></div>
          <div class="field"><label>التاريخ *</label><input id="f-date" type="date" value="${esc(doc ? doc.doc_date : today())}"></div>
          <div class="field"><label>المصدر</label>
            <select id="f-source">
              <option value="own" ${doc && doc.source === 'own' ? 'selected' : ''}>إنتاج المصنع</option>
              <option value="customer" ${doc && doc.source === 'customer' ? 'selected' : ''}>خام عميل</option>
            </select></div>
          <div class="field" id="w-party"><label>العميل *</label>
            <select id="f-party"><option value="">— اختر العميل —</option>
              ${customers.map(p => `<option value="${p.id}" ${doc && doc.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
          <div class="field" id="w-issue"><label>تصريح الصرف المرتبط</label>
            <select id="f-issue"><option value="">— بدون (اختياري) —</option>
              ${activeIssues.map(p => `<option value="${p.id}" ${doc && doc.issue_permit_id === p.id ? 'selected' : ''}>${esc(p.doc_number)} — ${esc(p.doc_date)}${p.machine_name ? ' (' + esc(p.machine_name) + ')' : ''}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:11px">يربط الاستلام بدورة الكراتين لمتابعة النقص والزيادة</span></div>
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
            <th>الصنف</th><th>المخزن</th><th>السلة</th><th>الكمية</th><th>كسور</th><th>الوحدة</th><th>الحبات / الوزن</th><th>ملاحظات</th><th></th>
          </tr></thead>
          <tbody id="irows"></tbody>
          <tfoot><tr>
            <td colspan="6"><b>إجمالي الحبات المستلمة</b></td>
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
              breaks: Number(r.querySelector('.p-breaks').value) || 0,
              unit: r.querySelector('.p-unit').value,
              notes: r.querySelector('.p-notes').value,
              bucket: r.querySelector('.p-bucket').value,
            })).filter(x => x.item_id);
            await api.invoke('receives:save', {
              id: doc ? doc.id : null,
              doc_number: b.querySelector('#f-num').value,
              doc_date: b.querySelector('#f-date').value,
              source: b.querySelector('#f-source').value,
              party_id: b.querySelector('#f-party').value ? Number(b.querySelector('#f-party').value) : null,
              issue_permit_id: b.querySelector('#f-issue').value ? Number(b.querySelector('#f-issue').value) : null,
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
      const applySource = () => {
        back.querySelector('#w-party').style.display = isCustomer() ? '' : 'none';
        back.querySelector('#w-issue').style.display = isCustomer() ? 'none' : '';
      };
      back.querySelector('#f-source').onchange = applySource;

      // نفس حساب المخدَم: الحبات = مكتملة × حبات/كيس + كسور، والأكياس = ceil(الحبات ÷ حبات/كيس)
      function linePieces(rowEl) {
        const item = itemById(Number(rowEl.querySelector('.p-item').value));
        const unit = rowEl.querySelector('.p-unit').value;
        const qty = rowEl.querySelector('.p-qty').value;
        const breaks = Number(rowEl.querySelector('.p-breaks').value) || 0;
        const per = Number(item?.pieces_per_bag) || 0;
        if (unit === 'كيس' && per > 0) {
          const total = (Math.round(Number(qty) || 0) * per) + breaks;
          return { pieces: total, bags: Math.ceil(total / per), per };
        }
        return { pieces: toPieces(qty, unit, item) || 0, bags: 0, per };
      }

      function updateTotal() {
        let total = 0;
        for (const r of rowsWrap.querySelectorAll('.irow')) total += linePieces(r).pieces;
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
          <td><input class="p-breaks num" type="number" min="0" step="1" value="${esc(data.breaks ?? '')}" title="حبات مفردة بعد آخر كيس" disabled style="max-width:80px"></td>
          <td><select class="p-unit"></select></td>
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
        const breaksEl = row.querySelector('.p-breaks');
        const calc = row.querySelector('.p-calc');

        function refreshUnits() {
          const item = itemById(Number(itemSel.value));
          const cur = unitSel.value;
          const opts = unitOptionsFor(item);
          unitSel.innerHTML = opts.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
          if (opts.some(o => o.value === cur)) unitSel.value = cur;
          else if (data.unit && opts.some(o => o.value === data.unit)) unitSel.value = data.unit;
        }

        function refresh() {
          refreshUnits();
          const item = itemById(Number(itemSel.value));
          // الكسور تُكتب فقط عندما تكون الوحدة كيساً والصنف له «حبات/كيس»
          const baggable = unitSel.value === 'كيس' && Number(item?.pieces_per_bag) > 0;
          breaksEl.disabled = !baggable;
          if (!baggable) breaksEl.value = '';
          const { pieces, bags } = linePieces(row);
          if (pieces != null && pieces > 0) {
            const kg = piecesToWeightKg(pieces, item.weight_grams);
            calc.textContent = `${fmtNum(pieces, 0)} حبة${baggable ? ` — ${fmtNum(bags, 0)} كيس` : ''}${kg ? ' — ' + fmtNum(kg) + ' كجم' : ''}`;
          } else {
            calc.textContent = '—';
          }
          updateTotal();
        }

        itemSel.onchange = refresh;
        unitSel.onchange = refresh;
        qty.oninput = refresh;
        breaksEl.oninput = refresh;
        if (data.item_id) combo.setValue(data.item_id);
        if (data.warehouse_id) row.querySelector('.p-wh').value = String(data.warehouse_id);
        refresh();
      }

      if (doc && doc.items.length) {
        for (const it of doc.items) {
          addRow({ item_id: it.item_id, warehouse_id: it.warehouse_id, quantity: it.quantity, breaks: it.breaks, unit: it.unit, notes: it.notes, bucket: it.bucket });
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
