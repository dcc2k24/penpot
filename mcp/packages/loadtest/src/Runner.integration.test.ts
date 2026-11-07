import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type BackendFigures, type BackendWatchOptions } from "./BackendWatch.js";
import { ResultFile, type RunResult } from "./ResultFile.js";
import { ScenarioLoader, type Scenario, type ScenarioExpectation } from "./Scenario.js";
import { type BackendWatchLike, checkExpectation, ScenarioRunner, type RunOptions } from "./Runner.js";
import { VariableResolver } from "./VariableResolver.js";
import { StubMcpServer } from "./testing/StubMcpServer.js";

const TOKENS = ["token-agent-0", "token-agent-1", "token-agent-2"];

let stub: StubMcpServer;
let url: string;
let scratch: string;

before(async () => {
    stub = new StubMcpServer();
    url = await stub.start();
    scratch = await mkdtemp(join(tmpdir(), "mcp-loadtest-run-"));
});

after(async () => {
    await stub.stop();
    await rm(scratch, { recursive: true, force: true });
});

/** A two-step scenario: whoami, then a board write whose id is captured from the result. */
function twoStepScenario(): Scenario {
    return ScenarioLoader.parse(
        {
            name: "stub-two-step",
            description: "Two steps against the stub server.",
            agents: 3,
            iterations: 1,
            steps: [
                {
                    name: "whoami",
                    tool: "whoami",
                    args: {},
                    capture: { profileId: "$.result.profileId" },
                    expect: { path: "$.result.profileId", equals: "stub-profile" },
                },
                {
                    name: "create board",
                    tool: "apply_operations",
                    args: {
                        fileId: "file-1",
                        operations: [
                            {
                                op: "create_board",
                                id: "$tmp:board",
                                pageId: "page-1",
                                name: "Agent ${agent}",
                                x: 0,
                                y: 0,
                                width: 10,
                                height: 10,
                            },
                        ],
                    },
                    capture: { boardId: '$.result.createdIds["$tmp:board"]' },
                },
            ],
        },
        "inline"
    );
}

describe("ScenarioRunner against the stub MCP server", () => {
    let output: { result: RunResult; captured: Record<string, unknown> };

    before(async () => {
        output = await new ScenarioRunner({
            url,
            tokens: TOKENS,
            agents: 3,
            vars: {},
            env: {},
            commit: "abc1234",
        }).run(twoStepScenario());
    });

    test("every agent makes one call per step, with its own token", () => {
        assert.equal(output.result.calls, 6);
        assert.equal(output.result.errors, 0, JSON.stringify(output.result.errorSamples));
        assert.deepEqual(
            output.result.steps.map((step) => step.calls),
            [3, 3]
        );
        const tokens = new Set(stub.calls.map((call) => call.token));
        assert.deepEqual([...tokens].sort(), [...TOKENS].sort());
    });

    test("substitutes the agent number and captures values per agent", () => {
        const names = stub.calls
            .filter((call) => call.tool === "apply_operations")
            .map((call) => (call.args.operations as Array<{ name: string }>)[0].name);
        assert.deepEqual(names.sort(), ["Agent 0", "Agent 1", "Agent 2"]);
        assert.ok(typeof output.captured.boardId === "string", "agent 0 captured the board id");
        assert.equal(output.captured.profileId, "stub-profile");
    });

    test("the result has the schema fields and the per-step breakdown", () => {
        const result = output.result;
        assert.equal(result.scenario, "stub-two-step");
        assert.equal(result.commit, "abc1234");
        assert.equal(result.agents, 3);
        assert.equal(result.iterations, 3, "three agents each completed one iteration");
        assert.equal(result.rateLimitPerSecond, null);
        assert.ok(result.machineSpec.cpuCores > 0);
        assert.ok(result.machineSpec.nodeVersion.startsWith("v"));
        assert.ok(result.p95 >= result.p50 && result.max >= result.p99);
        assert.ok(result.heap.peakBytes >= result.heap.startBytes);
        assert.ok(result.rss.peakBytes > 0);
        assert.deepEqual(
            result.steps.map((step) => step.name),
            ["1. whoami", "2. create board"]
        );
        assert.deepEqual(
            result.steps.map((step) => step.tool),
            ["whoami", "apply_operations"]
        );
        assert.ok(result.bytes > 0);
    });

    test("writes a result file whose shape validates", async () => {
        const file = await ResultFile.write(scratch, output.result);
        assert.equal(file, join(scratch, `${output.result.startedAt.slice(0, 10)}-abc1234-stub-two-step.json`));
        const back = await ResultFile.read(file);
        assert.equal(back.steps.length, 2);
        assert.equal(back.commit, "abc1234");
    });
});

