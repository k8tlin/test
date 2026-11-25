'use strict'
// Shapes sent to clients. Public views never contain internal integer ids,
// exact stock above a small threshold, token hashes or admin notes.

const { distanceTo } = require('./postcodes')

const LOW_STOCK = 3
const SHOW_STOCK_AT = 5

const mediaUrl = (name) => (name ? `/media/${name}` : null)
const roastBand = (level) => (level <= 2 ? 'light' : level === 3 ? 'medium' : 'dark')

function publicRoaster (r, place) {
  const out = {
    id: r.slug,
    slug: r.slug,
    name: r.name,
    area: r.area,
    postcode: r.postcode,
    lat: r.lat,
    lon: r.lon,
    description: r.description,
    bag_color: r.bag_color,
    label_color: r.label_color,
    label_ink: r.label_ink,
    image_url: mediaUrl(r.image_path),
    collection_enabled: !!r.collection_enabled,
    collection_hours: r.collection_hours
  }
  if (place) out.distance_miles = distanceTo(place, r.lat, r.lon)
  return out
}

function publicProduct (p, place) {
  const roaster = {
    id: p.roaster_slug,
    slug: p.roaster_slug,
    name: p.roaster_name,
    area: p.roaster_area,
    postcode: p.roaster_postcode,
    bag_color: p.roaster_bag_color,
    label_color: p.roaster_label_color,
    label_ink: p.roaster_label_ink,
    image_url: mediaUrl(p.roaster_image_path),
    collection_enabled: !!p.roaster_collection_enabled
  }
  const out = {
    id: p.slug,
    slug: p.slug,
    name: p.name,
    roaster,
    origin_country: p.origin_country,
    origin_region: p.origin_region,
    process: p.process,
    varietal: p.varietal,
    altitude_m: p.altitude_m,
    roast_level: p.roast_level,
    roast_band: roastBand(p.roast_level),
    brew: p.brew,
    notes: p.notes,
    flavour: p.flavour,
    weight_g: p.weight_g,
    price_pence: p.price_pence,
    image_url: mediaUrl(p.image_path),
    tint: p.tint,
    in_stock: p.stock > 0,
    low_stock: p.stock > 0 && p.stock <= LOW_STOCK,
    // Exact count only when it is useful to the shopper ("only 4 left").
    stock_left: p.stock <= SHOW_STOCK_AT ? p.stock : null
  }
  if (place) {
    out.distance_miles = distanceTo(place, p.roaster_lat, p.roaster_lon)
    roaster.distance_miles = out.distance_miles
  }
  return out
}

function publicOrder (order, items, collectionRoaster) {
  const out = {
    ref: order.public_ref,
    status: order.status,
    created_at: order.created_at,
    paid_at: order.paid_at,
    expires_at: order.status === 'pending_payment' ? order.expires_at : null,
    fulfilment: order.fulfilment,
    customer: { name: order.customer_name, email: order.email, phone: order.phone },
    items: items.map(i => ({
      product_id: i.product_slug,
      name: i.name_snapshot,
      roaster_name: i.roaster_name_snapshot,
      grind: i.grind,
      unit_price_pence: i.unit_price_pence,
      quantity: i.quantity,
      line_total_pence: i.unit_price_pence * i.quantity
    })),
    subtotal_pence: order.subtotal_pence,
    delivery_fee_pence: order.delivery_fee_pence,
    total_pence: order.total_pence,
    currency: 'GBP',
    collection: null,
    delivery: null
  }
  if (order.fulfilment === 'collect' && collectionRoaster) {
    out.collection = {
      roaster: {
        id: collectionRoaster.slug,
        name: collectionRoaster.name,
        area: collectionRoaster.area,
        postcode: collectionRoaster.postcode,
        collection_hours: collectionRoaster.collection_hours
      }
    }
  }
  if (order.fulfilment === 'delivery') {
    out.delivery = {
      address_line1: order.address_line1,
      address_line2: order.address_line2,
      city: order.city,
      postcode: order.postcode,
      delivery_notes: order.delivery_notes
    }
  }
  return out
}

