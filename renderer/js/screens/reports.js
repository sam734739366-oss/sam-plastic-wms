import { register } from '../router.js';
import { api } from '../api.js';
import { toast, esc } from '../ui.js';
import { fmtMoney } from '../fmt.js';

const N = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
const DOC_LABEL = { opening: 'رصيد افتتاحي', purchase: 'شراء', issue: 'صرف إنتاج', receive: 'استلام', invoice: 'فاتورة', exit: 'خروج', scrap: 'تالف', transfer: 'نقل', production: 'نتيجة إنتاج' };
const DISP_LABEL = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة' };
const ACTION_LABEL = { create: 'إضافة', update: 'تعديل', delete: 'حذف', void: 'إلغاء', login: 'دخول', stock_write: 'تسجيل حركة مخزون' };

function dateInput(id, value = '') {
  return `<input id="${id}" type="date" value="${value}">`;
}

function selectHtml(id, options) {
  return `<select id="${id}">${options.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select>`;
}

function tableHtml(columns, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

register('reports', {
  title: 'التقارير',
  async mount(el) {
    const [items, warehouses, parties, machines, users] = await Promise.all([
      api.invoke('items:list'),
      api.invoke('warehouses:list'),
      api.invoke('parties:list'),
      api.invoke('machines:list'),
      api.invoke('users:list'),
    ]);

    const REPORTS = {
      inventory: {
        label: 'جرد المخزون',
        filterHtml: () => `
          <div class="field"><label>المخزن</label>${selectHtml('r-warehouse', [{ value: '', label: 'كل المخازن' }, ...warehouses.map(w => ({ value: w.id, label: w.name }))])}</div>`,
        getFilters: (el) => ({
          warehouseId: Number(el.querySelector('#r-warehouse').value) || null,
        }),
        columns: [
          { label: 'الكود', cell: r => r.code },
          { label: 'الصنف', cell: r => r.name },
          { label: 'الوحدة', cell: r => r.unit_name },
          { label: 'الرصيد المخزني', cell: r => r.balance_label },
          { label: 'سليم', cell: r => N(r.qty_salem) },
          { label: 'تالف', cell: r => N(r.qty_talef) },
          { label: 'محرز', cell: r => N(r.qty_muharraz) },
          { label: 'الوزن كجم', cell: r => N(r.balance_kg, 2) },
        ],
        foot: (data) => {
          const rows = Array.isArray(data) ? data : data.rows;
          return `<div class="notes"><b>عدد الأصناف: ${rows.length} — إجمالي الحبات: ${N(rows.reduce((s, r) => s + (Number(r.balance_pieces) || 0), 0))} — إجمالي الوزن: ${N(rows.reduce((s, r) => s + (Number(r.balance_kg) || 0), 0), 2)} كجم</b></div>`;
        },
      },
      movement: {
        label: 'حركة صنف (سجل مخزني)',
        filterHtml: () => `
          <div class="field"><label>الصنف</label>${selectHtml('r-item', [{ value: '', label: 'كل الأصناف' }, ...items.map(i => ({ value: i.id, label: `${i.code} — ${i.name}` }))])}</div>
          <div class="field"><label>المخزن</label>${selectHtml('r-warehouse', [{ value: '', label: 'كل المخازن' }, ...warehouses.map(w => ({ value: w.id, label: w.name }))])}</div>
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>`,
        getFilters: (el) => ({
          itemId: Number(el.querySelector('#r-item').value) || null,
          warehouseId: Number(el.querySelector('#r-warehouse').value) || null,
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
        }),
        columns: [
          { label: 'التاريخ', cell: r => r.doc_date },
          { label: 'النوع', cell: r => DOC_LABEL[r.doc_type] || r.doc_type },
          { label: 'الرقم', cell: r => r.doc_number },
          { label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { label: 'المخزن', cell: r => r.warehouse_name },
          { label: 'داخل (حبة)', cell: r => N(r.qty_in_pieces) },
          { label: 'خارج (حبة)', cell: r => N(r.qty_out_pieces) },
          { label: 'الرصيد', cell: r => r.balance_label },
          { label: 'داخل كجم', cell: r => N(r.weight_in_kg, 2) },
          { label: 'خارج كجم', cell: r => N(r.weight_out_kg, 2) },
          { label: 'الرصيد كجم', cell: r => N(r.balance_kg, 2) },
          { label: 'ملاحظات', cell: r => r.notes || '' },
        ],
        foot: (data) => {
          const rows = Array.isArray(data) ? data : data.rows;
          const pin = rows.reduce((s, r) => s + (Number(r.qty_in_pieces) || 0), 0);
          const pout = rows.reduce((s, r) => s + (Number(r.qty_out_pieces) || 0), 0);
          const win = rows.reduce((s, r) => s + (Number(r.weight_in_kg) || 0), 0);
          const wout = rows.reduce((s, r) => s + (Number(r.weight_out_kg) || 0), 0);
          return `<div class="notes"><b>الإجمالي — داخل: ${N(pin)} حبة — خارج: ${N(pout)} حبة — الصافي: ${N(pin - pout)} حبة &nbsp;|&nbsp; الوزن: داخل ${N(win, 2)} كجم — خارج ${N(wout, 2)} كجم — الصافي ${N(win - wout, 2)} كجم</b></div>`;
        },
      },
      production: {
        label: 'تقرير الإنتاج',
        filterHtml: () => `
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>
          <div class="field"><label>المكينة</label>${selectHtml('r-machine', [{ value: '', label: 'كل المكاين' }, ...machines.map(m => ({ value: m.id, label: m.name }))])}</div>`,
        getFilters: (el) => ({
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
          machineId: Number(el.querySelector('#r-machine').value) || null,
        }),
        columns: [
          { label: 'التاريخ', cell: r => r.result_date },
          { label: 'الكرتون', cell: r => r.carton_number },
          { label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { label: 'تصريح الصرف', cell: r => r.issue_number },
          { label: 'المكينة', cell: r => r.machine_name || '—' },
          { label: 'الوردية', cell: r => r.shift_name || '—' },
          { label: 'سليم', cell: r => N(r.good_pieces) },
          { label: 'تالف قبل', cell: r => N(r.defect_before) },
          { label: 'تالف بعد', cell: r => N(r.defect_after) },
          { label: 'الإجمالي', cell: r => N(r.total_pieces) },
          { label: 'ملاحظات', cell: r => r.notes || '' },
        ],
        foot: (data) => {
          const rows = Array.isArray(data) ? data : data.rows;
          const g = rows.reduce((s, r) => s + r.good_pieces, 0);
          const b = rows.reduce((s, r) => s + r.defect_before, 0);
          const a = rows.reduce((s, r) => s + r.defect_after, 0);
          return `<div class="notes"><b>الإجمالي — سليم: ${N(g)} &nbsp; تالف قبل: ${N(b)} &nbsp; تالف بعد: ${N(a)} &nbsp; الكراتين: ${rows.length}</b></div>`;
        },
      },
      scrap: {
        label: 'تقرير التوالف ومصائرها',
        filterHtml: () => `
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>`,
        getFilters: (el) => ({
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
        }),
        columns: [
          { label: 'الرقم', cell: r => r.doc_number },
          { label: 'التاريخ', cell: r => r.doc_date },
          { label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { label: 'المصير', cell: r => DISP_LABEL[r.disposition] || r.disposition },
          { label: 'المخزن', cell: r => r.warehouse_name || '—' },
          { label: 'الطرف', cell: r => r.party_name || '—' },
          { label: 'الحبات', cell: r => N(r.pieces) },
          { label: 'الوزن كجم', cell: r => N(r.weight_kg, 2) },
          { label: 'السعر', cell: r => r.price ? N(r.price, 2) : '—' },
        ],
        foot: (data) => {
          const rows = Array.isArray(data) ? data : data.rows;
          return `<div class="notes"><b>إجمالي الحبات: ${N(rows.reduce((s, r) => s + r.pieces, 0))} — الوزن: ${N(rows.reduce((s, r) => s + r.weight_kg, 0), 2)} كجم</b></div>`;
        },
      },
      purchases: {
        label: 'تقرير المشتريات',
        filterHtml: () => `
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>
          <div class="field"><label>المورد</label>${selectHtml('r-party', [{ value: '', label: 'كل الموردين' }, ...parties.filter(p => p.type !== 'customer').map(p => ({ value: p.id, label: p.name }))])}</div>`,
        getFilters: (el) => ({
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
          partyId: Number(el.querySelector('#r-party').value) || null,
        }),
        columns: [
          { label: 'الرقم', cell: r => r.doc_number },
          { label: 'التاريخ', cell: r => r.doc_date },
          { label: 'المورد', cell: r => r.party_name || '—' },
          { label: 'الحبات', cell: r => N(r.total_pieces) },
          { label: 'الإجمالي', cell: r => fmtMoney(r.total) },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي المشتريات: ${fmtMoney(data.total)} — عدد الفواتير: ${data.rows.length}</b></div>`,
      },
      audit: {
        label: 'سجل التدقيق',
        filterHtml: () => `
          <div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
          <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>
          <div class="field"><label>المستخدم</label>${selectHtml('r-user', [{ value: '', label: 'كل المستخدمين' }, ...users.map(u => ({ value: u.id, label: u.username }))])}</div>`,
        getFilters: (el) => ({
          from: el.querySelector('#r-from').value || null,
          to: el.querySelector('#r-to').value || null,
          userId: Number(el.querySelector('#r-user').value) || null,
        }),
        columns: [
          { label: 'الوقت', cell: r => r.created_at },
          { label: 'المستخدم', cell: r => r.user_name || '—' },
          { label: 'الإجراء', cell: r => ACTION_LABEL[r.action] || r.action },
          { label: 'الكيان', cell: r => r.entity },
          { label: 'رقم السجل', cell: r => r.entity_id ?? '' },
        ],
      },
    };

    el.innerHTML = `
      <div class="toolbar">
        <select id="r-kind">${Object.entries(REPORTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
        <button class="btn primary" id="btn-run">عرض التقرير</button>
        <span class="spacer"></span>
        <button class="btn" id="btn-print" disabled>طباعة A4</button>
        <button class="btn" id="btn-export" disabled>تصدير CSV</button>
      </div>
      <div class="toolbar" id="filters"></div>
      <div id="table-wrap"></div>`;

    const filtersEl = el.querySelector('#filters');
    const tableWrap = el.querySelector('#table-wrap');
    const btnPrint = el.querySelector('#btn-print');
    const btnExport = el.querySelector('#btn-export');
    let last = null;

    function renderFilters(kind) {
      filtersEl.innerHTML = `<div class="form-grid inline">${REPORTS[kind].filterHtml()}</div>`;
    }

    async function run() {
      const kind = el.querySelector('#r-kind').value;
      const r = REPORTS[kind];
      try {
        const data = await api.invoke('reports:' + kind, r.getFilters(el));
        const rows = Array.isArray(data) ? data : data.rows;
        last = { kind, data, cells: rows.map(row => r.columns.map(c => c.cell(row))) };
        tableWrap.innerHTML = tableHtml(r.columns, last.cells);
        if (r.foot) tableWrap.insertAdjacentHTML('beforeend', r.foot(data));
        btnPrint.disabled = false;
        btnExport.disabled = false;
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    renderFilters(el.querySelector('#r-kind').value);
    el.querySelector('#r-kind').onchange = () => renderFilters(el.querySelector('#r-kind').value);
    el.querySelector('#btn-run').onclick = run;

    btnPrint.onclick = async () => {
      if (!last) return;
      const r = REPORTS[last.kind];
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: r.label,
          metaLines: ['تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: r.columns.map(c => c.label),
          rows: last.cells.map(row => row.map(v => esc(v))),
          foot: r.foot ? r.foot(last.data) : '',
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    btnExport.onclick = async () => {
      if (!last) return;
      const r = REPORTS[last.kind];
      try {
        const res = await api.invoke('reports:export', {
          defaultName: `${r.label}.csv`,
          columns: r.columns.map(c => c.label),
          rows: last.cells,
        });
        if (res.ok) toast('تم التصدير: ' + res.path, 'ok');
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    await run();
  },
});
