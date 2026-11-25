'use strict'
// Builds the Fastify app. `buildApp(opts)` is exported for tests;
// running this file directly starts the server.

const fs = require('node:fs')
const path = require('node:path')
const Fastify = require('fastify')

const { loadConfig, ConfigError } = require('./config')
const { openDb } = require('./db')
const { createStorage } = require('./storage')
const { createPaymentProvider } = require('./payments')
const { AppError, errorHandler, notFoundHandler } = require('./security/errors')
const { loggerOptions } = require('./security/logging')
const originCheck = require('./security/origin')
const createSessions = require('./security/sessions')
const createOrders = require('./domain/orders')

const ROOT = path.join(__dirname, '..')

// The Content-Security-Policy for every response. No inline scripts or styles
// anywhere, and nothing loaded from other sites.
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"]
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]        environment to read (default process.env)
 * @param {object} [opts.config]     overrides applied on top of the parsed env (tests)
 * @param {object} [opts.logStream]  writable stream for log lines (tests)
 */
async function buildApp (opts = {}) {
  const config = loadConfig(opts.env || process.env, opts.config || {})

  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(config.dbPath)
  const repo = {
    catalog: require('./repo/catalog')(db),
    orders: require('./repo/orders')(db),
    admin: require('./repo/admin')(db),
    subscribers: require('./repo/subscribers')(db)
  }
  const storage = createStorage(config.uploadsDir)
  const payments = createPaymentProvider(config)

  const app = Fastify({
    logger: loggerOptions(config, opts.logStream),
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024, // JSON bodies are small; uploads have their own 5 MB limit
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 200 }
  })

  const orders = createOrders({ db, repo, config, log: app.log })
  const sessions = createSessions({ config, repo })

  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('repo', repo)
  app.decorate('orders', orders)
  app.decorate('storage', storage)
  app.decorateRequest('session', null)

  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  if (config.demoInProduction) {
    app.log.warn('!!! DEMO PAYMENTS ARE ENABLED IN PRODUCTION (ALLOW_DEMO_IN_PRODUCTION=yes). NO MONEY IS TAKEN FOR ANY ORDER. Use this for a staging demo only. !!!')
  }

  // ---- security plumbing ---------------------------------------------------
  await app.register(require('@fastify/helmet'), {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS only in production: it must never be sent for http://localhost.
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' }
  })
  await app.register(require('@fastify/cookie'))
  await app.register(require('@fastify/formbody'), { bodyLimit: 8 * 1024 })

  const rl = config.rateLimit
  const tooMany = (request, context) => {
    const err = new AppError(429, 'rate_limited', `Too many attempts. Please wait ${context.after} and try again.`)
    return err
  }
  if (rl.enabled) {
    await app.register(require('@fastify/rate-limit'), {
      global: true,
      max: rl.globalMax,
      timeWindow: rl.globalWindowMs,
      errorResponseBuilder: tooMany
    })
  }
  // Per-route limits (passed to routes as `config.rateLimit`).
  const rateLimits = rl.enabled
    ? {
        checkout: { max: rl.checkoutMax, timeWindow: rl.checkoutWindowMs, errorResponseBuilder: tooMany },
        subscribe: { max: rl.subscribeMax, timeWindow: rl.subscribeWindowMs, errorResponseBuilder: tooMany },
        // Keyed by IP + email, so it needs the parsed body (preHandler).
        login: {
          max: rl.loginMax,
          timeWindow: rl.loginWindowMs,
          hook: 'preHandler',
          keyGenerator: (request) => {
            const email = request.body && typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 254) : ''
            return `login|${request.ip}|${email}`
          },
          errorResponseBuilder: tooMany
        },
        password: { max: 10, timeWindow: 15 * 60 * 1000, errorResponseBuilder: tooMany }
      }
    : { checkout: false, subscribe: false, login: false, password: false }

  // Same-origin check on every state-changing request, public and admin.
  app.addHook('onRequest', originCheck(config))

  // CSRF tokens for the admin. The per-session secret lives in the sessions
  // table (request.session._csrf); the token travels in the x-csrf-token header.
  await app.register(require('@fastify/csrf-protection'), {
    sessionPlugin: '@fastify/session',
    sessionKey: '_csrf',
    getToken: (request) => request.headers['x-csrf-token']
  })

  // ---- payments ------------------------------------------------------------
  // The single path by which a payment outcome reaches an order.
  function applyPaymentEvent (event) {
    return event.outcome === 'paid'
      ? orders.markPaid(event.orderRef, event.paymentRef || null)
      : orders.markFailed(event.orderRef, event.paymentRef || null)
  }
  const deps = { config, db, repo, orders, storage, payments, sessions, rateLimits, applyPaymentEvent }
  if (typeof payments.registerRoutes === 'function') payments.registerRoutes(app, deps)

  // ---- routes --------------------------------------------------------------
  await app.register(require('./routes/public'), deps)
  await app.register(require('./routes/subscribe'), deps)
  await app.register(require('./routes/media'), deps)

  const { adminLoginRoutes, adminAccountRoutes } = require('./routes/admin-auth')
  await app.register(adminLoginRoutes, deps)
  await app.register(async function protectedAdmin (admin) {
    await admin.register(require('@fastify/multipart'), {
      limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 4, parts: 5, headerPairs: 100 }
    })
    admin.addHook('onRequest', sessions.requireSession)
    admin.addHook('onRequest', function csrf (request, reply, done) {
      if (request.method === 'GET' || request.method === 'HEAD') return done()
      admin.csrfProtection(request, reply, done)
    })
    admin.addHook('onRequest', async (request, reply) => { reply.header('Cache-Control', 'no-store') })
    await admin.register(adminAccountRoutes, deps)
    await admin.register(require('./routes/admin-orders'), deps)
    await admin.register(require('./routes/admin-catalog'), deps)
    // Unknown admin API paths still require a session, and answer in JSON.
    admin.all('/api/admin/*', async () => { throw new AppError(404, 'not_found', 'Not found') })
  })
  // Unknown /api paths answer in JSON rather than falling through to static files.
  app.all('/api/*', async () => { throw new AppError(404, 'not_found', 'Not found') })

  // ---- static front ends ---------------------------------------------------
  // public/ at "/" and admin/ at "/admin/". HTML is always revalidated; other
  // assets get a modest cache because their names are not fingerprinted.
  const setHeaders = (reply, filePath) => {
    reply.header('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600')
  }
  const staticOptions = { dotfiles: 'ignore', index: ['index.html'], list: false, cacheControl: false, setHeaders }
  await app.register(require('@fastify/static'), {
    ...staticOptions, root: config.adminDir || path.join(ROOT, 'admin'), prefix: '/admin', redirect: true, decorateReply: false
  })
  await app.register(require('@fastify/static'), {
    ...staticOptions, root: config.publicDir || path.join(ROOT, 'public'), prefix: '/', decorateReply: false
  })

  // ---- background sweep ----------------------------------------------------
  function sweep () {
    try {
      const expired = orders.sweepExpired()
      if (expired) app.log.info({ expired }, 'expired unpaid orders and restored their stock')
      sessions.sweep()
    } catch (err) {
      app.log.error({ err }, 'sweep failed')
    }
  }
  app.decorate('sweep', sweep)
  let timer = null
  app.addHook('onReady', async () => {
    sweep()
    if (config.sweepIntervalMs > 0) {
      timer = setInterval(sweep, config.sweepIntervalMs)
      timer.unref()
    }
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    db.close()
  })

  return app
}

async function main () {
  let app
  try {
    app = await buildApp()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down')
    try { await app.close() } finally { process.exit(0) }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await app.listen({ port: app.config.port, host: app.config.host })
  app.log.info(`One Shelf is running. Payment mode: ${app.config.paymentMode}. Open ${app.config.publicBaseUrl}`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { buildApp, CSP_DIRECTIVES }
