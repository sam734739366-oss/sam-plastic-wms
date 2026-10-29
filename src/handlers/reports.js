const { getDb } = require('../db');
const { formatQty } = require('../units');
const { dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ========== أدوات التقارير السبعة ==========
// القياس دائمًا بالحبة؛ وحدة العرض (كرتون/كيس) زينة حسابية لا تغيّر التجميع.
const UNIT_LABEL = { pieces: 'حبة', carton: 'كرتون', bag: 'كيس' };
const num = (n) => Number(n) || 0;
const int = (n) => Math.round(num(n)).toLocaleString('en-US');
const dec = (n) => Number(n.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });

function unitMode(filters) {
  return ['pieces', 'carton', 'bag'].includes(filters.unit) ? filters.unit : 'pieces';
}

// كمية واحدة بصيغة العرض المطلوبة. بلا حجم تعبئة صالح للصنف ترجع للحبة دائمًا،
// فلا تُعرض «كرتون» بقسمة على صفر أو على حجم غير معرّف.
function qtyText(pieces, item, mode) {
  const p = num(pieces);
  const per = mode === 'carton' ? num(item && item.pieces_per_carton) : mode === 'bag' ? num(item && item.pieces_per_bag) : 0;
  if (per > 0) return `${dec(p / per)} ${UNIT_LABEL[mode]}`;
  return `${int(p)} حبة`;
}

// يُلصق <key>_label لكل عمود كمية في الصفوف، ويُبقي القيمة الرقمية بالحبة للجمع
function withUnits(rows, mode, keys) {
  for (const r of rows) for (const k of keys) r[`${k}_label`] = qtyText(r[k], r, mode);
  return rows;
}

// المخزن الرئيسي: أول مخزن بالميلاد (id الأصغر) — القاعدة لا تحمل علما بـ«الرئيسي»
function mainWarehouseId(db) {
  const row = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

// فلتر المخزن الذكي: 'all' يعني كل المخازن (بلا شرط)، ورقم يعني مخزناً واحداً.
// القيمة السالبة هنا تعيد 'لا شيء' لأن المخزن الرئيسي غير موجود أصلاً.
function whClause(filters, column) {
  const v = filters.warehouseId;
  if (v === null || v === undefined || v === '' || v === 'all') return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [Number(v)] };
}

function dateClause(filters, column) {
  const sql = [];
  const params = [];
  if (filters.from) { sql.push(` AND ${column} >= ?`); params.push(filters.from); }
  if (filters.to) { sql.push(` AND ${column} <= ?`); params.push(filters.to); }
  return { sql: sql.join(''), params };
}

function andSql(...parts) {
  return parts.map(p => (typeof p === 'string' ? p : p.sql)).filter(Boolean).join('');
}
function andParams(...parts) {
  return parts.flatMap(p => (typeof p === 'string' ? [] : p.params));
}

