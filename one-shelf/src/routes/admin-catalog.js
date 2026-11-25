'use strict'
// Admin: products, roasters, delivery zones and image uploads.
// Every change is written to the audit log with before/after snapshots.

const v = require('../security/validate')
const { z, parse } = v
const { AppError, notFound } = require('../security/errors')
const views = require('../domain/views')

const stale = (what) => new AppError(409, 'stale_version', `This ${what} was changed by someone else. Reload it and try again.`)
const score = z.number({ error: 'Enter a whole number from 0 to 10' }).int('Enter a whole number from 0 to 10').min(0, 'Minimum is 0').max(10, 'Maximum is 10')
const bool = z.boolean({ error: 'Must be true or false' })

const productShape = {
  roaster_id: z.number({ error: 'Choose a roaster' }).int().min(1),
  name: v.singleLine(100, 'Name'),
  slug: v.slug,
  origin_country: v.singleLine(60, 'Country'),
  origin_region: v.text(80, 'Region'),
  process: v.text(60, 'Process'),
  varietal: v.text(80, 'Varietal'),
  altitude_m: z.number({ error: 'Enter metres as a whole number' }).int('Enter metres as a whole number').min(0).max(6000, 'Altitude looks too high').nullable(),
  roast_level: z.number({ error: 'Choose a roast level from 1 to 5' }).int().min(1, 'Choose a roast level from 1 to 5').max(5, 'Choose a roast level from 1 to 5'),
  brew: z.enum(['espresso', 'filter', 'both'], { error: 'Choose espresso, filter or both' }),
  notes: z.array(v.singleLine(30, 'Tasting note'), { error: 'Enter three tasting notes' }).length(3, 'Enter exactly three tasting notes'),
  flavour: z.object({ acidity: score, sweetness: score, body: score, fruit: score, floral: score, roast: score }, { error: 'Enter the six flavour scores' }),
  weight_g: z.number({ error: 'Enter the bag weight in grams' }).int().min(50, 'Minimum is 50 g').max(5000, 'Maximum is 5000 g'),
  price_pence: v.pence(100000),
  stock: z.number({ error: 'Enter the stock as a whole number' }).int('Enter the stock as a whole number').min(0, 'Stock cannot be negative').max(100000, 'Too large'),
  tint: v.hexColor,
  status: z.enum(['draft', 'active'], { error: 'Choose draft or active' })
}
const productCreate = z.object({
  ...productShape,
  slug: productShape.slug.optional(),
  origin_region: productShape.origin_region.optional(),
  process: productShape.process.optional(),
  varietal: productShape.varietal.optional(),
  altitude_m: productShape.altitude_m.optional(),
  weight_g: productShape.weight_g.optional(),
  stock: productShape.stock.optional(),
  tint: productShape.tint.optional(),
  status: productShape.status.optional()
})
const productUpdate = z.object(productShape).partial().extend({ version: v.version })
const productsQuery = z.object({
  status: z.enum(['draft', 'active', 'archived']).optional(),
  roaster_id: v.id.optional(),
  q: z.string().trim().max(60).optional()
})

const roasterShape = {
  name: v.singleLine(80, 'Name'),
  slug: v.slug,
  area: v.singleLine(60, 'Area'),
  postcode: v.loosePostcode,
  lat: z.number({ error: 'Enter a latitude' }).min(49, 'That is not in the UK').max(61, 'That is not in the UK'),
  lon: z.number({ error: 'Enter a longitude' }).min(-9, 'That is not in the UK').max(3, 'That is not in the UK'),
  description: v.text(400, 'Description'),
  bag_color: v.hexColor,
  label_color: v.hexColor,
  label_ink: v.hexColor,
  collection_enabled: bool,
  collection_hours: v.text(120, 'Collection hours')
}
const roasterCreate = z.object({
  ...roasterShape,
  slug: roasterShape.slug.optional(),
  description: roasterShape.description.optional(),
  bag_color: roasterShape.bag_color.optional(),
  label_color: roasterShape.label_color.optional(),
  label_ink: roasterShape.label_ink.optional(),
  collection_enabled: bool.optional(),
  collection_hours: roasterShape.collection_hours.optional()
})
const roasterUpdate = z.object(roasterShape).partial().extend({ version: v.version })
const versionBody = z.object({ version: v.version })

const zoneParams = z.object({
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}$/, 'Use the letters at the start of a postcode, like SE')
})
const zoneBody = z.object({ fee_pence: v.pence(10000), active: bool.default(true) })

// Columns that can be written, picked from a stored row.
const PRODUCT_COLUMNS = ['roaster_id', 'slug', 'name', 'origin_country', 'origin_region', 'process', 'varietal', 'altitude_m',
  'roast_level', 'brew', 'notes', 'flavour', 'weight_g', 'price_pence', 'stock', 'image_path', 'tint', 'status']
const ROASTER_COLUMNS = ['slug', 'name', 'area', 'postcode', 'lat', 'lon', 'description', 'bag_color', 'label_color', 'label_ink',
  'image_path', 'collection_enabled', 'collection_hours', 'active']
