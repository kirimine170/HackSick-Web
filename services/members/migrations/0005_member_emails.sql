-- 確認済みのメールだけを，単一の会員へ紐付ける．ドメイン一致だけでは付与しない．
CREATE TABLE member_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  member_id TEXT NOT NULL REFERENCES members(id),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO member_emails SELECT claim_email, id, 'member-registration', created_at FROM members;
CREATE INDEX member_emails_member ON member_emails(member_id);
