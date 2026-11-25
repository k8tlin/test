// Small DOM toolkit shared by every screen. Data only ever reaches the page
// through textContent / setAttribute; there is no innerHTML anywhere.

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'htmlFor', 'required', 'readOnly', 'multiple'])

export function h (tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn)
    else if (key === 'data') for (const [k, v] of Object.entries(value)) node.dataset[k] = v
    else if (PROPERTIES.has(key)) node[key] = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

function append (node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(node, child)
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

// ---- money, dates ----------------------------------------------------------

export function formatPence (pence) {
  if (!Number.isInteger(pence)) return ''
  const sign = pence < 0 ? '-' : ''
  const abs = Math.abs(pence)
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}£${pounds}.${String(abs % 100).padStart(2, '0')}`
}

/** Plain "12.50" for putting back into an input. */
export function penceToInput (pence) {
  return Number.isInteger(pence) ? `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}` : ''
}

/** "12.50", "£12.5", "12" -> integer pence, with no floating point. Null when malformed. */
export function parsePounds (text) {
  const match = /^\s*£?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(String(text))
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
}

export function parseWhole (text) {
  return /^\s*\d{1,9}\s*$/.test(String(text)) ? Number(String(text).trim()) : null
}

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function formatDateTime (iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormat.format(date)
}
export function formatDate (iso) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date)
}
export function timeEl (iso, dateOnly = false) {
  return h('time', { datetime: iso || '', text: dateOnly ? formatDate(iso) : formatDateTime(iso) })
}

// ---- order status ----------------------------------------------------------

export const ORDER_STATUSES = ['paid', 'preparing', 'ready_for_collection', 'out_for_delivery', 'pending_payment', 'completed', 'cancelled', 'refunded', 'expired']
export const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  preparing: 'Preparing',
  ready_for_collection: 'Ready for collection',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  expired: 'Expired',
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
  inactive: 'Inactive',
  pending: 'Pending',
  confirmed: 'Confirmed',
  unsubscribed: 'Unsubscribed'
}
export const statusLabel = (status) => STATUS_LABELS[status] || String(status).replace(/_/g, ' ')

/** Text label with a dot; the dot is decoration, the words carry the meaning. */
export function statusBadge (status) {
  return h('span', { class: 'status' },
    h('span', { class: `dot dot-${String(status).replace(/[^a-z_]/g, '')}`, 'aria-hidden': 'true' }),
    h('span', { text: statusLabel(status) }))
}

// ---- messages --------------------------------------------------------------

let statusTimer = null
export function announce (message) {
  const region = document.getElementById('status-region')
  clearAlert()
  region.replaceChildren(h('p', { class: 'toast toast-ok', text: message }))
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => region.replaceChildren(), 6000)
}

export function alertError (message, retry) {
  const region = document.getElementById('alert-region')
  document.getElementById('status-region').replaceChildren()
  const box = h('div', { class: 'toast toast-error' }, h('p', { text: message }))
  const actions = h('div', { class: 'toast-actions' })
  if (retry) actions.append(h('button', { type: 'button', class: 'btn btn-small', text: 'Try again', on: { click: () => { clearAlert(); retry() } } }))
  actions.append(h('button', { type: 'button', class: 'btn btn-small btn-quiet', text: 'Dismiss', on: { click: clearAlert } }))
  box.append(actions)
  region.replaceChildren(box)
  // The message floats over the page, so get it out of the way as soon as the
  // person starts correcting something, or presses Escape.
  document.addEventListener('input', clearAlert, { once: true })
  document.addEventListener('keydown', dismissOnEscape)
}
function dismissOnEscape (event) {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) clearAlert()
}
export function clearAlert () {
  document.removeEventListener('input', clearAlert)
  document.removeEventListener('keydown', dismissOnEscape)
  document.getElementById('alert-region').replaceChildren()
}
export function clearMessages () {
  clearAlert()
  clearTimeout(statusTimer)
  document.getElementById('status-region').replaceChildren()
}

/** Report an error from an action. 401s are handled centrally, so stay quiet. */
export function reportError (error, retry) {
  if (error && error.code === 'unauthorized') return
  alertError((error && error.message) || 'Something went wrong. Please try again.', retry)
}

// ---- buttons ---------------------------------------------------------------

/** Disable a button and change its label while work is in flight. */
export async function busy (button, label, work) {
  if (button.disabled) return undefined
  const original = button.textContent
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  button.textContent = label
  try {
    return await work()
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
    button.textContent = original
  }
}

// ---- states ----------------------------------------------------------------

export const loadingState = (text = 'Loading…') => h('p', { class: 'loading', role: 'status', text })
export const emptyState = (text, action) => h('div', { class: 'empty' }, h('p', { text }), action || null)
export function errorState (message, retry) {
  return h('div', { class: 'error-state', role: 'alert' },
    h('p', { text: message }),
    retry ? h('button', { type: 'button', class: 'btn', text: 'Try again', on: { click: retry } }) : null)
}

/** Loading -> content, or an error with a retry. Never leaves the area blank. */
export async function loadInto (container, load, render) {
  container.replaceChildren(loadingState())
  try {
    const data = await load()
    if (!container.isConnected) return
    container.replaceChildren()
    render(data)
  } catch (error) {
    if (error.code === 'unauthorized' || !container.isConnected) return
    container.replaceChildren(errorState(error.message || 'This could not be loaded.', () => loadInto(container, load, render)))
  }
}

// ---- dialog ----------------------------------------------------------------

let dialogCount = 0
/**
 * Modal confirmation. Resolves true only when the confirm button is pressed.
 * The safe (cancel) button takes focus first; Escape cancels; focus returns.
 */
export function confirmDialog ({ title, body, confirmLabel, cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement
    const id = `dialog-${++dialogCount}`
    const cancel = h('button', { type: 'button', class: 'btn', text: cancelLabel })
    const confirm = h('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: confirmLabel })
    const bodyEl = h('div', { class: 'dialog-body', id: `${id}-body` })
    for (const part of [].concat(body)) bodyEl.append(typeof part === 'string' ? h('p', { text: part }) : part)
    const dialog = h('dialog', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-body` },
      h('h2', { id: `${id}-title`, text: title }),
      bodyEl,
      h('div', { class: 'dialog-actions' }, cancel, confirm))
    let result = false
    const finish = (value) => { result = value; dialog.close() }
    cancel.addEventListener('click', () => finish(false))
    confirm.addEventListener('click', () => finish(true))
    dialog.addEventListener('keydown', (event) => {
      // Keep Tab inside the dialog even in browsers with a leaky top layer.
      if (event.key !== 'Tab') return
      const first = cancel
      const last = confirm
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus()
      resolve(result)
    })
    document.body.append(dialog)
    dialog.showModal() // Escape fires "cancel" then "close" with result still false
    cancel.focus()
  })
}

