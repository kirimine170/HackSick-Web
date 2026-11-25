CREATE TABLE shop_member_statuses (
  member_id TEXT NOT NULL REFERENCES members(id),
  status_key TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (member_id, status_key)
);
CREATE TABLE shop_products (
  sku TEXT PRIMARY KEY,
  square_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  unit_price_jpy INTEGER NOT NULL CHECK (unit_price_jpy > 0),
  bags INTEGER NOT NULL CHECK (bags >= 0),
  required_status TEXT,
  fulfillment_source TEXT NOT NULL CHECK (fulfillment_source IN ('hacksick','essen')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  photo BLOB,
  photo_type TEXT
);
CREATE TABLE shop_coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label TEXT NOT NULL,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 99),
  allowed_skus_json TEXT NOT NULL CHECK (json_valid(allowed_skus_json)),
  recipient_email TEXT COLLATE NOCASE,
  expires_at TEXT NOT NULL,
  account_limit INTEGER NOT NULL CHECK (account_limit > 0),
  use_limit INTEGER CHECK (use_limit > 0),
  budget_jpy INTEGER CHECK (budget_jpy > 0),
  revoked_at TEXT
);
CREATE TABLE shop_coupon_uses (
  order_id TEXT PRIMARY KEY REFERENCES member_orders(id),
  coupon_id TEXT NOT NULL REFERENCES shop_coupons(id),
  auth_user_id TEXT NOT NULL REFERENCES user(id),
  discount_jpy INTEGER NOT NULL CHECK (discount_jpy > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed'))
);
CREATE INDEX shop_coupon_usage ON shop_coupon_uses(coupon_id, auth_user_id);
ALTER TABLE member_orders ADD COLUMN fulfillment_source TEXT NOT NULL DEFAULT 'hacksick' CHECK (fulfillment_source IN ('hacksick','essen'));
ALTER TABLE member_orders ADD COLUMN square_location_id TEXT;
ALTER TABLE member_orders ADD COLUMN order_channel TEXT NOT NULL DEFAULT 'members' CHECK (order_channel IN ('members','shop'));
CREATE TABLE shop_dispatch (
  order_id TEXT PRIMARY KEY REFERENCES member_orders(id),
  planned_date TEXT,
  hold_reason TEXT
);
ALTER TABLE order_shipments ADD COLUMN carrier TEXT NOT NULL DEFAULT 'clickpost';
CREATE TABLE shop_fulfillment_staff (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1))
);
CREATE TABLE shop_operations_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES user(id),
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
