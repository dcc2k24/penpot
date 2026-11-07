-- One MCP token per OAuth client and profile. The hand-made token from
-- the settings page keeps client_id NULL. client_name is the name shown
-- in settings; it sits in the row so the list needs no client lookup.
ALTER TABLE access_token
  ADD COLUMN client_id   text NULL,
  ADD COLUMN client_name text NULL,
  -- Bounded in bytes: a client id comes from an HTTPS metadata document.
  ADD CONSTRAINT access_token_client_id_size
    CHECK (client_id IS NULL OR octet_length(client_id) <= 512),
  ADD CONSTRAINT access_token_client_name_size
    CHECK (client_name IS NULL OR octet_length(client_name) <= 512);

-- At most one token per client of a profile. Plain profile_id lookups
-- keep their existing index; nothing else needs a client index.
CREATE UNIQUE INDEX access_token_profile_id_client_id_uidx
    ON access_token (profile_id, client_id)
 WHERE client_id IS NOT NULL;
