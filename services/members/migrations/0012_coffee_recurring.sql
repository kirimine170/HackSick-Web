-- ショップ専用アプリの実際の許可スコープ．既存HSAPアプリは変更しない．
ALTER TABLE square_connections ADD COLUMN granted_scopes_json TEXT;
ALTER TABLE square_connections ADD COLUMN scopes_checked_at TEXT;

CREATE TABLE coffee_customers (
  auth_user_id TEXT PRIMARY KEY REFERENCES user(id),
  creation_key TEXT NOT NULL UNIQUE,
  square_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE coffee_enrollments (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL REFERENCES user(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  plan_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  recipient_json TEXT NOT NULL,
  pricing_consent_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','activating','card_required','active','action_required','review','canceled')),
  square_card_id TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_attempt_key TEXT NOT NULL,
  next_billing_date TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX coffee_enrollment_one_open ON coffee_enrollments(auth_user_id) WHERE state <> 'canceled';
ALTER TABLE member_orders ADD COLUMN purchase_kind TEXT NOT NULL DEFAULT 'one-time' CHECK(purchase_kind IN ('one-time','coffee-trial','coffee-cycle'));
ALTER TABLE member_orders ADD COLUMN coffee_enrollment_id TEXT REFERENCES coffee_enrollments(id);
ALTER TABLE member_orders ADD COLUMN coffee_cycle TEXT;
ALTER TABLE member_orders ADD COLUMN square_customer_id TEXT;
CREATE UNIQUE INDEX coffee_cycle_one_order ON member_orders(coffee_enrollment_id,coffee_cycle) WHERE coffee_enrollment_id IS NOT NULL;
CREATE INDEX coffee_due ON coffee_enrollments(state,next_billing_date);
CREATE TABLE coffee_notices (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES coffee_enrollments(id),
  kind TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('buyer','operator')),
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provider_id TEXT
);
