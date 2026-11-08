# Gate scripts

These scripts ran the round 1 gates of the MCP backend mode on 2026-11-08. The results and logs are in
`mcp/packages/loadtest/results/2026-11-08-round1-resumed/`. The gate run is described in
`mcp/docs/production-readiness.md`, section "Gate run, round 1".

Nothing in this folder holds a token, a password or a vars file. Token files and vars files are passed as
paths. The scripts were copied as they ran. Their paths still point to the session folder and the results folder
of the run, so change those paths before you run them again.

## Scripts

### cold.sh

Restarts the dev backend in the `penpot-tc` container, waits for it to answer on port 6061, then runs one cold
scenario through `run2.sh`. Writes `cold-<a|b><n>-restart.log` and the scenario log into the results folder.

Invocation (Git Bash, from the repo):

    bash mcp/packages/loadtest/scripts/gates/cold.sh a 1
    bash mcp/packages/loadtest/scripts/gates/cold.sh a 2
    bash mcp/packages/loadtest/scripts/gates/cold.sh b 1
    bash mcp/packages/loadtest/scripts/gates/cold.sh b 2

Needs: the `restart-backend-dev` command in the `penpot-tc` container (not in this repo), a token file, and
the backend on `127.0.0.1:4405` (the adapter) and `localhost:6061` (metrics).

### cold-a.json and cold-b.json

The cold scenarios. `cold-a.json` reads the 5,000-shape file first, then the 100,000-shape file. `cold-b.json` reads
them in the reverse order. Each file makes one cold call per tool, then five warm calls per tool.

### run2.sh

Runs one loadtest scenario with the run's settings. It writes to `<logname>.log` in the results folder. It stops
when less than 5 GB is free on drive C.

Invocation (the other scripts call it):

    bash mcp/packages/loadtest/scripts/gates/run2.sh <logname> <scenario> --tokens <token-file> [more args]

Environment: `SPID` is the backend process id for the server-pid option. The default is 25420, the value of the run.

### cap.sh

Runs one capacity scenario and records the database pool and rate-limit counters once a second while it runs.
It starts `poolwatch.cjs`, runs the scenario through `run2.sh`, stops the watch, and writes a summary with `poolsum.cjs`.

Invocation (example from the C1 run at 50 agents):

    bash mcp/packages/loadtest/scripts/gates/cap.sh c1-50 c1-different-files \
      --tokens <token-file> --vars <vars-file> --agents 50

Needs: a token file, a vars file, and the agent count. Other C1 and C2 runs used the same wrapper with their own
scenario names and agent counts.

### poolwatch.cjs

Samples the `hikaricp_*` pool metrics and the `penpot_rpc_climit_*` and `penpot_rpc_rlimit*` counters from
`http://localhost:6061/metrics` once a second. It appends one JSON line per sample. It stops when the stop file exists.

Invocation (cap.sh starts it in the background):

    node mcp/packages/loadtest/scripts/gates/poolwatch.cjs <out.jsonl> <stop-file>

### poolsum.cjs

Reads a `poolwatch.cjs` file and prints one JSON summary: the largest active, pending and connection counts, the share
of samples with pending threads, the timeouts, and the largest acquire p95.

Invocation:

    node mcp/packages/loadtest/scripts/gates/poolsum.cjs <name>-pool.jsonl

### steps.cjs

Prints the call count, errors, p50 and max for each step of a loadtest result file. It loads the file with
`require`, so pass an absolute path or a path starting with `./`.

Invocation:

    node mcp/packages/loadtest/scripts/gates/steps.cjs <absolute-path-to-result.json>

### s6-import-archive-base64.json

The S6 scenario. It imports an archive through `import_archive` with the archive sent inline as base64. Then it
checks the shape count and page count of the new file against the archive counts. The run found that
`import_archive` fails on this path (finding R1-G1 in the readiness doc), so the gate result was a fail.

Invocation (from `s6.log`, with the path names shortened):

    pnpm --filter mcp-loadtest run cli run mcp/packages/loadtest/scripts/gates/s6-import-archive-base64.json \
      --tokens <token-file> --vars <vars-file> --url http://127.0.0.1:4405/mcp \
      --metrics http://localhost:6061/metrics --pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev \
      --results <results-folder> --db-pool-size 8 --server-pid <backend-pid>

The vars file is JSON with these keys: `projectId` (string), `archiveBase64` (string, the base64 of the `.penpot`
archive), `archiveShapeCount` (number) and `archivePageCount` (number). The run used the 5,000-shape, 21-page
archive `medium-5000.penpot`. That archive and the vars file are not in the repo.

### restart-nopm

Stops every dev backend JVM in the container and starts one fresh copy of `/tmp/run-backend-dev-nopm`. It waits
until the backend boots or fails. The run used it for the no-pointer-map gate. The logs do not record the exact
command line, so this is how the script works, not a logged call.

Invocation: copy `run-backend-dev-nopm` to `/tmp/` in the container, then run this script in the container
(for example `bash /tmp/restart-nopm`). It needs the environment for `run-backend-dev-nopm`.

### run-backend-dev-nopm

Starts the backend from source (`clojure -A:dev -M -m app.main` in `/work/backend`) with the dev flags, on the
`penpot_mcpdev` database, with the pointer-map flag left out. It sets the pool size to 8.

Required environment variables (the script stops if one is missing):

- `PENPOT_DATABASE_PASSWORD`: the database password.
- `PENPOT_SECRET_KEY`: the backend secret key.
- `PENPOT_EXPORTER_SHARED_KEY`: the key the exporter uses.

## Files left out

- The vars files (`s6/s6-vars.json`, `cap/vars-c2-fresh.json` and the others). They hold the archive or
  file ids and are data. Write your own from the list above.
- The token files (`tokens-*.txt`). They hold live tokens.
- `s6/s6-count.json` and `s6-direct.log`. These check the backend half of S6 with a direct import. They were
  one-off probes.
- `sqlcount.mjs`, `call.mjs` and `mkfiles.mjs`. They count SQL per call, time one call and create agent files.
  They are not in this set. Add them only if the round 2 plan needs them.
- The archives (`medium-5000.penpot`, `large-100k.penpot`).
