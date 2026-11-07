# Backend-native MCP review: read commands, scopes, authentication, sessions, limits

Reviewer area: `BRA`. Commits `2c33b0ff9a`, `541f965bf1` on `perf/render-wasm-large-files`.
Method: read-only. Nothing was run. "Confirmed" means confirmed by reading the code. Where a run is still
needed to size an effect, the finding says so.

## Verdict

The RPC layer is sound: MCP tokens are denied by default, every opened command declares a scope, the new read
commands check the profile and the file as the human path does, and the render restriction inside RPC is tight.
The render session is not confined outside RPC, which breaks the scope boundary (BRA-01). The other weak points
are the scope model (one token shared by all clients, scopes only grow), a page cache bounded by entry count
and not by size, and limits whose numbers do not match how the bucket script and the adapter behave.

## How enforcement works (question 1)

Wrapper order, outermost first (`backend/src/app/rpc.clj:432-446`): authentication, params validation, session
restriction, MCP scope, nitrate SSO, audit, rlimit, metrics, climit, retry, cond, db transaction.

- `wrap-authentication` (`rpc.clj:187-239`): a request with token type `mcp` is refused unless the command has
  `::rpc/token-type "mcp"` or `::rpc/allow-token-types #{"mcp"}`. A command with no metadata is **denied** to
  MCP tokens. Commands with `::rpc/token-type "mcp"` refuse sessions and personal tokens.
- `wrap-mcp-scope` (`rpc.clj:241-250`): only for MCP tokens. The scope is `::rpc/mcp-scope` (a string or a
  function of the merged params). When absent it is `mcp:read` (`rpc.clj:177-185`).
- Token lookup (`backend/src/app/http/access_token.clj:30-48`): one primary-key query per request, expiry in
  SQL, issuer must match the row type. Revocation, expiry and scope edits apply on the next request.

Commands an MCP token may call (read from the metadata; this matches the contract table):

| Scope | Commands |
|---|---|
| `mcp:read`, explicit | `get-profile`, `get-teams`, `get-team`, `get-projects`, `get-all-projects`, `get-project`, `get-project-files`, `get-team-recent-files`, `get-team-deleted-files`, `get-team-shared-files`, `get-file-info`, `get-file-summary`, `get-file-stats`, `get-file-plugin-data`, `get-file-tokens`, `get-file-libraries`, `get-page`, `search-files`, `get-comment-threads`, `get-comment-thread`, `get-comments`, `get-file-snapshots`, `get-font-variants`, `export-binfile` |
| `mcp:read`, by default (no `::mcp-scope`) | `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session`, `send-mcp-feedback` |
| `mcp:read` when `dry-run`, else `mcp:write` | `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg` |
| `mcp:write` | `upload-file-media-object`, `create-file-media-object-from-url`, `create-comment-thread`, `create-comment`, `update-comment`, `update-comment-thread`, `update-comment-thread-status`, `update-comment-thread-position`, `update-comment-thread-frame`, `delete-comment-thread`, `delete-comment`, `create-file-snapshot`, `restore-file-snapshot`, `update-file-snapshot`, `delete-file-snapshot`, `lock-file-snapshot`, `unlock-file-snapshot` |
| `mcp:manage` | `create-team`, `update-team`, `create-project`, `rename-project`, `update-project-pin`, `create-file`, `rename-file`, `set-file-shared`, `duplicate-file`, `duplicate-project`, `move-files`, `move-project`, `link-file-to-library`, `unlink-file-from-library`, `restore-deleted-team-files`, `import-binfile` |
| `mcp:delete` | `delete-project`, `delete-file` |

The opened human commands run the same handler as the cookie path, so their team, project and file checks are
identical. The eight new read commands call `check-access!` (`mcp.clj:180-183`): profile not blocked and
active, then `files/check-read-permissions!`. A file of another team answers `:not-found`. Inside RPC I found
no command reachable with a weaker check than the cookie path.

---

## Findings

### BRA-01 (critical, confirmed): the render-session restriction holds only inside RPC

Location: `backend/src/app/rpc.clj:274-290` (the only enforcement point);
`backend/src/app/http/session.clj:283-294` (`assoc-session`);
`backend/src/app/http/mcp_oauth.clj:176-182`, `:395-399`; `backend/src/app/http/debug.clj:897-911`, `:972`;
`backend/src/app/http/websocket.clj:307-353`; `backend/src/app/rpc/commands/mcp.clj:1102-1138`.

