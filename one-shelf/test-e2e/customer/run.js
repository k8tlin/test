#!/usr/bin/env node
'use strict';
/*
 * Browser tests for the customer site, at 1360 and 390 wide.
 *
 *   node test-e2e/customer/run.js              starts its own server on a free port with a throwaway data folder
 *   BASE_URL=http://localhost:4310 node ...    uses a server that is already running (raise its rate limits first)
 *   ONLY=checkout node ...                     runs only the tests whose name contains "checkout"
 *
 * Uses the globally installed Playwright (nothing is installed by this script).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execSync, spawnSync } = require('node:child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) {
    const root = execSync('npm root -g').toString().trim();
    return require(path.join(root, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(__dirname, 'shots');
const WIDTHS = [1360, 390];
const ONLY = process.env.ONLY || '';
let BASE = process.env.BASE_URL || '';
let server = null, dataDir = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer() {
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-e2e-'));
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', LOG_LEVEL: 'warn',
    RATE_LIMIT_GLOBAL_MAX: '100000', RATE_LIMIT_CHECKOUT_MAX: '1000', RATE_LIMIT_SUBSCRIBE_MAX: '1000' };
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/seed.js'], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('Seed failed: ' + seed.stderr + seed.stdout);
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  BASE = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 125));
  }
  throw new Error('Server did not start:\n' + log);
}

function stopServer() {
  if (server) server.kill();
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

/* ---------- helpers ---------- */
const problems = []; // console errors and CSP violations, across every page opened
async function newPage(browser, width, label) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => { window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '')); });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !page.__expectErrors) problems.push('[' + label + ' ' + width + '] console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('[' + label + ' ' + width + '] pageerror: ' + e.message));
  page.__label = label; page.__width = width;
  return page;
}
async function done(page) {
  const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
  for (const v of csp) problems.push('[' + page.__label + ' ' + page.__width + '] CSP: ' + v);
  await page.context().close();
}
async function home(page, qs = '') {
  await page.goto(BASE + '/' + qs);
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard, #grid-wrap[aria-busy="false"] .state');
}
async function settled(page) { await page.waitForSelector('#grid-wrap[aria-busy="false"]:not(.is-swapping)'); await page.waitForTimeout(60); }
async function noOverflow(page, what) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 0, what + ': page scrolls sideways by ' + over + 'px at ' + page.__width);
}
async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name + '-' + page.__width + '.png') }); }
const names = (page) => page.$$eval('.pcard .pname', (els) => els.map((e) => e.textContent));
const count = (page) => page.$eval('#basket-count', (e) => Number(e.textContent));
async function openFilters(page) {
  if (await page.$eval('#f-groups', (e) => e.hidden)) await page.click('#f-toggle');
}
async function addFromCard(page, name) {
  const card = page.locator('.pcard', { has: page.locator('.pname', { hasText: name }) });
  await card.locator('button[data-act="add"]').click();
  return card;
}
async function apiJson(pathname, body) {
  const r = await fetch(BASE + pathname, body ? { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) } : undefined);
  return r.json();
}
const money = (p) => '£' + (p / 100).toFixed(2);

