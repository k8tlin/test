'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { makeApp, createAdmin, loginAdmin, placeOrder, payDemo, ADMIN_EMAIL, ADMIN_PASSWORD, ORIGIN } = require('./helpers/app')

let app
let admin
before(async () => {
  app = await makeApp()
  admin = await loginAdmin(app)
})
after(async () => { await app.close() })

const ADMIN_GETS = ['/api/admin/me', '/api/admin/orders', '/api/admin/orders/1', '/api/admin/products', '/api/admin/roasters',
  '/api/admin/delivery-zones', '/api/admin/subscribers', '/api/admin/subscribers.csv', '/api/admin/audit', '/api/admin/summary',
  '/api/admin/anything-else']

test('admin routes reject requests without a session', async () => {
  for (const url of ADMIN_GETS) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 401, url)
    assert.equal(res.json().error.code, 'unauthorized')
  }
  const writes = [
    ['POST', '/api/admin/logout'], ['POST', '/api/admin/password'], ['POST', '/api/admin/orders/1/status'],
    ['POST', '/api/admin/orders/1/notes'], ['POST', '/api/admin/products'], ['PATCH', '/api/admin/products/1'],
    ['POST', '/api/admin/products/1/archive'], ['POST', '/api/admin/products/1/restore'], ['POST', '/api/admin/products/1/image'],
    ['POST', '/api/admin/roasters'], ['PATCH', '/api/admin/roasters/1'], ['POST', '/api/admin/roasters/1/deactivate'],
    ['POST', '/api/admin/roasters/1/image'], ['PUT', '/api/admin/delivery-zones/E']
  ]
  for (const [method, url] of writes) {
    const res = await app.inject({ method, url, headers: { origin: ORIGIN }, payload: {} })
    assert.equal(res.statusCode, 401, `${method} ${url}`)
  }
  const forged = await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie: `os_session=${crypto.randomBytes(32).toString('base64url')}` } })
  assert.equal(forged.statusCode, 401)
})

