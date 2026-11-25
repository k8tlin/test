import * as api from '../api.js'
import { h, loadInto, pageHeader, formatPence, statusBadge, table, emptyState, field, input, select, busy, confirmDialog, announce, reportError, alertError, parseWhole } from '../ui.js'

export function thumb (item, kind = 'product') {
  if (item.image_url) return h('img', { class: 'thumb', src: item.image_url, alt: '', width: '44', height: '44', loading: 'lazy' })
  const placeholder = h('span', { class: `thumb thumb-placeholder thumb-${kind}`, 'aria-hidden': 'true' })
  const colour = kind === 'product' ? item.tint : item.bag_color
  if (/^#[0-9a-fA-F]{6}$/.test(colour || '')) placeholder.style.setProperty('--swatch', colour)
  return placeholder
}

export function archiveDialog (product) {
  return confirmDialog({
    title: `Archive ${product.name}?`,
    body: [
      'It will disappear from the shop straight away and customers will not be able to buy it.',
      'Old orders keep it. You can restore it later; it comes back as a draft.'
    ],
    confirmLabel: 'Archive product',
    cancelLabel: 'Keep product',
    danger: true
  })
}

export function productsView (root, { query, navigate }) {
  const filters = {
    status: ['draft', 'active', 'archived'].includes(query.get('status')) ? query.get('status') : '',
    roaster_id: /^\d+$/.test(query.get('roaster_id') || '') ? query.get('roaster_id') : '',
    q: (query.get('q') || '').slice(0, 60),
    low: query.get('low') === '1' ? '1' : ''
  }
  const body = h('div')
  const filterSlot = h('div')
  root.append(pageHeader('Products', h('a', { class: 'btn btn-primary', href: '#/products/new', text: 'Add product' })), filterSlot, body)

  const load = async () => {
    const [products, roasters] = await Promise.all([
      api.get(`/api/admin/products${api.query({ status: filters.status, roaster_id: filters.roaster_id, q: filters.q })}`),
      api.get('/api/admin/roasters')
    ])
    return { products: products.products, roasters: roasters.roasters }
  }

  function renderFilters (roasters) {
    const status = select([['', 'All statuses'], ['active', 'Active'], ['draft', 'Draft'], ['archived', 'Archived']], filters.status)
    const roaster = select([['', 'All roasters'], ...roasters.map(r => [r.id, r.name])], filters.roaster_id)
    const search = input({ type: 'search', value: filters.q, maxlength: '60' })
    const low = h('input', { type: 'checkbox', id: 'filter-low', checked: filters.low === '1' })
    const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter products' },
      field({ key: 'q', label: 'Search name, origin or notes', control: search }),
      field({ key: 'status', label: 'Status', control: status }),
      field({ key: 'roaster_id', label: 'Roaster', control: roaster }),
      h('div', { class: 'field field-check' }, low, h('label', { for: 'filter-low', text: 'Low stock only (3 or fewer)' })),
      h('div', { class: 'filter-actions' },
        h('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply filters' }),
        h('button', { type: 'button', class: 'btn', text: 'Clear', on: { click: () => navigate('#/products') } })))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      navigate(`#/products${api.query({ q: search.value.trim(), status: status.value, roaster_id: roaster.value, low: low.checked ? '1' : '' })}`)
    })
    filterSlot.replaceChildren(form)
  }

  function stockEditor (product, refresh) {
    const stock = h('input', { type: 'number', class: 'input-stock', min: '0', max: '100000', step: '1', inputmode: 'numeric', value: String(product.stock), 'aria-label': `Stock for ${product.name}` })
    const save = h('button', { type: 'submit', class: 'btn btn-small', text: 'Save', disabled: true, 'aria-label': `Save stock for ${product.name}` })
    const error = h('p', { class: 'field-error', hidden: true })
    const form = h('form', { class: 'stock-form', novalidate: true, data: { stockFor: String(product.id) } }, stock, save, error)
    const setError = (message) => { error.textContent = message || ''; error.hidden = !message; if (message) stock.setAttribute('aria-invalid', 'true'); else stock.removeAttribute('aria-invalid') }
    stock.addEventListener('input', () => { save.disabled = stock.value === String(product.stock); setError(null) })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = parseWhole(stock.value)
      if (value === null || value > 100000) { setError('Enter a whole number from 0 to 100000.'); stock.focus(); return }
      busy(save, 'Saving…', async () => {
        try {
          const result = await api.patch(`/api/admin/products/${product.id}`, { stock: value, version: product.version })
          Object.assign(product, result.product)
          stock.value = String(product.stock)
          announce(`Stock for ${product.name} is now ${product.stock}.`)
        } catch (err) {
          if (err.code === 'stale_version') {
            alertError(`Someone else changed ${product.name} while this list was open. The list has been reloaded: check the stock and try again.`)
            refresh()
          } else if (err.fields && err.fields.stock) setError(err.fields.stock)
          else reportError(err)
        }
      }).then(() => { save.disabled = stock.value === String(product.stock) })
    })
    return form
  }

  function render ({ products, roasters }) {
    renderFilters(roasters)
    const refresh = () => loadInto(body, load, render)
    const shown = filters.low ? products.filter(p => p.status === 'active' && p.stock <= 3) : products
    const filtered = Boolean(filters.status || filters.roaster_id || filters.q || filters.low)
    if (shown.length === 0) {
      body.append(emptyState(filtered ? 'No products match these filters.' : 'No products yet. Add the first coffee to put it on the shelf.',
        filtered ? h('a', { href: '#/products', text: 'Show all products' }) : h('a', { class: 'btn btn-primary', href: '#/products/new', text: 'Add product' })))
      return
    }

    const rows = shown.map((product) => {
      const toggle = product.status === 'archived'
        ? h('button', { type: 'button', class: 'btn btn-small', text: 'Restore', 'aria-label': `Restore ${product.name}` })
        : h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', text: 'Archive', 'aria-label': `Archive ${product.name}` })
      toggle.addEventListener('click', async () => {
        const archiving = product.status !== 'archived'
        if (archiving && !(await archiveDialog(product))) return
        busy(toggle, archiving ? 'Archiving…' : 'Restoring…', async () => {
          try {
            await api.post(`/api/admin/products/${product.id}/${archiving ? 'archive' : 'restore'}`, { version: product.version })
            await refresh()
            announce(archiving ? `${product.name} archived. It is no longer in the shop.` : `${product.name} restored as a draft. Set it to active to put it back in the shop.`)
          } catch (err) {
            if (err.code === 'stale_version' || err.code === 'invalid_transition') {
              await refresh()
              alertError(`${err.message} The list has been reloaded.`)
            } else reportError(err)
          }
        })
      })
      return h('tr', { data: { productId: String(product.id) } },
        h('td', { class: 'cell-thumb' }, thumb(product)),
        h('th', { scope: 'row' }, h('a', { href: `#/products/${product.id}`, text: product.name }), h('span', { class: 'cell-sub', text: `${product.origin_country} · ${product.weight_g} g` })),
        h('td', { text: product.roaster_name }),
        h('td', { class: 'num', text: formatPence(product.price_pence) }),
        h('td', null, stockEditor(product, refresh)),
        h('td', null, statusBadge(product.status), product.status === 'active' && product.stock <= 3 ? h('mark', { class: 'flag', text: product.stock === 0 ? 'Sold out' : 'Low stock' }) : null),
        h('td', { class: 'cell-actions' }, h('a', { class: 'btn btn-small', href: `#/products/${product.id}`, text: 'Edit', 'aria-label': `Edit ${product.name}` }), toggle))
    })
    body.append(
      h('p', { class: 'result-count', text: `${shown.length} ${shown.length === 1 ? 'product' : 'products'}` }),
      table('Products', [{ label: 'Image', class: 'cell-thumb' }, 'Name', 'Roaster', { label: 'Price', class: 'num' }, 'Stock', 'Status', 'Actions'], rows))
  }

  loadInto(body, load, render)
}