/* ---------- tests ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('home loads cleanly: no console errors, no CSP violations, fonts and fish present', async (browser, w) => {
  const page = await newPage(browser, w, 'home');
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
  await home(page);
  assert.equal((await names(page)).length, 24, 'all 24 coffees are listed');
  assert.equal(await page.textContent('.demo-banner'), 'Demo mode: no real payments are taken.');
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.fonts.check('40px "Instrument Serif"') && document.fonts.check('900 16px Doto')), 'self-hosted fonts loaded');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.hero-title')).fontFamily.includes('Instrument Serif')), true);
  await page.waitForFunction(() => { const c = document.getElementById('koi'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 0) return true; return false; });
  assert.deepEqual(failed, [], 'no failed requests');
  await noOverflow(page, 'home');
  await shot(page, '01-home-top');
  // walk the page so every section has been seen, then check the lower sections rendered
  for (const id of ['how', 'steps', 'roasters', 'faq', 'ml-form']) { await page.locator('#' + id).scrollIntoViewIfNeeded(); await page.waitForTimeout(250); }
  assert.equal(await page.locator('.rcard').count(), 12);
  assert.ok((await page.locator('#cradle path').count()) >= 10, 'cherries drawn');
  await noOverflow(page, 'home after scroll');
  await page.locator('#how').scrollIntoViewIfNeeded(); await page.waitForTimeout(700); await shot(page, '07-label-section');
  await page.locator('#roasters').scrollIntoViewIfNeeded(); await page.waitForTimeout(700); await shot(page, '08-roasters');
  await page.locator('#ml-form').scrollIntoViewIfNeeded(); await page.waitForTimeout(900); await shot(page, '09-closing');
  await done(page);
});

test('postcode search re-sorts the shelf and shows distances', async (browser, w) => {
  const page = await newPage(browser, w, 'postcode');
  await home(page);
  const before = await names(page);
  // a bad postcode gets a specific message next to the field
  await page.fill('#pc-input', 'M1 1AA');
  page.__expectErrors = true; // the 422 from the API is logged by the browser as a failed request
  await page.click('#pc-submit');
  await page.waitForSelector('#pc-input[aria-invalid="true"]');
  assert.match(await page.textContent('#pc-input-error'), /Enter a London postcode, e\.g\. E8 4PH/);
  assert.equal(await page.inputValue('#pc-input'), 'M1 1AA', 'keeps what was typed');
  page.__expectErrors = false;
  await page.fill('#pc-input', 'e8 4ph');
  await page.click('#pc-submit');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('postcode') === 'E8');
  await page.waitForSelector('.pcard .ptag');
  await settled(page);
  const after = await names(page);
  assert.notDeepEqual(after, before, 'order changed');
  assert.equal(await page.textContent('.pcard:first-child .proaster'), 'Climpson & Sons');
  const metas = await page.$$eval('.pcard .pmeta', (els) => els.map((e) => e.textContent));
  assert.ok(metas.every((m) => /(under 1 mi|about \d+\.\d mi)$/.test(m)), 'every card shows a distance: ' + metas[0]);
  const miles = metas.map((m) => (/under/.test(m) ? 0.5 : parseFloat(/about ([\d.]+)/.exec(m)[1])));
  assert.deepEqual(miles, miles.slice().sort((a, b) => a - b), 'nearest first');
  assert.equal(await page.locator('.pcard .ptag', { hasText: 'Nearest' }).count(), 2);
  assert.match(await page.textContent('#pc-status'), /Nearest to E8: Climpson & Sons, under a mile away/);
  assert.equal(await page.textContent('#pc-chip-code'), 'E8');
  assert.equal(await page.inputValue('#mk-sort'), 'near');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('os.postcode')).district), 'E8');
  await page.waitForTimeout(700);
  await shot(page, '02-grid-postcode');
  // remembered on a fresh visit without the query string
  await home(page);
  assert.equal(await page.textContent('.pcard:first-child .proaster'), 'Climpson & Sons');
  assert.match(page.url(), /postcode=E8/);
  await done(page);
});

test('filter + search + sort change the grid and the URL; reload and back restore them', async (browser, w) => {
  const page = await newPage(browser, w, 'filters');
  await home(page);
  await openFilters(page);
  await page.locator('.frow', { hasText: 'Light' }).first().click();
  await settled(page);
  const light = await names(page);
  assert.ok(light.length > 0 && light.length < 24);
  await page.fill('#mk-q', 'washed');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'washed');
  await settled(page);
  await page.selectOption('#mk-sort', 'price_desc');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'price_desc');
  await settled(page);
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('roast'), 'light');
  const shown = await names(page);
  const expected = (await apiJson('/api/products?roast=light&q=washed&sort=price_desc')).products.map((p) => p.name);
  assert.deepEqual(shown, expected, 'grid matches the API for the same query');
  assert.ok(shown.length < light.length);
  const prices = await page.$$eval('.pcard .pprice', (els) => els.map((e) => parseFloat(e.textContent.replace('£', ''))));
  assert.deepEqual(prices, prices.slice().sort((a, b) => b - a), 'price high to low');
  assert.equal(await page.locator('#chips .chipx').count(), 2);
  assert.match(await page.textContent('#r-count'), new RegExp('^' + shown.length + ' coffee'));
  await shot(page, '03-grid-filtered');

  await page.reload();
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard');
  assert.deepEqual(await names(page), expected, 'reload restores the grid');
  assert.equal(await page.inputValue('#mk-q'), 'washed');
  assert.equal(await page.inputValue('#mk-sort'), 'price_desc');
  await openFilters(page);
  assert.equal(await page.locator('.frow[aria-pressed="true"]', { hasText: 'Light' }).count(), 1);

  // remove a chip, then the back button brings it back
  await page.locator('#chips .chipx', { hasText: 'Light roast' }).click();
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('roast'));
  await settled(page);
  assert.ok((await names(page)).length > expected.length);
  await page.goBack();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('roast') === 'light');
  await settled(page);
  assert.deepEqual(await names(page), expected, 'back button restores the filter');

  // nothing matches: offers Clear filters
  await page.fill('#mk-q', 'zzzz-no-such-coffee');
  await page.waitForSelector('#grid-wrap .state button');
  assert.match(await page.textContent('#grid-wrap .state'), /No coffees match/);
  await page.click('#grid-wrap .state button');
  await page.waitForFunction(() => location.search === '' || !/q=|roast=/.test(location.search));
  await settled(page);
  assert.equal((await names(page)).length, 24);

  if (w >= 940) {
    // hiding the filter column gives the grid the full width and shows "Filters +"
    const before = await page.$eval('#pgrid', (e) => e.getBoundingClientRect().width);
    await page.click('#f-toggle');
    assert.equal(await page.isVisible('#filters'), false);
    assert.equal(await page.isVisible('#f-open'), true);
    assert.ok((await page.$eval('#pgrid', (e) => e.getBoundingClientRect().width)) > before + 200);
    await page.click('#f-open');
    assert.equal(await page.isVisible('#filters'), true);
  } else {
    assert.equal(await page.$eval('#pgrid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length), 2, 'two columns on a phone');
  }

  // a roaster card filters the shelf and scrolls to it
  await page.locator('.rcard', { hasText: 'Monmouth' }).scrollIntoViewIfNeeded();
  await page.locator('.rcard', { hasText: 'Monmouth' }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('roaster') === 'monmouth');
  await settled(page);
  assert.deepEqual(await page.$$eval('.pcard .proaster', (els) => Array.from(new Set(els.map((e) => e.textContent)))), ['Monmouth']);
  await noOverflow(page, 'filters');
  await done(page);
});

test('card add, add again, remove: persistent stepper and correct header count', async (browser, w) => {
  const page = await newPage(browser, w, 'stepper');
  await home(page);
  assert.equal(await count(page), 0);
  const card = await addFromCard(page, 'Guji Natural');
  const stepper = card.locator('.stepper');
  await stepper.waitFor();
  assert.match(await stepper.textContent(), /−\s*✓\s*1 added\s*\+/);
  assert.equal(await count(page), 1);
  assert.equal(await stepper.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(42, 59, 232)', 'cobalt stepper');
  await stepper.locator('button[data-act="more"]').click();
  assert.match(await stepper.textContent(), /2 added/);
  assert.equal(await count(page), 2);
  await page.waitForTimeout(1800);
  assert.match(await card.locator('.stepper').textContent(), /2 added/, 'the stepper stays, it does not time out');
  assert.match(await page.textContent('#live-region'), /Basket: 2 items/);
  const box = await card.locator('.stepper button[data-act="less"]').boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44, '44px targets');
  await shot(page, '04-card-stepper');
  await card.locator('button[data-act="less"]').click();
  assert.match(await card.locator('.stepper').textContent(), /1 added/);
  assert.equal(await count(page), 1);
  await card.locator('button[data-act="less"]').click();
  await card.locator('button[data-act="add"]').waitFor();
  assert.equal(await card.locator('.stepper').count(), 0, 'back to Add at zero');
  assert.equal(await count(page), 0);
  // capped at 12
  await card.locator('button[data-act="add"]').click();
  for (let i = 0; i < 11; i++) await card.locator('button[data-act="more"]').click();
  assert.match(await card.locator('.stepper').textContent(), /12 added/);
  assert.equal(await card.locator('button[data-act="more"]').isDisabled(), true, 'capped at 12');
  assert.equal(await count(page), 12);
  // after a refresh the basket is kept but the card shows Add again
  await page.reload();
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard');
  assert.equal(await count(page), 12);
  assert.equal(await page.locator('.stepper').count(), 0);
  await done(page);
});

test('basket drawer: server prices, quantity controls, problems, survives a reload', async (browser, w) => {
  const page = await newPage(browser, w, 'basket');
  await home(page);
  await addFromCard(page, 'Guji Natural');
  const c2 = await addFromCard(page, 'Boquete Geisha');
  await c2.locator('button[data-act="more"]').click();
  const quote = await apiJson('/api/basket/quote', { items: [{ product_id: 'guji-natural', quantity: 1 }, { product_id: 'boquete-geisha', quantity: 2 }], fulfilment: 'delivery' });
  await page.click('#basket-btn');
  await page.waitForSelector('#basket-drawer[open] .bline');
  assert.equal(await page.getAttribute('#basket-drawer', 'aria-modal'), 'true');
  assert.equal(await page.getAttribute('#basket-drawer', 'role'), 'dialog');
  assert.equal(await page.locator('.bline').count(), 2);
  const text = await page.textContent('#basket-drawer');
  for (const l of quote.lines) assert.ok(text.includes(money(l.line_total_pence)), 'line total from server ' + money(l.line_total_pence));
  assert.ok(text.includes(money(quote.subtotal_pence)), 'subtotal from server');
  assert.ok(text.includes(money(quote.total_pence)), 'total from server');
  // mixed roasters: collection refused with the reason
  assert.equal(await page.locator('#basket-drawer input[value="collect"]').isDisabled(), true);
  assert.match(text, /only possible when everything in your basket comes from one roastery/);
  await page.waitForTimeout(400);
  await shot(page, '05-basket');
  // focus is trapped inside the dialog
  for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement.closest('#basket-drawer') !== null), 'focus stays in the drawer'); }
  // quantity up, then remove a line
  await page.locator('.bline', { hasText: 'Guji Natural' }).locator('button', { hasText: '+' }).click();
  await page.waitForFunction(() => document.querySelector('#basket-count').textContent === '4');
  await page.waitForFunction(() => /2 × |each/.test(document.querySelector('.bline').textContent) || true);
  await page.locator('.bline', { hasText: 'Boquete Geisha' }).getByRole('button', { name: /^Remove Boquete/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.bline').length === 1);
  assert.equal(await count(page), 2);
  // single roaster now: collection is offered
  await page.waitForSelector('#basket-drawer input[value="collect"]:not([disabled])');
  // survives a reload
  await page.reload();
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard');
  assert.equal(await count(page), 2);
  await page.click('#basket-btn');
  await page.waitForSelector('#basket-drawer[open] .bline');
  assert.match(await page.textContent('.bline'), /Guji Natural/);
  assert.ok((await page.textContent('#basket-drawer')).includes(money(2 * quote.lines.find((l) => l.product_id === 'guji-natural').unit_price_pence)));
  // Escape closes and focus returns to the opener
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#basket-drawer').open);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'basket-btn');
  // a line the server no longer sells is removed with an explanation
  await page.evaluate(() => { const b = JSON.parse(localStorage.getItem('os.basket.v1')); b.push({ product_id: 'no-such-coffee', quantity: 1, grind: 'Whole bean' }); localStorage.setItem('os.basket.v1', JSON.stringify(b)); });
  await page.reload();
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard');
  await page.click('#basket-btn');
  await page.waitForSelector('#basket-drawer .notice--warn');
  assert.match(await page.textContent('#basket-drawer .notice--warn'), /no longer available and was removed/);
  assert.equal(await count(page), 2);
  // empty state links back to the shop
  await page.locator('.bline').getByRole('button', { name: /^Remove Guji/ }).click();
  await page.waitForSelector('#basket-drawer .state a[href="/#market"]');
  assert.match(await page.textContent('#basket-drawer .state'), /basket is empty/);
  await done(page);
});

test('keyboard only: tab to a product, open it, Escape closes and focus returns; deep link works', async (browser, w) => {
  const page = await newPage(browser, w, 'keyboard');
  await home(page);
  await page.focus('#mk-sort');
  let guard = 0;
  while (!(await page.evaluate(() => document.activeElement.classList.contains('pimg'))) && guard++ < 12) await page.keyboard.press('Tab');
  const slug = await page.evaluate(() => document.activeElement.dataset.open);
  assert.ok(slug, 'reached a product with the Tab key');
  const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor; });
  assert.equal(outline, 'solid 2px rgb(42, 59, 232)', 'visible cobalt focus ring');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#product-dialog[open] #product-title');
  assert.equal(new URL(page.url()).searchParams.get('product'), slug);
  assert.equal(await page.getAttribute('#product-dialog', 'aria-modal'), 'true');
  assert.ok(await page.evaluate(() => document.activeElement.closest('#product-dialog') !== null), 'focus moved into the dialog');
  for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement.closest('#product-dialog') !== null), 'focus trapped'); }
  await page.waitForTimeout(400);
  await shot(page, '06-product-dialog');
  await noOverflow(page, 'product dialog');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#product-dialog').open);
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('product'));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.open), slug, 'focus returned to the product');

  // deep link, choose a grind and quantity, add to basket
  await page.goto(BASE + '/?product=nyeri-aa');
  await page.waitForSelector('#product-dialog[open] .sheet-buy');
  assert.equal(await page.textContent('#product-title'), 'Nyeri AA');
  assert.equal(await page.locator('#product-dialog .bar').count(), 6);
  await page.locator('#product-dialog .pill', { hasText: 'Filter' }).click();
  await page.click('#product-dialog [aria-label="Increase quantity"]');
  await page.click('#product-add');
  await page.waitForSelector('#basket-drawer[open] .bline');
  assert.match(await page.textContent('.bline'), /Nyeri AA.*Filter/s);
  assert.equal(await count(page), 2);
  assert.equal(new URL(page.url()).searchParams.has('product'), false);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('os.basket.v1'))), [{ product_id: 'nyeri-aa', quantity: 2, grind: 'Filter' }]);

  // unknown product: friendly state, not a blank dialog
  page.__expectErrors = true;
  await page.goto(BASE + '/?product=not-a-coffee');
  await page.waitForSelector('#product-dialog[open] .state');
  assert.match(await page.textContent('#product-dialog'), /not on the shelf any more/);
  await done(page);
});

async function fillCheckout(page) {
  await page.fill('#co-name', 'Ada Lovelace');
  await page.fill('#co-email', 'ada@example.com');
  await page.fill('#co-phone', '020 7946 0958');
}

test('checkout with delivery through the demo payment page to a paid order page', async (browser, w) => {
  const page = await newPage(browser, w, 'checkout');
  await home(page);
  await addFromCard(page, 'Guji Natural');
  await addFromCard(page, 'Nyeri AA');
  await page.click('#basket-btn');
  await page.waitForSelector('#basket-drawer[open] a[href="/checkout.html"]');
  await page.click('#basket-drawer a[href="/checkout.html"]');
  await page.waitForSelector('#co-form');
  await page.waitForSelector('#co-summary .sum-line');
  // mixed basket: collection refused, with the reason shown
  assert.equal(await page.locator('#co-way-collect').isDisabled(), true);
  assert.match(await page.textContent('#co-way-note'), /Collection is only possible when everything in your basket comes from one roastery/);
  assert.equal(await page.locator('#co-way-delivery').isChecked(), true);
  assert.equal(await page.isVisible('#co-address'), true);
  assert.match(await page.textContent('#co-demo'), /no money is taken/i);
  await fillCheckout(page);
  await page.fill('#co-line1', '1 Mare Street');
  await page.fill('#co-city', 'London');
  await page.fill('#co-postcode', 'E8 4RP');
  await page.fill('#co-notes', 'Leave with the neighbour at number 3');
  await page.locator('#co-postcode').blur();
  const quote = await apiJson('/api/basket/quote', { items: [{ product_id: 'guji-natural', quantity: 1 }, { product_id: 'nyeri-aa', quantity: 1 }], fulfilment: 'delivery', postcode: 'E8 4RP' });
  await page.waitForFunction((t) => document.querySelector('#co-total') && document.querySelector('#co-total').textContent === t, money(quote.total_pence));
  assert.ok((await page.textContent('#co-summary')).includes(money(quote.delivery_fee_pence)));
  await page.check('#co-terms');
  await noOverflow(page, 'checkout');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '10-checkout-' + w + '.png'), fullPage: true });
  // the button shows a loading state and cannot be pressed twice
  let posts = 0;
  await page.route('**/api/checkout', async (route) => { posts++; await new Promise((r) => setTimeout(r, 500)); route.continue(); });
  await page.click('#co-pay');
  await page.waitForSelector('#co-pay.is-loading');
  assert.equal(await page.textContent('#co-pay'), 'Placing order…');
  assert.equal(await page.locator('#co-pay').isDisabled(), true);
  await page.locator('#co-pay').click({ force: true, timeout: 1000 }).catch(() => {});
  await page.waitForURL(/\/pay\/demo\/OS-/);
  assert.equal(posts, 1, 'only one checkout request');
  assert.match(await page.textContent('body'), /no money is taken/i);
  await page.click('button.pay');
  await page.waitForURL(/\/order\.html\?ref=OS-/);
  await page.waitForSelector('#order-status[data-status="paid"]');
  assert.match(await page.textContent('#order-title'), /confirmed/);
  assert.match(await page.textContent('#order-ref'), /^OS-/);
  assert.equal(await page.textContent('#order-total'), money(quote.total_pence));
  const body = await page.textContent('#order-root');
  assert.match(body, /1 Mare Street/);
  assert.match(body, /Out for delivery/);
  assert.match(body, /Leave with the neighbour/);
  assert.equal(await count(page), 0, 'basket cleared once paid');
  assert.equal(await page.evaluate(() => localStorage.getItem('os.basket.v1')), '[]');
  await noOverflow(page, 'order');
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '11-order-' + w + '.png'), fullPage: true });
  await done(page);
});

