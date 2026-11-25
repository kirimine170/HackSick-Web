CREATE TABLE billing_sync_state (
  square_subscription_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  paid_until TEXT,
  invoice_id TEXT
);
