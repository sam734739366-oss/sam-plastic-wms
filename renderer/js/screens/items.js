import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

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
  return {
    id: back.dataset.editId ? Number(back.dataset.editId) : null,
    code: digitsOnly(v('f-code')),
    name: v('f-name').trim(),
    unit_name: v('f-unit'),
    weight_grams: num(v('f-weight')) || null,
    pieces_per_carton: num(v('f-carton')) || null,
    pieces_per_shadda: num(v('f-shadda')) || null,
    pieces_per_bag: num(v('f-bag')) || null,
    qty_salem: num(v('f-salem')) || 0,
    qty_talef: num(v('f-talef')) || 0,
    qty_muharraz: num(v('f-muharraz')) || 0,
    notes: v('f-notes').trim() || null,
  };
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
  const total = (num(back.querySelector('#f-salem')?.value) || 0)
    + (num(back.querySelector('#f-talef')?.value) || 0)
    + (num(back.querySelector('#f-muharraz')?.value) || 0);
  const unit = back.querySelector('#f-unit')?.value || 'حبة';
  lines.push(`إجمالي الكمية = <b>${fmt(total)}</b> ${esc(unit)}`);
  conv.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
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

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="btn-add">+ إضافة صنف</button>
        <button class="btn" id="btn-import">استيراد من ملف</button>
        <span class="spacer"></span>
        <input id="f-search" placeholder="بحث بالكود أو الاسم…" style="width:230px">
      </div>
      <div id="summary" class="summary-line"></div>
      <div id="table-wrap"></div>`;

    el.querySelector('#btn-add').onclick = () => edit(null, () => refresh());
    el.querySelector('#btn-import').onclick = () => importModal(() => refresh());
    el.querySelector('#f-search').addEventListener('input', renderTableData);

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
        { key: 'weight', label: 'وزن الوحدة', render: weightCell },
        { key: 'pack', label: 'التعبئة', render: packCell },
        { key: 'salem', label: 'سليم', render: r => qtyCell(r, 'qty_salem', 'salem', 'سليم') },
        { key: 'talef', label: 'تالف', render: r => qtyCell(r, 'qty_talef', 'talef', 'تالف') },
        { key: 'muharraz', label: 'محرز', render: r => qtyCell(r, 'qty_muharraz', 'muharraz', 'محرز') },
        { key: 'notes', label: 'ملاحظات' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-del="${r.id}">حذف</button>`,
        },
      ], filtered);

      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit)), () => refresh());
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = rows.find(x => x.id === Number(b.dataset.del));
          if (!r) return;
          if (await confirmDialog(`حذف الصنف «${esc(r.name)}»؟`)) {
            try {
              await api.invoke('items:delete', r.id, currentUser().id);
              toast('تم حذف الصنف', 'ok');
              await refresh();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          }
        };
      });
    }

    async function refresh() {
      rows = await api.invoke('items:list');
      renderTableData();
    }

    function edit(row, onSaved) {
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
          <div class="field"><label>الكمية السليمة (سليم)</label><input id="f-salem" inputmode="numeric" value="${esc(row?.qty_salem || '')}"></div>
          <div class="field"><label>الكمية التالفة (تالف)</label><input id="f-talef" inputmode="numeric" value="${esc(row?.qty_talef || '')}"></div>
          <div class="field"><label>الكمية المحرزة (محرز)</label><input id="f-muharraz" inputmode="numeric" value="${esc(row?.qty_muharraz || '')}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(row?.notes || '')}"></div>
        </div>
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
      for (const id of ['f-weight', 'f-carton', 'f-shadda', 'f-bag', 'f-salem', 'f-talef', 'f-muharraz']) {
        back.querySelector(`#${id}`)?.addEventListener('input', () => updateConv(back));
      }
      updateConv(back);
    }

    function importModal(onDone) {
      const back = openModal('استيراد الأصناف من ملف', `
        <p style="line-height:1.8">اختر ملف CSV أو الصق البيانات (كل سطر صنف):<br>
        <small style="color:#64748b">كود ; اسم ; وحدة ; وزن ; كرتون ; شدة ; كيس ; سليم ; تالف ; محرز ; ملاحظات</small></p>
        <div class="field"><input type="file" id="imp-file" accept=".csv,.txt"></div>
        <div class="field"><label>أو الصق البيانات هنا</label><textarea id="imp-text" rows="6" style="font-family:monospace;font-size:12px"></textarea></div>
        <div id="imp-result" style="margin-top:8px;color:#2450c8;font-weight:bold"></div>
      `, [
        {
          label: 'استيراد', class: 'primary',
          onClick: async (b) => {
            try {
              const text = b.querySelector('#imp-text').value.trim();
              if (!text) { toast('لا توجد بيانات للاستيراد', 'err'); return; }
              const parsed = parseCsv(text);
              if (!parsed.length) { toast('لم يتم التعرف على أي صف صالح', 'err'); return; }
              const res = await api.invoke('items:import', parsed, currentUser().id);
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
