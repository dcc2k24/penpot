# Review: backend-write-mcp-plan.md

Reviewer: review sub-agent. Date: 2026-11-03. Read-only review; 12 code references spot-checked (listed in each finding).

## 1. Verdict

**Ready after fixes.** The architecture (option b, backend `app.rpc.commands.mcp` reusing `common`) is sound, and the
code references I checked are mostly accurate (`wrap-authentication` rule, `update-file` vern/revn checks, `check-changes`
at `changes.cljc` 455, JVM `validate-shape` at 622, `enable-pointer-map` at `fdata.clj` 328, snapshot commands at
`files_snapshot.clj` 33/83/111/205). But four issues must be fixed before code is written: the auto-snapshot design
does not fit the real snapshot mechanism (`created-by` enum, `create-file-snapshot` realises the whole file, quotas);
the scope enforcement relies on a `wrap-authentication` clause whose semantics change for MCP tokens and is not
spelled out for session users; two sections (8.7, 8.8) still contradict decision 5; and the "Full" ratings for
layout and component sync assume a modifiers-to-changes path that the plan itself marks Unverified.

## 2. Decision consistency

| Decision | Finding | Lines |
|---|---|---|
| 5 (fully local) | 8.7 "Azure Monitor managed Prometheus or ... container on the VM". Contradicts decision 5. | 903-904 |
| 5 | 8.8 CI gates on "GitHub Actions large runner, arm64" and "CI-hosted compose stack" make regression gates depend on remote infra and on emulation-free arm64 runners that are not part of the local devenv. At minimum say CI is supplementary and gates are taken locally. | 909-914 |
| 5 | 4.9 edits `deploy-azure/Caddyfile`; 7.1 cites `deploy-azure/docker-compose.yaml` line 10 as the renderer evidence. Use the devenv config (`penpot/docker/devenv`) as the reference; Azure files only as optional rollout. | 365, 569 |
| 5 | C5 "heap < 5 GB" and backend CPU "< 70% of 4 vCPU" are VM-sized; a developer machine under Docker Desktop limits may not have this. Express as fractions of the recorded `-Xmx`/CPU limit. | 761, 833 |
| 3 (snapshots) | 5.1 says "keeps the last 20 agent-created snapshots", but `fsnap/create!` only accepts `created-by` `"user"`/`"system"` (`file_snapshots.clj` 204); there is no way to identify agent snapshots, so "last 20 per file" cannot be pruned without a schema change or a label convention. Also "a failed snapshot aborts the write" (9.2) is not designed. | 376-384, 1110-1112 |
| 3 | 5.1 still carries "Unverified: confirm the snapshot RPC command name" though it is verified (`create-file-snapshot`, line 83). Remove. | 381 |
| 2 (read default) | 5.1 says `dryRun` needs only `mcp:read`. `dryRun` of `apply_raw_changes` runs full process-changes on the server: acceptable, but it must be rate-limited like writes (CPU DoS); not stated. | 372-373 |
| 2 | Phase 1 scope says "auth minus scopes UI", and the scopes UI and the explicit `mcp:write` grant ship in Phase 3 (1047). With decision 2, Phase 1 tokens can never write, so Phase 1 exit criteria (agent builds 50 pages) are unreachable without the grant path. Move a minimal grant (consent screen scope or settings toggle) into Phase 1. | 1023, 1030-1031, 1047 |
| 1, 4, 6, 7, 8, 9 | Reflected correctly (4.4, 1/3.4, 8.6, 7.5, 5.2 row 14, 6.1/6.3). Minor: 1.33 env name `PENPOT_MCP_PLUGIN_BRIDGE` vs 3.4 `PENPOT_MCP_MODE`; pick one. | 33, 231 |

## 3. Feature-parity gaps

- **Missing Plugin API members** (checked against `plugin-types/index.d.ts`): `penpotMgmt.getFile` (1022) and
  `listDeletedProjects`/`listDeletedFiles` (1007/1012) are only implicit in tool 3/4; `Team.listDeletedFiles` (819)
  absent; `textBounds`-style reads; `GridLayout.addRowAtIndex`/`addColumnAtIndex` (2393/2418) not named;
  `bringForward`/`sendBackward` (4381/4391) folded into "etc."; `Page.removeCommentThread` (3612) and
  `CommentThread.findComments` (637) not in A.13; `LibraryComponent.isVariant`/`transformInVariant` ok. Add explicit rows.
- **`replaceColor` / `shapesColors`** (1193/1203) marked Partial as "find + batch update" but the colour filter on
  `find_shapes` is not in the 5.2 input list. Add a `colors` filter or an op.
- **`createShapeFromSvgWithImages`** (1438) needs embedded image upload inside one tool call; 17 says "uploaded first"
  but no media-upload-in-transaction design (media rows commit outside `update-file`). Mark Partial until designed.
- **Events (A.15)** marked N/A, but current agents use `penpot.on('shapechange')` rarely; acceptable. However an MCP
  resource subscription on `revn` should be a tracked Phase 3 item, not "possible later".