test('checkout: collection for a single-roaster basket; failed payment keeps the basket', async (browser, w) => {
  const page = await newPage(browser, w, 'collect');
  await home(page);
  await addFromCard(page, 'Guji Natural');
  await addFromCard(page, 'Cauca Washed');
  await page.goto(BASE + '/checkout.html');
  await page.waitForSelector('#co-summary .sum-line');
  assert.equal(await page.locator('#co-way-collect').isDisabled(), false, 'collection offered');
  assert.equal(await page.locator('#co-way-collect').isChecked(), true);
  assert.match(await page.textContent('.way.is-on'), /Climpson & Sons/);
  assert.equal(await page.isVisible('#co-address'), false, 'no address needed to collect');
  assert.match(await page.textContent('#co-summary'), /Collection\s*Free/);
  // switching to delivery reveals the address and adds the fee from the server
  await page.check('#co-way-delivery', { force: true });
  await page.waitForSelector('#co-address:not([hidden])');
  await page.waitForFunction(() => /Delivery/.test(document.querySelector('#co-summary .totals').textContent));
  await page.check('#co-way-collect', { force: true });
  await page.waitForFunction(() => document.querySelector('#co-address').hidden);
  await fillCheckout(page);
  await page.check('#co-terms');
  await page.click('#co-pay');
  await page.waitForURL(/\/pay\/demo\/OS-/);
  await page.click('button.fail');
  await page.waitForURL(/\/order\.html\?ref=OS-/);
  await page.waitForSelector('#order-status[data-status="cancelled"]');
  assert.match(await page.textContent('#order-root'), /You have not been charged/);
  assert.equal(await count(page), 2, 'basket kept after a failed payment');
  // try again and pay: collection next steps
  await page.click('a[href="/checkout.html"]');
  await page.waitForSelector('#co-summary .sum-line');
  assert.equal(await page.inputValue('#co-name'), 'Ada Lovelace', 'details kept');
  await page.check('#co-terms');
  await page.click('#co-pay');
  await page.waitForURL(/\/pay\/demo\/OS-/);
  await page.click('button.pay');
  await page.waitForSelector('#order-status[data-status="paid"]');
  const body = await page.textContent('#order-root');
  assert.match(body, /Ready to collect/);
  assert.match(body, /Climpson & Sons/);
  assert.match(body, /Mon to Fri 9am to 4pm/);
  assert.equal(await count(page), 0);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '12-order-collect-' + w + '.png'), fullPage: true });
  await done(page);
});

