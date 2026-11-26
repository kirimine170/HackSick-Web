ALTER TABLE members ADD COLUMN hsap_workspace_only INTEGER NOT NULL DEFAULT 0
  CHECK(hsap_workspace_only IN (0, 1) AND (hsap_workspace_only = 0 OR hsap_id IS NOT NULL));
