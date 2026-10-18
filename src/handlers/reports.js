const { getDb } = require('../db');
const { formatQty } = require('../units');
const { dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = function register(ipcMain) {
  ipcMain.handle('reports:inventory', (e, filters = {}) => {
    const db = getDb();
    const where = [];
    const params = [];
    let joinWh = '';
    if (filters.warehouseId) { joinWh = ' AND m.warehouse_id = ?'; params.push(filters.warehouseId); }
    if (filters.group) { where.push('i.item_group = ?'); params.push(filters.group); }
    const wh = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`SELECT i.id, i.code, i.name, i.item_group, i.unit_name, i.weight_grams, i.pieces_per_carton,
        COALESCE(SUM(m.qty_in_pieces),0) in_pieces,
        COALESCE(SUM(m.qty_out_pieces),0) out_pieces,
        COALESCE(SUM(m.qty_in_pieces),0) - COALESCE(SUM(m.qty_out_pieces),0) balance_pieces,
        COALESCE(SUM(m.weight_in_kg),0) - COALESCE(SUM(m.weight_out_kg),0) balance_kg
      FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id${joinWh}${wh}
      GROUP BY i.id ORDER BY i.item_group, i.code`).all(...params);
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
    const rows = db.prepare(`SELECT m.id, m.doc_type, m.doc_number, m.doc_date, i.code, i.name, i.unit_name,
        i.weight_grams, i.pieces_per_carton, w.name warehouse_name,
        m.qty_in_pieces, m.qty_out_pieces, m.weight_in_kg, m.weight_out_kg, m.notes
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

  ipcMain.handle('reports:production', (e, filters = {}) => {
    const db = getDb();
    const where = [];
    const params = [];
    if (filters.from) { where.push('pr.result_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('pr.result_date <= ?'); params.push(filters.to); }
    if (filters.machineId) { where.push('pr.machine_id = ?'); params.push(filters.machineId); }
    const wh = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return db.prepare(`SELECT pr.id, pr.result_date, c.carton_number, i.code, i.name, i.unit_name,
        i.weight_grams, i.pieces_per_carton, ip.doc_number issue_number,
        m.name machine_name, s.name shift_name,
        pr.good_pieces, pr.defect_before, pr.defect_after,
        (pr.good_pieces + pr.defect_before + pr.defect_after) total_pieces, pr.notes
      FROM production_results pr
      JOIN cartons c ON c.id = pr.carton_id
      JOIN items i ON i.id = c.item_id
      JOIN issue_permits ip ON ip.id = pr.issue_permit_id
      LEFT JOIN machines m ON m.id = pr.machine_id
      LEFT JOIN shifts s ON s.id = pr.shift_id${wh}
      ORDER BY pr.result_date DESC, pr.id DESC`).all(...params);
  });

  ipcMain.handle('reports:scrap', (e, filters = {}) => {
    const db = getDb();
    const where = ['sm.status = ?'];
    const params = ['active'];
    if (filters.from) { where.push('sm.doc_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('sm.doc_date <= ?'); params.push(filters.to); }
    return db.prepare(`SELECT sm.id, sm.doc_number, sm.doc_date, i.code, i.name, sm.disposition,
        w.name warehouse_name, p.name party_name, sm.pieces, sm.weight_kg, sm.price, sm.notes
      FROM scrap_movements sm
      JOIN items i ON i.id = sm.item_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN parties p ON p.id = sm.party_id
      WHERE ${where.join(' AND ')}
      ORDER BY sm.doc_date DESC, sm.id DESC`).all(...params);
  });

  ipcMain.handle('reports:purchases', (e, filters = {}) => {
    const db = getDb();
    const where = ['p.status = ?'];
    const params = ['active'];
    if (filters.from) { where.push('p.doc_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('p.doc_date <= ?'); params.push(filters.to); }
    if (filters.partyId) { where.push('p.party_id = ?'); params.push(filters.partyId); }
    const rows = db.prepare(`SELECT p.id, p.doc_number, p.doc_date, pa.name party_name, p.notes,
        (SELECT COALESCE(SUM(total_price),0) FROM purchase_items pi WHERE pi.purchase_id = p.id) total,
        (SELECT COALESCE(SUM(pieces),0) FROM purchase_items pi WHERE pi.purchase_id = p.id) total_pieces
      FROM purchases p LEFT JOIN parties pa ON pa.id = p.party_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.doc_date DESC, p.id DESC`).all(...params);
    return { rows, total: rows.reduce((s, r) => s + r.total, 0), total_pieces: rows.reduce((s, r) => s + r.total_pieces, 0) };
  });

  ipcMain.handle('reports:sales', (e, filters = {}) => {
    const db = getDb();
    const where = ['inv.status = ?'];
    const params = ['active'];
    if (filters.from) { where.push('inv.doc_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('inv.doc_date <= ?'); params.push(filters.to); }
    if (filters.partyId) { where.push('inv.party_id = ?'); params.push(filters.partyId); }
    const rows = db.prepare(`SELECT inv.id, inv.doc_number, inv.doc_date, inv.invoice_type,
        pa.name party_name, inv.driver_name, inv.car_number, inv.notes,
        (SELECT COALESCE(SUM(total_price),0) FROM invoice_items ii WHERE ii.invoice_id = inv.id) total
      FROM invoices inv LEFT JOIN parties pa ON pa.id = inv.party_id
      WHERE ${where.join(' AND ')}
      ORDER BY inv.doc_date DESC, inv.id DESC`).all(...params);
    return { rows, total: rows.reduce((s, r) => s + r.total, 0) };
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
