-- One Shelf schema. Money is integer pence. Timestamps are ISO 8601 UTC strings.
-- Applied idempotently at every startup (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS roasters (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  area               TEXT NOT NULL,
  postcode           TEXT NOT NULL,
  lat                REAL NOT NULL,
  lon                REAL NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  bag_color          TEXT NOT NULL DEFAULT '#F4F1EA',
  label_color        TEXT NOT NULL DEFAULT '#F4F1EA',
  label_ink          TEXT NOT NULL DEFAULT '#111114',
  image_path         TEXT,
  collection_enabled INTEGER NOT NULL DEFAULT 1 CHECK (collection_enabled IN (0, 1)),
  collection_hours   TEXT NOT NULL DEFAULT '',
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY,
  roaster_id     INTEGER NOT NULL REFERENCES roasters (id),
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  origin_country TEXT NOT NULL DEFAULT '',
  origin_region  TEXT NOT NULL DEFAULT '',
  process        TEXT NOT NULL DEFAULT '',
  varietal       TEXT NOT NULL DEFAULT '',
  altitude_m     INTEGER,
  roast_level    INTEGER NOT NULL CHECK (roast_level BETWEEN 1 AND 5),
  brew           TEXT NOT NULL CHECK (brew IN ('espresso', 'filter', 'both')),
  notes          TEXT NOT NULL DEFAULT '[]',
  flavour        TEXT NOT NULL DEFAULT '{}',
  weight_g       INTEGER NOT NULL DEFAULT 250 CHECK (weight_g > 0),
  price_pence    INTEGER NOT NULL CHECK (price_pence >= 0),
  stock          INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_path     TEXT,
  tint           TEXT NOT NULL DEFAULT '#9A765F',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_roaster_idx ON products (roaster_id);
CREATE INDEX IF NOT EXISTS products_status_idx ON products (status);

CREATE TABLE IF NOT EXISTS delivery_zones (
  postcode_prefix TEXT PRIMARY KEY,
  fee_pence       INTEGER NOT NULL CHECK (fee_pence >= 0),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS orders (
  id                    INTEGER PRIMARY KEY,
  public_ref            TEXT NOT NULL UNIQUE,
  access_token_hash     TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending_payment', 'paid', 'preparing', 'ready_for_collection',
                          'out_for_delivery', 'completed', 'cancelled', 'refunded', 'expired')),
  customer_name         TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  fulfilment            TEXT NOT NULL CHECK (fulfilment IN ('collect', 'delivery')),
  collection_roaster_id INTEGER REFERENCES roasters (id),
  address_line1         TEXT,
  address_line2         TEXT,
  city                  TEXT,
  postcode              TEXT,
  delivery_notes        TEXT,
  subtotal_pence        INTEGER NOT NULL CHECK (subtotal_pence >= 0),
  delivery_fee_pence    INTEGER NOT NULL CHECK (delivery_fee_pence >= 0),
  total_pence           INTEGER NOT NULL CHECK (total_pence >= 0),
  payment_provider      TEXT NOT NULL,
  payment_ref           TEXT,
  admin_notes           TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  paid_at               TEXT,
  expires_at            TEXT,
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, expires_at);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);

CREATE TABLE IF NOT EXISTS order_items (
  id                    INTEGER PRIMARY KEY,
  order_id              INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id            INTEGER NOT NULL REFERENCES products (id),
  roaster_id            INTEGER NOT NULL REFERENCES roasters (id),
  name_snapshot         TEXT NOT NULL,
  roaster_name_snapshot TEXT NOT NULL,
  grind                 TEXT NOT NULL,
  unit_price_pence      INTEGER NOT NULL CHECK (unit_price_pence >= 0),
  quantity              INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 12)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,
  admin_id     INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  csrf_secret  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  email              TEXT PRIMARY KEY,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  consent_at         TEXT NOT NULL,
  consent_source     TEXT NOT NULL,
  consent_text       TEXT NOT NULL,
  confirm_token_hash TEXT,
  unsubscribed_at    TEXT
);
CREATE INDEX IF NOT EXISTS subscribers_token_idx ON subscribers (confirm_token_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  admin_id    INTEGER REFERENCES admin_users (id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity, entity_id);