describe("ScenarioRunner options", () => {
    test("refuses a run with fewer tokens than agents", async () => {
        await assert.rejects(
            new ScenarioRunner({ url, tokens: ["only-one"], agents: 2, vars: {}, env: {}, commit: "x" }).run(
                twoStepScenario()
            ),
            /2 agents need 2 tokens, but the tokens file has 1/
        );
    });

    test("counts a missing variable as an error without making the call", async () => {
        const scenario = ScenarioLoader.parse(
            { name: "missing", steps: [{ tool: "whoami", args: { fileId: "${notSet}" } }] },
            "inline"
        );
        const callsBefore = stub.calls.length;
        const { result } = await new ScenarioRunner({
            url,
            tokens: ["token-missing"],
            agents: 1,
            vars: {},
            env: {},
            commit: "x",
        }).run(scenario);
        assert.equal(result.errors, 1);
        assert.equal(result.calls, 0);
        assert.equal(stub.calls.length, callsBefore);
        assert.match(result.errorSamples[0], /unknown variable \$\{notSet\}/);
    });

    test("a duration limit repeats the step list until the time is up", async () => {
        const scenario = ScenarioLoader.parse({ name: "timed", steps: [{ tool: "whoami", args: {} }] }, "inline");
        const { result } = await new ScenarioRunner({
            url,
            tokens: ["token-timed"],
            agents: 1,
            vars: {},
            env: {},
            commit: "x",
            durationMs: 300,
            rateLimitPerSecond: 50,
        }).run(scenario);
        assert.ok(result.iterations > 3, `iterations ${result.iterations}`);
        assert.ok(result.durationMs >= 300);
        assert.equal(result.rateLimitPerSecond, 50);
    });
});

describe("checkExpectation", () => {
    test("compares equality and length, and reports the mismatch", () => {
        const json = { matches: [{ id: 1 }, { id: 2 }], revn: 4 };
        assert.equal(checkExpectation([{ path: "$.result.revn", equals: 4 }], json), undefined);
        assert.match(checkExpectation([{ path: "$.result.revn", equals: 5 }], json) ?? "", /to equal 5, got 4/);
        assert.equal(checkExpectation([{ path: "$.result.matches", length: 2 }], json), undefined);
        assert.match(checkExpectation([{ path: "$.result.matches", length: 3 }], json) ?? "", /length 3, got 2/);
        assert.match(checkExpectation([{ path: "$.result.none", length: 1 }], json) ?? "", /no array/);
        assert.equal(checkExpectation(undefined, json), undefined);
    });

    test("checks maxLength, sum and contains", () => {
        const json = { matches: [{ id: 1 }, { id: 2 }], tags: ["a", "b"], counts: [1, 2, 3] };
        assert.equal(checkExpectation([{ path: "$.result.counts", maxLength: 3 }], json), undefined);
        assert.match(
            checkExpectation([{ path: "$.result.counts", maxLength: 2 }], json) ?? "",
            /length at most 2, got 3/
        );
        assert.match(checkExpectation([{ path: "$.result.tags", maxLength: 1 }], json) ?? "", /at most 1, got 2/);
        assert.equal(checkExpectation([{ path: "$.result.counts", sum: 6 }], json), undefined);
        assert.match(checkExpectation([{ path: "$.result.counts", sum: 7 }], json) ?? "", /to sum to 7, got 6/);
        assert.match(checkExpectation([{ path: "$.result.tags", sum: 2 }], json) ?? "", /array of numbers/);
        assert.equal(checkExpectation([{ path: "$.result.tags", contains: "b" }], json), undefined);
        assert.match(checkExpectation([{ path: "$.result.tags", contains: "z" }], json) ?? "", /to contain "z"/);
        assert.equal(checkExpectation([{ path: "$.result.matches", contains: { id: 2 } }], json), undefined);
        assert.match(checkExpectation([{ path: "$.result.matches", contains: { id: 3 } }], json) ?? "", /to contain/);
    });

    test("reports the first failing expectation of a list", () => {
        const json = { counts: [1, 2, 3], tags: ["a"] };
        const expectations: ScenarioExpectation[] = [
            { path: "$.result.counts", length: 3 },
            { path: "$.result.tags", equals: ["x"] },
            { path: "$.result.counts", sum: 99 },
        ];
        assert.match(checkExpectation(expectations, json) ?? "", /to equal \["x"\]/);
        assert.equal(checkExpectation(expectations.slice(0, 1), json), undefined);
    });

    test("accepts a numeric string for a count and rejects other text", () => {
        const json = { counts: [1, 2, 3] };
        assert.equal(checkExpectation([{ path: "$.result.counts", length: "3" }], json), undefined);
        assert.match(
            checkExpectation([{ path: "$.result.counts", length: "abc" }], json) ?? "",
            /must resolve to a whole number/
        );
    });

    test("expectations with placeholders are resolved from the variables before the check", () => {
        const resolver = new VariableResolver({ archiveShapeCount: 2, rectId: "r1" }, {}, {});
        const scope = { agent: 0, iteration: 0, index: 0, runId: "t" };
        const expectations = [
            { path: "$.result.shapes", length: "${archiveShapeCount}", contains: "${rectId}" },
        ] as ScenarioExpectation[];
        const resolved = resolver.expand(expectations, scope) as ScenarioExpectation[];
        assert.equal(checkExpectation(resolved, { shapes: ["r1", "r2"] }), undefined);
        assert.match(checkExpectation(resolved, { shapes: ["r2", "r3"] }) ?? "", /to contain "r1"/);
    });
});

