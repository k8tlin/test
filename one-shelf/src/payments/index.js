'use strict'
// Payment providers.
//
// interface PaymentProvider {
//   name: string
//   // Start a payment for a freshly created pending order.
//   // ctx.accessToken is the customer's order access token (never stored in clear).
//   createCheckout(order, ctx) -> Promise<{ url: string, ref: string }>
//   // Authenticate an incoming provider notification (webhook) and translate it.
//   // Returns null when the event is not about a payment outcome.
//   // Must throw when the request cannot be authenticated.
//   verifyEvent(request) -> Promise<{ orderRef: string, outcome: 'paid'|'failed', paymentRef?: string } | null>
//   // Optional: register provider-specific routes (demo pages, webhook endpoint).
//   registerRoutes(app, deps)
// }
//
// Whatever the provider, orders are only ever marked paid through
// ordersService.markPaid(), and card details never touch this server.

const { DemoProvider } = require('./demo')
const { StripeProvider } = require('./stripe')

function createPaymentProvider (config) {
  if (config.paymentProvider === 'demo') return new DemoProvider(config)
  if (config.paymentProvider === 'stripe') return new StripeProvider(config)
  throw new Error(`Unknown payment provider: ${config.paymentProvider}`)
}

module.exports = { createPaymentProvider }
