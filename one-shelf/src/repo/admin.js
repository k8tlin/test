'use strict'
// Admin users, sessions and the audit log. Fixed SQL, bound parameters only.

const { nowIso } = require('../db')

module.exports = function adminRepo (db) {
  return {
    getAdminByEmail (email) {
      return db.get('SELECT * FROM admin_users WHERE email = :email', { email }) || null
    },
    getAdmin (id) {
      return db.get('SELECT * FROM admin_users WHERE id = :id', { id }) || null
    },
    insertAdmin (email, passwordHash) {
      return db.run('INSERT INTO admin_users (email, password_hash, created_at, disabled) VALUES (:email, :hash, :now, 0)',
        { email, hash: passwordHash, now: nowIso() }).lastInsertRowid
    },
    setPassword (id, passwordHash) {
      db.run('UPDATE admin_users SET password_hash = :hash WHERE id = :id', { id, hash: passwordHash })
    },
    touchLogin (id) {
      db.run('UPDATE admin_users SET last_login_at = :now WHERE id = :id', { id, now: nowIso() })
    },

    insertSession (idHash, adminId, csrfSecret) {
      const now = nowIso()
      db.run(`INSERT INTO sessions (id_hash, admin_id, csrf_secret, created_at, last_seen_at)
              VALUES (:id_hash, :admin_id, :csrf_secret, :now, :now)`,
      { id_hash: idHash, admin_id: adminId, csrf_secret: csrfSecret, now })
    },
    getSession (idHash) {
      return db.get(`
        SELECT s.*, a.email AS admin_email, a.disabled AS admin_disabled
        FROM sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.id_hash = :id_hash`, { id_hash: idHash }) || null
    },
    touchSession (idHash, now) {
      db.run('UPDATE sessions SET last_seen_at = :now WHERE id_hash = :id_hash', { id_hash: idHash, now })
    },
    deleteSession (idHash) {
      db.run('DELETE FROM sessions WHERE id_hash = :id_hash', { id_hash: idHash })
    },
    deleteSessionsForAdmin (adminId) {
      db.run('DELETE FROM sessions WHERE admin_id = :admin_id', { admin_id: adminId })
    },
    deleteStaleSessions (idleCutoff, absoluteCutoff) {
      db.run('DELETE FROM sessions WHERE last_seen_at < :idle OR created_at < :absolute',
        { idle: idleCutoff, absolute: absoluteCutoff })
    },

    /** before/after are plain objects (or null); stored as JSON text. */
    audit (adminId, action, entity, entityId, before, after) {
      db.run(`
        INSERT INTO audit_log (admin_id, action, entity, entity_id, before_json, after_json, created_at)
        VALUES (:admin_id, :action, :entity, :entity_id, :before_json, :after_json, :now)`, {
        admin_id: adminId ?? null,
        action,
        entity,
        entity_id: String(entityId),
        before_json: before == null ? null : JSON.stringify(before),
        after_json: after == null ? null : JSON.stringify(after),
        now: nowIso()
      })
    },
    listAudit (f) {
      return db.all(`
        SELECT l.*, a.email AS admin_email FROM audit_log l LEFT JOIN admin_users a ON a.id = l.admin_id
        WHERE (:entity IS NULL OR l.entity = :entity) AND (:entity_id IS NULL OR l.entity_id = :entity_id)
        ORDER BY l.id DESC LIMIT :limit OFFSET :offset`, {
        entity: f.entity ?? null,
        entity_id: f.entity_id ?? null,
        limit: f.limit,
        offset: f.offset
      })
    }
  }
}
