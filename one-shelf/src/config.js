'use strict'
// Reads and validates environment variables once, at startup.
// Anything missing or unsafe throws a ConfigError with a plain-English message;
// src/server.js prints it and exits.

const path = require('node:path')
const { z } = require('zod')

class ConfigError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const yesNo = z.enum(['yes', 'no', 'true', 'false', '1', '0']).transform(v => ['yes', 'true', '1'].includes(v))
const posInt = (def, max = 1000000) => z.coerce.number().int().min(1).max(max).default(def)

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).max(255).default('127.0.0.1'),
  DATA_DIR: z.string().min(1).default('./data'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  PAYMENT_PROVIDER: z.enum(['demo', 'stripe']).default('demo'),
  ALLOW_DEMO_IN_PRODUCTION: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  TRUST_PROXY: yesNo.optional(),
  ALLOW_MISSING_ORIGIN: yesNo.optional(),
  ALLOW_SAME_HOST_ORIGIN: yesNo.optional(),
  PREVIEW_SESSION_KEY: z.string().min(32).max(200).optional(),
  PREVIEW_ADMIN_EMAIL: z.string().email().max(254).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),
  RATE_LIMIT_GLOBAL_MAX: posInt(300),
  RATE_LIMIT_LOGIN_MAX: posInt(5),
  RATE_LIMIT_CHECKOUT_MAX: posInt(10),
  RATE_LIMIT_SUBSCRIBE_MAX: posInt(5),
  ORDER_EXPIRY_MINUTES: posInt(30, 24 * 60)
})

/**
 * @param {object} env        usually process.env
 * @param {object} overrides  already-parsed values that win over env (used by tests)
 */
function loadConfig (env = process.env, overrides = {}) {
  // Treat empty strings ("FOO=") as unset.
  const cleaned = {}
  for (const key of Object.keys(envSchema.shape)) {
    if (env[key] !== undefined && env[key] !== '') cleaned[key] = env[key]
  }
  const parsed = envSchema.safeParse(cleaned)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`)
    throw new ConfigError('Invalid configuration:\n' + lines.join('\n'))
  }
  const e = parsed.data
  const isProduction = e.NODE_ENV === 'production'
  const isTest = e.NODE_ENV === 'test'

  if (isProduction && !e.PUBLIC_BASE_URL) {
    throw new ConfigError('PUBLIC_BASE_URL is required in production (for example https://shop.example.com).')
  }
  const publicBaseUrl = (e.PUBLIC_BASE_URL || `http://localhost:${e.PORT}`).replace(/\/+$/, '')
  const publicUrl = new URL(publicBaseUrl)
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new ConfigError('PUBLIC_BASE_URL must be just a scheme and host, with no path (for example https://shop.example.com).')
  }
  if (isProduction && publicUrl.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must start with https:// in production. Secure cookies do not work over plain http.')
  }

  const allowDemoInProduction = e.ALLOW_DEMO_IN_PRODUCTION === 'yes'
  if (isProduction && e.PAYMENT_PROVIDER === 'demo' && !allowDemoInProduction) {
    throw new ConfigError(
      'Refusing to start: NODE_ENV=production with PAYMENT_PROVIDER=demo would let customers "pay" without any money being taken.\n' +
      'Set PAYMENT_PROVIDER=stripe (once the Stripe provider is implemented), or, for a staging demo only, set ALLOW_DEMO_IN_PRODUCTION=yes.'
    )
  }
  if (e.PAYMENT_PROVIDER === 'stripe' && (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET)) {
    throw new ConfigError('PAYMENT_PROVIDER=stripe needs both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.')
  }
  if (isProduction && e.ALLOW_MISSING_ORIGIN === true) {
    throw new ConfigError('ALLOW_MISSING_ORIGIN must not be enabled in production.')
  }

  const dataDir = path.resolve(e.DATA_DIR)
  const config = {
    env: e.NODE_ENV,
    isProduction,
    isTest,
    port: e.PORT,
    host: e.HOST,
    dataDir,
    dbPath: path.join(dataDir, 'one-shelf.sqlite'),
    uploadsDir: path.join(dataDir, 'uploads'),
    publicBaseUrl,
    publicOrigin: publicUrl.origin,
    paymentProvider: e.PAYMENT_PROVIDER,
    paymentMode: e.PAYMENT_PROVIDER === 'demo' ? 'demo' : 'live',
    demoInProduction: isProduction && e.PAYMENT_PROVIDER === 'demo',
    stripeSecretKey: e.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET || null,
    trustProxy: e.TRUST_PROXY === true,
    allowMissingOrigin: e.ALLOW_MISSING_ORIGIN === undefined ? !isProduction : e.ALLOW_MISSING_ORIGIN,
    // Also accept an Origin equal to the Host the request was sent to (hosts that serve one deployment under several names).
    allowSameHostOrigin: e.ALLOW_SAME_HOST_ORIGIN === true,
    // Preview deployments only (see src/preview.js): lets a sign-in be recognised by another short-lived copy of the server.
    previewSessionKey: e.PREVIEW_SESSION_KEY && e.PREVIEW_ADMIN_EMAIL ? e.PREVIEW_SESSION_KEY : null,
    previewAdminEmail: e.PREVIEW_ADMIN_EMAIL ? e.PREVIEW_ADMIN_EMAIL.toLowerCase() : null,
    logLevel: e.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    sessionCookieName: isProduction ? '__Host-os_session' : 'os_session',
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 12 * 60 * 60 * 1000,
    orderExpiryMinutes: e.ORDER_EXPIRY_MINUTES,
    sweepIntervalMs: 60 * 1000,
    uploadMaxBytes: 5 * 1024 * 1024,
    rateLimit: {
      enabled: true,
      globalMax: e.RATE_LIMIT_GLOBAL_MAX,
      globalWindowMs: 60 * 1000,
      loginMax: e.RATE_LIMIT_LOGIN_MAX,
      loginWindowMs: 15 * 60 * 1000,
      checkoutMax: e.RATE_LIMIT_CHECKOUT_MAX,
      checkoutWindowMs: 60 * 1000,
      subscribeMax: e.RATE_LIMIT_SUBSCRIBE_MAX,
      subscribeWindowMs: 60 * 60 * 1000
    }
  }
  // Shallow overrides, with one level of merge for rateLimit.
  const { rateLimit: rlOverride, ...rest } = overrides
  Object.assign(config, rest)
  if (rest.dataDir) {
    config.dataDir = path.resolve(rest.dataDir)
    if (!rest.dbPath) config.dbPath = path.join(config.dataDir, 'one-shelf.sqlite')
    if (!rest.uploadsDir) config.uploadsDir = path.join(config.dataDir, 'uploads')
  }
  if (rlOverride) config.rateLimit = { ...config.rateLimit, ...rlOverride }
  return config
}

module.exports = { loadConfig, ConfigError }
