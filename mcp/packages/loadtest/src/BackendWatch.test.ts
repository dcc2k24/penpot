import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BackendWatch } from "./BackendWatch.js";
import { type CommandRunner, type PgStatsTarget } from "./PgStats.js";

const METRICS_URL = "http://127.0.0.1:1/metrics";
const TARGET: PgStatsTarget = { container: "penpot-postgres", database: "penpot", user: "penpot" };

/**
 * Builds a scrape with one heap series.
 *
 * @param heap - heap bytes in use
 */
function scrapeWithHeap(heap: number): string {
    return `jvm_memory_bytes_used{area="heap",id="G1 Old Gen"} ${heap}\n`;
}

/**
 * Builds a runner for the Postgres queries. Commands other than docker fail, so that a source that calls them fails.
 *
 * @param statements - returns the current pg_stat_statements count
 * @param events - receives one entry per docker command
 */
function pgRunner(statements: () => number, events: string[] = []): CommandRunner {
    return async (file, args) => {
        if (file !== "docker") {
            throw new Error(`no such program: ${file}`);
        }
        events.push("docker");
        const sql = args[args.length - 1];
        if (sql.includes("pg_stat_statements")) {
            return `${statements()}\n`;
        }
        if (sql.includes("pg_stat_database")) {
            return "10|200|20\n";
        }
        if (sql.includes("file_change")) {
            return "3|4\n";
        }
        return "55\n";
    };
}

/**
 * Waits until a condition holds, polling every millisecond.
 *
 * @param condition - the condition to wait for
 * @throws Error when the condition does not hold within two seconds
 */
async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

