// Case 3b of T4 (review F1-9): the Redis of the two-adapter stack is stopped. This tests the adapter's own fallback:
// the rate limiter and the sandbox storage of both adapters are shared through that Redis (deploy/README.md).
//
// Expected (plan and deploy/README.md "Settings that change the behaviour"):
//   - the limiter falls back to each adapter's in-process bucket: the fallback counter of both adapters rises, and
//     the calls still answer (no 5xx);
//   - storage reads through the balancer do not return the value stored before the outage (the copy is unavailable),
//     and the adapter log names the failed Redis operation. The code gives no storageNotice for this case: the case
//     records whether one came, and says so when it did not;
//   - a write during the outage commits (the backend does not depend on this Redis);
//   - after the container runs again, the storage round trip works through the balancer and the fallback counters
//     stop rising. Redis is not persistent, so the value stored before the outage is gone (expected).
//
// The stack must be up (deploy/README.md, "How to run"). The defaults are the names compose gives in a project called
// "deploy"; pass the real names when the stack was started with another project name (docker ps shows them).
//
// Usage:
//   node adapter-redis-stopped.mjs --dry-run
//   node adapter-redis-stopped.mjs --yes --token-file <file> --vars <vars.json> [--url http://127.0.0.1:4415/mcp]
//
// --yes is required: the case stops and starts the Redis container of the stack.

import { randomUUID } from "node:crypto";
import {
    BALANCER_MCP_URL,
    runCase,
    adapterFallbackCount,
    containerAction,
    containerLogLines,
    createScratchPage,
    dockerExec,
    ensureRunning,
    outcome,
    runTag,
    sleep,
    waitFor,
} from "./lib.mjs";

const NAME = "adapter-redis-stopped";

const USAGE = `${NAME}: stops the Redis of the two-adapter stack; checks the adapter fallbacks and recovery.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url <balancer MCP URL, default http://127.0.0.1:4415/mcp>,
  --results-dir, --no-cleanup
Extra: --adapter-a <deploy-penpot-mcp-a-1>, --adapter-b <deploy-penpot-mcp-b-1>, --redis <deploy-redis-1>,
  --outage-s <10>, --recover-wait-s <90>`;

const LOG_PATTERN = /redis|storage|rate|limit|fallback/i;

/** Runs one execute_code on the file, through the balancer. */
function execute(c, code) {
    return c.call("execute_code", { fileId: c.config.vars.fileId, code });
}

