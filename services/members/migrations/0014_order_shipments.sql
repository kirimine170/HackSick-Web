CREATE TABLE order_shipments (
  order_id TEXT PRIMARY KEY REFERENCES member_orders(id),
  tracking_numbers_json TEXT NOT NULL CHECK(json_valid(tracking_numbers_json)),
  shipped_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES user(id)
);

ALTER TABLE order_notifications RENAME TO order_notifications_previous;
CREATE TABLE order_notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES member_orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('buyer-paid','operator-paid','operator-review','buyer-shipped')),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','canceled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,kind)
);
INSERT INTO order_notifications SELECT * FROM order_notifications_previous;
DROP TABLE order_notifications_previous;
CREATE INDEX order_notifications_pending ON order_notifications(state,next_attempt_at);