describe("BackendWatch", () => {
    test("is disabled and does nothing without options", async () => {
        const watch = new BackendWatch({});
        assert.equal(watch.enabled, false);
        await watch.start();
        const figures = await watch.stop();
        assert.deepEqual(figures, { warnings: [] });
    });

    test("is enabled when a source is configured", () => {
        assert.equal(new BackendWatch({ metricsUrl: METRICS_URL }).enabled, true);
        assert.equal(new BackendWatch({ pgStats: TARGET }).enabled, true);
        assert.equal(new BackendWatch({ serverPid: 1 }).enabled, true);
    });

    test("reports the change of the JVM, request and metrics figures over the run", async () => {
        const start = [
            'jvm_memory_bytes_used{area="heap",id="G1 Old Gen"} 1000',
            'jvm_memory_bytes_max{area="heap"} 4000',
            'jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 1',
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 5',
            "process_cpu_seconds_total 10",
            'penpot_rpc_main_timing_count{name="get-file"} 100',
            'penpot_mcp_tool_duration_seconds_count{tool="whoami",outcome="ok"} 2',
            'hikaricp_connection_usage_millis_count{pool="HikariPool-1"} 40',
            "penpot_db_statements_total 1000",
        ].join("\n");
        const end = [
            'jvm_memory_bytes_used{area="heap",id="G1 Old Gen"} 1500',
            'jvm_memory_bytes_max{area="heap"} 4000',
            'jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 1.5',
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 9',
            "process_cpu_seconds_total 12.5",
            'penpot_rpc_main_timing_count{name="get-file"} 130',
            'penpot_mcp_tool_duration_seconds_count{tool="whoami",outcome="ok"} 5',
            'hikaricp_connection_usage_millis_count{pool="HikariPool-1"} 70',
            "penpot_db_statements_total 1200",
        ].join("\n");
        const bodies = [start, end];
        let calls = 0;
        const fetcher = async () => new Response(bodies[Math.min(calls++, bodies.length - 1)]);
        const watch = new BackendWatch({ metricsUrl: METRICS_URL, fetcher, intervalMs: 60_000 });
        await watch.start();
        const figures = await watch.stop();

        assert.deepEqual(figures.backendHeap, { startBytes: 1000, endBytes: 1500, peakBytes: 1500, maxBytes: 4000 });
        assert.deepEqual(figures.gc, { seconds: 0.5, collections: 4 });
        assert.equal(figures.backendCpuSeconds, 2.5);
        assert.equal(figures.backendRequests, 30);
        assert.equal(figures.mcpCommands, 3);
        assert.equal(figures.connectionCheckouts, 30);
        assert.equal(figures.dbStatements, 200);
        assert.equal(figures.dbStatementsSource, "metrics");
        assert.equal(figures.metricsDelta?.penpot_db_statements_total, 200);
        assert.equal(figures.pg, undefined, "no Postgres source is configured");
        assert.deepEqual(figures.warnings, []);
    });

    test("the heap peak is the largest sample, including the periodic ones", async () => {
        const heaps = [100, 300, 500, 200, 80];
        const served: number[] = [];
        const fetcher = async () => {
            const heap = heaps[Math.min(served.length, heaps.length - 1)];
            served.push(heap);
            return new Response(scrapeWithHeap(heap));
        };
        const watch = new BackendWatch({ metricsUrl: METRICS_URL, fetcher, intervalMs: 2 });
        await watch.start();
        await waitFor(() => served.length >= 3);
        const figures = await watch.stop();

        assert.equal(figures.backendHeap?.startBytes, 100);
        assert.equal(figures.backendHeap?.endBytes, served[served.length - 1]);
        assert.equal(figures.backendHeap?.peakBytes, 500);
        assert.equal(figures.backendHeap?.peakBytes, Math.max(...served));
        assert.deepEqual(figures.warnings, []);
    });

    test("a failing source adds a warning and the other sources still report", async () => {
        const watch = new BackendWatch({
            metricsUrl: METRICS_URL,
            fetcher: async () => new Response("", { status: 503 }),
            pgStats: TARGET,
            runner: pgRunner(() => 500),
            serverPid: 999999999,
            sleep: async () => {},
        });
        await watch.start();
        const figures = await watch.stop();

        assert.equal(figures.backendHeap, undefined);
        assert.equal(figures.pg?.transactions, 0);
        assert.equal(figures.warnings.length, 2, figures.warnings.join("; "));
        assert.match(figures.warnings[0], /^metrics scrape failed: .*answered HTTP 503$/);
        assert.match(figures.warnings[1], /^server rss failed: /);
    });

    test("periodic failures add one warning per source", async () => {
        const served: number[] = [];
        const fetcher = async () => {
            served.push(1);
            if (served.length === 1) {
                return new Response(scrapeWithHeap(100));
            }
            return new Response("", { status: 503 });
        };
        const watch = new BackendWatch({ metricsUrl: METRICS_URL, fetcher, intervalMs: 2 });
        await watch.start();
        await waitFor(() => served.length >= 4);
        const figures = await watch.stop();

        assert.equal(figures.warnings.length, 2, "one warning for the periodic failures and one for the final scrape");
        assert.match(figures.warnings[0], /^metrics scrape failed: /);
        assert.equal(figures.backendHeap, undefined);
    });

    test("pgSettleMs is passed to the injected sleep before the final Postgres sample", async () => {
        const events: string[] = [];
        const watch = new BackendWatch({
            pgStats: TARGET,
            pgSettleMs: 1234,
            runner: pgRunner(() => 500, events),
            sleep: async (ms) => {
                events.push(`sleep:${ms}`);
            },
        });
        await watch.start();
        const figures = await watch.stop();

        const dockerCalls = ["docker", "docker", "docker", "docker"];
        assert.deepEqual(events, [...dockerCalls, "sleep:1234", ...dockerCalls]);
        assert.equal(figures.pg?.rowsRead, 0);
    });

    test("the settle time defaults to 11 seconds", async () => {
        const slept: number[] = [];
        const watch = new BackendWatch({
            pgStats: TARGET,
            runner: pgRunner(() => 500),
            sleep: async (ms) => {
                slept.push(ms);
            },
        });
        await watch.start();
        await watch.stop();
        assert.deepEqual(slept, [11000]);
    });

    test("pg_stat_statements counts give the statement figure when the metrics have none", async () => {
        let statements = 500;
        const watch = new BackendWatch({
            pgStats: TARGET,
            runner: pgRunner(() => statements),
            sleep: async () => {
                statements = 900;
            },
        });
        await watch.start();
        const figures = await watch.stop();

        assert.equal(figures.pg?.statements, 400);
        assert.equal(figures.dbStatements, 400);
        assert.equal(figures.dbStatementsSource, "pg_stat_statements");
    });
});
