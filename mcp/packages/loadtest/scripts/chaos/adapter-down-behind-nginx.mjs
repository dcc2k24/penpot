// Plan addition 14, case 1: one adapter container is stopped behind the nginx balancer of the two-adapter stack.
//
// Expected: calls keep passing through the other adapter (nginx retries a connection that was refused, and after two
// failures it skips the stopped adapter for 10 s), the sandbox storage survives because it lives in Redis, and the
// stopped adapter takes calls again once it runs and is healthy.
//
// The stack must be up (deploy/README.md). Names default to the compose project "deploy"; pass the real ones with
// --adapter, --other and --redis when docker ps shows other names.
//
// Usage:
//   node adapter-down-behind-nginx.mjs --dry-run
//   node adapter-down-behind-nginx.mjs --yes --token-file <file> --vars <vars.json> [--url http://127.0.0.1:4415/mcp]
//
// --yes is required: the case stops and starts one adapter container. Its cleanup starts it again.

import {
    BALANCER_MCP_URL,
    runCase,
    containerAction,
    containerHealth,
    containerLogLines,
    ensureRunning,
    outcome,
    runTag,
    sleep,
    waitFor,
} from "./lib.mjs";

const NAME = "adapter-down-behind-nginx";
const RECEIVED = /Received MCP request/;

const USAGE = `${NAME}: stops one adapter behind the balancer; calls must keep passing through the other.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url <balancer MCP URL, default http://127.0.0.1:4415/mcp>,
  --results-dir, --no-cleanup
Extra: --adapter <deploy-penpot-mcp-a-1> (the one stopped), --calls <40>, --outage-s <5>, --recover-wait-s <120>`;

await runCase(
    NAME,
    {
        "--adapter": "deploy-penpot-mcp-a-1",
        "--other": "deploy-penpot-mcp-b-1",
        "--calls": 40,
        "--outage-s": 5,
        "--recover-wait-s": 120,
    },
    async (c) => {
        const tag = runTag("c3c");
        const fileId = c.config.vars.fileId;
        const { "--adapter": stopped, "--other": other } = c.opts.extra;
        const calls = c.opts.extra["--calls"];
        let sinceIso;

        await c.step(
            "store a value in the sandbox storage (Redis copy)",
            async () => {
                const answer = await c.call("execute_code", {
                    fileId,
                    code: `storage.t3c = "${tag}"; return storage.t3c;`,
                });
                if (!answer.ok) {
                    throw new Error(`execute_code failed: ${answer.text.slice(0, 200)}`);
                }
            },
            "one execute_code"
        );

        sinceIso = new Date().toISOString();
        await c.step(
            `stop ${stopped}`,
            () => {
                c.registerCleanup(`start ${stopped}`, async () => {
                    await ensureRunning(stopped, c.opts.yes);
                    await waitFor("adapter healthy", () => containerHealth(stopped).then((h) => h === "healthy"), {
                        timeoutMs: 180_000,
                        intervalMs: 3000,
                    });
                });
                return containerAction("stop", stopped, { yes: c.opts.yes });
            },
            "docker stop; the balancer keeps the other adapter"
        );
        await c.step("wait for the outage to settle", () => sleep(c.opts.extra["--outage-s"] * 1000), "");

        const sequence = await c.step(
            `${calls} calls through the balancer while one adapter is down`,
            async () => {
                const answers = [];
                for (let i = 0; i < calls; i++) {
                    // stay under the 10 calls a second of one token, so a refusal is not read as an outage failure
                    await sleep(150);
                    answers.push(
                        i % 2 === 0
                            ? await c.call("whoami", {})
                            : await c.call("execute_code", { fileId, code: "return storage.t3c ?? null;" })
                    );
                }
                return answers;
            },
            "alternating whoami and a storage read"
        );
        const failed = sequence.filter((answer) => !answer.ok);
        const storageReads = sequence.filter((_, index) => index % 2 === 1);
        const storageHeld = storageReads.filter((answer) => JSON.stringify(answer.json ?? answer.text).includes(tag));
        c.observe("callsFailed", failed.length);
        c.observe(
            "slowestMs",
            sequence.reduce((max, answer) => Math.max(max, Math.round(answer.durationMs)), 0)
        );
        c.observe("failedSamples", failed.slice(0, 3).map(outcome));

        const otherLog = await c.step(
            "read the other adapter's log for the calls",
            () => containerLogLines(other, sinceIso, RECEIVED),
            "Received MCP request lines since the stop"
        );
        const stoppedLog = await c.step(
            "read the stopped adapter's log for the outage",
            () => containerLogLines(stopped, sinceIso, RECEIVED),
            "should be empty while it is down"
        );
        c.observe("requestsOnOther", otherLog.length);
        c.observe("requestsOnStoppedDuringOutage", stoppedLog.length);

        await c.step(`start ${stopped} and wait until healthy`, async () => {
            await containerAction("start", stopped, { yes: c.opts.yes });
            await waitFor("adapter healthy", () => containerHealth(stopped).then((h) => h === "healthy"), {
                timeoutMs: c.opts.extra["--recover-wait-s"] * 1000,
                intervalMs: 3000,
            });
        });
        const recoverSince = new Date().toISOString();
        await c.step(
            "20 calls over 15 s after the restart",
            async () => {
                for (let i = 0; i < 20; i++) {
                    await c.call("whoami", {});
                    await sleep(750);
                }
            },
            "nginx skips a failed server for 10 s, so the first calls may all reach the other one"
        );
        const backLog = await c.step(
            "read the restarted adapter's log",
            () => containerLogLines(stopped, recoverSince, RECEIVED),
            "requests after the restart"
        );
        c.observe("requestsOnStoppedAfterRestart", backLog.length);

        c.check(
            "calls pass through the other adapter",
            `at most 1 of ${calls} calls fails while one adapter is down`,
            failed.length <= 1,
            { failed: failed.length }
        );
        c.check(
            "the other adapter serves the calls",
            "its log has request lines since the stop; the stopped adapter has none while down",
            otherLog.length > 0 && stoppedLog.length === 0,
            { other: otherLog.length, stopped: stoppedLog.length }
        );
        c.check(
            "storage survives the adapter outage",
            "storage reads through the balancer still return the value (it lives in Redis)",
            storageHeld.length === storageReads.length && storageReads.length > 0,
            { held: storageHeld.length, reads: storageReads.length }
        );
        c.check(
            "the restarted adapter takes calls again",
            "its log has request lines after the restart",
            backLog.length > 0,
            { requests: backLog.length }
        );
    },
    USAGE,
    BALANCER_MCP_URL
);
