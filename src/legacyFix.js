// منطق إصلاح التالف التاريخي المسجل على كراتين خام العميل (النفخ للغير) — بلا طرفية
//
// الخلل: قبل تصحيح production:save كان تالف النتيجة يُضاف إلى عداد items.qty_talef
// ويُكتب كحركة stock_moves بسلة talef، حتى لو كان الكرتون من عهدة عميل.
//
// هذه الوحدة تُحلّل وتُصلح، وتُرجع نتائج مُهيّأة ليستخدمها طرفان:
//   • scripts/fix-legacy-tolling-defects.js  (سطر الأوامر)
//   • backup:fixLegacy في التطبيق (زر «إصلاح البيانات القديمة»)
// الوحدة لا تطبع شيئاً على شاشة: كل مخرجاتها قيم قابلة للعرض.

const { withTransaction } = require('./db');

const DEFECT_DISP = 'production_defect';

function assertMigrated(db) {
  const cols = db.prepare('PRAGMA table_info(cartons)').all().map((c) => c.name);
  if (!cols.includes('source') || !cols.includes('party_id')) {
    throw new Error('قاعدة البيانات لم تُرحَّل بعد (أعمدة cartons.source/party_id ناقصة) — افتح البرنامج مرة واحدة ثم أعيد المحاولة');
  }
}

// حركة production بسلة talef على كرتون عميل، بملكيّة الكرتون أو تصريحه.
// الصافي qty_in − qty_out حتى لا تُحسب صفوف «عكس حركة» إن وُجدت.
function findLegacyRows(db) {
  const rows = db.prepare(`
    SELECT sm.id AS move_id, sm.doc_id AS carton_id, sm.item_id, sm.warehouse_id,
           (sm.qty_in_pieces - sm.qty_out_pieces) AS defects,
           c.carton_number, COALESCE(c.party_id, ip.party_id) AS party_id,
           c.source AS carton_source, ip.source AS permit_source
      FROM stock_moves sm
      JOIN cartons c ON c.id = sm.doc_id
      LEFT JOIN issue_permits ip ON ip.id = c.issue_permit_id
     WHERE sm.doc_type = 'production'
       AND sm.bucket = 'talef'
       AND (c.source = 'customer' OR ip.source = 'customer')
       AND (sm.qty_in_pieces - sm.qty_out_pieces) != 0
     ORDER BY c.carton_number`).all();
  return rows.filter((r) => r.defects > 0);
}

function linkedCartonIds(db) {
  return new Set(db.prepare('SELECT prod_carton_id FROM scrap_movements WHERE prod_carton_id IS NOT NULL')
    .all().map((r) => r.prod_carton_id));
}

function hasResult(db, cartonId) {
  return !!db.prepare('SELECT 1 FROM production_results WHERE carton_id = ?').get(cartonId);
}

// تجميع لكل صنف: ما سيُخصم من عدّاد تالف المصنع، مع بيان كل كرتون.
// shortfall = true تعني العدّاد لا يتّسع للخصم ⇒ الصنف كله يُترك للمراجعة اليدوية.
function groupByItem(db, rows, linked) {
  const byItem = new Map();
  for (const r of rows) {
    const item = db.prepare('SELECT id, code, name, qty_talef FROM items WHERE id = ?').get(r.item_id);
    if (!item) {
      const ghost = byItem.get('deleted') || { itemId: null, code: null, name: 'صنف محذوف', qty_talef: 0, total: 0, cartons: [], shortfall: true };
      ghost.cartons.push(cartonView(db, r, linked));
      byItem.set('deleted', ghost);
      continue;
    }
    const agg = byItem.get(item.id) || {
      itemId: item.id, code: item.code, name: item.name, qty_talef: Number(item.qty_talef) || 0, total: 0, cartons: [],
    };
    agg.total += r.defects;
    agg.cartons.push(cartonView(db, r, linked));
    byItem.set(item.id, agg);
  }
  return [...byItem.values()].map((g) => {
    // after يُحسب في متغير: الإشارة إلى g.after داخل نفس الكائن تعطي undefined
    const after = g.qty_talef - g.total;
    return { ...g, after, shortfall: g.itemId === null || after < 0 };
  });
}

function cartonView(db, r, linked) {
  const party = r.party_id ? db.prepare('SELECT name FROM parties WHERE id = ?').get(r.party_id) : null;
  return {
    cartonId: r.carton_id,
    cartonNumber: r.carton_number,
    moveId: r.move_id,
    defects: r.defects,
    owner: party ? party.name : null,
    partyId: r.party_id || null,
    viaCarton: r.carton_source === 'customer',
    hasScrapDoc: linked.has(r.carton_id),
    hasResult: hasResult(db, r.carton_id),
  };
}

