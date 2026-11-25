CREATE TABLE benefit_redemptions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK(kind IN ('LT_WAIVER', 'JOIN_STICKER', 'LOYALTY_STICKER', 'SPEAKER_STICKER', 'FIRST_TALK_COFFEE')),
  benefit_key TEXT NOT NULL,
  event_id TEXT,
  occurred_at TEXT NOT NULL,
  funding TEXT NOT NULL CHECK(funding IN ('HSAP', 'MONTHLY', 'PROMOTION')),
  internal_allocation_jpy INTEGER NOT NULL DEFAULT 0 CHECK(internal_allocation_jpy >= 0),
  confirmed_by TEXT NOT NULL REFERENCES user(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(member_id, kind, benefit_key)
);
CREATE INDEX benefit_redemptions_member ON benefit_redemptions(member_id, occurred_at);