What is wrong. `create-mcp-render-session` needs only `mcp:read` and returns an ordinary session cookie token
whose row carries `props :mcp-render`. `wrap-session-restriction` narrows it for RPC commands. But
`session/assoc-session` still sets `::session/profile-id` and `::session/session`, so every other route behind
`session/authz` sees a normal login. Three such routes exist:

- The MCP OAuth approval endpoints. `session-binding` asks only for a profile id. An approval made with a
  render session adds scopes to the profile's MCP token (`access_token.clj:131-145`), which is the same token
  that minted the session. The consent page is never shown to the user.
- `/dbg/*`, for profiles in `:admins` and for any profile on a devenv host.
- `/ws/notifications`, where the profile may subscribe to any team or file it can read, not only the
  session's files.

Why it matters. The first route turns `mcp:read` into `mcp:write`, `mcp:manage` and `mcp:delete` without the
user. Scopes and consent are the safety boundary of this feature, so this is a full bypass of it. The existing
tests cover the restriction on RPC routes only (`rpc_mcp_read_test.clj:815-890`).

Recommended change.
1. Enforce in `session/wrap-authz`, deny by default: a session with `:mcp-render` sets `::session/profile-id`
   only on routes that opt in through route data (the RPC routes and `/assets`). Elsewhere it authenticates as
   nobody.
2. Defence in depth: `mcp_oauth/session-binding` refuses a session with `:mcp-render` props.
3. Longer term, give render tokens their own issuer so `session/decode-token` rejects them wherever they are
   not expected.
4. Tests: a render token on `/api/mcp/oauth/request`, `/api/mcp/oauth/decision`, `/dbg` and
   `/ws/notifications` must answer as unauthenticated.

Effort: S for 1, 2 and 4; M for 3.

### BRA-02 (high, mechanism confirmed, size suspected): the page cache is bounded by count, not by memory

Location: `backend/src/app/rpc/commands/mcp.clj:204-226`; `backend/src/app/util/cache.clj:50-61`;
`common/src/app/common/types/objects_map.cljc:527-538`.

What is wrong. `page-cache` holds up to 256 whole pages for 10 minutes, keyed `[file-id page-id revn]`.
`cache/create` uses Caffeine `maximumSize`, an entry count. Each value is a full page whose lazy objects map
keeps both the encoded shapes and every shape decoded so far (`valAt` memoises). The key carries the file
revision, so every write to any page of the file makes the next read store a fresh copy of the page while the
old copies wait out their 10 minutes.

Cost scenario. An agent that alternates a write and a `find-mcp-shapes` on a 100,000-shape page stores one
fully decoded page per cycle. At one cycle every ten seconds that is 60 live copies. If one decoded page is a
few hundred megabytes, the heap is gone and the backend stops for every user. Smaller pages reach the same
place more slowly: 256 entries of 50 MB are 12 GB.

Second effect: a write on page B drops the cached page A (new `revn`), so an unchanged 100,000-shape page is
fetched and decoded again after every unrelated write.

Recommended change. Key on the page's pointer id (`pmap/get-id`) when the page is a pointer map. A persisted
pointer id names fixed content (`pointer_map.clj:176-189`), so an unchanged page is one entry across all
revisions. Bound the cache by weight (shape count or blob bytes): add a `:weigher` option to
`app.util.cache/create`. Consider `expireAfterAccess` and a smaller total.

What would confirm the size: heap per cached page for the 100,000-shape file after a full `find`.
Effort: M.

### BRA-03 (high, confirmed): one token for all clients, and approvals only add scopes

Location: `backend/src/app/rpc/commands/access_token.clj:98-145`; `backend/src/app/http/mcp_oauth.clj:189-195`,
`:246-259`, `:320-333`; `frontend/src/app/main/ui/mcp_authorize.cljs` (`extra-scopes`);
test `mcp_oauth_http_test.clj:322-344` pins the behaviour.

What is wrong. A profile has one MCP token. Every OAuth client receives that same secret. An approval unions
the requested scopes into the token (`grant-mcp-scopes`), and nothing removes one. So:

- A client approved for read last month gains write and delete the day the user approves another client for
  them. The consent page tells the user what the new client will also receive; it does not say that clients
  approved earlier gain the new scopes.
