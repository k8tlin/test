'use strict'
// Orders and order items. Fixed SQL, bound parameters only.

module.exports = function ordersRepo (db) {
  return {
    insertOrder (o) {
      return db.run(`
        INSERT INTO orders (public_ref, access_token_hash, status, customer_name, email, phone, fulfilment,
                            collection_roaster_id, address_line1, address_line2, city, postcode, delivery_notes,
                            subtotal_pence, delivery_fee_pence, total_pence, payment_provider, payment_ref,
                            admin_notes, created_at, paid_at, expires_at, version)
        VALUES (:public_ref, :access_token_hash, 'pending_payment', :customer_name, :email, :phone, :fulfilment,
                :collection_roaster_id, :address_line1, :address_line2, :city, :postcode, :delivery_notes,
                :subtotal_pence, :delivery_fee_pence, :total_pence, :payment_provider, NULL,
                '', :created_at, NULL, :expires_at, 1)`, o).lastInsertRowid
    },
    insertItem (i) {
      db.run(`
        INSERT INTO order_items (order_id, product_id, roaster_id, name_snapshot, roaster_name_snapshot, grind,
                                 unit_price_pence, quantity)
        VALUES (:order_id, :product_id, :roaster_id, :name_snapshot, :roaster_name_snapshot, :grind,
                :unit_price_pence, :quantity)`, i)
    },
    refExists (ref) {
      return !!db.get('SELECT 1 AS x FROM orders WHERE public_ref = :ref', { ref })
    },
    getById (id) {
      return db.get('SELECT * FROM orders WHERE id = :id', { id }) || null
    },
    getByRef (ref) {
      return db.get('SELECT * FROM orders WHERE public_ref = :ref', { ref }) || null
    },
    /** Items with the public product slug (customers never see integer ids). */
    listItems (orderId) {
      return db.all(`
        SELECT i.*, p.slug AS product_slug, r.slug AS roaster_slug
        FROM order_items i JOIN products p ON p.id = i.product_id JOIN roasters r ON r.id = i.roaster_id
        WHERE i.order_id = :order_id ORDER BY i.id`, { order_id: orderId })
    },
    setPaymentRef (id, ref) {
      db.run('UPDATE orders SET payment_ref = :ref WHERE id = :id', { id, ref })
    },
    /** Status change guarded by both the expected current status and the version. */
    setStatus (id, fromStatus, version, toStatus, paidAt) {
      return db.run(`
        UPDATE orders SET status = :to_status, paid_at = COALESCE(:paid_at, paid_at), version = version + 1
        WHERE id = :id AND status = :from_status AND version = :version`,
      { id, from_status: fromStatus, version, to_status: toStatus, paid_at: paidAt ?? null }).changes === 1
    },
    setNotes (id, version, notes) {
      return db.run('UPDATE orders SET admin_notes = :notes, version = version + 1 WHERE id = :id AND version = :version',
        { id, version, notes }).changes === 1
    },
    listOverdue (now) {
      return db.all(`SELECT * FROM orders WHERE status = 'pending_payment' AND expires_at IS NOT NULL AND expires_at <= :now`,
        { now })
    },
    search (f) {
      const params = {
        status: f.status ?? null,
        date_from: f.from ?? null,
        date_to: f.to ?? null,
        q: f.q ?? null
      }
      const total = db.get(`
        SELECT COUNT(*) AS n FROM orders o
        WHERE (:status IS NULL OR o.status = :status)
          AND (:date_from IS NULL OR o.created_at >= :date_from)
          AND (:date_to IS NULL OR o.created_at < :date_to)
          AND (:q IS NULL OR o.public_ref LIKE :q ESCAPE '\\' OR o.email LIKE :q ESCAPE '\\'
               OR o.customer_name LIKE :q ESCAPE '\\')`, params).n
      const rows = db.all(`
        SELECT o.*, (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count
        FROM orders o
        WHERE (:status IS NULL OR o.status = :status)
          AND (:date_from IS NULL OR o.created_at >= :date_from)
          AND (:date_to IS NULL OR o.created_at < :date_to)
          AND (:q IS NULL OR o.public_ref LIKE :q ESCAPE '\\' OR o.email LIKE :q ESCAPE '\\'
               OR o.customer_name LIKE :q ESCAPE '\\')
        ORDER BY o.created_at DESC, o.id DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit: f.limit, offset: f.offset })
      return { total, rows }
    },
    countsByStatus () {
      return db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')
    },
    todayStats (dayStart, dayEnd) {
      return db.get(`
        SELECT COUNT(*) AS orders,
               COALESCE(SUM(CASE WHEN status IN ('paid', 'preparing', 'ready_for_collection', 'out_for_delivery', 'completed')
                                 THEN total_pence ELSE 0 END), 0) AS revenue_pence,
               COALESCE(SUM(CASE WHEN status IN ('paid', 'preparing', 'ready_for_collection', 'out_for_delivery', 'completed')
                                 THEN 1 ELSE 0 END), 0) AS paid_orders
        FROM orders WHERE created_at >= :day_start AND created_at < :day_end`, { day_start: dayStart, day_end: dayEnd })
    }
  }
}
