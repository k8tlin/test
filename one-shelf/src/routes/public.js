'use strict'
// Public catalogue, postcode lookup, basket quote, checkout and order view.

const v = require('../security/validate')
const { z, parse } = v
const { AppError, notFound } = require('../security/errors')
const { sha256, safeEqual, ORDER_REF_PATTERN, TOKEN_PATTERN } = require('../security/tokens')
const { resolvePostcode, distanceTo } = require('../domain/postcodes')
const views = require('../domain/views')

const ROAST_BANDS = { light: [1, 2], medium: [3, 3], dark: [4, 5] }
const GRINDS = ['Whole bean', 'Espresso', 'Moka pot', 'Filter', 'Cafetière']

const roastersQuery = z.object({ postcode: v.loosePostcode.optional() })
const productsQuery = z.object({
  postcode: v.loosePostcode.optional(),
  roaster: v.slug.optional(),
  roast: z.enum(['light', 'medium', 'dark'], { error: 'roast must be light, medium or dark' }).optional(),
  brew: z.enum(['espresso', 'filter'], { error: 'brew must be espresso or filter' }).optional(),
  max_price_pence: z.coerce.number({ error: 'max_price_pence must be a number' }).int().min(0).max(1000000).optional(),
  q: z.string().trim().max(60, 'Search is limited to 60 characters').optional(),
  // The sort key is matched against this fixed list; it never reaches SQL as text.
  sort: z.enum(['roast', 'near', 'price_asc', 'price_desc'], { error: 'sort must be roast, near, price_asc or price_desc' }).default('roast')
})
const slugParams = z.object({ slug: v.slug })
const postcodeParams = z.object({ value: z.string().trim().min(1).max(12) })

const itemSchema = z.object({
  product_id: v.slug,
  quantity: z.number({ error: 'Quantity must be a whole number from 1 to 12' }).int('Quantity must be a whole number from 1 to 12')
    .min(1, 'Quantity must be at least 1').max(12, 'You can order up to 12 of each coffee'),
  grind: z.enum(GRINDS, { error: 'Choose a grind' }).default('Whole bean')
})
const itemsSchema = z.array(itemSchema, { error: 'Your basket is empty' }).min(1, 'Your basket is empty').max(20, 'A basket can hold up to 20 different lines')
const fulfilment = z.enum(['collect', 'delivery'], { error: 'Choose collection or delivery' })

const quoteBody = z.object({
  items: itemsSchema,
  fulfilment: fulfilment.default('collect'),
  postcode: v.loosePostcode.optional().or(z.literal('').transform(() => undefined))
})

const addressSchema = z.object({
  line1: v.singleLine(120, 'Address line 1'),
  line2: v.text(120, 'Address line 2').regex(/^[^\r\n]*$/, 'Address line 2 must be a single line').optional(),
  city: v.singleLine(60, 'Town or city'),
  postcode: v.fullPostcode
}, { error: 'Enter a delivery address' })
const checkoutShape = {
  items: itemsSchema,
  fulfilment,
  customer: z.object({
    name: v.singleLine(100, 'Your name'),
    email: v.email,
    phone: v.phone
  }, { error: 'Enter your details' }),
  delivery_notes: v.text(500, 'Delivery notes').optional(),
  accept_terms: z.literal(true, { error: 'You need to accept the terms to place an order' })
}
// Two shapes so address errors are reported together with every other field.
// Any price or total the client sends is not part of either shape and is dropped.
const checkoutCollect = z.object(checkoutShape)
const checkoutDelivery = z.object({ ...checkoutShape, address: addressSchema })

const orderParams = z.object({ ref: z.string().trim().toUpperCase().regex(ORDER_REF_PATTERN) })
const orderQuery = z.object({ token: z.string().regex(TOKEN_PATTERN) })

