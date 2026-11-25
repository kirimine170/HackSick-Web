ALTER TABLE membership_grants ADD COLUMN revocation_source TEXT CHECK(revocation_source IS NULL OR revocation_source IN ('operator','square-sync'));
