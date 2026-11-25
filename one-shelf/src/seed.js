'use strict'
// Idempotent seed: inserts the placeholder roasters, coffees and delivery
// zones if they are missing and never overwrites rows that already exist
// (so admin edits survive a re-run).

const fs = require('node:fs')
const path = require('node:path')
const data = require('./seed-data.json')

const ASSETS = path.join(__dirname, '..', 'seed-assets', 'roasters')

/**
 * @param {{ db, repo, storage }} deps
 * @param {{ images?: boolean }} [options]  images=false skips copying roaster photos (faster tests)
 */
async function seed ({ db, repo, storage }, options = {}) {
  const withImages = options.images !== false
  const result = { roasters: 0, products: 0, zones: 0, images: 0 }

  // Images are re-encoded through the same pipeline as admin uploads. That is
  // asynchronous, so it happens before the (synchronous) transaction.
  const images = {}
  if (withImages) {
    for (const r of data.roasters) {
      const existing = repo.catalog.getRoasterBySlug(r.slug)
      if (existing && existing.image_path && storage.exists(existing.image_path)) continue
      const file = path.join(ASSETS, `${r.ref}.jpg`)
      if (!fs.existsSync(file)) continue
      images[r.slug] = await storage.saveImage(fs.readFileSync(file))
      result.images++
    }
  }

  db.tx(() => {
    const roasterIds = {}
    for (const r of data.roasters) {
      let row = repo.catalog.getRoasterBySlug(r.slug)
      if (!row) {
        const id = repo.catalog.insertRoaster({ ...r, image_path: images[r.slug] || null, active: true })
        row = repo.catalog.getRoaster(id)
        result.roasters++
      } else if (images[r.slug]) {
        repo.catalog.updateRoaster(row.id, row.version, { ...row, image_path: images[r.slug] })
      }
      roasterIds[r.ref] = row.id
    }
    for (const p of data.products) {
      if (repo.catalog.getProductBySlug(p.slug)) continue
      repo.catalog.insertProduct({ ...p, roaster_id: roasterIds[p.roaster_ref], image_path: null, status: 'active' })
      result.products++
    }
    for (const z of data.delivery_zones) {
      if (repo.catalog.getZone(z.postcode_prefix)) continue
      repo.catalog.insertZoneIfMissing(z.postcode_prefix, z.fee_pence)
      result.zones++
    }
  })
  return result
}

module.exports = { seed }
