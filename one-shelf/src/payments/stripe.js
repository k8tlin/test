'use strict'
// =============================================================================
// STUB. NOT IMPLEMENTED. Selecting PAYMENT_PROVIDER=stripe makes checkout fail
// with "not configured" until the steps below are done.
// =============================================================================
//
// What to implement (Stripe hosted Checkout, so card data never reaches us):
//
// 1. Add the official `stripe` package (pin the exact version) and construct it
//    with config.stripeSecretKey. Keep the key in the host's secret store.
//
// 2. createCheckout(order, ctx):
//      const session = await stripe.checkout.sessions.create({
//        mode: 'payment',
//        currency: 'gbp',
//        client_reference_id: order.public_ref,
//        customer_email: order.email,
//        line_items: [one per order item, price_data.unit_amount = unit_price_pence,
//                     plus one line for delivery_fee_pence when it is > 0],
//        metadata: { order_ref: order.public_ref },
//        expires_at: <unix time of order.expires_at; Stripe's minimum is 30 minutes>,
//        success_url: `${config.publicBaseUrl}/order.html?ref=${ref}&token=${ctx.accessToken}`,
//        cancel_url:  `${config.publicBaseUrl}/order.html?ref=${ref}&token=${ctx.accessToken}`
//      }, { idempotencyKey: order.public_ref })
//      return { url: session.url, ref: session.id }
//    The amounts must come from the order rows in our database, never from the browser.
//
// 3. Webhook: POST /api/webhooks/stripe (already exempt from the Origin check in
//    src/security/origin.js because Stripe is not a browser).
//    - Register the route inside registerRoutes with a content-type parser that
//      keeps the RAW request body (Buffer). Signature verification fails on
//      re-serialised JSON.
//    - verifyEvent(request):
//        const event = stripe.webhooks.constructEvent(rawBody,
//          request.headers['stripe-signature'], config.stripeWebhookSecret)   // throws if forged
//        'checkout.session.completed' with payment_status 'paid'
//             -> { orderRef: session.client_reference_id, outcome: 'paid', paymentRef: session.payment_intent }
//        'checkout.session.expired' or 'checkout.session.async_payment_failed'
//             -> { orderRef, outcome: 'failed', paymentRef }
//        anything else -> null
//    - The route then calls orders.markPaid(orderRef, paymentRef) or
//      orders.markFailed(orderRef, paymentRef) and answers 200 quickly. Both are
//      idempotent, which matters because Stripe retries deliveries.
//
// 4. ONLY the webhook may mark an order paid. The success_url redirect proves
//    nothing (anyone can open it); the order page simply polls
//    GET /api/orders/:ref until the status changes from pending_payment.
//
// 5. If markPaid() reports `not_payable` (the order expired or was cancelled
//    before the payment landed), refund the PaymentIntent and alert a human.
//
// 6. Refunds: when an admin moves an order to "refunded", issue the refund in
//    Stripe (dashboard, or stripe.refunds.create) - this codebase does not move money.
//
// 7. Add tests with Stripe's signed test fixtures, then remove this banner.

class StripeProvider {
  constructor (config) {
    this.name = 'stripe'
    this.config = config
  }

  async createCheckout (order, ctx) { // eslint-disable-line no-unused-vars
    throw new Error('Stripe payments are not configured: StripeProvider is a stub (see src/payments/stripe.js).')
  }

  async verifyEvent (request) { // eslint-disable-line no-unused-vars
    throw new Error('Stripe payments are not configured: StripeProvider is a stub (see src/payments/stripe.js).')
  }

  registerRoutes (app) {
    const { AppError } = require('../security/errors')
    // Present so a misconfigured Stripe dashboard gets a clear answer instead of a 404.
    app.post('/api/webhooks/stripe', async () => {
      throw new AppError(501, 'not_configured', 'Stripe payments are not configured on this server.')
    })
  }
}

module.exports = { StripeProvider }
