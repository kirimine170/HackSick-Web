CREATE TABLE members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  claim_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hsap_id TEXT UNIQUE,
  auth_user_id TEXT UNIQUE REFERENCES user(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operators (
  auth_user_id TEXT PRIMARY KEY REFERENCES user(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'manager')),
  created_at TEXT NOT NULL
);

CREATE TABLE membership_grants (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK(kind IN ('HSAP', 'MONTHLY')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  evidence_id TEXT NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES user(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(kind <> 'MONTHLY' OR valid_until IS NOT NULL),
  CHECK(valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX membership_grants_member ON membership_grants(member_id);
CREATE UNIQUE INDEX membership_grants_evidence ON membership_grants(member_id, kind, evidence_id, valid_from);

CREATE TABLE billing_links (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  square_customer_id TEXT NOT NULL,
  square_subscription_id TEXT NOT NULL UNIQUE,
  confirmed_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL
);
CREATE INDEX billing_links_member ON billing_links(member_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES user(id),
  action TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_member_time ON audit_log(member_id, created_at);
