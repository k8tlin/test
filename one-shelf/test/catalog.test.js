'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { makeApp, ORIGIN } = require('./helpers/app')

let app
before(async () => { app = await makeApp() })
after(async () => { await app.close() })

const get = (url) => app.inject({ method: 'GET', url })

test('GET /api/config reports demo mode, fee in pence and currency', async () => {
  const body = (await get('/api/config')).json()
  assert.equal(body.payment_mode, 'demo')
  assert.equal(body.delivery_fee_pence, 350)
  assert.equal(body.currency, 'GBP')
})

test('seed gives 12 roasters and 24 active products', async () => {
  assert.equal((await get('/api/roasters')).json().roasters.length, 12)
  const body = (await get('/api/products')).json()
  assert.equal(body.products.length, 24)
  assert.equal(body.products[0].roast_level, 1, 'default sort is by roast level')
})

test('public catalogue never exposes integer ids or exact stock above 5', async () => {
  const roasters = (await get('/api/roasters')).json().roasters
  const products = (await get('/api/products')).json().products
  for (const p of products) {
    assert.equal(typeof p.id, 'string')
    assert.equal(p.id, p.slug)
    assert.equal(typeof p.roaster.id, 'string')
    assert.ok(!('stock' in p) && !('roaster_id' in p) && !('version' in p))
    assert.equal(p.stock_left, null, 'seed stock is 12+, so the count is hidden')
    assert.equal(p.in_stock, true)
    assert.equal(p.low_stock, false)
  }
  for (const r of roasters) assert.equal(typeof r.id, 'string')
  // No bare integer id anywhere in the payloads.
  assert.doesNotMatch(JSON.stringify({ roasters, products }), /"(id|roaster_id|product_id)":\d/)
})

test('low stock is flagged and the count shown only when 5 or fewer remain', async () => {
  const p = app.repo.catalog.getProductBySlug('boquete-geisha')
  app.repo.catalog.decrementStock(p.id, p.stock - 3)
  const one = (await get('/api/products/boquete-geisha')).json().product
  assert.equal(one.low_stock, true)
  assert.equal(one.stock_left, 3)
  app.repo.catalog.decrementStock(p.id, 3)
  const none = (await get('/api/products/boquete-geisha')).json().product
  assert.equal(none.in_stock, false)
  assert.equal(none.low_stock, false)
  app.repo.catalog.restoreStock(p.id, 20)
})

test('filters: roaster, roast band, brew, max price, search', async () => {
  const list = async (qs) => (await get('/api/products?' + qs)).json().products
  assert.deepEqual((await list('roaster=square-mile')).map(p => p.slug).sort(), ['huila-espresso', 'yirgacheffe-washed'])
  assert.ok((await list('roast=light')).every(p => p.roast_level <= 2))
  assert.ok((await list('roast=dark')).every(p => p.roast_level >= 4))
  assert.ok((await list('brew=espresso')).every(p => p.brew === 'espresso' || p.brew === 'both'))
  assert.ok((await list('max_price_pence=1000')).every(p => p.price_pence <= 1000))
  assert.deepEqual((await list('q=geisha')).map(p => p.slug), ['boquete-geisha'])
  assert.equal((await list('q=' + encodeURIComponent('%'))).length, 0, 'LIKE wildcards are escaped')
  const asc = (await list('sort=price_asc')).map(p => p.price_pence)
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b))
  const desc = (await list('sort=price_desc')).map(p => p.price_pence)
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a))
})

test('sort and filter values outside the allowlist are rejected with field messages', async () => {
  const res = await get('/api/products?sort=price_pence;DROP TABLE products&roast=burnt')
  assert.equal(res.statusCode, 422)
  const { error } = res.json()
  assert.equal(error.code, 'validation_error')
  assert.ok(error.fields.sort && error.fields.roast)
})

test('postcode adds distance_miles and sorts nearest first', async () => {
  const roasters = (await get('/api/roasters?postcode=E8%204PH')).json().roasters
  assert.equal(roasters[0].slug, 'climpson-and-sons')
  const d = roasters.map(r => r.distance_miles)
  assert.deepEqual(d, [...d].sort((a, b) => a - b))
  const products = (await get('/api/products?postcode=E8&sort=near')).json().products
  assert.equal(products[0].roaster.slug, 'climpson-and-sons')
  assert.equal(typeof products[0].distance_miles, 'number')
  assert.equal((await get('/api/products')).json().products[0].distance_miles, undefined)
})

