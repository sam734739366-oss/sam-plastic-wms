function suggestNumber(db, table) {
  const row = db.prepare(`SELECT doc_number FROM ${table}
    WHERE doc_number GLOB '[0-9]*' ORDER BY CAST(doc_number AS INTEGER) DESC, doc_number DESC LIMIT 1`).get();
  if (!row) return '1';
  const n = parseInt(row.doc_number, 10);
  return Number.isNaN(n) ? '' : String(n + 1);
}

function checkDocNumber(db, table, number, excludeId = null) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE doc_number = ?`).get(number);
  return !row || (excludeId !== null && row.id === excludeId);
}

module.exports = { suggestNumber, checkDocNumber };