// ---- forms -----------------------------------------------------------------

let fieldCount = 0
/**
 * A labelled control with a hint and a place for its error.
 * `key` is the API's field path (e.g. "flavour.acidity") used to place server errors.
 */
export function field ({ key, label, control, hint, wide = false }) {
  const id = control.id || `f-${++fieldCount}`
  control.id = id
  control.dataset.fieldKey = key
  const hintEl = hint ? h('p', { class: 'hint', id: `${id}-hint`, text: hint }) : null
  const errorEl = h('p', { class: 'field-error', id: `${id}-error`, hidden: true })
  control.setAttribute('aria-describedby', [hintEl && hintEl.id, errorEl.id].filter(Boolean).join(' '))
  return h('div', { class: wide ? 'field field-wide' : 'field', data: { field: key } },
    h('label', { for: id, text: label }), control, hintEl, errorEl)
}

export function input (props) { return h('input', { type: 'text', autocomplete: 'off', ...props }) }

export function select (options, value, props) {
  const node = h('select', props || {})
  for (const [optionValue, label] of options) {
    node.append(h('option', { value: String(optionValue), text: label, selected: String(optionValue) === String(value ?? '') }))
  }
  return node
}

export function clearFieldErrors (root) {
  for (const wrapper of root.querySelectorAll('[data-field]')) {
    const error = wrapper.querySelector('.field-error')
    if (error) { error.hidden = true; error.textContent = '' }
    const control = wrapper.querySelector('[data-field-key]')
    if (control) control.removeAttribute('aria-invalid')
  }
}

/** Put each message next to its field. Returns messages that had no field on the page. */
export function showFieldErrors (root, fields) {
  const leftovers = []
  let first = null
  for (const [key, message] of Object.entries(fields || {})) {
    const wrapper = [...root.querySelectorAll('[data-field]')].find(el => el.dataset.field === key)
    if (!wrapper) { leftovers.push(message); continue }
    const error = wrapper.querySelector('.field-error')
    const control = wrapper.querySelector('[data-field-key]')
    error.textContent = message
    error.hidden = false
    if (control) { control.setAttribute('aria-invalid', 'true'); first = first || control }
  }
  if (first) first.focus()
  return leftovers
}

/** Handle a failed save: field errors in place, anything else in the alert region. */
export function showFormError (root, error, retry) {
  if (error.code === 'unauthorized') return
  if (error.fields && Object.keys(error.fields).length) {
    // Messages sit next to their fields; only ones with no field on the page need the alert.
    const leftovers = showFieldErrors(root, error.fields)
    if (leftovers.length) alertError([error.message, ...leftovers].join(' '))
  } else {
    alertError(error.message || 'Something went wrong. Please try again.', retry)
  }
}

