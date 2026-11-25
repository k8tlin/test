'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { makeApp, loginAdmin, placeOrder, payDemo, checkoutPayload, stockOf, customer, ORIGIN } = require('./helpers/app')

let app
before(async () => { app = await makeApp() })
after(async () => { await app.close() })

const checkout = (payload) => app.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN }, payload })
const viewOrder = (ref, token) => app.inject({ method: 'GET', url: `/api/orders/${ref}?token=${encodeURIComponent(token)}` })
const setStock = (slug, n) => {
  const p = app.repo.catalog.getProductBySlug(slug)
  app.repo.catalog.updateProduct(p.id, p.version, { ...p, stock: n })
}

test('checkout creates a pending order, reserves stock and returns ref, token and payment url', async () => {
  const before = stockOf(app, 'huila-espresso')
  const order = await placeOrder(app, [{ product_id: 'huila-espresso', quantity: 3, grind: 'Espresso' }])
  assert.match(order.order_ref, /^OS-[34679ACDEFGHJKMNPQRTWXY]{7}$/)
  assert.ok(order.access_token.length >= 40)
  assert.equal(order.payment_url, `/pay/demo/${order.order_ref}?token=${order.access_token}`)
  assert.equal(stockOf(app, 'huila-espresso'), before - 3)

  const row = app.repo.orders.getByRef(order.order_ref)
  assert.equal(row.status, 'pending_payment')
  assert.notEqual(row.access_token_hash, order.access_token, 'only a hash of the token is stored')
  const minutes = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60000
  assert.equal(minutes, 30)

  const view = (await viewOrder(order.order_ref, order.access_token)).json().order
  assert.equal(view.status, 'pending_payment')
  assert.equal(view.total_pence, 3 * 1150)
  assert.equal(view.payment_url, order.payment_url)
  assert.ok(!('id' in view) && !('admin_notes' in view) && !('access_token_hash' in view) && !('version' in view))
  assert.equal(view.items[0].product_id, 'huila-espresso')
})

test('price tampering is ignored: totals always come from the database', async () => {
  const res = await checkout({
    ...checkoutPayload([{ product_id: 'boquete-geisha', quantity: 2, grind: 'Filter', price_pence: 1, unit_price_pence: 1, line_total_pence: 2 }]),
    subtotal_pence: 2,
    delivery_fee_pence: 0,
    total_pence: 2,
    status: 'paid'
  })
  assert.equal(res.statusCode, 201)
  const row = app.repo.orders.getByRef(res.json().order_ref)
  assert.equal(row.subtotal_pence, 4800)
  assert.equal(row.total_pence, 4800)
  assert.equal(row.status, 'pending_payment')
  assert.equal(app.repo.orders.listItems(row.id)[0].unit_price_pence, 2400)

  const delivery = await checkout({
    ...checkoutPayload([{ product_id: 'boquete-geisha', quantity: 1 }], {
      fulfilment: 'delivery',
      address: { line1: '1 Mare Street', city: 'London', postcode: 'e8 4rp' }
    }),
    delivery_fee_pence: 0
  })
  assert.equal(delivery.statusCode, 201)
  const d = app.repo.orders.getByRef(delivery.json().order_ref)
  assert.equal(d.delivery_fee_pence, 350)
  assert.equal(d.total_pence, 2400 + 350)
  assert.equal(d.postcode, 'E8 4RP')
})

test('overselling is prevented when two checkouts compete for the last bags', async () => {
  setStock('nyeri-aa', 3)
  const payload = checkoutPayload([{ product_id: 'nyeri-aa', quantity: 2 }])
  const [a, b] = await Promise.all([checkout(payload), checkout(payload)])
  const codes = [a.statusCode, b.statusCode].sort()
  assert.deepEqual(codes, [201, 409])
  const loser = a.statusCode === 409 ? a : b
  assert.equal(loser.json().error.code, 'basket_changed')
  assert.equal(stockOf(app, 'nyeri-aa'), 1, 'stock never goes negative and only one order took bags')
  const orders = app.repo.orders.search({ limit: 200, offset: 0 }).rows.filter(o => o.item_count === 2)
  assert.ok(orders.length >= 1)
})

test('the stock guard itself refuses to go below zero', async () => {
  setStock('nyeri-aa', 1)
  const p = app.repo.catalog.getProductBySlug('nyeri-aa')
  assert.equal(app.repo.catalog.decrementStock(p.id, 2), false)
  assert.equal(app.repo.catalog.decrementStock(p.id, 1), true)
  assert.equal(app.repo.catalog.decrementStock(p.id, 1), false)
  assert.equal(stockOf(app, 'nyeri-aa'), 0)
  setStock('nyeri-aa', 20)
})