test('admin writes reject a missing or wrong CSRF token', async () => {
  const body = { fee_pence: 100, active: true }
  const missing = await app.inject({ method: 'PUT', url: '/api/admin/delivery-zones/E', headers: { cookie: admin.cookie, origin: ORIGIN }, payload: body })
  assert.equal(missing.statusCode, 403)
  assert.equal(missing.json().error.code, 'csrf_invalid')
  const wrong = await app.inject({ method: 'PUT', url: '/api/admin/delivery-zones/E', headers: { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': 'nope-nope-nope' }, payload: body })
  assert.equal(wrong.statusCode, 403)
  // A token minted for a different session does not work either.
  const other = await loginAdmin(app, { email: 'second@example.com', password: 'another-long-password-1' })
  const swapped = await app.inject({ method: 'PUT', url: '/api/admin/delivery-zones/E', headers: { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': other.csrf }, payload: body })
  assert.equal(swapped.statusCode, 403)
  assert.equal(app.repo.catalog.getZone('E').fee_pence, 350, 'nothing changed')
  // The token is not accepted from the body or query string.
  const inBody = await app.inject({ method: 'PUT', url: `/api/admin/delivery-zones/E?_csrf=${admin.csrf}`, headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { ...body, _csrf: admin.csrf } })
  assert.equal(inBody.statusCode, 403)
  const ok = await admin.put('/api/admin/delivery-zones/E', { fee_pence: 350, active: true })
  assert.equal(ok.statusCode, 200)
})

test('state-changing requests from another origin are refused (admin and public)', async () => {
  const evil = { ...admin.headers, origin: 'https://evil.example' }
  const res = await app.inject({ method: 'PUT', url: '/api/admin/delivery-zones/E', headers: evil, payload: { fee_pence: 1, active: true } })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error.code, 'origin_forbidden')
  const viaReferer = await app.inject({
    method: 'PUT', url: '/api/admin/delivery-zones/E', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, referer: 'https://evil.example/page' }, payload: { fee_pence: 1, active: true }
  })
  assert.equal(viaReferer.statusCode, 403)
  assert.equal(app.repo.catalog.getZone('E').fee_pence, 350)
  for (const [url, payload] of [
    ['/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }],
    ['/api/subscribe', { email: 'x@example.com', consent: true }],
    ['/api/basket/quote', { items: [{ product_id: 'guji-natural', quantity: 1 }] }],
    ['/api/checkout', {}]
  ]) {
    const r = await app.inject({ method: 'POST', url, headers: { origin: 'https://evil.example' }, payload })
    assert.equal(r.statusCode, 403, url)
    assert.equal(r.json().error.code, 'origin_forbidden')
  }
  assert.equal(app.repo.subscribers.get('x@example.com'), null)
  // "null" origins (sandboxed frames, some redirects) are refused too.
  const nullOrigin = await app.inject({ method: 'POST', url: '/api/subscribe', headers: { origin: 'null' }, payload: { email: 'x@example.com', consent: true } })
  assert.equal(nullOrigin.statusCode, 403)
})

test('login failures are generic and identical', async () => {
  await createAdmin(app, 'disabled@example.com', 'some-long-password-9')
  app.db.run('UPDATE admin_users SET disabled = 1 WHERE email = :email', { email: 'disabled@example.com' })
  const attempts = [
    { email: ADMIN_EMAIL, password: 'wrong-password-123' },
    { email: 'nobody@example.com', password: ADMIN_PASSWORD },
    { email: 'disabled@example.com', password: 'some-long-password-9' },
    { email: 'not-an-email', password: 'x' },
    { email: ADMIN_EMAIL },
    {}
  ]
  for (const payload of attempts) {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: { code: 'invalid_credentials', message: 'Invalid email or password' } })
    assert.equal(res.headers['set-cookie'], undefined)
  }
})

test('login is rate limited per IP + email', async () => {
  const limited = await makeApp({ rateLimit: { loginMax: 5 } })
  try {
    await createAdmin(limited)
    const attempt = (email, password = 'wrong-password-123') => limited.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { email, password } })
    for (let i = 0; i < 5; i++) assert.equal((await attempt(ADMIN_EMAIL)).statusCode, 401)
    const sixth = await attempt(ADMIN_EMAIL)
    assert.equal(sixth.statusCode, 429)
    assert.equal(sixth.json().error.code, 'rate_limited')
    // Even the right password is refused while locked out; case and spaces do not dodge the limit.
    assert.equal((await attempt(ADMIN_EMAIL, ADMIN_PASSWORD)).statusCode, 429)
    assert.equal((await attempt('  ' + ADMIN_EMAIL.toUpperCase())).statusCode, 429)
    // A different email from the same IP has its own counter.
    assert.equal((await attempt('someone-else@example.com')).statusCode, 401)
  } finally {
    await limited.close()
  }
})

test('session cookie attributes, hashed storage, regeneration and logout', async () => {
  const session = await loginAdmin(app, { email: 'cookie@example.com', password: 'cookie-test-password-1' })
  const c = session.setCookie
  assert.equal(c.name, 'os_session')
  assert.equal(c.httpOnly, true)
  assert.equal(c.sameSite, 'Lax')
  assert.equal(c.path, '/')
  assert.equal(c.secure, undefined, 'not Secure on http://localhost in development')
  assert.equal(Buffer.from(c.value, 'base64url').length, 32, 'random 32-byte id')

  const hash = crypto.createHash('sha256').update(c.value).digest('hex')
  const rows = app.db.all('SELECT * FROM sessions')
  assert.ok(rows.some(r => r.id_hash === hash), 'the SHA-256 of the id is stored')
  assert.ok(!JSON.stringify(rows).includes(c.value), 'the raw id is never stored')

  // Signing in again from the same browser replaces the session.
  const again = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN, cookie: session.cookie }, payload: { email: 'cookie@example.com', password: 'cookie-test-password-1' } })
  const fresh = again.cookies.find(k => k.name === 'os_session')
  assert.notEqual(fresh.value, c.value)
  assert.equal((await session.get('/api/admin/me')).statusCode, 401, 'old session id no longer works')

  const cookie = `os_session=${fresh.value}`
  const csrf = again.json().csrf_token
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode, 200)
  const out = await app.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf } })
  assert.equal(out.statusCode, 200)
  const freshHash = crypto.createHash('sha256').update(fresh.value).digest('hex')
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = :h', { h: freshHash }).n, 0, 'logout deletes the row')
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode, 401)
})

test('sessions time out after 30 minutes idle and 12 hours absolute', async () => {
  const idle = await loginAdmin(app, { email: 'idle@example.com', password: 'idle-test-password-12' })
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const hashOf = (s) => crypto.createHash('sha256').update(s.setCookie.value).digest('hex')
  app.db.run('UPDATE sessions SET last_seen_at = :t WHERE id_hash = :h', { t: ago(29 * 60000), h: hashOf(idle) })
  assert.equal((await idle.get('/api/admin/me')).statusCode, 200, '29 minutes idle is fine (and counts as activity)')
  app.db.run('UPDATE sessions SET last_seen_at = :t WHERE id_hash = :h', { t: ago(31 * 60000), h: hashOf(idle) })
  assert.equal((await idle.get('/api/admin/me')).statusCode, 401)
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = :h', { h: hashOf(idle) }).n, 0)

  const old = await loginAdmin(app, { email: 'idle@example.com', password: 'idle-test-password-12' })
  app.db.run('UPDATE sessions SET created_at = :t WHERE id_hash = :h', { t: ago(12 * 3600000 + 60000), h: hashOf(old) })
  assert.equal((await old.get('/api/admin/me')).statusCode, 401, 'active sessions still end after 12 hours')
})

