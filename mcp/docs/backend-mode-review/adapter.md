# Review: TypeScript MCP adapter (without the sandbox)

Scope: `mcp/packages/server` at `541f965bf1`, the files named in the brief. Read-only: nothing was run, built or
edited. Paths below are relative to `mcp/packages/server/` unless they start with another root. "Confirmed" means
confirmed by reading the code; it does not mean observed in a run.

## Verdict

The adapter is well built at the small scale: one small class per tool, one HTTP client, tokens never stored raw,
no write retries, caps on bodies in both directions and a broad test suite. Its weak side is behaviour under real
clients and real load: a client that gives up does not stop the work, nothing makes a retried write safe, large
bodies are parsed before any credential is checked, and queues and responses are bounded in bytes or not at all.
Agent-facing text has several places where the schema, the instructions and the backend disagree.

## Answers to the nine questions

1. **Architecture.** The mode split is clean. `PenpotMcpServer` decides once in the constructor and in `initTools`
   (`src/PenpotMcpServer.ts:237-312`, `:437-478`); tools never branch on the mode, apart from
   `HighLevelOverviewTool`. `createMcpHandler` builds a fresh `McpServer` per HTTP request (`:292`, `:483-494`), so
   the MCP layer holds no session. A call flows: Express JSON parser → `McpAuthentication.authenticate` →
   `AsyncLocalStorage` with the token → SDK validates the zod shape → `Tool.execute` → `BackendTool.executeCore`
   (rate limit, `mcp-whoami` cached 60 s) → `executeBackend` → `PenpotBackendClient.callCommand` (writes go through
   `FileWriteQueue`). A new tool costs about 40 lines, one line in `BackendToolSet` and a count in one test.
   Coupling is low: tools see `BackendServices` only. Weak points: ADP-01, ADP-14, ADP-22.
2. **Multi-user and scale.** State in the process, all keyed by the SHA-256 of the token: validator cache (60 s,
   pruned on each call), rate-limit buckets (swept every 256 calls), write-queue tails (dropped when idle), render
   sessions (pruned on each call), sandboxes (50, LRU, 30 min). No path lets one token read another token's entry.
   Hundreds of sessions are fine for the maps; the risks are memory per call (ADP-02, ADP-04, ADP-13) and the
   per-instance state (ADP-11).
3. **HTTP client.** One timeout per call (`AbortSignal.timeout`), no retries of any kind, `redirect: "manual"`,
   response cap 64 MB with a streaming count, full buffering, global `fetch` pool. Errors keep the backend code and
   hint. No cancellation (ADP-01). See also ADP-13, ADP-20.
4. **Write ordering.** One FIFO per `(token digest, file id)`, in the process. A failure does not stop later
   entries. No depth cap, no wait deadline, no cancellation (ADP-01, ADP-04). The token catalogue read sits
   outside the queue (ADP-03).
5. **Security.** Token handling in logs and errors is careful. Open points: ADP-02, ADP-08, ADP-09, ADP-12,
   ADP-14, ADP-18, ADP-21.
6. **Tool design.** Names and the "Next:" hints are good. Open points: ADP-05, ADP-06, ADP-07, ADP-10, ADP-15,
   ADP-16, ADP-17, ADP-19. The adapter schemas are loose on purpose (`props` is any map, `looseObject`
   everywhere) and the backend is strict (`common/src/app/common/mcp/operations.cljc:719` closes the props map),
   so a wrong prop key costs one round trip, not a silent no-op.
7. **Performance.** Per-call overhead is small: five SHA-256 digests, one cached validation, one zod pass by the
   SDK and one discriminated-union pass per operation. The costs that matter are in ADP-03 (full token catalogue
   per call), ADP-06 (page export), ADP-13 (copies of large bodies).
8. **Best practice.** `strict` is on; `any` appears only as `Tool<any>`; casts of backend answers are unchecked
   but local. See ADP-22.
9. **Tests.** Listed at the end.

## Findings

