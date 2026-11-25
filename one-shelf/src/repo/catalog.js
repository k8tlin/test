'use strict'
// Roasters, products and delivery zones. Fixed SQL, bound parameters only.

const { nowIso } = require('../db')

const PRODUCT_SELECT = `
  SELECT p.*, r.slug AS roaster_slug, r.name AS roaster_name, r.area AS roaster_area,
         r.postcode AS roaster_postcode, r.lat AS roaster_lat, r.lon AS roaster_lon,
         r.bag_color AS roaster_bag_color, r.label_color AS roaster_label_color,
         r.label_ink AS roaster_label_ink, r.image_path AS roaster_image_path,
         r.collection_enabled AS roaster_collection_enabled,
         r.collection_hours AS roaster_collection_hours, r.active AS roaster_active
  FROM products p JOIN roasters r ON r.id = p.roaster_id`

function parseProduct (row) {
  if (!row) return null
  let notes = []
  let flavour = {}
  try { notes = JSON.parse(row.notes) } catch { /* keep default */ }
  try { flavour = JSON.parse(row.flavour) } catch { /* keep default */ }
  return { ...row, notes, flavour }
}

module.exports = function catalogRepo (db) {
  return {
    // ---- roasters -------------------------------------------------------
    listActiveRoasters () {
      return db.all('SELECT * FROM roasters WHERE active = 1 ORDER BY name')
    },
    listAllRoasters () {
      return db.all(`
        SELECT r.*, (SELECT COUNT(*) FROM products p WHERE p.roaster_id = r.id AND p.status = 'active') AS active_products
        FROM roasters r ORDER BY r.name`)
    },
    getRoaster (id) {
      return db.get('SELECT * FROM roasters WHERE id = :id', { id }) || null
    },
    getRoasterBySlug (slug) {
      return db.get('SELECT * FROM roasters WHERE slug = :slug', { slug }) || null
    },
    insertRoaster (r) {
      const res = db.run(`
        INSERT INTO roasters (slug, name, area, postcode, lat, lon, description, bag_color, label_color, label_ink,
                              image_path, collection_enabled, collection_hours, active, version)
        VALUES (:slug, :name, :area, :postcode, :lat, :lon, :description, :bag_color, :label_color, :label_ink,
                :image_path, :collection_enabled, :collection_hours, :active, 1)`, {
        slug: r.slug,
        name: r.name,
        area: r.area,
        postcode: r.postcode,
        lat: r.lat,
        lon: r.lon,
        description: r.description,
        bag_color: r.bag_color,
        label_color: r.label_color,
        label_ink: r.label_ink,
        image_path: r.image_path ?? null,
        collection_enabled: r.collection_enabled ? 1 : 0,
        collection_hours: r.collection_hours,
        active: r.active ? 1 : 0
      })
      return res.lastInsertRowid
    },
    /** Full-row update guarded by the optimistic-lock version. Returns true when a row changed. */
    updateRoaster (id, version, r) {
      return db.run(`
        UPDATE roasters SET slug = :slug, name = :name, area = :area, postcode = :postcode, lat = :lat, lon = :lon,
               description = :description, bag_color = :bag_color, label_color = :label_color, label_ink = :label_ink,
               image_path = :image_path, collection_enabled = :collection_enabled,
               collection_hours = :collection_hours, active = :active, version = version + 1
        WHERE id = :id AND version = :version`, {
        id,
        version,
        slug: r.slug,
        name: r.name,
        area: r.area,
        postcode: r.postcode,
        lat: r.lat,
        lon: r.lon,
        description: r.description,
        bag_color: r.bag_color,
        label_color: r.label_color,
        label_ink: r.label_ink,
        image_path: r.image_path ?? null,
        collection_enabled: r.collection_enabled ? 1 : 0,
        collection_hours: r.collection_hours,
        active: r.active ? 1 : 0
      }).changes === 1
    },

    // ---- products -------------------------------------------------------
    /**
     * Public listing: active products of active roasters, filtered in SQL.
     * Every filter is a nullable bound parameter; `sort` is matched against
     * fixed CASE branches, so no part of the statement is built from input.
     */
    listPublicProducts (f) {
      return db.all(PRODUCT_SELECT + `
        WHERE p.status = 'active' AND r.active = 1
          AND (:roaster IS NULL OR r.slug = :roaster)
          AND (:roast_min IS NULL OR p.roast_level >= :roast_min)
          AND (:roast_max IS NULL OR p.roast_level <= :roast_max)
          AND (:brew IS NULL OR p.brew = :brew OR p.brew = 'both')
          AND (:max_price IS NULL OR p.price_pence <= :max_price)
          AND (:q IS NULL
               OR p.name LIKE :q ESCAPE '\\' OR p.origin_country LIKE :q ESCAPE '\\'
               OR p.origin_region LIKE :q ESCAPE '\\' OR p.process LIKE :q ESCAPE '\\'
               OR p.varietal LIKE :q ESCAPE '\\' OR p.notes LIKE :q ESCAPE '\\'
               OR r.name LIKE :q ESCAPE '\\' OR r.area LIKE :q ESCAPE '\\')
        ORDER BY
          CASE :sort WHEN 'price_asc' THEN p.price_pence END ASC,
          CASE :sort WHEN 'price_desc' THEN p.price_pence END DESC,
          p.roast_level ASC, p.name ASC`, {
        roaster: f.roaster ?? null,
        roast_min: f.roast_min ?? null,
        roast_max: f.roast_max ?? null,
        brew: f.brew ?? null,
        max_price: f.max_price ?? null,
        q: f.q ?? null,
        sort: f.sort ?? 'roast'
      }).map(parseProduct)
    },
    getPublicProductBySlug (slug) {
      return parseProduct(db.get(PRODUCT_SELECT + `
        WHERE p.slug = :slug AND p.status = 'active' AND r.active = 1`, { slug }))
    },
    /** Any status; used by basket/checkout to explain why a line is unavailable. */
    getProductBySlug (slug) {
      return parseProduct(db.get(PRODUCT_SELECT + ' WHERE p.slug = :slug', { slug }))
    },
    getProduct (id) {
      return parseProduct(db.get(PRODUCT_SELECT + ' WHERE p.id = :id', { id }))
    },
    listAdminProducts (f) {
      return db.all(PRODUCT_SELECT + `
        WHERE (:status IS NULL OR p.status = :status)
          AND (:roaster_id IS NULL OR p.roaster_id = :roaster_id)
          AND (:q IS NULL OR p.name LIKE :q ESCAPE '\\' OR p.slug LIKE :q ESCAPE '\\' OR r.name LIKE :q ESCAPE '\\')
        ORDER BY r.name, p.name`, {
        status: f.status ?? null,
        roaster_id: f.roaster_id ?? null,
        q: f.q ?? null
      }).map(parseProduct)
    },
    slugTaken (slug, exceptId) {
      return !!db.get('SELECT 1 AS x FROM products WHERE slug = :slug AND id <> :except', { slug, except: exceptId ?? -1 })
    },
    roasterSlugTaken (slug, exceptId) {
      return !!db.get('SELECT 1 AS x FROM roasters WHERE slug = :slug AND id <> :except', { slug, except: exceptId ?? -1 })
    },
    insertProduct (p) {
      const now = nowIso()
      return db.run(`
        INSERT INTO products (roaster_id, slug, name, origin_country, origin_region, process, varietal, altitude_m,
                              roast_level, brew, notes, flavour, weight_g, price_pence, stock, image_path, tint,
                              status, version, created_at, updated_at)
        VALUES (:roaster_id, :slug, :name, :origin_country, :origin_region, :process, :varietal, :altitude_m,
                :roast_level, :brew, :notes, :flavour, :weight_g, :price_pence, :stock, :image_path, :tint,
                :status, 1, :now, :now)`, {
        roaster_id: p.roaster_id,
        slug: p.slug,
        name: p.name,
        origin_country: p.origin_country,
        origin_region: p.origin_region,
        process: p.process,
        varietal: p.varietal,
        altitude_m: p.altitude_m ?? null,
        roast_level: p.roast_level,
        brew: p.brew,
        notes: JSON.stringify(p.notes),
        flavour: JSON.stringify(p.flavour),
        weight_g: p.weight_g,
        price_pence: p.price_pence,
        stock: p.stock,
        image_path: p.image_path ?? null,
        tint: p.tint,
        status: p.status,
        now
      }).lastInsertRowid
    },
    updateProduct (id, version, p) {
      return db.run(`
        UPDATE products SET roaster_id = :roaster_id, slug = :slug, name = :name, origin_country = :origin_country,
               origin_region = :origin_region, process = :process, varietal = :varietal, altitude_m = :altitude_m,
               roast_level = :roast_level, brew = :brew, notes = :notes, flavour = :flavour, weight_g = :weight_g,
               price_pence = :price_pence, stock = :stock, image_path = :image_path, tint = :tint, status = :status,
               version = version + 1, updated_at = :now
        WHERE id = :id AND version = :version`, {
        id,
        version,
        roaster_id: p.roaster_id,
        slug: p.slug,
        name: p.name,
        origin_country: p.origin_country,
        origin_region: p.origin_region,
        process: p.process,
        varietal: p.varietal,
        altitude_m: p.altitude_m ?? null,
        roast_level: p.roast_level,
        brew: p.brew,
        notes: JSON.stringify(p.notes),
        flavour: JSON.stringify(p.flavour),
        weight_g: p.weight_g,
        price_pence: p.price_pence,
        stock: p.stock,
        image_path: p.image_path ?? null,
        tint: p.tint,
        status: p.status,
        now: nowIso()
      }).changes === 1
    },
    /** The oversell guard: only succeeds while enough stock remains. */
    decrementStock (productId, quantity) {
      return db.run('UPDATE products SET stock = stock - :qty WHERE id = :id AND stock >= :qty',
        { id: productId, qty: quantity }).changes === 1
    },
    restoreStock (productId, quantity) {
      db.run('UPDATE products SET stock = stock + :qty WHERE id = :id', { id: productId, qty: quantity })
    },
    listLowStock (threshold) {
      return db.all(`
        SELECT p.id, p.slug, p.name, p.stock, r.name AS roaster_name
        FROM products p JOIN roasters r ON r.id = p.roaster_id
        WHERE p.status = 'active' AND p.stock <= :threshold ORDER BY p.stock, p.name`, { threshold })
    },

    // ---- delivery zones -------------------------------------------------
    listZones () {
      return db.all('SELECT * FROM delivery_zones ORDER BY postcode_prefix')
    },
    getZone (prefix) {
      return db.get('SELECT * FROM delivery_zones WHERE postcode_prefix = :prefix', { prefix }) || null
    },
    upsertZone (prefix, feePence, active) {
      db.run(`
        INSERT INTO delivery_zones (postcode_prefix, fee_pence, active) VALUES (:prefix, :fee, :active)
        ON CONFLICT (postcode_prefix) DO UPDATE SET fee_pence = excluded.fee_pence, active = excluded.active`,
      { prefix, fee: feePence, active: active ? 1 : 0 })
    },
    insertZoneIfMissing (prefix, feePence) {
      db.run('INSERT OR IGNORE INTO delivery_zones (postcode_prefix, fee_pence, active) VALUES (:prefix, :fee, 1)',
        { prefix, fee: feePence })
    },
    standardDeliveryFee () {
      const row = db.get('SELECT MIN(fee_pence) AS fee FROM delivery_zones WHERE active = 1')
      return row && row.fee !== null ? row.fee : null
    }
  }
}