test('checkout with invalid fields shows field errors and a linked summary; 422 and 409 from the server are handled', async (browser, w) => {
  const page = await newPage(browser, w, 'invalid');
  await home(page);
  await addFromCard(page, 'Guji Natural');
  await addFromCard(page, 'Nyeri AA');
  await page.goto(BASE + '/checkout.html');
  await page.waitForSelector('#co-summary .sum-line');
  // on blur, not per keystroke
  await page.fill('#co-email', 'not-an-email');
  assert.equal(await page.getAttribute('#co-email', 'aria-invalid'), null, 'no error while typing');
  await page.locator('#co-email').blur();
  assert.equal(await page.getAttribute('#co-email', 'aria-invalid'), 'true');
  assert.match(await page.textContent('#co-email-error'), /name@example\.com/);
  assert.ok((await page.getAttribute('#co-email', 'aria-describedby')).includes('co-email-error'));
  // on submit
  let posts = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/checkout')) posts++; });
  await page.click('#co-pay');
  await page.waitForSelector('#co-error-summary');
  assert.equal(posts, 0, 'nothing sent while fields are invalid');
  const ids = ['co-name', 'co-email', 'co-phone', 'co-line1', 'co-city', 'co-postcode', 'co-terms'];
  for (const id of ids) {
    assert.equal(await page.getAttribute('#' + id, 'aria-invalid'), 'true', id + ' marked invalid');
    assert.ok((await page.textContent('#' + id + '-error')).length > 5, id + ' has a message beside it');
    assert.equal(await page.locator('#co-error-summary a[href="#' + id + '"]').count(), 1, 'summary links to ' + id);
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), 'co-error-summary');
  assert.equal(await page.inputValue('#co-email'), 'not-an-email', 'keeps what was typed');
  assert.equal(await page.getAttribute('#co-email', 'autocomplete'), 'email');
  assert.equal(await page.getAttribute('#co-phone', 'inputmode'), 'tel');
  assert.equal(await page.getAttribute('#co-postcode', 'autocomplete'), 'postal-code');
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, '13-checkout-errors-' + w + '.png'), fullPage: true });
  await page.click('#co-error-summary a[href="#co-phone"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'co-phone');
  await noOverflow(page, 'checkout errors');

  // server-side 422: messages land beside the fields
  await fillCheckout(page);
  await page.fill('#co-line1', '1 Mare Street'); await page.fill('#co-city', 'London'); await page.fill('#co-postcode', 'E8 4RP');
  await page.locator('#co-postcode').blur();
  await page.check('#co-terms');
  await page.waitForSelector('#co-pay:not([disabled])');
  page.__expectErrors = true;
  await page.route('**/api/checkout', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation_error', message: 'Please check the highlighted fields.', fields: { 'customer.phone': 'Enter a valid phone number', 'address.postcode': 'We do not deliver to that postcode' } } }) }));
  await page.click('#co-pay');
  await page.waitForSelector('#co-error-summary');
  assert.equal(await page.textContent('#co-phone-error'), 'Enter a valid phone number');
  assert.equal(await page.textContent('#co-postcode-error'), 'We do not deliver to that postcode');
  assert.equal(await page.locator('#co-error-summary a').count(), 2);
  assert.equal(await page.textContent('#co-pay'), 'Place order and pay', 'button is usable again');
  await page.unroute('**/api/checkout');

  // 409 basket_changed: explains what changed and refreshes the quote
  await page.fill('#co-phone', '020 7946 0958');
  let quotes = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/basket/quote')) quotes++; });
  await page.route('**/api/checkout', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'basket_changed', message: 'Some items in your basket have changed. Please review it.', fields: { 'items.guji-natural': 'Only 1 of Guji Natural left.' } } }) }));
  await page.click('#co-pay');
  await page.waitForSelector('#co-notice .notice');
  const note = await page.textContent('#co-notice');
  assert.match(note, /have changed/);
  assert.match(note, /Only 1 of Guji Natural left/);
  assert.ok(quotes >= 1, 'quote refreshed');
  await page.unroute('**/api/checkout');

  // network failure: a retry-able message, never a blank area
  await page.route('**/api/checkout', (route) => route.abort());
  await page.click('#co-pay');
  await page.waitForFunction(() => /could not reach the shop/.test(document.querySelector('#co-notice').textContent));
  assert.equal(await page.locator('#co-pay').isDisabled(), false);
  await page.unroute('**/api/checkout');

  // empty basket
  await page.evaluate(() => localStorage.removeItem('os.basket.v1'));
  await page.goto(BASE + '/checkout.html');
  await page.waitForSelector('#co-root .state a[href="/#market"]');
  assert.match(await page.textContent('#co-root'), /basket is empty/);
  await done(page);
});

