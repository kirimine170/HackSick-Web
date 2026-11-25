CREATE TABLE square_oauth_states (
  state_hash TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES user(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE square_connections (
  environment TEXT PRIMARY KEY CHECK(environment IN ('sandbox','production')),
  merchant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  encrypted_tokens TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  connected_by TEXT NOT NULL REFERENCES user(id)
);
