-- Inserts 100,000 synthetic file_change rows for one file, so the index migrations (0159 and the others) run on a
-- table of realistic size. Run by seed.sh with: psql -v file_id=<uuid> -f seed-file-change.sql
--
-- Copy only: the DO block stops the script on any other database.
-- Idempotent: rows that an earlier run wrote (data_backend = 'synthetic-seed') are deleted first.
-- Each row carries 1 KB of data; every 100th row is labelled (the labelled partial index then has rows to index).
-- Columns follow the migrations: id, file_id, created_at, session_id, revn, data, changes, profile_id, features,
-- label, data_backend, data_ref_id. Only the ones without a default are set here.

DO $$
BEGIN
    IF current_database() <> 'penpot_upgrade_test' THEN
        RAISE EXCEPTION 'seed-file-change.sql runs only on penpot_upgrade_test, not on %', current_database();
    END IF;
END
$$;

DELETE FROM file_change
 WHERE file_id = :'file_id'::uuid
   AND data_backend = 'synthetic-seed';

INSERT INTO file_change (file_id, created_at, revn, data, label, data_backend)
SELECT :'file_id'::uuid,
       clock_timestamp() - ((100000 - n) * interval '1 second'),
       n,
       convert_to(repeat('x', 1024), 'UTF8'),
       CASE WHEN n % 100 = 0 THEN 'synthetic-' || n ELSE NULL END,
       'synthetic-seed'
  FROM generate_series(1, 100000) AS n;

ANALYZE file_change;

SELECT count(*) AS synthetic_rows,
       count(label) AS labelled_rows,
       pg_size_pretty(pg_total_relation_size('file_change')) AS file_change_size
  FROM file_change
 WHERE file_id = :'file_id'::uuid
   AND data_backend = 'synthetic-seed';
