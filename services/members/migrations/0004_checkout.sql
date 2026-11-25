-- 会員販売用に確保し，一般ストア・POSの販売可能在庫から除いた袋だけを登録する．
CREATE TABLE checkout_stock (
  pool TEXT PRIMARY KEY CHECK(pool = 'coffee'),
  allocated_bags INTEGER NOT NULL DEFAULT 0 CHECK(allocated_bags >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO checkout_stock VALUES ('coffee', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL REFERENCES user(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  fingerprint TEXT NOT NULL,
  bags INTEGER NOT NULL CHECK(bags > 0),
  quote_json TEXT NOT NULL,
  create_payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','open','paid','canceled','review')),
  square_link_id TEXT UNIQUE,
  square_order_id TEXT UNIQUE,
  square_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX checkouts_user_time ON checkouts(auth_user_id, created_at);
CREATE INDEX checkouts_pending ON checkouts(state, expires_at);
CREATE TABLE checkout_webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE shop_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES user(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
