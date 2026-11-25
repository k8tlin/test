// Turns audit entries (action + before/after snapshots) into plain sentences.
import { formatPence, statusLabel, formatDateTime } from './ui.js'

const ACTION_LABELS = {
  'order.status_changed': 'Order status changed',
  'order.notes_changed': 'Internal notes updated',
  'order.payment_paid': 'Payment received',
  'order.payment_failed': 'Payment failed, order cancelled',
  'order.expired': 'Order expired unpaid, stock returned',
  'product.created': 'Product created',
  'product.updated': 'Product updated',
  'product.archived': 'Product archived',
  'product.restored': 'Product restored',
  'product.image_changed': 'Product image changed',
  'roaster.created': 'Roaster created',
  'roaster.updated': 'Roaster updated',
  'roaster.deactivated': 'Roaster deactivated',
  'roaster.reactivated': 'Roaster reactivated',
  'roaster.image_changed': 'Roaster image changed',
  'delivery_zone.created': 'Delivery zone added',
  'delivery_zone.updated': 'Delivery zone updated',
  'admin.login': 'Signed in',
  'admin.logout': 'Signed out',
  'admin.password_changed': 'Password changed',
  'admin.created_cli': 'Admin account created (command line)',
  'admin.password_reset_cli': 'Password reset (command line)'
}

const FIELD_LABELS = {
  price_pence: 'Price', fee_pence: 'Fee', stock: 'Stock', status: 'Status', name: 'Name', slug: 'Web address',
  roaster_id: 'Roaster (id)', origin_country: 'Country', origin_region: 'Region', altitude_m: 'Altitude (m)',
  roast_level: 'Roast level', weight_g: 'Weight (g)', notes: 'Tasting notes', flavour: 'Flavour scores',
  image_path: 'Image', tint: 'Tint colour', admin_notes: 'Internal notes', paid_at: 'Paid at', payment_ref: 'Payment reference',
  lat: 'Latitude', lon: 'Longitude', bag_color: 'Bag colour', label_color: 'Label colour', label_ink: 'Label ink',
  collection_enabled: 'Collection', collection_hours: 'Collection hours', active: 'Active', postcode_prefix: 'Postcode prefix'
}
const HIDDEN = new Set(['version', 'updated_at'])

export const actionLabel = (action) => ACTION_LABELS[action] || action
export const actorLabel = (entry) => entry.admin_email || (entry.admin_id ? `Admin ${entry.admin_id}` : 'System (automatic)')

export function fieldLabel (key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  const text = key.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function parseMaybeJson (value) {
  if (typeof value !== 'string' || !/^[[{]/.test(value)) return value
  try { return JSON.parse(value) } catch { return value }
}

export function formatValue (key, raw) {
  const value = parseMaybeJson(raw)
  if (value === null || value === undefined || value === '') return 'empty'
  if (key.endsWith('_pence') && Number.isInteger(value)) return formatPence(value)
  if (key === 'status') return statusLabel(value)
  if (key === 'image_path') return 'an image'
  if (key.endsWith('_at') && typeof value === 'string') return formatDateTime(value) || value
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if ((key === 'active' || key === 'collection_enabled') && (value === 0 || value === 1)) return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(', ')
  return String(value)
}

const same = (a, b) => JSON.stringify(parseMaybeJson(a)) === JSON.stringify(parseMaybeJson(b))

/** [{ label, from, to }] for every field that differs between two snapshots. */
export function changes (before, after) {
  if (!before || !after) return []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !HIDDEN.has(key))
  return keys.filter(key => !same(before[key], after[key])).map(key => ({
    key,
    label: fieldLabel(key),
    from: formatValue(key, before[key]),
    to: formatValue(key, after[key])
  }))
}

/** [{ label, value }] of a whole snapshot (for creations). */
export function snapshotRows (snapshot) {
  if (!snapshot) return []
  return Object.keys(snapshot).filter(key => !HIDDEN.has(key)).map(key => ({ label: fieldLabel(key), value: formatValue(key, snapshot[key]) }))
}

/** One-line summary for an order's timeline. */
export function orderEventText (entry) {
  if (entry.action === 'order.status_changed' && entry.before && entry.after) {
    return `Status changed from ${statusLabel(entry.before.status)} to ${statusLabel(entry.after.status)}`
  }
  return actionLabel(entry.action)
}
