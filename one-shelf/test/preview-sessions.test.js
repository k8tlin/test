'use strict'
// Preview deployments run several copies of the server, each with its own database.
// A sign-in on one copy must be recognised by another, and only when the preview key is set.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp } = require('../src/server')
const { hashPassword } = require('../src/security/passwords')

const EMAIL = 'owner@example.test'
const PASSWORD = 'correct horse battery staple 42'
const KEY = 'k'.repeat(64)

async function copy (extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-preview-'))
  const app = await buildApp({ env: { NODE_ENV: 'test', DATA_DIR: dir, ...extraEnv } })
  app.repo.admin.insertAdmin(EMAIL, await hashPassword(PASSWORD))
  await app.ready()
  return app
}
const cookieOf = (res) => res.cookies.map(c => `${c.name}=${c.value}`).join('; ')
const login = (app) => app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: EMAIL, password: PASSWORD } })

test('preview: a session from one copy works on another, including CSRF', async (t) => {
  const env = { PREVIEW_SESSION_KEY: KEY, PREVIEW_ADMIN_EMAIL: EMAIL }
  const a = await copy(env); const b = await copy(env)
  t.after(() => Promise.all([a.close(), b.close()]))
  const res = await login(a)
  assert.strictEqual(res.statusCode, 200)
  const cookie = cookieOf(res)
  const me = await b.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })
  assert.strictEqual(me.statusCode, 200)
  const csrf = res.json().csrf_token
  const out = await b.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie, 'x-csrf-token': csrf } })
  assert.ok(out.statusCode < 300, `logout on the other copy returned ${out.statusCode}`)
})

test('preview: a tampered or expired cookie is refused', async (t) => {
  const env = { PREVIEW_SESSION_KEY: KEY, PREVIEW_ADMIN_EMAIL: EMAIL }
  const a = await copy(env); const b = await copy(env)
  t.after(() => Promise.all([a.close(), b.close()]))
  const res = await login(a)
  const c = res.cookies[0]
  const [random, expiry, sig] = c.value.split('.')
  for (const bad of [`${random}.${Number(expiry) + 1}.${sig}`, `${random}x.${expiry}.${sig}`, `${random}.${expiry}.${sig.slice(0, -1)}A`, `${random}.1000000000000.${sig}`]) {
    const me = await b.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie: `${c.name}=${bad}` } })
    assert.strictEqual(me.statusCode, 401, bad)
  }
})

test('without the preview key, a session from another copy is not accepted', async (t) => {
  const a = await copy({ PREVIEW_SESSION_KEY: KEY, PREVIEW_ADMIN_EMAIL: EMAIL }); const b = await copy()
  t.after(() => Promise.all([a.close(), b.close()]))
  const res = await login(a)
  const me = await b.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie: cookieOf(res) } })
  assert.strictEqual(me.statusCode, 401)
})