### ADP-01: A client that gives up does not stop the work, and a retried write is applied twice
- Severity: high. Confidence: confirmed (code); the client-side timing is suspected and a run would confirm it.
- Location: `src/PenpotMcpServer.ts:490`; `src/PenpotBackendClient.ts:175-181`; `src/backend/FileWriteQueue.ts:28-43`;
  `src/tools/backend/WriteOptions.ts:37-39`; `src/backend/BackendSettings.ts:4`;
  `src/tools/backend/ImportArchiveBackendTool.ts:77`.
- What is wrong: the tool callback is `async (args) => tool.instance.execute(args)`. The SDK passes a second
  argument with an abort signal for the request; the adapter drops it. Backend calls only carry
  `AbortSignal.timeout`. A queued write that has not started cannot be withdrawn. `requestId` is a label for
  snapshots and logs (`backend/src/app/rpc/commands/mcp_write.clj:580`), not an idempotency key. The SDK's own
  default client request timeout is 60 s; the adapter's backend timeout is 120 s, `execute_code` may run 120 s and
  `import_archive` 15 minutes. No tool sends progress, so in the handler's default `auto` response mode the
  response is plain JSON with no keep-alive bytes.
- Failure: an agent sends a bulk write behind six queued writes to the same file. The client times out at 60 s
  and reports a failure. The write still commits. The agent retries; both copies are applied and the page holds
  every shape twice. The same happens to `import_archive` (two files) and to a proxy with a 60 s idle timeout.
- Recommended change: pass the request signal through `Tool.execute` to `BackendTool` and combine it with the
  timeout (`AbortSignal.any`). Drop a queued write whose signal fired before it started; never abort a write that
  was sent. Send progress for tools that can pass a few seconds (this also turns the response into SSE with
  keep-alive). Make `requestId` an idempotency key: remember `(token, requestId) → result` for some minutes in the
  adapter, or better in the backend. Keep the default backend timeout under the common client timeout.
- Effort: M.

### ADP-02: A 32 MB JSON body is read and parsed before any credential is looked at
- Severity: high in multi-user or remote mode, low on a local machine. Confidence: confirmed.
- Location: `src/PenpotMcpServer.ts:521` (parser), `:498-515` (authentication after it); `src/utils/BodyLimit.ts:9`.
- What is wrong: before this commit the parser was `express.json()` with Express's 100 kB default. It is now
  32 MB for every request to `/mcp`, and it runs before `authenticate`. The SDK's own 4 MiB bound is skipped
  because the body arrives as `parsedBody`. Without OAuth no token is required at this layer at all.
- Abuse: anyone who can reach the port posts 32 MB JSON bodies in a loop. Each one is buffered, turned into a
  string and parsed on the event loop. A few dozen parallel posts hold gigabytes and stall every session of
  every user; no token is needed.
- Recommended change: check the `Authorization` header (syntax, then the cached `validate`) before the body is
  read. Keep a small default limit (1 to 4 MB) and allow the large limit only for authenticated requests, or
  move image and archive bytes off JSON-RPC (an upload endpoint, or `url`).
- Effort: S for the order and the two limits, M for an upload path.

### ADP-03: The token catalogue is read outside the write queue, and in full on every call
- Severity: medium. Confidence: confirmed.
- Location: `src/tools/backend/ApplyOperationsTool.ts:104-114`; `src/sandbox/ApplyTokenValues.ts:52-56`;
  `data/backend_instructions.md:161` ("Parallel calls are safe").
- What is wrong: `tokenValues.fill` calls `get-mcp-tokens` before `callWrite` puts the write in the queue. The
  guard for "a token write earlier in the same batch" does not cover a token write earlier in the queue.
  `execute_code` fills under the queue hold; `apply_operations` does not. Filling also runs before
  `validator.validate`, so an invalid batch still costs a backend read. The catalogue is the whole token set of
  the file, with the DTCG export, and nothing caches it between calls.