test('GET /api/postcode/:value', async () => {
  const ok = (await get('/api/postcode/se15%203qf')).json()
  assert.equal(ok.valid, true)
  assert.equal(ok.district, 'SE15')
  assert.equal(ok.nearest_roaster.slug, 'old-spike')
  const notLondon = await get('/api/postcode/M1%201AE')
  assert.equal(notLondon.statusCode, 422)
  assert.equal(notLondon.json().error.code, 'postcode_not_london')
  assert.match(notLondon.json().error.message, /London/)
  const junk = await get('/api/postcode/hello')
  assert.equal(junk.statusCode, 422)
  assert.equal(junk.json().error.code, 'postcode_invalid')
})

test('draft and archived products and inactive roasters are hidden', async () => {
  const p = app.repo.catalog.getProductBySlug('cauca-washed')
  app.repo.catalog.updateProduct(p.id, p.version, { ...p, status: 'draft' })
  assert.equal((await get('/api/products/cauca-washed')).statusCode, 404)
  assert.equal((await get('/api/products')).json().products.length, 23)
  const again = app.repo.catalog.getProductBySlug('cauca-washed')
  app.repo.catalog.updateProduct(again.id, again.version, { ...again, status: 'active' })
})

test('basket quote: server prices, collection rules, delivery fee, problems', async () => {
  const quote = async (payload) => (await app.inject({ method: 'POST', url: '/api/basket/quote', headers: { origin: ORIGIN }, payload })).json()
  const single = await quote({ items: [{ product_id: 'guji-natural', quantity: 2, grind: 'Filter' }], fulfilment: 'collect' })
  assert.equal(single.subtotal_pence, 2500)
  assert.equal(single.delivery_fee_pence, 0)
  assert.equal(single.total_pence, 2500)
  assert.equal(single.collection.allowed, true)
  assert.equal(single.collection.roaster.id, 'climpson-and-sons')

  const mixed = await quote({
    items: [{ product_id: 'guji-natural', quantity: 1 }, { product_id: 'nyeri-aa', quantity: 1 }, { product_id: 'no-such-coffee', quantity: 1 }],
    fulfilment: 'delivery',
    postcode: 'SW9 8AA'
  })
  assert.equal(mixed.collection.allowed, false)
  assert.equal(mixed.collection.reason_code, 'multiple_roasters')
  assert.equal(mixed.delivery.available, true)
  assert.equal(mixed.delivery_fee_pence, 350)
  assert.equal(mixed.total_pence, 1250 + 1300 + 350)
  assert.deepEqual(mixed.problems.map(p => p.code), ['product_unavailable'])

  const p = app.repo.catalog.getProductBySlug('kayanza-washed')
  app.repo.catalog.decrementStock(p.id, p.stock - 2)
  const reduced = await quote({ items: [{ product_id: 'kayanza-washed', quantity: 5 }], fulfilment: 'collect' })
  assert.equal(reduced.lines[0].quantity, 2)
  assert.equal(reduced.problems[0].code, 'quantity_reduced')
  app.repo.catalog.decrementStock(p.id, 2)
  const gone = await quote({ items: [{ product_id: 'kayanza-washed', quantity: 1 }], fulfilment: 'collect' })
  assert.equal(gone.lines.length, 0)
  assert.equal(gone.problems[0].code, 'out_of_stock')
  assert.equal(gone.can_checkout, false)

  const outside = await quote({ items: [{ product_id: 'guji-natural', quantity: 1 }], fulfilment: 'delivery', postcode: 'M1 1AE' })
  assert.equal(outside.delivery.available, false)
  assert.equal(outside.can_checkout, false)
})

test('quantities must be whole numbers from 1 to 12', async () => {
  for (const quantity of [0, 13, 1.5, -1, '2']) {
    const res = await app.inject({ method: 'POST', url: '/api/basket/quote', headers: { origin: ORIGIN }, payload: { items: [{ product_id: 'guji-natural', quantity }] } })
    assert.equal(res.statusCode, 422, `quantity ${quantity}`)
    assert.ok(res.json().error.fields['items.0.quantity'])
  }
})