module.exports = async function publicRoutes (app, { repo, orders, config, payments, rateLimits }) {
  const placeFor = (postcode) => {
    if (!postcode) return null
    const place = resolvePostcode(postcode)
    return place.ok ? place : null
  }

  app.get('/api/config', async () => ({
    payment_mode: config.paymentMode,
    delivery_fee_pence: repo.catalog.standardDeliveryFee(),
    currency: 'GBP',
    grinds: GRINDS,
    max_quantity_per_line: 12,
    max_basket_lines: 20,
    order_expiry_minutes: config.orderExpiryMinutes
  }))

  app.get('/api/roasters', async (request) => {
    const query = parse(roastersQuery, request.query, 'query')
    const place = placeFor(query.postcode)
    const roasters = repo.catalog.listActiveRoasters().map(r => views.publicRoaster(r, place))
    if (place) roasters.sort((a, b) => a.distance_miles - b.distance_miles || a.name.localeCompare(b.name))
    return { roasters, postcode: place ? { district: place.district, label: place.label } : null }
  })

  app.get('/api/products', async (request) => {
    const query = parse(productsQuery, request.query, 'query')
    const place = placeFor(query.postcode)
    const band = query.roast ? ROAST_BANDS[query.roast] : null
    const rows = repo.catalog.listPublicProducts({
      roaster: query.roaster,
      roast_min: band ? band[0] : null,
      roast_max: band ? band[1] : null,
      brew: query.brew,
      max_price: query.max_price_pence,
      q: v.likePattern(query.q),
      sort: query.sort
    })
    const products = rows.map(p => views.publicProduct(p, place))
    // "near" needs the postcode; without one it falls back to the roast order.
    if (query.sort === 'near' && place) {
      products.sort((a, b) => a.distance_miles - b.distance_miles || a.roast_level - b.roast_level || a.name.localeCompare(b.name))
    }
    return { products, count: products.length, postcode: place ? { district: place.district, label: place.label } : null }
  })

  app.get('/api/products/:slug', async (request) => {
    const { slug } = parse(slugParams, request.params, 'params')
    const query = parse(roastersQuery, request.query, 'query')
    const product = repo.catalog.getPublicProductBySlug(slug)
    if (!product) throw notFound('We could not find that coffee.')
    return { product: views.publicProduct(product, placeFor(query.postcode)) }
  })

  app.get('/api/postcode/:value', async (request) => {
    const { value } = parse(postcodeParams, request.params, 'params')
    const place = resolvePostcode(value)
    if (!place.ok) {
      throw new AppError(422, place.reason === 'format' ? 'postcode_invalid' : 'postcode_not_london',
        place.reason === 'format'
          ? 'That does not look like a UK postcode. Try something like E8 or E8 4PH.'
          : 'One Shelf only covers London for now. Try a London postcode such as E8, N1, SE15, SW9 or W11.',
        { postcode: place.reason === 'format' ? 'Enter a UK postcode, like E8 or E8 4PH' : 'Enter a London postcode' })
    }
    let nearest = null
    for (const r of repo.catalog.listActiveRoasters()) {
      const d = distanceTo(place, r.lat, r.lon)
      if (!nearest || d < nearest.distance_miles) nearest = { id: r.slug, slug: r.slug, name: r.name, area: r.area, distance_miles: d }
    }
    const zone = repo.catalog.getZone(place.area)
    return {
      valid: true,
      district: place.district,
      label: place.label,
      approximate: !place.precise,
      delivery_available: !!(zone && zone.active),
      nearest_roaster: nearest
    }
  })

  app.post('/api/basket/quote', async (request) => {
    const body = parse(quoteBody, request.body)
    const priced = orders.priceBasket(body.items)
    const delivery = orders.deliveryFor(body.postcode)
    const { roaster_internal_id: _internal, ...collection } = priced.collection
    const fee = body.fulfilment === 'delivery' ? (delivery.fee_pence ?? 0) : 0
    return {
      lines: priced.lines.map(l => ({
        product_id: l.product.slug,
        name: l.product.name,
        roaster: { id: l.product.roaster_slug, name: l.product.roaster_name },
        grind: l.grind,
        weight_g: l.product.weight_g,
        quantity: l.quantity,
        requested_quantity: l.requested_quantity,
        unit_price_pence: l.product.price_pence,
        line_total_pence: l.line_total_pence,
        image_url: views.mediaUrl(l.product.image_path),
        tint: l.product.tint,
        bag_color: l.product.roaster_bag_color,
        label_color: l.product.roaster_label_color,
        label_ink: l.product.roaster_label_ink
      })),
      problems: priced.problems,
      fulfilment: body.fulfilment,
      subtotal_pence: priced.subtotal_pence,
      delivery_fee_pence: fee,
      total_pence: priced.subtotal_pence + fee,
      currency: 'GBP',
      collection,
      delivery,
      can_checkout: priced.lines.length > 0 &&
        (body.fulfilment === 'collect' ? collection.allowed : delivery.available !== false)
    }
  })

  app.post('/api/checkout', { config: { rateLimit: rateLimits.checkout } }, async (request, reply) => {
    const wantsDelivery = !!request.body && request.body.fulfilment === 'delivery'
    const body = parse(wantsDelivery ? checkoutDelivery : checkoutCollect, request.body)
    const { order, accessToken } = orders.checkout(body)
    let payment
    try {
      payment = await payments.createCheckout(order, { accessToken })
    } catch (err) {
      // Could not start a payment: release the stock straight away.
      orders.markFailed(order.public_ref, null)
      request.log.error({ err, order_ref: order.public_ref }, 'payment provider could not create a checkout')
      throw new AppError(503, 'payment_unavailable', 'We could not start the payment. You have not been charged. Please try again in a moment.')
    }
    repo.orders.setPaymentRef(order.id, payment.ref)
    reply.code(201).header('Cache-Control', 'no-store')
    return { order_ref: order.public_ref, access_token: accessToken, payment_url: payment.url, expires_at: order.expires_at }
  })

  app.get('/api/orders/:ref', async (request, reply) => {
    // Every failure looks the same from outside: 404.
    const params = orderParams.safeParse(request.params)
    const query = orderQuery.safeParse(request.query)
    if (!params.success || !query.success) throw notFound('We could not find that order.')
    const order = repo.orders.getByRef(params.data.ref)
    const expected = order ? order.access_token_hash : sha256('no-such-order')
    if (!safeEqual(sha256(query.data.token), expected) || !order) throw notFound('We could not find that order.')
    const roaster = order.collection_roaster_id ? repo.catalog.getRoaster(order.collection_roaster_id) : null
    const view = views.publicOrder(order, repo.orders.listItems(order.id), roaster)
    view.payment_mode = config.paymentMode
    view.payment_url = order.status === 'pending_payment' && typeof payments.checkoutUrl === 'function'
      ? payments.checkoutUrl(order, { accessToken: query.data.token })
      : null
    reply.header('Cache-Control', 'no-store')
    return { order: view }
  })
}