- Failure: the agent sends two calls at once. Call A changes `color.brand` to a new value. Call B applies
  `color.brand` without `resolvedValue`. B reads the old value while A is in flight, then runs after A and writes
  the old value on the shape. Nothing warns; the shape no longer matches its token.
- Recommended change: run fill and validation inside the queued task. Better, let the backend resolve the value
  inside the write transaction and delete the TypeScript resolver from this path. Until then cache the catalogue
  per `(token, file, revn)`.
- Effort: S for the order, L to move resolution to the backend.

### ADP-04: Queues have no depth limit and waiting calls hold their payloads
- Severity: medium. Confidence: confirmed.
- Location: `src/backend/FileWriteQueue.ts:28-43`; `src/utils/Semaphore.ts:45-58`;
  `src/tools/backend/ImportArchiveBackendTool.ts:83`, `:135-155`; `src/utils/ExportConcurrency.ts:58-63`.
- What is wrong: the write queue, the export gate and the import gate accept any number of waiters and have no
  wait deadline. The backend timeout starts only when the call starts. `import_archive` decodes the archive
  before it asks for one of the two permits, so every waiter holds its decoded bytes and its base64 text. The
  only brake is the rate limit of 10 calls per second per token, which counts calls, not bytes. The export gate
  is one FIFO for all users.
- Cost: one token sends ten `import_archive` calls a second with 30 MB bodies; two run for up to 15 minutes
  each, the rest wait with about 55 MB apiece. Or one token queues 300 exports and every other user waits behind
  them.
- Recommended change: cap the depth per key and in total and answer "busy, retry" beyond it; add a wait
  deadline; take the import permit before decoding; give each token a share of the export gate.
- Effort: M.

### ADP-05: Response limits are sized in bytes, not in tokens, and JSON is pretty-printed
- Severity: medium. Confidence: confirmed for the limits; the token counts are an estimate.
- Location: `src/tools/backend/BackendTool.ts:19`, `:138-140`, `:152-158`; `src/tools/backend/GetPageTreeTool.ts:33-39`;
  `src/tools/backend/GetShapesTool.ts:15-19`, `:27-30`; `src/tools/backend/ListFilesTool.ts:25-33`.
- What is wrong: every answer is `JSON.stringify(value, null, 2)` and is cut only above 1 MB, which is some
  250,000 tokens. `get_page_tree` returns 500 nodes with 15 fields by default (about 200 kB pretty-printed) and
  allows 5,000. `get_shapes` returns every attribute of up to 200 shapes, and every descendant with
  `includeChildren`. `list_files` for a project and `comments list` have no limit at all. Indentation alone adds
  a fifth or more to nested answers.
- Cost: a default `get_page_tree` on a busy page can pass the output limit of common clients or eat a large part
  of the context window, and the agent learns that only after paying for it.
- Recommended change: print compact JSON; lower the cap to a token-sized figure (for example 60 to 100 kB) and
  the default page of `get_page_tree` to about 100 nodes; make `fields` default to a short list in `get_shapes`;
  add `limit` and a cursor to the unpaged lists.
- Effort: S for format and defaults, M for paging.

### ADP-06: Export output: PDF and SVG have no inline cap, images may be 8 MB, page export is slow and wasteful
- Severity: medium. Confidence: confirmed.
- Location: `src/tools/backend/ExportShapeBackendTool.ts:15`, `:41`, `:209-238`, `:403-409`, `:426-430`.
- What is wrong: the inline size check skips `svg` and `pdf`, so either may return up to the 64 MB response cap
  as text (a PDF as base64 inside JSON). Raster images pass up to 8 MB (10.7 MB as base64), above what model
  APIs take per image. A page export renders up to ten shapes one after another, each with its own 120 s
  timeouts for the exporter and the download, checks the 8 MB total only after each render, and throws away
  everything rendered if a later shape fails. `scale` goes to 10 with no pixel limit.
- Cost: `export_shape` of a detailed board as SVG or PDF floods the context with megabytes of text. A page
  export of ten boards can outlast the client timeout (see ADP-01).
