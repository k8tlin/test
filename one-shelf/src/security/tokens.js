'use strict'
const crypto = require('node:crypto')

/** 32 random bytes, URL-safe. Used for session ids, order access tokens, email-link tokens. */
const randomToken = () => crypto.randomBytes(32).toString('base64url')
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

/** Constant-time comparison of two strings (compares SHA-256 digests so lengths never leak). */
function safeEqual (a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest()
  const db = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(da, db)
}

// No 0/O, 1/I/L, 5/S, 2/Z, 8/B, U or V: easy to read aloud and retype.
const REF_ALPHABET = '34679ACDEFGHJKMNPQRTWXY'
function randomOrderRef () {
  let out = ''
  for (let i = 0; i < 7; i++) out += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]
  return 'OS-' + out
}
const ORDER_REF_PATTERN = /^OS-[34679ACDEFGHJKMNPQRTWXY]{7}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/

module.exports = { randomToken, sha256, safeEqual, randomOrderRef, ORDER_REF_PATTERN, TOKEN_PATTERN }