- A client that asks for `mcp:read` is handed a token that may hold every scope. There is no downgrade.
- One client cannot be revoked. Regenerating the token cuts off all of them.

This follows the contract ("never removes any"), so it is a design finding, not a coding slip.

Recommended change. Issue one `access_token` row per approval (per client), with its own perms and expiry,
and list them in settings so each can be revoked. If the single token stays for now: say on the consent page
that already connected clients gain the scopes, and reset scopes to the request when no other grant is live.
Effort: L for per-client tokens, S for the wording.

### BRA-04 (medium, confirmed): the "MCP server" switch in settings does not stop a token

Location: `frontend/src/app/main/ui/settings/integrations.cljs:483-504`;
`backend/src/app/rpc/commands/access_token.clj:113-114`; no reader of `:mcp-enabled` in `rpc.clj` or `mcp.clj`.

What is wrong. The switch writes `props.mcp-enabled`. In plugin mode that stopped the browser bridge. In
backend mode nothing reads it: with the switch off, the token still reads and writes files, with no browser
open. Also, the new commands have no instance flag of their own: an instance with `access-tokens` on and
`mcp` off still serves them (`http/access_token.clj:56-59`, unchanged here).

Failure scenario. A user turns MCP off, sees "disabled", and an agent keeps editing their files.

Recommended change. In `check-profile!` (and in the write path) refuse with `:mcp-disabled` when the profile
prop is false; or make the switch delete the token. Add a flag that gates backend-mode commands.
Effort: S.

### BRA-05 (medium, confirmed by reading; a soak run would show it): hourly buckets do not refill under steady use, and human buckets are shared

Location: `backend/resources/rlimit.edn:318-331`; `backend/src/app/rpc/rlimit/bucket.lua:23-29`;
`backend/src/app/rpc/rlimit.clj:93-95`, `:176-180`.

What is wrong.
1. The script works in whole seconds and adds `floor(delta * rate)` tokens, and it moves the timestamp on each
   allowed request. `6000/3000/1h` is 0.83 tokens per second: with one or more allowed requests per second the
   refill is always `floor(0.83) = 0`. The read bucket is then a flat 6,000 calls per command and profile,
   after which the agent gets about one call every two seconds. `1200/600/1h` for writes needs a gap of six
   seconds to gain one token. The module's own docstring says to use `:window` for long intervals.
2. The adapter's limiter allows 10 requests per second (contract, "Adapter auth and limits"). The backend
   sustains under one. A long session meets 429s that the adapter did not predict.
3. Buckets are keyed by command and profile. The opened human commands keep their UI buckets, so an agent and
   its owner share them: `get-projects` (120/60/30s), `create-comment` (30/15/1m), `search-files` (60/30/1m).
   An agent that loops on one of them makes the owner's dashboard or comments answer 429.

Recommended change. Express the MCP limits per second or per minute (for example `600/300/1m`), or as
`:window`. Align them with the adapter limiter. For opened human commands, key the bucket by auth type as well
(`<profile>.mcp`), so an agent cannot spend its owner's UI budget.
Effort: S for the numbers, M for the key.

### BRA-06 (medium, confirmed): responses are bounded by item count, not by bytes

Location: `mcp.clj:600-603`, `:685-695`, `:731-736` (shapes: 2,000 full shapes); `:595-603` (tree: 5,000 nodes,
any `fields`); `:1043-1094` (tokens: no bound, tokens listed twice, once as `:tokens` and once as `:dtcg`);
`backend/src/app/rpc/commands/files.clj:470-471` (`get-page` opened to MCP tokens).

What is wrong. `get-mcp-shapes` returns whole shape maps: path `:content`, text `:content`, `:position-data`.
`fields` on both commands is any keyword, so `get-mcp-page-tree` with `fields [content position-data]` and
`limit 5000` returns the heavy attrs for 5,000 nodes. `get-page` returns a whole page with no bound and is
open to read tokens, though the adapter does not call it. A large reply is built in memory, then encoded.

Cost scenario. 2,000 path shapes of 50 KB each are a 100 MB reply. Four of them at once per profile, sixteen
across the instance.

Recommended change. Add a byte budget per reply (stop, set `truncated`, return a cursor). Keep heavy attrs out
of the tree. Close `get-page` to MCP tokens unless a caller needs it. Give `get-mcp-tokens` a `set-id` filter
and return either the list or the DTCG form, not both.
Effort: M.

