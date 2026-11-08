// Case 5 of T4: the Postgres container is restarted while a steady stream of reads runs.
//
// Expected (plan T4): calls fail during the restart with a clear error, calls recover within 60 s of the restart
// ending, and no connection is left stuck (no session idle in a transaction for long, and no pile-up).
//
// The probe is get_file_outline every second, from this process, through the adapter. The case records every answer.
//
// Usage:
//   node postgres-restarted.mjs --dry-run
//   node postgres-restarted.mjs --yes --token-file <file> --vars <vars.json>
//
// --yes is required: the case restarts the Postgres container (docker restart, no volume is touched).

import { runCase, CONTAINERS, containerAction, dbRevn, ensureRunning, outcome, psql, sleep, waitFor } from "./lib.mjs";

const NAME = "postgres-restarted";
const RECOVERY_LIMIT_MS = 60_000;

const USAGE = `${NAME}: restarts ${CONTAINERS.postgres} under a steady read probe; checks errors, recovery, stuck sessions.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --adapter-log
Extra: --probe-tail-s <20> (how long the probe runs after the restart ends)`;

const CONNECTIONS_SQL = `select count(*) from pg_stat_activity where datname = 'penpot_mcpdev'`;
const STUCK_SQL = `select count(*) from pg_stat_activity where datname = 'penpot_mcpdev' and state like 'idle in transaction%' and now() - state_change > interval '60 seconds'`;

await runCase(NAME, { "--probe-tail-s": 20 }, async (c) => {
    const fileId = c.config.vars.fileId;
    const probes = [];
    let probing = false;
    let probeLoop;
    let restartStartedAt;
    let restartEndedAt;
    let recoveredAt;

    const startProbe = () => {
        probing = true;
        probeLoop = (async () => {
            while (probing) {
                const started = Date.now();
                const answer = await c.call("get_file_outline", { fileId });
                probes.push({
                    atMs: started,
                    ok: answer.ok,
                    ms: Math.round(answer.durationMs),
                    text: answer.ok ? "" : (answer.text || answer.error || "").replace(/\s+/g, " ").slice(0, 200),
                });
                const wait = Math.max(0, 1000 - (Date.now() - started));
                await sleep(wait);
            }
        })();
    };

    const baselineConnections = await c.step(
        "count the connections before the restart",
        () => psql(CONNECTIONS_SQL),
        "pg_stat_activity rows of penpot_mcpdev"
    );
    c.observe("connectionsBefore", Number(baselineConnections));

    await c.step(
        "start the read probe",
        async () => {
            startProbe();
            c.registerCleanup("stop the read probe", async () => {
                probing = false;
                await probeLoop;
            });
        },
        "get_file_outline every second"
    );
    await c.step("run the probe for a few seconds", () => sleep(5000), "5 s of healthy answers first");

    await c.step(
        `restart ${CONTAINERS.postgres}`,
        async () => {
            c.registerCleanup(`start ${CONTAINERS.postgres} if it is not running`, () =>
                ensureRunning(CONTAINERS.postgres, c.opts.yes)
            );
            restartStartedAt = Date.now();
            await containerAction("restart", CONTAINERS.postgres, { timeoutS: 30, yes: c.opts.yes });
            restartEndedAt = Date.now();
        },
        "docker restart -t 30"
    );

    await c.step(
        "wait for the first answer after the restart",
        async () => {
            try {
                recoveredAt = await waitFor(
                    "an ok probe after the restart",
                    async () => {
                        const hit = probes.find((p) => p.ok && p.atMs >= restartEndedAt);
                        return hit ? hit.atMs : false;
                    },
                    { timeoutMs: RECOVERY_LIMIT_MS + 30_000, intervalMs: 500 }
                );
            } catch {
                recoveredAt = undefined;
            }
        },
        `up to ${(RECOVERY_LIMIT_MS + 30_000) / 1000} s`
    );

    await c.step(
        "let the probe run on after recovery",
        () => sleep(c.opts.extra["--probe-tail-s"] * 1000),
        `${c.opts.extra["--probe-tail-s"]} s`
    );
    probing = false;
    await c.step("stop the probe", () => probeLoop, "the probe loop ends after its current call");

    const duringRestart = probes.filter((p) => p.atMs >= restartStartedAt && p.atMs < (restartEndedAt ?? Infinity));
    const failuresDuring = duringRestart.filter((p) => !p.ok);
    const errorSamples = [...new Set(probes.filter((p) => !p.ok).map((p) => p.text))].slice(0, 3);
    const recoveryMs = recoveredAt === undefined ? undefined : recoveredAt - restartEndedAt;

    c.observe("restartMs", restartEndedAt === undefined ? undefined : restartEndedAt - restartStartedAt);
    c.observe("probesTotal", probes.length);
    c.observe("probesFailedDuringRestart", failuresDuring.length);
    c.observe("errorSamples", errorSamples);
    c.observe("recoveryMs", recoveryMs);

    await c.step("wait 10 s for sessions to settle", () => sleep(10_000), "the pool reconnects");

    const connectionsAfter = await c.step(
        "count the connections after recovery",
        () => psql(CONNECTIONS_SQL),
        "pg_stat_activity rows of penpot_mcpdev"
    );
    const stuck = await c.step(
        "count sessions idle in a transaction for over 60 s",
        () => psql(STUCK_SQL),
        "a stuck session would hold a lock"
    );
    const revn = await c.step(
        "read the file revision",
        () => dbRevn(fileId),
        "the file still answers from the database"
    );
    c.observe("connectionsAfter", Number(connectionsAfter));
    c.observe("stuckIdleInTransaction", Number(stuck));
    c.observe("revnAfter", revn);
    c.observe("lastProbe", outcome(probes[probes.length - 1] ?? { ok: false, durationMs: 0, text: "" }));

    c.check(
        "errors during the restart are clear",
        "every failure during the restart carries an error text (no silent empty answer)",
        failuresDuring.every((p) => p.text.length > 0),
        { failuresDuringRestart: failuresDuring.length, samples: errorSamples }
    );
    c.check(
        "recovers within 60 s",
        "the first ok answer comes within 60 s of the restart ending",
        recoveryMs !== undefined && recoveryMs <= RECOVERY_LIMIT_MS,
        { recoveryMs }
    );
    c.check("no stuck sessions", "no session is idle in a transaction for over 60 s", Number(stuck) === 0, {
        stuck: Number(stuck),
    });
    c.check(
        "no connection pile-up",
        "the connection count after recovery is at most 10 above the count before the restart",
        Number(connectionsAfter) <= Number(baselineConnections) + 10,
        { before: Number(baselineConnections), after: Number(connectionsAfter) }
    );
});
