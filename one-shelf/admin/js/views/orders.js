import * as api from '../api.js'
import { h, loadInto, pageHeader, formatPence, statusBadge, statusLabel, ORDER_STATUSES, table, emptyState, field, input, select, pagination, timeEl } from '../ui.js'

const PAGE_SIZE = 25
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function ordersView (root, { query, navigate }) {
  const filters = {
    status: ORDER_STATUSES.includes(query.get('status')) ? query.get('status') : '',
    from: DATE.test(query.get('from') || '') ? query.get('from') : '',
    to: DATE.test(query.get('to') || '') ? query.get('to') : '',
    q: (query.get('q') || '').slice(0, 100),
    offset: Math.max(0, parseInt(query.get('offset'), 10) || 0)
  }
  const go = (next) => navigate(`#/orders${api.query({ ...filters, ...next, offset: next.offset || '' })}`)

  const status = select([['', 'All statuses'], ...ORDER_STATUSES.map(s => [s, statusLabel(s)])], filters.status)
  const from = input({ type: 'date', value: filters.from })
  const to = input({ type: 'date', value: filters.to })
  const search = input({ type: 'search', value: filters.q, maxlength: '100', placeholder: 'OS-… or name@example.com' })
  const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter orders' },
    field({ key: 'q', label: 'Search reference, email or name', control: search }),
    field({ key: 'status', label: 'Status', control: status }),
    field({ key: 'from', label: 'From date', control: from }),
    field({ key: 'to', label: 'To date', control: to }),
    h('div', { class: 'filter-actions' },
      h('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply filters' }),
      h('button', { type: 'button', class: 'btn', text: 'Clear', on: { click: () => navigate('#/orders') } })))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    go({ status: status.value, from: from.value, to: to.value, q: search.value.trim(), offset: 0 })
  })

  const body = h('div')
  root.append(pageHeader('Orders'), form, body)
  const filtered = Boolean(filters.status || filters.from || filters.to || filters.q)

  loadInto(body, () => api.get(`/api/admin/orders${api.query({ ...filters, limit: PAGE_SIZE, offset: filters.offset || '' })}`), (data) => {
    if (data.orders.length === 0) {
      body.append(emptyState(filtered ? 'No orders match these filters.' : 'No orders yet. They will appear here as soon as a customer checks out.',
        filtered ? h('a', { href: '#/orders', text: 'Show all orders' }) : null))
      if (filters.offset > 0) body.append(pagination({ offset: filters.offset, limit: PAGE_SIZE, total: data.total, count: 0, onPage: offset => go({ offset }) }))
      return
    }
    body.append(
      h('p', { class: 'result-count', text: `${data.total} ${data.total === 1 ? 'order' : 'orders'}, newest first` }),
      table('Orders', ['Reference', 'Placed', 'Customer', 'Fulfilment', { label: 'Items', class: 'num' }, { label: 'Total', class: 'num' }, 'Status'],
        data.orders.map(order => h('tr', null,
          h('th', { scope: 'row' }, h('a', { href: `#/orders/${order.id}`, text: order.ref })),
          h('td', null, timeEl(order.created_at)),
          h('td', null, h('span', { class: 'cell-main', text: order.customer_name }), h('span', { class: 'cell-sub', text: order.email })),
          h('td', { text: order.fulfilment === 'delivery' ? 'Delivery' : 'Collection' }),
          h('td', { class: 'num', text: String(order.item_count) }),
          h('td', { class: 'num', text: formatPence(order.total_pence) }),
          h('td', null, statusBadge(order.status))))),
      pagination({ offset: data.offset, limit: data.limit, total: data.total, count: data.orders.length, onPage: offset => go({ offset }) }))
  })
}
