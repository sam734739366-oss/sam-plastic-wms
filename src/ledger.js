// ===== دفتر حركات الأطراف والنقدية =====
// side: 'debit' = ذمة على الطرف (مدين لنا) | 'credit' = ذمة له (دائن عندنا)
// cash_in / cash_out: أثر الحركة على نقدية المصنع

function write(db, row, userId) {
  db.prepare(`INSERT INTO party_ledger
    (party_id, doc_type, doc_id, doc_number, doc_date, side, amount, cash_in, cash_out, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.party_id ?? null, row.doc_type, row.doc_id, row.doc_number, row.doc_date,
      row.side, row.amount || 0, row.cash_in || 0, row.cash_out || 0, row.notes || null, userId);
}

// حذف قيود مستند: في v2 لا يوجد قيد «ملغى» — القيد يُمحى مع مستنده ويُعاد حساب الذمة
function deleteDoc(db, docType, docId) {
  db.prepare('DELETE FROM party_ledger WHERE doc_type=? AND doc_id=?').run(docType, docId);
}

function partyBalance(db, partyId) {
  // موجب = ذمة على الطرف لنا (مدين)، سالب = ذمة لنا عنده (دائن)
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0) b
    FROM party_ledger WHERE party_id=?`).get(partyId);
  return r.b;
}

function cashBalance(db) {
  const r = db.prepare('SELECT COALESCE(SUM(cash_in - cash_out),0) b FROM party_ledger').get();
  return r.b;
}

function receivables(db) {
  // ذمم العملاء: مجموع ما عليهم (debit) ناقص ما لهم
  const r = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN p.type IN ('customer','both') THEN
      CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END ELSE 0 END),0) cust,
    COALESCE(SUM(CASE WHEN p.type IN ('supplier','both') THEN
      CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END ELSE 0 END),0) supp
    FROM party_ledger l JOIN parties p ON p.id=l.party_id
    WHERE l.party_id IS NOT NULL`).get();
  return { customers: r.cust, suppliers: r.supp };
}

// أثر فاتورة (بيع/شراء) على الدفتر
function invoiceEffect(db, { docType, doc, total, userId }) {
  if (doc.id != null) deleteDoc(db, docType, doc.id);
  if (total <= 0) return;
  const method = doc.payment_method === 'cash' ? 'cash' : 'credit';
  if (docType === 'invoice') {
    // فاتورة بيع/خردة/أجرة: ذمة على العميل، وإن كانت نقدية فقبض فوري
    write(db, {
      party_id: doc.party_id, doc_type: 'invoice', doc_id: doc.id,
      doc_number: doc.doc_number, doc_date: doc.doc_date,
      side: 'debit', amount: total,
      cash_in: method === 'cash' ? total : 0, cash_out: 0,
      notes: `فاتورة ${doc.invoice_type === 'scrap' ? 'خردة' : doc.invoice_type === 'blowing_fee' ? 'أجرة نفخ' : 'بيع'} ${method === 'cash' ? '(نقدي)' : '(آجل)'}`,
    }, userId);
  } else if (docType === 'purchase') {
    // فاتورة شراء: ذمة للمورد، وإن كانت نقدية فدفع فوري
    write(db, {
      party_id: doc.party_id, doc_type: 'purchase', doc_id: doc.id,
      doc_number: doc.doc_number, doc_date: doc.doc_date,
      side: 'credit', amount: total,
      cash_in: 0, cash_out: method === 'cash' ? total : 0,
      notes: `فاتورة شراء ${method === 'cash' ? '(نقدي)' : '(آجل)'}`,
    }, userId);
  }
}

// أثر مرتجع (بيع/شراء) على الدفتر
function returnEffect(db, { docType, doc, total, userId }) {
  if (doc.id != null) deleteDoc(db, docType, doc.id);
  if (total <= 0) return;
  const method = doc.payment_method === 'cash' ? 'cash' : 'credit';
  if (docType === 'sale_return') {
    // مرتجع بيع: يخفض ذمة العميل، وإن كان مردوداً نقداً فيخرج نقد من الصندوق
    write(db, {
      party_id: doc.party_id, doc_type: 'sale_return', doc_id: doc.id,
      doc_number: doc.doc_number, doc_date: doc.doc_date,
      side: 'credit', amount: total,
      cash_in: 0, cash_out: method === 'cash' ? total : 0,
      notes: `مرتجع بيع — فاتورة ${doc.invoice_number || ''} ${method === 'cash' ? '(نقد مسترد)' : '(تخفيض ذمة)'}`,
    }, userId);
  } else if (docType === 'purchase_return') {
    // مرتجع شراء: يخفض ذمة المورد، وإن كان مردوداً نقداً فقبض من المورد
    write(db, {
      party_id: doc.party_id, doc_type: 'purchase_return', doc_id: doc.id,
      doc_number: doc.doc_number, doc_date: doc.doc_date,
      side: 'debit', amount: total,
      cash_in: method === 'cash' ? total : 0, cash_out: 0,
      notes: `مرتجع شراء — فاتورة ${doc.purchase_number || ''} ${method === 'cash' ? '(نقد مقبوض)' : '(تخفيض ذمة)'}`,
    }, userId);
  }
}

module.exports = { write, deleteDoc, partyBalance, cashBalance, receivables, invoiceEffect, returnEffect };
