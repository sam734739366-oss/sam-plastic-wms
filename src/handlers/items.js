const { getDb, withTransaction } = require('../db');
const { audit } = require('../audit');

const GROUP_PREFIX = { 1: '001', 2: '002', 3: '003', 4: '004', 5: '005' };

module.exports = function register(ipcMain) {
  ipcMain.handle('items:list', (e, group) => {
    const q = group ? 'WHERE item_group = ?' : '';
    return getDb().prepare(`SELECT * FROM items ${q} ORDER BY code`).all(...(group ? [group] : []));
  });
  ipcMain.handle('items:save', (e, row, userId) => {
    const db = getDb();
    const code = String(row.code || '').trim();
    if (!code) throw new Error('كود الصنف مطلوب');
    if (!row.name || !row.name.trim()) throw new Error('اسم الصنف مطلوب');
    const prefix = GROUP_PREFIX[row.item_group];
    if (!prefix || !code.startsWith(prefix)) throw new Error(`كود المجموعة ${row.item_group} يجب أن يبدأ بـ ${prefix}`);
    const dup = db.prepare('SELECT id FROM items WHERE code=? AND id IS NOT ?').get(code, row.id || -1);
    if (dup) throw new Error('كود الصنف مكرر — اختر كوداً آخر');
    const isNew = !row.id;
    const before = isNew ? null : db.prepare('SELECT * FROM items WHERE id=?').get(row.id);
    let id = row.id;
    const fields = { code, name: row.name.trim(), item_group: row.item_group, unit_name: row.unit_name || 'حبة',
      weight_grams: row.weight_grams || null, pieces_per_carton: row.pieces_per_carton || null,
      pieces_per_bag: row.pieces_per_bag || null, service_price: row.service_price || null,
      is_recycled: row.is_recycled ? 1 : 0, brand: row.brand || null, size_label: row.size_label || null,
      bale_size: row.bale_size || null, bale_condition: row.bale_condition || null,
      bale_mixed: row.bale_mixed ? 1 : 0, notes: row.notes || null };
    if (id) {
      db.prepare(`UPDATE items SET code=@code,name=@name,item_group=@item_group,unit_name=@unit_name,
        weight_grams=@weight_grams,pieces_per_carton=@pieces_per_carton,pieces_per_bag=@pieces_per_bag,
        service_price=@service_price,is_recycled=@is_recycled,brand=@brand,size_label=@size_label,
        bale_size=@bale_size,bale_condition=@bale_condition,bale_mixed=@bale_mixed,notes=@notes WHERE id=@id`)
        .run({ ...fields, id });
    } else {
      id = db.prepare(`INSERT INTO items (code,name,item_group,unit_name,weight_grams,pieces_per_carton,
        pieces_per_bag,service_price,is_recycled,brand,size_label,bale_size,bale_condition,bale_mixed,notes)
        VALUES (@code,@name,@item_group,@unit_name,@weight_grams,@pieces_per_carton,@pieces_per_bag,
        @service_price,@is_recycled,@brand,@size_label,@bale_size,@bale_condition,@bale_mixed,@notes)`)
        .run(fields).lastInsertRowid;
    }
    audit(db, userId, isNew ? 'create' : 'update', 'item', id, before, fields);
    return { id };
  });
  ipcMain.handle('items:delete', (e, id, userId) => {
    const db = getDb();
    const used = db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE item_id=?').get(id).c;
    if (used > 0) throw new Error('لا يمكن حذف صنف له حركات مخزون');
    const before = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!before) throw new Error('الصنف غير موجود');
    db.prepare('DELETE FROM items WHERE id=?').run(id);
    audit(db, userId, 'delete', 'item', id, before, null);
    return { ok: true };
  });
  ipcMain.handle('items:import', (e, rows, userId) => {
    const db = getDb();
    let count = 0;
    withTransaction(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO items (code,name,item_group,unit_name,weight_grams,
        pieces_per_carton,pieces_per_bag,service_price,is_recycled,brand,size_label,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const res = ins.run(r.code, r.name, r.item_group, r.unit_name || 'حبة', r.weight_grams || null,
          r.pieces_per_carton || null, r.pieces_per_bag || null, r.service_price || null,
          r.is_recycled ? 1 : 0, r.brand || null, r.size_label || null, r.notes || null);
        count += res.changes;
      }
    });
    audit(db, userId, 'import', 'items', null, null, { imported: count });
    return { imported: count };
  });
};
