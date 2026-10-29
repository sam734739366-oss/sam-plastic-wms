import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, attachRowMenu, openModal, esc } from '../ui.js';

const UNITS = ['علبة', 'حبة', 'غطاء', 'كيس', 'كرتون', 'امبول'];

function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v)
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٬/g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : '';
}

function digitsOnly(v) {
  return String(v || '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^0-9]/g, '');
}

function fmt(v) {
  const n = num(v);
  return n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function packCell(r) {
  const parts = [];
  if (r.pieces_per_carton) parts.push(`كرتون ${fmt(r.pieces_per_carton)}`);
  if (r.pieces_per_shadda) parts.push(`شدة ${fmt(r.pieces_per_shadda)}`);
  if (r.pieces_per_bag) parts.push(`كيس ${fmt(r.pieces_per_bag)}`);
  return parts.join(' — ') || '—';
}

function weightCell(r) {
  return r.weight_grams ? `${fmt(r.weight_grams)} جم` : '—';
}

function qtyCell(r, key, cls, label) {
  return `<span class="tag ${cls}">${label}: ${fmt(r[key])}</span>`;
}

function collect(back) {
  const v = (id) => back.querySelector(`#${id}`)?.value ?? '';
  const opening_split = [];
  for (const tr of back.querySelectorAll('tr.s-row')) {
    const whId = Number(tr.dataset.wh) || null;
    opening_split.push({
      warehouse_id: whId,
      salem: num(tr.querySelector('.s-salem')?.value) || 0,
      talef: num(tr.querySelector('.s-talef')?.value) || 0,
      muharraz: num(tr.querySelector('.s-muharraz')?.value) || 0,
    });
  }
  return {
    id: back.dataset.editId ? Number(back.dataset.editId) : null,
    code: digitsOnly(v('f-code')),
    name: v('f-name').trim(),
    unit_name: v('f-unit'),
    weight_grams: num(v('f-weight')) || null,
    pieces_per_carton: num(v('f-carton')) || null,
    pieces_per_shadda: num(v('f-shadda')) || null,
    pieces_per_bag: num(v('f-bag')) || null,
    bag_item_id: num(v('f-bag-item')) || null,
    opening_split,
    is_complement: back.querySelector('#f-complement')?.checked ? 1 : 0,
    notes: v('f-notes').trim() || null,
  };
}

function sumInputs(back, sel) {
  let t = 0;
  for (const el of back.querySelectorAll(sel)) t += num(el?.value) || 0;
  return t;
}

function updateConv(back) {
  const conv = back.querySelector('#conv');
  if (!conv) return;
  const w = num(back.querySelector('#f-weight')?.value);
  const lines = [];
  if (w) {
    lines.push(`وزن 1000 وحدة = <b>${fmt(w)}</b> كجم`);
    const carton = num(back.querySelector('#f-carton')?.value);
    if (carton) lines.push(`وزن الكرتون (${fmt(carton)} قطعة) ≈ <b>${((w * carton) / 1000).toFixed(2)}</b> كجم`);
    const shadda = num(back.querySelector('#f-shadda')?.value);
    if (shadda) lines.push(`وزن الشدة (${fmt(shadda)} قطعة) ≈ <b>${((w * shadda) / 1000).toFixed(2)}</b> كجم`);
    const bag = num(back.querySelector('#f-bag')?.value);
    if (bag) lines.push(`وزن الكيس (${fmt(bag)} قطعة) ≈ <b>${((w * bag) / 1000).toFixed(2)}</b> كجم`);
  }
  const totalSalem = sumInputs(back, '.s-salem');
  const totalTalef = sumInputs(back, '.s-talef');
  const totalMuharraz = sumInputs(back, '.s-muharraz');
  const total = totalSalem + totalTalef + totalMuharraz;
  const unit = back.querySelector('#f-unit')?.value || 'حبة';
  lines.push(`إجمالي الكمية = <b>${fmt(total)}</b> ${esc(unit)}`);
  conv.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  const totSalem = back.querySelector('#tot-salem');
  const totTalef = back.querySelector('#tot-talef');
  const totMuharraz = back.querySelector('#tot-muharraz');
  if (totSalem) totSalem.textContent = fmt(totalSalem);
  if (totTalef) totTalef.textContent = fmt(totalTalef);
  if (totMuharraz) totMuharraz.textContent = fmt(totalMuharraz);
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line.split(/[;,\t]/).map(c => (c || '').trim());
    if (!cells[0] || /^(كود|code)$/i.test(cells[0])) continue;
    if (cells.length < 2) continue;
    const [code, name, unit, weight, carton, shadda, bag, salem, talef, muharraz, notes] = cells;
    const codeNorm = digitsOnly(code);
    if (!codeNorm || !name) continue;
    rows.push({
      code: codeNorm,
      name,
      unit_name: UNITS.includes(unit) ? unit : 'حبة',
      weight_grams: num(weight) || null,
      pieces_per_carton: num(carton) || null,
      pieces_per_shadda: num(shadda) || null,
      pieces_per_bag: num(bag) || null,
      qty_salem: num(salem) || 0,
      qty_talef: num(talef) || 0,
      qty_muharraz: num(muharraz) || 0,
      notes: notes || null,
    });
  }
  return rows;
}

register('items', {
  title: 'الأصناف',
  async mount(el) {
    let rows = [];
    let warehouses = [];

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة صنف</button>
        <button class="btn" id="btn-import">استيراد من ملف</button>
        <span class="spacer"></span>
        <button class="btn" id="btn-print">طباعة القائمة</button>
        <input id="f-search" placeholder="بحث بالكود أو الاسم…" style="width:230px">
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    el.querySelector('#btn-add').onclick = () => edit(null, () => refresh());
    el.querySelector('#btn-import').onclick = () => importModal(() => refresh());
    el.querySelector('#f-search').addEventListener('input', renderTableData);
    el.querySelector('#btn-print').onclick = async () => {
      const q = (el.querySelector('#f-search')?.value || '').trim();
      const filtered = q
        ? rows.filter(r => String(r.code).includes(q) || (r.name || '').includes(q))
        : rows;
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: 'قائمة الأصناف',
          metaLines: ['عدد الأصناف: ' + filtered.length, 'تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: ['الكود', 'الاسم', 'الوحدة', 'النوع', 'وزن الوحدة', 'التعبئة', 'سليم', 'تالف', 'محرز'],
          rows: filtered.map(r => [esc(r.code), esc(r.name), esc(r.unit_name), r.is_complement ? 'مكمل' : 'أساسي',
            weightCell(r).replace(/<[^>]*>/g, ''),
            packCell(r).replace(/<[^>]*>/g, ''), fmt(r.qty_salem), fmt(r.qty_talef), fmt(r.qty_muharraz)]),
          foot: `<div class="notes"><b>إجمالي — سليم: ${fmt(filtered.reduce((a, r) => a + (Number(r.qty_salem) || 0), 0))} — تالف: ${fmt(filtered.reduce((a, r) => a + (Number(r.qty_talef) || 0), 0))} — محرز: ${fmt(filtered.reduce((a, r) => a + (Number(r.qty_muharraz) || 0), 0))}</b></div>`,
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    function renderTableData() {
      const q = (el.querySelector('#f-search')?.value || '').trim();
      const filtered = q
        ? rows.filter(r => String(r.code).includes(q) || (r.name || '').includes(q))
        : rows;
      const s = filtered.reduce((a, r) => a + (Number(r.qty_salem) || 0), 0);
      const t = filtered.reduce((a, r) => a + (Number(r.qty_talef) || 0), 0);
      const m = filtered.reduce((a, r) => a + (Number(r.qty_muharraz) || 0), 0);
      el.querySelector('#summary').innerHTML =
        `عدد الأصناف: <b>${filtered.length}</b> — الكمية السليمة: <b>${fmt(s)}</b> — التالفة: <b>${fmt(t)}</b> — المحرزة: <b>${fmt(m)}</b>`;

      renderTable(el.querySelector('#table-wrap'), [
        { key: 'code', label: 'الكود' },
        { key: 'name', label: 'الاسم' },
        { key: 'unit_name', label: 'الوحدة' },
        { key: 'is_complement', label: 'النوع', render: r => r.is_complement ? '<span class="tag new">مكمل</span>' : '<span class="tag salem">أساسي</span>' },
        { key: 'weight', label: 'وزن الوحدة', render: weightCell },
        { key: 'pack', label: 'التعبئة', render: packCell },
        { key: 'salem', label: 'سليم', render: r => qtyCell(r, 'qty_salem', 'salem', 'سليم') },
        { key: 'talef', label: 'تالف', render: r => qtyCell(r, 'qty_talef', 'talef', 'تالف') },
        { key: 'muharraz', label: 'محرز', render: r => qtyCell(r, 'qty_muharraz', 'muharraz', 'محرز') },
        { key: 'notes', label: 'ملاحظات' },
      ], filtered);

      attachRowMenu(el.querySelector('#table-wrap'), (ri) => {
        const r = filtered[ri];
        return [
          { label: 'عرض', open: true, onClick: () => view(r) },
          { label: 'تعديل', onClick: () => edit(r, () => refresh()) },
          { label: 'حذف', danger: true, onClick: async () => {
            if (!(await confirmDialog(`حذف الصنف «${esc(r.name)}»؟`))) return;
            try {
              await api.invoke('items:delete', r.id, currentUser().id);
              toast('تم حذف الصنف', 'ok');
              await refresh();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          } },
        ];
      });
    }

    async function refresh() {
      [rows, warehouses] = await Promise.all([
        api.invoke('items:list'),
        api.invoke('warehouses:list'),
      ]);
      renderTableData();
    }

    function whOptions(selectedId) {
      return warehouses.map(w => `<option value="${w.id}" ${String(w.id) === String(selectedId) ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
    }

    function view(row) {
      const split = row.opening_split || [];
      const splitLines = split.length
        ? split.map((s) => {
          const name = warehouses.find(w => w.id === s.warehouse_id)?.name || `مخزن ${s.warehouse_id}`;
          const parts = [];
          if (s.salem) parts.push(`<span class="tag salem">سليم ${fmt(s.salem)}</span>`);
          if (s.talef) parts.push(`<span class="tag talef">تالف ${fmt(s.talef)}</span>`);
          if (s.muharraz) parts.push(`<span class="tag muharraz">محرز ${fmt(s.muharraz)}</span>`);
          return `<div style="margin:3px 0">${esc(name)}: ${parts.join(' ') || '<span class="muted">—</span>'}</div>`;
        }).join('')
        : '<span class="muted">—</span>';
      openModal(`عرض صنف ${esc(row.code)}`, `
        <div class="form-grid">
          <div class="field"><label>كود الصنف</label><span class="muted">${esc(row.code)}</span></div>
          <div class="field"><label>الاسم</label><span class="muted">${esc(row.name)}</span></div>
          <div class="field"><label>الوحدة</label><span class="muted">${esc(row.unit_name)}</span></div>
          <div class="field"><label>النوع</label><span class="muted">${row.is_complement ? 'صنف مكمل' : 'صنف أساسي'}</span></div>
          <div class="field"><label>وزن الوحدة</label><span class="muted">${row.weight_grams ? fmt(row.weight_grams) + ' جم' : '—'}</span></div>
          <div class="field"><label>التعبئة</label><span class="muted">${packCell(row)}</span></div>
          <div class="field"><label>سليم</label>${qtyCell(row, 'qty_salem', 'salem', 'سليم')}</div>
          <div class="field"><label>تالف</label>${qtyCell(row, 'qty_talef', 'talef', 'تالف')}</div>
          <div class="field"><label>محرز</label>${qtyCell(row, 'qty_muharraz', 'muharraz', 'محرز')}</div>
          <div class="field full"><label>التوزيع على المخازن</label><div>${splitLines}</div></div>
          <div class="field full"><label>ملاحظات</label><span class="muted">${esc(row.notes || '—')}</span></div>
        </div>`,
        [{ label: 'إغلاق', onClick: (b) => b.remove() }]);
    }

    function edit(row, onSaved) {
      const hasMoves = !!row?.has_moves;
      const splitMap = Object.fromEntries((row?.opening_split || []).map(s => [s.warehouse_id, s]));
      const splitRowsHtml = warehouses.length
        ? `<table class="split-table">
            <thead><tr><th>المخزن</th><th>سليم</th><th>تالف</th><th>محرز</th></tr></thead>
            <tbody>${warehouses.map(w => {
              const s = splitMap[w.id] || {};
              return `<tr class="s-row" data-wh="${w.id}">
                <td>${esc(w.name)}</td>
                <td><input class="s-salem" inputmode="numeric" value="${s.salem ? String(s.salem) : ''}" placeholder="0"></td>
                <td><input class="s-talef" inputmode="numeric" value="${s.talef ? String(s.talef) : ''}" placeholder="0"></td>
                <td><input class="s-muharraz" inputmode="numeric" value="${s.muharraz ? String(s.muharraz) : ''}" placeholder="0"></td>
              </tr>`;
            }).join('')}</tbody>
            <tfoot><tr><td>الإجمالي</td><td id="tot-salem">0</td><td id="tot-talef">0</td><td id="tot-muharraz">0</td></tr></tfoot>
          </table>`
        : '<p class="muted" style="margin:0">لا توجد مخازن — أنشئ مخزناً من شاشة المخازن قبل إدخال الأرصدة.</p>';
      const back = openModal(row ? 'تعديل صنف' : 'إضافة صنف', `
        <div class="form-grid">
          <div class="field"><label>كود الصنف * (أرقام فقط)</label><input id="f-code" inputmode="numeric" value="${esc(row?.code || '')}" placeholder="مثال: 101"></div>
          <div class="field"><label>اسم الصنف *</label><input id="f-name" value="${esc(row?.name || '')}"></div>
          <div class="field"><label>الوحدة *</label>
            <select id="f-unit">${UNITS.map(u => `<option value="${esc(u)}" ${row?.unit_name === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>وزن الوحدة (جرام)</label><input id="f-weight" inputmode="decimal" value="${esc(row?.weight_grams || '')}" placeholder="مثال: 5.02"></div>
          <div class="field"><label>عدد القطع في الكرتون (اختياري)</label><input id="f-carton" inputmode="numeric" value="${esc(row?.pieces_per_carton || '')}"></div>
          <div class="field"><label>عدد القطع في الشدة (اختياري)</label><input id="f-shadda" inputmode="numeric" value="${esc(row?.pieces_per_shadda || '')}"></div>
          <div class="field"><label>عدد القطع في الكيس (اختياري)</label><input id="f-bag" inputmode="numeric" value="${esc(row?.pieces_per_bag || '')}"></div>
          <div class="field"><label>صنف الأكياس المستهلكة (اختياري)</label>
            <select id="f-bag-item"><option value="">— بلا خصم آلي —</option>
              ${rows.filter(i => i.id !== row?.id).map(i => `<option value="${i.id}" ${row?.bag_item_id === i.id ? 'selected' : ''}>${esc(i.code)} — ${esc(i.name)}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:11px">عند استلام الإنتاج التام بوحدة الكيس يُخصم عدد الأكياس المستهلكة من رصيد هذا الصنف</span>
          </div>
          <div class="field full"><label>توزيع الرصيد الافتتاحي على المخازن</label>${splitRowsHtml}</div>
          <div class="field full"><label style="display:flex;align-items:center;gap:8px;margin:0;font-weight:600;cursor:pointer">
            <input type="checkbox" id="f-complement" ${row?.is_complement ? 'checked' : ''} style="width:auto;flex:none;accent-color:#2450c8">
            صنف مكمل — لا يظهر في جرد المخزون (مثل أغطية العبوات)</label></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(row?.notes || '')}"></div>
        </div>
        ${hasMoves
          ? '<p class="muted" style="margin:10px 0 0">لهذا الصنف حركات مخزون: الجدول يعرض الرصيد الحالي في كل مخزن، وتعديله يعيد توزيع الرصيد الافتتاحي ليصبح رصيد كل مخزن كما أدخلته ويظهر فوراً في كل التقارير، ولا يُقبل رصيد أقل من صافي حركات المخزن.</p>'
          : '<p class="muted" style="margin:10px 0 0">أدخل الرصيد الافتتاحي لكل مخزن في خاناته (جزء في مخزن وجزء في آخر)، واترك الخانات فارغة لصنف بلا كمية. الأرصدة تُسجَّل كحركات مخزون وتظهر فوراً في الجرد والتقارير وتصبح قابلة للصرف والبيع.</p>'}
        <div id="conv" style="margin-top:10px;color:#2450c8;font-size:13px;line-height:1.8"></div>
      `, [
        {
          label: 'حفظ', class: 'primary',
          onClick: async (b) => {
            try {
              await api.invoke('items:save', collect(b), currentUser().id);
              toast('تم حفظ الصنف', 'ok');
              b.remove();
              await onSaved();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
      if (row) back.dataset.editId = String(row.id);

      const codeInput = back.querySelector('#f-code');
      codeInput.addEventListener('input', () => {
        const before = codeInput.value;
        const after = digitsOnly(before);
        if (after !== before) codeInput.value = after;
      });

      back.querySelector('#f-unit').addEventListener('change', () => updateConv(back));
      for (const id of ['f-weight', 'f-carton', 'f-shadda', 'f-bag']) {
        back.querySelector(`#${id}`)?.addEventListener('input', () => updateConv(back));
      }
      for (const el of back.querySelectorAll('.s-row input')) {
        el.addEventListener('input', () => updateConv(back));
      }
      updateConv(back);
    }

    function importModal(onDone) {
      const back = openModal('استيراد الأصناف من ملف', `
        <p style="line-height:1.8">اختر ملف CSV أو الصق البيانات (كل سطر صنف):<br>
        <small style="color:#64748b">كود ; اسم ; وحدة ; وزن ; كرتون ; شدة ; كيس ; سليم ; تالف ; محرز ; ملاحظات</small></p>
        <div class="field"><label>مخزن الرصيد الافتتاحي *</label>
          <select id="imp-wh">${whOptions(warehouses[0]?.id || '')}</select></div>
        <div class="field"><input type="file" id="imp-file" accept=".csv,.txt"></div>
        <div class="field"><label>أو الصق البيانات هنا</label><textarea id="imp-text" rows="6" style="font-family:monospace;font-size:12px"></textarea></div>
        <div id="imp-result" style="margin-top:8px;color:#2450c8;font-weight:bold"></div>
      `, [
        {
          label: 'استيراد', class: 'primary',
          onClick: async (b) => {
            try {
              const wh = Number(b.querySelector('#imp-wh')?.value) || null;
              if (!wh) { toast('اختر مخزن الرصيد الافتتاحي', 'err'); return; }
              const text = b.querySelector('#imp-text').value.trim();
              if (!text) { toast('لا توجد بيانات للاستيراد', 'err'); return; }
              const parsed = parseCsv(text);
              if (!parsed.length) { toast('لم يتم التعرف على أي صف صالح', 'err'); return; }
              const res = await api.invoke('items:import', parsed, currentUser().id, wh);
              b.querySelector('#imp-result').textContent = `تم استيراد ${res.imported} صنف (تجاهل المكرر وغير الصالح: ${parsed.length - res.imported})`;
              toast(`تم استيراد ${res.imported} صنف`, 'ok');
              await onDone();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
      back.querySelector('#imp-file').addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { back.querySelector('#imp-text').value = String(reader.result || ''); };
        reader.readAsText(file, 'utf-8');
      });
    }

    await refresh();
  }
});