function adminRoaster (r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    area: r.area,
    postcode: r.postcode,
    lat: r.lat,
    lon: r.lon,
    description: r.description,
    bag_color: r.bag_color,
    label_color: r.label_color,
    label_ink: r.label_ink,
    image_url: mediaUrl(r.image_path),
    collection_enabled: !!r.collection_enabled,
    collection_hours: r.collection_hours,
    active: !!r.active,
    version: r.version,
    ...(r.active_products !== undefined ? { active_products: r.active_products } : {})
  }
}

function adminProduct (p) {
  return {
    id: p.id,
    roaster_id: p.roaster_id,
    roaster_name: p.roaster_name,
    slug: p.slug,
    name: p.name,
    origin_country: p.origin_country,
    origin_region: p.origin_region,
    process: p.process,
    varietal: p.varietal,
    altitude_m: p.altitude_m,
    roast_level: p.roast_level,
    brew: p.brew,
    notes: p.notes,
    flavour: p.flavour,
    weight_g: p.weight_g,
    price_pence: p.price_pence,
    stock: p.stock,
    image_url: mediaUrl(p.image_path),
    tint: p.tint,
    status: p.status,
    version: p.version,
    created_at: p.created_at,
    updated_at: p.updated_at
  }
}

function adminOrderSummary (o) {
  return {
    id: o.id,
    ref: o.public_ref,
    status: o.status,
    customer_name: o.customer_name,
    email: o.email,
    fulfilment: o.fulfilment,
    total_pence: o.total_pence,
    item_count: o.item_count,
    created_at: o.created_at,
    paid_at: o.paid_at,
    version: o.version
  }
}

function adminOrder (o, items, collectionRoaster, allowedTransitions, audit) {
  return {
    id: o.id,
    ref: o.public_ref,
    status: o.status,
    allowed_transitions: allowedTransitions,
    customer_name: o.customer_name,
    email: o.email,
    phone: o.phone,
    fulfilment: o.fulfilment,
    collection_roaster: collectionRoaster ? { id: collectionRoaster.id, name: collectionRoaster.name, area: collectionRoaster.area } : null,
    address_line1: o.address_line1,
    address_line2: o.address_line2,
    city: o.city,
    postcode: o.postcode,
    delivery_notes: o.delivery_notes,
    items: items.map(i => ({
      product_id: i.product_id,
      roaster_id: i.roaster_id,
      name: i.name_snapshot,
      roaster_name: i.roaster_name_snapshot,
      grind: i.grind,
      unit_price_pence: i.unit_price_pence,
      quantity: i.quantity,
      line_total_pence: i.unit_price_pence * i.quantity
    })),
    subtotal_pence: o.subtotal_pence,
    delivery_fee_pence: o.delivery_fee_pence,
    total_pence: o.total_pence,
    payment_provider: o.payment_provider,
    payment_ref: o.payment_ref,
    admin_notes: o.admin_notes,
    created_at: o.created_at,
    paid_at: o.paid_at,
    expires_at: o.expires_at,
    version: o.version,
    ...(audit ? { audit: audit.map(auditEntry) } : {})
  }
}

function safeJson (text) {
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

function auditEntry (a) {
  return {
    id: a.id,
    admin_id: a.admin_id,
    admin_email: a.admin_email || null,
    action: a.action,
    entity: a.entity,
    entity_id: a.entity_id,
    before: safeJson(a.before_json),
    after: safeJson(a.after_json),
    created_at: a.created_at
  }
}

module.exports = {
  publicRoaster, publicProduct, publicOrder, adminRoaster, adminProduct, adminOrderSummary, adminOrder,
  auditEntry, mediaUrl, roastBand, LOW_STOCK, SHOW_STOCK_AT
}
