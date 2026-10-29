const { getDb } = require('../db');
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

// تسمية كمية للتقارير: حبة الصنف ثم مقابلها كرتون/كيس — بلا وزن إطلاقاً،
// لأن تقارير v2 لا تعرض أعمدة الكيلو والطن (الحبة هي وحدة القياس الوحيدة).
function piecesLabel(pieces, item = {}) {
  const p = Math.round(Number(pieces) || 0);
  const unit = item.unit_name || 'حبة';
  const abs = Math.abs(p);
  const sign = p < 0 ? '-' : '';
  const per = (k) => Number(item[k]) || 0;
  const parts = [`${sign}${int(abs)} ${unit}`];
  if (per('pieces_per_carton') && abs >= per('pieces_per_carton')) {
    const c = Math.floor(abs / per('pieces_per_carton'));
    const r = abs % per('pieces_per_carton');
    parts.push(r ? `${int(c)} كرتون + ${int(r)} ${unit}` : `${int(c)} كرتون`);
  }
  if (per('pieces_per_bag') && abs >= per('pieces_per_bag')) {
    const b = Math.floor(abs / per('pieces_per_bag'));
    const r = abs % per('pieces_per_bag');
    parts.push(r ? `${int(b)} كيس + ${int(r)} ${unit}` : `${int(b)} كيس`);
  }
  return parts.join(' — ');
}

function unitMode(filters) {
  return ['pieces', 'carton', 'bag'].includes(filters.unit) ? filters.unit : 'pieces';
}

