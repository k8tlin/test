'use strict'
// Vercel entry point: PREVIEW DEPLOYMENTS ONLY.
//
// Vercel runs this as a short-lived function with no permanent disk. The
// database and uploaded images therefore live in /tmp, are re-seeded whenever a
// new instance starts, and are lost when it stops. That is fine for looking at
// the site and clicking through a demo order. It is NOT a place to take real
// orders: use a host with a persistent disk for that (see README, "Before
// going live").

const env = process.env
if (!env.NODE_ENV) env.NODE_ENV = 'production'
if (!env.DATA_DIR) env.DATA_DIR = '/tmp/one-shelf-data'
if (!env.PUBLIC_BASE_URL) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL
  if (host) env.PUBLIC_BASE_URL = `https://${host}`
}
if (!env.TRUST_PROXY) env.TRUST_PROXY = 'yes'
// Vercel serves one deployment under several hostnames (production domain,
// per-deployment URL, branch URL), so accept the hostname the browser used.
if (!env.ALLOW_SAME_HOST_ORIGIN) env.ALLOW_SAME_HOST_ORIGIN = 'yes'
// A preview can only ever run demo payments. Real payments need PAYMENT_PROVIDER=stripe.
if ((env.PAYMENT_PROVIDER || 'demo') === 'demo' && !env.ALLOW_DEMO_IN_PRODUCTION) env.ALLOW_DEMO_IN_PRODUCTION = 'yes'

let starting = null

async function createPreviewAdmin (app) {
  const email = (env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = env.ADMIN_PASSWORD
  if (!email || !password) return
  const { hashPassword, passwordProblem } = require('../src/security/passwords')
  if (app.repo.admin.getAdminByEmail(email)) return
  const problem = passwordProblem(password, email)
  if (problem) {
    app.log.warn(`ADMIN_PASSWORD not accepted, no admin created: ${problem}`)
    return
  }
  const id = app.repo.admin.insertAdmin(email, await hashPassword(password))
  app.repo.admin.audit(null, 'admin.created_env', 'admin_user', id, null, { email })
}

async function start () {
  const { buildApp } = require('../src/server')
  const { seed } = require('../src/seed')
  const app = await buildApp()
  await seed({ db: app.db, repo: app.repo, storage: app.storage })
  await createPreviewAdmin(app)
  await app.ready()
  return app
}

module.exports = async function handler (req, res) {
  try {
    if (!starting) starting = start()
    const app = await starting
    app.server.emit('request', req, res)
  } catch (err) {
    starting = null
    console.error(err)
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(err && err.name === 'ConfigError' ? `One Shelf could not start.\n\n${err.message}` : 'One Shelf could not start. See the function logs.')
  }
}