- Recommended change: cap inline SVG and PDF (for example 256 kB) and point to `filePath` or a resource link;
  downscale inline rasters with `sharp` to a fixed pixel and byte budget; return partial page results with the
  error; bound `scale × size` from the shape box that `readShape` already fetches.
- Effort: M.

### ADP-07: Truncation by the adapter leaves `nextCursor` pointing past the nodes it dropped
- Severity: medium. Confidence: confirmed (code); the size at which it triggers needs a run.
- Location: `src/tools/backend/BackendTool.ts:152-205`; `src/tools/backend/GetPageTreeTool.ts:93-94`.
- What is wrong: `get_page_tree` returns the backend page through `jsonResponse`. Above 1 MB the envelope keeps
  the same leading count of every array and copies the rest of the object, `nextCursor` included. The cursor
  was made by the backend for the full page, so it starts after nodes the adapter removed. The note names the
  cut arrays but does not say that the cursor skips them.
- Failure: `limit: 5000` on a large page. The answer is cut to a few hundred nodes per array. The agent follows
  `nextCursor` and never sees the rest of the first window; it works on an incomplete tree without knowing it.
- Recommended change: when the adapter truncates a paged answer, drop `nextCursor` and tell the agent to repeat
  the call with a smaller `limit`; or shrink `limit` and ask the backend again.
- Effort: S.

### ADP-08: With OAuth the token is checked only on `initialize`
- Severity: medium. Confidence: confirmed.
- Location: `src/McpAuthentication.ts:243-245`, `:255-270`; `src/PenpotMcpServer.ts:506-511`.
- What is wrong: `InitializeTokenCheck` answers 401 with a `WWW-Authenticate` challenge only for a request whose
  method is `initialize`. The handler is stateless and also serves the 2026 protocol era, where a client need
  not send `initialize` at all. A token that expires or is revoked later is found by `BackendTool`, which
  returns a tool error inside a 200 response.
- Failure: an OAuth access token expires during a session. Every tool call fails with "The MCP token was
  rejected". The client's OAuth layer never sees a 401, so it does not refresh the token; the user must
  reconnect by hand.
- Recommended change: in OAuth mode validate every request with the cached validator (one backend call per
  token per minute) and answer 401 with the challenge on rejection.
- Effort: S.

### ADP-09: The token in the query string is accepted by default, and the error text recommends it
- Severity: medium. Confidence: confirmed.
- Location: `src/backend/BackendSettings.ts:58`; `src/McpAuthentication.ts:83`, `:144-152`;
  `src/tools/backend/BackendTool.ts:44-47`.
- What is wrong: `PENPOT_MCP_ALLOW_QUERY_TOKEN` defaults to `true`. In bridge mode the token only matched a
  request to an open browser tab. In backend mode it is a bearer credential that can write and delete on its
  own. URLs reach proxy logs, shell history and client configuration files. The missing-token error tells the
  caller to use the query parameter.
- Recommended change: default to `false` when the mode is `backend` or `both`, or at least in multi-user mode;
  remove the query parameter from the error text.
- Effort: S.

### ADP-10: The agent cannot read the parameters of an operation
- Severity: medium. Confidence: confirmed.
- Location: `src/tools/backend/ApplyOperationsTool.ts:15-27`, `:78-102`;
  `src/tools/backend/operations/OperationSchemas.ts:169-211`, `:251-525`.
- What is wrong: the published input schema of `apply_operations` is `{op: string}` plus anything. The 75
  operation schemas, with their descriptions of font variants, token types, overrides and child index, are used
  only by `OperationValidator`; `describe()` text never reaches an error message or the tool list. The tool
  description ends with "Read the schema of an op from the error message if a parameter is rejected". The op
  list is kept by hand in four places: the zod table, the tool description, `backend_instructions.md` and the
  CLJC schema.
- Cost: for each op the agent has not used it guesses, fails, reads the error and tries again. The font and
  token rules are never shown.