/**
 * Options for a run against the stub, with one token per agent.
 *
 * @param agents - number of simulated agents
 * @param extra - settings that replace the defaults
 */
function runOptions(agents: number, extra: Partial<RunOptions> = {}): RunOptions {
    return {
        url,
        tokens: Array.from({ length: agents }, (_, index) => `token-extra-${index}`),
        agents,
        vars: {},
        env: {},
        commit: "x",
        treeDirty: false,
        ...extra,
    };
}

describe("setup steps, expectError, maxDurationMs, everyMs and expectation placeholders", () => {
    test("setup runs before every iteration, and its captures reach the steps", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "setup-per-iteration",
                iterations: 2,
                setup: [
                    {
                        name: "make page",
                        tool: "apply_operations",
                        args: {
                            fileId: "file-1",
                            operations: [{ op: "create_page", id: "$tmp:page", name: "Setup page" }],
                        },
                        capture: { pageId: '$.result.createdIds["$tmp:page"]' },
                    },
                ],
                steps: [
                    {
                        name: "board",
                        tool: "apply_operations",
                        args: {
                            fileId: "file-1",
                            operations: [
                                {
                                    op: "create_board",
                                    id: "$tmp:board",
                                    pageId: "${pageId}",
                                    name: "Board",
                                    x: 0,
                                    y: 0,
                                    width: 10,
                                    height: 10,
                                },
                            ],
                        },
                    },
                ],
            },
            "inline"
        );
        const mark = stub.calls.length;
        const { result } = await new ScenarioRunner(runOptions(1)).run(scenario);
        assert.equal(result.errors, 0, JSON.stringify(result.errorSamples));
        assert.equal(result.calls, 2, "setup calls are left out of the calls");
        assert.equal(result.steps[0].calls, 2);
        assert.equal(result.iterations, 2);
        assert.equal(result.setupSteps?.length, 1);
        assert.equal(result.setupSteps?.[0].name, "1. make page");
        assert.equal(result.setupSteps?.[0].calls, 2);

        const made = stub.calls.slice(mark);
        const opOf = (call: (typeof made)[number]) => (call.args.operations as Array<Record<string, unknown>>)[0];
        assert.equal(made.filter((call) => opOf(call).op === "create_page").length, 2);
        const boardPages = made.filter((call) => opOf(call).op === "create_board").map((call) => opOf(call).pageId);
        assert.equal(new Set(boardPages).size, 2, "each iteration used the page its own setup created");
        assert.ok(boardPages.every((pageId) => typeof pageId === "string" && pageId !== "${pageId}"));
    });

    test("setupPer agent runs the setup once for each agent", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "setup-per-agent",
                iterations: 3,
                setupPer: "agent",
                setup: [{ name: "who", tool: "whoami", args: {}, capture: { profileId: "$.result.profileId" } }],
                steps: [{ name: "again", tool: "whoami", args: {} }],
            },
            "inline"
        );
        const { result } = await new ScenarioRunner(runOptions(2)).run(scenario);
        assert.equal(result.setupSteps?.[0].calls, 2, "one setup call per agent");
        assert.equal(result.steps[0].calls, 6, "two agents, three iterations");
        assert.equal(result.calls, 6);
        assert.equal(result.errors, 0);
    });

    test("a failing setup step counts as an error and the steps do not run", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "setup-fails",
                iterations: 2,
                setup: [{ name: "boom", tool: "fail_tool", args: { reason: "setup boom" } }],
                steps: [{ name: "who", tool: "whoami", args: {} }],
            },
            "inline"
        );
        const { result } = await new ScenarioRunner(runOptions(1)).run(scenario);
        assert.equal(result.errors, 2, "one error for each failed setup");
        assert.equal(result.setupSteps?.[0].errors, 2);
        assert.equal(result.calls, 0);
        assert.equal(result.steps[0].calls, 0, "the steps did not run");
        assert.equal(result.iterations, 0);
        assert.ok(
            result.errorSamples.includes("setup: Tool execution failed: setup boom"),
            JSON.stringify(result.errorSamples)
        );
    });

    test("expectError passes on a matching failure and fails on a success or a different failure", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "expect-error",
                steps: [
                    { name: "matching", tool: "fail_tool", args: { reason: "quota exceeded" }, expectError: "QUOTA" },
                    { name: "success", tool: "whoami", args: {}, expectError: "nope" },
                    { name: "other", tool: "fail_tool", args: { reason: "disk full" }, expectError: "quota" },
                    { name: "after", tool: "whoami", args: {} },
                ],
            },
            "inline"
        );
        const { result } = await new ScenarioRunner(runOptions(1)).run(scenario);
        assert.deepEqual(
            result.steps.map((step) => step.calls),
            [1, 1, 1, 1]
        );
        assert.deepEqual(
            result.steps.map((step) => step.errors),
            [0, 1, 1, 0]
        );
        assert.equal(result.errors, 2);
        assert.deepEqual(result.errorSamples, [
            "expected an error matching /nope/i, got a success",
            "expected an error matching /quota/i, got: Tool execution failed: disk full",
        ]);
        assert.equal(result.iterations, 1, "a matching failure does not stop the iteration");
    });

    test("maxDurationMs flags a slow call and keeps its latency", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "slow",
                steps: [
                    { name: "slow call", tool: "sleep", args: { ms: 120 }, maxDurationMs: 20 },
                    { name: "fast call", tool: "sleep", args: { ms: 1 }, maxDurationMs: 60000 },
                ],
            },
            "inline"
        );
        const { result } = await new ScenarioRunner(runOptions(1)).run(scenario);
        assert.equal(result.errors, 1);
        assert.match(result.errorSamples[0], /^took \d+ ms, over the limit of 20 ms$/);
        assert.ok(result.steps[0].max >= 100, `latency ${result.steps[0].max}`);
        assert.equal(result.steps[1].errors, 0);
    });

    test("everyMs skips a step that ran less than that long ago, and the iteration still completes", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "every",
                iterations: 2,
                steps: [
                    { name: "slow export", tool: "whoami", args: {}, everyMs: 60000 },
                    { name: "quick", tool: "whoami", args: {} },
                ],
            },
            "inline"
        );
        const { result } = await new ScenarioRunner(runOptions(1)).run(scenario);
        assert.deepEqual(
            result.steps.map((step) => step.calls),
            [1, 2]
        );
        assert.equal(result.iterations, 2);
        assert.equal(result.errors, 0);
    });

    test("expectation placeholders resolve from the variables, and a failed check counts as an error", async () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "placeholders",
                steps: [
                    {
                        name: "who",
                        tool: "whoami",
                        args: {},
                        expect: [
                            { path: "$.result.profileId", equals: "${expectedProfile}" },
                            { path: "$.result.profileId", length: "${profileLength}" },
                            { path: "$.result.profileId", maxLength: "${smallLimit}" },
                        ],
                    },
                ],
            },
            "inline"
        );
        const vars = { expectedProfile: "stub-profile", profileLength: 12, smallLimit: 5 };
        const { result } = await new ScenarioRunner(runOptions(1, { vars })).run(scenario);
        assert.equal(result.errors, 1, JSON.stringify(result.errorSamples));
        assert.match(result.errorSamples[0], /to have length at most 5, got 12/);
    });
});

