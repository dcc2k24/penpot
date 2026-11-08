// Case 6 of T4: a slow backend write. A psql session holds the file lock for 20 s while an agent writes.
//
// Expected (rpc/commands/mcp_write.clj, lock-wait!): the agent's write waits for the file lock for 15 s (lock_timeout)
// and then fails with the conflict code mcp-file-busy, not with a 500. Nothing is applied. After the lock is released
// the next write works.
//
// Lock used: the write takes the advisory lock of the file (db.clj xact-lock!, a SipHash of the file id, not
// reproduced here), and then the share lock of the file row (bfc/get-file :lock-for-share?). This case holds the
// row lock with SELECT ... FOR UPDATE on the file row, which blocks that share lock in the same way.
//
// Coverage (review F1-11): both waits run inside one lock-wait! call (mcp_write.clj, about lines 548-593), and the
// 55P03 handler is shared. So the error and the wait the agent sees are the same ones it sees for the advisory lock.
// What this case does NOT exercise is the advisory-lock wait itself. A second variant, two MCP writers on one file with
// the first one sending 2,000 operations, would exercise it; it is not built.
//
// Usage:
//   node slow-backend.mjs --dry-run
//   node slow-backend.mjs --yes --token-file <file> --vars <vars.json>
//
// --yes is required: the case runs SQL on the dev database that holds a row lock (no container is stopped).

import { randomUUID } from "node:crypto";
import {
    raceTimeout,
    run,
    runCase,
    CONTAINERS,
    PG_DB,
    PG_USER,
    createScratchPage,
    dbRevn,
    outcome,
    outlineShapeCount,
    psql,
    runTag,
    sleep,
    waitFor,
} from "./lib.mjs";

const NAME = "slow-backend";

const USAGE = `${NAME}: holds the file row lock for 20 s in psql while an agent writes; expects mcp-file-busy, then recovery.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --adapter-log
Extra: --hold-s <20>`;

function oneRect(pageId, name) {
    return {
        op: "create_rect",
        pageId,
        id: "$tmp:r",
        name,
        x: 60,
        y: 60,
        width: 30,
        height: 30,
        props: { fills: [{ fillColor: "#AA3366", fillOpacity: 1 }] },
    };
}

await runCase(NAME, { "--hold-s": 20 }, async (c) => {
    const tag = runTag("c6");
    const pageName = `chaos ${tag}`;
    const fileId = c.config.vars.fileId;
    const holdS = c.opts.extra["--hold-s"];
    let pageId;
    let holder;
    let before;
    let busy;
    let busyDurationMs;
    let afterBusy;
    let next;

    pageId = await c.step(
        "create a scratch page",
        () => createScratchPage(c, pageName),
        "a new page, so the test page of the file is not touched"
    );

    before = await c.step(
        "read the baseline",
        async () => ({ revn: await dbRevn(fileId), shapes: await outlineShapeCount(c, pageName) }),
        "file.revn and the scratch page shape count"
    );
    c.observe("baseline", before);

    const holdSql = [
        "BEGIN;",
        `SELECT id FROM file WHERE id = '${fileId}' FOR UPDATE;`,
        `SELECT pg_sleep(${holdS});`,
        "COMMIT;",
        "",
    ].join("\n");

    await c.step(
        "hold the file row lock in psql",
        async () => {
            holder = run(
                "docker",
                [
                    "exec",
                    "-i",
                    CONTAINERS.postgres,
                    "psql",
                    "-U",
                    PG_USER,
                    "-d",
                    PG_DB,
                    "-X",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-f",
                    "-",
                ],
                { timeoutMs: (holdS + 60) * 1000, input: holdSql }
            );
            await waitFor(
                "the holder to sleep inside the lock",
                () =>
                    psql(
                        `select count(*) from pg_stat_activity where query like 'SELECT pg_sleep(%' and state = 'active' and pid <> pg_backend_pid()`
                    ).then((n) => Number(n) >= 1),
                { timeoutMs: 15_000, intervalMs: 500 }
            );
        },
        `BEGIN; SELECT ... FROM file WHERE id = <file> FOR UPDATE; pg_sleep(${holdS}); COMMIT`
    );

    busy = await c.step(
        "agent writes while the lock is held",
        async () => {
            const started = Date.now();
            const answer = await c.call("apply_operations", {
                fileId,
                pageId,
                requestId: randomUUID(),
                operations: [oneRect(pageId, `${tag}-busy`)],
            });
            busyDurationMs = Date.now() - started;
            return answer;
        },
        "one create_rect; the lock is held for the whole wait"
    );
    c.observe("writeWhileLocked", outcome(busy));
    c.observe("writeWhileLockedWallMs", busyDurationMs);

    afterBusy = await c.step(
        "read the file while the lock was held and the write failed",
        async () => ({ revn: await dbRevn(fileId), shapes: await outlineShapeCount(c, pageName) }),
        "nothing from the failed write may be in the file"
    );
    c.observe("afterBusy", afterBusy);

    await c.step(
        "wait for the holder to release the lock",
        () => raceTimeout(holder, (holdS + 45) * 1000, () => ({ code: -1, stderr: "holder still running" })),
        "COMMIT of the holder"
    );

    next = await c.step(
        "write after the release",
        () =>
            c.call("apply_operations", {
                fileId,
                pageId,
                requestId: randomUUID(),
                operations: [oneRect(pageId, `${tag}-next`)],
            }),
        "a new requestId: this is a new write"
    );
    c.observe("writeAfterRelease", outcome(next));
    const finalState = await c.step(
        "read the file after the next write",
        async () => ({ revn: await dbRevn(fileId), shapes: await outlineShapeCount(c, pageName) }),
        "revn and shape count"
    );
    c.observe("final", finalState);

    const busyText = `${busy.text ?? ""} ${busy.error ?? ""}`;
    c.check(
        "busy write fails with mcp-file-busy",
        "the write fails with the conflict code mcp-file-busy, and the text names the file",
        busy.isError === true && /mcp-file-busy/.test(busyText),
        outcome(busy)
    );
    c.check(
        "busy write is not a server error",
        "the answer is not a 500 or an internal error",
        !/\b500\b|internal server error|NullPointer|Exception/i.test(busyText),
        { text: busyText.slice(0, 200) }
    );
    c.check(
        "busy write waits about the file lock timeout",
        "the write returns after about 15 s (between 10 s and 25 s), not at once and not at the 55 s adapter timeout",
        busyDurationMs >= 10_000 && busyDurationMs <= 25_000,
        { wallMs: busyDurationMs }
    );
    c.check(
        "busy write applied nothing",
        "revn and the shape count are unchanged by the failed write",
        afterBusy.revn === before.revn && afterBusy.shapes === before.shapes,
        { before, afterBusy }
    );
    c.check(
        "write after the release works",
        "the next write is ok and adds exactly one shape",
        next.ok === true && finalState.shapes === before.shapes + 1,
        { ok: next.ok, shapes: finalState.shapes }
    );
    c.note(`The lock hold is ${holdS} s; the adapter timeout is 55 s, so the 15 s lock wait is what the agent sees.`);
});
