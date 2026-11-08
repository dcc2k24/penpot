# Adversarial suite (T3): results

Run on 2026-11-07, 23:02 to 23:12, against the dev stack: adapter `http://127.0.0.1:4405/mcp` in backend mode with
`--multi-user`, dev backend `http://localhost:6061`, branch `perf/render-wasm-large-files` at `e4084f80b2` with a
dirty tree (uncommitted work of other tracks). Groups 6 and 7 ran first (load), then groups 1 to 5 and 8.

Totals: 282 cases, 242 pass, 13 fail, 27 not testable. `/readyz` and a control `get_file_outline` passed after
every group. No token or cookie value appears in any log or report.

## Failures

| Case | Severity | What was sent | What came back | Expected | Most likely at fault |
|---|---|---|---|---|---|
| 6.25 | high | 4 tokens each run a script of 1,500 `penpotMgmt.listTeams()` calls; 3 s later a fifth token runs `return 1 + 1` | fifth token: `execute_code is busy: 4 calls are already running`; the 4 scripts held the slots for 98 s, then hit the 1,000 host-call cap | other users still get a slot; a script that waits on its own rate limit does not hold a global slot for up to 120 s | `mcp/packages/server/src/sandbox/SandboxHost.ts:938` (`takeRateToken` waits inside the slot), `sandbox/CallSlots.ts:43` (4 global slots) |
| 5.01 | medium | POST `/mcp`, no token, 5 MB body | 413 with the Express HTML error page: `PayloadTooLargeError` stack, `C:\dev\penpot\mcp\node_modules\...` paths and line numbers | 413 with a short JSON error, no stack, no paths | `mcp/packages/server/src/PenpotMcpServer.ts:761-762, 828` (body parsers with no error middleware) |
| 5.02 | medium | POST `/mcp`, valid token, 40 MB body | the same HTML stack page, 413 | as 5.01 | as 5.01 |
| 5.03 | medium | POST `/mcp`, valid token, body `{"jsonrpc":"2.0",` | 400 HTML page with the `SyntaxError` stack and host paths | 400 JSON-RPC `-32700` | as 5.01 |
| 8.04c | medium | `apply_raw_changes` (real write), `mod-obj` of an existing rect, `set name = {"$$":1}` | refused, but as `Backend error assertion: invalid shape found ...` with the malli explain and the whole shape record | a `validation` refusal naming the field, no internal dump | `common/src/app/common/files/changes.cljc:489-497` (`validate-shape` raises `:assertion`); the explain reaches the client |
| 7.05 | medium (inconclusive) | 20 agent tokens, 30 `whoami` each, all 600 at once | tokens 10 to 19: `fetch failed` on the client, 0 answers; tokens 0 to 9 limited correctly (20 to 22 ok each) | each token limited on its own | not settled: passed in an isolated run at 23:01; either the client or the adapter drops connections at 600 sockets. Needs a run from a second client process |
| 7.07 | medium | 20 concurrent `export_shape` png of one rect from one token | all 20 images, but 4 took 70 to 81 s | an answer or a clear refusal within the 60 s render wait (contract 4.5) | `mcp/packages/server/src/tools/backend/ExportShapeBackendTool.ts:354` (the bound covers the queue, not queue plus render); an agent with a 60 s client timeout sees a timeout |
| 1.67, 1.100 | low | `update-mcp-token-scopes` with the full and the read MCP token | 403 `token-auth-required`, hint "access token authentication required for this endpoint" | 403 `session-required` (contract 1.6) | `backend/src/app/rpc.clj:266-270` refuses first, with a hint that is wrong for a token caller |
| 3.17 | low | `import_image url=http://0177.0.0.1:6060/` | `unable-to-download-image ... request timeout` after 30 s | refused up front | the adapter (WHATWG) reads 127.0.0.1, the backend's Java parser does not, so loopback is not reached; `backend/src/app/util/ssrf.clj` could refuse ambiguous IPv4 literals |
| 5.05 | low | POST `/mcp`, valid token, 10,000 nested objects in `params` | HTTP 500, JSON-RPC `-32603 Internal server error`; the server stays up | 4xx | request validation behind `PenpotMcpServer.ts` `handleMcpRequest`; cap the depth before it |
| 8.04 | low | `apply_raw_changes` dry run, `mod-obj` of a random id | `validation.ok: true` | the dry run says the change targets no shape | `backend/src/app/rpc/commands/mcp_write.clj` dry-run path |
| 4.14 | low | `export_shape` with `filePath` on this multi-user adapter | image returned inline, `filePath` silently dropped | a refusal that says file paths are off | zod strips the key: `ImportImageBackendTool.ts:183-186` and the same pattern in `ExportShapeBackendTool.ts` |

