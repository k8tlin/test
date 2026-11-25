'use strict'
// Server-side admin sessions.
// - The browser holds a random 32-byte id in an HttpOnly cookie.
// - The database holds only the SHA-256 of that id, so a leaked database
//   cannot be replayed as a login.
// - 30 minutes idle timeout, 12 hours absolute timeout, deleted on logout.

const crypto = require('node:crypto')
const { randomToken, sha256 } = require('./tokens')
const { AppError } = require('./errors')

function cookieOptions (config) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction
    // No Domain attribute (required by the __Host- prefix) and no Max-Age:
    // it is a browser-session cookie; the server enforces the real timeouts.
  }
}

module.exports = function sessions ({ config, repo }) {
  const name = config.sessionCookieName

  // ---- preview deployments only -------------------------------------------
  // With config.previewSessionKey set, the cookie is "<random>.<expiry>.<signature>"
  // and the CSRF secret is derived from it, so a different copy of the server (with
  // its own empty database) can verify the cookie and recreate the session row.
  // Off everywhere else: a normal deployment has one database and does not need it.
  const previewKey = config.previewSessionKey
  const sign = (text) => crypto.createHmac('sha256', previewKey).update(text).digest('base64url')
  const previewCsrf = (random) => sign(`csrf\n${random}`).slice(0, 32)

  function restorePreviewSession (id) {
    if (!previewKey) return false
    const parts = id.split('.')
    if (parts.length !== 3) return false
    const [random, expiry, signature] = parts
    const expected = Buffer.from(sign(`session\n${random}\n${expiry}`))
    const given = Buffer.from(signature)
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false
    if (!/^\d{13}$/.test(expiry) || Number(expiry) < Date.now()) return false
    const admin = repo.admin.getAdminByEmail(config.previewAdminEmail)
    if (!admin || admin.disabled) return false
    repo.admin.insertSession(sha256(id), admin.id, previewCsrf(random))
    return true
  }

  function create (reply, adminId) {
    let id = randomToken()
    let csrfSecret = crypto.randomBytes(24).toString('base64url')
    if (previewKey) {
      const expiry = String(Date.now() + config.sessionAbsoluteMs)
      csrfSecret = previewCsrf(id)
      id = `${id}.${expiry}.${sign(`session\n${id}\n${expiry}`)}`
    }
    repo.admin.insertSession(sha256(id), adminId, csrfSecret)
    reply.setCookie(name, id, cookieOptions(config))
    return { idHash: sha256(id), csrfSecret }
  }

  function destroy (request, reply) {
    const id = request.cookies[name]
    if (id) repo.admin.deleteSession(sha256(id))
    reply.clearCookie(name, cookieOptions(config))
  }

  /** @returns the live session for this request, or null. Expired rows are deleted. */
  function load (request) {
    const id = request.cookies[name]
    if (typeof id !== 'string' || id.length < 20 || id.length > 128) return null
    const idHash = sha256(id)
    let row = repo.admin.getSession(idHash)
    if (!row && restorePreviewSession(id)) row = repo.admin.getSession(idHash)
    if (!row) return null
    const now = Date.now()
    const idleExpired = now - Date.parse(row.last_seen_at) > config.sessionIdleMs
    const absoluteExpired = now - Date.parse(row.created_at) > config.sessionAbsoluteMs
    if (idleExpired || absoluteExpired || row.admin_disabled) {
      repo.admin.deleteSession(idHash)
      return null
    }
    repo.admin.touchSession(idHash, new Date(now).toISOString())
    return {
      idHash,
      adminId: row.admin_id,
      email: row.admin_email,
      createdAt: row.created_at,
      // Read by @fastify/csrf-protection (sessionPlugin: '@fastify/session', sessionKey: '_csrf').
      _csrf: row.csrf_secret
    }
  }

  /** onRequest hook for everything under /api/admin except login. */
  function requireSession (request, reply, done) {
    const session = load(request)
    if (!session) {
      reply.clearCookie(name, cookieOptions(config))
      return done(new AppError(401, 'unauthorized', 'Please sign in.'))
    }
    request.session = session
    done()
  }

  function sweep () {
    const now = Date.now()
    repo.admin.deleteStaleSessions(new Date(now - config.sessionIdleMs).toISOString(),
      new Date(now - config.sessionAbsoluteMs).toISOString())
  }

  return { create, destroy, load, requireSession, sweep, cookieName: name }
}