test('a failed line rolls back the whole order, including stock already taken', async () => {
  setStock('sidama-honey', 1)
  const before = stockOf(app, 'tarrazu-washed')
  // Force the mid-transaction guard: the quote sees 1 in stock, then it vanishes.
  const original = app.repo.catalog.decrementStock
  app.repo.catalog.decrementStock = (id, qty) => {
    const p = app.repo.catalog.getProduct(id)
    return p.slug === 'sidama-honey' ? false : original(id, qty)
  }
  const res = await checkout(checkoutPayload([{ product_id: 'tarrazu-washed', quantity: 2 }, { product_id: 'sidama-honey', quantity: 1 }]))
  app.repo.catalog.decrementStock = original
  assert.equal(res.statusCode, 409)
  assert.equal(stockOf(app, 'tarrazu-washed'), before)
  setStock('sidama-honey', 20)
})

test('stock is restored when an unpaid order expires', async () => {
  const before = stockOf(app, 'marcala-washed')
  const order = await placeOrder(app, [{ product_id: 'marcala-washed', quantity: 4 }])
  assert.equal(stockOf(app, 'marcala-washed'), before - 4)
  assert.equal(app.orders.sweepExpired(), 0, 'not overdue yet')
  // 31 minutes later...
  assert.ok(app.orders.sweepExpired(new Date(Date.now() + 31 * 60000)) >= 1)
  assert.equal(app.repo.orders.getByRef(order.order_ref).status, 'expired')
  assert.equal(stockOf(app, 'marcala-washed'), before)
  // A second sweep must not restore twice.
  app.orders.sweepExpired(new Date(Date.now() + 62 * 60000))
  assert.equal(stockOf(app, 'marcala-washed'), before)
  // And the demo payment can no longer mark it paid.
  await payDemo(app, order)
  assert.equal(app.repo.orders.getByRef(order.order_ref).status, 'expired')
})

test('stock is restored when an admin cancels a paid order, exactly once', async () => {
  const admin = await loginAdmin(app)
  const before = stockOf(app, 'gayo-wet-hulled')
  const order = await placeOrder(app, [{ product_id: 'gayo-wet-hulled', quantity: 5 }])
  await payDemo(app, order)
  const row = app.repo.orders.getByRef(order.order_ref)
  assert.equal(row.status, 'paid')
  assert.equal(stockOf(app, 'gayo-wet-hulled'), before - 5)
  const res = await admin.post(`/api/admin/orders/${row.id}/status`, { status: 'cancelled', version: row.version })
  assert.equal(res.statusCode, 200)
  assert.equal(stockOf(app, 'gayo-wet-hulled'), before)
  const refund = await admin.post(`/api/admin/orders/${row.id}/status`, { status: 'refunded', version: res.json().order.version })
  assert.equal(refund.statusCode, 200)
  assert.equal(stockOf(app, 'gayo-wet-hulled'), before, 'refunding a cancelled order does not add stock again')
})

test('a failed demo payment cancels the order and restores stock', async () => {
  const before = stockOf(app, 'chiapas-washed')
  const order = await placeOrder(app, [{ product_id: 'chiapas-washed', quantity: 2 }])
  const res = await payDemo(app, order, 'fail')
  assert.equal(res.statusCode, 303)
  assert.equal(app.repo.orders.getByRef(order.order_ref).status, 'cancelled')
  assert.equal(stockOf(app, 'chiapas-washed'), before)
})

test('order view rejects a wrong, missing or malformed token with the same 404', async () => {
  const order = await placeOrder(app)
  const good = await viewOrder(order.order_ref, order.access_token)
  assert.equal(good.statusCode, 200)
  assert.equal(good.headers['cache-control'], 'no-store')
  const other = await placeOrder(app)
  const attempts = [
    await viewOrder(order.order_ref, other.access_token),
    await viewOrder(order.order_ref, order.access_token.slice(0, -1) + (order.access_token.endsWith('A') ? 'B' : 'A')),
    await viewOrder(order.order_ref, 'short'),
    await app.inject({ method: 'GET', url: `/api/orders/${order.order_ref}` }),
    await viewOrder('OS-AAAAAAA', order.access_token),
    await viewOrder('1', order.access_token)
  ]
  for (const res of attempts) {
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), { error: { code: 'not_found', message: 'We could not find that order.' } })
  }
})

