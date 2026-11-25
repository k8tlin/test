'use strict'
// End-to-end tests for the admin front end, in a real browser against the real server.
//
//   node test-e2e/admin/run.js
//
// Starts its own server on a free port with a throwaway data directory (seeded,
// one admin), creates orders through the public API, then drives /admin/.
// Environment: E2E_DATA_DIR (parent folder for the throwaway data; default the OS temp dir).
// Playwright must be resolvable (it is installed globally in this environment).

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..', '..')
const SHOTS = path.join(__dirname, 'shots')
const EMAIL = 'admin@example.test'
const PASSWORD = 'correct horse battery staple 1'
const NEW_PASSWORD = 'a different long passphrase 2'
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning']

let BASE = ''
const results = []
const consoleErrors = [] // everything except the browser's own "Failed to load resource" lines
const failedResources = [] // those lines: one per non-2xx response
const cspViolations = []

// ---- helpers ---------------------------------------------------------------

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

async function waitForServer () {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) return } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('server did not start')
}

function makePng (width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2 // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ])
}

async function publicJson (method, pathname, body) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${JSON.stringify(data)}`)
  return data
}

/** Checkout through the public API, then (optionally) press "Pay" on the demo payment page. */
async function createOrder ({ items, fulfilment, name, email, pay = true }) {
  const order = await publicJson('POST', '/api/checkout', {
    items,
    fulfilment,
    customer: { name, email, phone: '020 7946 0958' },
    address: fulfilment === 'delivery' ? { line1: '1 Mare Street', line2: 'Flat 2', city: 'London', postcode: 'E8 4RP' } : undefined,
    delivery_notes: fulfilment === 'delivery' ? 'Leave with the neighbour at number 3' : undefined,
    accept_terms: true
  })
  if (pay) {
    const response = await fetch(`${BASE}/pay/demo/${order.order_ref}/pay`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ token: order.access_token })
    })
    assert.equal(response.status, 303, 'demo Pay form should redirect')
  }
  const view = await publicJson('GET', `/api/orders/${order.order_ref}?token=${order.access_token}`)
  return { ref: order.order_ref, total: view.order.total_pence, status: view.order.status }
}

const pounds = (pence) => `£${Math.floor(pence / 100).toLocaleString('en-GB')}.${String(pence % 100).padStart(2, '0')}`

async function step (name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok    ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL  ${name}\n        ${String(error && error.stack ? error.stack : error).split('\n').slice(0, 6).join('\n        ')}`)
    try { await step.page.screenshot({ path: path.join(SHOTS, `FAILED-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`) }) } catch { /* ignore */ }
  }
}

