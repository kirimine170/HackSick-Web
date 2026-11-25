-- Squareの同じ商品バリエーションを販売する．会員用の在庫は確保しない．
CREATE TABLE member_orders (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL REFERENCES user(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  fingerprint TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  recipient_json TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','paying','paid','failed','canceled','review')),
  square_order_id TEXT UNIQUE,
  square_payment_id TEXT UNIQUE,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX member_orders_user ON member_orders(auth_user_id,created_at);
CREATE INDEX member_orders_pending ON member_orders(state,updated_at);
-- 会員ショップ内の同時決済だけを直列化する．一般EC・POSへのロックではない．
CREATE TABLE member_payment_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at TEXT NOT NULL);
INSERT INTO member_payment_lock VALUES (1,NULL,'1970-01-01T00:00:00.000Z');
