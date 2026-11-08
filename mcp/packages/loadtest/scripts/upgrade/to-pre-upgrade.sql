-- Puts penpot_upgrade_test back to the state before migrations 0158 and 0159, so run-new-migrations.sh can apply
-- them. The dev database penpot_mcpdev already has both applied (the current backend ran them there), so the copy
-- would otherwise have nothing to migrate.
--
-- Copy only: the DO block stops the script on any other database. Run by dump-and-copy-db.sh, never by hand on the
-- dev database. Each statement is idempotent (IF EXISTS), so a second run does nothing.

DO $$
BEGIN
    IF current_database() <> 'penpot_upgrade_test' THEN
        RAISE EXCEPTION 'to-pre-upgrade.sql runs only on penpot_upgrade_test, not on %', current_database();
    END IF;
END
$$;

-- Migration 0159: the two indexes it creates.
DROP INDEX IF EXISTS file_change__file_id__created_at__labelled__idx;
DROP INDEX IF EXISTS file_change__file_id__session_id__idx;

-- Migration 0158: the columns, their size checks (dropped with the columns) and the unique index.
DROP INDEX IF EXISTS access_token_profile_id_client_id_uidx;
ALTER TABLE access_token
    DROP COLUMN IF EXISTS client_name,
    DROP COLUMN IF EXISTS client_id;

-- The migration records, so the migration runner applies both again.
DELETE FROM migrations
 WHERE module = 'main'
   AND step IN ('0158-add-client-to-access-token', '0159-add-file-change-indexes');
