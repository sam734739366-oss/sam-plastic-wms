import { register } from '../router.js';
import { api, currentUser } from '../api.js';
import { toast, confirmDialog, renderTable, openModal, esc } from '../ui.js';

const GROUP_NAMES = { 1: 'مواد أولية', 2: 'إنتاج تام', 3: 'خام للغير', 4: 'خدمات نفخ', 5: 'توالف' };
const UNIT_OPTIONS = {
  1: ['امبولة', 'حبة', 'كيس', 'كرتون', 'بالة'],
  2: ['علبة', 'حبة'],
  3: ['امبولة', 'علبة'],
  4: ['علبة'],
  5: ['علبة', 'حبة'],
};

function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : '';
}

function fmtNum(v) {
  const n = num(v);
  return n === '' ? '' : String(n);
}

function packCell(r) {
  const parts = [];
  if (r.weight_grams) parts.push(`الوزن ${fmtNum(r.weight_grams)} جم`);
  if (r.pieces_per_carton) parts.push(`الكرتون ${fmtNum(r.pieces_per_carton)}`);
  if (r.pieces_per_bag) parts.push(`الكيس ${fmtNum(r.pieces_per_bag)}`);
  if (r.service_price) parts.push(`الأجرة ${fmtNum(r.service_price)} ريال`);
  return parts.join(' — ') || '';
}

function typeCell(r) {
  return r.is_recycled
    ? '<span class="tag recycled">محرز</span>'
    : '<span class="tag new">جديد</span>';
}

function showFields(back, g) {
  g = Number(g);
  const toggle = (id, on) => {
    const f = back.querySelector(`#${id}`);
    if (f) f.style.display = on ? '' : 'none';
  };
  toggle('w-weight', g === 1 || g === 2 || g === 3);
  toggle('w-carton', g === 1);
  toggle('w-bag', g === 2);
  toggle('w-price', g === 4);
  toggle('w-recycled', g === 1);
  toggle('w-bale', g === 1);
  toggle('w-bale2', g === 1);
  toggle('w-bale3', g === 1);

  const sel = back.querySelector('#f-unit');
  if (sel) {
    const opts = UNIT_OPTIONS[g] || [];
    const cur = sel.value;
    sel.innerHTML = opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    if (opts.includes(cur)) sel.value = cur;
  }
  updateConv(back);
}

function updateConv(back) {
  const conv = back.querySelector('#conv');
  if (!conv) return;
  const g = Number(back.querySelector('#f-group')?.value || 0);
  const w = num(back.querySelector('#f-weight')?.value);
  const lines = [];
  if ((g === 1 || g === 2 || g === 3) && w) {
    lines.push(`وزن 1000 حبة = <b>${(w * 1000 / 1000).toFixed(3)}</b> كجم`);
    const carton = num(back.querySelector('#f-carton')?.value);
    if (g === 1 && carton) lines.push(`وزن الكرتون (${fmtNum(carton)} حبة) ≈ <b>${(w * carton / 1000).toFixed(2)}</b> كجم`);
    const bag = num(back.querySelector('#f-bag')?.value);
    if (g === 2 && bag) lines.push(`وزن الكيس (${fmtNum(bag)} حبة) ≈ <b>${(w * bag / 1000).toFixed(2)}</b> كجم`);
  }
  conv.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

function collect(back) {
  const v = (id) => back.querySelector(`#${id}`)?.value ?? '';
  return {
    id: back.dataset.editId ? Number(back.dataset.editId) : null,
    code: v('f-code').trim(),
    name: v('f-name').trim(),
    item_group: Number(v('f-group')),
    unit_name: v('f-unit'),
    weight_grams: num(v('f-weight')) || null,
    pieces_per_carton: num(v('f-carton')) || null,
    pieces_per_bag: num(v('f-bag')) || null,
    service_price: num(v('f-price')) || null,
    is_recycled: back.querySelector('#f-recycled')?.checked ? 1 : 0,
    brand: v('f-brand').trim() || null,
    size_label: v('f-size').trim() || null,
    bale_size: v('f-bale-size').trim() || null,
    bale_condition: v('f-bale-cond').trim() || null,
    bale_mixed: back.querySelector('#f-mixed')?.checked ? 1 : 0,
    notes: v('f-notes').trim() || null,
  };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line.split(/[;,\t]/).map(c => (c || '').trim());
    if (!cells[0] || /^(كود|code)$/i.test(cells[0])) continue;
    if (cells.length < 3) continue;
    const [code, name, groupStr, unit, weight, carton, bag, price, recycled, brand, size, notes] = cells;
    const group = Number(groupStr);
    if (!(group >= 1 && group <= 5)) continue;
    rows.push({
      code, name, item_group: group, unit_name: unit || 'حبة',
      weight_grams: num(weight) || null,
      pieces_per_carton: num(carton) || null,
      pieces_per_bag: num(bag) || null,
      service_price: num(price) || null,
      is_recycled: /^(1|نعم|محرز|true)$/i.test(recycled || '') ? 1 : 0,
      brand: brand || null, size_label: size || null, notes: notes || null,
    });
  }
  return rows;
}