test('GET /api/admin/me returns the admin and a working CSRF token', async () => {
  const me = (await admin.get('/api/admin/me')).json()
  assert.equal(me.admin.email, ADMIN_EMAIL)
  assert.ok(!('password_hash' in me.admin))
  const res = await app.inject({ method: 'PUT', url: '/api/admin/delivery-zones/TW', headers: { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': me.csrf_token }, payload: { fee_pence: 350, active: true } })
  assert.equal(res.statusCode, 200)
})

test('order status: allowed path works, invalid transitions are rejected, stale versions get 409', async () => {
  const order = await placeOrder(app)
  const row = app.repo.orders.getByRef(order.order_ref)
  const setStatus = (status, version) => admin.post(`/api/admin/orders/${row.id}/status`, { status, version })

  // Admins can never mark an order paid by hand, nor skip ahead.
  for (const status of ['paid', 'preparing', 'completed', 'expired', 'refunded']) {
    const res = await setStatus(status, row.version)
    assert.equal(res.statusCode, 409, status)
    assert.equal(res.json().error.code, 'invalid_transition')
  }
  await payDemo(app, order)
  const paid = app.repo.orders.getByRef(order.order_ref)
  assert.equal(paid.status, 'paid')

  const stale = await setStatus('preparing', row.version)
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'stale_version')
  assert.equal(app.repo.orders.getById(row.id).status, 'paid')

  const preparing = await setStatus('preparing', paid.version)
  assert.equal(preparing.statusCode, 200)
  let current = preparing.json().order
  assert.deepEqual(current.allowed_transitions, ['ready_for_collection', 'cancelled', 'refunded'])
  // A collection order cannot go out for delivery.
  assert.equal((await setStatus('out_for_delivery', current.version)).statusCode, 409)
  current = (await setStatus('ready_for_collection', current.version)).json().order
  current = (await setStatus('completed', current.version)).json().order
  assert.equal(current.status, 'completed')
  assert.equal((await setStatus('cancelled', current.version)).statusCode, 409)
  assert.equal((await setStatus('bogus', current.version)).statusCode, 422)

  const detail = (await admin.get(`/api/admin/orders/${row.id}`)).json().order
  const actions = detail.audit.map(a => a.action)
  assert.ok(actions.includes('order.payment_paid'))
  assert.equal(actions.filter(a => a === 'order.status_changed').length, 3)
  const last = detail.audit.find(a => a.action === 'order.status_changed')
  assert.equal(last.before.status, 'ready_for_collection')
  assert.equal(last.after.status, 'completed')
  assert.equal(last.admin_email, ADMIN_EMAIL)
})

test('order notes, list filters, search and pagination', async () => {
  const order = await placeOrder(app, undefined, { customer: { name: 'Grace Hopper', email: 'grace@example.com', phone: '07700 900123' } })
  const row = app.repo.orders.getByRef(order.order_ref)
  const notes = await admin.post(`/api/admin/orders/${row.id}/notes`, { admin_notes: 'Rang customer', version: row.version })
  assert.equal(notes.statusCode, 200)
  assert.equal(notes.json().order.admin_notes, 'Rang customer')
  assert.equal((await admin.post(`/api/admin/orders/${row.id}/notes`, { admin_notes: 'again', version: row.version })).statusCode, 409)

  const byRef = (await admin.get(`/api/admin/orders?q=${order.order_ref}`)).json()
  assert.equal(byRef.total, 1)
  assert.equal(byRef.orders[0].ref, order.order_ref)
  assert.equal((await admin.get('/api/admin/orders?q=grace@example.com')).json().total, 1)
  assert.equal((await admin.get('/api/admin/orders?status=refunded')).json().total, 0)
  const today = new Date().toISOString().slice(0, 10)
  assert.ok((await admin.get(`/api/admin/orders?from=${today}&to=${today}`)).json().total >= 1)
  assert.equal((await admin.get('/api/admin/orders?from=2020-01-01&to=2020-01-02')).json().total, 0)
  const page = (await admin.get('/api/admin/orders?limit=1&offset=0')).json()
  assert.equal(page.orders.length, 1)
  assert.ok(page.total >= 2)
  assert.equal((await admin.get('/api/admin/orders?limit=9999')).statusCode, 422)
  assert.equal((await admin.get('/api/admin/orders/999999')).statusCode, 404)
  assert.equal((await admin.get('/api/admin/orders/abc')).statusCode, 422)
})

test('products: create, update with version, stale update 409, archive and restore, all audited', async () => {
  const roasterId = (await admin.get('/api/admin/roasters')).json().roasters[0].id
  const created = await admin.post('/api/admin/products', {
    roaster_id: roasterId,
    name: 'Test Lot Nº 1',
    origin_country: 'Peru',
    roast_level: 2,
    brew: 'filter',
    notes: ['Plum', 'Honey', 'Tea'],
    flavour: { acidity: 6, sweetness: 7, body: 5, fruit: 6, floral: 4, roast: 3 },
    price_pence: 1200,
    stock: 4,
    is_admin: true
  })
  assert.equal(created.statusCode, 201, created.body)
  let product = created.json().product
  assert.equal(product.status, 'draft')
  assert.equal(product.slug, 'test-lot-no-1')
  assert.equal(product.stock, 4)
  assert.ok(!('is_admin' in product), 'unknown keys are stripped')
  assert.equal((await app.inject({ method: 'GET', url: `/api/products/${product.slug}` })).statusCode, 404, 'drafts are not public')

  const updated = await admin.patch(`/api/admin/products/${product.id}`, { status: 'active', price_pence: 1300, version: product.version })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().product.price_pence, 1300)
  assert.equal(updated.json().product.name, 'Test Lot Nº 1', 'fields that were not sent are untouched')
  assert.equal((await app.inject({ method: 'GET', url: `/api/products/${product.slug}` })).json().product.stock_left, 4)

  const stale = await admin.patch(`/api/admin/products/${product.id}`, { price_pence: 1, version: product.version })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'stale_version')
  product = updated.json().product

  const bad = await admin.patch(`/api/admin/products/${product.id}`, { price_pence: -5, roast_level: 9, notes: ['one'], version: product.version })
  assert.equal(bad.statusCode, 422)
  assert.deepEqual(Object.keys(bad.json().error.fields).sort(), ['notes', 'price_pence', 'roast_level'])
  const dupe = await admin.patch(`/api/admin/products/${product.id}`, { slug: 'guji-natural', version: product.version })
  assert.equal(dupe.statusCode, 422)
  assert.ok(dupe.json().error.fields.slug)

  const archived = await admin.post(`/api/admin/products/${product.id}/archive`, { version: product.version })
  assert.equal(archived.json().product.status, 'archived')
  assert.equal((await app.inject({ method: 'GET', url: `/api/products/${product.slug}` })).statusCode, 404)
  const restored = await admin.post(`/api/admin/products/${product.id}/restore`, { version: archived.json().product.version })
  assert.equal(restored.json().product.status, 'draft')

  const all = (await admin.get('/api/admin/products')).json()
  assert.equal(all.count, 25)
  assert.ok(all.products.every(p => Number.isInteger(p.stock)))
  assert.equal((await admin.get('/api/admin/products?status=draft')).json().count, 1)

  const audit = (await admin.get(`/api/admin/audit?entity=product&entity_id=${product.id}`)).json().entries
  assert.deepEqual(audit.map(a => a.action), ['product.restored', 'product.archived', 'product.updated', 'product.created'])
  const update = audit[2]
  assert.equal(update.before.price_pence, 1200)
  assert.equal(update.after.price_pence, 1300)
  assert.equal(audit[3].before, null)
})