- **Undo**: `history.undoBlock*` Partial is honest. Note restore of a snapshot also discards concurrent human edits;
  inverse-ops "returned by dryRun" is undesigned.
- **Layout / sync "Full" ratings are optimistic.** A.6 and A.9 mark flex/grid and same-file sync Full while 7.2 marks
  the modifiers-to-changes function Unverified and 7.3 relies on `*touched-changes*` behaviour not checked. Mark
  Partial until a Phase 2 spike confirms.
- **`File.export('zip')`** and `activeUsers` correctly flagged.
- **Current MCP `export_shape` "selection"** N/A is fine; `export_shape` `filePath` local mode needs file-system flag
  parity (`PenpotMcpServer.ts` 266-268); state it.

## 4. Technical correctness

Verified correct: `rpc.clj` 171-216 rule (MCP token rejected unless `required-token-type "mcp"`); perms check uses
token perms only when `auth-type :token`; `update-file` vern/revn checks (files_update.clj 199-213); `xact-lock!` 172;
`skip-validate` param exists on `update-file` schema (line 74); `check-changes` 455; `enable-pointer-map` wraps
`pages-index` values and `:components` (fdata.clj 328-336); auth header regex accepts `Token|Bearer`
(`http/middleware.clj` 340), so the 4.1 Unverified item can be closed; climit numbers (climit.edn 16-19);
`scopes_supported ["mcp"]` (mcp_oauth.clj 51/60/136).

Issues:

1. **`::rpc/perms` cannot coexist with session users.** `wrap-authentication` raises `token-auth-required` when a
   command has `required-perms` and `auth-type` is not `:token` (rpc.clj ~199-203). Tagging allow-listed existing
   commands (`create-project`, `delete-file` ...) with `::rpc/perms #{"mcp:manage"}` would lock out the browser.
   4.3/4.5 must specify a new rule: perms are checked only when `token-type = "mcp"` (or a new `::rpc/mcp-perms` key).
2. **`apply_raw_changes` must force `skip-validate false`.** `update-file*` honours `skip-validate`; the plan must state
   the MCP path never forwards it. Also forbid raw `:set-tokens-lib`, `:purge-component`, `:add-media` with foreign
   media ids, and `:mov-objects` across pages unless validated: schema validation alone does not check ownership of
   referenced media/library ids (Unverified whether `validate-file-affected!` does).
3. **Snapshot cost.** `create-file-snapshot` does `bfc/get-file ... :realize? true` (files_snapshot.clj 90) and
   `update-file*` `attach-snapshot` calls `fdata/realize` (440). Every auto-snapshot of the 100k-shape file realises
   the full file, contradicting the "never a full realised copy" heap budget (8.1, 761) and the bulk write budget.
   Snapshot quota `::quotes/snapshots-per-file` (quotes.clj 433) can also reject auto snapshots. Specify: snapshot
   via the existing `::snapshot` hook inside `update-file*` (same transaction), label prefix `mcp/`, prune by label,
   budget the realise cost, and decide quota interaction.
4. **Auto-snapshot frequency.** "Exceeds 100 operations" plus 300-object adaptive commits means a 5,000-shape import
   creates up to 17 full-file snapshots. Define: one snapshot per tool call, not per commit.
5. **Multi-commit tool calls break atomicity.** 8.3 splits one call into several commits, but 5.2/12 says "applied
   atomically in one transaction". Choose: default atomic with a size cap, explicit `allowSplit`.
6. **revn semantics.** 7.7 says ops are built against latest data, which is correct for `update-file`; but
   `get-lagged-changes` returns changes from other sessions, and the MCP session id per call (UUIDv5) must be stable
   across commits or the agent receives its own commits as lagged. Spell out.
7. **`file_page_index` table** is a new invariant maintained by every `update-file*` commit, including human ones:
   that is a core write-path change with migration and upstream-merge cost, not mentioned in 11.1. Alternative:
   store a page summary as a non-pointer key in `file.data` or derive from `get-file-summary` cache (files.clj 654).
8. **Sandbox.** QuickJS-WASM with facade "property reads hit a working copy fetched through projections" means
   synchronous getters must be served from prefetched data; arbitrary `page.findShapes` on unfetched pages needs
   async host calls, which QuickJS-emscripten supports only via asyncify builds (slower, larger). State the async
   model. Also the CLJS `common` preview build (several MB) loaded into each QuickJS runtime vs in the Node host
   is undecided: if in the host, host-side code must treat all script data as untrusted.
9. **Token resolver as `POST /internal/resolve-tokens` on the MCP container** (7.5, 653) makes the backend call the
   MCP container; this inverts the dependency, needs auth between containers, and adds a failure mode to writes.
   Prefer JVM port or resolve in the worker before sending ops.
10. **Exporter auth** with access tokens remains open (7.6); the "render session" is a new session type that must be
    read-only and file-scoped in `session.clj`; non-trivial; budget it.
11. **Audit**: `wrap-audit` only runs when `webhooks`/`audit-log`/`telemetry` flags are on (rpc.clj 226-237). The
    plan claims audit "cannot be skipped"; it can, by flags. Require the `audit-log` flag in backend mode or emit
    directly.
