'use strict'
// Order status machine. The same table is documented in docs/API.md.

const STATUSES = ['pending_payment', 'paid', 'preparing', 'ready_for_collection', 'out_for_delivery',
  'completed', 'cancelled', 'refunded', 'expired']

// from -> to[]. "paid" and "expired" are never set by an admin: only the
// payment provider path (markPaid) and the expiry sweep set them.
const ADMIN_TRANSITIONS = {
  pending_payment: ['cancelled'],
  paid: ['preparing', 'cancelled', 'refunded'],
  preparing: ['ready_for_collection', 'out_for_delivery', 'cancelled', 'refunded'],
  ready_for_collection: ['completed', 'cancelled', 'refunded'],
  out_for_delivery: ['completed', 'cancelled', 'refunded'],
  completed: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
  expired: []
}
const SYSTEM_TRANSITIONS = {
  pending_payment: ['paid', 'cancelled', 'expired']
}
// Some targets only make sense for one fulfilment type.
const FULFILMENT_ONLY = { ready_for_collection: 'collect', out_for_delivery: 'delivery' }
// Statuses in which the order is holding stock. Leaving this set for
// "cancelled" or "expired" puts the stock back.
const HOLDS_STOCK = new Set(['pending_payment', 'paid', 'preparing', 'ready_for_collection', 'out_for_delivery'])
const RESTORES_STOCK = new Set(['cancelled', 'expired'])

function allowedAdminTransitions (order) {
  return (ADMIN_TRANSITIONS[order.status] || []).filter(to => {
    if (FULFILMENT_ONLY[to] && FULFILMENT_ONLY[to] !== order.fulfilment) return false
    // A refund only makes sense when money was taken.
    if (to === 'refunded' && !order.paid_at) return false
    return true
  })
}

const shouldRestoreStock = (from, to) => HOLDS_STOCK.has(from) && RESTORES_STOCK.has(to)

module.exports = { STATUSES, ADMIN_TRANSITIONS, SYSTEM_TRANSITIONS, FULFILMENT_ONLY, allowedAdminTransitions, shouldRestoreStock }