- Recommended change: add a small read tool or MCP resource (`describe_operations {ops}`) that returns
  `z.toJSONSchema` of the named entries of `OPERATION_SCHEMAS`; build the op list in the description from
  `OPERATION_NAMES`; add a test that pins the TypeScript names to the CLJC names.
- Effort: M.

### ADP-11: State per token lives in one process; several instances change behaviour
- Severity: medium. Confidence: confirmed.
- Location: `src/backend/BackendServices.ts:38-46`; `src/tools/backend/ExecuteCodeBackendTool.ts:145`;
  `data/backend_instructions.md:161`, `:209-211`, `:229-232`; `mcp/README.md:363-367` (Redis covers the bridge only).
- What is wrong: the MCP layer needs no sticky session, which is good. But the write queue, the rate limiter,
  the sandbox `storage`, the call slots and the export gate are per process. Behind a round-robin balancer the
  promises in the instructions stop holding: "writes to one file run one after another", "no other write of
  this server lands between" the chunks of an `execute_code` flush, and `storage` kept per token. The rate
  limit becomes N times the configured value. The write queue is also keyed by token, not by profile, so a
  refreshed OAuth token starts a second queue for the same user.
- Failure: two instances. A script stores ids in `storage`; the next call lands on the other instance and
  finds it empty.
- Recommended change: document that backend mode needs routing by a hash of the `Authorization` header, and
  log a warning when `PENPOT_MCP_REDIS_URI` is set in backend mode. Later: key the queue by profile id and move
  the limiter to Redis.
- Effort: S to document, L for shared state.

### ADP-12: The export directory defaults to the whole home directory, and files are overwritten
- Severity: medium (local mode only). Confidence: confirmed.
- Location: `src/utils/ExportDirectory.ts:19-28`, `:37-47`, `:54-66`; `src/utils/FileUtils.ts:16-21`, `:29-43`;
  `src/tools/backend/ExportShapeBackendTool.ts:393-402`.
- What is wrong: without `PENPOT_MCP_EXPORT_DIR` any path under the home directory is accepted. `writeFileSync`
  replaces an existing file without a word and missing folders are created. The extension is not tied to the
  format. `realPathOf` steps over a dangling symbolic link (`existsSync` is false for it), so the check passes
  and the write then follows the link out of the root.
- Abuse: text in a design file tells the agent to "save the export to `~/.ssh/config`" or over a document. The
  file is replaced with SVG or PNG bytes. SVG text comes from the design, so part of the content is the
  attacker's.
- Recommended change: default to a dedicated folder (for example `~/penpot-exports`); refuse to overwrite unless
  an `overwrite` flag is set; require an extension that matches the format; use `lstat` on each path part and
  open with `wx` when not overwriting.
- Effort: S.

### ADP-13: A large backend answer is held in memory several times
- Severity: medium. Confidence: suspected. A run with a 64 MB answer and a heap profile would confirm it, and
  would show whether the backend's own limits make such an answer possible.
- Location: `src/PenpotBackendClient.ts:296-325`; `src/tools/backend/BackendTool.ts:152-180`;
  `src/backend/BackendSettings.ts:12`.
- What is wrong: `readBody` keeps the chunks and a joined copy, decodes to a string, and `JSON.parse` builds the
  tree. `formatJson` prints it, parses the text again when it is over 1 MB, and the binary search prints a
  trimmed copy up to log2(n) times. Nothing limits how many calls do this at once across tokens.
- Cost: a handful of users reading large pages at the same moment can take the process past its heap limit; the
  crash ends every session.
- Recommended change: lower the default cap for JSON commands (8 MB is far above the 1 MB that is ever
  returned); trim the parsed value directly instead of printing and reparsing; add a global gate for calls with
  large answers.
- Effort: S to M.