12. **Query-token default false** breaks existing clients (today's docs use `?userToken=`); needs a migration note.

## 5. Performance plan quality

Strengths: explicit p50/p95/p99, resource budgets, generated deterministic reference file with pointer-map variants,
plugin-bridge baseline, machine spec recording, soak tests, sandbox benchmarks.

Gaps:

- Targets are absolute ms on an unspecified developer machine; define a reference spec (cores, RAM, Docker limits)
  or express gates relative to the baseline run on the same machine.
- The generator itself is unspecified (how it builds 100k shapes; via MCP? via binfile writer?). Building through the
  system under test makes the fixture depend on the code being tested. Specify generating the `.penpot` archive
  directly with `common` builders, with a schema validation step.
- No cold-JVM / first-call numbers; agents often hit cold pages. Add cold-cache rows.
- No test for auto-snapshot cost on the large file (see 4.3).
- C3 human-tab test via Playwright on the devenv frontend dev build (shadow-cljs) is not representative of release
  performance; specify a production frontend build in the devenv.
- 12 h soak on a laptop is fragile (sleep, Docker Desktop restarts); allow 12 h only as an optional pre-1.0 run.
- Sandbox: add a hostile-script benchmark (infinite loop, memory bomb, deep recursion) proving the 10 s / 128 MB caps
  terminate cleanly and do not leak runtimes.
- Rate limit "6000/h" vs scenario S2 (17 commits) is fine, but S5 (30 min, 280 calls) plus C5 (20 agents) on one
  profile would exceed per-profile limits if all use one test user; specify one profile per agent.

## 6. Phasing and effort

- Order is sensible (reads and basic writes before layout/text/components).
- Phase 1 is useful only if the `mcp:write` grant path ships in Phase 1 (see section 2).
- Phase 1 lacks text, which most real agent tasks need; consider moving `create_text` with approximate sizing
  (7.1 layers 1-2) into Phase 1, since it does not depend on layout.
- Estimates are optimistic: Phase 2 (layout recomputation port, JVM text measurer, components, variants port,
  exporter auth) in 6 w, and Phase 3 (QuickJS facade with full Plugin API proxy semantics, token application port,
  code-gen on Node, reflow job) in 5 w. A credible total is 26-32 engineer-weeks. Add spike tasks with go/no-go in
  Phase 0: modifiers-to-changes on JVM, QuickJS async host calls, code_gen on Node, exporter token auth.

## 7. Prioritised fixes

**P1 (must fix before implementation)**

1. 4.3/4.5 (lines 270-321): define how `::rpc/perms` / scopes are enforced for MCP tokens without breaking session
   users (new metadata key or modified `wrap-authentication` clause), with a test in 9.2.
2. 5.1, 9.2 (376-384, 1110-1112): redesign auto-snapshot: take it once per tool call inside `update-file*` via the
   `::snapshot` hook, label prefix `mcp/` for pruning to 20, state quota behaviour, failure aborts commit, and add its
   realise cost to the 8.1 budgets.
3. 8.7 (903-904) and 8.8 (909-914): remove Azure Monitor and the VM; make local devenv the only gate environment and
   CI informational only.
4. Section 10 (1023, 1047): move the minimal `mcp:write` grant (consent scope or settings toggle) into Phase 1.

**P2 (should fix)**

5. 5.2 row 12 vs 8.3: resolve atomic vs multi-commit semantics; add `allowSplit`.
6. 5.2 row 14 / 4.3: state the MCP path never forwards `skip-validate` and list raw change types refused or extra-checked.
7. A.6, A.9: downgrade layout and same-file sync to Partial until Phase 2 spike; add spikes to Phase 0.
8. 7.5 (653): replace backend-to-MCP `/internal/resolve-tokens` with worker-side resolution or JVM port.
9. 6.1/6.3: specify the QuickJS async host-call model and where the CLJS `common` preview runs.
10. 4.8: require `audit-log` flag in backend mode or emit audit directly.
11. 5.5: justify `file_page_index` vs a lighter alternative; add it to 11.1 risks.
12. 8.1/8.4: express resource gates relative to recorded machine spec; add cold-cache rows; production frontend build for C3.
13. Section 10: revise total to about 26-32 engineer-weeks.

**P3 (nice to have)**

14. Close resolved Unverified items: 4.1 (line 251, `middleware.clj` 340 accepts both), 5.1 (line 381).
15. Unify `PENPOT_MCP_PLUGIN_BRIDGE` (33) with `PENPOT_MCP_MODE` (231).
16. Replace `deploy-azure/*` references (365, 569) with devenv equivalents.
17. Add missing Appendix A rows (getFile, deleted lists, addRowAtIndex/addColumnAtIndex, bringForward/sendBackward,
    removeCommentThread, findComments) and a `colors` filter on `find_shapes`.
18. Add hostile-script sandbox benchmarks and one-profile-per-agent rule to 8.4.
19. Document migration for clients using `?userToken=` (4.9).
