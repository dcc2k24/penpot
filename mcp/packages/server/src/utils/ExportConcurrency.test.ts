import assert from "node:assert/strict";
import { test } from "node:test";
import { ExportConcurrency, RenderDeadlineError } from "./ExportConcurrency";
import { BusyError } from "./PermitGate";

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
        ExportConcurrency.withBackendPermit("token-slow", () => new Promise<never>(() => undefined), { timeoutMs: 20 }),
        /did not finish within 0\.02 seconds/
    );
    assert.equal(await ExportConcurrency.withBackendPermit("token-slow", async () => "next"), "next");
});

test("a render past its timeout rejects with a RenderDeadlineError that keeps the message", async () => {
    const error = await ExportConcurrency.withBackendPermit("digest-deadline", () => new Promise(() => undefined), {
        timeoutMs: 20,
    }).then(
        () => assert.fail("the render should not finish"),
        (reason: unknown) => reason
    );
    assert.ok(error instanceof RenderDeadlineError);
    assert.equal((error as Error).message, "The export did not finish within 0.02 seconds.");
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
            { timeoutMs: 20 }
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

/**
 * Holds one render of a token until the returned release function is called.
 *
 * @param digest - the token digest the render runs under
 */
function holdRender(digest: string): { started: Promise<void>; release: () => void; done: Promise<unknown> } {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const done = ExportConcurrency.withBackendPermit(digest, async () => {
        markStarted();
        await gate;
        return "held";
    });
    return { started, release, done };
}

test("a call that waits longer than the slot wait is refused as busy, and leaves the queue", async () => {
    const holder = holdRender("token-busy");
    await holder.started;
    await assert.rejects(
        ExportConcurrency.withBackendPermit("token-busy", async () => "late", { waitMs: 20 }),
        /export is busy, retry later: no slot was free for 0\.02 seconds/
    );
    holder.release();
    assert.equal(await holder.done, "held");
    // the refused call did not keep its place: the next call runs at once
    assert.equal(await ExportConcurrency.withBackendPermit("token-busy", async () => "next"), "next");
});

test("the timeout covers the wait for a slot as well as the render", async () => {
    const holder = holdRender("token-queued");
    await holder.started;
    const queued = ExportConcurrency.withBackendPermit("token-queued", async () => "never", {
        timeoutMs: 30,
        waitMs: 5_000,
    });
    await assert.rejects(queued, /did not finish within 0\.03 seconds/);
    holder.release();
    await holder.done;
});

test("heldCounts reads the process permits that this process holds", async () => {
    assert.deepEqual(ExportConcurrency.heldCounts(), { process: 0, shared: 0 });
    const holder = holdRender("token-held");
    await holder.started;
    assert.equal(ExportConcurrency.heldCounts().process, 1);
    holder.release();
    await holder.done;
    assert.equal(ExportConcurrency.heldCounts().process, 0);
});

test("heldCounts reads the shared permits through the shared permits set", () => {
    ExportConcurrency.setSharedPermits({
        heldCount: 3,
        acquire: async () => async () => undefined,
    });
    try {
        assert.equal(ExportConcurrency.heldCounts().shared, 3);
    } finally {
        ExportConcurrency.setSharedPermits(undefined);
    }
});

test("the render timeout is 60 seconds", () => {
    assert.equal(ExportConcurrency.RENDER_TIMEOUT_MS, 60_000);
});

test("the shared permit is taken after the process permit, and given back when the render fails", async () => {
    const events: string[] = [];
    ExportConcurrency.setSharedPermits({
        heldCount: 0,
        acquire: async (wait) => {
            events.push(`take within ${wait.waitMs <= ExportConcurrency.PERMIT_WAIT_MS ? "budget" : "too long"}`);
            return async () => {
                events.push("give");
            };
        },
    });
    try {
        await assert.rejects(
            ExportConcurrency.withBackendPermit("token-shared", async () => {
                events.push("render");
                throw new Error("render failed");
            }),
            /render failed/
        );
        assert.deepEqual(events, ["take within budget", "render", "give"]);
    } finally {
        ExportConcurrency.setSharedPermits(undefined);
    }
});

test("a refused shared permit gives the busy error and frees the token and process slots", async () => {
    let refuse = true;
    ExportConcurrency.setSharedPermits({
        heldCount: 0,
        acquire: async () => {
            if (refuse) {
                throw new BusyError("export", 20);
            }
            return async () => undefined;
        },
    });
    try {
        await assert.rejects(
            ExportConcurrency.withBackendPermit("token-refused", async () => "never"),
            /export is busy/
        );
        refuse = false;
        assert.equal(await ExportConcurrency.withBackendPermit("token-refused", async () => "next"), "next");
    } finally {
        ExportConcurrency.setSharedPermits(undefined);
    }
});

test("a busy refusal is counted under the gate that refused it", async () => {
    const before = ExportConcurrency.busyCounts();
    const holder = holdRender("token-counted");
    await holder.started;
    await assert.rejects(
        ExportConcurrency.withBackendPermit("token-counted", async () => "late", { waitMs: 10 }),
        /export is busy/
    );
    holder.release();
    await holder.done;
    const afterToken = ExportConcurrency.busyCounts();
    assert.equal(afterToken.token - before.token, 1);
    assert.equal(afterToken.shared - before.shared, 0);

    ExportConcurrency.setSharedPermits({
        heldCount: 0,
        acquire: async () => {
            throw new BusyError("export", 10);
        },
    });
    try {
        await assert.rejects(
            ExportConcurrency.withBackendPermit("token-counted-shared", async () => "never"),
            /export is busy/
        );
    } finally {
        ExportConcurrency.setSharedPermits(undefined);
    }
    const afterShared = ExportConcurrency.busyCounts();
    assert.equal(afterShared.shared - afterToken.shared, 1);
    assert.equal(afterShared.token - afterToken.token, 0);

    await assert.rejects(
        ExportConcurrency.withBackendPermit("token-counted-deadline", () => new Promise<never>(() => undefined), {
            timeoutMs: 20,
        }),
        /did not finish within/
    );
    const afterDeadline = ExportConcurrency.busyCounts();
    assert.deepEqual(afterDeadline, afterShared);
});

test("the shared permit lease covers the render timeout with a margin of 5 seconds", () => {
    assert.equal(ExportConcurrency.PERMIT_LEASE_MS, 65_000);
    assert.equal(ExportConcurrency.PERMIT_LEASE_MS, ExportConcurrency.RENDER_TIMEOUT_MS + 5_000);
});
