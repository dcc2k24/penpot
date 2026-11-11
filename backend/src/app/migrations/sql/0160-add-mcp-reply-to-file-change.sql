-- The reply of an MCP write (the created ids and the per-operation results),
-- kept on the first change row of the call so that a retry of the request
-- gets the same answer. The column is separate from `data`, which belongs to
-- the legacy file data backend: the file restore treats a row with `data` as
-- durable history, and this row must expire like the other change rows.
--
-- Adding a nullable column with no default does not rewrite the table in
-- PostgreSQL: it only changes the catalog, so this is safe on a large
-- file_change table. Old rows, and rows written by an older backend process,
-- keep NULL here, and an older process never selects the column.

ALTER TABLE file_change
  ADD COLUMN IF NOT EXISTS mcp_reply bytea NULL;
