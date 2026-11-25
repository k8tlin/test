'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp } = require('../../src/server')
const { seed } = require('../../src/seed')
const { hashPassword } = require('../../src/security/passwords')

const ADMIN_EMAIL = 'owner@example.com'
const ADMIN_PASSWORD = 'tall-green-ladder-77'
const ORIGIN = 'http://localhost:3000'

/** A fresh app with its own temporary data directory and the seed catalogue. */
async function makeApp (configOverrides = {}, { env = { NODE_ENV: 'test' }, logStream, beforeReady } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-test-'))
  const app = await buildApp({
    env,
    logStream,
    config: {
      dataDir,
      sweepIntervalMs: 0,
      ...configOverrides,
      // Generous limits unless a test asks for tight ones.
      rateLimit: { globalMax: 100000, loginMax: 1000, checkoutMax: 1000, subscribeMax: 1000, ...(configOverrides.rateLimit || {}) }
    }
  })
  await seed({ db: app.db, repo: app.repo, storage: app.storage }, { images: false })
  if (beforeReady) beforeReady(app)
  app.addHook('onClose', async () => { fs.rmSync(dataDir, { recursive: true, force: true }) })
  await app.ready()
  return app
}

async function createAdmin (app, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  return app.repo.admin.insertAdmin(email, await hashPassword(password))
}

/** Sign in and return helpers that send the session cookie and CSRF token. */
async function loginAdmin (app, { email = ADMIN_EMAIL, password = ADMIN_PASSWORD, origin = ORIGIN } = {}) {
  if (!app.repo.admin.getAdminByEmail(email)) await createAdmin(app, email, password)
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin }, payload: { email, password } })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  const setCookie = res.cookies.find(c => c.name === app.config.sessionCookieName)
  const cookie = `${setCookie.name}=${setCookie.value}`
  const csrf = res.json().csrf_token
  const headers = { cookie, origin, 'x-csrf-token': csrf }
  return {
    cookie,
    csrf,
    setCookie,
    headers,
    get: (url) => app.inject({ method: 'GET', url, headers: { cookie } }),
    post: (url, payload) => app.inject({ method: 'POST', url, headers, payload }),
    patch: (url, payload) => app.inject({ method: 'PATCH', url, headers, payload }),
    put: (url, payload) => app.inject({ method: 'PUT', url, headers, payload })
  }
}

const customer = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '020 7946 0958' }

function checkoutPayload (items, extra = {}) {
  return { items, fulfilment: 'collect', customer, accept_terms: true, ...extra }
}

async function placeOrder (app, items = [{ product_id: 'guji-natural', quantity: 1, grind: 'Whole bean' }], extra = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN }, payload: checkoutPayload(items, extra) })
  if (res.statusCode !== 201) throw new Error(`checkout failed: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function payDemo (app, order, action = 'pay') {
  return app.inject({
    method: 'POST',
    url: `/pay/demo/${order.order_ref}/${action}`,
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(order.access_token)}`
  })
}

const stockOf = (app, slug) => app.repo.catalog.getProductBySlug(slug).stock

/** Build a multipart/form-data body with one file field. */
function multipart (fieldName, filename, contentType, buffer) {
  const boundary = '----oneshelftest' + Math.random().toString(16).slice(2)
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { payload: Buffer.concat([head, buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

module.exports = {
  makeApp, createAdmin, loginAdmin, placeOrder, payDemo, checkoutPayload, stockOf, multipart, customer,
  ADMIN_EMAIL, ADMIN_PASSWORD, ORIGIN
}
