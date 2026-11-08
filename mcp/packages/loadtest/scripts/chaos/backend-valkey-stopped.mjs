// Case 3a of T4 (review F1-9): the dev backend's valkey container is stopped while the adapter has no Redis.
//
// This tests the backend's own dependence on valkey, not the adapter's Redis fallback (that is
// adapter-redis-stopped.mjs). The dev adapter runs without PENPOT_MCP_REDIS_URI, so its rate limit and storage are
// in process. The backend uses valkey for the msgbus notifications after a commit (files_update.clj publishes after
// commit) and for the rlimit counters.
//
// Expected:
//   - a write during the outage commits (the plan's expectation; if the rlimit path refuses it, the check fails and
//     the answer text is in the result, which is the finding);
//   - the notifications that cannot be published are dropped, and the backend log says so (checked on the new log
//     lines of the outage);
//   - reads work; a write after the container runs again commits.
//
// Usage:
//   node backend-valkey-stopped.mjs --dry-run
//   node backend-valkey-stopped.mjs --yes --token-file <file> --vars <vars.json>
//
// --yes is required: the case stops and starts the valkey container. Its cleanup starts it again when the case fails.

import { randomUUID } from "node:crypto";
import {
    runCase,
    CONTAINERS,
    containerAction,
    createScratchPage,
    dbRevn,
    dockerExec,
    ensureRunning,
    outcome,
    runTag,
    sleep,
    waitFor,
} from "./lib.mjs";

const NAME = "backend-valkey-stopped";

const USAGE = `${NAME}: stops ${CONTAINERS.valkey} (the backend's valkey) while the adapter has no Redis.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --no-cleanup
Extra: --outage-s <5> (how long valkey stays down before the outage write)`;

const BACKEND_LOG = "/tmp/backend-dev.log";
const NOTIFY_PATTERN = /redis|valkey|msgbus|publish/i;

function oneRect(pageId, name) {
    return {
        op: "create_rect",
        pageId,
        id: "$tmp:r",
        name,
        x: 40,
        y: 40,
        width: 30,
        height: 30,
        props: { fills: [{ fillColor: "#33AA66", fillOpacity: 1 }] },
    };
}

/** Line count of the backend log: the cursor for the lines written during the outage. */
async function backendLogLines() {
    const out = await dockerExec(CONTAINERS.backend, ["bash", "-c", `wc -l < ${BACKEND_LOG}`], { timeoutMs: 20_000 });
    return Number(out.trim());
}

/** Backend log lines after the cursor that mention valkey or Redis. */
async function backendLogSince(cursor) {
    const script = `tail -n +${cursor + 1} ${BACKEND_LOG} | grep -i -E 'redis|valkey|msgbus' | tail -n 30`;
    const out = await dockerExec(CONTAINERS.backend, ["bash", "-c", script], { timeoutMs: 30_000 });
    return out
        .split(/\r?\n/)
        .filter((line) => line.length > 0 && NOTIFY_PATTERN.test(line))
        .map((line) => line.slice(0, 300));
}