### ADP-14: No Host or Origin check in front of the handler
- Severity: low for backend mode. Confidence: confirmed.
- Location: `src/PenpotMcpServer.ts:496-523`.
- What is wrong: the SDK states that `createMcpHandler` does no validation and tells the caller to put
  `hostHeaderValidationResponse` and `originValidationResponse` in front of it. The server does not. Backend
  tools are safe today only because each needs a token from the caller and the server holds none. In `both`
  mode, which is implied whenever `PENPOT_MCP_BACKEND_URI` is set, the plugin tools on the same endpoint take no
  token in single-user mode, so a web page that rebinds DNS to `localhost:4401` can run code in the user's open
  Penpot tab. That part predates this feature.
- Recommended change: add the two SDK checks with the localhost defaults when the host is a loopback name.
- Effort: S.

### ADP-15: `allowSplit` is described as several transactions; the contract says one
- Severity: low. Confidence: confirmed.
- Location: `src/tools/backend/ApplyOperationsTool.ts:28-34`; `src/tools/backend/ExecuteCodeBackendTool.ts:43-49`;
  against `data/backend_instructions.md:142-144` and `mcp/docs/backend-mode-contract.md:238-241`.
- What is wrong: the schema text says "commit large batches in several transactions" and "On failure the
  response names lastCommittedRevn", which reads as a partial commit. The contract and the instructions say all
  batches commit in one transaction and a failed call changes nothing.
- Cost: the agent either avoids the option or, after a failure, re-reads the file to find what was applied.
- Recommended change: fix both texts. Since the split no longer changes what the agent sees, consider taking the
  option out of the agent-facing schema and letting the backend decide.
- Effort: S.

### ADP-16: `depth` of `get_page_tree` is off by one against the backend
- Severity: low. Confidence: confirmed in the two texts; `ExportShapeBackendTool.ts:264-270` uses `depth: 2` to
  get the direct children, which agrees with the backend's reading.
- Location: `src/tools/backend/GetPageTreeTool.ts:18-24`; `backend/src/app/rpc/commands/mcp.clj:606-608`.
- What is wrong: the tool says "How many levels of children to include below the start shape". The backend says
  "down to `depth` levels (the root is level 1)". `depth: 1` returns the start shape alone.
- Recommended change: correct the description, or add one in the adapter.
- Effort: S.

### ADP-17: Tools carry no MCP annotations
- Severity: low. Confidence: confirmed.
- Location: `src/PenpotMcpServer.ts:471-477`, `:490`.
- What is wrong: `registerTool` gets a description and an input schema only. No `readOnlyHint`,
  `destructiveHint` or `idempotentHint`. Clients use these to let reads pass without a prompt and to ask before
  `manage_files delete_project` or `manage_versions restore`.
- Recommended change: add an `annotations()` method to `Tool` with a safe default, and set it per tool.
- Effort: S.

### ADP-18: Local mode: the archive URL check can be bypassed by DNS, and file reads are not confined
- Severity: low (local mode only). Confidence: confirmed for the code paths.
- Location: `src/tools/backend/ImportArchiveBackendTool.ts:182-195`, `:252-273`;
  `src/utils/PublicAddressPolicy.ts:21-34`, `:56-80`; `src/tools/backend/ImportImageBackendTool.ts:249-262`.
- What is wrong: `assertPublicHost` resolves the name, then `fetch` resolves it again; a name that answers first
  with a public address and then with `127.0.0.1` passes. The block list lacks `64:ff9b::/96`, `2002::/16`,
  `198.18.0.0/15`, `192.0.0.0/24`, multicast and `240.0.0.0/4`. The status code of the download comes back in
  the error, which is enough to probe ports. `filePath` reads any absolute path; the image tool uploads it only
  if it is an image, the archive tool uploads any zip (a `.docx` is one), and "File not found" tells the agent
  which paths exist. Reads of up to 200 MB are synchronous.
- Recommended change: connect to the address that was checked (an undici `Agent` with a fixed `lookup`); widen
  the list; give reads a root as exports have; read with `fs.promises`.
- Effort: M.