### BRA-07 (medium, confirmed): a page-tree cursor dies on any write to the file

Location: `mcp.clj:567-593` (`cursor->index`), `:657-658`.

What is wrong. The cursor carries the file `revn`. A write to any page, by anyone, makes it stale, and the
caller must start again. Each page of the walk also rebuilds the full pre-order of the subtree (`:638`).

Failure scenario. A 100,000-shape page read at 500 nodes per call needs 200 calls. With a person editing the
file, or with the agent's own writes in between, the walk never ends. The "5 agents on one file" case hits
this on every paged read.

Recommended change. Bind the cursor to the page's pointer id, so only a change to that page makes it stale. Or
continue from the last node id and report `changed: true`.
Effort: S to M.

### BRA-08 (medium, confirmed): concurrency limits leave little room for people and are not keyed by file

Location: `backend/resources/climit.edn:81-91`; `backend/src/app/rpc/climit.clj:296-299`, `:337-370`; the
`::climit/id` and `::db/transaction true` on each command in `mcp.clj`; `mcp_write.clj:684-686`.

What is wrong.
- MCP commands also take the root limits. `:mcp-read/global` 16 plus `:mcp-apply/global` 10 can hold 26 of the
  40 `:root/global` permits. People are left with 14.
- `find-mcp-shapes` may burn five seconds of CPU per call (`mcp.clj:744-746`). Sixteen at once fill sixteen
  cores. No limit is keyed by file, so many profiles can search the same large file together.
- Every read runs in a transaction and holds a pooled connection through the decode and the search. The reads
  gain nothing from it: the isolation is read committed and they write nothing (bar a migration).
- Writes take `:update-file/by-profile` (one permit), the limiter of the editor's own saves. While an agent's
  9.5 s bulk write runs, its owner's editor saves on any file wait behind it.
- The file's comment says the production `climit.edn` lives outside the repository and that an id without an
  entry runs with no limiter. If production is not updated, the MCP ids do nothing.

Recommended change. Lower the global shares (for example 8 and 6). Add a per-file limiter on `find`. Drop the
transaction from the read commands, or open the connection only around the queries. Give agent writes their
own by-profile limiter. Assert at startup that every declared climit id has an entry.
Effort: S to M.

### BRA-09 (medium, confirmed): settings can neither show nor remove `mcp:manage` and `mcp:delete`

Location: `frontend/src/app/main/ui/settings/integrations.cljs:418-466`.

What is wrong. The token settings show one switch, for `mcp:write`. `mcp-scopes-with-write` keeps `manage` and
`delete` when the token has them, and nothing displays them. A user who once approved a client for delete has
no place to see that the key can delete, and no way to take it back short of regenerating the key (which
BRA-03 makes a cut for every client).

Recommended change. List all four scopes with a switch each, or at least show the held scopes with a "reduce
to read only" action.
Effort: S.

### BRA-10 (medium to low, confirmed; cost on files without pointer-map suspected): each read loads and decodes the file root again

Location: `mcp.clj:187-202` (`load-file-data`), `:180-183`, `:358-366`, `:407-447`.

Round trips for one page read: token row, profile, permissions, file row with data, applied migrations, page
fragment; then one audit insert when the audit log is on. That matches the 4 to 5 the report counted inside
the command.

What a cache would remove:
- `bfc/get-file` reads and decodes the root blob on every call: tokens library, colours, typographies, the
  component and page pointers. On a file without `fdata/pointer-map` it is the whole file, and the report
  lists that case as not measured. A `get-minimal-file` probe for `revn`, then a cache of the decoded root by
  `[file-id revn vern]`, removes it. Permissions are checked first either way.
- `mcp-whoami` runs `sql:token-expiry`; the middleware already put `::actoken/expires-at` on the request.
- The outline runs `fragment-modified-at`, which returns a row for every fragment of the file, old ones too,
  only to build cache keys. Persisted pointer ids already name fixed content. Drop the query or filter it by
  the page pointer ids.
- A cold outline loads every page one after another (N+1) to count shapes, and the 10 minute expiry repeats
  that for an unchanged file. Store the counts with the page or do not expire by time.
- `get-mcp-library` sorts every component on each call.

The caches are per instance and keyed by content or revision, so several instances stay correct; each warms
alone.
Effort: M.

### BRA-11 (low, confirmed): refused calls leave no MCP metric and no audit event

