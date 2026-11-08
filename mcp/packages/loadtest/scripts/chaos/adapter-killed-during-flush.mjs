// Case 2 of T4: the adapter is killed while an execute_code call flushes 4,000 operations.
//
// Failure-mode row (system.md section 4): "Adapter restart in a write", for execute_code with several chunks. The
// sandbox flushes in chunks of 1,500 operations (SandboxHost.CHUNK_SIZE), so 4,000 operations are 3 chunks and the
// shape count after the kill must be 0, 1,500, 3,000 or 4,000. No chunk may commit after the one in flight.
//
// The case cannot kill the adapter itself: the adapter runs on the host and the operator owns it. So the case
// prints the manual step, waits for the adapter to come back (the operator restarts it), and then asserts:
//   - the shape count on the scratch page is a chunk boundary,
//   - the count is the same 15 s later (nothing committed after the cut),
//   - the next call (execute_code) reports the same count, and the count in the error text when there is one.
//
// Manual step (the operator does it, in another terminal, while the flush runs):
//   1. Find the adapter process on port 4405 (netstat -ano | findstr :4405) and stop it.
//   2. Start the adapter again with the same command the orchestrator used.
// The case polls the endpoint, so it continues by itself once the adapter answers whoami.
//
// Usage:
//   node adapter-killed-during-flush.mjs --dry-run
//   node adapter-killed-during-flush.mjs --yes --token-file <file> --vars <vars.json> [--url <mcp url>]
//
// --yes is required: the case still needs the operator to act, and it writes to the dev stack.

import { raceTimeout, runCase, createScratchPage, outcome, outlineShapeCount, runTag, sleep, waitFor } from "./lib.mjs";

const NAME = "adapter-killed-during-flush";
const OPS = 4000;
const CHUNK = 1500;
const VALID_BOUNDARIES = [0, CHUNK, 2 * CHUNK, OPS];

const USAGE = `${NAME}: kills the adapter during a ${OPS}-operation execute_code flush (manual kill, then checks).
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --adapter-log
Extra: --wait-s <150> (how long the case waits for the flush call to end), --restart-wait-s <900>`;

function flushCode(tag) {
    return `for (let i = 0; i < ${OPS}; i++) {
  const r = penpot.createRectangle();
  r.name = "${tag}-" + i;
  r.resize(10, 10);
  r.x = (i % 100) * 12;
  r.y = Math.floor(i / 100) * 12;
}
return { created: ${OPS} };`;
}

/** The committed count some answers carry, such as "3000 of 4000 operations are applied". */
function committedFrom(answer) {
    const json = answer?.json;
    const fromJson = json?.committed ?? json?.opsApplied ?? json?.result?.committed ?? json?.result?.opsApplied;
    if (typeof fromJson === "number") {
        return fromJson;
    }
    const match = /committed\D{0,40}?(\d+)/i.exec(answer?.text ?? answer?.error ?? "");
    return match ? Number(match[1]) : undefined;
}

await runCase(NAME, { "--wait-s": 150, "--restart-wait-s": 900 }, async (c) => {
    const tag = runTag("c2");
    const pageName = `chaos ${tag}`;
    const fileId = c.config.vars.fileId;
    let pageId;
    let pending;
    let flushAnswer;
    let count;

    pageId = await c.step(
        "create a scratch page",
        () => createScratchPage(c, pageName),
        "a new page, so the test page of the file is not touched"
    );

    await c.step(
        "start the execute_code flush",
        async () => {
            pending = c
                .call("execute_code", { fileId, pageId, code: flushCode(tag) })
                .catch((error) => ({ ok: false, isError: true, text: "", error: String(error), durationMs: 0 }));
        },
        `execute_code with ${OPS} operations, ${Math.ceil(OPS / CHUNK)} chunks of ${CHUNK}`
    );

    flushAnswer = await c.step(
        "wait for the operator to kill the adapter",
        async () => {
            console.log("");
            console.log("MANUAL STEP: stop the adapter now, while the flush runs.");
            console.log("  Find the process on port 4405 (netstat -ano | findstr :4405) and stop it.");
            console.log("  Then start the adapter again with the command the orchestrator used.");
            console.log("  This case waits for the flush call to end and then polls the adapter.");
            console.log("");
            return raceTimeout(pending, c.opts.extra["--wait-s"] * 1000, () => ({
                ok: false,
                isError: true,
                text: "",
                error: `no answer within ${c.opts.extra["--wait-s"]} s`,
            }));
        },
        "the operator stops the adapter during the flush"
    );
    c.observe("agentFlushAnswer", flushAnswer.error ? { error: flushAnswer.error } : outcome(flushAnswer));
    c.observe("committedReportedByAnswer", committedFrom(flushAnswer));

    await c.step(
        "wait for the adapter to answer again",
        () =>
            waitFor(
                "adapter whoami",
                async () => {
                    await c.reconnect();
                    const answer = await c.call("whoami", {});
                    return answer.ok;
                },
                { timeoutMs: c.opts.extra["--restart-wait-s"] * 1000, intervalMs: 5000 }
            ),
        `polls http://127.0.0.1:4405/mcp, up to ${c.opts.extra["--restart-wait-s"]} s`
    );

    count = await c.step(
        "count the shapes the flush left",
        () => outlineShapeCount(c, pageName), // find_shapes caps at 1,000; the scratch page holds only this run's shapes
        "shapes on the scratch page whose name carries the run tag"
    );
    c.observe("shapesAfterCut", count);

    const countLater = await c.step(
        "count again after 15 s",
        async () => {
            await sleep(15_000);
            return outlineShapeCount(c, pageName);
        },
        "a chunk that committed after the cut would show here"
    );
    c.observe("shapesAfter15s", countLater);

    const nextCall = await c.step(
        "ask for the count with the next call",
        () =>
            c.call("execute_code", {
                fileId,
                pageId,
                code: `return { shapesOnPage: penpot.currentPage.findShapes().length };`,
            }),
        "the scratch page holds only this case's shapes"
    );
    c.observe("nextCallAnswer", outcome(nextCall));
    const shapesOnPage = nextCall.json?.result?.shapesOnPage ?? nextCall.json?.shapesOnPage;

    c.check(
        "cut at a chunk boundary",
        `the shape count is one of ${VALID_BOUNDARIES.join(", ")} (whole chunks only)`,
        VALID_BOUNDARIES.includes(count),
        count
    );
    c.check("nothing commits after the cut", "the count is the same 15 s later", countLater === count, {
        first: count,
        later: countLater,
    });
    c.check(
        "next call agrees",
        "the next call reports the same shapes on the page, and the count in the error when there is one",
        shapesOnPage === count && (committedFrom(flushAnswer) ?? count) === count,
        { shapesOnPage, committedInError: committedFrom(flushAnswer) }
    );
    c.check(
        "complete flush answered ok",
        `when the call answered ok, all ${OPS} shapes must be there`,
        !flushAnswer.ok ? true : count === OPS,
        { answeredOk: flushAnswer.ok, count }
    );
    c.note(
        "A partial flush is not rolled back: the chunks before the cut stay committed. The result of this case is the record of which chunks landed."
    );
});