test('mailing list: consent wording from the API, consent required, neutral success; newsletter notices', async (browser, w) => {
  const page = await newPage(browser, w, 'mailing');
  await home(page);
  const consent = (await apiJson('/api/subscribe/consent-text')).consent_text;
  await page.locator('#ml-form').scrollIntoViewIfNeeded();
  await page.waitForFunction((t) => document.querySelector('#ml-consent-text').textContent === t, consent);
  assert.equal(await page.isChecked('#ml-consent'), false, 'consent starts unticked');
  let posts = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/subscribe')) posts++; });
  await page.fill('#ml-email', 'reader' + w + '@example.com');
  await page.click('#ml-submit');
  await page.waitForSelector('#ml-consent[aria-invalid="true"]');
  assert.match(await page.textContent('#ml-consent-error'), /Tick the box/);
  assert.equal(posts, 0, 'nothing sent without consent');
  await page.fill('#ml-email', 'nope');
  await page.click('#ml-submit');
  assert.equal(await page.getAttribute('#ml-email', 'aria-invalid'), 'true');
  await page.fill('#ml-email', 'reader' + w + '@example.com');
  await page.check('#ml-consent');
  await page.click('#ml-submit');
  await page.waitForFunction(() => document.querySelector('#ml-status').textContent.length > 0);
  assert.equal(await page.textContent('#ml-status'), 'Thanks. Check your inbox for a link to confirm your subscription.');
  assert.equal(posts, 1);
  for (const [kind, re] of [['confirmed', /on the list/], ['unsubscribed', /unsubscribed/], ['invalid', /did not work/]]) {
    await home(page, '?newsletter=' + kind);
    assert.match(await page.textContent('#flash .notice'), re);
    assert.equal(new URL(page.url()).searchParams.has('newsletter'), false);
    await page.click('#flash .notice button');
    assert.equal(await page.locator('#flash .notice').count(), 0, 'dismissible');
  }
  await done(page);
});