Location: `rpc.clj:432-446` (order); `mcp.clj:124-161` (`run-tool`).

Scope refusals, validation errors, rate-limit and concurrency rejections are raised by wrappers outside the
audit wrapper and outside `run-tool`. `penpot_mcp_errors_total`, the `mcp-tool` log line and the audit log see
none of them. An operator cannot count scope refusals per token, the signal that matters most here.

Recommended change. Count and log `:mcp-scope-required` and `:session-restricted` in the wrappers, with the
token fingerprint.
Effort: S.

### BRA-12 (low, confirmed): the scope default fails open for future commands

Location: `rpc.clj:177-185`.

An opted-in command with no `::rpc/mcp-scope` needs only `mcp:read`. All 60-odd opened commands declare one
today; nine MCP-only reads rely on the default. A later change that opens a mutating command and forgets the
scope gives it to read-only tokens, and no test would fail.

Recommended change. In `process-method`, throw at startup when a command has `::token-type "mcp"` or
`::allow-token-types` and no `::mcp-scope`. Add a test that walks the method table and compares it with an
expected map of command to scope.
Effort: S.

### BRA-13 (low, confirmed; "unused" rests on a grep of the adapter): scope names against what they allow

Location: metadata in `comments.clj:685-757`, `files_snapshot.clj:116-258`, `files.clj:1142-1143`,
`management.clj:357-429`; `frontend/translations/en.po:9759-9772`.

- `mcp:write` is shown as "Create and modify designs". It also deletes comments and threads, deletes
  versions, restores a version (which replaces the whole file) and fetches URLs into the file.
- `mcp:manage` also unshares a library (`set-file-shared false`) and moves files and projects to another
  team. Both remove things from where teammates expect them.
- Opened but not called by the adapter (no literal use in `mcp/packages/server/src`): `get-page`,
  `export-binfile`, `get-file-libraries`, `get-file-tokens`, `get-file-plugin-data`, `get-file-stats`,
  `get-file-summary`, `get-file-info`, `get-font-variants`, `get-profile`, `get-all-projects`, `get-project`,
  `get-team`, `get-comment-thread`, `update-comment`, `update-comment-thread-status`,
  `update-comment-thread-frame`. Each is surface with no user.

Recommended change. Move the deleting and restoring commands under `mcp:delete`, or fix the consent text.
Close the commands nothing calls.
Effort: S.

### BRA-14 (low, confirmed): reads that can mislead an agent

- `get-mcp-library` (`mcp.clj:994-1034`) cuts each kind at `limit` (default 500, max 5,000) with no
  `truncated` flag, no total and no cursor. The agent takes a partial list for the whole.
- `find-mcp-shapes` takes `type` as any keyword (`:909`). `rectangle` in place of `rect` returns no matches
  and no error. Use an enum of the shape types.
- `get-mcp-tokens` accepts `resolve` and ignores it (`:1041`). Drop it or refuse it.
- Error codes mix prefixed and plain names (`:mcp-invalid-cursor`, `:page-not-found`, `:object-not-found`).
  A missing fragment answers 500 (`fdata.clj:282-287`).
- A regex that overflows the stack on a very long name is not caught by `hit?` (`:834-843`) and answers 500.

Effort: S.

### BRA-15 (low, confirmed; older design, higher stakes now): token lifetime and handling

Location: `backend/src/app/config.clj:210`; `access_token.clj:68-70`, `:205-217`;
`frontend/src/app/main/ui/settings/integrations.cljs:485`.

MCP tokens do not expire unless `:mcp-token-max-age` is set. The secret is stored in clear in `access_token`,
returned again by `get-access-tokens`, and placed in the MCP URL as `?userToken=`. This was accepted when the
token could only talk to a browser plugin. It now carries write and delete.

Recommended change. Default the max age (for example 90 days). Send the token in a header, not in the URL.
Effort: S to M.

### BRA-16 (low, suspected): organisation SSO and MCP callers

Location: `rpc.clj:346-430`; `backend/src/app/nitrate.clj:586-606`.

With the admin console on, `wrap-nitrate-sso` checks the session's `:sso` props. A token request has no
session, and a render session has none of those props, so calls on files of an SSO organisation should fail
with `:nitrate-sso-required`. But the positive result is cached for 15 minutes by `[profile-id ref]`, not by
credential, so the same call passes when the owner's browser touched that file on that instance a moment
before. The outcome depends on timing and on the instance. A run with nitrate on would confirm it.