await runCase(NAME, { "--outage-s": 5 }, async (c) => {
    const tag = runTag("c3a");
    const pageName = `chaos ${tag}`;
    const fileId = c.config.vars.fileId;
    let pageId;
    let revnBefore;
    let logCursor;

    pageId = await c.step(
        "create a scratch page",
        () => createScratchPage(c, pageName),
        "a new page, so the test page of the file is not touched"
    );
    revnBefore = await c.step("read the revision before the outage", () => dbRevn(fileId), "file.revn");
    logCursor = await c.step(
        "remember the backend log position",
        () => backendLogLines(),
        `line count of ${BACKEND_LOG} in ${CONTAINERS.backend}`
    );

    await c.step(
        `stop ${CONTAINERS.valkey}`,
        () => {
            c.registerCleanup(`start ${CONTAINERS.valkey}`, () => ensureRunning(CONTAINERS.valkey, c.opts.yes));
            return containerAction("stop", CONTAINERS.valkey, { yes: c.opts.yes });
        },
        "docker stop; no volume is touched"
    );
    await c.step("wait for the outage to settle", () => sleep(c.opts.extra["--outage-s"] * 1000), "");

    const duringAnswer = await c.step(
        "write during the outage",
        () =>
            c.call("apply_operations", {
                fileId,
                pageId,
                requestId: randomUUID(),
                operations: [oneRect(pageId, `${tag}-during`)],
            }),
        "one create_rect while valkey is down"
    );
    c.observe("writeDuringOutage", outcome(duringAnswer));
    const revnDuring = await c.step("read the revision after the outage write", () => dbRevn(fileId), "file.revn");

    const duringOutline = await c.step(
        "read the outline during the outage",
        () => c.call("get_file_outline", { fileId }),
        "get_file_outline"
    );
    c.observe("outlineDuringOutage", outcome(duringOutline));

    const notifyLines = await c.step(
        "read the backend log lines of the outage",
        () => backendLogSince(logCursor),
        "lines that mention redis, valkey or msgbus"
    );
    c.observe("backendLogDuringOutage", notifyLines);

    await c.step(
        `start ${CONTAINERS.valkey}`,
        () => containerAction("start", CONTAINERS.valkey, { yes: c.opts.yes }),
        "docker start"
    );
    await c.step(
        "wait until valkey answers ping",
        () =>
            waitFor(
                "valkey ping",
                async () => {
                    const out = await dockerExec(CONTAINERS.valkey, ["sh", "-c", "valkey-cli ping || redis-cli ping"], {
                        timeoutMs: 10_000,
                    }).catch(() => "");
                    return out.trim() === "PONG";
                },
                { timeoutMs: 120_000, intervalMs: 2000 }
            ),
        "PONG from the container"
    );

    const afterAnswer = await c.step(
        "write after the restart (retried for up to 60 s)",
        async () => {
            const requestId = randomUUID();
            try {
                return await waitFor(
                    "a write that commits",
                    async () => {
                        const answer = await c.call("apply_operations", {
                            fileId,
                            pageId,
                            requestId,
                            operations: [oneRect(pageId, `${tag}-after`)],
                        });
                        return answer.ok ? answer : false;
                    },
                    { timeoutMs: 60_000, intervalMs: 3000 }
                );
            } catch (error) {
                return { ok: false, isError: true, text: "", error: error.message };
            }
        },
        "one create_rect, same requestId on each attempt"
    );
    c.observe("writeAfterRestart", afterAnswer.error ? { error: afterAnswer.error } : outcome(afterAnswer));
    const revnAfter = await c.step("read the revision after the restart write", () => dbRevn(fileId), "file.revn");
    c.observe("revn", { before: revnBefore, duringOutage: revnDuring, afterRestart: revnAfter });

    c.check(
        "write during the outage commits",
        "a write with valkey down commits (revn rises by one, answer ok); if refused, the answer text is the finding",
        duringAnswer.ok === true && revnDuring === revnBefore + 1,
        { ok: duringAnswer.ok, revnBefore, revnDuring }
    );
    c.check(
        "dropped notifications are logged",
        "the backend log names the failed valkey publish during the outage",
        notifyLines.length > 0,
        { lines: notifyLines.length }
    );
    c.check(
        "reads work during the outage",
        "get_file_outline answers while valkey is down",
        duringOutline.ok === true,
        outcome(duringOutline)
    );
    c.check(
        "write after the restart commits",
        "a write after valkey answers again commits",
        afterAnswer.ok === true && revnAfter > revnDuring,
        { ok: afterAnswer.ok, revnAfter, revnDuring }
    );
    c.note(
        "The backend's valkey use is not in the failure-mode table of system.md section 4: this result is the first evidence for it."
    );
});
