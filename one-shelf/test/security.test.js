'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Writable } = require('node:stream')
const { buildApp } = require('../src/server')
const { loadConfig, ConfigError } = require('../src/config')
const { makeApp, loginAdmin, placeOrder, createAdmin, ADMIN_EMAIL, ADMIN_PASSWORD, ORIGIN } = require('./helpers/app')

const PROD_ENV = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://shop.example', PAYMENT_PROVIDER: 'demo', ALLOW_DEMO_IN_PRODUCTION: 'yes' }
const PROD_ORIGIN = 'https://shop.example'

let app
before(async () => { app = await makeApp() })
after(async () => { await app.close() })

test('production + demo payment provider refuses to boot', async () => {
  const env = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://shop.example', PAYMENT_PROVIDER: 'demo' }
  assert.throws(() => loadConfig(env), (err) => err instanceof ConfigError && /Refusing to start/.test(err.message))
  await assert.rejects(buildApp({ env }), ConfigError)
  // Defaulting to demo is refused as well.
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://shop.example' }), ConfigError)

  // The real entry point exits non-zero with a readable message and no stack trace.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-boot-'))
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { PATH: process.env.PATH, ...env, DATA_DIR: dataDir, PORT: '0' }, encoding: 'utf8', timeout: 20000
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Refusing to start: NODE_ENV=production with PAYMENT_PROVIDER=demo/)
  assert.doesNotMatch(run.stderr, /\n\s+at /)
  assert.equal(fs.existsSync(path.join(dataDir, 'one-shelf.sqlite')), false, 'it stopped before touching the database')
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('ALLOW_DEMO_IN_PRODUCTION=yes boots with a loud warning', async () => {
  const lines = []
  const logStream = new Writable({ write (chunk, enc, cb) { lines.push(chunk.toString()); cb() } })
  const prod = await makeApp({ logLevel: 'warn' }, { env: PROD_ENV, logStream })
  try {
    assert.ok(lines.some(l => /DEMO PAYMENTS ARE ENABLED IN PRODUCTION/.test(l)))
    assert.equal((await prod.inject({ method: 'GET', url: '/api/config' })).json().payment_mode, 'demo')
  } finally {
    await prod.close()
  }
})

test('other unsafe or incomplete configuration is refused', () => {
  const bad = [
    { NODE_ENV: 'production', PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' }, // no PUBLIC_BASE_URL
    { NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://shop.example', ALLOW_DEMO_IN_PRODUCTION: 'yes' }, // not https
    { ...PROD_ENV, ALLOW_MISSING_ORIGIN: 'yes' },
    { PAYMENT_PROVIDER: 'stripe' }, // keys missing
    { PAYMENT_PROVIDER: 'paypal' },
    { PORT: 'eighty' },
    { NODE_ENV: 'staging' },
    { PUBLIC_BASE_URL: 'https://shop.example/some/path' },
    { RATE_LIMIT_LOGIN_MAX: '0' }
  ]
  for (const env of bad) assert.throws(() => loadConfig(env), ConfigError, JSON.stringify(env))
  const ok = loadConfig({ NODE_ENV: 'development' })
  assert.equal(ok.port, 3000)
  assert.equal(ok.rateLimit.loginMax, 5)
  assert.equal(ok.rateLimit.checkoutMax, 10)
  assert.equal(ok.rateLimit.subscribeMax, 5)
  assert.equal(loadConfig(PROD_ENV).allowMissingOrigin, false)
})

test('security headers: exact CSP, referrer policy, nosniff, no HSTS outside production', async () => {
  const expected = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
  const normalise = (v) => v.split(';').map(s => s.trim()).filter(Boolean).join('; ')
  const order = await placeOrder(app)
  for (const url of ['/api/products', '/api/nope', '/', order.payment_url, '/pay/demo.css', '/api/admin/me']) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(normalise(res.headers['content-security-policy']), expected, url)
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin', url)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url)
    assert.equal(res.headers['strict-transport-security'], undefined, url)
    assert.equal(res.headers['x-powered-by'], undefined)
  }
})

test('production: HSTS on, __Host- Secure cookie, missing Origin refused', async () => {
  const prod = await makeApp({ logLevel: 'silent' }, { env: PROD_ENV })
  try {
    const res = await prod.inject({ method: 'GET', url: '/api/config' })
    assert.match(res.headers['strict-transport-security'], /max-age=\d+/)

    await createAdmin(prod)
    const payload = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    const noOrigin = await prod.inject({ method: 'POST', url: '/api/admin/login', payload })
    assert.equal(noOrigin.statusCode, 403)
    assert.equal(noOrigin.json().error.code, 'origin_forbidden')
    assert.equal((await prod.inject({ method: 'POST', url: '/api/subscribe', payload: { email: 'a@example.com', consent: true } })).statusCode, 403)
    // In production the Host header is not trusted as a stand-in for the site origin.
    const hostTrick = await prod.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: 'https://evil.example', host: 'evil.example' }, payload })
    assert.equal(hostTrick.statusCode, 403)

    const session = await loginAdmin(prod, { origin: PROD_ORIGIN })
    const c = session.setCookie
    assert.equal(c.name, '__Host-os_session')
    assert.equal(c.secure, true)
    assert.equal(c.httpOnly, true)
    assert.equal(c.sameSite, 'Lax')
    assert.equal(c.path, '/')
    assert.equal(c.domain, undefined, '__Host- cookies must not set Domain')
    assert.equal((await session.get('/api/admin/me')).statusCode, 200)
  } finally {
    await prod.close()
  }
})

