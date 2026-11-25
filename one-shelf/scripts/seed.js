'use strict'
// npm run seed  -  safe to run as often as you like.

const { loadConfig, ConfigError } = require('../src/config')
const { openDb } = require('../src/db')
const { createStorage } = require('../src/storage')
const { seed } = require('../src/seed')

async function main () {
  // The seed never starts a payment, so the production/demo guard is not relevant here.
  const config = loadConfig({ ...process.env, ALLOW_DEMO_IN_PRODUCTION: process.env.ALLOW_DEMO_IN_PRODUCTION || 'yes' })
  const db = openDb(config.dbPath)
  const repo = { catalog: require('../src/repo/catalog')(db) }
  const storage = createStorage(config.uploadsDir)
  const result = await seed({ db, repo, storage })
  db.close()
  console.log(`Seed complete (${config.dbPath}).`)
  console.log(`  added: ${result.roasters} roasters, ${result.products} coffees, ${result.zones} delivery zones, ${result.images} roaster photos`)
  if (!result.roasters && !result.products && !result.zones && !result.images) console.log('  nothing was missing; existing data left untouched')
  console.log('  Note: these coffees, prices and stock levels are illustrative placeholders.')
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
})
