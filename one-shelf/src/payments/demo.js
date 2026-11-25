'use strict'
// Demo payment provider: NO MONEY IS TAKEN. It exists so the whole shop can be
// tried end to end. src/config.js refuses to start in production with this
// provider unless ALLOW_DEMO_IN_PRODUCTION=yes.
//
// The two server-rendered pages here use an external stylesheet and no inline
// script or style, so they comply with the site's Content-Security-Policy.

const fs = require('node:fs')
const path = require('node:path')
const { z, parse } = require('../security/validate')
const { sha256, safeEqual, ORDER_REF_PATTERN, TOKEN_PATTERN } = require('../security/tokens')

const CSS = fs.readFileSync(path.join(__dirname, 'demo.css'))

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const money = (pence) => '£' + (pence / 100).toFixed(2)

function page (title, bodyHtml) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | One Shelf</title>
<link rel="stylesheet" href="/pay/demo.css">
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>
`
}

const paramsSchema = z.object({ ref: z.string().regex(ORDER_REF_PATTERN) })
const tokenSchema = z.object({ token: z.string().regex(TOKEN_PATTERN) })
const actionParamsSchema = z.object({ ref: z.string().regex(ORDER_REF_PATTERN), action: z.enum(['pay', 'fail']) })

class DemoProvider {
  constructor (config) {
    this.name = 'demo'
    this.config = config
  }

  /** Relative URL on this same site, so it works on any host or port. */
  checkoutUrl (order, ctx) {
    return `/pay/demo/${encodeURIComponent(order.public_ref)}?token=${encodeURIComponent(ctx.accessToken)}`
  }

  async createCheckout (order, ctx) {
    return { url: this.checkoutUrl(order, ctx), ref: `demo_${order.public_ref}` }
  }

  /**
   * The demo "event" is the customer pressing Pay or Fail on the demo page.
   * It is authenticated with the order's access token (a real provider would
   * be authenticated by a webhook signature instead).
   */
  async verifyEvent (request) {
    const params = actionParamsSchema.safeParse(request.params)
    const body = tokenSchema.safeParse(request.body)
    if (!params.success || !body.success) return null
    const order = this.repo.orders.getByRef(params.data.ref)
    // Compare against a dummy hash when the order is unknown, so timing is the same.
    const expected = order ? order.access_token_hash : sha256('no-such-order')
    if (!safeEqual(sha256(body.data.token), expected) || !order) return null
    return { orderRef: order.public_ref, outcome: params.data.action === 'pay' ? 'paid' : 'failed', paymentRef: `demo_${order.public_ref}` }
  }

  registerRoutes (app, { repo, applyPaymentEvent }) {
    this.repo = repo
    const provider = this
    const html = (reply, status, markup) => reply.code(status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(markup)
    const notFoundPage = (reply) => html(reply, 404, page('Order not found',
      '<h1>We could not find that order</h1>\n<p class="hint">The payment link is incomplete or out of date. <a href="/">Back to the shop</a></p>'))

    app.get('/pay/demo.css', async (request, reply) => {
      return reply.header('Content-Type', 'text/css; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(CSS)
    })

    app.get('/pay/demo/:ref', async (request, reply) => {
      const params = paramsSchema.safeParse(request.params)
      const query = tokenSchema.safeParse(request.query)
      if (!params.success || !query.success) return notFoundPage(reply)
      const order = repo.orders.getByRef(params.data.ref)
      const expected = order ? order.access_token_hash : sha256('no-such-order')
      if (!safeEqual(sha256(query.data.token), expected) || !order) return notFoundPage(reply)

      const ref = escapeHtml(order.public_ref)
      const token = escapeHtml(query.data.token)
      const orderLink = `/order.html?ref=${encodeURIComponent(order.public_ref)}&amp;token=${encodeURIComponent(query.data.token)}`
      if (order.status !== 'pending_payment') {
        return html(reply, 200, page('Order ' + order.public_ref, `<p class="banner">Demo payment: no money is taken</p>
<h1>This order can no longer be paid for</h1>
<p class="ref">Order ${ref}</p>
<p class="hint">It has already been paid, cancelled or has timed out. <a href="${orderLink}">View your order</a></p>`))
      }
      return html(reply, 200, page('Demo payment', `<p class="banner">Demo payment: no money is taken</p>
<h1>Order total</h1>
<p class="ref">Order ${ref}</p>
<p class="total">${escapeHtml(money(order.total_pence))}</p>
<p class="hint">This shop is running in demo mode. Nothing will be charged and no card details are asked for. Choose an outcome to see what happens next.</p>
<div class="actions">
<form method="post" action="/pay/demo/${ref}/pay">
<input type="hidden" name="token" value="${token}">
<button class="pay" type="submit">Pay ${escapeHtml(money(order.total_pence))} (demo)</button>
</form>
<form method="post" action="/pay/demo/${ref}/fail">
<input type="hidden" name="token" value="${token}">
<button class="fail" type="submit">Make the payment fail</button>
</form>
</div>`))
    })

    // State change by POST only, authenticated by the order access token and
    // covered by the global same-origin check.
    app.post('/pay/demo/:ref/:action', async (request, reply) => {
      const event = await provider.verifyEvent(request)
      if (!event) return notFoundPage(reply)
      applyPaymentEvent(event)
      const token = parse(tokenSchema, request.body).token
      return reply.header('Cache-Control', 'no-store')
        .redirect(`/order.html?ref=${encodeURIComponent(event.orderRef)}&token=${encodeURIComponent(token)}`, 303)
    })
  }
}

module.exports = { DemoProvider }
