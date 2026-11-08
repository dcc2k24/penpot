// Case 1 of T4: the dev backend JVM dies while a 300-rectangle apply_operations call is in flight.
//
// Failure-mode row (system.md section 4): "Adapter restart in a write" and "Duplicate delivery or client retry".
// Expected: the file ends either with the whole write (revision +1, 300 shapes named with this run's tag) or with
// none of it. A retry with the same requestId and payload then either applies once (when nothing was committed)
// or answers alreadyApplied (when the write had committed). Never two copies.
//
// Steps: scratch page, baseline, start the write, kill the backend JVM, wait for the call to end, restart the
// backend with restart-backend-dev, read the file, retry with the same requestId, read the file again.
//
// Usage:
//   node backend-stopped-during-write.mjs --dry-run
//   node backend-stopped-during-write.mjs --yes --token-file <file> --vars <vars.json> [--url <mcp url>]
//
// --yes is required: the case kills the backend JVM and restarts it through restart-backend-dev.

import { randomUUID } from "node:crypto";
import {
    raceTimeout,
    runCase,
    CONTAINERS,
    KILL_BACKEND_JVM,
    backendReady,
    countNamed,
    createScratchPage,
    dbRevn,
    dockerExec,
    outcome,
    outlineShapeCount,
    runTag,
    sleep,
    waitFor,
} from "./lib.mjs";

const NAME = "backend-stopped-during-write";
const RECTS = 300;

const USAGE = `${NAME}: kills the dev backend JVM during a ${RECTS}-rectangle write, restarts it, and checks the file.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --adapter-log
Extra: --kill-after-ms <400> (wait after the call starts before the kill)`;

function rectOperations(pageId, tag) {
    return Array.from({ length: RECTS }, (_, i) => ({
        op: "create_rect",
        pageId,
        id: `$tmp:r${i}`,
        name: `${tag}-${i}`,
        x: 20 + (i % 20) * 30,
        y: 20 + Math.floor(i / 20) * 30,
        width: 20,
        height: 20,
        props: { fills: [{ fillColor: "#3366FF", fillOpacity: 1 }] },
    }));
}

async function snapshot(c, pageName, pageId, tag) {
    return {
        revn: await dbRevn(c.config.vars.fileId),
        shapes: await outlineShapeCount(c, pageName),
        named: await countNamed(c, pageId, tag),
    };
}

/** A transport or tool error has no answer text, so a dropped connection counts as an error the agent saw. */
function isClearError(answer) {
    if (answer.ok) {
        return true;
    }
    const text = answer.text ?? "";
    if (answer.error) {
        return true;
    }
    return text.length > 0 && !/Exception|NullPointer|\bat [a-z]+\.[a-z]/i.test(text);
}

