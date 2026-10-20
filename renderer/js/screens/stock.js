import { register } from '../router.js';
import { api } from '../api.js';
import { toast, renderTable, esc } from '../ui.js';
import { fmtNum } from '../fmt.js';

register('stock', {
  title: 'جرد المخزون',
  async mount(el) {
    const warehouses = await api.invoke('warehouses:list');
    el.innerHTML = `
      <div class="toolbar">
        <select id="f-warehouse"><option value="">كل المخازن</option>
          ${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
        <button class="btn primary" id="btn-run">عرض الجرد</button>
      </div>
      <div class="summary-line" id="summary"></div>
      <div id="table-wrap"></div>`;

    async function load() {
      try {
        const filters = {
          warehouseId: Number(el.querySelector('#f-warehouse').value) || null,
        };
        const rows = await api.invoke('reports:inventory', filters);
        const totalPieces = rows.reduce((s, r) => s + r.balance_pieces, 0);
        const totalKg = rows.reduce((s, r) => s + r.balance_kg, 0);
        el.querySelector('#summary').innerHTML =
          `<b>عدد الأصناف:</b> ${rows.length} &nbsp; <b>إجمالي الحبات:</b> ${fmtNum(totalPieces, 0)} &nbsp; <b>إجمالي الوزن:</b> ${fmtNum(totalKg)} كجم`;
        renderTable(el.querySelector('#table-wrap'), [
          { key: 'code', label: 'الكود', render: r => `<span dir="ltr">${esc(r.code)}</span>` },
          { key: 'name', label: 'الصنف' },
          { key: 'unit_name', label: 'الوحدة' },
          { key: 'balance_label', label: 'الرصيد المخزني' },
          { key: 'qty_salem', label: 'سليم', render: r => fmtNum(r.qty_salem, 0) },
          { key: 'qty_talef', label: 'تالف', render: r => fmtNum(r.qty_talef, 0) },
          { key: 'qty_muharraz', label: 'محرز', render: r => fmtNum(r.qty_muharraz, 0) },
          { key: 'balance_kg', label: 'الوزن كجم', render: r => fmtNum(r.balance_kg) },
        ], rows);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-run').onclick = load;
    el.querySelector('#f-warehouse').onchange = load;
    await load();
  },
});
