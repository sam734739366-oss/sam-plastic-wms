const { getDb } = require('../db');

// متابعة دورة الكراتين: كل كرتون (دخول/صرف/نتيجة) ومقارنة كل تصريح صرف بما استُلم من إنتاج تام
// القناة قراءة فقط — لا أثر لها على المخزون، فالحركات تبقى مصدر الإحصاء الوحيد بلا تكرار
module.exports = function register(ipcMain) {
  ipcMain.handle('cartons:cycle', () => {
    const db = getDb();
    const cartons = db.prepare(`SELECT c.id, c.carton_number, c.pieces, c.status, c.issue_date,
        i.code item_code, i.name item_name,
        p.doc_number purchase_number, p.doc_date purchase_date,
        ip.doc_number issue_number, ip.doc_date issue_doc_date,
        m.name machine_name, s.name shift_name,
        pr.result_date, pr.good_pieces, pr.defect_before, pr.defect_after
      FROM cartons c
      JOIN items i ON i.id=c.item_id
      LEFT JOIN purchases p ON p.id=c.purchase_id
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id
      LEFT JOIN machines m ON m.id=ip.machine_id
      LEFT JOIN shifts s ON s.id=ip.shift_id
      LEFT JOIN production_results pr ON pr.carton_id=c.id
      ORDER BY c.id DESC`).all();
    for (const r of cartons) {
      // الفرق: زيادة (باقٍ في الكرتون غير محسوب) أو نقص (تجاوز الإنتاج حبات الكرتون) أو مكتمل
      const total = (Number(r.good_pieces) || 0) + (Number(r.defect_before) || 0) + (Number(r.defect_after) || 0);
      r.rest = r.status === 'finished' ? (Number(r.pieces) || 0) - total : null;
      r.total = total;
    }
    // مقارنة كل تصريح صرف نشط: المصروف من الكراتين مقابل المعلن سليماً مقابل المستلم فعلاً
    const issues = db.prepare(`SELECT ip.id, ip.doc_number, ip.doc_date,
        COALESCE(SUM(c.pieces),0) issued_pieces,
        COALESCE(SUM(pr.good_pieces),0) declared_good,
        COALESCE((SELECT SUM(ri.pieces) FROM receive_items ri
          JOIN receive_permits rp ON rp.id=ri.receive_permit_id
          WHERE rp.issue_permit_id=ip.id AND rp.status='active'),0) received_pieces
      FROM issue_permits ip
      LEFT JOIN cartons c ON c.issue_permit_id=ip.id
      LEFT JOIN production_results pr ON pr.carton_id=c.id
      WHERE ip.status='active'
      GROUP BY ip.id
      ORDER BY ip.id DESC`).all();
    for (const r of issues) {
      r.receive_diff = (Number(r.received_pieces) || 0) - (Number(r.declared_good) || 0);
    }
    return { cartons, issues };
  });
};