test('5xx responses never leak stack traces, SQL or internal messages', async () => {
  const lines = []
  const logStream = new Writable({ write (chunk, enc, cb) { lines.push(chunk.toString()); cb() } })
  const boom = await makeApp({ logLevel: 'error' }, {
    logStream,
    beforeReady (a) {
      a.get('/boom', async () => { throw new Error('secret internal detail at /srv/app/src/thing.js') })
      a.get('/boom-sql', async () => a.db.all('SELECT * FROM table_that_does_not_exist'))
    }
  })
  try {
    for (const url of ['/boom', '/boom-sql']) {
      const res = await boom.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 500)
      assert.deepEqual(res.json(), { error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } })
      assert.doesNotMatch(res.body, /secret|stack|\.js|SELECT|table_that|sqlite|no such/i)
    }
    assert.ok(lines.some(l => l.includes('secret internal detail')), 'the detail is in the server log instead')
  } finally {
    await boom.close()
  }
})

test('errors always use the { error: { code, message, fields? } } shape', async () => {
  const cases = [
    await app.inject({ method: 'GET', url: '/api/nope' }),
    await app.inject({ method: 'GET', url: '/nope.html' }),
    await app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: '{not json' }),
    await app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN, 'content-type': 'application/xml' }, payload: '<a/>' }),
    await app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN }, payload: { items: 'x'.repeat(70000) } }),
    await app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN }, payload: {} }),
    await app.inject({ method: 'GET', url: '/api/products/NOT_A_SLUG!' })
  ]
  assert.deepEqual(cases.map(r => r.statusCode), [404, 404, 400, 415, 413, 422, 422])
  for (const res of cases) {
    const body = res.json()
    assert.deepEqual(Object.keys(body), ['error'])
    assert.equal(typeof body.error.code, 'string')
    assert.equal(typeof body.error.message, 'string')
    assert.doesNotMatch(res.body, /stack|node_modules|at Object\./)
  }
  const fields = cases[5].json().error.fields
  assert.equal(typeof fields.items, 'string')
  assert.equal(typeof fields.customer, 'string')
})

test('unknown keys are stripped and long values rejected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: { origin: ORIGIN },
    payload: {
      items: [{ product_id: 'guji-natural', quantity: 1, grind: 'Sawdust' }],
      fulfilment: 'collect',
      customer: { name: 'x'.repeat(101), email: 'a'.repeat(250) + '@example.com', phone: '020 7946 0958' },
      delivery_notes: 'n'.repeat(501),
      accept_terms: true
    }
  })
  assert.equal(res.statusCode, 422)
  assert.deepEqual(Object.keys(res.json().error.fields).sort(), ['customer.email', 'customer.name', 'delivery_notes', 'items.0.grind'])
  for (const email of ['plain', 'a@b', 'a b@example.com', '<x>@example.com', 'a@example..com']) {
    const r = await app.inject({ method: 'POST', url: '/api/subscribe', headers: { origin: ORIGIN }, payload: { email, consent: true } })
    assert.equal(r.statusCode, 422, email)
  }
})

test('GET never changes state on write endpoints', async () => {
  const order = await placeOrder(app)
  const row = app.repo.orders.getByRef(order.order_ref)
  const admin = await loginAdmin(app)
  for (const url of ['/api/checkout', '/api/subscribe', '/api/basket/quote', '/api/admin/logout', `/api/admin/orders/${row.id}/status?status=cancelled&version=1`,
    `/api/admin/products/1/archive?version=1`, '/api/admin/login']) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })
    assert.equal(res.statusCode, 404, url)
  }
  assert.equal(app.repo.orders.getById(row.id).status, 'pending_payment')
  assert.equal((await admin.get('/api/admin/me')).statusCode, 200, 'still signed in')
})