// كمية واحدة بصيغة العرض المطلوبة. بلا حجم تعبئة صالح للصنف ترجع إلى وحدة الصنف نفسه،
// لأن «حبة» لم تعد تسمية عامة في v2 — لكل صنف وحدته (زجاجة/غطاء/كيس...).
function qtyText(pieces, item, mode) {
  const p = num(pieces);
  const unit = (item && item.unit_name) || 'حبة';
  const per = mode === 'carton' ? num(item && item.pieces_per_carton) : mode === 'bag' ? num(item && item.pieces_per_bag) : 0;
  if (per > 0) return `${dec(p / per)} ${UNIT_LABEL[mode]}`;
  return `${int(p)} ${unit}`;
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
    const rows = db.prepare(`SELECT i.id, i.code, i.name, i.unit_name, i.pieces_per_carton,
        i.pieces_per_shadda, i.pieces_per_bag,
        COALESCE(SUM(CASE WHEN m.bucket='salem' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_salem,
        COALESCE(SUM(CASE WHEN m.bucket='talef' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_talef,
        COALESCE(SUM(CASE WHEN m.bucket='muharraz' THEN m.qty_in_pieces - m.qty_out_pieces ELSE 0 END),0) qty_muharraz,
        COALESCE(SUM(m.qty_in_pieces),0) in_pieces,
        COALESCE(SUM(m.qty_out_pieces),0) out_pieces,
        COALESCE(SUM(m.qty_in_pieces),0) - COALESCE(SUM(m.qty_out_pieces),0) balance_pieces,
        (SELECT GROUP_CONCAT(DISTINCT pa.name) FROM purchase_items pi
          JOIN purchases pu ON pu.id = pi.purchase_id JOIN parties pa ON pa.id = pu.party_id
          WHERE pi.item_id = i.id AND pa.name IS NOT NULL) suppliers,
        (SELECT GROUP_CONCAT(DISTINCT pa.name) FROM invoice_items ii
          JOIN invoices inv ON inv.id = ii.invoice_id JOIN parties pa ON pa.id = inv.party_id
          WHERE ii.item_id = i.id AND pa.name IS NOT NULL) customers
      FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id${joinWh}
      WHERE i.is_complement = 0
      GROUP BY i.id${havingWh} ORDER BY i.code`).all(...params);
    return rows.map(r => ({ ...r, balance_label: piecesLabel(r.balance_pieces, r) }));
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
        i.pieces_per_carton, i.pieces_per_bag, w.name warehouse_name,
        m.qty_in_pieces, m.qty_out_pieces, m.bucket, m.notes
      FROM stock_moves m
      JOIN items i ON i.id = m.item_id
      JOIN warehouses w ON w.id = m.warehouse_id${wh}
      ORDER BY m.doc_date, m.id`).all(...params);
    let balP = 0;
    for (const r of rows) {
      balP += r.qty_in_pieces - r.qty_out_pieces;
      r.balance_pieces = balP;
      r.balance_label = piecesLabel(balP, r);
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
      WHERE 1=1${d.sql}${w.sql}${extra.join('')}
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
      WHERE 1=1${d.sql}${w.sql}
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
      WHERE inv.invoice_type = 'sale'${d.sql}${w.sql}${extra.join('')}
      ORDER BY inv.doc_date, inv.id, ii.id`).all(...d.params, ...w.params, ...extraParams);
    withUnits(rows, mode, ['qty']);
    return {
      rows,
      total_qty: rows.reduce((s, r) => s + num(r.qty), 0),
      total_qty_label: int(rows.reduce((s, r) => s + num(r.qty), 0)) + ' حبة',
      total: rows.reduce((s, r) => s + num(r.value), 0),
    };
  });
  // 4) تقرير الإنتاج اليومي — سطر لكل كرتون في سند استلام، وملخّص على مستوى السند
  ipcMain.handle('reports:production', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'r.doc_date');
    const extra = [];
    const extraParams = [];
    if (filters.machineId) { extra.push(' AND r.machine_id = ?'); extraParams.push(Number(filters.machineId)); }
    if (filters.shiftId) { extra.push(' AND r.shift_id = ?'); extraParams.push(Number(filters.shiftId)); }
    if (filters.fgItemId) { extra.push(' AND r.fg_item_id = ?'); extraParams.push(Number(filters.fgItemId)); }
    // مخزن الاستلام هو مخزن التام — وهو ما يُفلتر به التقرير
    const w = whClause(filters, 'r.warehouse_id');
    const where = `WHERE 1=1${d.sql}${w.sql}${extra.join('')}`;
    const params = [...d.params, ...w.params, ...extraParams];
    const rows = db.prepare(`SELECT r.id receipt_id, r.doc_number, r.doc_date AS result_date, r.source,
        r.variance_pieces, r.notes,
        c.id carton_id, c.carton_number, c.pieces AS carton_pieces,
        ri.id item_id, ri.code, ri.name, ri.unit_name, ri.pieces_per_carton, ri.pieces_per_bag,
        fg.id fg_item_id, fg.code fg_code, fg.name fg_name, fg.unit_name fg_unit_name,
        fg.pieces_per_carton AS fg_pieces_per_carton, fg.pieces_per_bag AS fg_pieces_per_bag,
        m.name machine_name, s.name shift_name, w.name warehouse_name,
        rc.good_pieces, rc.defect_before_pieces AS defect_before, rc.defect_after_pieces AS defect_after,
        (rc.good_pieces + rc.defect_before_pieces + rc.defect_after_pieces) AS accounted,
        (c.pieces - (rc.good_pieces + rc.defect_before_pieces + rc.defect_after_pieces)) AS variance
      FROM production_receipts r
      JOIN production_receipt_cartons rc ON rc.receipt_id = r.id
      JOIN cartons c ON c.id = rc.carton_id
      JOIN items ri ON ri.id = c.item_id
      JOIN items fg ON fg.id = r.fg_item_id
      LEFT JOIN machines m ON m.id = r.machine_id
      LEFT JOIN shifts s ON s.id = r.shift_id
      LEFT JOIN warehouses w ON w.id = r.warehouse_id
      ${where}
      ORDER BY r.doc_date, r.id, c.carton_number`).all(...params);
    // كل كمية تُنسَب إلى وحدة صنفها الصحيح: حبات الكرتون وتالف «قبل» من الخام،
    // والسليم وتالف «بعد» والمحسوب والفارق من الصنف النهائي. تمرير الصف كما هو إلى
    // qtyText كان يلبس التامَ وحدةَ الخام وحجمَ تعبئته (10,000 حبة عبوة تظهر «كجم»).
    const rawCtx = (r) => ({ unit_name: r.unit_name, pieces_per_carton: r.pieces_per_carton, pieces_per_bag: r.pieces_per_bag });
    const fgCtx = (r) => ({ unit_name: r.fg_unit_name, pieces_per_carton: r.fg_pieces_per_carton, pieces_per_bag: r.fg_pieces_per_bag });
    for (const r of rows) {
      r.carton_pieces_label = qtyText(r.carton_pieces, rawCtx(r), mode);
      r.defect_before_label = qtyText(r.defect_before, rawCtx(r), mode);
      for (const k of ['good_pieces', 'defect_after', 'accounted', 'variance']) {
        r[`${k}_label`] = qtyText(r[k], fgCtx(r), mode);
      }
    }
    // الملخّص على مستوى السند وحده: الفارق والأكياس قيمة واحدة للسند، وجمعها على أسطر
    // الكراتين سيُضاعفها حتماً إن كان للسند أكثر من كرتون.
    const sum = db.prepare(`SELECT
        COUNT(*) receipts_count,
        COALESCE(SUM(r.issued_pieces),0) issued,
        COALESCE(SUM(r.good_pieces),0) good,
        COALESCE(SUM(r.defect_before_pieces),0) defect_before,
        COALESCE(SUM(r.defect_after_pieces),0) defect_after,
        COALESCE(SUM(r.total_pieces),0) total,
        COALESCE(SUM(CASE WHEN r.variance_pieces > 0 THEN r.variance_pieces ELSE 0 END),0) shortage,
        COALESCE(SUM(CASE WHEN r.variance_pieces < 0 THEN -r.variance_pieces ELSE 0 END),0) surplus,
        COALESCE(SUM(r.bags_used),0) used_bags
      FROM production_receipts r ${where}`).get(...params);
    const out = {
      rows,
      receipts_count: sum.receipts_count,
      total_issued: sum.issued,
      total_good: sum.good,
      total_defect_before: sum.defect_before,
      total_defect_after: sum.defect_after,
      total_defect: sum.defect_before + sum.defect_after,
      total_accounted: sum.total,
      total_shortage: sum.shortage,
      total_surplus: sum.surplus,
      total_bags: sum.used_bags,
    };
    for (const [key, value] of Object.entries(out)) {
      if (key.startsWith('total_') && !key.endsWith('_label') && typeof value === 'number') {
        out[`${key}_label`] = `${int(value)} حبة`;
      }
    }
    return out;
  });

  // 6) تقرير التالف — مصدر السطر: قبل النفخ أو بعده حين جاء من نتيجة إنتاج، ويدوي خلاف ذلك
  ipcMain.handle('reports:scrap', (e, filters = {}) => {
    const db = getDb();
    const mode = unitMode(filters);
    const d = dateClause(filters, 'sm.doc_date');
    const w = whClause(filters, 'sm.warehouse_id');
    const rows = db.prepare(`SELECT sm.id, sm.doc_date, sm.doc_number, sm.disposition, sm.pieces AS qty,
        sm.warehouse_id, sm.is_customer, sm.party_id, sm.prod_receipt_id,
        i.id item_id, i.code, i.name, i.unit_name, i.pieces_per_carton, i.pieces_per_bag,
        w.name warehouse_name, p.name party_name,
        (SELECT pr.doc_number FROM production_receipts pr WHERE pr.id = sm.prod_receipt_id) AS receipt_number,
        (SELECT pr.defect_before_pieces FROM production_receipts pr WHERE pr.id = sm.prod_receipt_id) AS defect_before,
        (SELECT pr.defect_after_pieces  FROM production_receipts pr WHERE pr.id = sm.prod_receipt_id) AS defect_after
      FROM scrap_movements sm
      JOIN items i ON i.id = sm.item_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN parties p ON p.id = sm.party_id
      WHERE 1=1${d.sql}${w.sql}
      ORDER BY sm.doc_date, sm.id`).all(...d.params, ...w.params);
    for (const r of rows) {
      if (r.prod_receipt_id) {
        const b = num(r.defect_before);
        const a = num(r.defect_after);
        const tag = r.receipt_number ? ` — سند ${r.receipt_number}` : '';
        r.source_label = b > 0 && a > 0 ? `تالف قبل + بعد${tag}` : b > 0 ? `تالف قبل النفخ${tag}` : a > 0 ? `تالف بعد النفخ${tag}` : `تالف إنتاج${tag}`;
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
          WHERE rr.party_id = pa.id${r1.sql}), 0) AS raw_in,
        COALESCE((SELECT SUM(di.pieces) FROM customer_delivery_items di
          JOIN customer_deliveries dd ON dd.id = di.delivery_id
          WHERE dd.party_id = pa.id${r2.sql}), 0) AS delivered,
        COALESCE((SELECT SUM(sm.pieces) FROM scrap_movements sm
          WHERE sm.party_id = pa.id${r3.sql}), 0) AS scrap_out,
        COALESCE((SELECT SUM(sm.pieces) FROM scrap_movements sm
          WHERE sm.party_id = pa.id AND sm.is_customer = 1${r3.sql}), 0) AS customer_defects
      FROM parties pa
      WHERE pa.type IN ('customer','both')${extra.join('')}
      ORDER BY pa.name`).all(...r1.params, ...r2.params, ...r3.params, ...r3.params, ...extraParams);
    for (const r of rows) {
      r.remaining = num(r.raw_in) - num(r.delivered) - num(r.scrap_out);
      // التحويل لوحدات التعبئة له معنى فقط إذا كان خام العميل كله من صنف واحد،
      // لأن «كرتون» صنفين مختلفين لا يُجمعان في رقم واحد.
      const only = db.prepare(`SELECT COUNT(DISTINCT ri.item_id) n, MAX(ri.item_id) item_id
          FROM customer_raw_items ri JOIN customer_raw_receipts rr ON rr.id = ri.receipt_id
          WHERE rr.party_id = ?`).get(r.party_id);
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
    db.prepare(`SELECT inv.id, inv.doc_number, inv.doc_date, inv.invoice_type,
        COALESCE((SELECT SUM(total_price) FROM invoice_items ii WHERE ii.invoice_id=inv.id),0) total
      FROM invoices inv WHERE inv.party_id=?${wh} ORDER BY inv.doc_date, inv.id`).all(filters.partyId, ...params)
      .forEach(r => {
        // الأثر يُقرأ من الدفتر مباشرة بعد الحذف الفعلي
        rows.push({ doc_date: r.doc_date, label: r.invoice_type === 'sale' ? 'فاتورة بيع' : r.invoice_type === 'scrap' ? 'فاتورة خردة' : 'فاتورة أجرة نفخ', doc_number: r.doc_number, debit: r.total, credit: 0 });
      });
    // مشتريات من الطرف (له)
    db.prepare(`SELECT p.id, p.doc_number, p.doc_date,
        COALESCE((SELECT SUM(total_price) FROM purchase_items pi WHERE pi.purchase_id=p.id),0) total
      FROM purchases p WHERE p.party_id=?${wh} ORDER BY p.doc_date, p.id`).all(filters.partyId, ...params)
      .forEach(r => {
        // الأثر يُقرأ من الدفتر مباشرة بعد الحذف الفعلي
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
