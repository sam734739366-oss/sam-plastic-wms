const { getDb } = require('../db');

// ===== متابعة دورة الكراتين =====
// كل كرتون بمراحله: دخول (فاتورة شراء أو سند خام عميل) → صرف للإنتاج → نتيجة في استلام إنتاج.
// مقارنة كل تصريح صرف: المصروف من الكراتين مقابل المُعلَن سليماً مقابل المستلَم فعلاً
// (المستلَم =good + فائض التسوية، لأنه ما دخل المخزون فعلاً من الصنف النهائي).
// القناة قراءة فقط — لا أثر لها على المخزون، فالحركات تبقى مصدر الإحصاء الوحيد بلا تكرار.
module.exports = function register(ipcMain) {
  ipcMain.handle('cartons:cycle', () => {
    const db = getDb();
    // نتيجة الكرتون = أحدث سطر نتيجة مكتوب له (استلام الإنتاج يعيد بناء أسطره عند التعديل)
    const cartons = db.prepare(`SELECT c.id, c.carton_number, c.pieces, c.status, c.issue_date,
        c.source, c.party_id, pa.name party_name, r.doc_number AS receipt_number,
        i.code item_code, i.name item_name,
        p.doc_number purchase_number, p.doc_date purchase_date,
        ip.doc_number issue_number, ip.doc_date issue_doc_date,
        m.name machine_name, s.name shift_name,
        r.doc_date AS result_date, rc.good_pieces, rc.defect_before_pieces AS defect_before,
        rc.defect_after_pieces AS defect_after
      FROM cartons c
      JOIN items i ON i.id=c.item_id
      LEFT JOIN purchases p ON p.id=c.purchase_id
      LEFT JOIN issue_permits ip ON ip.id=c.issue_permit_id
      LEFT JOIN machines m ON m.id=ip.machine_id
      LEFT JOIN shifts s ON s.id=ip.shift_id
      LEFT JOIN parties pa ON pa.id=c.party_id
      LEFT JOIN production_receipt_cartons rc
        ON rc.id = (SELECT MAX(rc2.id) FROM production_receipt_cartons rc2 WHERE rc2.carton_id = c.id)
      LEFT JOIN production_receipts r ON r.id = rc.receipt_id
      ORDER BY c.id DESC`).all();
    for (const r of cartons) {
      // الفرق: زيادة (باقٍ في الكرتون غير محسوب) أو نقص (تجاوز الإنتاج حبات الكرتون) أو مكتمل
      const total = (Number(r.good_pieces) || 0) + (Number(r.defect_before) || 0) + (Number(r.defect_after) || 0);
      r.rest = r.status === 'finished' ? (Number(r.pieces) || 0) - total : null;
      r.total = total;
    }
    // كل تصريح صرف: مصروف الكراتين مقابل المُعلَّن سليماً مقابل المستلَم في المخزون
    const issues = db.prepare(`SELECT ip.id, ip.doc_number, ip.doc_date, ip.source, ip.party_id,
        COALESCE(SUM(c.pieces),0) issued_pieces,
        COALESCE(SUM(rc.good_pieces),0) declared_good,
        COALESCE((SELECT SUM(r.good_pieces + r.surplus_pieces) FROM production_receipts r
          WHERE r.issue_permit_id=ip.id),0) received_pieces
      FROM issue_permits ip
      LEFT JOIN cartons c ON c.issue_permit_id=ip.id
      LEFT JOIN production_receipt_cartons rc
        ON rc.id = (SELECT MAX(rc2.id) FROM production_receipt_cartons rc2 WHERE rc2.carton_id = c.id)
      GROUP BY ip.id
      ORDER BY ip.id DESC`).all();
    for (const r of issues) {
      // موجب = فائض أضافته تسوية الاستلام إلى السليم، سالب = كراتين لم يُستلم إنتاجها بعد
      r.receive_diff = (Number(r.received_pieces) || 0) - (Number(r.declared_good) || 0);
    }
    return { cartons, issues };
  });
};