test('demo payment page: clear demo wording, total, CSP-safe markup, token required', async () => {
  const order = await placeOrder(app, [{ product_id: 'guji-natural', quantity: 2 }])
  const page = await app.inject({ method: 'GET', url: order.payment_url })
  assert.equal(page.statusCode, 200)
  assert.match(page.headers['content-type'], /text\/html/)
  assert.match(page.body, /Demo payment: no money is taken/)
  assert.match(page.body, /£25\.00/)
  assert.match(page.headers['content-security-policy'], /style-src 'self'/)
  assert.doesNotMatch(page.body, /<script|<style|\sstyle=|\son[a-z]+=/i, 'no inline script, style or event handlers')
  assert.match(page.body, /<link rel="stylesheet" href="\/pay\/demo\.css">/)
  const css = await app.inject({ method: 'GET', url: '/pay/demo.css' })
  assert.equal(css.statusCode, 200)
  assert.match(css.headers['content-type'], /text\/css/)

  assert.equal((await app.inject({ method: 'GET', url: `/pay/demo/${order.order_ref}?token=${'x'.repeat(43)}` })).statusCode, 404)
  const forged = await app.inject({
    method: 'POST',
    url: `/pay/demo/${order.order_ref}/pay`,
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${'x'.repeat(43)}`
  })
  assert.equal(forged.statusCode, 404)
  assert.equal(app.repo.orders.getByRef(order.order_ref).status, 'pending_payment')
  // Paying needs a POST: a GET to the action URL changes nothing.
  assert.equal((await app.inject({ method: 'GET', url: `/pay/demo/${order.order_ref}/pay?token=${order.access_token}` })).statusCode, 404)
  assert.equal(app.repo.orders.getByRef(order.order_ref).status, 'pending_payment')

  const paid = await payDemo(app, order)
  assert.equal(paid.statusCode, 303)
  assert.equal(paid.headers.location, `/order.html?ref=${order.order_ref}&token=${order.access_token}`)
  const row = app.repo.orders.getByRef(order.order_ref)
  assert.equal(row.status, 'paid')
  assert.ok(row.paid_at)
  // Paying twice is harmless.
  await payDemo(app, order)
  assert.equal(app.repo.orders.getByRef(order.order_ref).version, row.version)
  const after = await app.inject({ method: 'GET', url: order.payment_url })
  assert.match(after.body, /can no longer be paid/)
})

test('checkout validation returns per-field messages', async () => {
  const res = await checkout({
    items: [{ product_id: 'guji-natural', quantity: 99 }],
    fulfilment: 'delivery',
    customer: { name: '', email: 'not-an-email', phone: 'abc' },
    address: { line1: '', city: 'London', postcode: 'NOPE' }
  })
  assert.equal(res.statusCode, 422)
  const { fields } = res.json().error
  for (const key of ['items.0.quantity', 'customer.name', 'customer.email', 'customer.phone', 'address.line1', 'address.postcode', 'accept_terms']) {
    assert.equal(typeof fields[key], 'string', key)
  }
  const noAddress = await checkout(checkoutPayload([{ product_id: 'guji-natural', quantity: 1 }], { fulfilment: 'delivery' }))
  assert.equal(noAddress.statusCode, 422)
  assert.ok(noAddress.json().error.fields.address)
  const outside = await checkout(checkoutPayload([{ product_id: 'guji-natural', quantity: 1 }], {
    fulfilment: 'delivery', address: { line1: '1 High St', city: 'Manchester', postcode: 'M1 1AE' }
  }))
  assert.equal(outside.statusCode, 422)
  assert.ok(outside.json().error.fields['address.postcode'])
})

test('collection is refused for a basket from two roasters', async () => {
  const res = await checkout(checkoutPayload([{ product_id: 'guji-natural', quantity: 1 }, { product_id: 'nyeri-aa', quantity: 1 }]))
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error.code, 'collection_unavailable')
})

test('checkout is rate limited per IP', async () => {
  const limited = await makeApp({ rateLimit: { checkoutMax: 2 } })
  try {
    const payload = { ...checkoutPayload([{ product_id: 'guji-natural', quantity: 1 }]), customer }
    const send = () => limited.inject({ method: 'POST', url: '/api/checkout', headers: { origin: ORIGIN }, payload })
    assert.equal((await send()).statusCode, 201)
    assert.equal((await send()).statusCode, 201)
    const third = await send()
    assert.equal(third.statusCode, 429)
    assert.equal(third.json().error.code, 'rate_limited')
  } finally {
    await limited.close()
  }
})