/** Figures that the fake backend watch returns. Every field is set so that a copy can be checked. */
const WATCH_FIGURES: BackendFigures = {
    dbStatements: 42,
    dbStatementsSource: "metrics",
    backendHeap: { startBytes: 100, endBytes: 300, peakBytes: 500, maxBytes: 1000 },
    gc: { seconds: 0.5, collections: 3 },
    backendCpuSeconds: 2,
    backendRequests: 10,
    mcpCommands: 6,
    connectionCheckouts: 8,
    pg: {
        transactions: 1,
        tableScans: 2,
        rowsRead: 3,
        rowsWritten: 4,
        fileChangeSeqScans: 0,
        fileChangeIdxScans: 1,
    },
    serverRss: { startBytes: 1, endBytes: 2, peakBytes: 3 },
    warnings: ["postgres stats failed: boom"],
};

/**
 * Fake backend watch. It records how many stub calls had arrived when it started and when it stopped.
 */
class FakeWatch implements BackendWatchLike {
    /** Times start ran. */
    starts = 0;
    /** Times stop ran. */
    stops = 0;
    /** Stub calls received when start ran, or undefined when it did not run. */
    startedAtCall?: number;
    /** Stub calls received when stop ran, or undefined when it did not run. */
    stoppedAtCall?: number;