test('order not-found state, static placeholder pages, failed network shows a retry', async (browser, w) => {
  const page = await newPage(browser, w, 'pages');
  page.__expectErrors = true;
  await page.goto(BASE + '/order.html?ref=OS-NOPE123&token=wrong');
  await page.waitForSelector('#order-root[aria-busy="false"]');
  assert.match(await page.textContent('#order-root'), /could not find that order/);
  await noOverflow(page, 'order not found');
  await page.goto(BASE + '/order.html');
  await page.waitForSelector('#order-root[aria-busy="false"]');
  assert.match(await page.textContent('#order-root'), /could not find that order/);
  page.__expectErrors = false;
  for (const p of ['privacy', 'terms', 'delivery-returns', 'contact']) {
    await page.goto(BASE + '/' + p + '.html');
    assert.match(await page.textContent('main'), /This page needs to be written and reviewed by the business owner and a lawyer before launch/);
    assert.ok((await page.locator('main h2').count()) >= 4);
    await page.waitForSelector('.demo-banner');
    await noOverflow(page, p);
  }
  await shot(page, '14-placeholder-page');
  assert.equal(await page.locator('.site-footer a[href="/privacy.html"], .site-footer a[href="/terms.html"], .site-footer a[href="/delivery-returns.html"], .site-footer a[href="/contact.html"]').count(), 4);
  // catalogue request fails: retry button, then recovery
  page.__expectErrors = true;
  let fail = true;
  await page.route('**/api/products**', (route) => (fail ? route.abort() : route.continue()));
  await page.goto(BASE + '/');
  await page.waitForSelector('#grid-wrap .state button');
  assert.match(await page.textContent('#grid-wrap'), /could not reach the shop/);
  fail = false;
  await page.click('#grid-wrap .state button');
  await page.waitForSelector('#grid-wrap[aria-busy="false"] .pcard');
  page.__expectErrors = false;
  await done(page);
});