await runCase(NAME, { "--kill-after-ms": 400 }, async (c) => {
    const tag = runTag("c1");
    const pageName = `chaos ${tag}`;
    const requestId = randomUUID();
    const fileId = c.config.vars.fileId;
    let pageId;
    let pending;
    let baseline;
    let afterKill;
    let afterRestart;
    let retry;
    let afterRetry;

    pageId = await c.step(
        "create a scratch page",
        () => createScratchPage(c, pageName),
        "a new page, so the test page of the file is not touched"
    );

    const writeArgs = () => ({ fileId, pageId, requestId, operations: rectOperations(pageId, tag) });

    baseline = await c.step(
        "read the baseline",
        () => snapshot(c, pageName, pageId, tag),
        "database revn, outline shape count, shapes named with the run tag"
    );
    c.observe("baseline", baseline);

    await c.step(
        "start the write",
        async () => {
            pending = c
                .call("apply_operations", writeArgs())
                .catch((error) => ({ ok: false, isError: true, text: "", error: String(error), durationMs: 0 }));
        },
        `apply_operations with ${RECTS} create_rect operations and requestId ${requestId}`
    );

    await c.step(
        "let the write reach the backend",
        () => sleep(c.opts.extra["--kill-after-ms"]),
        `${c.opts.extra["--kill-after-ms"]} ms`
    );

    const killed = await c.step(
        "kill the backend JVM",
        async () => {
            c.registerCleanup("restart the backend if /readyz does not answer", async () => {
                if (!(await backendReady())) {
                    await dockerExec(CONTAINERS.backend, ["//usr/local/bin/restart-backend-dev"], {
                        timeoutMs: 900_000,
                    });
                }
            });
            const out = await dockerExec(CONTAINERS.backend, ["bash", "-c", KILL_BACKEND_JVM], { timeoutMs: 60_000 });
            return out.match(/killed=(\d+)/)?.[1] ?? "0";
        },
        "kill -9 every java process whose command line has app.main, as restart-backend-dev does"
    );
    c.observe("killedProcesses", killed);

    const firstAnswer = await c.step(
        "wait for the agent's call to end",
        () =>
            raceTimeout(pending, 75_000, () => ({
                ok: false,
                isError: true,
                text: "",
                error: "no answer within 75 s",
            })),
        "the adapter gives up at 55 s; the case waits at most 75 s"
    );
    c.observe("agentFirstAnswer", firstAnswer.error ? { error: firstAnswer.error } : outcome(firstAnswer));

    await c.step(
        "wait until /readyz is down",
        () => waitFor("backend down", async () => !(await backendReady()), { timeoutMs: 30_000 }),
        "readyz must stop answering 200 after the kill"
    );

    afterKill = await c.step(
        "read the database after the kill",
        () => dbRevn(fileId),
        "postgres is still up, so the revn is readable"
    );
    c.observe("revnAfterKill", afterKill);

    await c.step(
        "restart the backend",
        () => dockerExec(CONTAINERS.backend, ["//usr/local/bin/restart-backend-dev"], { timeoutMs: 900_000 }),
        "restart-backend-dev kills nothing (the JVM is gone) and starts a fresh one; waits for boot"
    );

    await c.step(
        "wait for /readyz",
        () => waitFor("backend ready", () => backendReady(), { timeoutMs: 180_000, intervalMs: 3000 }),
        "200 from http://127.0.0.1:6061/readyz"
    );

    afterRestart = await c.step(
        "read the file after the restart",
        () => snapshot(c, pageName, pageId, tag),
        "revn, outline shape count, shapes named with the run tag"
    );
    c.observe("afterRestart", afterRestart);

    const wholeWrite =
        afterRestart.revn === baseline.revn + 1 &&
        afterRestart.shapes === baseline.shapes + RECTS &&
        afterRestart.named === RECTS;
    const noWrite =
        afterRestart.revn === baseline.revn && afterRestart.shapes === baseline.shapes && afterRestart.named === 0;
    c.check(
        "whole-or-none",
        "the file shows either the whole write (revn +1, 300 shapes) or none (revn unchanged, 0 shapes)",
        wholeWrite || noWrite,
        { wholeWrite, noWrite }
    );
    c.check(
        "agent answer is a clear error or a result",
        "the agent's first answer is a result, or an error without a Java stack trace",
        isClearError(firstAnswer),
        firstAnswer.error ? { error: firstAnswer.error } : outcome(firstAnswer)
    );

    retry = await c.step(
        "retry with the same requestId and payload",
        () => c.call("apply_operations", writeArgs()),
        `requestId ${requestId}, same operations`
    );
    c.observe("retryAnswer", outcome(retry));
    const alreadyApplied = retry.json?.alreadyApplied === true;
    c.check(
        "retry answer matches the file state",
        "when nothing committed the retry applies (no alreadyApplied); when the write committed it answers alreadyApplied",
        noWrite ? retry.ok && !alreadyApplied : wholeWrite ? retry.ok && alreadyApplied : false
    );

    afterRetry = await c.step(
        "read the file after the retry",
        () => snapshot(c, pageName, pageId, tag),
        "the same three numbers"
    );
    c.observe("afterRetry", afterRetry);
    c.check(
        "one copy only",
        "after the retry the file holds exactly one copy: revn baseline +1, shapes baseline +300, 300 named shapes",
        afterRetry.revn === baseline.revn + 1 &&
            afterRetry.shapes === baseline.shapes + RECTS &&
            afterRetry.named === RECTS,
        afterRetry
    );
    c.note(
        "A retry that answers alreadyApplied is only valid within about an hour of the first call (backend_instructions.md)."
    );
});
