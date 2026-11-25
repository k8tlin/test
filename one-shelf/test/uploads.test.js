'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const sharp = require('sharp')
const { makeApp, loginAdmin, multipart, ORIGIN } = require('./helpers/app')

let app
let admin
let productId
before(async () => {
  app = await makeApp()
  admin = await loginAdmin(app)
  productId = app.repo.catalog.getProductBySlug('guji-natural').id
})
after(async () => { await app.close() })

function upload (url, filename, type, buffer, headers = admin.headers) {
  const body = multipart('image', filename, type, buffer)
  return app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': body.contentType }, payload: body.payload })
}
const png = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: '#2A3BE8' } }).png().toBuffer()
const filesOnDisk = () => fs.readdirSync(app.config.uploadsDir)

test('upload rejects an SVG, even when it is labelled as a PNG', async () => {
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')
  for (const [name, type] of [['logo.svg', 'image/svg+xml'], ['logo.png', 'image/png']]) {
    const res = await upload(`/api/admin/products/${productId}/image`, name, type, svg)
    assert.equal(res.statusCode, 415, name)
    assert.equal(res.json().error.code, 'unsupported_image')
  }
  assert.equal(filesOnDisk().length, 0)
})

test('upload rejects a text file renamed .jpg, and other non-images with image headers', async () => {
  const text = Buffer.from('This is definitely not a photograph. '.repeat(20))
  const res = await upload(`/api/admin/products/${productId}/image`, 'photo.jpg', 'image/jpeg', text)
  assert.equal(res.statusCode, 415)
  assert.equal(res.json().error.code, 'unsupported_image')
  // Right magic bytes, rubbish afterwards: sharp cannot decode it.
  const fakeJpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('<?php echo 1; ?>'.repeat(50))])
  assert.equal((await upload(`/api/admin/products/${productId}/image`, 'x.jpg', 'image/jpeg', fakeJpeg)).statusCode, 415)
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1')
  assert.equal((await upload(`/api/admin/products/${productId}/image`, 'x.gif', 'image/gif', gif)).statusCode, 415)
  assert.equal(filesOnDisk().length, 0)
  assert.equal(app.repo.catalog.getProduct(productId).image_path, null)
})

test('upload needs an admin session, a CSRF token and a same-site origin', async () => {
  const image = await png()
  assert.equal((await upload(`/api/admin/products/${productId}/image`, 'a.png', 'image/png', image, { origin: ORIGIN })).statusCode, 401)
  assert.equal((await upload(`/api/admin/products/${productId}/image`, 'a.png', 'image/png', image, { cookie: admin.cookie, origin: ORIGIN })).statusCode, 403)
  assert.equal((await upload(`/api/admin/products/${productId}/image`, 'a.png', 'image/png', image, { ...admin.headers, origin: 'https://evil.example' })).statusCode, 403)
  assert.equal(filesOnDisk().length, 0)
})

test('a real image is re-encoded to WebP (max 1600px), given a random name and served safely', async () => {
  const res = await upload(`/api/admin/products/${productId}/image`, '../../evil name.PNG', 'image/png', await png(3200, 800))
  assert.equal(res.statusCode, 200, res.body)
  const url = res.json().product.image_url
  assert.match(url, /^\/media\/[a-f0-9]{32}\.webp$/)
  assert.deepEqual(filesOnDisk(), [url.slice('/media/'.length)], 'stored under data/uploads with the server-chosen name')

  const served = await app.inject({ method: 'GET', url })
  assert.equal(served.statusCode, 200)
  assert.equal(served.headers['content-type'], 'image/webp')
  assert.equal(served.headers['x-content-type-options'], 'nosniff')
  const meta = await sharp(served.rawPayload).metadata()
  assert.equal(meta.format, 'webp')
  assert.equal(meta.width, 1600)
  assert.equal(meta.height, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/products/guji-natural' })).json().product.image_url, url)

  // Replacing the image removes the old file; JPEG and WebP are accepted too.
  const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).jpeg().toBuffer()
  const second = await upload(`/api/admin/products/${productId}/image`, 'b.jpg', 'image/jpeg', jpeg)
  assert.equal(second.statusCode, 200)
  assert.notEqual(second.json().product.image_url, url)
  assert.equal(filesOnDisk().length, 1)
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404)

  const roasterId = app.repo.catalog.getRoasterBySlug('nude').id
  const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'green' } }).webp().toBuffer()
  const r = await upload(`/api/admin/roasters/${roasterId}/image`, 'c.webp', 'image/webp', webp)
  assert.equal(r.statusCode, 200)
  assert.match(r.json().roaster.image_url, /^\/media\/[a-f0-9]{32}\.webp$/)
  const audit = (await admin.get(`/api/admin/audit?entity=product&entity_id=${productId}`)).json().entries
  assert.equal(audit[0].action, 'product.image_changed')
})

test('uploads over 5 MB are refused', async () => {
  const before = filesOnDisk().length
  const big = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024 + 10)])
  const res = await upload(`/api/admin/products/${productId}/image`, 'big.png', 'image/png', big)
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error.code, 'file_too_large')
  assert.equal(filesOnDisk().length, before)
})

test('/media only serves names matching the strict pattern', async () => {
  for (const name of ['..%2f..%2fone-shelf.sqlite', '..%2Fone-shelf.sqlite', 'one-shelf.sqlite', 'abc.webp', 'A'.repeat(32) + '.webp',
    'a'.repeat(32) + '.svg', 'a'.repeat(32) + '.webp.html', '.env']) {
    const res = await app.inject({ method: 'GET', url: `/media/${name}` })
    assert.equal(res.statusCode, 404, name)
  }
  assert.equal((await app.inject({ method: 'GET', url: `/media/${'a'.repeat(32)}.webp` })).statusCode, 404, 'well-formed but unknown')
})

test('uploads are not reachable through the static roots', async () => {
  const name = filesOnDisk()[0]
  for (const url of [`/uploads/${name}`, `/data/uploads/${name}`, `/admin/../data/uploads/${name}`, '/data/one-shelf.sqlite', '/..%2fdata/one-shelf.sqlite']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url)
  }
})