Recommended change. Decide the policy for MCP tokens in SSO organisations and state it; put the credential
kind in the cache key.
Effort: S.

### BRA-17 (low, confirmed): render-session housekeeping

Location: `session.clj:265-281`, `:382-398`; `mcp.clj:1117-1133`.

- A render session outlives the revocation of the token that minted it, by up to 10 minutes.
- Expired render rows stay in `http_session_v2` until the idle GC, seven days later.
- The session is not bound to the token id, so the audit trail cannot tie a render read to a token.

Recommended change. Store the token id in the props; on use, check that the token still exists. Let the GC
delete render rows past their own age.
Effort: S.

### BRA-18 (low, confirmed): idiom and dead code

- `::audit/skip false` on every command is the default (`rpc.clj:299-311`); remove it.
- `check-profile!` copies the check in `feedback.clj`; `load-page` copies the pointer deref in
  `files/get-page` (`files.clj:432-437`). Share one helper.
- `page-cache` and `outline-cache` are `def`; `rpc.clj:346` uses `defonce` for its cache.
- The docstring of `load-page` says "Decodes the page on every call" though its only hot caller caches it.
- `outline-cache` keys carry `modified-at`, which the pointer id makes redundant (see BRA-10).
- `default-library-kinds` and the `:enum` in `schema:library` repeat the same four strings.

Effort: S.

---

## Tests that are missing (question 7)

1. A render token on non-RPC routes: OAuth approval, `/dbg`, `/ws/notifications` (BRA-01).
2. Render session with widening params: `get-team {id}`, `get-font-variants {team-id}` or `{project-id}`,
   `get-file` of another id, `get-file-fragment` of another file. The code handles them (`rpc.clj:257-272`);
   only `get-page` of another file is tested.
3. `find-mcp-shapes` and `get-mcp-library` are absent from the other-team test
   (`rpc_mcp_read_test.clj:741-754`).
4. No test with a viewer role, a deleted file, or a profile removed from the team.
5. MCP-only commands refused for a session and for a personal token.
6. A table test of command to scope; `delete-file` and `delete-project` need `mcp:delete`; `mcp:manage` does
   not grant delete.
7. An expired or deleted MCP token over HTTP on an MCP command.
8. A cursor after a write to another page (pins BRA-07 either way).
9. Cache bounds: no test that entries of old revisions are dropped.
10. Every declared climit id has an entry in `climit.edn`; rlimit behaviour of the MCP buckets.
11. `mcp-enabled false` and a token call (pins BRA-04 either way).

## Strengths worth keeping

- Deny by default for MCP tokens, and MCP-only commands that refuse sessions and personal tokens.
- Opened commands reuse the human handlers, so permission logic exists once.
- `check-profile!` on every MCP read; other-team files answer `:not-found`.
- Scope check after params validation, so a function scope (`dry-run`) sees the merged params.
- Render restriction inside RPC: fixed command list, file set from the server, param-widening cases closed,
  never renewed, absolute age checked on the row and in the token.
- OAuth: exact redirect match, S256 only, single-use code bound to client, redirect and verifier, request
  bound to the first session, CSRF value plus origin check, `no-store` replies, no token in logs.
- Token issuer must match the row type; revocation and scope edits apply at once.
- The regex deadline through a `CharSequence`, and the five-second search budget.
- Logs carry a token fingerprint, never the token; audit props name ids, never content.
- Cursor validation (shape, page, root, depth, range).
- Outline cache keyed by pointer id: the right key, and the model for the page cache.

## Questions only a run can settle

1. Heap held by one cached 100,000-shape page after a full `find`, and the heap curve of a write-then-read
   loop over ten minutes (BRA-02).
2. Bucket behaviour at a steady 2 to 5 requests per second for an hour (BRA-05).
3. Read cost on a large file without `fdata/pointer-map`, and with a tokens library of several thousand
   tokens (BRA-10).
4. Cold outline time and statement count on a file of 100 pages.
5. p95 of human `get-file` and `update-file` while 16 `find-mcp-shapes` run on large files (BRA-08).
6. Reply size and encode time of `get-mcp-shapes` with 2,000 path shapes (BRA-06).
7. MCP calls and exports on files of an SSO organisation (BRA-16).
8. Whether the frontend consent page and the settings switch render as intended (the frontend was not built).
