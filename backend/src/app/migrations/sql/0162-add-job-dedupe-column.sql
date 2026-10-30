-- Dedupe jobs: at most one not-started job per key.
--
-- A job submitted with `::jobs/dedupe` or `::jobs/debounce` is marked as
-- dedupe, and the database admits a single `new` row for each (tenant,
-- name, queue, label). The submit no longer deletes the pending row
-- before inserting: the unique index decides, and the insert resolves it
-- with `ON CONFLICT`. `dedupe` leaves the pending row alone and skips the
-- insert; `debounce` refreshes its `scheduled_at` and `params` in place,
-- so the work keeps its id and its event history.
--
-- The predicate is `status = 'new'` and not the live set of the
-- `exclusive` column: a row that was already dispatched, is running or
-- waits for a retry leaves the index, and a new submit of the same key is
-- admitted. The status never changes inside the upsert, so the row that
-- is refreshed stays in the index.
--
-- `dedupe` is false by default, so the rows that were never submitted
-- with the option (including every row that exists when this migration
-- runs) stay out of the index: it starts empty and no cleanup of
-- duplicates is needed. The label stays a label.

ALTER TABLE job
    ADD COLUMN dedupe boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS job__new_dedupe__uniq
    ON job (tenant, name, queue, label)
    WHERE dedupe
      AND status = 'new';

-- NOTE: on instances with a large `job` table, run the statement above out
-- of band, before deploying, with CONCURRENTLY instead: this migration runs
-- inside a transaction, and a plain CREATE INDEX locks the table against
-- writes for the whole build (in Penpot every webhook-producing file save
-- inserts a job), while CONCURRENTLY does not. Run it on its own, not inside
-- a transaction block:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS job__new_dedupe__uniq
--       ON job (tenant, name, queue, label)
--    WHERE dedupe
--      AND status = 'new';
--
-- A CONCURRENTLY build interrupted midway leaves the index INVALID: drop it
-- and retry. Verify with:
--
--   SELECT indexdef FROM pg_indexes
--    WHERE indexname = 'job__new_dedupe__uniq';
--   SELECT indisvalid FROM pg_index
--    WHERE indexrelid = 'job__new_dedupe__uniq'::regclass;
--
-- Once the index exists, this migration finds it and does nothing.