function watch (page) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) cspViolations.push(text)
    else if (/^Failed to load resource/.test(text)) failedResources.push(`${text} ${message.location().url}`)
    else consoleErrors.push(text)
  })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`))
}

// ---- main ------------------------------------------------------------------

async function main () {
  fs.mkdirSync(SHOTS, { recursive: true })
  for (const file of fs.readdirSync(SHOTS)) if (file.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, file))

  const parent = process.env.E2E_DATA_DIR || os.tmpdir()
  fs.mkdirSync(parent, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(parent, 'one-shelf-admin-e2e-'))
  const port = await freePort()
  BASE = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, NODE_ENV: 'development', DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', PUBLIC_BASE_URL: BASE, LOG_LEVEL: 'warn',
    PAYMENT_PROVIDER: 'demo', RATE_LIMIT_GLOBAL_MAX: '100000', RATE_LIMIT_LOGIN_MAX: '1000', RATE_LIMIT_CHECKOUT_MAX: '1000', RATE_LIMIT_SUBSCRIBE_MAX: '1000'
  }
  execFileSync(process.execPath, [...NODE_FLAGS, 'scripts/seed.js'], { cwd: ROOT, env, stdio: 'pipe' })
  execFileSync(process.execPath, [...NODE_FLAGS, 'scripts/create-admin.js', EMAIL], { cwd: ROOT, env: { ...env, ADMIN_PASSWORD: PASSWORD }, stdio: 'pipe' })
  const server = spawn(process.execPath, [...NODE_FLAGS, 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += chunk })
  server.stderr.on('data', chunk => { serverLog += chunk })

  let browser
  try {
    await waitForServer()
    console.log(`Server on ${BASE}, data in ${dataDir}`)

    // ---- data to manage: four orders and two subscribers -------------------
    const orderA = await createOrder({ items: [{ product_id: 'guji-natural', quantity: 2, grind: 'Filter' }], fulfilment: 'collect', name: 'Ada Collect', email: 'ada@example.com' })
    const orderB = await createOrder({ items: [{ product_id: 'guji-natural', quantity: 2 }, { product_id: 'nyeri-aa', quantity: 1, grind: 'Espresso' }], fulfilment: 'delivery', name: 'Bea Deliver', email: 'bea@example.com' })
    const orderC = await createOrder({ items: [{ product_id: 'nyeri-aa', quantity: 1 }], fulfilment: 'delivery', name: 'Cy Stale', email: 'cy@example.com' })
    const orderD = await createOrder({ items: [{ product_id: 'nyeri-aa', quantity: 1 }], fulfilment: 'collect', name: 'Dee Unpaid', email: 'dee@example.com', pay: false })
    assert.deepEqual([orderA.status, orderB.status, orderC.status, orderD.status], ['paid', 'paid', 'paid', 'pending_payment'])
    await publicJson('POST', '/api/subscribe', { email: 'reader-one@example.com', consent: true, source: 'footer' })
    await publicJson('POST', '/api/subscribe', { email: 'reader-two@example.com', consent: true, source: 'home' })

    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true })
    const page = await context.newPage()
    step.page = page
    watch(page)
    page.setDefaultTimeout(10000)

    const admin = `${BASE}/admin/`
    const h1 = () => page.locator('main h1')
    const status = () => page.locator('#status-region')
    const alertBox = () => page.locator('#alert-region')
    const dialog = () => page.getByRole('dialog')
    const nav = (name) => page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name, exact: true })
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
    // Run something that re-renders the view, and wait for the new view to finish loading.
    const fresh = async (action) => {
      await page.evaluate(() => { const view = document.querySelector('main .view'); if (view) view.dataset.old = '1' })
      await action()
      await page.locator('main .view:not([data-old])').waitFor()
      await page.locator('main .loading').waitFor({ state: 'detached' })
    }
    const go = async (hash, title) => {
      await fresh(() => page.goto(admin + hash))
      if (title) await h1().filter({ hasText: title }).waitFor()
    }
    const applyFilters = (name = 'Apply filters') => fresh(() => page.getByRole('button', { name }).click())
    // Do something and wait for its confirmation, ignoring any earlier message still on screen.
    const expectStatus = async (action, text) => {
      await page.evaluate(() => document.getElementById('status-region').replaceChildren())
      await action()
      await status().filter({ hasText: text }).waitFor()
    }
    const saveChanges = (text = 'Changes saved.') => expectStatus(() => page.getByRole('button', { name: 'Save changes' }).click(), text)
    const api = async (pathname) => {
      const response = await page.request.get(BASE + pathname)
      assert.equal(response.status(), 200, `GET ${pathname}`)
      return response.json()
    }
    const adminProduct = async (slug) => (await api('/api/admin/products')).products.find(p => p.slug === slug)
    const orderId = async (ref) => (await api(`/api/admin/orders?q=${ref}`)).orders[0].id
    const transitions = () => page.locator('#status-actions button').evaluateAll(buttons => buttons.map(b => b.dataset.transition))
    const noPageScroll = async (label) => {
      const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 0, `${label}: the page scrolls sideways by ${overflow}px`)
    }
    const signIn = async (password = PASSWORD) => {
      await page.getByLabel('Email address').fill(EMAIL)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in' }).click()
    }

    // ---- sign in ------------------------------------------------------------
    await step('signed out: an admin page redirects to sign-in and has noindex', async () => {
      await page.goto(`${admin}#/orders`)
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
      assert.match(page.url(), /#\/signin\?next=%2Forders$/)
      assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex')
      assert.ok(await page.locator('#topbar').isHidden(), 'navigation is hidden while signed out')
      await shot('01-sign-in-1360')
    })

    await step('wrong password shows the generic error', async () => {
      await signIn('definitely not the password')
      await page.locator('#signin-error').filter({ hasText: 'Invalid email or password' }).waitFor()
      assert.equal((await page.locator('#signin-error').textContent()).trim(), 'Invalid email or password')
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
    })

    await step('rate-limited sign-in shows "too many attempts, try again later"', async () => {
      await page.route('**/api/admin/login', route => route.fulfill({
        status: 429, contentType: 'application/json', headers: { 'retry-after': '840' },
        body: JSON.stringify({ error: { code: 'rate_limited', message: 'Rate limit exceeded' } })
      }))
      await signIn()
      await page.locator('#signin-error').filter({ hasText: /Too many attempts\. Try again later, in about 14 minutes\./ }).waitFor()
      await shot('01b-sign-in-rate-limited-1360')
      await page.unroute('**/api/admin/login')
    })

    await step('sign in sends the CSRF token flow and returns to where the user was', async () => {
      const me = page.waitForResponse(r => r.url().endsWith('/api/admin/me') && r.status() === 200)
      await signIn()
      await me // token refreshed after sign-in
      await h1().filter({ hasText: 'Orders' }).waitFor()
      assert.match(page.url(), /#\/orders$/)
      assert.equal(await nav('Orders').getAttribute('aria-current'), 'page')
    })

    // ---- dashboard ----------------------------------------------------------
    await step('dashboard numbers match the orders created', async () => {
      await go('#/', 'Dashboard')
      const count = (s) => page.locator(`a[data-status="${s}"] .card-number`).textContent()
      assert.equal(await count('paid'), '3')
      assert.equal(await count('pending_payment'), '1')
      assert.equal(await count('preparing'), '0')
      assert.equal(await count('completed'), '0')
      assert.match(await page.locator('#needs-action').textContent(), /^3 orders need attention/)
      assert.equal(await page.locator('[data-stat="today-orders"] .card-number').textContent(), '4')
      assert.equal(await page.locator('[data-stat="today-revenue"] .card-number').textContent(), pounds(orderA.total + orderB.total + orderC.total))
      // actionable statuses come first, paid before everything
      const order = await page.locator('a[data-status]').evaluateAll(links => links.map(a => a.dataset.status))
      assert.deepEqual(order.slice(0, 4), ['paid', 'preparing', 'ready_for_collection', 'out_for_delivery'])
      assert.match(await page.locator('a[data-status="paid"]').textContent(), /Needs preparing/)
      await shot('02-dashboard-1360')
      await fresh(() => page.locator('a[data-status="paid"]').click())
      await h1().filter({ hasText: 'Orders' }).waitFor()
      assert.match(page.url(), /#\/orders\?status=paid$/)
      await page.locator('tbody tr').first().waitFor()
      assert.equal(await page.locator('tbody tr').count(), 3)
    })

    // ---- orders -------------------------------------------------------------
    await step('orders list: newest first, search, status and date filters, status as text', async () => {
      await go('#/orders', 'Orders')
      const refs = await page.locator('tbody th a').allTextContents()
      assert.deepEqual(refs, [orderD.ref, orderC.ref, orderB.ref, orderA.ref])
      assert.match(await page.locator('tbody tr').first().locator('.status').textContent(), /Awaiting payment/)
      await shot('03-orders-1360')
      await page.getByLabel('Search reference, email or name').fill('bea@example.com')
      await applyFilters()
      await page.locator('tbody tr').first().waitFor()
      assert.deepEqual(await page.locator('tbody th a').allTextContents(), [orderB.ref])
      await page.getByLabel('Search reference, email or name').fill(orderA.ref)
      await applyFilters()
      await page.locator('tbody th a', { hasText: orderA.ref }).waitFor()
      assert.equal(await page.locator('tbody tr').count(), 1)
      await fresh(() => page.getByRole('button', { name: 'Clear' }).click())
      await page.getByLabel('Status').selectOption('pending_payment')
      await page.getByLabel('From date').fill('2020-01-01')
      await page.getByLabel('To date').fill('2099-01-01')
      await applyFilters()
      await page.locator('tbody th a', { hasText: orderD.ref }).waitFor()
      assert.equal(await page.locator('tbody tr').count(), 1)
      await page.getByLabel('From date').fill('2001-01-01')
      await page.getByLabel('To date').fill('2001-01-02')
      await applyFilters()
      await page.locator('.empty', { hasText: 'No orders match these filters.' }).waitFor()
    })

    const idA = await orderId(orderA.ref)
    const idB = await orderId(orderB.ref)
    const idC = await orderId(orderC.ref)

    await step('order detail shows customer, fulfilment, items, totals, payment and timeline', async () => {
      await go(`#/orders/${idB}`, orderB.ref)
      const text = await page.locator('main').innerText()
      for (const expected of ['Bea Deliver', 'bea@example.com', '020 7946 0958', 'Local delivery', '1 Mare Street', 'Flat 2', 'E8 4RP',
        'Leave with the neighbour at number 3', 'Guji Natural', 'Nyeri AA', 'Espresso', 'Demo (no money taken)', `demo_${orderB.ref}`, 'Payment received', 'Order placed']) {
        assert.ok(text.includes(expected), `order detail should show "${expected}"`)
      }
      assert.equal(await page.locator('#order-total').textContent(), pounds(orderB.total))
      await shot('04-order-detail-1360')
    })

    await step('paid order moves through preparing and ready to completed, offering only allowed actions', async () => {
      await go(`#/orders/${idA}`, orderA.ref)
      assert.ok((await page.locator('main').innerText()).includes('Collection from the roastery'))
      assert.deepEqual(await transitions(), ['preparing', 'cancelled', 'refunded'])
      await page.getByRole('button', { name: 'Start preparing' }).click()
      await page.locator('#order-status', { hasText: 'Preparing' }).waitFor()
      await status().filter({ hasText: 'Order is now being prepared.' }).waitFor()
      assert.deepEqual(await transitions(), ['ready_for_collection', 'cancelled', 'refunded']) // collection order: no "out for delivery"
      await page.getByRole('button', { name: 'Mark ready for collection' }).click()
      await page.locator('#order-status', { hasText: 'Ready for collection' }).waitFor()
      assert.deepEqual(await transitions(), ['completed', 'cancelled', 'refunded'])
      await page.getByRole('button', { name: 'Mark completed' }).click()
      await page.locator('#order-status', { hasText: 'Completed' }).waitFor()
      assert.deepEqual(await transitions(), ['refunded'])
      const timeline = await page.locator('.timeline').innerText()
      assert.ok(timeline.includes('Status changed from Ready for collection to Completed'))
      assert.ok(timeline.includes(EMAIL))
      assert.equal((await api(`/api/admin/orders/${idA}`)).order.status, 'completed')
      await shot('04b-order-completed-1360')
    })

    await step('internal notes save', async () => {
      await page.getByLabel('Internal notes').fill('Rang the customer. Collected by a friend.')
      await expectStatus(() => page.getByRole('button', { name: 'Save notes' }).click(), 'Notes saved.')
      assert.equal((await api(`/api/admin/orders/${idA}`)).order.admin_notes, 'Rang the customer. Collected by a friend.')
    })

    await step('cancel goes through a proper confirmation dialog and stock is restored', async () => {
      const before = { guji: (await adminProduct('guji-natural')).stock, nyeri: (await adminProduct('nyeri-aa')).stock }
      await go(`#/orders/${idB}`, orderB.ref)
      const cancel = page.getByRole('button', { name: 'Cancel order…' })
      await cancel.click()
      await dialog().waitFor()
      assert.equal(await dialog().getAttribute('aria-modal'), 'true')
      const said = await dialog().innerText()
      assert.ok(said.includes('Stock for 3 items will be returned to the shelf. This cannot be undone.'), said)
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Keep order', 'the safe choice has focus')
      await shot('05-cancel-dialog-1360')
      // focus stays inside the dialog
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab')
        assert.ok(await page.evaluate(() => Boolean(document.activeElement.closest('dialog'))), 'focus is trapped in the dialog')
      }
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel order…', 'focus returns to the button')
      assert.equal((await api(`/api/admin/orders/${idB}`)).order.status, 'paid', 'Escape cancels nothing')
      await cancel.click()
      await dialog().getByRole('button', { name: 'Cancel this order' }).click()
      await page.locator('#order-status', { hasText: 'Cancelled' }).waitFor()
      assert.deepEqual(await transitions(), ['refunded'])
      assert.equal((await adminProduct('guji-natural')).stock, before.guji + 2)
      assert.equal((await adminProduct('nyeri-aa')).stock, before.nyeri + 1)
    })

    await step('refund needs confirmation too, then nothing more is offered', async () => {
      await page.getByRole('button', { name: 'Mark as refunded…' }).click()
      assert.ok((await dialog().innerText()).includes('It does not move any money'))
      await dialog().getByRole('button', { name: 'Mark as refunded' }).click()
      await page.locator('#order-status', { hasText: 'Refunded' }).waitFor()
      await page.locator('#no-actions').waitFor()
      assert.equal(await page.locator('#status-actions button').count(), 0)
    })

    await step('stale version (409) reloads the order and says someone else changed it', async () => {
      await go(`#/orders/${idC}`, orderC.ref)
      const me = await api('/api/admin/me')
      const current = (await api(`/api/admin/orders/${idC}`)).order
      const other = await page.request.post(`${BASE}/api/admin/orders/${idC}/notes`, {
        headers: { 'x-csrf-token': me.csrf_token, origin: BASE }, data: { admin_notes: 'Changed in another tab', version: current.version }
      })
      assert.equal(other.status(), 200)
      await page.getByRole('button', { name: 'Start preparing' }).click()
      await alertBox().filter({ hasText: 'Someone else changed this order' }).waitFor()
      assert.equal(await page.getByLabel('Internal notes').inputValue(), 'Changed in another tab', 'the order was reloaded')
      await page.locator('#order-status', { hasText: 'Paid' }).waitFor()
      await page.getByRole('button', { name: 'Start preparing' }).click() // retry now works
      await page.locator('#order-status', { hasText: 'Preparing' }).waitFor()
      assert.deepEqual(await transitions(), ['out_for_delivery', 'cancelled', 'refunded']) // delivery order
    })

    await step('a refused transition (409 invalid_transition) is handled gracefully', async () => {
      const me = await api('/api/admin/me')
      const current = (await api(`/api/admin/orders/${idC}`)).order
      await page.route(`**/api/admin/orders/${idC}/status`, route => route.fulfill({
        status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_transition', message: 'That status change is not allowed.' } })
      }))
      await page.getByRole('button', { name: 'Mark out for delivery' }).click()
      await alertBox().filter({ hasText: 'That status change is not allowed. The order has been reloaded' }).waitFor()
      await page.unroute(`**/api/admin/orders/${idC}/status`)
      assert.ok(me.csrf_token && current.status === 'preparing')
      await h1().filter({ hasText: orderC.ref }).waitFor()
    })

    // ---- products -----------------------------------------------------------
    let productId = null
    const png = makePng(64, 48, [42, 59, 232])

    await step('product form validates like the API before sending', async () => {
      await go('#/products/new', 'Add product')
      await shot('06-product-new-1360')
      await page.getByLabel('Price in pounds (£)').fill('12.345')
      await page.getByLabel('Acidity (0 to 10)').fill('11')
      await page.getByRole('button', { name: 'Create product' }).click()
      const errorFor = (key) => page.locator(`[data-field="${key}"] .field-error`).textContent()
      assert.equal(await errorFor('name'), 'Name is required')
      assert.equal(await errorFor('roaster_id'), 'Choose a roaster')
      assert.equal(await errorFor('price_pence'), 'Enter a price in pounds and pence, like 12.50')
      assert.equal(await errorFor('flavour.acidity'), 'Maximum is 10')
      assert.equal(await errorFor('notes.0'), 'Tasting note is required')
      assert.equal(await page.getByLabel('Name', { exact: true }).getAttribute('aria-invalid'), 'true')
      await shot('06b-product-validation-1360')
    })

    await step('create a product with a PNG, set active, and it appears in GET /api/products', async () => {
      await page.getByLabel('Name', { exact: true }).fill('E2E Test Lot')
      await page.getByLabel('Roaster', { exact: true }).selectOption({ label: 'Climpson & Sons' })
      await page.getByLabel('Origin country').fill('Rwanda')
      await page.getByLabel('Origin region (optional)').fill('Nyamasheke')
      await page.getByLabel('Process (optional)').fill('Washed')
      await page.getByLabel('Varietal (optional)').fill('Red Bourbon')
      await page.getByLabel('Altitude in metres (optional)').fill('1850')
      await page.getByLabel('Roast level').selectOption('2')
      await page.getByLabel('Best brewed as').selectOption('filter')
      for (const [i, note] of ['Red apple', 'Honey', 'Black tea'].entries()) await page.getByLabel(`Tasting note ${i + 1}`).fill(note)
      for (const [label, score] of [['Acidity', 7], ['Sweetness', 8], ['Body', 5], ['Fruit', 6], ['Floral', 4], ['Roast', 2]]) await page.getByLabel(`${label} (0 to 10)`).fill(String(score))
      await page.getByLabel('Price in pounds (£)').fill('12.50')
      await page.getByLabel('Bag weight in grams').fill('250')
      await page.getByLabel('Bags in stock').fill('9')
      await page.getByLabel('Status').selectOption('active')
      await page.getByLabel('Tint colour').fill('#b0668d')
      await page.getByLabel('Product photo').setInputFiles({ name: 'bag.png', mimeType: 'image/png', buffer: png })
      await page.locator('.image-preview img[src^="blob:"]').waitFor() // preview before sending
      await page.getByRole('button', { name: 'Create product' }).click()
      await h1().filter({ hasText: 'Edit E2E Test Lot' }).waitFor()
      productId = Number(/#\/products\/(\d+)$/.exec(page.url())[1])
      await page.locator('.image-preview img[src^="/media/"]').waitFor()
      const listing = await (await fetch(`${BASE}/api/products`)).json()
      const live = listing.products.find(p => p.slug === 'e2e-test-lot')
      assert.ok(live, 'the new product is in the public catalogue')
      assert.equal(live.price_pence, 1250)
      assert.match(live.image_url, /^\/media\/[a-f0-9]{32}\.webp$/)
      assert.deepEqual(live.notes, ['Red apple', 'Honey', 'Black tea'])
      assert.equal(live.tint, '#B0668D')
      await shot('07-product-edit-1360')
    })

    await step('wrong-type and oversized files are rejected on the client; the server\'s reason is shown for a fake image', async () => {
      const requests = []
      const listener = (request) => { if (request.url().endsWith('/image')) requests.push(request.url()) }
      page.on('request', listener)
      const file = page.getByLabel('Product photo')
      const error = page.locator('[data-field="image"] .field-error')
      await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
      await error.filter({ hasText: 'not a JPEG, PNG or WebP image' }).waitFor()
      assert.ok(await page.getByRole('button', { name: 'Upload image' }).isDisabled())
      await file.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]) })
      await error.filter({ hasText: 'The largest allowed is 5 MB' }).waitFor()
      assert.ok(await page.getByRole('button', { name: 'Upload image' }).isDisabled())
      assert.equal(requests.length, 0, 'nothing was sent to the server')
      await shot('07b-product-file-rejected-1360')
      await file.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this only claims to be a png') })
      await page.getByRole('button', { name: 'Upload image' }).click()
      await error.filter({ hasText: /\S/ }).waitFor()
      const reply = await error.textContent()
      assert.ok(!/largest allowed|not a JPEG, PNG or WebP image\. Choose/.test(reply), `server message expected, got: ${reply}`)
      assert.equal(requests.length, 1)
      console.log(`        server said: "${reply}"`)
      page.off('request', listener)
      // and a real replacement works through the explicit upload button
      await file.setInputFiles({ name: 'bag2.png', mimeType: 'image/png', buffer: makePng(40, 40, [221, 243, 90]) })
      const before = await page.locator('.image-preview img').getAttribute('src')
      await page.getByRole('button', { name: 'Upload image' }).click()
      await status().filter({ hasText: 'Image uploaded.' }).waitFor()
      const after = await page.locator('.image-preview img').getAttribute('src')
      assert.match(after, /^\/media\//)
      assert.notEqual(after, before)
    })

    await step('a price change of more than 50% asks for an extra confirmation showing old and new', async () => {
      const price = page.getByLabel('Price in pounds (£)')
      await price.fill('13.00') // small change: no dialog
      await saveChanges()
      assert.equal(await dialog().count(), 0)
      await page.getByLabel('Price in pounds (£)').fill('130')
      await page.getByRole('button', { name: 'Save changes' }).click()
      await dialog().waitFor()
      assert.equal(await page.locator('#price-old').textContent(), '£13.00')
      assert.equal(await page.locator('#price-new').textContent(), '£130.00')
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Go back and check')
      await shot('08-price-confirm-1360')
      await dialog().getByRole('button', { name: 'Go back and check' }).click()
      assert.equal((await api(`/api/admin/products/${productId}`)).product.price_pence, 1300, 'not saved when declined')
      await page.getByLabel('Price in pounds (£)').fill('19.99')
      await page.getByRole('button', { name: 'Save changes' }).click()
      await expectStatus(() => dialog().getByRole('button', { name: 'Yes, change to £19.99' }).click(), 'Changes saved.')
      assert.equal((await api(`/api/admin/products/${productId}`)).product.price_pence, 1999)
    })

    await step('leaving a dirty form warns about unsaved changes', async () => {
      await page.getByLabel('Name', { exact: true }).fill('E2E Test Lot (edited)')
      await nav('Orders').click()
      await dialog().waitFor()
      assert.ok((await dialog().innerText()).includes('Leave without saving?'))
      await dialog().getByRole('button', { name: 'Stay on this page' }).click()
      assert.match(page.url(), new RegExp(`#/products/${productId}$`))
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'E2E Test Lot (edited)')
      await nav('Orders').click()
      await dialog().getByRole('button', { name: 'Leave without saving' }).click()
      await h1().filter({ hasText: 'Orders' }).waitFor()
      assert.equal((await api(`/api/admin/products/${productId}`)).product.name, 'E2E Test Lot')
    })

    await step('server validation errors land next to their field', async () => {
      await go(`#/products/${productId}`, 'Edit E2E Test Lot')
      await page.getByLabel('Web address name').fill('guji-natural') // already taken: only the server knows
      await page.getByRole('button', { name: 'Save changes' }).click()
      await page.locator('[data-field="slug"] .field-error').filter({ hasText: /\S/ }).waitFor()
      console.log(`        server said: "${await page.locator('[data-field="slug"] .field-error').textContent()}"`)
      await page.getByLabel('Web address name').fill('e2e-test-lot')
      await saveChanges()
    })

    await step('archive (with confirmation) and restore', async () => {
      await page.getByRole('button', { name: 'Archive product…' }).click()
      assert.ok((await dialog().innerText()).includes('disappear from the shop'))
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Keep product')
      await dialog().getByRole('button', { name: 'Archive product' }).click()
      await page.locator('#product-status', { hasText: 'Archived' }).waitFor()
      let listing = await (await fetch(`${BASE}/api/products`)).json()
      assert.ok(!listing.products.some(p => p.slug === 'e2e-test-lot'), 'archived product left the shop')
      await go('#/products?status=archived', 'Products')
      await page.locator('tbody tr').first().waitFor()
      assert.equal(await page.locator('tbody tr').count(), 1)
      await expectStatus(() => page.getByRole('button', { name: 'Restore E2E Test Lot' }).click(), 'restored as a draft')
      assert.equal((await api(`/api/admin/products/${productId}`)).product.status, 'draft')
      await go(`#/products/${productId}`, 'Edit E2E Test Lot')
      await page.getByLabel('Status').selectOption('active')
      await saveChanges()
      listing = await (await fetch(`${BASE}/api/products`)).json()
      assert.ok(listing.products.some(p => p.slug === 'e2e-test-lot'), 'active again')
    })

    await step('products list: filters, thumbnail or placeholder, quick-edit stock', async () => {
      await go('#/products', 'Products')
      await page.locator('tbody tr').first().waitFor()
      assert.equal(await page.locator('tbody tr').count(), 25)
      assert.ok(await page.locator('tbody .thumb-placeholder').count() >= 24)
      assert.equal(await page.locator(`tr[data-product-id="${productId}"] img.thumb`).count(), 1)
      await shot('09-products-1360')
      await page.getByLabel('Roaster', { exact: true }).selectOption({ label: 'Climpson & Sons' })
      await page.getByLabel('Status', { exact: true }).selectOption('active')
      await page.getByLabel('Search name, origin or notes').fill('E2E')
      await applyFilters()
      await page.locator(`tr[data-product-id="${productId}"]`).waitFor()
      assert.equal(await page.locator('tbody tr').count(), 1)
      const stock = page.getByRole('spinbutton', { name: 'Stock for E2E Test Lot' })
      const save = page.getByRole('button', { name: 'Save stock for E2E Test Lot' })
      assert.ok(await save.isDisabled(), 'nothing to save until the number changes')
      await stock.fill('2')
      await save.click()
      await status().filter({ hasText: 'Stock for E2E Test Lot is now 2.' }).waitFor()
      assert.equal((await api(`/api/admin/products/${productId}`)).product.stock, 2)
      await stock.fill('3') // a second edit uses the new version, no reload needed
      await expectStatus(() => save.click(), 'is now 3.')
      assert.equal((await api(`/api/admin/products/${productId}`)).product.stock, 3)
      await go('#/', 'Dashboard')
      await page.locator('#dash-low').waitFor()
      const low = page.getByRole('link', { name: 'E2E Test Lot' })
      await low.waitFor() // low stock shows on the dashboard and links onward
      await fresh(() => page.getByRole('link', { name: 'See them in the products list' }).click())
      await page.locator(`tr[data-product-id="${productId}"]`).waitFor()
      assert.match(page.url(), /#\/products\?low=1$/)
    })

    // ---- roasters -----------------------------------------------------------
    await step('roasters: list, live colour preview, create with image, deactivate and reactivate', async () => {
      await go('#/roasters', 'Roasters')
      await page.locator('tbody tr').first().waitFor()
      assert.equal(await page.locator('tbody tr').count(), 12)
      await shot('10-roasters-1360')
      await go('#/roasters/new', 'Add roaster')
      await page.getByLabel('Name', { exact: true }).fill('E2E Roasters')
      await page.getByLabel('Area').fill('Peckham')
      await page.getByLabel('Postcode').fill('se15')
      await page.getByLabel('Latitude').fill('95')
      await page.getByLabel('Longitude').fill('-0.069')
      await page.getByRole('button', { name: 'Create roaster' }).click()
      assert.equal(await page.locator('[data-field="lat"] .field-error').textContent(), 'That is not in the UK')
      await page.getByLabel('Latitude').fill('51.474')
      await page.getByLabel('Description (optional)').fill('A test roaster.')
      await page.getByLabel('Bag colour', { exact: true }).fill('#2a3be8')
      await page.getByLabel('Label colour', { exact: true }).fill('#ddf35a')
      await page.getByLabel('Label ink (text) colour').fill('#111114')
      const vars = await page.locator('#bag-preview').evaluate(el => [el.style.getPropertyValue('--bag'), el.style.getPropertyValue('--label'), getComputedStyle(el).backgroundColor])
      assert.deepEqual(vars, ['#2a3be8', '#ddf35a', 'rgb(42, 59, 232)'])
      assert.equal(await page.locator('.bag-label-name').textContent(), 'E2E Roasters')
      await page.getByLabel('Collection hours (optional)').fill('Sat 10am to 2pm')
      await page.getByLabel('Roaster photo').setInputFiles({ name: 'roastery.png', mimeType: 'image/png', buffer: png })
      await shot('11-roaster-new-1360')
      await page.getByRole('button', { name: 'Create roaster' }).click()
      await h1().filter({ hasText: 'Edit E2E Roasters' }).waitFor()
      await page.locator('.image-preview img[src^="/media/"]').waitFor()
      const roasterId = Number(/#\/roasters\/(\d+)$/.exec(page.url())[1])
      let roaster = (await api(`/api/admin/roasters/${roasterId}`)).roaster
      assert.equal(roaster.postcode, 'SE15')
      assert.equal(roaster.bag_color, '#2A3BE8')
      assert.equal(roaster.collection_hours, 'Sat 10am to 2pm')
      // edit
      await page.getByLabel('Area').fill('Peckham Rye')
      await saveChanges()
      await shot('11b-roaster-edit-1360')
      // deactivate / reactivate
      await page.getByRole('button', { name: 'Deactivate roaster…' }).click()
      assert.ok((await dialog().innerText()).includes('will disappear from the shop'))
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Keep roaster active')
      await dialog().getByRole('button', { name: 'Deactivate roaster' }).click()
      await page.locator('#roaster-status', { hasText: 'Inactive' }).waitFor()
      roaster = (await api(`/api/admin/roasters/${roasterId}`)).roaster
      assert.equal(roaster.active, false)
      assert.equal(roaster.area, 'Peckham Rye')
      await go('#/roasters', 'Roasters')
      await page.getByRole('button', { name: 'Reactivate E2E Roasters' }).click()
      await dialog().getByRole('button', { name: 'Reactivate roaster' }).click()
      await status().filter({ hasText: 'E2E Roasters reactivated.' }).waitFor()
      assert.equal((await api(`/api/admin/roasters/${roasterId}`)).roaster.active, true)
    })

    // ---- delivery zones -----------------------------------------------------
    await step('delivery zones: add a zone, edit its fee, toggle it off with confirmation', async () => {
      await go('#/zones', 'Delivery zones')
      await page.locator('tbody tr').first().waitFor()
      const before = await page.locator('tbody tr').count()
      await page.getByLabel('Postcode letters').fill('e')
      await page.getByLabel('Delivery fee in pounds (£)').fill('4.2.5')
      await page.getByRole('button', { name: 'Add zone' }).click()
      assert.match(await page.locator('[data-field="prefix"] .field-error').textContent(), /already a zone for E/)
      assert.equal(await page.locator('[data-field="fee_pence"] .field-error').textContent(), 'Enter a fee in pounds and pence, like 3.50')
      await page.getByLabel('Postcode letters').fill('br')
      await page.getByLabel('Delivery fee in pounds (£)').fill('4.25')
      await page.getByRole('button', { name: 'Add zone' }).click()
      await status().filter({ hasText: 'Zone BR added with a £4.25 fee.' }).waitFor()
      assert.equal(await page.locator('tbody tr').count(), before + 1)
      let zone = (await api('/api/admin/delivery-zones')).zones.find(z => z.postcode_prefix === 'BR')
      assert.deepEqual(zone, { postcode_prefix: 'BR', fee_pence: 425, active: true })
      const row = page.locator('tr[data-zone="BR"]')
      await row.getByLabel('Delivery fee in pounds for BR').fill('5')
      await row.getByRole('button', { name: 'Save fee for BR' }).click()
      await status().filter({ hasText: 'Delivery to BR now costs £5.00.' }).waitFor()
      await row.getByRole('switch').click()
      assert.ok((await dialog().innerText()).includes('Stop delivering to BR postcodes?'))
      await dialog().getByRole('button', { name: 'Stop delivery' }).click()
      await status().filter({ hasText: 'Delivery to BR is switched off.' }).waitFor()
      zone = (await api('/api/admin/delivery-zones')).zones.find(z => z.postcode_prefix === 'BR')
      assert.deepEqual(zone, { postcode_prefix: 'BR', fee_pence: 500, active: false })
      await shot('12-zones-1360')
    })

    // ---- subscribers --------------------------------------------------------
    await step('subscribers: table with status and consent date, CSV download', async () => {
      await go('#/subscribers', 'Subscribers')
      await page.locator('tbody tr').first().waitFor()
      assert.equal(await page.locator('tbody tr').count(), 2)
      const rowText = await page.locator('tbody tr', { hasText: 'reader-one@example.com' }).innerText()
      assert.match(rowText, /Pending/)
      assert.match(rowText, /\d{4}/, 'consent date shown')
      await shot('13-subscribers-1360')
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()])
      const csv = fs.readFileSync(await download.path(), 'utf8')
      assert.match(download.suggestedFilename(), /\.csv$/)
      assert.ok(csv.includes('reader-one@example.com') && csv.includes('reader-two@example.com'), csv)
      assert.match(csv.split('\n')[0], /email/i)
      await page.getByLabel('Status').selectOption('confirmed')
      await applyFilters('Apply filter')
      await page.locator('.empty', { hasText: 'No subscribers with this status.' }).waitFor()
    })

    // ---- activity -----------------------------------------------------------
    await step('activity log: who, what, when, before and after; filtered per order and product', async () => {
      await go('#/activity', 'Activity log')
      await page.locator('tbody tr').first().waitFor()
      await shot('14-activity-1360')
      await go(`#/orders/${idA}`, orderA.ref)
      await fresh(() => page.getByRole('link', { name: 'Full activity log for this order' }).click())
      await h1().filter({ hasText: `Activity log: order ${idA}` }).waitFor()
      await page.locator('tbody tr').first().waitFor()
      const text = await page.locator('tbody').innerText()
      assert.ok(text.includes('Order status changed') && text.includes('Payment received') && text.includes('Internal notes updated'), text)
      assert.ok(text.includes(EMAIL) && text.includes('System (automatic)'))
      assert.match(text, /Status: Ready for collection\s*→\s*(changed to\s*)?Completed/)
      await go(`#/products/${productId}`, 'Edit E2E Test Lot')
      await fresh(() => page.getByRole('link', { name: 'Activity log for this product' }).click())
      await h1().filter({ hasText: `Activity log: product ${productId}` }).waitFor()
      await page.locator('tbody tr').first().waitFor()
      const productLog = await page.locator('tbody').innerText()
      assert.match(productLog, /Price: £13\.00\s*→\s*(changed to\s*)?£19\.99/)
      assert.ok(productLog.includes('Product archived') && productLog.includes('Product restored') && productLog.includes('Product created'))
      await shot('14b-activity-product-1360')
    })

    // ---- every screen: zero console errors, zero CSP violations --------------
    await step('every screen renders with zero console errors and zero CSP violations (1360), and fits at 820 and 390', async () => {
      const screens = [['#/', 'Dashboard'], ['#/orders', 'Orders'], [`#/orders/${idC}`, orderC.ref], ['#/products', 'Products'], ['#/products/new', 'Add product'],
        [`#/products/${productId}`, 'Edit E2E Test Lot'], ['#/roasters', 'Roasters'], ['#/roasters/new', 'Add roaster'], ['#/roasters/1', 'Edit'], ['#/zones', 'Delivery zones'],
        ['#/subscribers', 'Subscribers'], ['#/activity', 'Activity log'], ['#/account', 'Account'], ['#/nowhere', 'Page not found']]
      failedResources.length = 0
      for (const width of [1360, 820, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const [hash, title] of screens) {
          await page.goto('about:blank')
          await go(hash, title) // full page load each time
          await page.waitForLoadState('networkidle')
          await noPageScroll(`${hash} at ${width}`)
          if (width === 390 && hash === '#/orders') await shot('03-orders-390')
          if (width === 390 && hash.startsWith('#/orders/')) await shot('04-order-detail-390')
          if (width === 820 && hash === '#/products') await shot('09-products-820')
          if (width === 820 && hash.startsWith('#/orders/')) await shot('04-order-detail-820')
          if (width === 1360 && hash === '#/account') await shot('15-account-1360')
          if (width === 390 && hash === '#/account') await shot('15-account-390')
          if (width === 390 && hash === '#/activity') await shot('14-activity-390')
          if (width === 820 && hash === '#/') await shot('02-dashboard-820')
          if (width === 1360 && hash === '#/nowhere') await shot('16-not-found-1360')
        }
      }
      await page.setViewportSize({ width: 1360, height: 900 })
      assert.deepEqual(consoleErrors, [], 'console errors')
      assert.deepEqual(cspViolations, [], 'CSP violations')
      assert.deepEqual(failedResources, [], 'failed requests while signed in')
      const inline = await page.evaluate(() => ({ style: document.querySelectorAll('style, [style=""]').length, script: [...document.scripts].filter(s => !s.src).length }))
      assert.deepEqual(inline, { style: 0, script: 0 })
    })

    await step('keyboard: skip link is first, focus ring is the 2px cobalt outline', async () => {
      await page.goto('about:blank')
      await go('#/orders', 'Orders')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link')
      await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(() => document.activeElement.id), 'main')
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth, s.outlineColor] })
      assert.deepEqual(ring, ['solid', '2px', 'rgb(42, 59, 232)'])
    })

    // ---- account ------------------------------------------------------------
    await step('change password: wrong current password shows the API error; rules are enforced', async () => {
      await page.setViewportSize({ width: 390, height: 900 }) // small screen: messages must not cover the button
      await go('#/account', 'Account')
      assert.equal(await page.locator('#account-email').textContent(), EMAIL)
      await page.getByLabel('Current password').fill('this is not my password')
      await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
      await page.getByLabel('New password again').fill(NEW_PASSWORD)
      await page.getByRole('button', { name: 'Change password' }).click()
      await page.locator('[data-field="current_password"] .field-error').filter({ hasText: 'That is not your current password' }).waitFor()
      await shot('15b-account-error-1360')
      await page.getByLabel('Current password').fill(PASSWORD)
      await page.getByLabel('New password', { exact: true }).fill('passwordpassword')
      await page.getByLabel('New password again').fill('passwordpassword')
      await page.getByRole('button', { name: 'Change password' }).click()
      await page.locator('[data-field="new_password"] .field-error').filter({ hasText: /\S/ }).waitFor()
      console.log(`        server said: "${await page.locator('[data-field="new_password"] .field-error').textContent()}"`)
      await page.setViewportSize({ width: 1360, height: 900 })
    })

    await step('change password succeeds and the new CSRF token keeps working', async () => {
      await page.getByLabel('Current password').fill(PASSWORD)
      await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
      await page.getByLabel('New password again').fill(NEW_PASSWORD)
      await page.getByRole('button', { name: 'Change password' }).click()
      await status().filter({ hasText: 'Password changed.' }).waitFor()
      await go(`#/orders/${idC}`, orderC.ref)
      await page.getByLabel('Internal notes').fill('Saved after the password change')
      await expectStatus(() => page.getByRole('button', { name: 'Save notes' }).click(), 'Notes saved.')
    })

    await step('a stale CSRF token (403 csrf_invalid) is refreshed from /me and the request retried once', async () => {
      let first = true
      await page.route(`**/api/admin/orders/${idC}/notes`, (route) => {
        if (!first) return route.continue()
        first = false
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'csrf_invalid', message: 'Security token missing or wrong.' } }) })
      })
      await page.getByLabel('Internal notes').fill('Saved after a token refresh')
      await expectStatus(() => page.getByRole('button', { name: 'Save notes' }).click(), 'Notes saved.')
      await page.unroute(`**/api/admin/orders/${idC}/notes`)
      assert.equal((await api(`/api/admin/orders/${idC}`)).order.admin_notes, 'Saved after a token refresh')
    })

    // ---- session end ----------------------------------------------------------
    await step('a session that disappears mid-use returns to sign-in and then back to where the user was', async () => {
      await go('#/orders', 'Orders')
      await context.clearCookies()
      await nav('Products').click()
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
      await page.locator('#signin-notice').waitFor()
      assert.match(page.url(), /#\/signin\?next=%2Fproducts&reason=expired$/)
      assert.ok(await page.locator('#topbar').isHidden())
      await shot('17-session-expired-1360')
      await signIn(NEW_PASSWORD)
      await h1().filter({ hasText: 'Products' }).waitFor()
      await page.locator('tbody tr').first().waitFor()
    })

    await step('a session that expires during a save returns to sign-in', async () => {
      await go(`#/orders/${idC}`, orderC.ref)
      await context.clearCookies()
      await page.getByRole('button', { name: 'Mark out for delivery' }).click()
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
      assert.ok(decodeURIComponent(page.url()).includes(`next=/orders/${idC}`))
      await signIn(NEW_PASSWORD)
      await h1().filter({ hasText: orderC.ref }).waitFor()
      assert.equal((await api(`/api/admin/orders/${idC}`)).order.status, 'preparing', 'nothing was changed while signed out')
    })

    await step('sign out, then an admin page redirects to sign-in', async () => {
      await page.getByRole('button', { name: 'Sign out' }).first().click()
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
      await status().filter({ hasText: 'You have signed out.' }).waitFor()
      assert.equal((await page.request.get(`${BASE}/api/admin/me`)).status(), 401)
      await page.goto('about:blank')
      await page.goto(`${admin}#/products`)
      await h1().filter({ hasText: 'Sign in to admin' }).waitFor()
      assert.match(page.url(), /#\/signin\?next=%2Fproducts$/)
      await page.setViewportSize({ width: 390, height: 844 })
      await noPageScroll('sign-in at 390')
      await shot('01-sign-in-390')
      await page.setViewportSize({ width: 1360, height: 900 })
    })

    await step('no console errors or CSP violations anywhere in the run', async () => {
      assert.deepEqual(consoleErrors, [])
      assert.deepEqual(cspViolations, [])
      // The only failed requests are the ones these tests provoked on purpose.
      const unexpected = failedResources.filter(line => !/status of (401|403|409|415|422|429)/.test(line))
      assert.deepEqual(unexpected, [])
    })
  } finally {
    if (browser) await browser.close()
    server.kill()
    if (results.some(r => !r.ok) && serverLog.trim()) console.log(`\nServer log:\n${serverLog.slice(-3000)}`)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
