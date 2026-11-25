import * as api from '../api.js'
import { h, loadInto, pageHeader, statusBadge, table, emptyState, field, select, pagination, timeEl, busy, announce, reportError } from '../ui.js'

const PAGE_SIZE = 50
const STATUSES = ['pending', 'confirmed', 'unsubscribed']
const SOURCES = { footer: 'Footer form', checkout: 'Checkout', home: 'Home page', other: 'Other' }

export function subscribersView (root, { query, navigate }) {
  const status = STATUSES.includes(query.get('status')) ? query.get('status') : ''
  const offset = Math.max(0, parseInt(query.get('offset'), 10) || 0)
  const go = (next) => navigate(`#/subscribers${api.query({ status, offset: '', ...next })}`)

  const download = h('button', { type: 'button', class: 'btn btn-primary', id: 'download-csv', text: 'Download CSV' })
  download.addEventListener('click', () => busy(download, 'Preparing…', async () => {
    try {
      const blob = await api.get('/api/admin/subscribers.csv')
      const url = URL.createObjectURL(blob)
      const link = h('a', { href: url, download: 'one-shelf-subscribers.csv', hidden: true })
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
      announce('The subscriber list has been downloaded.')
    } catch (error) {
      reportError(error)
    }
  }))

  const statusSelect = select([['', 'All statuses'], ['confirmed', 'Confirmed'], ['pending', 'Pending'], ['unsubscribed', 'Unsubscribed']], status)
  const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter subscribers' },
    field({ key: 'status', label: 'Status', control: statusSelect }),
    h('div', { class: 'filter-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply filter' })))
  form.addEventListener('submit', (event) => { event.preventDefault(); go({ status: statusSelect.value }) })

  const body = h('div')
  root.append(
    pageHeader('Subscribers', download),
    h('p', { class: 'section-note', text: 'People who signed up to the mailing list. Only email those whose status is Confirmed. The CSV contains everyone, with their status.' }),
    form, body)

  loadInto(body, () => api.get(`/api/admin/subscribers${api.query({ status, limit: PAGE_SIZE, offset: offset || '' })}`), (data) => {
    if (data.subscribers.length === 0) {
      body.append(emptyState(status ? 'No subscribers with this status.' : 'No subscribers yet. Sign-ups from the shop will appear here.',
        status ? h('a', { href: '#/subscribers', text: 'Show all subscribers' }) : null))
      return
    }
    body.append(
      h('p', { class: 'result-count', text: `${data.total} ${data.total === 1 ? 'subscriber' : 'subscribers'}` }),
      table('Subscribers', ['Email', 'Status', 'Consent given', 'Signed up from', 'Unsubscribed'],
        data.subscribers.map(person => h('tr', null,
          h('th', { scope: 'row', text: person.email }),
          h('td', null, statusBadge(person.status)),
          h('td', null, person.consent_at ? timeEl(person.consent_at) : 'Not recorded'),
          h('td', { text: SOURCES[person.consent_source] || person.consent_source || '' }),
          h('td', null, person.unsubscribed_at ? timeEl(person.unsubscribed_at) : h('span', { class: 'muted', text: 'No' }))))),
      pagination({ offset: data.offset, limit: data.limit, total: data.total, count: data.subscribers.length, onPage: next => go({ offset: next || '' }) }))
  })
}
