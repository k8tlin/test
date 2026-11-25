'use strict'
// Basket pricing, checkout and order state changes. Every number here comes
// from the database; nothing price-related is ever read from the client.

const { AppError } = require('../security/errors')
const { randomToken, sha256, randomOrderRef } = require('../security/tokens')
const { resolvePostcode } = require('./postcodes')
const { allowedAdminTransitions, shouldRestoreStock } = require('./status')

const GRINDS = ['Whole bean', 'Espresso', 'Moka pot', 'Filter', 'Cafetière']
const MAX_QUANTITY = 12
const MAX_LINES = 20
const LOW_STOCK = 3
const SHOW_STOCK_AT = 5

module.exports = function ordersService ({ db, repo, config, log }) {
  /**
   * Price a basket from the database.
   * @param {Array<{product_id: string, quantity: number, grind: string}>} items  product_id is the public product id (its slug)
   * @returns {{ lines, problems, subtotal_pence, collection, roasterIds }}
   */
  function priceBasket (items) {
    // Merge duplicate lines (same product and grind).
    const merged = new Map()
    for (const item of items) {
      const key = item.product_id + '|' + item.grind
      const existing = merged.get(key)
      if (existing) existing.quantity += item.quantity
      else merged.set(key, { ...item })
    }

    const lines = []
    const problems = []
    const usedPerProduct = new Map()
    for (const item of merged.values()) {
      const product = repo.catalog.getProductBySlug(item.product_id)
      if (!product || product.status !== 'active' || !product.roaster_active) {
        problems.push({ product_id: item.product_id, code: 'product_unavailable', message: 'This coffee is no longer available and was removed.' })
        continue
      }
      const alreadyUsed = usedPerProduct.get(product.id) || 0
      const available = Math.max(0, product.stock - alreadyUsed)
      let quantity = Math.min(item.quantity, MAX_QUANTITY)
      if (available === 0) {
        problems.push({ product_id: product.slug, code: 'out_of_stock', message: `${product.name} is out of stock and was removed.` })
        continue
      }
      if (quantity > available) {
        quantity = available
        problems.push({
          product_id: product.slug,
          code: 'quantity_reduced',
          message: `Only ${available} of ${product.name} left, so the quantity was reduced.`,
          requested_quantity: item.quantity,
          available_quantity: available
        })
      } else if (item.quantity > MAX_QUANTITY) {
        problems.push({
          product_id: product.slug,
          code: 'quantity_reduced',
          message: `You can order up to ${MAX_QUANTITY} of each coffee per order.`,
          requested_quantity: item.quantity,
          available_quantity: quantity
        })
      }
      usedPerProduct.set(product.id, alreadyUsed + quantity)
      lines.push({ product, grind: item.grind, quantity, requested_quantity: item.quantity, line_total_pence: product.price_pence * quantity })
    }

    const subtotal = lines.reduce((sum, l) => sum + l.line_total_pence, 0)
    return { lines, problems, subtotal_pence: subtotal, collection: collectionFor(lines) }
  }

  /** Collection is only offered when every line comes from one roaster that allows it. */
  function collectionFor (lines) {
    if (lines.length === 0) return { allowed: false, reason: 'Your basket is empty.', reason_code: 'empty_basket', roaster: null }
    const roasterIds = new Set(lines.map(l => l.product.roaster_id))
    if (roasterIds.size > 1) {
      return {
        allowed: false,
        reason_code: 'multiple_roasters',
        reason: 'Collection is only possible when everything in your basket comes from one roastery. Choose delivery, or order from each roastery separately.',
        roaster: null
      }
    }
    const p = lines[0].product
    if (!p.roaster_collection_enabled) {
      return { allowed: false, reason_code: 'collection_disabled', reason: `${p.roaster_name} does not offer collection. Please choose delivery.`, roaster: null }
    }
    return {
      allowed: true,
      reason: null,
      reason_code: null,
      roaster: { id: p.roaster_slug, name: p.roaster_name, area: p.roaster_area, postcode: p.roaster_postcode, collection_hours: p.roaster_collection_hours },
      roaster_internal_id: p.roaster_id
    }
  }

  /**
   * @returns {{ available: boolean|null, fee_pence: number|null, reason, reason_code, estimated }}
   * available is null when no postcode was given yet (fee is then the standard fee, as an estimate).
   */
  function deliveryFor (postcode) {
    if (!postcode) {
      const fee = repo.catalog.standardDeliveryFee()
      return { available: null, fee_pence: fee, estimated: true, reason_code: 'postcode_needed', reason: 'Enter your postcode to confirm we deliver to you.' }
    }
    const place = resolvePostcode(postcode)
    if (!place.ok) {
      return {
        available: false,
        fee_pence: null,
        estimated: false,
        reason_code: place.reason === 'format' ? 'postcode_invalid' : 'outside_delivery_area',
        reason: place.reason === 'format' ? 'That does not look like a UK postcode.' : 'Sorry, we only deliver to London postcodes.'
      }
    }
    const zone = repo.catalog.getZone(place.area)
    if (!zone || !zone.active) {
      return { available: false, fee_pence: null, estimated: false, reason_code: 'outside_delivery_area', reason: `Sorry, we do not deliver to ${place.outward} yet.` }
    }
    return { available: true, fee_pence: zone.fee_pence, estimated: false, reason: null, reason_code: null }
  }

  function newRef () {
    for (let i = 0; i < 10; i++) {
      const ref = randomOrderRef()
      if (!repo.orders.refExists(ref)) return ref
    }
    throw new Error('could not allocate an order reference')
  }

  /**
   * Create a pending order and reserve its stock, all in one transaction.
   * Any basket problem aborts the checkout (409) so the customer can review
   * the corrected basket; nothing is silently changed at this point.
   */
  function checkout (input) {
    return db.tx(() => {
      const priced = priceBasket(input.items)
      if (priced.problems.length || priced.lines.length === 0) {
        const fields = {}
        for (const p of priced.problems) fields[`items.${p.product_id}`] = p.message
        throw new AppError(409, 'basket_changed',
          priced.lines.length === 0 && !priced.problems.length ? 'Your basket is empty.' : 'Some items in your basket have changed. Please review your basket and try again.',
          fields)
      }

      let deliveryFee = 0
      let collectionRoasterId = null
      let address = { address_line1: null, address_line2: null, city: null, postcode: null, delivery_notes: null }
      if (input.fulfilment === 'collect') {
        if (!priced.collection.allowed) {
          throw new AppError(409, 'collection_unavailable', priced.collection.reason, { fulfilment: priced.collection.reason })
        }
        collectionRoasterId = priced.collection.roaster_internal_id
      } else {
        const delivery = deliveryFor(input.address.postcode)
        if (!delivery.available) {
          throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { 'address.postcode': delivery.reason })
        }
        deliveryFee = delivery.fee_pence
        address = {
          address_line1: input.address.line1,
          address_line2: input.address.line2 || null,
          city: input.address.city,
          postcode: input.address.postcode,
          delivery_notes: input.delivery_notes || null
        }
      }

      // Reserve stock. The WHERE stock >= qty guard makes overselling impossible
      // even if two checkouts race; a failed guard rolls the whole order back.
      for (const line of priced.lines) {
        if (!repo.catalog.decrementStock(line.product.id, line.quantity)) {
          throw new AppError(409, 'basket_changed', 'Some items in your basket have just sold out. Please review your basket and try again.',
            { [`items.${line.product.slug}`]: `${line.product.name} has just sold out.` })
        }
      }

      const accessToken = randomToken()
      const now = new Date()
      const order = {
        public_ref: newRef(),
        access_token_hash: sha256(accessToken),
        customer_name: input.customer.name,
        email: input.customer.email,
        phone: input.customer.phone,
        fulfilment: input.fulfilment,
        collection_roaster_id: collectionRoasterId,
        ...address,
        subtotal_pence: priced.subtotal_pence,
        delivery_fee_pence: deliveryFee,
        total_pence: priced.subtotal_pence + deliveryFee,
        payment_provider: config.paymentProvider,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + config.orderExpiryMinutes * 60000).toISOString()
      }
      const orderId = repo.orders.insertOrder(order)
      for (const line of priced.lines) {
        repo.orders.insertItem({
          order_id: orderId,
          product_id: line.product.id,
          roaster_id: line.product.roaster_id,
          name_snapshot: line.product.name,
          roaster_name_snapshot: line.product.roaster_name,
          grind: line.grind,
          unit_price_pence: line.product.price_pence,
          quantity: line.quantity
        })
      }
      return { order: repo.orders.getById(orderId), accessToken }
    })
  }

  function restoreStock (orderId) {
    for (const item of repo.orders.listItems(orderId)) repo.catalog.restoreStock(item.product_id, item.quantity)
  }

  const snapshot = (o) => ({ status: o.status, version: o.version, paid_at: o.paid_at, payment_ref: o.payment_ref })

  /**
   * The one path that marks an order paid. Called by the payment provider
   * integration (demo page today, verified Stripe webhook later). Idempotent.
   * @returns {{ ok: boolean, order, reason? }}
   */
  function markPaid (orderRef, paymentRef) {
    return db.tx(() => {
      const order = repo.orders.getByRef(orderRef)
      if (!order) return { ok: false, reason: 'not_found', order: null }
      if (order.status !== 'pending_payment') {
        // Already paid (duplicate event) is fine; anything else needs a human.
        const alreadyPaid = !!order.paid_at && order.status !== 'cancelled' && order.status !== 'expired'
        if (!alreadyPaid) log.warn({ order_ref: order.public_ref, status: order.status }, 'payment received for an order that is no longer payable; refund it at the payment provider')
        return { ok: alreadyPaid, reason: alreadyPaid ? 'already_paid' : 'not_payable', order }
      }
      const paidAt = new Date().toISOString()
      repo.orders.setStatus(order.id, 'pending_payment', order.version, 'paid', paidAt)
      if (paymentRef) repo.orders.setPaymentRef(order.id, paymentRef)
      const after = repo.orders.getById(order.id)
      repo.admin.audit(null, 'order.payment_paid', 'order', order.id, snapshot(order), snapshot(after))
      return { ok: true, order: after }
    })
  }

  /** Payment failed or was abandoned at the provider: cancel and release the stock. */
  function markFailed (orderRef, paymentRef) {
    return db.tx(() => {
      const order = repo.orders.getByRef(orderRef)
      if (!order) return { ok: false, reason: 'not_found', order: null }
      if (order.status !== 'pending_payment') return { ok: false, reason: 'not_payable', order }
      repo.orders.setStatus(order.id, 'pending_payment', order.version, 'cancelled', null)
      if (paymentRef) repo.orders.setPaymentRef(order.id, paymentRef)
      restoreStock(order.id)
      const after = repo.orders.getById(order.id)
      repo.admin.audit(null, 'order.payment_failed', 'order', order.id, snapshot(order), snapshot(after))
      return { ok: true, order: after }
    })
  }

  /** Expire unpaid orders past their deadline and put their stock back. */
  function sweepExpired (now = new Date()) {
    return db.tx(() => {
      const overdue = repo.orders.listOverdue(now.toISOString())
      for (const order of overdue) {
        if (!repo.orders.setStatus(order.id, 'pending_payment', order.version, 'expired', null)) continue
        restoreStock(order.id)
        repo.admin.audit(null, 'order.expired', 'order', order.id, snapshot(order), snapshot(repo.orders.getById(order.id)))
      }
      return overdue.length
    })
  }

  /** Admin status change with transition rules and optimistic locking. */
  function adminSetStatus (adminId, orderId, toStatus, version) {
    return db.tx(() => {
      const order = repo.orders.getById(orderId)
      if (!order) throw new AppError(404, 'not_found', 'Order not found.')
      if (order.version !== version) {
        throw new AppError(409, 'stale_version', 'This order was changed by someone else. Reload it and try again.')
      }
      const allowed = allowedAdminTransitions(order)
      if (!allowed.includes(toStatus)) {
        throw new AppError(409, 'invalid_transition',
          `An order that is "${order.status}" cannot be moved to "${toStatus}".` +
          (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' No further changes are possible.'))
      }
      if (!repo.orders.setStatus(order.id, order.status, version, toStatus, null)) {
        throw new AppError(409, 'stale_version', 'This order was changed by someone else. Reload it and try again.')
      }
      if (shouldRestoreStock(order.status, toStatus)) restoreStock(order.id)
      const after = repo.orders.getById(order.id)
      repo.admin.audit(adminId, 'order.status_changed', 'order', order.id, snapshot(order), snapshot(after))
      return after
    })
  }

  function adminSetNotes (adminId, orderId, notes, version) {
    return db.tx(() => {
      const order = repo.orders.getById(orderId)
      if (!order) throw new AppError(404, 'not_found', 'Order not found.')
      if (!repo.orders.setNotes(order.id, version, notes)) {
        throw new AppError(409, 'stale_version', 'This order was changed by someone else. Reload it and try again.')
      }
      const after = repo.orders.getById(order.id)
      repo.admin.audit(adminId, 'order.notes_changed', 'order', order.id,
        { admin_notes: order.admin_notes, version: order.version }, { admin_notes: after.admin_notes, version: after.version })
      return after
    })
  }

  return {
    GRINDS, MAX_QUANTITY, MAX_LINES, LOW_STOCK, SHOW_STOCK_AT,
    priceBasket, deliveryFor, checkout, markPaid, markFailed, sweepExpired, adminSetStatus, adminSetNotes
  }
}