test('roasters and delivery zones: create, update, deactivate, upsert, audited', async () => {
  const created = await admin.post('/api/admin/roasters', { name: 'Test Roastery', area: 'Dalston', postcode: 'e8', lat: 51.546, lon: -0.075 })
  assert.equal(created.statusCode, 201, created.body)
  let roaster = created.json().roaster
  assert.equal(roaster.slug, 'test-roastery')
  assert.equal(roaster.active, true)
  const updated = await admin.patch(`/api/admin/roasters/${roaster.id}`, { collection_enabled: false, collection_hours: 'Sat 10 to 2', version: roaster.version })
  assert.equal(updated.json().roaster.collection_enabled, false)
  assert.equal((await admin.patch(`/api/admin/roasters/${roaster.id}`, { name: 'X', version: roaster.version })).statusCode, 409)
  roaster = updated.json().roaster

  const sq = (await admin.get('/api/admin/roasters')).json().roasters.find(r => r.slug === 'square-mile')
  const off = await admin.post(`/api/admin/roasters/${sq.id}/deactivate`, { version: sq.version })
  assert.equal(off.json().roaster.active, false)
  assert.equal((await app.inject({ method: 'GET', url: '/api/roasters' })).json().roasters.some(r => r.slug === 'square-mile'), false)
  assert.equal((await app.inject({ method: 'GET', url: '/api/products?roaster=square-mile' })).json().count, 0, 'its coffees leave the shop too')
  const on = await admin.post(`/api/admin/roasters/${sq.id}/reactivate`, { version: off.json().roaster.version })
  assert.equal(on.json().roaster.active, true)

  const zone = await admin.put('/api/admin/delivery-zones/w', { fee_pence: 495, active: false })
  assert.deepEqual(zone.json().zone, { postcode_prefix: 'W', fee_pence: 495, active: false })
  assert.equal((await app.inject({ method: 'GET', url: '/api/postcode/W11' })).json().delivery_available, false)
  assert.equal((await admin.put('/api/admin/delivery-zones/W1', { fee_pence: 1 })).statusCode, 422)
  assert.equal((await admin.put('/api/admin/delivery-zones/W', { fee_pence: 2.5 })).statusCode, 422)
  assert.equal((await admin.get('/api/admin/delivery-zones')).json().zones.length, 9)

  const zoneAudit = (await admin.get('/api/admin/audit?entity=delivery_zone&entity_id=W')).json().entries
  assert.equal(zoneAudit[0].before.fee_pence, 350)
  assert.equal(zoneAudit[0].after.fee_pence, 495)
  const roasterAudit = (await admin.get(`/api/admin/audit?entity=roaster&entity_id=${sq.id}`)).json().entries
  assert.deepEqual(roasterAudit.map(a => a.action), ['roaster.reactivated', 'roaster.deactivated'])
})