## What held

- Scopes: the read token is refused with `mcp-scope-required` on every write, manage and delete tool action (37
  cases) and on 22 raw backend commands; dry runs work with it. MCP tokens cannot reach `get-file`, `update-file`,
  `export-binfile`, or the token, profile, team, invitation and webhook commands.
- Render session (review P1): the cookie works for its own file and is refused (`session-restricted`) everywhere
  else, including the token, scope and profile commands; OAuth `/request` and `/decision` answer `login_required`;
  `/ws/notifications` and `/dbg` treat it as no session; another file's media is 404.
- Token states: expired and revoked tokens get 401; a profile with MCP off gets `mcp-disabled` and cannot switch it
  back on with its token. Cross-tenant reads answer `object-not-found`.
- OAuth: a code of client A cannot be exchanged by client B, a wrong verifier does not burn the code, a code is
  single use, the client token holds only `mcp:read`, and `/decision` needs the right `Origin`.
- SSRF: 56 targets refused (loopback, link-local, metadata, private ranges, docker names, mapped and compatible
  IPv6, decimal and hex forms, non-HTTP schemes, credentials in the URL, redirects to private hosts, rebinding).
- Sandbox (review P2, P3): prototype and `Promise.prototype.then` tampering, the `__arg0` setter, CPU, recursion,
  memory, 50 MB results, log floods and `storage` bombs are refused or capped, and the same token works afterwards;
  nine escape attempts found no host object. Ten parallel CPU burners left the stack usable.
- Replay: the same `requestId` and payload answers `alreadyApplied` and writes once (also with 5 at once); a changed
  payload is a new write. Rate limit: 33 of 200 calls in 2 s pass; other tokens are not affected.
- Leaks: refusals carry no SQL, Java class or other profile ids (except 5.01 to 5.03 and 8.04c); `/metrics` needs
  a token when any forwarding header is present.

## Not testable here

- 2.01, 2.02: the backend and raw-change flags need a backend restart with the flag off. The case notes give the
  manual steps.
- 4.01 to 4.24 (traversal, UNC, device names, junctions): this adapter runs multi-user, which removes `filePath` from
  the tool schemas (4.00 checks this). They need a single-user adapter; file symlinks also need a privilege this host
  lacks (EPERM).
- 1.89 `/assets/by-id` with a render session: no tool reply exposes a storage id. Contract 1.5 says this route does
  not check the file.
- 8.15: the backend sends no `X-Request-Id` response header.
- DNS rebinding (3.55) is a probe: six attempts against a rebinding name never reached content, which does not prove
  that the backend pins the checked address.

## Notes on the suite

- The adapter under test logged `Max parallel exports (multi-user mode): 0 (0 = unbounded)`, so the process-wide
  export permit (contract 4.5, default 4) was off; 7.08 passed under that setting.
- 6.09b passes by design: the live sandbox keeps a 20 MB `storage` value; only the saved copy is capped (8 MB), and
  the reply says so.
- After this run, 8.04c's severity in the code was lowered from high to medium (the write is refused; the fault is
  the error type and the dump).

## Result per case

