import assert from "node:assert/strict";
import { test } from "node:test";
import { ExportConcurrency } from "./ExportConcurrency";

test("the backend export gate allows four concurrent exports by default", () => {
    assert.equal(ExportConcurrency.readBackendMaximum({}), 4);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: " " }), 4);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "junk" }), 4);
});

test("PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS sets the backend export gate, and zero means no limit", () => {
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "7" }), 7);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "0" }), 0);
});

/**
 * Runs tasks that each hold until released, and reports the most that ran at once.
 *
 * @param starts - for each task, the token digest it runs under
 * @returns the highest number of tasks that ran at the same time, once all of them finished
 */
async function peakConcurrency(starts: string[]): Promise<number> {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const runs = starts.map((digest) =>
        ExportConcurrency.withBackendPermit(digest, async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => release.push(resolve));
            running -= 1;
        })
    );
    // let every task reach its permit before any of them is released
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (release.length > 0 || running > 0) {
        release.splice(0).forEach((resolve) => resolve());
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all(runs);
    return peak;
}

test("the backend gate runs the task and returns its value", async () => {
    assert.equal(await ExportConcurrency.withBackendPermit("digest-a", async () => 42), 42);
});

test("one token runs one render at a time", async () => {
    assert.equal(await peakConcurrency(["token-one", "token-one", "token-one"]), 1);
});

test("different tokens run side by side, up to the process limit", async () => {
    const limit = ExportConcurrency.readBackendMaximum(process.env);
    const peak = await peakConcurrency(["token-a", "token-b", "token-c", "token-d", "token-e", "token-f"]);
    assert.equal(peak, limit === 0 ? 6 : Math.min(6, limit));
});

test("a render that runs past the timeout fails, and frees its token for the next render", async () => {
    await assert.rejects(
        ExportConcurrency.withBackendPermit("token-slow", () => new Promise<never>(() => undefined), 20),
        /did not finish within 0\.02 seconds/
    );
    assert.equal(await ExportConcurrency.withBackendPermit("token-slow", async () => "next"), "next");
});

test("at the deadline the signal of the render is aborted, so the render can stop", async () => {
    let seen: AbortSignal | undefined;
    await assert.rejects(
        ExportConcurrency.withBackendPermit(
            "token-aborted",
            (signal) => {
                seen = signal;
                return new Promise<never>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason));
                });
            },
            20
        ),
        /did not finish within/
    );
    assert.equal(seen?.aborted, true);
});

test("a render that finishes in time gets a signal that is not aborted", async () => {
    const value = await ExportConcurrency.withBackendPermit("token-quick", async (signal) =>
        signal.aborted ? "no" : "yes"
    );
    assert.equal(value, "yes");
});

test("the render timeout is 60 seconds", () => {
    assert.equal(ExportConcurrency.RENDER_TIMEOUT_MS, 60_000);
});
