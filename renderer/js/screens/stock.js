import { register } from '../router.js';
import { api } from '../api.js';
import { toast, renderTable, esc } from '../ui.js';

const GROUP_NAMES = { 1: 'مواد أولية', 2: 'إنتاج تام', 3: 'خام للغير', 4: 'خدمات نفخ', 5: 'توالف' };

register('stock', {
  title: 'جرد المخزون',
  async mount(el) {
    const warehouses = await api.invoke('warehouses:list');
    el.innerHTML = `
      <div class="toolbar">
        <select id="f-warehouse"><option value="">كل المخازن</option>
          ${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
        <select id="f-group"><option value="">كل المجموعات</option>
          ${[1, 2, 3, 4, 5].map(g => `<option value="${g}">${g} — ${GROUP_NAMES[g]}</option>`).join('')}</select>
        <button class="btn primary" id="btn-run">عرض الجرد</button>
      </div>
      <div class="summary-line" id="summary"></div>
      <div id="table-wrap"></div>`;

    async function load() {
      try {
        const filters = {
          warehouseId: Number(el.querySelector('#f-warehouse').value) || null,
          group: Number(el.querySelector('#f-group').value) || null,
        };
        const rows = await api.invoke('reports:inventory', filters);
        const totalPieces = rows.reduce((s, r) => s + r.balance_pieces, 0);
        const totalKg = rows.reduce((s, r) => s + r.balance_kg, 0);
        el.querySelector('#summary').innerHTML =
          `<b>عدد الأصناف:</b> ${rows.length} &nbsp; <b>إجمالي الحبات:</b> ${totalPieces.toLocaleString('en-US')} &nbsp; <b>إجمالي الوزن:</b> ${totalKg.toLocaleString('en-US', { maximumFractionDigits: 2 })} كجم`;
        renderTable(el.querySelector('#table-wrap'), [
          { key: 'code', label: 'الكود' },
          { key: 'name', label: 'الصنف' },
          { key: 'item_group', label: 'المجموعة', render: r => GROUP_NAMES[r.item_group] || r.item_group },
          { key: 'balance_label', label: 'الرصيد' },
          { key: 'balance_kg', label: 'الوزن كجم', render: r => Number(r.balance_kg || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) },
        ], rows);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-run').onclick = load;
    el.querySelectorAll('#f-warehouse, #f-group').forEach(s => s.onchange = load);
    await load();
  },
});
