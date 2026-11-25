'use strict'
// Admin: orders, audit log, summary, subscribers.

const v = require('../security/validate')
const { z, parse } = v
const { notFound } = require('../security/errors')
const { STATUSES, allowedAdminTransitions } = require('../domain/status')
const views = require('../domain/views')

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-25').refine(s => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Use a real date')
const ordersQuery = z.object({
  status: z.enum(STATUSES).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
  ...v.page
})
const statusBody = z.object({ status: z.enum(STATUSES, { error: 'Choose a status' }), version: v.version })
const notesBody = z.object({ admin_notes: v.text(2000, 'Notes'), version: v.version })
const auditQuery = z.object({
  entity: z.enum(['order', 'product', 'roaster', 'delivery_zone', 'admin_user']).optional(),
  entity_id: z.string().trim().min(1).max(40).optional(),
  ...v.page
})
const subscribersQuery = z.object({ status: z.enum(['pending', 'confirmed', 'unsubscribed']).optional(), ...v.page })

// Spreadsheet programs run cells that start with = + - @ as formulas.
function csvCell (value) {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return '"' + s.replace(/"/g, '""') + '"'
}

module.exports = async function adminOrderRoutes (app, { repo, orders }) {
  function orderDetail (order) {
    const roaster = order.collection_roaster_id ? repo.catalog.getRoaster(order.collection_roaster_id) : null
    const audit = repo.admin.listAudit({ entity: 'order', entity_id: String(order.id), limit: 200, offset: 0 })
    return views.adminOrder(order, repo.orders.listItems(order.id), roaster, allowedAdminTransitions(order), audit)
  }

  app.get('/api/admin/orders', async (request) => {
    const query = parse(ordersQuery, request.query, 'query')
    const nextDay = query.to ? new Date(Date.parse(query.to + 'T00:00:00Z') + 86400000).toISOString() : null
    const { total, rows } = repo.orders.search({
      status: query.status,
      from: query.from ? query.from + 'T00:00:00.000Z' : null,
      to: nextDay,
      q: v.likePattern(query.q),
      limit: query.limit,
      offset: query.offset
    })
    return { orders: rows.map(views.adminOrderSummary), total, limit: query.limit, offset: query.offset }
  })

  app.get('/api/admin/orders/:id', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const order = repo.orders.getById(id)
    if (!order) throw notFound('Order not found.')
    return { order: orderDetail(order) }
  })

  app.post('/api/admin/orders/:id/status', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const body = parse(statusBody, request.body)
    const order = orders.adminSetStatus(request.session.adminId, id, body.status, body.version)
    return { order: orderDetail(order) }
  })

  app.post('/api/admin/orders/:id/notes', async (request) => {
    const { id } = parse(v.idParams, request.params, 'params')
    const body = parse(notesBody, request.body)
    const order = orders.adminSetNotes(request.session.adminId, id, body.admin_notes, body.version)
    return { order: orderDetail(order) }
  })

  app.get('/api/admin/audit', async (request) => {
    const query = parse(auditQuery, request.query, 'query')
    const rows = repo.admin.listAudit(query)
    return { entries: rows.map(views.auditEntry), limit: query.limit, offset: query.offset }
  })

  app.get('/api/admin/summary', async () => {
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]))
    for (const row of repo.orders.countsByStatus()) counts[row.status] = row.n
    const now = new Date()
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const today = repo.orders.todayStats(dayStart.toISOString(), new Date(dayStart.getTime() + 86400000).toISOString())
    return {
      orders_by_status: counts,
      needs_action: counts.paid + counts.preparing + counts.ready_for_collection + counts.out_for_delivery,
      low_stock_products: repo.catalog.listLowStock(views.LOW_STOCK),
      today: { date: dayStart.toISOString().slice(0, 10), timezone: 'UTC', orders: today.orders, paid_orders: today.paid_orders, revenue_pence: today.revenue_pence }
    }
  })

  app.get('/api/admin/subscribers', async (request) => {
    const query = parse(subscribersQuery, request.query, 'query')
    const { total, rows } = repo.subscribers.list(query)
    return { subscribers: rows, total, limit: query.limit, offset: query.offset }
  })

  app.get('/api/admin/subscribers.csv', async (request, reply) => {
    parse(v.empty, request.query, 'query')
    const header = ['email', 'status', 'consent_at', 'consent_source', 'consent_text', 'unsubscribed_at']
    const lines = [header.join(',')]
    for (const row of repo.subscribers.listAll()) lines.push(header.map(k => csvCell(row[k])).join(','))
    reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="one-shelf-subscribers.csv"')
    return lines.join('\r\n') + '\r\n'
  })
}