    /**
     * @param enabled - value of the enabled flag
     * @param figures - figures that stop returns
     */
    constructor(
        readonly enabled: boolean,
        private readonly figures: BackendFigures
    ) {}

    /** Records the start. */
    async start(): Promise<void> {
        this.starts++;
        this.startedAtCall = stub.calls.length;
    }

    /** Records the stop and returns the figures. */
    async stop(): Promise<BackendFigures> {
        this.stops++;
        this.stoppedAtCall = stub.calls.length;
        return this.figures;
    }
}

describe("ScenarioRunner with a backend watch", () => {
    test("starts the watch before the first call, stops it after the last, and copies its figures", async () => {
        const watch = new FakeWatch(true, WATCH_FIGURES);
        const before = stub.calls.length;
        const { result } = await new ScenarioRunner(runOptions(3), () => watch).run(twoStepScenario());
        assert.equal(result.calls, 6);
        assert.equal(watch.starts, 1);
        assert.equal(watch.stops, 1);
        assert.equal(watch.startedAtCall, before, "no call had been made when the watch started");
        assert.equal(watch.stoppedAtCall, stub.calls.length, "every call had been made when the watch stopped");
        assert.equal(result.dbStatements, 42);
        assert.equal(result.dbStatementsSource, "metrics");
        assert.deepEqual(result.backendHeap, WATCH_FIGURES.backendHeap);
        assert.deepEqual(result.gc, { seconds: 0.5, collections: 3 });
        assert.equal(result.backendCpuSeconds, 2);
        assert.equal(result.backendRequests, 10);
        assert.equal(result.mcpCommands, 6);
        assert.equal(result.connectionCheckouts, 8);
        assert.deepEqual(result.pg, WATCH_FIGURES.pg);
        assert.deepEqual(result.serverRss, { startBytes: 1, endBytes: 2, peakBytes: 3 });
        assert.deepEqual(result.warnings, ["postgres stats failed: boom"]);
    });

    test("a watch that is not enabled is neither started nor stopped", async () => {
        const watch = new FakeWatch(false, WATCH_FIGURES);
        const { result } = await new ScenarioRunner(runOptions(1), () => watch).run(twoStepScenario());
        assert.equal(watch.starts, 0);
        assert.equal(watch.stops, 0);
        assert.equal(result.dbStatements, undefined);
        assert.equal(result.backendHeap, undefined);
        assert.equal(result.pg, undefined);
        assert.deepEqual(result.warnings, []);
    });

    test("builds the watch from the run options", async () => {
        let seen: BackendWatchOptions | undefined;
        const pgStats = { container: "penpot-postgres", database: "penpot", user: "penpot" };
        const options = runOptions(1, {
            metricsUrl: `${url.replace(/\/mcp$/, "/metrics")}`,
            pgStats,
            serverPid: 4242,
            sampleIntervalMs: 250,
            pgSettleMs: 0,
        });
        await new ScenarioRunner(options, (watchOptions) => {
            seen = watchOptions;
            return new FakeWatch(false, { warnings: [] });
        }).run(twoStepScenario());
        assert.deepEqual(seen, {
            metricsUrl: url.replace(/\/mcp$/, "/metrics"),
            pgStats,
            serverPid: 4242,
            intervalMs: 250,
            pgSettleMs: 0,
        });
    });

    test("a metrics URL that the stub refuses adds a warning and no metrics figures", async () => {
        const { result } = await new ScenarioRunner(
            runOptions(1, { metricsUrl: url.replace(/\/mcp$/, "/metrics") })
        ).run(twoStepScenario());
        assert.equal(result.calls, 2);
        assert.equal(result.metricsDelta, undefined);
        assert.equal(result.dbStatements, undefined);
        assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
        assert.match(result.warnings[0], /^metrics scrape failed: /);
    });
});