export function pageHeader (title, ...actions) {
  return h('div', { class: 'page-header' },
    h('h1', { text: title, tabindex: '-1' }),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null)
}

/** A scrollable table. `columns` is a list of header labels (or {label, class}). */
export function table (caption, columns, rows) {
  const head = h('tr', null, columns.map(col => {
    const spec = typeof col === 'string' ? { label: col } : col
    return h('th', { scope: 'col', class: spec.class || null, text: spec.label })
  }))
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption },
    h('table', null,
      h('caption', { class: 'visually-hidden', text: caption }),
      h('thead', null, head),
      h('tbody', null, rows)))
}

export function pagination ({ offset, limit, total, count, onPage }) {
  const hasTotal = Number.isInteger(total)
  const from = count === 0 ? 0 : offset + 1
  const to = offset + count
  const more = hasTotal ? to < total : count === limit
  const summary = hasTotal ? `Showing ${from} to ${to} of ${total}` : `Showing ${from} to ${to}`
  return h('nav', { class: 'pagination', 'aria-label': 'Pages' },
    h('p', { class: 'pagination-summary', text: count === 0 ? '' : summary }),
    h('div', { class: 'pagination-buttons' },
      h('button', { type: 'button', class: 'btn', text: 'Previous', disabled: offset <= 0, on: { click: () => onPage(Math.max(0, offset - limit)) } }),
      h('button', { type: 'button', class: 'btn', text: 'Next', disabled: !more, on: { click: () => onPage(offset + limit) } })))
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Client-side check before sending. Returns a message, or null when the file is fine. */
export function imageProblem (file) {
  if (!file) return 'Choose an image file first.'
  if (!IMAGE_TYPES.includes(file.type)) return 'That file is not a JPEG, PNG or WebP image. Choose a different file.'
  if (file.size > MAX_IMAGE_BYTES) return `That image is ${(file.size / 1048576).toFixed(1)} MB. The largest allowed is 5 MB.`
  if (file.size === 0) return 'That file is empty.'
  return null
}

/**
 * Image chooser with preview and client-side checks.
 * `onUpload(file)` (optional) uploads straight away and returns the new image URL.
 * Without it the chosen file waits in `picker.file` for the caller to send.
 */
export function imagePicker ({ label, currentUrl, onUpload, pendingNote }) {
  const preview = h('div', { class: 'image-preview' })
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' })
  const uploadButton = onUpload ? h('button', { type: 'button', class: 'btn', text: 'Upload image', disabled: true }) : null
  const note = h('p', { class: 'hint', text: '' })
  let objectUrl = null
  const picker = { file: null }

  function show (url, altText) {
    if (objectUrl && objectUrl !== url) { URL.revokeObjectURL(objectUrl); objectUrl = null }
    if (url) preview.replaceChildren(h('img', { src: url, alt: altText }))
    else preview.replaceChildren(h('span', { class: 'image-none', text: 'No image yet' }))
  }
  show(currentUrl, 'Current image')

  const wrapper = field({ key: 'image', label, control: fileInput, hint: 'JPEG, PNG or WebP, up to 5 MB.' })
  const errorEl = wrapper.querySelector('.field-error')
  const setError = (message) => {
    errorEl.textContent = message || ''
    errorEl.hidden = !message
    if (message) fileInput.setAttribute('aria-invalid', 'true'); else fileInput.removeAttribute('aria-invalid')
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0] || null
    picker.file = null
    note.textContent = ''
    if (uploadButton) uploadButton.disabled = true
    if (!file) { setError(null); show(currentUrl, 'Current image'); return }
    const problem = imageProblem(file)
    if (problem) { setError(problem); fileInput.value = ''; show(currentUrl, 'Current image'); return }
    setError(null)
    picker.file = file
    objectUrl = URL.createObjectURL(file)
    show(objectUrl, 'Preview of the chosen image')
    note.textContent = onUpload ? 'Preview only. Press "Upload image" to save it.' : (pendingNote || '')
    if (uploadButton) uploadButton.disabled = false
  })

  if (uploadButton) {
    uploadButton.addEventListener('click', () => busy(uploadButton, 'Uploading…', async () => {
      if (!picker.file) return
      try {
        currentUrl = await onUpload(picker.file)
        picker.file = null
        fileInput.value = ''
        note.textContent = ''
        show(currentUrl, 'Current image')
        announce('Image uploaded.')
      } catch (error) {
        if (error.code === 'unauthorized') return
        setError(error.message || 'The image could not be uploaded.') // the server's own reason
        fileInput.focus()
      }
    }).then(() => { uploadButton.disabled = !picker.file }))
  }

  picker.setError = setError
  picker.element = h('div', { class: 'image-picker' }, preview, h('div', { class: 'image-controls' }, wrapper, uploadButton, note))
  return picker
}