test('summary counts orders by status, low stock and today', async () => {
  const p = app.repo.catalog.getProductBySlug('mogiana-natural')
  app.repo.catalog.updateProduct(p.id, p.version, { ...p, stock: 2 })
  const s = (await admin.get('/api/admin/summary')).json()
  assert.equal(typeof s.orders_by_status.pending_payment, 'number')
  assert.ok(s.orders_by_status.completed >= 1)
  assert.ok(s.low_stock_products.some(x => x.slug === 'mogiana-natural' && x.stock === 2))
  assert.ok(s.today.orders >= 2)
  assert.ok(s.today.revenue_pence >= 1250)
})

test('password change needs the current password, 12+ characters and rejects common passwords', async () => {
  const user = await loginAdmin(app, { email: 'pw@example.com', password: 'original-password-55' })
  const change = (current_password, new_password) => user.post('/api/admin/password', { current_password, new_password })
  let res = await change('wrong-current-password', 'a-brand-new-password-1')
  assert.equal(res.statusCode, 422)
  assert.ok(res.json().error.fields.current_password)
  res = await change('original-password-55', 'short')
  assert.match(res.json().error.fields.new_password, /at least 12/)
  for (const common of ['password1234', 'Qwertyuiop123', 'aaaaaaaaaaaaaa', 'pw@example.com']) {
    res = await change('original-password-55', common)
    assert.equal(res.statusCode, 422, common)
    assert.ok(res.json().error.fields.new_password, common)
  }
  const other = await loginAdmin(app, { email: 'pw@example.com', password: 'original-password-55' })
  res = await change('original-password-55', 'a-brand-new-password-1')
  assert.equal(res.statusCode, 200)
  assert.equal((await other.get('/api/admin/me')).statusCode, 401, 'other sessions are signed out')
  assert.equal((await user.get('/api/admin/me')).statusCode, 401, 'the old session id is replaced')
  const stored = app.repo.admin.getAdminByEmail('pw@example.com').password_hash
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
  assert.ok(!stored.includes('a-brand-new-password-1'))
  await loginAdmin(app, { email: 'pw@example.com', password: 'a-brand-new-password-1' })
  const old = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { email: 'pw@example.com', password: 'original-password-55' } })
  assert.equal(old.statusCode, 401)
})

test('each user gets a different salt', async () => {
  await createAdmin(app, 'salt1@example.com', 'the-same-password-123')
  await createAdmin(app, 'salt2@example.com', 'the-same-password-123')
  const a = app.repo.admin.getAdminByEmail('salt1@example.com').password_hash.split('$')
  const b = app.repo.admin.getAdminByEmail('salt2@example.com').password_hash.split('$')
  assert.notEqual(a[4], b[4])
  assert.notEqual(a[5], b[5])
})
