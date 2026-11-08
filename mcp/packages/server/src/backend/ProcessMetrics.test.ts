import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterMetrics } from "./AdapterMetrics";
import { ProcessMetrics } from "./ProcessMetrics";

/** Busy-waits so that the event loop sees a delay inside the sampling window. */
function blockEventLoop(milliseconds: number): void {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
        // spin
    }
}

test("families returns the memory and event loop families with their types", () => {
    const metrics = new ProcessMetrics();
    const families = metrics.families();
    const byName = new Map(families.map((family) => [family.name, family]));
    assert.equal(byName.get("process_resident_memory_bytes")?.type, "gauge");
    assert.equal(byName.get("nodejs_heap_used_bytes")?.type, "gauge");
    assert.equal(byName.get("nodejs_eventloop_lag_p50_seconds")?.type, "gauge");
    assert.equal(byName.get("nodejs_eventloop_lag_p99_seconds")?.type, "gauge");
    assert.equal(byName.get("nodejs_eventloop_lag_max_seconds")?.type, "gauge");
    assert.equal(families.length, 5);
});

test("RSS and heap are positive numbers", () => {
    const families = new ProcessMetrics().families();
    const rss = families.find((family) => family.name === "process_resident_memory_bytes");
    const heap = families.find((family) => family.name === "nodejs_heap_used_bytes");
    assert.ok((rss?.samples[0]?.value ?? 0) > 0);
    assert.ok((heap?.samples[0]?.value ?? 0) > 0);
});

test("after start the lag gauges hold one finite sample each", async () => {
    const metrics = new ProcessMetrics();
    metrics.start();
    try {
        await new Promise((resolve) => setTimeout(resolve, 60));
        blockEventLoop(50);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const families = metrics.families();
        const lagNames = [
            "nodejs_eventloop_lag_p50_seconds",
            "nodejs_eventloop_lag_p99_seconds",
            "nodejs_eventloop_lag_max_seconds",
        ];
        for (const name of lagNames) {
            const lag = families.find((family) => family.name === name);
            assert.equal(lag?.samples.length, 1, name);
            assert.equal(lag?.samples[0]?.labels, undefined, `${name} carries no labels`);
            const value = lag?.samples[0]?.value ?? -1;
            assert.ok(Number.isFinite(value));
            assert.ok(value >= 0);
        }
    } finally {
        metrics.stop();
    }
});

test("an empty window reads as zero lag", () => {
    const families = new ProcessMetrics().families();
    const values = [
        "nodejs_eventloop_lag_p50_seconds",
        "nodejs_eventloop_lag_p99_seconds",
        "nodejs_eventloop_lag_max_seconds",
    ].map((name) => families.find((family) => family.name === name)?.samples[0]?.value);
    assert.deepEqual(values, [0, 0, 0]);
});

test("stop can be called twice without throwing", () => {
    const metrics = new ProcessMetrics();
    metrics.start();
    metrics.stop();
    assert.doesNotThrow(() => metrics.stop());
    assert.doesNotThrow(() => metrics.families());
});

test("a render through AdapterMetrics writes TYPE lines and quantile samples", () => {
    const text = new AdapterMetrics().render(new ProcessMetrics().families());
    assert.match(text, /^# TYPE process_resident_memory_bytes gauge$/m);
    assert.match(text, /^# TYPE nodejs_heap_used_bytes gauge$/m);
    assert.match(text, /^# TYPE nodejs_eventloop_lag_p50_seconds gauge$/m);
    assert.match(text, /^# TYPE nodejs_eventloop_lag_p99_seconds gauge$/m);
    assert.match(text, /^# TYPE nodejs_eventloop_lag_max_seconds gauge$/m);
    assert.match(text, /^nodejs_eventloop_lag_p50_seconds [0-9.e+-]+$/m);
    assert.match(text, /^nodejs_eventloop_lag_p99_seconds [0-9.e+-]+$/m);
    assert.match(text, /^nodejs_eventloop_lag_max_seconds [0-9.e+-]+$/m);
    assert.doesNotMatch(text, /quantile=/);
});
