function audit(db, userId, action, entity, entityId, before, after) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, before_json, after_json)
    VALUES (?,?,?,?,?,?)`).run(userId || null, action, entity, entityId || null,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

module.exports = { audit };
