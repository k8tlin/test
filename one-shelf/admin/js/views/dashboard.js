import * as api from '../api.js'
import { h, loadInto, pageHeader, formatPence, statusBadge, ORDER_STATUSES, table, emptyState } from '../ui.js'

const ACTION_HINTS = {
  paid: 'Needs preparing',
  preparing: 'Being packed',
  ready_for_collection: 'Waiting for the customer',
  out_for_delivery: 'On its way'
}
const ACTIONABLE = ['paid', 'preparing', 'ready_for_collection', 'out_for_delivery']
const OTHER = ORDER_STATUSES.filter(status => !ACTIONABLE.includes(status))

function countCard (status, count, emphasise) {
  return h('li', null,
    h('a', { class: emphasise && count > 0 ? 'card card-link card-attention' : 'card card-link', href: `#/orders?status=${status}`, data: { status } },
      h('span', { class: 'card-number', text: String(count) }),
      statusBadge(status),
      ACTION_HINTS[status] ? h('span', { class: 'card-hint', text: ACTION_HINTS[status] }) : null))
}

export function dashboardView (root) {
  const body = h('div')
  root.append(pageHeader('Dashboard'), body)
  loadInto(body, () => api.get('/api/admin/summary'), (summary) => {
    const counts = summary.orders_by_status
    const today = summary.today
    const todayHref = `#/orders?from=${today.date}&to=${today.date}`

    body.append(
      h('section', { 'aria-labelledby': 'dash-action' },
        h('h2', { id: 'dash-action', text: 'Orders to deal with' }),
        h('p', { class: 'section-note', id: 'needs-action', text: summary.needs_action === 0 ? 'Nothing is waiting on you right now.' : `${summary.needs_action} ${summary.needs_action === 1 ? 'order needs' : 'orders need'} attention.` }),
        h('ul', { class: 'cards' }, ACTIONABLE.map(status => countCard(status, counts[status] || 0, true)))),

      h('section', { 'aria-labelledby': 'dash-today' },
        h('h2', { id: 'dash-today', text: 'Today' }),
        h('p', { class: 'section-note', text: `Orders placed on ${today.date} (${today.timezone} day).` }),
        h('ul', { class: 'cards' },
          h('li', null, h('a', { class: 'card card-link', href: todayHref, data: { stat: 'today-orders' } },
            h('span', { class: 'card-number', text: String(today.orders) }),
            h('span', { text: today.orders === 1 ? 'Order today' : 'Orders today' }),
            h('span', { class: 'card-hint', text: `${today.paid_orders} paid` }))),
          h('li', null, h('a', { class: 'card card-link', href: todayHref, data: { stat: 'today-revenue' } },
            h('span', { class: 'card-number', text: formatPence(today.revenue_pence) }),
            h('span', { text: 'Revenue today' }),
            h('span', { class: 'card-hint', text: 'Paid orders, not cancelled or refunded' }))))),

      h('section', { 'aria-labelledby': 'dash-low' },
        h('h2', { id: 'dash-low', text: 'Low stock' }),
        summary.low_stock_products.length === 0
          ? emptyState('No active coffee is running low.')
          : [
              h('p', { class: 'section-note' }, 'Active coffees with 3 or fewer bags left. ', h('a', { href: '#/products?low=1', text: 'See them in the products list' }), '.'),
              table('Low stock products', ['Coffee', 'Roaster', { label: 'Stock', class: 'num' }],
                summary.low_stock_products.map(product => h('tr', null,
                  h('th', { scope: 'row' }, h('a', { href: `#/products/${product.id}`, text: product.name })),
                  h('td', { text: product.roaster_name }),
                  h('td', { class: 'num' }, product.stock === 0 ? h('mark', { text: 'Sold out' }) : String(product.stock)))))
            ]),

      h('section', { 'aria-labelledby': 'dash-all' },
        h('h2', { id: 'dash-all', text: 'All other orders' }),
        h('ul', { class: 'cards cards-small' }, OTHER.map(status => countCard(status, counts[status] || 0, false)))))
  })
}