### ADP-19: Small disagreements between tool texts, schemas and instructions
- Severity: low. Confidence: confirmed.
- Location and detail:
  - `src/tools/backend/ImportImageBackendTool.ts:18`, `:191` and `data/backend_instructions.md:178`: "Up to
    50 MB", but `base64` stops at 24 MB of text (about 18 MB of image), the only path in remote mode.
  - `src/tools/backend/FindShapesTool.ts:16-22`: `type` is a free string, not an enum; `rectangle` and `svg_raw`
    pass here and match nothing, while `src/tools/backend/operations/BatchTreeExpander.ts:41-51` accepts them.
  - `src/tools/backend/GetTokensTool.ts:12-15`: `resolve` is published and does nothing.
  - `data/backend_instructions.md:172-174` says to use `execute_code` only as a last resort; `:201-202` says to
    use it for loops and many shapes.
  - `data/backend_instructions.md:160`: the rate limit is stated as 10 and 20, but both are settings.
- Recommended change: make `type` an enum with the aliases; drop `resolve`; state one rule for `execute_code`;
  correct the size text.
- Effort: S.

### ADP-20: The global `fetch` pool sets limits the settings do not show
- Severity: low. Confidence: suspected; it rests on the default 300 s header and body timeouts of Node's
  `fetch`. A run with a backend that stays silent for six minutes would confirm it.
- Location: `src/PenpotBackendClient.ts:175-181`; `src/tools/backend/ImportArchiveBackendTool.ts:77`;
  `src/backend/BackendSettings.ts:43-47`.
- What is wrong: no dispatcher is configured. `PENPOT_MCP_BACKEND_TIMEOUT_S` above 300 and the 15 minute import
  timeout are cut at 300 s whenever the backend sends nothing for that long, and the error then reads "got no
  response (HeadersTimeoutError)". The number of sockets per origin has no limit.
- Recommended change: create one undici `Agent` for the backend and one for the exporter with explicit
  timeouts and a connection limit.
- Effort: S.

### ADP-21: Calls with unknown tokens are not rate limited
- Severity: low. Confidence: confirmed.
- Location: `src/tools/backend/BackendTool.ts:49-50`; `src/backend/BackendTokenValidator.ts:74-91`, `:106-113`;
  `src/backend/TokenRateLimiter.ts:53-69`.
- What is wrong: the bucket is keyed by the token as sent, before it is validated, and a rejected token is not
  cached. Each new random token gets a full bucket and causes one `mcp-whoami` call. `pruneExpired` walks the
  whole map on every call.
- Abuse: a flood of random tokens turns into the same number of backend calls, past the per-token limit.
- Recommended change: cache rejections for a few seconds; add a limit per client address for failed
  validations, or state that a reverse proxy must provide it.
- Effort: S.

### ADP-22: Configuration, cleanup and typing details
- Severity: low. Confidence: confirmed.
- Detail:
  - `src/PenpotMcpServer.ts:247-250`: ports are `parseInt` without a check; `NaN` reaches `listen`.
  - `src/backend/BackendSettings.ts:74-81`: a bad `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` falls back silently while
    every other setting throws. `src/PenpotBackendClient.ts:82` reads the environment in a default parameter;
    `src/PenpotMcpServer.ts:265` does not pass `backendSettings.maxResponseMb`, though it does for the exporter.
  - `src/utils/ExportDirectory.ts:19-28`: a bad `PENPOT_MCP_EXPORT_DIR` is found at the first export, not at start.
  - `src/PenpotMcpServer.ts:577-592`: `stop()` does not call `sandboxes.stop()` or `dispose()`; `httpServer.close`
    waits without a deadline, so a 15 minute import blocks shutdown.
  - `src/PenpotMcpServer.ts:28-33`: backend modules load in bridge mode too, so a bridge-only server imports
    QuickJS and reads `data/fonts.json` at import (`src/sandbox/FontCatalog.ts:35`) and fails to start without it.
  - `src/McpAuthentication.ts:154-159`: the note "does not validate userToken against the backend" is no longer
    true in backend mode.
  - `src/Tool.ts:80`: expected failures (rate limit, bad arguments) are logged at error level.
  - `src/tools/backend/ManageFilesTool.ts:237`: `args.fileId!` relies on each `fileScoped` entry listing `fileId`
    in `requires`; a new entry that forgets it queues under the key `…:undefined`.
  - `src/backend/ExporterClient.ts:462-470`: `snippetOf` reads the whole error body without the cap.
  - `package.json`: `class-validator` and `class-transformer` are not imported anywhere in `src` (older than
    this feature).
