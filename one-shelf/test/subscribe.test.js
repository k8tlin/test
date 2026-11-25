'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { Writable } = require('node:stream')
const { makeApp, loginAdmin, ORIGIN } = require('./helpers/app')
const { sha256 } = require('../src/security/tokens')

let app
const lines = []
before(async () => {
  const logStream = new Writable({ write (chunk, enc, cb) { lines.push(chunk.toString()); cb() } })
  app = await makeApp({ logLevel: 'info' }, { logStream })
})
after(async () => { await app.close() })

const subscribe = (payload, a = app) => a.inject({ method: 'POST', url: '/api/subscribe', headers: { origin: ORIGIN }, payload })
const lastToken = () => {
  const line = [...lines].reverse().find(l => l.includes('Confirmation link'))
  return /confirm\?token=([A-Za-z0-9_-]+)/.exec(line)[1]
}

test('consent text is served and stored verbatim with time and source', async () => {
  const consent = (await app.inject({ method: 'GET', url: '/api/subscribe/consent-text' })).json()
  assert.ok(consent.consent_text.length > 20)
  const res = await subscribe({ email: '  Reader@Example.COM ', consent: true })
  assert.equal(res.statusCode, 202)
  const row = app.repo.subscribers.get('reader@example.com')
  assert.equal(row.status, 'pending')
  assert.equal(row.consent_text, consent.consent_text)
  assert.match(row.consent_source, /^web:footer:/)
  assert.ok(Date.now() - Date.parse(row.consent_at) < 5000)
  assert.equal(row.confirm_token_hash, sha256(lastToken()), 'only the hash of the token is stored')
})

test('consent must be exactly true', async () => {
  for (const consent of [false, 'true', 1, undefined]) {
    const res = await subscribe({ email: 'noconsent@example.com', consent })
    assert.equal(res.statusCode, 422)
    assert.ok(res.json().error.fields.consent)
  }
  assert.equal(app.repo.subscribers.get('noconsent@example.com'), null)
})

test('the response is identical whether or not the email is already known', async () => {
  const first = await subscribe({ email: 'same@example.com', consent: true })
  const second = await subscribe({ email: 'same@example.com', consent: true })
  await app.inject({ method: 'GET', url: `/api/subscribe/confirm?token=${lastToken()}` })
  assert.equal(app.repo.subscribers.get('same@example.com').status, 'confirmed')
  const third = await subscribe({ email: 'same@example.com', consent: true })
  assert.equal(app.repo.subscribers.get('same@example.com').status, 'confirmed', 're-subscribing does not un-confirm')
  for (const res of [second, third]) {
    assert.equal(res.statusCode, first.statusCode)
    assert.equal(res.body, first.body)
  }
})

test('confirm and unsubscribe links work by GET, are idempotent and reject bad tokens', async () => {
  await subscribe({ email: 'links@example.com', consent: true })
  const token = lastToken()
  const json = { accept: 'application/json' }
  const bad = await app.inject({ method: 'GET', url: `/api/subscribe/confirm?token=${'z'.repeat(43)}`, headers: json })
  assert.equal(bad.statusCode, 404)

  const viaBrowser = await app.inject({ method: 'GET', url: `/api/subscribe/confirm?token=${token}`, headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(viaBrowser.statusCode, 303)
  assert.equal(viaBrowser.headers.location, '/?newsletter=confirmed')
  assert.equal(app.repo.subscribers.get('links@example.com').status, 'confirmed')
  const again = await app.inject({ method: 'GET', url: `/api/subscribe/confirm?token=${token}`, headers: json })
  assert.deepEqual(again.json(), { ok: true, status: 'confirmed' })

  const unsub = await app.inject({ method: 'GET', url: `/api/unsubscribe?token=${token}`, headers: json })
  assert.deepEqual(unsub.json(), { ok: true, status: 'unsubscribed' })
  const row = app.repo.subscribers.get('links@example.com')
  assert.equal(row.status, 'unsubscribed')
  assert.ok(row.unsubscribed_at)
  assert.equal((await app.inject({ method: 'GET', url: `/api/subscribe/confirm?token=${token}`, headers: json })).statusCode, 404, 'an old link cannot re-subscribe')
  assert.equal((await app.inject({ method: 'GET', url: '/api/unsubscribe', headers: json })).statusCode, 404)

  // Signing up again asks for fresh consent and a fresh confirmation.
  await subscribe({ email: 'links@example.com', consent: true })
  assert.equal(app.repo.subscribers.get('links@example.com').status, 'pending')
  assert.equal(app.repo.subscribers.get('links@example.com').unsubscribed_at, null)
})

test('subscribe is rate limited per IP', async () => {
  const limited = await makeApp({ rateLimit: { subscribeMax: 5 } })
  try {
    for (let i = 0; i < 5; i++) assert.equal((await subscribe({ email: `r${i}@example.com`, consent: true }, limited)).statusCode, 202)
    const res = await subscribe({ email: 'r6@example.com', consent: true }, limited)
    assert.equal(res.statusCode, 429)
    assert.equal(limited.repo.subscribers.get('r6@example.com'), null)
  } finally {
    await limited.close()
  }
})

test('admin can list subscribers and export a CSV that is safe to open in a spreadsheet', async () => {
  const admin = await loginAdmin(app)
  await subscribe({ email: '=cmd@example.com', consent: true })
  const list = (await admin.get('/api/admin/subscribers?status=pending')).json()
  assert.ok(list.total >= 2)
  assert.ok(list.subscribers.every(s => s.status === 'pending' && !('confirm_token_hash' in s)))
  const csv = await admin.get('/api/admin/subscribers.csv')
  assert.equal(csv.statusCode, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  assert.match(csv.headers['content-disposition'], /attachment/)
  const rows = csv.body.trim().split('\r\n')
  assert.equal(rows[0], 'email,status,consent_at,consent_source,consent_text,unsubscribed_at')
  assert.ok(rows.some(r => r.startsWith('"reader@example.com","pending"')))
  assert.ok(rows.some(r => r.startsWith('"\'=cmd@example.com"')), 'formula-looking cells are neutralised')
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/subscribers.csv' })).statusCode, 401)
})