register('items', {
  title: 'الأصناف',
  async mount(el) {
    let currentGroup = 0;

    async function load() {
      const rows = await api.invoke('items:list', currentGroup || null);
      const pills = [
        { g: 0, label: 'الكل' },
        ...[1, 2, 3, 4, 5].map(g => ({ g, label: `${g} — ${GROUP_NAMES[g]}` })),
      ];
      el.innerHTML = `
        <div class="filters">${pills.map(p => `<button class="pill ${currentGroup === p.g ? 'active' : ''}" data-g="${p.g}">${esc(p.label)}</button>`).join('')}</div>
        <div class="toolbar">
          <button class="btn primary" id="btn-add">+ إضافة صنف</button>
          <button class="btn" id="btn-import">استيراد من ملف</button>
        </div>
        <div id="table-wrap"></div>`;

      el.querySelectorAll('.pill').forEach(p => {
        p.onclick = () => { currentGroup = Number(p.dataset.g); load(); };
      });
      el.querySelector('#btn-add').onclick = () => edit(null);
      el.querySelector('#btn-import').onclick = importModal;

      renderTable(el.querySelector('#table-wrap'), [
        { key: 'code', label: 'الكود' },
        { key: 'name', label: 'الاسم' },
        { key: 'item_group', label: 'المجموعة', render: r => GROUP_NAMES[r.item_group] || r.item_group },
        { key: 'unit_name', label: 'الوحدة' },
        { key: 'pack', label: 'العبوة / الوزن', render: packCell },
        { key: 'type', label: 'النوع', render: typeCell },
        { key: 'notes', label: 'ملاحظات' },
        {
          key: 'actions', label: '',
          render: (r) => `<button class="btn mini" data-edit="${r.id}">تعديل</button>
            <button class="btn mini danger" data-del="${r.id}">حذف</button>`,
        },
      ], rows);

      el.querySelectorAll('[data-edit]').forEach(b => {
        b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit)));
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = async () => {
          const r = rows.find(x => x.id === Number(b.dataset.del));
          if (!r) return;
          if (await confirmDialog(`حذف الصنف «${esc(r.name)}»؟`)) {
            try {
              await api.invoke('items:delete', r.id, currentUser().id);
              toast('تم حذف الصنف', 'ok');
              await load();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          }
        };
      });
    }

    function edit(row) {
      const back = openModal(row ? 'تعديل صنف' : 'إضافة صنف', `
        <div class="form-grid">
          <div class="field"><label>كود الصنف *</label><input id="f-code" value="${esc(row?.code || '')}" placeholder="مثال: 001-020"></div>
          <div class="field"><label>اسم الصنف *</label><input id="f-name" value="${esc(row?.name || '')}"></div>
          <div class="field"><label>المجموعة</label>
            <select id="f-group">${[1, 2, 3, 4, 5].map(g => `<option value="${g}" ${row?.item_group === g ? 'selected' : ''}>${g} — ${GROUP_NAMES[g]}</option>`).join('')}</select>
          </div>
          <div class="field"><label>الوحدة</label><select id="f-unit"></select></div>
          <div class="field" id="w-weight"><label>وزن الحبة (جرام)</label><input id="f-weight" value="${esc(row?.weight_grams || '')}"></div>
          <div class="field" id="w-carton"><label>عدد الحبات في الكرتون</label><input id="f-carton" value="${esc(row?.pieces_per_carton || '')}"></div>
          <div class="field" id="w-bag"><label>عدد الحبات في الكيس</label><input id="f-bag" value="${esc(row?.pieces_per_bag || '')}"></div>
          <div class="field" id="w-price"><label>سعر أجرة النفخ (ريال)</label><input id="f-price" value="${esc(row?.service_price || '')}"></div>
          <div class="field" id="w-recycled"><label>محرز؟</label><label class="check"><input type="checkbox" id="f-recycled" ${row?.is_recycled ? 'checked' : ''}> صنف محرز (مُعاد)</label></div>
          <div class="field" id="w-bale"><label>حجم البالة</label><input id="f-bale-size" value="${esc(row?.bale_size || '')}"></div>
          <div class="field" id="w-bale2"><label>حالة البالة</label><input id="f-bale-cond" value="${esc(row?.bale_condition || '')}"></div>
          <div class="field" id="w-bale3"><label>بالة مخلطة؟</label><label class="check"><input type="checkbox" id="f-mixed" ${row?.bale_mixed ? 'checked' : ''}> مخلطة</label></div>
          <div class="field"><label>العلامة التجارية</label><input id="f-brand" value="${esc(row?.brand || '')}"></div>
          <div class="field"><label>المقاس</label><input id="f-size" value="${esc(row?.size_label || '')}"></div>
          <div class="field full"><label>ملاحظات</label><input id="f-notes" value="${esc(row?.notes || '')}"></div>
        </div>
        <div id="conv" style="margin-top:10px;color:#0f766e;font-size:13px;line-height:1.8"></div>
      `, [
        {
          label: 'حفظ', class: 'primary',
          onClick: async (b) => {
            try {
              await api.invoke('items:save', collect(b), currentUser().id);
              toast('تم حفظ الصنف', 'ok');
              b.remove();
              await load();
            } catch (err) {
              toast(String(err.message || err), 'err');
            }
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
      if (row) back.dataset.editId = String(row.id);
      back.querySelector('#f-group').addEventListener('change', () => showFields(back, back.querySelector('#f-group').value));
      for (const id of ['f-weight', 'f-carton', 'f-bag', 'f-price']) {
        back.querySelector(`#${id}`)?.addEventListener('input', () => updateConv(back));
      }
      showFields(back, row?.item_group || 1);
    }

    function importModal() {
      const back = openModal('استيراد الأصناف من ملف', `
        <p style="line-height:1.8">اختر ملف CSV أو الصق البيانات (كل سطر صنف):<br>
        <small style="color:#64748b">كود ; اسم ; مجموعة ; وحدة ; وزن ; كرتون ; كيس ; سعر ; محرز ; علامة ; مقاس ; ملاحظات</small></p>
        <div class="field"><input type="file" id="imp-file" accept=".csv,.txt"></div>
        <div class="field"><label>أو الصق البيانات هنا</label><textarea id="imp-text" rows="6" style="font-family:monospace;font-size:12px"></textarea></div>
        <div id="imp-result" style="margin-top:8px;color:#0f766e;font-weight:bold"></div>
      `, [
        {
          label: 'استيراد', class: 'primary',
          onClick: async (b) => {
            try {
              const text = b.querySelector('#imp-text').value.trim();
              if (!text) { toast('لا توجد بيانات للاستيراد', 'err'); return; }
              const rows = parseCsv(text);
              if (!rows.length) { toast('لم يتم التعرف على أي صف صالح', 'err'); return; }
              const res = await api.invoke('items:import', rows, currentUser().id);
              b.querySelector('#imp-result').textContent = `تم استيراد ${res.imported} صنف (تجاهل المكرر: ${rows.length - res.imported})`;
              toast(`تم استيراد ${res.imported} صنف`, 'ok');
              await load();
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

    await load();
  }
});