- Effort: S.

## Strengths worth keeping

- The per-request, stateless MCP handler with the token in `AsyncLocalStorage`, and the test that overlaps two
  tokens on one request id (`PenpotMcpServer.http.test.ts`).
- Raw tokens never enter a map or a log: SHA-256 keys, 12-character fingerprints, and a test that the token is
  absent from error messages.
- No retries on any backend call, and a no-response error that says the write may have been applied.
- `redirect: "manual"` on every call; the render cookie follows at most one same-origin redirect; asset ids are
  checked as UUIDs before they enter a URL.
- Response caps that count while streaming and cancel early, on the backend client and the exporter client.
- One class per tool over a thin `BackendTool`; `ManageFilesTool`'s action table; "Next:" hints in descriptions.
- `OperationValidator`: a discriminated union, errors that name the index, the op and the field, and the
  `cloneId` trap for a renamed key.
- File and URL arguments are removed from the published schema in remote mode, and checked again at run time.
- In-flight sharing of token validation and render-session mints; caches that prune themselves.
- Settings that fail at start with the variable name in the message.

## Tests that are missing

- The HTTP endpoint with an oversized body, with and without a token (ADP-02).
- A cancelled or disconnected client during a queued write and during a running one (ADP-01).
- `apply_operations` with `apply_token` queued behind a token write to the same file (ADP-03).
- Queue depth and waiting memory: many writes to one file, many imports (ADP-04).
- `get_page_tree` where the adapter truncates an answer that carries `nextCursor` (ADP-07).
- Inline size of SVG and PDF exports (ADP-06).
- OAuth: a token that the backend starts to reject after `initialize`, and a modern-era client that never sends
  `initialize` (ADP-08).
- `import_archive`: a redirect whose second hop is a private address; a name that changes its address between
  the check and the fetch (ADP-18).
- `ExportDirectory`: an existing symbolic link, a dangling one, and an existing target file (ADP-12).
- A test that pins `OPERATION_NAMES` to the CLJC operation names and to the list in the tool description.
- Backend tools over real HTTP with two tokens writing to the same file.
- `stop()` with a call in flight.

## Questions that only a run can settle

- Does the SDK abort the request signal when the HTTP client disconnects in per-request mode, and what does a
  60 s client see when the backend answers at 90 s?
- Token size of default answers: `get_page_tree` at 500 nodes, `get_shapes` for 200 shapes, and the raw
  `get-teams`, `get-projects` and `get-project-files` answers that the list tools pass through unchanged.
- How the recursive `z.lazy` schema of `batch_create_shapes` is published in `tools/list`, and whether common
  clients accept it. What a deeply nested `children` chain does to zod's recursive parse.
- Peak memory for one 64 MB backend answer, and whether the backend can produce one.
- Cost per request of building a `McpServer` and registering about 24 tools in the stateless handler.
- Whether `import-binfile` stays silent for more than 300 s on a large archive (ADP-20).
- How long a 32 MB `JSON.parse` blocks the event loop.
- Whether the exporter limits the pixel size at `scale: 10`.
- `import_image` with `dryRun: true`: the media is stored, and the answer may name a `shapeId` that was not created.
- Two instances behind a round-robin balancer: `storage`, and a chunked `execute_code` flush.
- Whether `gfont-source-sans-pro` in `data/fonts.json` exists in Penpot's Google font list (that list is not in
  git); the built-in font id is `sourcesanspro` with variant `bold`, not `700`.