test('logs redact emails, phones, addresses, passwords and tokens', async () => {
  const lines = []
  const logStream = new Writable({ write (chunk, enc, cb) { lines.push(chunk.toString()); cb() } })
  const logged = await makeApp({ logLevel: 'info' }, { logStream })
  try {
    const order = await placeOrder(logged, [{ product_id: 'guji-natural', quantity: 1 }], {
      fulfilment: 'delivery',
      customer: { name: 'Private Person', email: 'private.person@example.com', phone: '07700 900999' },
      address: { line1: '221B Baker Street', city: 'London', postcode: 'NW1 6XE' }
    })
    await logged.inject({ method: 'GET', url: `/api/orders/${order.order_ref}?token=${order.access_token}` })
    await logged.inject({ method: 'GET', url: order.payment_url })
    await loginAdmin(logged)
    await logged.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { email: 'private.person@example.com', password: 'hunter2-hunter2-hunter2' } })
    logged.log.info({ email: 'private.person@example.com', customer: { phone: '07700 900999', address_line1: '221B Baker Street' }, token: order.access_token }, 'explicit log call')
    const all = lines.join('')
    assert.ok(lines.length > 6, 'requests were logged')
    assert.match(all, /"url":"\/api\/orders\/OS-[A-Z0-9]+\?token=\[redacted\]"/)
    assert.match(all, /explicit log call/)
    for (const secret of ['private.person@example.com', '07700 900999', '221B Baker Street', 'NW1 6XE', 'Private Person', order.access_token, ADMIN_PASSWORD, 'hunter2', 'os_session=']) {
      assert.ok(!all.includes(secret), `log must not contain ${secret}`)
    }
    for (const line of lines) JSON.parse(line) // structured: every line is JSON
  } finally {
    await logged.close()
  }
})

test('static serving: public/ at /, admin/ at /admin/, no dotfiles, nothing outside the roots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-static-'))
  const publicDir = path.join(dir, 'public')
  const adminDir = path.join(dir, 'admin')
  fs.mkdirSync(path.join(publicDir, 'css'), { recursive: true })
  fs.mkdirSync(adminDir)
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>shop</title>')
  fs.writeFileSync(path.join(publicDir, 'order.html'), '<!doctype html><title>order</title>')
  fs.writeFileSync(path.join(publicDir, 'css', 'site.css'), 'body{}')
  fs.writeFileSync(path.join(publicDir, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(publicDir, '.gitkeep'), '')
  fs.writeFileSync(path.join(adminDir, 'index.html'), '<!doctype html><title>admin</title>')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside')
  const site = await makeApp({ publicDir, adminDir })
  try {
    const get = (url) => site.inject({ method: 'GET', url })
    const home = await get('/')
    assert.equal(home.statusCode, 200)
    assert.match(home.body, /shop/)
    assert.equal(home.headers['cache-control'], 'no-cache')
    assert.match(home.headers['content-security-policy'], /script-src 'self'/)
    assert.equal((await get('/order.html?ref=OS-AAAAAAA&token=abc')).statusCode, 200)
    const css = await get('/css/site.css')
    assert.equal(css.statusCode, 200)
    assert.equal(css.headers['cache-control'], 'public, max-age=3600')
    const adminHome = await get('/admin/')
    assert.match(adminHome.body, /admin/)
    assert.equal(adminHome.headers['cache-control'], 'no-cache')
    const bare = await get('/admin')
    assert.ok(bare.statusCode === 301 || bare.statusCode === 302)
    assert.equal(bare.headers.location, '/admin/')
    for (const url of ['/.env', '/.gitkeep', '/admin/.env', '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/admin/../../secret.txt',
      '/css/../../secret.txt', '/package.json', '/src/server.js', '/data/one-shelf.sqlite', '/node_modules/fastify/package.json']) {
      const res = await get(url)
      assert.ok(res.statusCode === 404 || res.statusCode === 400 || res.statusCode === 403, `${url} -> ${res.statusCode}`)
      assert.doesNotMatch(res.body, /SECRET=1|outside|"name": "one-shelf"/)
    }
  } finally {
    await site.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the global rate limit applies to everything', async () => {
  const limited = await makeApp({ rateLimit: { globalMax: 3 } })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await limited.inject({ method: 'GET', url: '/api/config' })).statusCode, 200)
    const res = await limited.inject({ method: 'GET', url: '/api/config' })
    assert.equal(res.statusCode, 429)
    assert.equal(res.json().error.code, 'rate_limited')
    assert.ok(res.headers['retry-after'])
  } finally {
    await limited.close()
  }
})

test('the Stripe provider is a stub that fails closed and releases stock', async () => {
  const stripe = await makeApp({}, { env: { NODE_ENV: 'test', PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' } })
  try {
    assert.equal((await stripe.inject({ method: 'GET', url: '/api/config' })).json().payment_mode, 'live')
    const before = stripe.repo.catalog.getProductBySlug('guji-natural').stock
    const res = await stripe.inject({
      method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN },
      payload: { items: [{ product_id: 'guji-natural', quantity: 2 }], fulfilment: 'collect', customer: { name: 'A B', email: 'a@example.com', phone: '020 7946 0958' }, accept_terms: true }
    })
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().error.code, 'payment_unavailable')
    assert.equal(stripe.repo.catalog.getProductBySlug('guji-natural').stock, before)
    assert.equal((await stripe.inject({ method: 'GET', url: '/pay/demo.css' })).statusCode, 404, 'demo pages do not exist outside demo mode')
    assert.equal((await stripe.inject({ method: 'POST', url: '/api/webhooks/stripe', payload: {} })).statusCode, 501)
  } finally {
    await stripe.close()
  }
})
