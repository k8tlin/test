import * as api from '../api.js'
import { h, loadInto, pageHeader, table, emptyState, field, input, select, pagination, timeEl } from '../ui.js'
import { actionLabel, actorLabel, changes, snapshotRows } from '../audit-format.js'

const PAGE_SIZE = 50
const ENTITIES = [['', 'Everything'], ['order', 'Orders'], ['product', 'Products'], ['roaster', 'Roasters'], ['delivery_zone', 'Delivery zones'], ['admin_user', 'Admin accounts']]
const ENTITY_NAMES = { order: 'Order', product: 'Product', roaster: 'Roaster', delivery_zone: 'Delivery zone', admin_user: 'Admin account' }

function entityLink (entry) {
  const name = `${ENTITY_NAMES[entry.entity] || entry.entity} ${entry.entity_id ?? ''}`.trim()
  const href = {
    order: `#/orders/${entry.entity_id}`,
    product: `#/products/${entry.entity_id}`,
    roaster: `#/roasters/${entry.entity_id}`,
    delivery_zone: '#/zones'
  }[entry.entity]
  return href && entry.entity_id ? h('a', { href, text: name }) : h('span', { text: name })
}

function changeCell (entry) {
  const diff = changes(entry.before, entry.after)
  if (diff.length) {
    return h('ul', { class: 'changes' }, diff.map(change => h('li', null,
      h('span', { class: 'change-label', text: `${change.label}: ` }),
      h('span', { class: 'change-from', text: change.from }),
      h('span', { class: 'change-arrow', text: ' → ' }),
      h('span', { class: 'visually-hidden', text: ' changed to ' }),
      h('span', { class: 'change-to', text: change.to }))))
  }
  if (!entry.before && entry.after) {
    return h('details', null,
      h('summary', { text: 'New record: show details' }),
      h('dl', { class: 'snapshot' }, snapshotRows(entry.after).map(rowData => h('div', null, h('dt', { text: rowData.label }), h('dd', { text: rowData.value })))))
  }
  return h('span', { class: 'muted', text: entry.before && entry.after ? 'Saved with no fields changed' : 'No details recorded' })
}

export function activityView (root, { query, navigate }) {
  const filters = {
    entity: ENTITIES.some(([value]) => value && value === query.get('entity')) ? query.get('entity') : '',
    entity_id: (query.get('entity_id') || '').slice(0, 20),
    offset: Math.max(0, parseInt(query.get('offset'), 10) || 0)
  }
  const go = (next) => navigate(`#/activity${api.query({ ...filters, offset: '', ...next })}`)

  const entity = select(ENTITIES, filters.entity)
  const entityId = input({ value: filters.entity_id, maxlength: '20', class: 'input-short' })
  const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter activity' },
    field({ key: 'entity', label: 'Show activity for', control: entity }),
    field({ key: 'entity_id', label: 'Record number (optional)', control: entityId, hint: 'For a zone, its letters.' }),
    h('div', { class: 'filter-actions' },
      h('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply filters' }),
      h('button', { type: 'button', class: 'btn', text: 'Clear', on: { click: () => navigate('#/activity') } })))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    go({ entity: entity.value, entity_id: entity.value ? entityId.value.trim() : '' })
  })

  const body = h('div')
  const scoped = filters.entity && filters.entity_id
  root.append(
    pageHeader(scoped ? `Activity log: ${(ENTITY_NAMES[filters.entity] || '').toLowerCase()} ${filters.entity_id}` : 'Activity log'),
    h('p', { class: 'section-note', text: 'Every change made in admin, plus payments and expiries, newest first.' }),
    form, body)

  loadInto(body, () => api.get(`/api/admin/audit${api.query({ entity: filters.entity, entity_id: filters.entity ? filters.entity_id : '', limit: PAGE_SIZE, offset: filters.offset || '' })}`), (data) => {
    if (data.entries.length === 0) {
      body.append(emptyState(filters.offset > 0 ? 'No more activity.' : (filters.entity ? 'No activity recorded for this yet.' : 'No activity yet.'),
        filters.entity || filters.offset ? h('a', { href: '#/activity', text: 'Show all activity' }) : null))
      return
    }
    body.append(
      table('Activity', ['When', 'Who', 'What', 'Record', 'Before and after'],
        data.entries.map(entry => h('tr', null,
          h('td', { class: 'nowrap' }, timeEl(entry.created_at)),
          h('td', { text: actorLabel(entry) }),
          h('th', { scope: 'row', text: actionLabel(entry.action) }),
          h('td', { class: 'nowrap' }, entityLink(entry)),
          h('td', null, changeCell(entry))))),
      pagination({ offset: filters.offset, limit: PAGE_SIZE, count: data.entries.length, onPage: offset => go({ offset: offset || '' }) }))
  })
}
