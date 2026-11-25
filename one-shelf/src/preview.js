'use strict'
// Settings and start-up steps for PREVIEW deployments on Vercel.
//
// Vercel has no permanent disk, so the database and uploads live in /tmp, are
// re-seeded when a new instance starts and are lost when it stops. This is for
// looking at the site, never for taking real orders.

function onVercel (env = process.env) {
  return Boolean(env.VERCEL)
}

// Fill in the settings a Vercel deployment needs, without overriding anything set explicitly.
function applyVercelEnv (env = process.env) {
  if (!env.NODE_ENV) env.NODE_ENV = 'production'
  if (!env.DATA_DIR) env.DATA_DIR = '/tmp/one-shelf-data'
  if (!env.PUBLIC_BASE_URL) {
    const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL
    if (host) env.PUBLIC_BASE_URL = `https://${host}`
  }
  if (!env.TRUST_PROXY) env.TRUST_PROXY = 'yes'
  // One deployment answers on several hostnames, so accept the one the browser used.
  if (!env.ALLOW_SAME_HOST_ORIGIN) env.ALLOW_SAME_HOST_ORIGIN = 'yes'
  // A preview can only run demo payments. Real payments need PAYMENT_PROVIDER=stripe.
  if ((env.PAYMENT_PROVIDER || 'demo') === 'demo' && !env.ALLOW_DEMO_IN_PRODUCTION) env.ALLOW_DEMO_IN_PRODUCTION = 'yes'
  // Vercel runs several short-lived copies, each with its own temporary database, so a
  // sign-in stored in one is unknown to the next. In a preview only, sign the session
  // cookie with a key derived from the admin password so any copy can recognise it.
  const email = (env.ADMIN_EMAIL || '').trim().toLowerCase()
  if (email && env.ADMIN_PASSWORD && !env.PREVIEW_SESSION_KEY) {
    const crypto = require('node:crypto')
    env.PREVIEW_SESSION_KEY = crypto.createHash('sha256').update(`one-shelf-preview-session\n${email}\n${env.ADMIN_PASSWORD}`).digest('hex')
    env.PREVIEW_ADMIN_EMAIL = email
  }
}

// Load the placeholder catalogue and, if ADMIN_EMAIL and ADMIN_PASSWORD are set, create that admin.
async function preparePreview (app, env = process.env) {
  const { seed } = require('./seed')
  await seed({ db: app.db, repo: app.repo, storage: app.storage })

  const email = (env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = env.ADMIN_PASSWORD
  if (!email || !password) return
  if (app.repo.admin.getAdminByEmail(email)) return
  const { hashPassword, passwordProblem } = require('./security/passwords')
  const problem = passwordProblem(password, email)
  if (problem) {
    app.log.warn(`ADMIN_PASSWORD not accepted, no admin created: ${problem}`)
    return
  }
  const id = app.repo.admin.insertAdmin(email, await hashPassword(password))
  app.repo.admin.audit(null, 'admin.created_env', 'admin_user', id, null, { email })
}

module.exports = { onVercel, applyVercelEnv, preparePreview }
