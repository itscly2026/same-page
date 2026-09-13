-- Run only while ALL authentication writes and in-flight requests are stopped.
-- Keep migrated schema and every post-upgrade record. Supported providers only.
CREATE TABLE auth_rollback_guard (valid INTEGER NOT NULL CHECK(valid = 1));
INSERT INTO auth_rollback_guard SELECT CASE WHEN EXISTS (
  SELECT 1 FROM account WHERE provider_id NOT IN ('credential', 'google')
    OR (issuer IS NOT NULL AND issuer != CASE provider_id
      WHEN 'credential' THEN 'local:credential'
      WHEN 'google' THEN 'https://accounts.google.com' END)
) THEN 0 ELSE 1 END;
UPDATE account SET issuer = CASE provider_id
  WHEN 'credential' THEN 'local:credential'
  WHEN 'google' THEN 'https://accounts.google.com' END
WHERE issuer IS NULL;
DROP TABLE auth_rollback_guard;