const pick = (row, columns) => Object.fromEntries(columns.map(c => [c, row[c]]))

module.exports = async function adminCatalogRoutes (app, { db, repo, storage, config }) {
  const audit = (request, action, entity, id, before, after) =>
    repo.admin.audit(request.session.adminId, action, entity, id, before, after)

  function uniqueSlug (base, taken) {
    let candidate = base || 'item'
    for (let n = 2; taken(candidate); n++) candidate = `${base}-${n}`.slice(0, 80)
    return candidate
  }

  /** Read one uploaded image from a multipart request and store it re-encoded. */
  async function receiveImage (request) {
    if (!request.isMultipart()) throw new AppError(415, 'unsupported_media_type', 'Send the image as multipart/form-data in a field called "image".')
    const file = await request.file({ limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 4 } })
    if (!file) throw new AppError(400, 'bad_request', 'No file was uploaded. Use a form field called "image".')
    const buffer = await file.toBuffer() // throws FST_REQ_FILE_TOO_LARGE over 5 MB
    // The client's filename and declared type are ignored: only the bytes count.
    return storage.saveImage(buffer)
  }

  // ---- products -----------------------------------------------------------
  const productSnapshot = (p) => pick(p, [...PRODUCT_COLUMNS, 'version'])

  app.get('/api/admin/products', async (request) => {
    const query = parse(productsQuery, request.query, 'query')
    const rows = repo.catalog.listAdminProducts({ status: query.status, roaster_id: query.roaster_id, q: v.likePattern(query.q) })
    return { products: rows.map(views.adminProduct), count: rows.length }
  })

  app.get('/api/admin/products/:id', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const product = repo.catalog.getProduct(id)
    if (!product) throw notFound('Product not found.')
    return { product: views.adminProduct(product) }
  })

  app.post('/api/admin/products', async (request, reply) => {
    const body = parse(productCreate, request.body)
    const product = db.tx(() => {
      if (!repo.catalog.getRoaster(body.roaster_id)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { roaster_id: 'Choose a roaster from the list' })
      }
      if (body.slug && repo.catalog.slugTaken(body.slug)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { slug: 'Another product already uses this web address' })
      }
      const slug = body.slug || uniqueSlug(v.slugify(body.name), s => repo.catalog.slugTaken(s))
      const id = repo.catalog.insertProduct({
        origin_region: '', process: '', varietal: '', altitude_m: null, weight_g: 250, stock: 0, tint: '#9A765F', status: 'draft',
        ...body,
        slug,
        image_path: null
      })
      const created = repo.catalog.getProduct(id)
      audit(request, 'product.created', 'product', id, null, productSnapshot(created))
      return created
    })
    reply.code(201)
    return { product: views.adminProduct(product) }
  })

  function changeProduct (request, id, version, action, mutate) {
    return db.tx(() => {
      const before = repo.catalog.getProduct(id)
      if (!before) throw notFound('Product not found.')
      if (before.version !== version) throw stale('product')
      const next = { ...pick(before, PRODUCT_COLUMNS), ...mutate(before) }
      if (next.slug !== before.slug && repo.catalog.slugTaken(next.slug, id)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { slug: 'Another product already uses this web address' })
      }
      if (next.roaster_id !== before.roaster_id && !repo.catalog.getRoaster(next.roaster_id)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { roaster_id: 'Choose a roaster from the list' })
      }
      if (!repo.catalog.updateProduct(id, version, next)) throw stale('product')
      const after = repo.catalog.getProduct(id)
      audit(request, action, 'product', id, productSnapshot(before), productSnapshot(after))
      return after
    })
  }

  // PATCH and PUT behave the same: send only the fields you want to change, plus `version`.
  const updateProductHandler = async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version, ...changes } = parse(productUpdate, request.body)
    const product = changeProduct(request, id, version, 'product.updated', (before) => {
      if (before.status === 'archived' && changes.status) {
        throw new AppError(409, 'invalid_transition', 'This product is archived. Restore it first.')
      }
      return changes
    })
    return { product: views.adminProduct(product) }
  }
  app.patch('/api/admin/products/:id', updateProductHandler)
  app.put('/api/admin/products/:id', updateProductHandler)

  app.post('/api/admin/products/:id/archive', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version } = parse(versionBody, request.body)
    return { product: views.adminProduct(changeProduct(request, id, version, 'product.archived', () => ({ status: 'archived' }))) }
  })

  app.post('/api/admin/products/:id/restore', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version } = parse(versionBody, request.body)
    const product = changeProduct(request, id, version, 'product.restored', (before) => {
      if (before.status !== 'archived') throw new AppError(409, 'invalid_transition', 'Only archived products can be restored.')
      // Restored as a draft so nothing goes back on sale by accident.
      return { status: 'draft' }
    })
    return { product: views.adminProduct(product) }
  })

  app.post('/api/admin/products/:id/image', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    if (!repo.catalog.getProduct(id)) throw notFound('Product not found.')
    const name = await receiveImage(request)
    let previous = null
    let product
    try {
      product = db.tx(() => {
        const current = repo.catalog.getProduct(id)
        if (!current) throw notFound('Product not found.')
        previous = current.image_path
        return changeProduct(request, id, current.version, 'product.image_changed', () => ({ image_path: name }))
      })
    } catch (err) {
      await storage.remove(name)
      throw err
    }
    if (previous) await storage.remove(previous)
    return { product: views.adminProduct(product) }
  })

  // ---- roasters -----------------------------------------------------------
  const roasterSnapshot = (r) => pick(r, [...ROASTER_COLUMNS, 'version'])

  app.get('/api/admin/roasters', async (request) => {
    parse(v.empty, request.query, 'query')
    return { roasters: repo.catalog.listAllRoasters().map(views.adminRoaster) }
  })

  app.get('/api/admin/roasters/:id', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const roaster = repo.catalog.getRoaster(id)
    if (!roaster) throw notFound('Roaster not found.')
    return { roaster: views.adminRoaster(roaster) }
  })

  app.post('/api/admin/roasters', async (request, reply) => {
    const body = parse(roasterCreate, request.body)
    const roaster = db.tx(() => {
      if (body.slug && repo.catalog.roasterSlugTaken(body.slug)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { slug: 'Another roaster already uses this web address' })
      }
      const slug = body.slug || uniqueSlug(v.slugify(body.name), s => repo.catalog.roasterSlugTaken(s))
      const id = repo.catalog.insertRoaster({
        description: '', bag_color: '#F4F1EA', label_color: '#F4F1EA', label_ink: '#111114', collection_enabled: true, collection_hours: '',
        ...body,
        slug,
        image_path: null,
        active: true
      })
      const created = repo.catalog.getRoaster(id)
      audit(request, 'roaster.created', 'roaster', id, null, roasterSnapshot(created))
      return created
    })
    reply.code(201)
    return { roaster: views.adminRoaster(roaster) }
  })

  function changeRoaster (request, id, version, action, mutate) {
    return db.tx(() => {
      const before = repo.catalog.getRoaster(id)
      if (!before) throw notFound('Roaster not found.')
      if (before.version !== version) throw stale('roaster')
      const next = { ...pick(before, ROASTER_COLUMNS), ...mutate(before) }
      if (next.slug !== before.slug && repo.catalog.roasterSlugTaken(next.slug, id)) {
        throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { slug: 'Another roaster already uses this web address' })
      }
      if (!repo.catalog.updateRoaster(id, version, next)) throw stale('roaster')
      const after = repo.catalog.getRoaster(id)
      audit(request, action, 'roaster', id, roasterSnapshot(before), roasterSnapshot(after))
      return after
    })
  }

  const updateRoasterHandler = async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version, ...changes } = parse(roasterUpdate, request.body)
    return { roaster: views.adminRoaster(changeRoaster(request, id, version, 'roaster.updated', () => changes)) }
  }
  app.patch('/api/admin/roasters/:id', updateRoasterHandler)
  app.put('/api/admin/roasters/:id', updateRoasterHandler)

  app.post('/api/admin/roasters/:id/deactivate', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version } = parse(versionBody, request.body)
    return { roaster: views.adminRoaster(changeRoaster(request, id, version, 'roaster.deactivated', () => ({ active: 0 }))) }
  })

  app.post('/api/admin/roasters/:id/reactivate', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const { version } = parse(versionBody, request.body)
    return { roaster: views.adminRoaster(changeRoaster(request, id, version, 'roaster.reactivated', () => ({ active: 1 }))) }
  })

  app.post('/api/admin/roasters/:id/image', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    if (!repo.catalog.getRoaster(id)) throw notFound('Roaster not found.')
    const name = await receiveImage(request)
    let previous = null
    let roaster
    try {
      roaster = db.tx(() => {
        const current = repo.catalog.getRoaster(id)
        if (!current) throw notFound('Roaster not found.')
        previous = current.image_path
        return changeRoaster(request, id, current.version, 'roaster.image_changed', () => ({ image_path: name }))
      })
    } catch (err) {
      await storage.remove(name)
      throw err
    }
    if (previous) await storage.remove(previous)
    return { roaster: views.adminRoaster(roaster) }
  })

  // ---- delivery zones -----------------------------------------------------
  const zoneView = (z0) => ({ postcode_prefix: z0.postcode_prefix, fee_pence: z0.fee_pence, active: !!z0.active })

  app.get('/api/admin/delivery-zones', async (request) => {
    parse(v.empty, request.query, 'query')
    return { zones: repo.catalog.listZones().map(zoneView) }
  })

  app.put('/api/admin/delivery-zones/:prefix', async (request) => {
    const { prefix } = parse(zoneParams, request.params, 'params')
    const body = parse(zoneBody, request.body)
    const zone = db.tx(() => {
      const before = repo.catalog.getZone(prefix)
      repo.catalog.upsertZone(prefix, body.fee_pence, body.active)
      const after = repo.catalog.getZone(prefix)
      audit(request, before ? 'delivery_zone.updated' : 'delivery_zone.created', 'delivery_zone', prefix,
        before ? zoneView(before) : null, zoneView(after))
      return after
    })
    return { zone: zoneView(zone) }
  })
}