function analyze(db) {
  assertMigrated(db);
  const rows = findLegacyRows(db);
  const linked = linkedCartonIds(db);
  const items = groupByItem(db, rows, linked);
  const cartons = items.flatMap((i) => i.cartons);
  return {
    rowCount: rows.length,
    cartonCount: cartons.length,
    totalDefects: cartons.reduce((s, c) => s + c.defects, 0),
    items,
    insufficient: items.filter((i) => i.shortfall),
    orphans: cartons.filter((c) => !c.hasResult),
    missingScrap: cartons.filter((c) => !c.hasScrapDoc && c.partyId),
  };
}

function scrapDocNumber(db, cartonNumber) {
  let n = `تالف إنتاج ${cartonNumber}`;
  for (let i = 2; db.prepare('SELECT 1 FROM scrap_movements WHERE doc_number = ?').get(n); i++) {
    n = `تالف إنتاج ${cartonNumber}-${i}`;
  }
  return n;
}

// التنفيذ: خصم العدّادات ثم حذف الحركات، وخيار إنشاء سند التالف للعميل.
// لا يلمس صنفاً عدّاده لا يتّسع (يتركه للمراجعة) بدل أن ينتج عدّاداً سالباً.
function apply(db, { createScrap = false } = {}) {
  const report = analyze(db);
  const result = { removed: 0, subtracted: 0, createdScrap: 0, skipped: [], perItem: [] };
  if (!report.items.length) return { ...report, ...result };

  withTransaction(db, () => {
    for (const group of report.items) {
      if (group.shortfall) {
        result.skipped.push({ code: group.code, counter: group.qty_talef, need: group.total });
        continue;
      }
      const live = db.prepare('SELECT qty_talef FROM items WHERE id = ?').get(group.itemId);
      if (!live || (Number(live.qty_talef) || 0) < group.total) {
        result.skipped.push({ code: group.code, counter: live ? Number(live.qty_talef) || 0 : null, need: group.total });
        continue;
      }
      db.prepare('UPDATE items SET qty_talef = qty_talef - ? WHERE id = ?').run(group.total, group.itemId);
      result.subtracted += group.total;
      result.perItem.push({ itemId: group.itemId, code: group.code, amount: group.total });
      for (const c of group.cartons) {
        db.prepare('DELETE FROM stock_moves WHERE id = ?').run(c.moveId);
        result.removed++;
        if (createScrap && !c.hasScrapDoc && c.partyId) {
          insertCustomerScrap(db, c, group.itemId);
          result.createdScrap++;
        }
      }
    }
  });
  return { ...report, ...result };
}

function insertCustomerScrap(db, carton, itemId) {
  const item = db.prepare('SELECT weight_grams FROM items WHERE id = ?').get(itemId);
  const result = db.prepare('SELECT result_date FROM production_results WHERE carton_id = ?').get(carton.cartonId);
  const date = result ? result.result_date : new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO scrap_movements
      (doc_number, doc_date, item_id, disposition, warehouse_id, party_id,
       pieces, weight_kg, price, talef_take, salem_take, is_customer, notes, status, created_by, prod_carton_id)
    VALUES (?,?,?, 'production_defect', NULL, ?,
            ?, ?, NULL, 0, 0, 1, ?, 'active', NULL, ?)`)
    .run(scrapDocNumber(db, carton.cartonNumber), date, itemId, carton.partyId, carton.defects,
      carton.defects * (Number(item && item.weight_grams) || 0) / 1000,
      `تالف إنتاج تاريخي على كرتون العميل (${carton.cartonNumber}) — أُصلح بأداة إصلاح البيانات القديمة`,
      carton.cartonId);
}

// ما زالت الحركة القديمة موجودة بعد الإصلاح ⇒ لم تُعالَج (عادةً صنف متروك للمراجعة).
// residualPerItem: عدّاد الصنف مقابل صافي حركات سلة التالف — التطابق هو الثبات المطلوب.
function verify(db, itemIds = []) {
  const residual = db.prepare(`
    SELECT COUNT(*) c FROM stock_moves sm
    JOIN cartons c ON c.id = sm.doc_id
    LEFT JOIN issue_permits ip ON ip.id = c.issue_permit_id
     WHERE sm.doc_type = 'production' AND sm.bucket = 'talef'
       AND (c.source = 'customer' OR ip.source = 'customer')
       AND (sm.qty_in_pieces - sm.qty_out_pieces) > 0`).get().c;
  const perItem = itemIds.map((itemId) => {
    const it = db.prepare('SELECT code, qty_talef FROM items WHERE id = ?').get(itemId);
    if (!it) return null;
    const net = db.prepare(`SELECT COALESCE(SUM(qty_in_pieces),0) - COALESCE(SUM(qty_out_pieces),0) n
      FROM stock_moves WHERE item_id = ? AND bucket = 'talef'`).get(itemId).n;
    return { code: it.code, counter: Number(it.qty_talef) || 0, net, match: (Number(it.qty_talef) || 0) === net };
  }).filter(Boolean);
  return { residual, perItem };
}

module.exports = { analyze, apply, verify, findLegacyRows, assertMigrated, DEFECT_DISP };