describe("warm-up, open-loop pacing and provenance", () => {
    test("the first calls of a warm-up are left out of the figures but still run", async () => {
        const { result, captured } = await new ScenarioRunner(runOptions(3, { warmup: { calls: 2 } })).run(
            twoStepScenario()
        );
        assert.equal(result.calls, 4, "6 calls made, 2 excluded");
        assert.deepEqual(result.warmup, { spec: "2 calls", excludedCalls: 2 });
        assert.equal(
            result.steps.reduce((sum, step) => sum + step.calls, 0),
            4
        );
        assert.equal(result.errors, 0);
        assert.equal(captured.profileId, "stub-profile");
    });

    test("a duration warm-up that covers the whole run leaves every call out", async () => {
        const { result } = await new ScenarioRunner(runOptions(1, { warmup: { durationMs: 60_000 } })).run(
            twoStepScenario()
        );
        assert.equal(result.calls, 0);
        assert.deepEqual(result.warmup, { spec: "60 s", excludedCalls: 2 });
        assert.equal(result.p95, 0);
    });

    test("no warm-up leaves the warmup field out", async () => {
        const { result } = await new ScenarioRunner(runOptions(1)).run(twoStepScenario());
        assert.equal(result.warmup, undefined);
        assert.equal(result.arrivalRatePerSecond, null);
        assert.equal(result.backendFlags, "unknown");
        assert.equal(result.dbPoolSize, undefined);
    });

    test("the backend flags and pool size are recorded as given", async () => {
        const { result } = await new ScenarioRunner(
            runOptions(1, { backendFlags: "enable-feature-x", dbPoolSize: 16 })
        ).run(twoStepScenario());
        assert.equal(result.backendFlags, "enable-feature-x");
        assert.equal(result.dbPoolSize, 16);
    });

    test("a dirty tree is recorded and warned about", async () => {
        const { result } = await new ScenarioRunner(runOptions(1, { treeDirty: true })).run(twoStepScenario());
        assert.equal(result.treeDirty, true);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /uncommitted changes/);
    });

    test("open loop: calls are due at the arrival rate, so the run takes at least the schedule", async () => {
        // Two calls at 20 per second: the second call is due 50 ms after the first.
        const started = performance.now();
        const { result } = await new ScenarioRunner(runOptions(1, { arrivalRatePerSecond: 20 })).run(twoStepScenario());
        assert.ok(performance.now() - started >= 45, "the schedule holds the second call back");
        assert.equal(result.arrivalRatePerSecond, 20);
        assert.equal(result.calls, 2, "one agent, two steps, one iteration");
        assert.equal(result.errors, 0);
    });
});
