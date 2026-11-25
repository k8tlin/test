'use strict'
// Same-origin check for every state-changing request (public and admin).
// A browser always sends Origin on cross-site POSTs, so a request whose Origin
// (or, failing that, Referer) is not this site is refused before any handler runs.

const { AppError } = require('./errors')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// Server-to-server calls authenticated by a signature instead of a browser origin.
const EXEMPT_PREFIXES = ['/api/webhooks/']

function originOf (value) {
  try {
    const u = new URL(value)
    return u.origin === 'null' ? null : u.origin
  } catch {
    return null
  }
}

module.exports = function originCheck (config) {
  return function checkOrigin (request, reply, done) {
    if (SAFE_METHODS.has(request.method)) return done()
    const path = request.url.split('?')[0]
    if (EXEMPT_PREFIXES.some(p => path.startsWith(p))) return done()

    const header = request.headers.origin || request.headers.referer
    if (!header) {
      // Not a browser (curl, scripts, tests). Off by default in production.
      if (config.allowMissingOrigin) return done()
      return done(new AppError(403, 'origin_forbidden', 'This request did not come from the One Shelf site.'))
    }
    const origin = originOf(header)
    const allowed = new Set([config.publicOrigin])
    // Outside production the site is usually opened as http://localhost:<port>
    // or http://127.0.0.1:<port>; accept the address the browser actually used.
    // The same applies where one deployment answers on several hostnames (ALLOW_SAME_HOST_ORIGIN).
    // A browser cannot be made to send another site's Origin with this site's Host, so this is still a same-origin check.
    // request.host honours X-Forwarded-Host only when TRUST_PROXY is on.
    const host = request.host || request.headers.host
    if ((!config.isProduction || config.allowSameHostOrigin) && host) allowed.add(`${request.protocol}://${host}`)
    if (origin && allowed.has(origin)) return done()
    request.log.warn({ origin: origin || 'unparseable' }, 'blocked cross-origin state-changing request')
    done(new AppError(403, 'origin_forbidden', 'This request did not come from the One Shelf site.'))
  }
}
