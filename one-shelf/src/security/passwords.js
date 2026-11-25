'use strict'
// scrypt password hashing with a per-user random salt and constant-time verify.
// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>

const crypto = require('node:crypto')
const { promisify } = require('node:util')
const scrypt = promisify(crypto.scrypt)

const PARAMS = { N: 32768, r: 8, p: 1 }
const KEY_LENGTH = 64
const MAX_MEM = 128 * 1024 * 1024
const MIN_LENGTH = 12
const MAX_LENGTH = 200

// A small built-in list; all lower case, compared case-insensitively.
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'password123456', 'passwordpassword', '123456789012', '1234567890123',
  '12345678901234', '123456123456', '111111111111', '000000000000', 'qwertyuiop12', 'qwertyuiop123',
  'qwertyuiopas', 'qwerty123456', 'qwertyqwerty', 'iloveyou1234', 'letmein12345', 'letmeinplease',
  'adminadmin12', 'adminadminadmin', 'administrator', 'administrator1', 'welcome12345', 'welcome123456',
  'changeme1234', 'changemeplease', 'correcthorsebatterystaple', 'abcdefghijkl', 'abcdefghijklm',
  'abc123abc123', 'monkey123456', 'dragon123456', 'football1234', 'liverpool1234', 'arsenal12345',
  'chelsea12345', 'london123456', 'coffeecoffee', 'coffee123456', 'oneshelf1234', 'oneshelfadmin',
  'trustno1trustno1', 'sunshine1234', 'princess1234', 'superman1234', 'baseball1234', 'p@ssw0rd1234',
  'passw0rd1234', 'password!234', 'asdfghjkl123', 'zxcvbnm12345', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  'qazwsxedcrfv', 'aaaaaaaaaaaa'
])

/** @returns {string|null} a message when the password is not acceptable, otherwise null */
function passwordProblem (password, email) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`
  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Choose something harder to guess.'
  if (/^(.)\1+$/.test(password)) return 'That password is too easy to guess.'
  if (email && lower === String(email).toLowerCase()) return 'Do not use your email address as your password.'
  return null
}

async function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM })
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

async function verifyPassword (password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$')
    if (scheme !== 'scrypt') return false
    const expected = Buffer.from(hashB64, 'base64')
    const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: MAX_MEM })
    return key.length === expected.length && crypto.timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

// Verified against when the email is unknown, so both paths take the same time.
let dummyHash = null
async function verifyDummy (password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(18).toString('base64'))
  await verifyPassword(password, dummyHash)
  return false
}

module.exports = { hashPassword, verifyPassword, verifyDummy, passwordProblem, MIN_LENGTH, MAX_LENGTH }