test('reduced motion: fish draw one still frame and nothing animates', async (browser, w) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.__label = 'reduced'; page.__width = w;
  await home(page);
  await page.waitForFunction(() => { const c = document.getElementById('koi'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 0) return true; return false; });
  const snap = () => page.evaluate(() => document.getElementById('koi').toDataURL().length + ':' + document.getElementById('koi').toDataURL().slice(-200));
  const a = await snap(); await page.waitForTimeout(500); const b = await snap();
  assert.equal(a, b, 'canvas is still');
  assert.equal(await page.$eval('#marq', (e) => getComputedStyle(e).animationName), 'none');
  assert.equal(await page.isVisible('#motion-btn'), false);
  await ctx.close();
});

/* ---------- runner ---------- */
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!BASE) await startServer();
  const browser = await chromium.launch();
  let failed = 0, passed = 0;
  for (const w of WIDTHS) {
    for (const t of tests) {
      if (ONLY && !t.name.includes(ONLY)) continue;
      const started = Date.now();
      try {
        await t.fn(browser, w);
        passed++;
        console.log('  ok   [' + w + '] ' + t.name + ' (' + (Date.now() - started) + 'ms)');
      } catch (err) {
        failed++;
        console.log('  FAIL [' + w + '] ' + t.name + '\n       ' + String(err && err.stack || err).split('\n').slice(0, 6).join('\n       '));
        for (const c of browser.contexts()) await c.close().catch(() => {});
      }
    }
  }
  await browser.close();
  stopServer();
  if (problems.length) {
    failed++;
    console.log('  FAIL console errors / CSP violations:\n       ' + Array.from(new Set(problems)).join('\n       '));
  } else console.log('  ok   zero console errors and zero CSP violations across all pages');
  console.log('\n' + passed + ' passed, ' + failed + ' failed. Screenshots: ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); stopServer(); process.exit(1); });
