import { register } from '../router.js';
import { api } from '../api.js';
import { toast, esc, openModal, attachRowMenu, bucketBadge } from '../ui.js';
import { fmtMoney } from '../fmt.js';

const N = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
const DOC_LABEL = { opening: 'رصيد افتتاحي', purchase: 'شراء', issue: 'صرف إنتاج', receive: 'استلام', invoice: 'فاتورة', exit: 'خروج', scrap: 'تالف', transfer: 'نقل', production: 'نتيجة إنتاج', sale_return: 'مرتجع بيع', purchase_return: 'مرتجع شراء' };
const DISP_LABEL = { to_recycled: 'إرجاع محرز', to_stock: 'إرجاع للمخزون', to_supplier: 'استرجاع مورد', sold_scrap: 'بيع خردة', production_defect: 'تالف إنتاج بخام عميل' };
const ACTION_LABEL = { create: 'إضافة', update: 'تعديل', delete: 'حذف', void: 'إلغاء', login: 'دخول', stock_write: 'تسجيل حركة مخزون' };

function dateInput(id, value = '') {
  return `<input id="${id}" type="date" value="${value}">`;
}

function selectHtml(id, options) {
  return `<select id="${id}">${options.map(o => `<option value="${o.value}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

function tableHtml(columns, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-ri="${i}">${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

register('reports', {
  title: 'التقارير',
  async mount(el) {
    const [items, warehouses, parties, machines, users, shiftsList, meta] = await Promise.all([
      api.invoke('items:list'),
      api.invoke('warehouses:list'),
      api.invoke('parties:list'),
      api.invoke('machines:list'),
      api.invoke('users:list'),
      api.invoke('shifts:list'),
      api.invoke('reports:meta'),
    ]);

    // ===== فلاتر مشتركة للتقارير السبعة =====
    // المخزن: الرئيسي أولًا ومختارًا، ثم بقية المخازن، ثم «كل المخازن» لتجميع الكل.
    const mainWhId = meta && meta.mainWarehouseId ? meta.mainWarehouseId : (warehouses.length ? warehouses[0].id : null);
    const whField = () => `<div class="field"><label>المخزن</label>${selectHtml('r-warehouse',
      [...warehouses.map(w => ({ value: w.id, label: w.id === mainWhId ? `${w.name} (الرئيسي)` : w.name, selected: w.id === mainWhId })),
        { value: 'all', label: 'كل المخازن' }])}</div>`;
    const unitField = () => `<div class="field"><label>وحدة العرض</label>${selectHtml('r-unit',
      [{ value: 'pieces', label: 'حبة/عبوة', selected: true }, { value: 'carton', label: 'كرتون' }, { value: 'bag', label: 'كيس' }])}</div>`;
    const dateFields = () => `<div class="field"><label>من تاريخ</label>${dateInput('r-from')}</div>
      <div class="field"><label>إلى تاريخ</label>${dateInput('r-to')}</div>`;
    const partyField = (label, list, allLabel) => `<div class="field"><label>${label}</label>${selectHtml('r-party',
      [{ value: '', label: allLabel }, ...list.map(p => ({ value: p.id, label: p.name }))])}</div>`;
    const getWh = (node) => (node.value === 'all' ? 'all' : (Number(node.value) || null));
    const getUnit = (node) => (node && node.value ? node.value : 'pieces');
    const dash = (v) => (v === null || v === undefined ? '—' : N(v));
    // كل تقرير يعطي نفس الرباعية: مدى تاريخ + مخزن ذكي + وحدة عرض، ثم زياداته الخاصة
    const baseFilters = (root) => ({
      from: root.querySelector('#r-from') ? root.querySelector('#r-from').value || null : null,
      to: root.querySelector('#r-to') ? root.querySelector('#r-to').value || null : null,
      unit: getUnit(root.querySelector('#r-unit')),
      warehouseId: root.querySelector('#r-warehouse') ? getWh(root.querySelector('#r-warehouse')) : 'all',
    });

    const REPORTS = {
      // 1) المشتريات — مستوى البند
      purchases: {
        label: 'تقرير المشتريات',
        filterHtml: () => `${dateFields()}
          ${partyField('المورد', parties.filter(p => p.type !== 'customer'), 'كل الموردين')}
          ${whField()}${unitField()}`,
        getFilters: (root) => ({ ...baseFilters(root), partyId: Number(root.querySelector('#r-party').value) || null }),
        columns: [
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'doc_number', label: 'رقم الفاتورة', cell: r => r.doc_number },
          { key: 'party_name', label: 'المورد', cell: r => r.party_name || '—' },
          { key: 'code', label: 'كود الصنف', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'qty_label', label: 'الكمية', cell: r => r.qty_label },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي الكميات: ${data.total_qty_label} — عدد البنود: ${data.rows.length}</b></div>`,
      },
      // 2) المنصرف للإنتاج — بلا مكينة ولا وردية
      issues: {
        label: 'المنصرف للإنتاج',
        filterHtml: () => `${dateFields()}${whField()}${unitField()}`,
        getFilters: (root) => baseFilters(root),
        columns: [
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'doc_number', label: 'رقم التصريح', cell: r => r.doc_number },
          { key: 'code', label: 'كود الصنف', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'source', label: 'المصدر', cell: r => (r.source === 'customer' ? 'خام عميل' : 'خام المصنع') },
          { key: 'qty_label', label: 'الكمية', cell: r => r.qty_label },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي المصروف: ${data.total_qty_label} — عدد البنود: ${data.rows.length}</b></div>`,
      },
      // 3) الخروج للعملاء — فواتير البيع بقيمتها
      sales: {
        label: 'الخروج للعملاء',
        filterHtml: () => `${dateFields()}
          ${partyField('العميل', parties.filter(p => p.type !== 'supplier'), 'كل العملاء')}
          ${whField()}${unitField()}`,
        getFilters: (root) => ({ ...baseFilters(root), partyId: Number(root.querySelector('#r-party').value) || null }),
        columns: [
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'invoice_number', label: 'رقم الفاتورة', cell: r => r.invoice_number },
          { key: 'party_name', label: 'العميل', cell: r => r.party_name || '—' },
          { key: 'code', label: 'كود الصنف', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'qty_label', label: 'الكمية', cell: r => r.qty_label },
          { key: 'value', label: 'قيمة البند (ريال)', cell: r => fmtMoney(r.value) },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي الكميات: ${data.total_qty_label} — إجمالي القيم: ${fmtMoney(data.total)} — عدد البنود: ${data.rows.length}</b></div>`,
      },
      // 4) الإنتاج اليومي لكل كرتون
      production: {
        label: 'الإنتاج اليومي',
        filterHtml: () => `${dateFields()}
          <div class="field"><label>المكينة</label>${selectHtml('r-machine', [{ value: '', label: 'كل المكاين' }, ...machines.map(m => ({ value: m.id, label: m.name }))])}</div>
          <div class="field"><label>الوردية</label>${selectHtml('r-shift', [{ value: '', label: 'كل الورديات' }, ...shiftsList.map(s => ({ value: s.id, label: s.name }))])}</div>
          ${whField()}${unitField()}`,
        getFilters: (root) => ({
          ...baseFilters(root),
          machineId: Number(root.querySelector('#r-machine').value) || null,
          shiftId: Number(root.querySelector('#r-shift').value) || null,
        }),
        columns: [
          { key: 'result_date', label: 'التاريخ', cell: r => r.result_date },
          { key: 'machine_name', label: 'المكينة', cell: r => r.machine_name || '—' },
          { key: 'shift_name', label: 'الوردية', cell: r => r.shift_name || '—' },
          { key: 'carton_number', label: 'رقم الكرتون', cell: r => r.carton_number },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'carton_pieces_label', label: 'حبات الكرتون', cell: r => r.carton_pieces_label },
          { key: 'good_pieces_label', label: 'سليم', cell: r => r.good_pieces_label },
          { key: 'defect_before_label', label: 'تالف قبل', cell: r => r.defect_before_label },
          { key: 'defect_after_label', label: 'تالف بعد', cell: r => r.defect_after_label },
          { key: 'variance_label', label: 'الفارق', cell: r => r.variance_label },
          { key: 'used_bags', label: 'أكياس مستخدمة', cell: r => dash(r.used_bags) },
          { key: 'breaks', label: 'كسور', cell: r => dash(r.breaks) },
        ],
        foot: (data) => `<div class="notes"><b>سليم: ${N(data.total_good)} حبة — تالف: ${N(data.total_defect)} حبة — فارق: ${N(data.total_variance)} حبة — أكياس: ${N(data.total_bags)}</b></div>`,
      },
      // 5) العهَد: النفخ للغير
      tolling: {
        label: 'تقرير العهَد (للغير)',
        filterHtml: () => `${dateFields()}
          ${partyField('العميل', parties.filter(p => p.type !== 'supplier'), 'كل العملاء')}${unitField()}`,
        getFilters: (root) => ({
          from: root.querySelector('#r-from').value || null,
          to: root.querySelector('#r-to').value || null,
          unit: getUnit(root.querySelector('#r-unit')),
          partyId: Number(root.querySelector('#r-party').value) || null,
        }),
        columns: [
          { key: 'party_name', label: 'العميل', cell: r => r.party_name },
          { key: 'raw_in_label', label: 'إجمالي الخام المستلم', cell: r => r.raw_in_label },
          { key: 'delivered_label', label: 'إجمالي المسلَّم', cell: r => r.delivered_label },
          { key: 'customer_defects_label', label: 'تالف العميل', cell: r => r.customer_defects_label },
          { key: 'remaining_label', label: 'الرصيد المتبقي', cell: r => r.remaining_label },
        ],
        foot: (data) => `<div class="notes"><b>الإجماليات — خام: ${N(data.total_raw)} حبة — مسلَّم: ${N(data.total_delivered)} حبة — تالف العملاء: ${N(data.total_defects)} حبة — متبقٍ: ${N(data.total_remaining)} حبة</b></div>`,
      },
      // 6) التالف ومصدره
      scrap: {
        label: 'تقرير التالف',
        filterHtml: () => `${dateFields()}${whField()}${unitField()}`,
        getFilters: (root) => baseFilters(root),
        columns: [
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'doc_number', label: 'رقم السند', cell: r => r.doc_number },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'source_label', label: 'المصدر', cell: r => r.source_label },
          { key: 'qty_label', label: 'الكمية', cell: r => r.qty_label },
          { key: 'disposition', label: 'المصير', cell: r => DISP_LABEL[r.disposition] || r.disposition },
        ],
        foot: (data) => `<div class="notes"><b>إجمالي التالف: ${data.total_qty_label} — عدد السندات: ${data.rows.length}</b></div>`,
      },
      // 7) أرصدة المخازن: مخزن × صنف بثلاث سلل
      stockBalances: {
        label: 'أرصدة المخازن',
        filterHtml: () => `
          <div class="field"><label>الصنف</label>${selectHtml('r-item', [{ value: '', label: 'كل الأصناف' }, ...items.map(i => ({ value: i.id, label: `${i.code} — ${i.name}` }))])}</div>
          ${whField()}${unitField()}`,
        getFilters: (root) => ({
          unit: getUnit(root.querySelector('#r-unit')),
          warehouseId: getWh(root.querySelector('#r-warehouse')),
          itemId: Number(root.querySelector('#r-item').value) || null,
        }),
        columns: [
          { key: 'warehouse_name', label: 'المخزن', cell: r => r.warehouse_name },
          { key: 'code', label: 'كود الصنف', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'qty_salem_label', label: 'سليم', cell: r => r.qty_salem_label },
          { key: 'qty_talef_label', label: 'تالف', cell: r => r.qty_talef_label },
          { key: 'qty_muharraz_label', label: 'محرز', cell: r => r.qty_muharraz_label },
          { key: 'total_pieces_label', label: 'الإجمالي', cell: r => r.total_pieces_label },
        ],
        foot: (data) => `<div class="notes"><b>عبر المخازن — سليم: ${N(data.total_salem)} — تالف: ${N(data.total_talef)} — محرز: ${N(data.total_muharraz)} — الحبات: ${N(data.total_pieces)}</b></div>`,
      },
      inventory: {
        label: 'جرد المخزون',
        filterHtml: () => `<div class="field"><label>المخزن</label>${selectHtml('r-warehouse', [{ value: '', label: 'كل المخازن' }, ...warehouses.map(w => ({ value: w.id, label: w.name }))])}</div>`,
        getFilters: (root) => ({ warehouseId: root.querySelector('#r-warehouse').value || null }),
        columns: [
          { key: 'code', label: 'الكود', cell: r => r.code },
          { key: 'name', label: 'الصنف', cell: r => r.name },
          { key: 'unit_name', label: 'الوحدة', cell: r => r.unit_name },
          { key: 'suppliers', label: 'الموردون', cell: r => r.suppliers || '—' },
          { key: 'customers', label: 'العملاء', cell: r => r.customers || '—' },
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
          ${dateFields()}`,
        getFilters: (root) => ({
          itemId: Number(root.querySelector('#r-item').value) || null,
          warehouseId: root.querySelector('#r-warehouse').value || null,
          from: root.querySelector('#r-from').value || null,
          to: root.querySelector('#r-to').value || null,
        }),
        columns: [
          { key: 'doc_date', label: 'التاريخ', cell: r => r.doc_date },
          { key: 'doc_type', label: 'النوع', cell: r => DOC_LABEL[r.doc_type] || r.doc_type },
          { key: 'doc_number', label: 'الرقم', cell: r => r.doc_number },
          { key: 'item', label: 'الصنف', cell: r => `${r.code} — ${r.name}` },
          { key: 'warehouse_name', label: 'المخزن', cell: r => r.warehouse_name },
          { key: 'bucket', label: 'السلة', cell: r => bucketBadge(r.bucket) },
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
      audit: {
        label: 'سجل التدقيق',
        filterHtml: () => `${dateFields()}
          <div class="field"><label>المستخدم</label>${selectHtml('r-user', [{ value: '', label: 'كل المستخدمين' }, ...users.map(u => ({ value: u.id, label: u.username }))])}</div>`,
        getFilters: (root) => ({
          from: root.querySelector('#r-from').value || null,
          to: root.querySelector('#r-to').value || null,
          userId: Number(root.querySelector('#r-user').value) || null,
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

    let kind = 'purchases';
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
        attachRowMenu(tableWrap, (ri) => rowMenu(kind, rows[ri]));
        btnPrint.disabled = false;
        btnExport.disabled = false;
      } catch (e) { toast(String(e.message || e), 'err'); }
    }

    // قائمة كليك يمين على صفوف التقارير:
    // - حركة الصنف: «عرض المستند» يفتح التصريح/الفاتورة الأصلية للحركة (كلك يمين مرتين = نفس النتيجة)
    // - جرد المخزون: «عرض حركة الصنف» ينتقل لتقرير حركة الصنف مفلتراً بهذا الصنف
    const MOVE_GET = {
      purchase: ['purchases:get', 'purchase'],
      issue: ['issues:get', 'issue'],
      receive: ['receives:get', 'receive'],
      invoice: ['sales:get', null],
      exit: ['exits:get', 'exit'],
      scrap: ['scrap:get', 'scrap'],
      transfer: ['transfers:get', 'transfer'],
      production: ['production:get', 'production'],
      sale_return: ['returns:getSale', 'sale_return'],
      purchase_return: ['returns:getPurchase', 'purchase_return'],
    };
    function rowMenu(rkind, row) {
      if (!row) return [];
      if (rkind === 'movement') {
        return [{ label: 'عرض المستند', open: true, onClick: () => openMoveDoc(row) }];
      }
      if (rkind === 'inventory') {
        return [{ label: 'عرض حركة الصنف', open: true, onClick: () => showItemMovement(row.id) }];
      }
      return [];
    }
    async function openMoveDoc(row) {
      try {
        const t = row.doc_type;
        if (t === 'opening') { toast('رصيد افتتاحي — لا يوجد مستند لهذه الحركة'); return; }
        const m = MOVE_GET[t];
        if (!m) { toast('لا يمكن عرض مستند لهذه الحركة'); return; }
        const doc = await api.invoke(m[0], row.doc_id);
        const kind0 = m[1] || (doc.invoice_type === 'scrap' ? 'scrap' : 'invoice');
        await api.invoke('print:open', { kind: kind0, doc, settings: await api.invoke('settings:get') });
      } catch (e) { toast(String(e.message || e), 'err'); }
    }
    function showItemMovement(itemId) {
      kind = 'movement';
      renderTabs();
      renderFilters();
      const sel = el.querySelector('#r-item');
      if (sel) sel.value = String(itemId);
      run();
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
