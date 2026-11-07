-- Index for the MCP write replay check: the commits of one request are found
-- by (file_id, session_id) under the file lock, so the check does not walk
-- the whole file_change table, which grows with every save.

CREATE INDEX IF NOT EXISTS file_change__file_id__session_id__idx
    ON file_change (file_id, session_id);

-- Index for the snapshot listings (the MCP snapshot pruning and the snapshot
-- lists): labelled rows only, ordered by creation within a file. The planner
-- uses a partial index when the query predicate implies it, and a LIKE on the
-- label implies that the label is not null.

CREATE INDEX IF NOT EXISTS file_change__file_id__created_at__labelled__idx
    ON file_change (file_id, created_at)
 WHERE label IS NOT NULL;

-- NOTE: on instances where file_change is large, run these statements out of
-- band, before deploying, with CONCURRENTLY instead: this migration runs inside
-- a transaction, and a plain CREATE INDEX locks the table against writes for
-- the whole build (in Penpot every file save writes a row to file_change).