await runCase(
    NAME,
    {
        "--adapter-a": "deploy-penpot-mcp-a-1",
        "--adapter-b": "deploy-penpot-mcp-b-1",
        "--redis": "deploy-redis-1",
        "--outage-s": 10,
        "--recover-wait-s": 90,
    },
    async (c) => {
        const tag = runTag("c3b");
        const pageName = `chaos ${tag}`;
        const fileId = c.config.vars.fileId;
        const { "--adapter-a": adapterA, "--adapter-b": adapterB, "--redis": redis } = c.opts.extra;
        let pageId;
        let fallbackBefore;
        let sinceIso;

        pageId = await c.step(
            "create a scratch page through the balancer",
            () => createScratchPage(c, pageName),
            "a new page, so the test page of the file is not touched"
        );

        await c.step(
            "store a value in the sandbox storage",
            async () => {
                const answer = await execute(c, `storage.t3probe = "${tag}"; return storage.t3probe;`);
                if (!answer.ok) {
                    throw new Error(`execute_code failed: ${answer.text.slice(0, 200)}`);
                }
            },
            "execute_code through the balancer; the copy goes to Redis"
        );
        const readBefore = await c.step(
            "read the value back through the balancer (twice: round robin)",
            async () => {
                const first = await execute(c, `return storage.t3probe ?? null;`);
                const second = await execute(c, `return storage.t3probe ?? null;`);
                return [first, second].map((answer) => JSON.stringify(answer.json ?? answer.text).includes(tag));
            },
            "both reads should show the stored value before the outage"
        );
        c.observe("storageReadBeforeOutage", readBefore);

        fallbackBefore = await c.step(
            "read the fallback counters of both adapters",
            async () => ({
                a: await adapterFallbackCount(adapterA),
                b: await adapterFallbackCount(adapterB),
            }),
            "penpot_mcp_rate_limit_fallback_total, read inside each container"
        );
        c.observe("fallbackBefore", fallbackBefore);

        sinceIso = new Date().toISOString();
        await c.step(
            `stop ${redis}`,
            () => {
                c.registerCleanup(`start ${redis}`, () => ensureRunning(redis, c.opts.yes));
                return containerAction("stop", redis, { yes: c.opts.yes });
            },
            "docker stop; no volume is touched"
        );
        await c.step("wait for the outage to settle", () => sleep(c.opts.extra["--outage-s"] * 1000), "");

        const burst = await c.step(
            "burst of 25 calls with one token during the outage",
            () => Promise.all(Array.from({ length: 25 }, () => c.call("whoami", {}))),
            "the shared limit is 20 burst; with fallback each adapter has its own bucket"
        );
        const refused = burst.filter((answer) => /rate limited/i.test(answer.text ?? "")).length;
        const admitted = burst.filter((answer) => answer.ok).length;
        const serverErrors = burst.filter((answer) => /internal|exception|500/i.test(answer.text ?? "")).length;
        c.observe("burst", { admitted, refused, serverErrors, other: 25 - admitted - refused });

        const fallbackDuring = await c.step(
            "read the fallback counters during the outage",
            async () => ({
                a: await adapterFallbackCount(adapterA),
                b: await adapterFallbackCount(adapterB),
            }),
            "the counters should rise on both adapters"
        );
        c.observe("fallbackDuringOutage", fallbackDuring);

        const storageDuring = await c.step(
            "read the storage during the outage",
            () => execute(c, `return storage.t3probe ?? null;`),
            "the value must not come back: the copy is unavailable"
        );
        c.observe("storageDuringOutage", outcome(storageDuring));
        c.observe("storageNoticeDuringOutage", storageDuring.json?.storageNotice ?? null);

        const writeDuring = await c.step(
            "write during the outage",
            () =>
                c.call("apply_operations", {
                    fileId,
                    pageId,
                    requestId: randomUUID(),
                    operations: [
                        {
                            op: "create_rect",
                            pageId,
                            id: "$tmp:r",
                            name: `${tag}-during`,
                            x: 40,
                            y: 40,
                            width: 20,
                            height: 20,
                            props: { fills: [{ fillColor: "#33AA66", fillOpacity: 1 }] },
                        },
                    ],
                }),
            "one create_rect through the balancer"
        );
        c.observe("writeDuringOutage", outcome(writeDuring));

        const logsDuring = await c.step(
            "read the adapter log lines of the outage (both adapters)",
            async () => ({
                a: await containerLogLines(adapterA, sinceIso, LOG_PATTERN),
                b: await containerLogLines(adapterB, sinceIso, LOG_PATTERN),
            }),
            "lines that mention redis, storage, the rate limit or the fallback"
        );
        c.observe("adapterLogsDuringOutage", logsDuring);

        await c.step(`start ${redis}`, () => containerAction("start", redis, { yes: c.opts.yes }), "docker start");
        await c.step(
            "wait until Redis answers ping",
            () =>
                waitFor(
                    "redis ping",
                    async () => {
                        const out = await dockerExec(redis, ["sh", "-c", "redis-cli ping || valkey-cli ping"], {
                            timeoutMs: 10_000,
                        }).catch(() => "");
                        return out.trim() === "PONG";
                    },
                    { timeoutMs: c.opts.extra["--recover-wait-s"] * 1000, intervalMs: 2000 }
                ),
            "PONG"
        );

        const recovered = await c.step(
            "storage round trip through the balancer after the restart (up to 60 s)",
            () =>
                waitFor(
                    "a storage write that reads back",
                    async () => {
                        const write = await execute(c, `storage.t3after = "${tag}-after"; return storage.t3after;`);
                        if (!write.ok) {
                            return false;
                        }
                        const read = await execute(c, `return storage.t3after ?? null;`);
                        return JSON.stringify(read.json ?? read.text).includes(`${tag}-after`) ? read : false;
                    },
                    { timeoutMs: 60_000, intervalMs: 3000 }
                ).catch((error) => ({ error: error.message })),
            "write then read through the balancer"
        );
        c.observe("storageRecovered", recovered.error ? { error: recovered.error } : outcome(recovered));

        const fallbackAfterRecovery = await c.step(
            "read the fallback counters after the recovery, then make 5 calls",
            async () => {
                const before = { a: await adapterFallbackCount(adapterA), b: await adapterFallbackCount(adapterB) };
                for (let i = 0; i < 5; i++) {
                    await c.call("whoami", {});
                }
                const after = { a: await adapterFallbackCount(adapterA), b: await adapterFallbackCount(adapterB) };
                return { before, after };
            },
            "no counter should rise once Redis answers again"
        );
        c.observe("fallbackAfterRecovery", fallbackAfterRecovery);

        const counterExposed = fallbackBefore.a !== undefined && fallbackBefore.b !== undefined;
        const fellBack = counterExposed && fallbackDuring.a > fallbackBefore.a && fallbackDuring.b > fallbackBefore.b;
        c.check(
            "limiter falls back on both adapters",
            "the fallback counter rises on both adapters during the outage (the counter must be exposed)",
            fellBack,
            { counterExposed, before: fallbackBefore, during: fallbackDuring }
        );
        c.check(
            "burst answers without server errors",
            "every call of the burst is admitted or refused with the rate-limit text; none is a 5xx",
            serverErrors === 0 && admitted + refused === 25,
            { admitted, refused, serverErrors }
        );
        // Round 2: a warm runtime still holds its own copy of the storage, so the value may come back from adapter
        // memory. That is acceptable when the agent is told that the shared copy could not be used (storageNotice).
        const valueBack = String(JSON.stringify(storageDuring.json ?? storageDuring.text) ?? "").includes(tag);
        const noticeDuring = storageDuring.json?.storageNotice ?? null;
        c.check(
            "storage outage is visible to the agent",
            "storage does not return the value stored before the outage, or the answer carries a storageNotice",
            !valueBack || typeof noticeDuring === "string",
            { valueBack, storageNotice: noticeDuring }
        );
        c.check(
            "outage is logged",
            "an adapter log line names the failed Redis operation or the fallback",
            logsDuring.a.length + logsDuring.b.length > 0,
            { a: logsDuring.a.length, b: logsDuring.b.length }
        );
        c.check(
            "write during the outage commits",
            "a write with the adapter's Redis down commits (the backend does not depend on it)",
            writeDuring.ok === true,
            outcome(writeDuring)
        );
        c.check(
            "storage works after the restart",
            "a storage write and read through the balancer work once Redis answers",
            recovered.error === undefined,
            recovered.error ? { error: recovered.error } : undefined
        );
        c.check(
            "limiter back on Redis",
            "no fallback counter rises across 5 calls after the recovery",
            fallbackAfterRecovery.after.a === fallbackAfterRecovery.before.a &&
                fallbackAfterRecovery.after.b === fallbackAfterRecovery.before.b,
            fallbackAfterRecovery
        );
        if (typeof noticeDuring !== "string") {
            c.note(
                "No storageNotice reached the agent for a storage read that failed on Redis. That is a gap against the table of failure modes."
            );
        }
    },
    USAGE,
    BALANCER_MCP_URL
);
