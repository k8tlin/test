'use strict'
// Image storage behind a small interface so it can later be swapped for
// object storage (S3, R2...) without touching the routes:
//
//   storage.saveImage(buffer) -> Promise<string name>   validates + re-encodes
//   storage.read(name)        -> Promise<Buffer|null>
//   storage.remove(name)      -> Promise<void>
//   storage.exists(name)      -> boolean
//
// Files live in DATA_DIR/uploads, which is outside the static web roots, and
// are only ever served through GET /media/:name.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const sharp = require('sharp')
const { AppError } = require('./security/errors')

const NAME_PATTERN = /^[a-f0-9]{32}\.webp$/
const MAX_DIMENSION = 1600
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp'])

/** Look at the first bytes of the file, not at its name or declared type. */
function sniffImageType (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png'
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

const badImage = () => new AppError(415, 'unsupported_image',
  'That file is not an image we can use. Upload a JPEG, PNG or WebP photo.')

function createStorage (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const resolve = (name) => {
    if (!NAME_PATTERN.test(name)) return null
    return path.join(dir, name)
  }

  return {
    dir,
    NAME_PATTERN,

    async saveImage (buffer) {
      const sniffed = sniffImageType(buffer)
      if (!sniffed) throw badImage()
      let output
      try {
        // sharp decodes the pixels and writes a brand-new WebP, which drops
        // metadata and anything else hidden in the original file.
        const image = sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000, animated: false })
        const meta = await image.metadata()
        if (!ALLOWED_FORMATS.has(meta.format) || meta.format !== sniffed) throw badImage()
        output = await image.rotate()
          .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer()
      } catch (err) {
        if (err instanceof AppError) throw err
        throw badImage()
      }
      const name = crypto.randomBytes(16).toString('hex') + '.webp'
      await fsp.writeFile(path.join(dir, name), output, { flag: 'wx', mode: 0o644 })
      return name
    },

    async read (name) {
      const file = resolve(name)
      if (!file) return null
      try {
        return await fsp.readFile(file)
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },

    exists (name) {
      const file = resolve(name)
      return !!file && fs.existsSync(file)
    },

    async remove (name) {
      const file = resolve(name)
      if (!file) return
      await fsp.rm(file, { force: true })
    }
  }
}

module.exports = { createStorage, sniffImageType, NAME_PATTERN }
