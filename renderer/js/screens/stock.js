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
        <span class="spacer"></span>
        <button class="btn" id="btn-print">طباعة الجرد</button>
      </div>
      <div class="summary-line" id="summary"></div>
      <div id="table-wrap"></div>`;

    let lastRows = [];
    let lastWhName = 'كل المخازن';
    el.querySelector('#btn-print').onclick = async () => {
      try {
        const settings = await api.invoke('settings:get');
        const totalPieces = lastRows.reduce((s, r) => s + (Number(r.balance_pieces) || 0), 0);
        await api.invoke('print:open', {
          kind: 'report',
          title: 'جرد المخزون',
          metaLines: ['المخزن: ' + lastWhName, 'عدد الأصناف: ' + lastRows.length, 'تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: ['الكود', 'الصنف', 'الوحدة', 'الرصيد المخزني', 'سليم', 'تالف', 'محرز'],
          rows: lastRows.map(r => [esc(r.code), esc(r.name), esc(r.unit_name), esc(r.balance_label),
            fmtNum(r.qty_salem, 0), fmtNum(r.qty_talef, 0), fmtNum(r.qty_muharraz, 0)]),
          foot: `<div class="notes"><b>إجمالي الرصيد: ${fmtNum(totalPieces, 0)} حبة</b></div>`,
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    async function load() {
      try {
        const filters = {
          warehouseId: Number(el.querySelector('#f-warehouse').value) || null,
        };
        const rows = await api.invoke('reports:inventory', filters);
        lastRows = rows;
        lastWhName = el.querySelector('#f-warehouse').selectedOptions[0]?.textContent || 'كل المخازن';
        const totalPieces = rows.reduce((s, r) => s + r.balance_pieces, 0);
        el.querySelector('#summary').innerHTML =
          `<b>عدد الأصناف:</b> ${rows.length} &nbsp; <b>إجمالي الرصيد:</b> ${fmtNum(totalPieces, 0)} حبة`;
        renderTable(el.querySelector('#table-wrap'), [
          { key: 'code', label: 'الكود', render: r => `<span dir="ltr">${esc(r.code)}</span>` },
          { key: 'name', label: 'الصنف' },
          { key: 'unit_name', label: 'الوحدة' },
          { key: 'balance_label', label: 'الرصيد المخزني' },
          { key: 'qty_salem', label: 'سليم', render: r => fmtNum(r.qty_salem, 0) },
          { key: 'qty_talef', label: 'تالف', render: r => fmtNum(r.qty_talef, 0) },
          { key: 'qty_muharraz', label: 'محرز', render: r => fmtNum(r.qty_muharraz, 0) },
        ], rows);
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-run').onclick = load;
    el.querySelector('#f-warehouse').onchange = load;
    await load();
  },
});
