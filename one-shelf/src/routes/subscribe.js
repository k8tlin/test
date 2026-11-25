'use strict'
// Mailing list with double opt-in. No email is sent by this codebase: an email
// provider must be connected (see README). In demo mode the links are logged.

const v = require('../security/validate')
const { z, parse } = v
const { randomToken, sha256, TOKEN_PATTERN } = require('../security/tokens')

// Stored verbatim with every sign-up as the record of what was agreed to.
// Change the version suffix whenever the wording changes.
const CONSENT_TEXT = 'Yes, email me One Shelf news about new coffees and roasters. I can unsubscribe at any time using the link in every email.'
const CONSENT_VERSION = '2026-11'

const subscribeBody = z.object({
  email: v.email,
  consent: z.literal(true, { error: 'Tick the box to confirm you want to receive our emails' }),
  source: z.enum(['footer', 'checkout', 'home', 'other']).default('footer')
})
const tokenQuery = z.object({ token: z.string().regex(TOKEN_PATTERN) })

module.exports = async function subscribeRoutes (app, { repo, config, rateLimits }) {
  app.get('/api/subscribe/consent-text', async () => ({ consent_text: CONSENT_TEXT, version: CONSENT_VERSION }))

  app.post('/api/subscribe', { config: { rateLimit: rateLimits.subscribe } }, async (request, reply) => {
    const body = parse(subscribeBody, request.body)
    const existing = repo.subscribers.get(body.email)
    if (!existing || existing.status !== 'confirmed') {
      const token = randomToken()
      const row = {
        email: body.email,
        consent_at: new Date().toISOString(),
        consent_source: `web:${body.source}:${CONSENT_VERSION}`,
        consent_text: CONSENT_TEXT,
        confirm_token_hash: sha256(token)
      }
      if (existing) repo.subscribers.resetPending(row)
      else repo.subscribers.insertPending(row)
      // TODO(email provider): send these two links to the subscriber instead of logging them.
      if (config.paymentMode === 'demo') {
        request.log.info(`[demo] no email is sent. Confirmation link: ${config.publicBaseUrl}/api/subscribe/confirm?token=${token}` +
          ` | Unsubscribe link: ${config.publicBaseUrl}/api/unsubscribe?token=${token}`)
      }
    }
    // Identical response whether or not the address was already known.
    reply.code(202)
    return { ok: true, message: 'Thanks. Check your inbox for a link to confirm your subscription.' }
  })

  // The two GET routes below change state. That is the usual, deliberate
  // exception for links opened from an email (a mail client cannot POST).
  // Both are idempotent and need an unguessable token.
  function respond (request, reply, state) {
    reply.header('Cache-Control', 'no-store')
    const accept = String(request.headers.accept || '')
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      return reply.code(state === 'invalid' ? 404 : 200).send(state === 'invalid'
        ? { error: { code: 'not_found', message: 'That link is not valid or has already been replaced by a newer one.' } }
        : { ok: true, status: state })
    }
    return reply.redirect(`/?newsletter=${state}`, 303)
  }

  app.get('/api/subscribe/confirm', async (request, reply) => {
    const query = tokenQuery.safeParse(request.query)
    const sub = query.success ? repo.subscribers.getByTokenHash(sha256(query.data.token)) : null
    if (!sub || sub.status === 'unsubscribed') return respond(request, reply, 'invalid')
    repo.subscribers.confirm(sub.email)
    return respond(request, reply, 'confirmed')
  })

  app.get('/api/unsubscribe', async (request, reply) => {
    const query = tokenQuery.safeParse(request.query)
    const sub = query.success ? repo.subscribers.getByTokenHash(sha256(query.data.token)) : null
    if (!sub) return respond(request, reply, 'invalid')
    repo.subscribers.unsubscribe(sub.email, new Date().toISOString())
    return respond(request, reply, 'unsubscribed')
  })
}

module.exports.CONSENT_TEXT = CONSENT_TEXT
