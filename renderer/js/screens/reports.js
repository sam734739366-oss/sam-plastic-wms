import { register } from '../router.js';
import { api } from '../api.js';
import { toast, esc, openModal } from '../ui.js';
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
          { key: 'code', label: 'الكود', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'unit_name', label: 'الوحدة', cell: r => r.unit_name },
          { key: 'balance_label', label: 'الرصيد المخزني', cell: r => r.balance_label },
          { key: 'qty_salem', label: 'سليم', cell: r => N(r.qty_salem) },
          { key: 'qty_talef', label: 'تالف', cell: r => N(r.qty_talef) },
          { key: 'qty_muharraz', label: 'محرز', cell: r => N(r.qty_muharraz) },
          { key: 'balance_kg', label: 'الوزن كجم', weight: true, cell: r => N(r.balance_kg, 2) },
        ],
        foot: (data, cols) => {
          const rows = Array.isArray(data) ? data : data.rows;
          const showW = cols.some(c => c.key === 'balance_kg');
          return `<div class="notes"><b>عدد الأصناف: ${rows.length} — إجمالي الحبات: ${N(rows.reduce((s, r) => s + (Number(r.balance_pieces) || 0), 0))}${showW ? ` — إجمالي الوزن: ${N(rows.reduce((s, r) => s + (Number(r.balance_kg) || 0), 0), 2)} كجم` : ''}</b></div>`;
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
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'doc_type', label: 'النوع', cell: r => DOC_LABEL[r.doc_type] || r.doc_type },
          { key: 'doc_number', label: 'الرقم', cell: r => r.doc_number },
          { key: 'item', label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { key: 'warehouse_name', label: 'المخزن', cell: r => r.warehouse_name },
          { key: 'qty_in_pieces', label: 'داخل (حبة)', cell: r => N(r.qty_in_pieces) },
          { key: 'qty_out_pieces', label: 'خارج (حبة)', cell: r => N(r.qty_out_pieces) },
          { key: 'balance_label', label: 'الرصيد', cell: r => r.balance_label },
          { key: 'weight_in_kg', label: 'داخل كجم', weight: true, cell: r => N(r.weight_in_kg, 2) },
          { key: 'weight_out_kg', label: 'خارج كجم', weight: true, cell: r => N(r.weight_out_kg, 2) },
          { key: 'balance_kg', label: 'الرصيد كجم', weight: true, cell: r => N(r.balance_kg, 2) },
          { key: 'notes', label: 'ملاحظات', cell: r => r.notes || '' },
        ],
        foot: (data, cols) => {
          const rows = Array.isArray(data) ? data : data.rows;
          const pin = rows.reduce((s, r) => s + (Number(r.qty_in_pieces) || 0), 0);
          const pout = rows.reduce((s, r) => s + (Number(r.qty_out_pieces) || 0), 0);
          const showW = cols.some(c => c.weight);
          const win = rows.reduce((s, r) => s + (Number(r.weight_in_kg) || 0), 0);
          const wout = rows.reduce((s, r) => s + (Number(r.weight_out_kg) || 0), 0);
          return `<div class="notes"><b>الإجمالي — داخل: ${N(pin)} حبة — خارج: ${N(pout)} حبة — الصافي: ${N(pin - pout)} حبة${showW ? ` &nbsp;|&nbsp; الوزن: داخل ${N(win, 2)} كجم — خارج ${N(wout, 2)} كجم — الصافي ${N(win - wout, 2)} كجم` : ''}</b></div>`;
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
          { key: 'result_date', label: 'التاريخ', cell: r => r.result_date },
          { key: 'carton_number', label: 'الكرتون', cell: r => r.carton_number },
          { key: 'item', label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { key: 'issue_number', label: 'تصريح الصرف', cell: r => r.issue_number },
          { key: 'machine_name', label: 'المكينة', cell: r => r.machine_name || '—' },
          { key: 'shift_name', label: 'الوردية', cell: r => r.shift_name || '—' },
          { key: 'good_pieces', label: 'سليم', cell: r => N(r.good_pieces) },
          { key: 'defect_before', label: 'تالف قبل', cell: r => N(r.defect_before) },
          { key: 'defect_after', label: 'تالف بعد', cell: r => N(r.defect_after) },
          { key: 'total_pieces', label: 'الإجمالي', cell: r => N(r.total_pieces) },
          { key: 'notes', label: 'ملاحظات', cell: r => r.notes || '' },
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
          { key: 'doc_number', label: 'الرقم', cell: r => r.doc_number },
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'item', label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { key: 'disposition', label: 'المصير', cell: r => DISP_LABEL[r.disposition] || r.disposition },
          { key: 'warehouse_name', label: 'المخزن', cell: r => r.warehouse_name || '—' },
          { key: 'party_name', label: 'الطرف', cell: r => r.party_name || '—' },
          { key: 'pieces', label: 'الحبات', cell: r => N(r.pieces) },
          { key: 'weight_kg', label: 'الوزن كجم', weight: true, cell: r => N(r.weight_kg, 2) },
          { key: 'price', label: 'السعر', cell: r => r.price ? N(r.price, 2) : '—' },
        ],
        foot: (data, cols) => {
          const rows = Array.isArray(data) ? data : data.rows;
          const showW = cols.some(c => c.key === 'weight_kg');
          return `<div class="notes"><b>إجمالي الحبات: ${N(rows.reduce((s, r) => s + r.pieces, 0))}${showW ? ` — الوزن: ${N(rows.reduce((s, r) => s + r.weight_kg, 0), 2)} كجم` : ''}</b></div>`;
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
          { key: 'doc_number', label: 'الرقم', cell: r => r.doc_number },
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'party_name', label: 'المورد', cell: r => r.party_name || '—' },
          { key: 'total_pieces', label: 'الحبات', cell: r => N(r.total_pieces) },
          { key: 'total', label: 'الإجمالي', cell: r => fmtMoney(r.total) },
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
          { key: 'created_at', label: 'الوقت', cell: r => r.created_at },
          { key: 'user_name', label: 'المستخدم', cell: r => r.user_name || '—' },
          { key: 'action', label: 'الإجراء', cell: r => ACTION_LABEL[r.action] || r.action },
          { key: 'entity', label: 'الكيان', cell: r => r.entity },
          { key: 'entity_id', label: 'رقم السجل', cell: r => r.entity_id ?? '' },
        ],
      },
    };

    const COL_KEY = (kind) => `report-cols:${kind}`;
    const visibleOf = (kind) => {
      const all = REPORTS[kind].columns;
      try {
        const saved = JSON.parse(localStorage.getItem(COL_KEY(kind)) || 'null');
        if (Array.isArray(saved)) {
          const keys = saved.filter(k => all.some(c => c.key === k));
          if (keys.length) return keys;
        }
      } catch { /* تجاهل */ }
      return all.filter(c => !c.weight).map(c => c.key);
    };
    const saveCols = (kind, keys) => localStorage.setItem(COL_KEY(kind), JSON.stringify(keys));

    let kind = 'inventory';
    let last = null;

    el.innerHTML = `
      <div class="report-tabs" id="r-tabs"></div>
      <div class="card">
        <div class="toolbar" id="filters"></div>
        <div class="toolbar">
          <button class="btn primary" id="btn-run">عرض التقرير</button>
          <button class="btn" id="btn-cols">الأعمدة</button>
          <span class="spacer"></span>
          <button class="btn" id="btn-print" disabled>طباعة A4</button>
          <button class="btn" id="btn-export" disabled>تصدير CSV</button>
        </div>
        <div id="table-wrap"></div>
      </div>`;

    const tabsEl = el.querySelector('#r-tabs');
    const filtersEl = el.querySelector('#filters');
    const tableWrap = el.querySelector('#table-wrap');
    const btnPrint = el.querySelector('#btn-print');
    const btnExport = el.querySelector('#btn-export');

    function renderTabs() {
      tabsEl.innerHTML = Object.entries(REPORTS)
        .map(([k, r]) => `<button class="tab-btn${k === kind ? ' active' : ''}" data-kind="${k}">${esc(r.label)}</button>`)
        .join('');
      tabsEl.querySelectorAll('.tab-btn').forEach(b => {
        b.onclick = () => { kind = b.dataset.kind; renderTabs(); renderFilters(); run(); };
      });
    }
    function renderFilters() {
      filtersEl.innerHTML = `<div class="form-grid inline">${REPORTS[kind].filterHtml()}</div>`;
    }
    function visibleCols() {
      const keys = visibleOf(kind);
      return REPORTS[kind].columns.filter(c => keys.includes(c.key));
    }
    async function run() {
      const r = REPORTS[kind];
      const cols = visibleCols();
      try {
        const data = await api.invoke('reports:' + kind, r.getFilters(el));
        const rows = Array.isArray(data) ? data : data.rows;
        last = { kind, data, cols, cells: rows.map(row => cols.map(c => c.cell(row))) };
        tableWrap.innerHTML = tableHtml(cols, last.cells);
        if (r.foot) tableWrap.insertAdjacentHTML('beforeend', r.foot(data, cols));
        btnPrint.disabled = false;
        btnExport.disabled = false;
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    el.querySelector('#btn-cols').onclick = () => {
      const cols = REPORTS[kind].columns;
      const keys = visibleOf(kind);
      const back = openModal('الأعمدة الظاهرة في التقرير', `
        <p class="muted" style="margin:0 0 10px">اختر الأعمدة التي تظهر في جدول التقرير وطباعته وتصديره — تُحفظ اختياراتك لكل تقرير.</p>
        ${cols.map(c => `<label class="col-line"><input type="checkbox" data-key="${esc(c.key)}" ${keys.includes(c.key) ? 'checked' : ''}>
          ${esc(c.label)}${c.weight ? ' <span class="tag muharraz">وزن</span>' : ''}</label>`).join('')}
      `, [
        {
          label: 'حفظ', class: 'primary',
          onClick: async (b) => {
            const picked = [...b.querySelectorAll('input[data-key]:checked')].map(i => i.dataset.key);
            if (!picked.length) { toast('اختر عموداً واحداً على الأقل', 'err'); return; }
            saveCols(kind, picked);
            b.remove();
            await run();
            toast('تم حفظ اختيار الأعمدة', 'ok');
          },
        },
        {
          label: 'الافتراضي',
          onClick: async (b) => {
            localStorage.removeItem(COL_KEY(kind));
            b.remove();
            await run();
            toast('عاد التقرير للأعمدة الافتراضية (بدون الوزن)', 'ok');
          },
        },
        { label: 'إلغاء', onClick: (b) => b.remove() },
      ]);
    };

    renderTabs();
    renderFilters();
    el.querySelector('#btn-run').onclick = run;

    btnPrint.onclick = async () => {
      if (!last) return;
      try {
        const settings = await api.invoke('settings:get');
        await api.invoke('print:open', {
          kind: 'report',
          title: REPORTS[last.kind].label,
          metaLines: ['تاريخ الطباعة: ' + new Date().toLocaleString('ar')],
          headers: last.cols.map(c => c.label),
          rows: last.cells.map(row => row.map(v => esc(v))),
          foot: REPORTS[last.kind].foot ? REPORTS[last.kind].foot(last.data, last.cols) : '',
          settings,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    btnExport.onclick = async () => {
      if (!last) return;
      try {
        const res = await api.invoke('reports:export', {
          defaultName: `${REPORTS[last.kind].label}.csv`,
          columns: last.cols.map(c => c.label),
          rows: last.cells,
        });
        if (res.ok) toast('تم التصدير: ' + res.path, 'ok');
      } catch (e) { toast(String(e.message || e), 'err'); }
    };

    await run();
  },
});
