'use strict'
// Mailing-list subscribers. Fixed SQL, bound parameters only.

module.exports = function subscribersRepo (db) {
  return {
    get (email) {
      return db.get('SELECT * FROM subscribers WHERE email = :email', { email }) || null
    },
    getByTokenHash (hash) {
      return db.get('SELECT * FROM subscribers WHERE confirm_token_hash = :hash', { hash }) || null
    },
    insertPending (s) {
      db.run(`
        INSERT INTO subscribers (email, status, consent_at, consent_source, consent_text, confirm_token_hash, unsubscribed_at)
        VALUES (:email, 'pending', :consent_at, :consent_source, :consent_text, :confirm_token_hash, NULL)`, s)
    },
    /** Re-consent for an address that was pending or unsubscribed. */
    resetPending (s) {
      db.run(`
        UPDATE subscribers SET status = 'pending', consent_at = :consent_at, consent_source = :consent_source,
               consent_text = :consent_text, confirm_token_hash = :confirm_token_hash, unsubscribed_at = NULL
        WHERE email = :email`, s)
    },
    confirm (email) {
      return db.run(`UPDATE subscribers SET status = 'confirmed' WHERE email = :email AND status = 'pending'`,
        { email }).changes === 1
    },
    unsubscribe (email, now) {
      return db.run(`UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = :now
                     WHERE email = :email AND status <> 'unsubscribed'`, { email, now }).changes === 1
    },
    list (f) {
      const total = db.get('SELECT COUNT(*) AS n FROM subscribers WHERE (:status IS NULL OR status = :status)',
        { status: f.status ?? null }).n
      const rows = db.all(`
        SELECT email, status, consent_at, consent_source, consent_text, unsubscribed_at FROM subscribers
        WHERE (:status IS NULL OR status = :status) ORDER BY consent_at DESC LIMIT :limit OFFSET :offset`,
      { status: f.status ?? null, limit: f.limit, offset: f.offset })
      return { total, rows }
    },
    listAll () {
      return db.all(`SELECT email, status, consent_at, consent_source, consent_text, unsubscribed_at
                     FROM subscribers ORDER BY consent_at DESC`)
    }
  }
}
