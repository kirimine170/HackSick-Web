CREATE TABLE order_notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES member_orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('buyer-paid','operator-paid','operator-review')),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','canceled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,kind)
);
CREATE INDEX order_notifications_pending ON order_notifications(state,next_attempt_at);