| Id | Case | Result | Note |
|---|---|---|---|
| 1.01 | apply_operations create_rect, not a dry run | pass |  |
| 1.02 | apply_raw_changes mod-obj of a random id | pass |  |
| 1.03 | batch_create_shapes one rect | pass |  |
| 1.04 | import_svg one small rect | pass |  |
| 1.05 | import_image a 1x1 png, createShape false | pass |  |
| 1.06 | import_archive a few random bytes (adapter may refuse the format first) | pass |  |
| 1.07 | manage_files create_team | pass |  |
| 1.08 | manage_files rename_team on a random team | pass |  |
| 1.09 | manage_files create_project in the test team | pass |  |
| 1.10 | manage_files rename_project on a random project | pass |  |
| 1.11 | manage_files pin_project on a random project | pass |  |
| 1.12 | manage_files delete_project on a random project | pass |  |
| 1.13 | manage_files create_file in the test project | pass |  |
| 1.14 | manage_files rename_file on a random file | pass |  |
| 1.15 | manage_files duplicate_file on a random file | pass |  |
| 1.16 | manage_files duplicate_project on a random project | pass |  |
| 1.17 | manage_files move_files of random ids | pass |  |
| 1.18 | manage_files move_project of random ids | pass |  |
| 1.19 | manage_files delete_file on a random file | pass |  |
| 1.20 | manage_files restore_files of random ids | pass |  |
| 1.21 | manage_files set_shared on a random file | pass |  |
| 1.22 | manage_files link_library of random ids | pass |  |
| 1.23 | manage_files unlink_library of random ids | pass |  |
| 1.24 | manage_versions create a snapshot of the test file | pass |  |
| 1.25 | manage_versions restore a random snapshot | pass |  |
| 1.26 | manage_versions pin a random snapshot | pass |  |
| 1.27 | manage_versions unpin a random snapshot | pass |  |
| 1.28 | manage_versions delete a random snapshot | pass |  |
| 1.29 | manage_versions rename a random snapshot | pass |  |
| 1.30 | comments create_thread on a fresh page | pass |  |
| 1.31 | comments reply to a random thread | pass |  |
| 1.32 | comments resolve a random thread | pass |  |
| 1.33 | comments reopen a random thread | pass |  |
| 1.34 | comments move a random thread | pass |  |
| 1.35 | comments delete_thread on a random thread | pass |  |
| 1.36 | comments delete a random comment | pass |  |
| 1.37 | execute_code creates a rect on a fresh page | pass |  |
| 1.38 | whoami with the read token reports only mcp:read | pass |  |
| 1.39 | get_file_outline with the read token (control) | pass |  |
| 1.40 | apply_operations dryRun with the read token (control, needs only mcp:read) | pass |  |
| 1.41 | raw mcp-apply-operations create_rect | pass |  |
| 1.42 | raw mcp-apply-changes mod-obj of a random id | pass |  |
| 1.43 | raw mcp-import-svg on a fresh page | pass |  |
| 1.44 | raw delete-file of a random file | pass |  |
| 1.45 | raw delete-project of a random project | pass |  |
| 1.46 | raw create-project in the test team | pass |  |
| 1.47 | raw create-file in the test project | pass |  |
| 1.48 | raw rename-file of a random file | pass |  |
| 1.49 | raw restore-file-snapshot of a random snapshot | pass |  |
| 1.50 | raw delete-file-snapshot of a random snapshot | pass |  |
| 1.51 | raw create-file-snapshot on the test file | pass |  |
| 1.52 | raw create-comment-thread on a fresh page | pass |  |
| 1.53 | raw delete-comment-thread of a random thread | pass |  |
| 1.54 | raw update-comment-thread (resolve) of a random thread | pass |  |
| 1.55 | raw set-file-shared of a random file | pass |  |
| 1.56 | raw duplicate-file of a random file | pass |  |
| 1.57 | raw move-files of random ids | pass |  |
| 1.58 | raw create-team | pass |  |
| 1.59 | raw link-file-to-library of random ids | pass |  |
| 1.60 | raw upload-file-media-object on the test file (multipart) | pass |  |
| 1.61 | raw create-file-media-object-from-url, unresolvable host | pass |  |
| 1.62 | get-file with the full MCP token | pass |  |
| 1.63 | update-file (editor save) with the full MCP token | pass |  |
| 1.64 | export-binfile with the full MCP token | pass |  |
| 1.65 | get-access-tokens with the full MCP token | pass |  |
| 1.66 | create-access-token with the full MCP token | pass |  |
| 1.67 | update-mcp-token-scopes with the full MCP token (must be session-required) | **fail** (low) | refused, but the code differs from contract 1.6 and its hint (access token authentication required) is misleading for a token caller (HTTP 403 token-auth-requir |
| 1.68 | update-profile-props mcpEnabled true with the full MCP token | pass |  |
| 1.69 | delete-team of a random team | pass |  |
| 1.70 | create-team-invitations with the full MCP token | pass |  |
| 1.71 | create-webhook with the full MCP token | pass |  |
| 1.72 | update-profile with the full MCP token | pass |  |
| 1.73 | update-profile-password with the full MCP token (wrong old password) | pass |  |
| 1.74 | create-mcp-render-session with the read token (control) | pass |  |
| 1.75 | get-profile with the render session (control) | pass |  |
| 1.76 | get-file on the covered test file with the render session (allowed) | pass |  |
| 1.77 | get-file on an agent file the session does not cover | pass |  |
| 1.78 | render session calls update-file | pass |  |
| 1.79 | render session calls create-access-token | pass |  |
| 1.80 | render session calls update-mcp-token-scopes | pass |  |
| 1.81 | render session calls update-profile-props | pass |  |
| 1.82 | render session calls get-teams | pass |  |
| 1.83 | render session calls delete-file | pass |  |
| 1.84 | render session calls mcp-apply-operations | pass |  |
| 1.85 | websocket /ws/notifications with the render session cookie | pass |  |
| 1.86 | GET /dbg/ with the render session cookie | pass |  |
| 1.87 | GET /dbg/error with the render session cookie | pass |  |
| 1.88 | render session reads media of an outsider file via /assets/by-file-media-id | pass |  |
| 1.89 | render session reads an outsider asset via /assets/by-id (contract 1.5 says no file check) | not testable | import_image reply exposes no storage id, so the by-id route cannot be probed |
| 1.90 | outsider token reads the test file outline | pass |  |
| 1.91 | read token reads the outsider file outline | pass |  |
| 1.92 | expired token through the adapter | pass |  |
| 1.93 | revoked token through the adapter | pass |  |
| 1.94 | switched-off token through the adapter | pass |  |
| 1.95 | expired token on the raw mcp-whoami | pass |  |
| 1.96 | revoked token on the raw mcp-whoami | pass |  |
| 1.97 | switched-off token on the raw mcp-whoami | pass |  |
| 1.98 | switched-off token tries to turn MCP back on | pass |  |
| 1.99 | switched-off token is still refused after the switch attempt | pass |  |
| 1.100 | read token calls update-mcp-token-scopes with all scopes | **fail** (low) | refused, but the code differs from contract 1.6 and its hint (access token authentication required) is misleading for a token caller (HTTP 403 token-auth-requir |
| 1.101 | read token still shows only mcp:read after the scope change attempt | pass |  |
| 1.102 | register two public OAuth clients | pass |  |
| 1.103 | code issued to client A cannot be exchanged by client B | pass |  |
| 1.104 | client A exchange with a wrong code_verifier | pass |  |
| 1.105 | client A exchange with the right code_verifier (control) | pass |  |
| 1.106 | the same code used again by client A | pass |  |
| 1.107 | client A token (mcp:read) through the adapter: apply_operations create_rect | pass |  |
| 1.108 | decision POST without an Origin header | pass |  |
| 1.109 | decision POST with Origin http://evil.example | pass |  |
| 1-scopes.health | stack healthy after group | pass |  |
| 2.01 | backend flag enable-mcp-backend off answers mcp-backend-disabled | not testable | needs a backend restart with the flag off, which this suite must not do. Manual steps: restart the backend without the flag enable-mcp-backend, then call whoami |
| 2.02 | raw changes flag off answers mcp-raw-changes-disabled | not testable | needs a backend restart with the flag enable-mcp-raw-changes off, which this suite must not do. Manual steps: restart the backend without that flag, then call a |
| 2.03 | backend answers mcp-whoami with the full token (flag is on) | pass |  |
| 2-backend-switch.health | stack healthy after group | pass |  |
| 3.01 | import_image refuses http://127.0.0.1:6060/readyz | pass |  |
| 3.02 | import_archive refuses http://127.0.0.1:6060/readyz | pass |  |
| 3.03 | import_image refuses http://localhost:6061/readyz | pass |  |
| 3.04 | import_archive refuses http://localhost:6061/readyz | pass |  |
| 3.05 | import_image refuses http://[::1]:4405/healthz | pass |  |
| 3.06 | import_archive refuses http://[::1]:4405/healthz | pass |  |
| 3.07 | import_image refuses http://169.254.169.254/latest/meta-data/ | pass |  |
| 3.08 | import_archive refuses http://169.254.169.254/latest/meta-data/ | pass |  |
| 3.09 | import_image refuses http://10.0.0.1/ | pass |  |
| 3.10 | import_archive refuses http://10.0.0.1/ | pass |  |
| 3.11 | import_image refuses http://0.0.0.0:6060/ | pass |  |
| 3.12 | import_archive refuses http://0.0.0.0:6060/ | pass |  |
| 3.13 | import_image refuses http://127.0.0.1.nip.io:6060/ | pass |  |
| 3.14 | import_archive refuses http://127.0.0.1.nip.io:6060/ | pass |  |
| 3.15 | import_image refuses http://2130706433:6060/ | pass |  |
| 3.16 | import_archive refuses http://2130706433:6060/ | pass |  |
| 3.17 | import_image refuses http://0177.0.0.1:6060/ | **fail** (low) | not refused up front; the backend does not reach loopback (WHATWG reads 127.0.0.1, Java does not); backend probe HTTP 400: {"type":"validation","code":"unable-t |
| 3.18 | import_archive refuses http://0177.0.0.1:6060/ | pass |  |
| 3.19 | import_image refuses http://0x7f.0.0.1:6060/ | pass |  |
| 3.20 | import_archive refuses http://0x7f.0.0.1:6060/ | pass |  |
| 3.21 | import_image refuses http://127.1:6060/ | pass |  |
| 3.22 | import_archive refuses http://127.1:6060/ | pass |  |
| 3.23 | import_image refuses http://[::ffff:127.0.0.1]:6060/ | pass |  |
| 3.24 | import_archive refuses http://[::ffff:127.0.0.1]:6060/ | pass |  |
| 3.25 | import_image refuses http://[::ffff:7f00:1]:6060/ | pass |  |
| 3.26 | import_archive refuses http://[::ffff:7f00:1]:6060/ | pass |  |
| 3.27 | import_image refuses http://[::127.0.0.1]:6060/ | pass |  |
| 3.28 | import_archive refuses http://[::127.0.0.1]:6060/ | pass |  |
| 3.29 | import_image refuses http://[fd00:ec2::254]/ | pass |  |
| 3.30 | import_archive refuses http://[fd00:ec2::254]/ | pass |  |
| 3.31 | import_image refuses http://localhost./ | pass |  |
| 3.32 | import_archive refuses http://localhost./ | pass |  |
| 3.33 | import_image refuses http://penpot-postgres:5432/ | pass |  |
| 3.34 | import_archive refuses http://penpot-postgres:5432/ | pass |  |
| 3.35 | import_image refuses http://penpot-valkey:6379/ | pass |  |
| 3.36 | import_archive refuses http://penpot-valkey:6379/ | pass |  |
| 3.37 | import_image refuses http://host.docker.internal:4405/healthz | pass |  |
| 3.38 | import_archive refuses http://host.docker.internal:4405/healthz | pass |  |
| 3.39 | import_image refuses file:///etc/passwd | pass |  |
| 3.40 | import_archive refuses file:///etc/passwd | pass |  |
| 3.41 | import_image refuses file:///C:/Windows/win.ini | pass |  |
| 3.42 | import_archive refuses file:///C:/Windows/win.ini | pass |  |
| 3.43 | import_image refuses gopher://127.0.0.1:6379/_INFO | pass |  |
| 3.44 | import_archive refuses gopher://127.0.0.1:6379/_INFO | pass |  |
| 3.45 | import_image refuses ftp://127.0.0.1/ | pass |  |
| 3.46 | import_archive refuses ftp://127.0.0.1/ | pass |  |
| 3.47 | import_image refuses dict://127.0.0.1:6379/info | pass |  |
| 3.48 | import_archive refuses dict://127.0.0.1:6379/info | pass |  |
| 3.49 | import_image refuses http://user:pass@127.0.0.1:6060/ | pass |  |
| 3.50 | import_archive refuses http://user:pass@127.0.0.1:6060/ | pass |  |
| 3.51 | redirect to http://127.0.0.1:6060/readyz is refused | pass |  |
| 3.52 | redirect to http://169.254.169.254/latest/meta-data/ is refused | pass |  |
| 3.53 | redirect to file:///etc/passwd is refused | pass |  |
| 3.54 | redirect chain of 12 is refused or fails cleanly | pass |  |
| 3.55 | DNS rebinding host never yields content (6 attempts) | pass |  |
| 3.56 | control: public image URL imports | pass |  |
| 3-ssrf.health | stack healthy after group | pass |  |
| 4.00 | tools/list shows no filePath in export_shape, import_image, import_archive | pass |  |
| 4.01 | export outside root: absolute path in scratch | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.02 | export outside root: C:\Windows\Temp | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.03 | export relative path with traversal | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.04 | export relative path | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.05 | export traversal out of root | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.06 | export traversal after a subfolder | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.07 | export UNC path to C$ share | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.08 | export extended-length path | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.09 | export POSIX absolute path | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.10 | export wrong extension .exe | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.11 | export alternate data stream name | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.12 | export reserved device name CON | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.13 | export path with NUL byte | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.14 | export filePath in remote mode is refused, not silently dropped | **fail** (low) | accepted: the path was not refused |
| 4.15 | export page with filePath is refused | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.16 | export through a junction to an outside folder | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.17 | export over a file symlink with overwrite | not testable | file symlink not testable: EPERM: operation not permitted, symlink 'C:\Users\colli\AppData\Local\Temp\penpot-adv-tspXcE\outside\in.png' -> 'C:\Users\colli\penpo |
| 4.18 | import outside root: C:\Windows\win.ini | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.19 | import traversal out of root | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.20 | import relative path | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.21 | import UNC path to C$ share | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.22 | import from scratch folder outside root | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.23 | import through a junction to an outside folder | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4.24 | import_archive filePath C:\Windows\win.ini | not testable | not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped |
| 4-paths.health | stack healthy after group | pass |  |
| 5.01 | 5 MB unauthenticated body is refused | **fail** (medium) | leak: node-modules-path, drive-path, js-source-line; Express default error page with stack trace and host paths (no error middleware after the JSON parser) |
| 5.02 | 40 MB authenticated body is refused | **fail** (medium) | leak: node-modules-path, drive-path, js-source-line; Express default error page with stack trace and host paths (no error middleware after the JSON parser) |
| 5.03 | malformed JSON is a 400 | **fail** (medium) | leak: node-modules-path, drive-path, js-source-line; Express default error page with stack trace and host paths (no error middleware after the JSON parser) |
| 5.04 | batch of 1000 tool calls is refused or capped | pass |  |
| 5.05 | 10,000 levels of JSON nesting are a 4xx | **fail** (low) | status 500 for deep JSON (crash or reset); 500 internal error instead of 4xx; the server stays up |
| 5.06 | 2001 operations are refused (dry run) | pass |  |
| 5.07 | get_shapes with 1000 ids is refused or bounded | pass |  |
| 5.08 | get_page_tree with limit 999999 is refused | pass |  |
| 5.08 | find_shapes with limit 999999 is refused | pass |  |
| 5.08 | list_files with limit 999999 is refused | pass |  |
| 5.08 | comments with limit 999999 is refused | pass |  |
| 5.09 | get_page_tree with depth 1000000 is refused or bounded | pass |  |
| 5.10 | unauthenticated tools/call is refused | pass |  |
| 5-bodies.health | stack healthy after group | pass |  |
| 6.01 | prototype tampering stays in the run | pass |  |
| 6.01b | prototype tampering: same token concat still works | pass |  |
| 6.01c | prototype tampering does not reach another token | pass |  |
| 6.02 | Promise.prototype.then replaced answers | pass |  |
| 6.02b | 6.02: same token still answers | pass |  |
| 6.03 | promise then property replaced answers | pass |  |
| 6.03b | 6.03: same token still answers | pass |  |
| 6.04 | Promise.prototype.then getter that never returns answers | pass |  |
| 6.04b | 6.04: same token still answers | pass |  |
| 6.05 | setter on __arg0 that never returns | pass |  |
| 6.05b | 6.05: same token still answers | pass |  |
| 6.06 | busy loop is refused with a CPU or time limit | pass |  |
| 6.06b | 6.06: same token still answers | pass |  |
| 6.07 | deep recursion is refused with a stack error | pass |  |
| 6.07b | 6.07: same token still answers | pass |  |
| 6.08 | 300 MB allocations are refused or answered within 30 s | pass |  |
| 6.08b | 6.08: same token still answers | pass |  |
| 6.09 | 20 MB storage value is capped with a note or refused | pass |  |
| 6.09b | 20 MB storage value is not kept | pass |  |
| 6.10 | 1500 host calls in one script hit the host call cap | pass |  |
| 6.10b | 6.10: same token still answers | pass |  |
| 6.11 | 10 parallel CPU burners from 10 tokens are refused or queued | pass |  |
| 6.11b | eleventh token still gets an answer after the burst | pass |  |
| 6.11c | control still reads the file outline after the burst | pass |  |
| 6.16 | escape attempt: typeof require | pass |  |
| 6.17 | escape attempt: require fs | pass |  |
| 6.18 | escape attempt: process.env | pass |  |
| 6.19 | escape attempt: fetch to the backend readyz | pass |  |
| 6.20 | escape attempt: constructor.constructor process | pass |  |
| 6.21 | escape attempt: this.process | pass |  |
| 6.22 | escape attempt: dynamic import fs | pass |  |
| 6.23 | escape attempt: new Function process | pass |  |
| 6.24 | escape attempt: global names | pass |  |
| 6.12 | guest escapes all refused (summary of 6.16 to 6.24) | pass |  |
| 6.13 | 50 MB string reply is capped | pass |  |
| 6.13b | 6.13: same token still answers | pass |  |
| 6.14 | storage toJSON that never returns answers | pass |  |
| 6.14b | 6.14: same token still answers | pass |  |
| 6.15 | log flood answers with the log capped | pass |  |
| 6.15b | 6.15: same token still answers | pass |  |
| 6.25 | four slow scripts hold the sandbox slots; a fifth token still gets an answer | **fail** (high) | 4 slow scripts hold all 4 sandbox slots: probe refused; probe refused: Tool execution failed: Error: execute_code is busy: 4 calls are already running; retry in |
| 6-sandbox.health | stack healthy after group | pass |  |
| 7.01 | same requestId and payload is answered alreadyApplied | pass |  |
| 7.02 | same requestId with a changed payload is a new write | pass |  |
| 7.03 | one token is rate limited to its bucket | pass |  |
| 7.04 | another token is not affected by the flood | pass |  |
| 7.05 | 20 tokens at once are each limited on their own | **fail** (medium) | token 11 had 0 successes, expected 15 to 50; #0 ok=21 rateLimited=9 timedOut=0 other=0 #1 ok=21 rateLimited=9 timedOut=0 other=0 #2 ok=22 rateLimited=8 timedOut |
| 7.06 | 30 concurrent execute_code from one token are queued or refused | pass |  |
| 7.07 | 20 concurrent exports from one token are answered or refused clearly | **fail** (medium) | 4 call(s) past 70000 ms, 0 other; images=20 clearRefusals=0 other=0 of 20; latency min=4329 median=45708 max=80987 ms; past 70000 ms=4 |
| 7.08 | the same export from 20 tokens at once: every call answers, and the exporter stays healthy | pass |  |
| 7.08b | a single export works after the 20-token burst | pass |  |
| 7.09 | one write with one requestId sent 5 times at once makes one shape | pass |  |
| 7-replay-limits.health | stack healthy after group | pass |  |
| 8.01 | get_file_outline with a malformed fileId is refused by validation | pass |  |
| 8.02 | get_file_outline with a random uuid is refused with no SQL or stack | pass |  |
| 8.03 | find_shapes with an invalid nameRegex answers mcp-invalid-regex | pass |  |
| 8.04 | apply_raw_changes dry run with a random id and a bad value is refused cleanly | **fail** (low) | dry run reports ok for a change that targets no shape |
| 8.04b | apply_raw_changes dry run with a non-string name on a real rect is refused | pass |  |
| 8.04c | apply_raw_changes write with a non-string name on a real rect is refused | **fail** (high) | refused as an internal assertion that dumps the malli explain and the whole shape record |
| 8.05 | raw backend get-mcp-shapes with SQL in fileId is a 400 validation with no SQL text | pass |  |
| 8.06 | raw backend malformed JSON body is a 400 with no Java class name or stack | pass |  |
| 8.07 | raw backend unknown command answers 404 or 400 with a clean body | pass |  |
| 8.08 | outsider token asking for the test file is refused and learns nothing about the owner | pass |  |
| 8.09 | /metrics refuses an unauthenticated request with X-Forwarded-For | pass |  |
| 8.10 | /metrics refuses an unauthenticated request with X-Real-IP | pass |  |
| 8.11 | /metrics refuses an unauthenticated request with Forwarded | pass |  |
| 8.12 | control: /metrics with the full token and X-Forwarded-For answers 200 | pass |  |
| 8.13 | /metrics refuses a bad bearer token with X-Forwarded-For | pass |  |
| 8.14 | X-Request-Id injection through the adapter: calls still work, response id is clean, log has no raw value | pass |  |
| 8.15 | X-Request-Id injection straight to the backend: response id is clean | not testable | backend answers no x-request-id response header: nothing to check here |
| 8-leaks.health | stack healthy after group | pass |  |