module.exports = function register(ipcMain) {
  ipcMain.handle('reports:inventory', (e, filters = {}) => {
    const db = getDb();
    const params = [];
    let joinWh = '';
    // عند فلترة مخزن معين: الأصناف المنتهية (رصيد صفر في هذا المخزن) لا تظهر
    let havingWh = '';
    if (filters.warehouseId) {
      joinWh = ' AND m.warehouse_id = ?';
      params.push(filters.warehouseId);
      havingWh = ' HAVING balance_pieces <> 0';
    }
    const rows = db.prepare(`SELECT i.id, i.code, i.name, i.unit_name, i.weight_grams, i.pieces_per_carton,
        i.pieces_per_shadda, i.pieces_per_bag,
        COALESCE(SUM(CASE WHEN m.bucket='salem' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_salem,
        COALESCE(SUM(CASE WHEN m.bucket='talef' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_talef,
        COALESCE(SUM(CASE WHEN m.bucket='muharraz' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_muharraz,
        COALESCE(SUM(m.qty_in_pieces),0) in_pieces,
        COALESCE(SUM(m.qty_out_pieces),0) out_pieces,
        COALESCE(SUM(m.qty_in_pieces),0) - COALESCE(SUM(m.qty_out_pieces),0) balance_pieces,
        COALESCE(SUM(m.weight_in_kg),0) - COALESCE(SUM(m.weight_out_kg),0) balance_kg,
        (SELECT GROUP_CONCAT(DISTINCT pa.name) FROM purchase_items pi
          JOIN purchases pu ON pu.id = pi.purchase_id JOIN parties pa ON pa.id = pu.party_id
          WHERE pi.item_id = i.id AND pu.status != 'void' AND pa.name IS NOT NULL) suppliers,
        (SELECT GROUP_CONCAT(DISTINCT pa.name) FROM invoice_items ii
          JOIN invoices inv ON inv.id = ii.invoice_id JOIN parties pa ON pa.id = inv.party_id
          WHERE ii.item_id = i.id AND inv.status != 'void' AND pa.name IS NOT NULL) customers
      FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id${joinWh}
      WHERE i.is_complement = 0
      GROUP BY i.id${havingWh} ORDER BY i.code`).all(...params);
    return rows.map(r => ({ ...r, balance_label: formatQty(r.balance_pieces, r) }));
  });

  ipcMain.handle('reports:movement', (e, filters = {}) => {
    const db = getDb();
    const where = [];
    const params = [];
    if (filters.itemId) { where.push('m.item_id = ?'); params.push(filters.itemId); }
    if (filters.warehouseId) { where.push('m.warehouse_id = ?'); params.push(filters.warehouseId); }
    if (filters.from) { where.push('m.doc_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('m.doc_date <= ?'); params.push(filters.to); }
    const wh = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`SELECT m.id, m.doc_type, m.doc_id, m.doc_number, m.doc_date, m.item_id,
        i.code, i.name, i.unit_name,
        i.weight_grams, i.pieces_per_carton, w.name warehouse_name,
        m.qty_in_pieces, m.qty_out_pieces, m.bucket, m.weight_in_kg, m.weight_out_kg, m.notes
      FROM stock_moves m
      JOIN items i ON i.id = m.item_id
      JOIN warehouses w ON w.id = m.warehouse_id${wh}
      ORDER BY m.doc_date, m.id`).all(...params);
    let balP = 0, balKg = 0;
    for (const r of rows) {
      balP += r.qty_in_pieces - r.qty_out_pieces;
      balKg += r.weight_in_kg - r.weight_out_kg;
      r.balance_pieces = balP;
      r.balance_kg = balKg;
      r.balance_label = formatQty(balP, r);
    }
    return rows;
  });

  // 1) تقرير المشتريات — مستوى البند: تاريخ/رقم/مورد/كود/صنف/كمية، بلا أوزان
  ipcMain.handle('reports:purchases', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'p.doc_date');
    const w = whClause(filters, 'pi.warehouse_id');
    const extra = [];
    const extraParams = [];
    if (filters.partyId) { extra.push(' AND p.party_id = ?'); extraParams.push(Number(filters.partyId)); }
    const rows = db.prepare(`SELECT p.id doc_id, p.doc_date, p.doc_number, pa.name party_name,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        pi.warehouse_id, pi.bucket, pi.pieces AS qty
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      JOIN items i ON i.id = pi.item_id
      LEFT JOIN parties pa ON pa.id = p.party_id
      WHERE p.status = 'active'${d.sql}${w.sql}${extra.join('')}
      ORDER BY p.doc_date, p.id, pi.id`).all(...d.params, ...w.params, ...extraParams);
    withUnits(rows, mode, ['qty']);
    return { rows, total_qty: rows.reduce((s, r) => s + num(r.qty), 0), total_qty_label: int(rows.reduce((s, r) => s + num(r.qty), 0)) + ' حبة' };
  });

  // 2) تقرير المنصرف للإنتاج — بلا مكينة ولا وردية كما طُلب
  ipcMain.handle('reports:issues', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'ip.doc_date');
    const w = whClause(filters, 'ii.warehouse_id');
    const rows = db.prepare(`SELECT ip.id doc_id, ip.doc_date, ip.doc_number, ip.source,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        ii.warehouse_id, ii.bucket, ii.pieces AS qty
      FROM issue_items ii
      JOIN issue_permits ip ON ip.id = ii.issue_permit_id
      JOIN items i ON i.id = ii.item_id
      WHERE ip.status = 'active'${d.sql}${w.sql}
      ORDER BY ip.doc_date, ip.id, ii.id`).all(...d.params, ...w.params);
    withUnits(rows, mode, ['qty']);
    return { rows, total_qty: rows.reduce((s, r) => s + num(r.qty), 0), total_qty_label: int(rows.reduce((s, r) => s + num(r.qty), 0)) + ' حبة' };
  });

  // 3) تقرير الخروج للعملاء — فواتير البيع فقط، بالقيمة بالريالي
  ipcMain.handle('reports:sales', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'inv.doc_date');
    const w = whClause(filters, 'ii.warehouse_id');
    const extra = [];
    const extraParams = [];
    if (filters.partyId) { extra.push(' AND inv.party_id = ?'); extraParams.push(Number(filters.partyId)); }
    const rows = db.prepare(`SELECT inv.id doc_id, inv.doc_date, inv.doc_number invoice_number, pa.name party_name,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        ii.warehouse_id, ii.bucket, ii.pieces AS qty, COALESCE(ii.total_price, 0) AS value
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      JOIN items i ON i.id = ii.item_id
      LEFT JOIN parties pa ON pa.id = inv.party_id
      WHERE inv.status = 'active' AND inv.invoice_type = 'sale'${d.sql}${w.sql}${extra.join('')}
      ORDER BY inv.doc_date, inv.id, ii.id`).all(...d.params, ...w.params, ...extraParams);
    withUnits(rows, mode, ['qty']);
    return {
      rows,
      total_qty: rows.reduce((s, r) => s + num(r.qty), 0),
      total_qty_label: int(rows.reduce((s, r) => s + num(r.qty), 0)) + ' حبة',
      total: rows.reduce((s, r) => s + num(r.value), 0),
    };
  });
  // 4) تقرير الإنتاج اليومي — لكل كرتون: سليم/تالف قبل/تالف بعد/الفارق/الأكياس/الكسور
  ipcMain.handle('reports:production', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'pr.result_date');
    const extra = [];
    const extraParams = [];
    if (filters.machineId) { extra.push(' AND pr.machine_id = ?'); extraParams.push(Number(filters.machineId)); }
    if (filters.shiftId) { extra.push(' AND pr.shift_id = ?'); extraParams.push(Number(filters.shiftId)); }
    // مستودع الصرف هو مخزن الخام الذي نُفخ، لا مخزن المنتج التام
    const whSel = `(SELECT ii.warehouse_id FROM issue_items ii
        WHERE ii.issue_permit_id = pr.issue_permit_id AND ii.item_id = c.item_id LIMIT 1)`;
    const w = whClause(filters, whSel);
    const rows = db.prepare(`SELECT pr.id, pr.result_date, pr.notes,
        c.id carton_id, c.carton_number, c.pieces AS carton_pieces, c.source AS carton_source,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        m.name machine_name, s.name shift_name,
        pr.good_pieces, pr.defect_before, pr.defect_after,
        (pr.good_pieces + pr.defect_before + pr.defect_after) AS accounted,
        (c.pieces - (pr.good_pieces + pr.defect_before + pr.defect_after)) AS variance,
        ${whSel} AS warehouse_id
      FROM production_results pr
      JOIN cartons c ON c.id = pr.carton_id
      JOIN items i ON i.id = c.item_id
      LEFT JOIN machines m ON m.id = pr.machine_id
      LEFT JOIN shifts s ON s.id = pr.shift_id
      WHERE 1=1${d.sql}${w.sql}${extra.join('')}
      ORDER BY pr.result_date, pr.id`).all(...d.params, ...w.params, ...extraParams);
    const whNames = Object.fromEntries(db.prepare('SELECT id, name FROM warehouses').all().map(x => [x.id, x.name]));
    for (const r of rows) {
      r.warehouse_name = whNames[r.warehouse_id] || '—';
      // الأكياس تُشتق من الحبات الصالحة للكرتون: لا يوجد ربط سطري بين الاستلام والكرتون
      const per = num(r.pieces_per_bag);
      r.used_bags = per > 0 ? Math.ceil(num(r.good_pieces) / per) : null;
      r.breaks = per > 0 ? num(r.good_pieces) % per : null;
    }
    withUnits(rows, mode, ['carton_pieces', 'good_pieces', 'defect_before', 'defect_after', 'accounted', 'variance']);
    return {
      rows,
      total_good: rows.reduce((s, r) => s + num(r.good_pieces), 0),
      total_defect: rows.reduce((s, r) => s + num(r.defect_before) + num(r.defect_after), 0),
      total_variance: rows.reduce((s, r) => s + num(r.variance), 0),
      total_bags: rows.reduce((s, r) => s + num(r.used_bags), 0),
    };
  });

  // 6) تقرير التالف — مصدر السطر: قبل النفخ أو بعده حين جاء من نتيجة إنتاج، ويدوي خلاف ذلك
  ipcMain.handle('reports:scrap', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'sm.doc_date');
    const w = whClause(filters, 'sm.warehouse_id');
    const rows = db.prepare(`SELECT sm.id, sm.doc_date, sm.doc_number, sm.disposition, sm.pieces AS qty,
        sm.warehouse_id, sm.is_customer, sm.party_id, sm.prod_carton_id,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        w.name warehouse_name, p.name party_name,
        (SELECT pr.defect_before FROM production_results pr WHERE pr.carton_id = sm.prod_carton_id) AS defect_before,
        (SELECT pr.defect_after  FROM production_results pr WHERE pr.carton_id = sm.prod_carton_id) AS defect_after
      FROM scrap_movements sm
      JOIN items i ON i.id = sm.item_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN parties p ON p.id = sm.party_id
      WHERE sm.status = 'active'${d.sql}${w.sql}
      ORDER BY sm.doc_date, sm.id`).all(...d.params, ...w.params);
    for (const r of rows) {
      if (r.prod_carton_id) {
        const b = num(r.defect_before);
        const a = num(r.defect_after);
        r.source_label = b > 0 && a > 0 ? 'تالف قبل + بعد' : b > 0 ? 'تالف قبل النفخ' : a > 0 ? 'تالف بعد النفخ' : 'تالف إنتاج';
      } else {
        r.source_label = 'سند يدوي';
      }
    }
    withUnits(rows, mode, ['qty']);
    const total = rows.reduce((s, r) => s + num(r.qty), 0);
    return { rows, total_qty: total, total_qty_label: int(total) + ' حبة' };
  });

  // 5) تقرير العهَد (النفخ للغير) — ما أخذه العميل من خامه وما سلّمناه وما تالف وباقٍ
  ipcMain.handle('reports:tolling', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const range = (col) => {
      const sql = [];
      const params = [];
      if (filters.from) { sql.push(` AND ${col} >= ?`); params.push(filters.from); }
      if (filters.to) { sql.push(` AND ${col} <= ?`); params.push(filters.to); }
      return { sql: sql.join(''), params };
    };
    const r1 = range('rr.doc_date');
    const r2 = range('dd.doc_date');
    const r3 = range('sm.doc_date');
    const extra = [];
    const extraParams = [];
    if (filters.partyId) { extra.push(' AND pa.id = ?'); extraParams.push(Number(filters.partyId)); }
    // ترتيب الوسائط يجب أن يطابق ظهور العلامات في نص SQL: خام، تسليم، تالف الكل، تالف العميل
    const rows = db.prepare(`SELECT pa.id party_id, pa.name party_name,
        COALESCE((SELECT SUM(ri.pieces) FROM customer_raw_items ri
          JOIN customer_raw_receipts rr ON rr.id = ri.receipt_id
          WHERE rr.party_id = pa.id AND rr.status = 'active'${r1.sql}), 0) AS raw_in,
        COALESCE((SELECT SUM(di.pieces) FROM customer_delivery_items di
          JOIN customer_deliveries dd ON dd.id = di.delivery_id
          WHERE dd.party_id = pa.id AND dd.status = 'active'${r2.sql}), 0) AS delivered,
        COALESCE((SELECT SUM(sm.pieces) FROM scrap_movements sm
          WHERE sm.party_id = pa.id AND sm.status = 'active'${r3.sql}), 0) AS scrap_out,
        COALESCE((SELECT SUM(sm.pieces) FROM scrap_movements sm
          WHERE sm.party_id = pa.id AND sm.status = 'active' AND sm.is_customer = 1${r3.sql}), 0) AS customer_defects
      FROM parties pa
      WHERE pa.type IN ('customer','both')${extra.join('')}
      ORDER BY pa.name`).all(...r1.params, ...r2.params, ...r3.params, ...r3.params, ...extraParams);
    for (const r of rows) {
      r.remaining = num(r.raw_in) - num(r.delivered) - num(r.scrap_out);
      // التحويل لوحدات التعبئة له معنى فقط إذا كان خام العميل كله من صنف واحد،
      // لأن «كرتون» صنفين مختلفين لا يُجمعان في رقم واحد.
      const only = db.prepare(`SELECT COUNT(DISTINCT ri.item_id) n, MAX(ri.item_id) item_id
          FROM customer_raw_items ri JOIN customer_raw_receipts rr ON rr.id = ri.receipt_id
          WHERE rr.party_id = ? AND rr.status = 'active'`).get(r.party_id);
      r.unit_item = only && only.n === 1 ? db.prepare('SELECT * FROM items WHERE id = ?').get(only.item_id) : null;
    }
    for (const r of rows) {
      const it = r.unit_item || {};
      for (const k of ['raw_in', 'delivered', 'customer_defects', 'remaining']) {
        r[`${k}_label`] = qtyText(r[k], it, mode);
      }
    }
    return {
      rows,
      total_raw: rows.reduce((s, r) => s + num(r.raw_in), 0),
      total_delivered: rows.reduce((s, r) => s + num(r.delivered), 0),
      total_defects: rows.reduce((s, r) => s + num(r.customer_defects), 0),
      total_remaining: rows.reduce((s, r) => s + num(r.remaining), 0),
    };
  });

  // 7) تقرير أرصدة المخازن — مخزن × صنف بثلاث سلل، بحبات لا أوزان
  ipcMain.handle('reports:stockBalances', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const w = whClause(filters, 'm.warehouse_id');
    const extra = [];
    const extraParams = [];
    if (filters.itemId) { extra.push(' AND m.item_id = ?'); extraParams.push(Number(filters.itemId)); }
    const rows = db.prepare(`SELECT w.id warehouse_id, w.name warehouse_name,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        COALESCE(SUM(CASE WHEN m.bucket = 'salem' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END), 0) AS qty_salem,
        COALESCE(SUM(CASE WHEN m.bucket = 'talef' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END), 0) AS qty_talef,
        COALESCE(SUM(CASE WHEN m.bucket = 'muharraz' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END), 0) AS qty_muharraz,
        COALESCE(SUM(m.qty_in_pieces), 0) - COALESCE(SUM(m.qty_out_pieces), 0) AS total_pieces
      FROM stock_moves m
      JOIN items i ON i.id = m.item_id
      JOIN warehouses w ON w.id = m.warehouse_id
      WHERE i.is_complement = 0${w.sql}${extra.join('')}
      GROUP BY m.item_id, m.warehouse_id
      HAVING total_pieces <> 0
      ORDER BY w.id, i.code`).all(...w.params, ...extraParams);
    withUnits(rows, mode, ['qty_salem', 'qty_talef', 'qty_muharraz', 'total_pieces']);
    return {
      rows,
      total_pieces: rows.reduce((s, r) => s + num(r.total_pieces), 0),
      total_salem: rows.reduce((s, r) => s + num(r.qty_salem), 0),
      total_talef: rows.reduce((s, r) => s + num(r.qty_talef), 0),
      total_muharraz: rows.reduce((s, r) => s + num(r.qty_muharraz), 0),
    };
  });

  ipcMain.handle('reports:partyStatement', (e, filters = {}) => {
    const db = getDb();
    if (!filters.partyId) throw new Error('اختر الطرف');
    const party = db.prepare('SELECT * FROM parties WHERE id=?').get(filters.partyId);
    if (!party) throw new Error('الطرف غير موجود');
    const where = [];
    const params = [];
    if (filters.from) { where.push('doc_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('doc_date <= ?'); params.push(filters.to); }
    const wh = where.length ? ` AND ${where.join(' AND ')}` : '';
    const rows = [];
    // فواتير على الطرف (عليه)
    db.prepare(`SELECT inv.id, inv.doc_number, inv.doc_date, inv.invoice_type, inv.status,
        COALESCE((SELECT SUM(total_price) FROM invoice_items ii WHERE ii.invoice_id=inv.id),0) total
      FROM invoices inv WHERE inv.party_id=?${wh} ORDER BY inv.doc_date, inv.id`).all(filters.partyId, ...params)
      .forEach(r => {
        if (r.status !== 'active') return;
        rows.push({ doc_date: r.doc_date, label: r.invoice_type === 'sale' ? 'فاتورة بيع' : r.invoice_type === 'scrap' ? 'فاتورة خردة' : 'فاتورة أجرة نفخ', doc_number: r.doc_number, debit: r.total, credit: 0 });
      });
    // مشتريات من الطرف (له)
    db.prepare(`SELECT p.id, p.doc_number, p.doc_date, p.status,
        COALESCE((SELECT SUM(total_price) FROM purchase_items pi WHERE pi.purchase_id=p.id),0) total
      FROM purchases p WHERE p.party_id=?${wh} ORDER BY p.doc_date, p.id`).all(filters.partyId, ...params)
      .forEach(r => {
        if (r.status !== 'active') return;
        rows.push({ doc_date: r.doc_date, label: 'فاتورة شراء', doc_number: r.doc_number, debit: 0, credit: r.total });
      });
    rows.sort((a, b) => (a.doc_date < b.doc_date ? -1 : a.doc_date > b.doc_date ? 1 : a.doc_number < b.doc_number ? -1 : 1));
    const total_debit = rows.reduce((s, r) => s + r.debit, 0);
    const total_credit = rows.reduce((s, r) => s + r.credit, 0);
    return { party: { id: party.id, name: party.name, type: party.type, phone: party.phone, address: party.address }, rows, total_debit, total_credit, net: total_credit - total_debit };
  });

  ipcMain.handle('reports:audit', (e, filters = {}) => {
    const db = getDb();
    const where = [];
    const params = [];
    if (filters.from) { where.push('date(a.created_at) >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('date(a.created_at) <= ?'); params.push(filters.to); }
    if (filters.userId) { where.push('a.user_id = ?'); params.push(filters.userId); }
    const wh = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return db.prepare(`SELECT a.id, a.created_at, u.full_name user_name, a.action, a.entity, a.entity_id
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id${wh}
      ORDER BY a.id DESC LIMIT 500`).all(...params);
  });

  // معرّف المخزن الرئيسي — تُقرأ من القاعدة لا من ترتيب الواجهة، لتصح الاستضافة لاحقاً
  ipcMain.handle('reports:meta', () => ({ mainWarehouseId: mainWarehouseId(getDb()) }));

  ipcMain.handle('reports:export', async (e, payload) => {
    const { defaultPath } = await dialog.showSaveDialog({
      title: 'تصدير التقرير',
      defaultPath: path.join(require('electron').app.getPath('documents'), payload.defaultName || 'تقرير.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!defaultPath) return { ok: false, canceled: true };
    const lines = [[...(payload.columns || [])], ...(payload.rows || [])]
      .map(row => row.map(csvCell).join(','));
    fs.writeFileSync(defaultPath, '\uFEFF' + lines.join('\r\n'), 'utf8');
    return { ok: true, path: defaultPath };
  });
};
