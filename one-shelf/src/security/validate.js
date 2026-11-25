'use strict'
// zod helpers. Every body, query and params object goes through parse();
// z.object() strips unknown keys by default.

const { z } = require('zod')
const { AppError } = require('./errors')

/** Parse or throw a 422 with per-field messages keyed by dotted path. */
function parse (schema, data, where = 'body') {
  const result = schema.safeParse(data ?? {})
  if (result.success) return result.data
  const fields = {}
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_'
    if (!fields[key]) fields[key] = issue.message
  }
  throw new AppError(422, 'validation_error',
    where === 'body' ? 'Please check the highlighted fields.' : 'The request is not valid.', fields)
}

// Reusable field schemas -----------------------------------------------------

// Rejects control characters so stored text is always printable.
const text = (max, label = 'This field') => z.string({ error: `${label} is required` }).trim()
  .max(max, `${label} must be at most ${max} characters`)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/, `${label} contains characters that are not allowed`)
const requiredText = (max, label) => text(max, label).min(1, `${label} is required`)
const singleLine = (max, label) => requiredText(max, label).regex(/^[^\r\n]*$/, `${label} must be a single line`)

const email = z.string({ error: 'Enter an email address' }).trim().toLowerCase()
  .min(3, 'Enter an email address').max(254, 'That email address is too long')
  .regex(/^[^\s@<>()[\],;:\\"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    'Enter a valid email address, like name@example.com')

const phone = z.string({ error: 'Enter a phone number' }).trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
  .refine(v => v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number')

// Full UK postcode, e.g. "E8 4PH" (space optional, any case).
const UK_POSTCODE = /^([A-Z]{1,2}[0-9][A-Z0-9]?) ?([0-9][A-Z]{2})$/
// Outward code only, e.g. "E8", "N1C", "SW1A".
const UK_OUTWARD = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/

const fullPostcode = z.string({ error: 'Enter a postcode' }).trim().toUpperCase().max(10, 'Enter a full UK postcode, like E8 4PH')
  .regex(UK_POSTCODE, 'Enter a full UK postcode, like E8 4PH')
  .transform(v => { const m = UK_POSTCODE.exec(v); return `${m[1]} ${m[2]}` })

// Full postcode or just the first half; used for browsing and quotes.
const loosePostcode = z.string({ error: 'Enter a postcode' }).trim().toUpperCase().max(10, 'Enter a UK postcode, like E8 or E8 4PH')
  .refine(v => UK_POSTCODE.test(v) || UK_OUTWARD.test(v.replace(/\s+/g, '')), 'Enter a UK postcode, like E8 or E8 4PH')

const slug = z.string({ error: 'Required' }).trim().toLowerCase().min(1, 'Required').max(80, 'Too long')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only')

const id = z.coerce.number({ error: 'Invalid id' }).int('Invalid id').min(1, 'Invalid id').max(Number.MAX_SAFE_INTEGER)
const idParams = z.object({ id })
const version = z.coerce.number({ error: 'version is required' }).int().min(1)
const pence = (max = 1000000) => z.number({ error: 'Enter an amount in pence' }).int('Must be a whole number of pence')
  .min(0, 'Cannot be negative').max(max, 'Too large')
const hexColor = z.string({ error: 'Enter a colour like #2A3BE8' }).trim().regex(/^#[0-9a-fA-F]{6}$/, 'Enter a colour like #2A3BE8')
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0)
}
const empty = z.object({})

/** Turn free text into a LIKE pattern with %, _ and \ escaped. */
function likePattern (value) {
  if (!value) return null
  return '%' + value.replace(/[\\%_]/g, c => '\\' + c) + '%'
}

function slugify (value) {
  return String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

module.exports = {
  z, parse, text, requiredText, singleLine, email, phone, fullPostcode, loosePostcode, slug, id, idParams,
  version, pence, hexColor, page, empty, likePattern, slugify, UK_POSTCODE, UK_OUTWARD
}
