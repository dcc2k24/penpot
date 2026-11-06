import { randomUUID } from "node:crypto";
import { BackendWatch, type BackendFigures, type BackendWatchOptions } from "./BackendWatch.js";
import { JsonPath } from "./JsonPath.js";
import { McpLoadClient, type ToolCallOutcome } from "./McpLoadClient.js";
import { type PgStatsTarget } from "./PgStats.js";
import { RESULT_SCHEMA_VERSION, type RunResult, type StepResult } from "./ResultFile.js";
import { type Scenario, type ScenarioExpectation, type ScenarioStep } from "./Scenario.js";
import { LatencyRecorder, type LatencySummary } from "./Statistics.js";
import { ProcessMemorySampler, SystemInfo } from "./SystemInfo.js";
import { type Scope, VariableResolver } from "./VariableResolver.js";

/** Settings of one run that do not belong to the scenario. */
export interface RunOptions {
    /** Full URL of the MCP endpoint. */
    url: string;
    /** One token per simulated agent. Agent i uses token i. */
    tokens: readonly string[];
    /** Number of simulated agents. */
    agents: number;
    /** Variables from the vars file and the command line. */
    vars: Readonly<Record<string, unknown>>;
    /** Environment in which PENPOT_LOADTEST_* variables are read. */
    env: Readonly<Record<string, string | undefined>>;
    /** Calls per second and agent, applied to every step. Lower of this and a step's own rate wins. */
    rateLimitPerSecond?: number;
    /** Time limit in milliseconds. When set, agents repeat the whole step list until the time is up. */
    durationMs?: number;
    /** Backend metrics endpoint, scraped at the start and the end of the run and sampled while it runs. */
    metricsUrl?: string;
    /** Postgres counters, read at the start and the end of the run through docker exec. Off when unset. */
    pgStats?: PgStatsTarget;
    /** Process id of the MCP server, whose resident memory is sampled during the run. Off when unset. */
    serverPid?: number;
    /** Time between two periodic samples of the backend heap and the server memory, in milliseconds. */
    sampleIntervalMs?: number;
    /** Wait before the final Postgres sample, in milliseconds, so that Postgres flushes the idle sessions first. */
    pgSettleMs?: number;
    /** Commit recorded in the result. Defaults to the git HEAD of this checkout. */
    commit?: string;
    /** Free text recorded in the machine spec. */
    machineNote?: string;
}

/** The part of BackendWatch that a run uses. Tests replace the watch with a fake that has this shape. */
export interface BackendWatchLike {
    /** False when no source is configured. A run then calls neither start nor stop. */
    readonly enabled: boolean;
    /** Takes the first sample of every source and starts the periodic samples. */
    start(): Promise<void>;
    /** Stops the periodic samples, takes the last sample of every source and returns the figures. */
    stop(): Promise<BackendFigures>;
}

/** Builds the backend watch of one run from its options. */
export type BackendWatchFactory = (options: BackendWatchOptions) => BackendWatchLike;

/** What a run produces. */
export interface RunOutput {
    /** The result document, ready to write. */
    result: RunResult;
    /** Variables captured by the first agent, used by the setup command. */
    captured: Record<string, unknown>;
}

/** Longest failure message kept in a result. */
const MAX_MESSAGE_LENGTH = 300;

/** Most distinct failure messages kept in a result. */
const MAX_ERROR_SAMPLES = 50;

/** Prefix of the failure messages of setup steps, so that they can be told apart in a result. */
const SETUP_MESSAGE_PREFIX = "setup: ";

/**
 * Runs a scenario with simulated agents and produces a result document.
 */
export class ScenarioRunner {
    /**
     * @param options - settings of the run
     * @param watchFactory - builds the backend watch of each run, replaceable in tests
     */
    constructor(
        private readonly options: RunOptions,
        private readonly watchFactory: BackendWatchFactory = (watchOptions) => new BackendWatch(watchOptions)
    ) {}

    /**
     * Runs every agent to the end of the scenario, or to the time limit.
     *
     * @param scenario - scenario to run
     * @throws Error when there are fewer tokens than agents, or an agent cannot connect
     */
    async run(scenario: Scenario): Promise<RunOutput> {
        const { agents, tokens } = this.options;
        if (tokens.length < agents) {
            throw new Error(`${agents} agents need ${agents} tokens, but the tokens file has ${tokens.length}`);
        }
        const runId = randomUUID().slice(0, 8);
        const recorder = new RunRecorder(scenario.steps);
        const setupRecorder = new RunRecorder(scenario.setup, SETUP_MESSAGE_PREFIX);
        const memory = new ProcessMemorySampler();
        const warnings: string[] = [];
        const watch = this.watchFactory({
            metricsUrl: this.options.metricsUrl,
            pgStats: this.options.pgStats,
            serverPid: this.options.serverPid,
            intervalMs: this.options.sampleIntervalMs,
            pgSettleMs: this.options.pgSettleMs,
        });
        if (watch.enabled) {
            await watch.start();
        }

        const simulated = Array.from({ length: agents }, (_, index) => {
            return new SimulatedAgent(index, tokens[index], this.options, runId);
        });
        const startedAt = new Date();
        const started = performance.now();
        const deadline = this.options.durationMs === undefined ? undefined : started + this.options.durationMs;
        memory.start();
        try {
            await Promise.all(simulated.map((agent) => agent.connect()));
            await Promise.all(simulated.map((agent) => agent.play(scenario, recorder, setupRecorder, deadline)));
        } finally {
            await Promise.all(simulated.map((agent) => agent.close()));
        }
        const durationMs = performance.now() - started;
        const figures = memory.stop();
        const backend = watch.enabled ? await watch.stop() : undefined;
        if (backend !== undefined) {
            warnings.push(...backend.warnings);
        }

        const total = recorder.totals();
        const setupTotal = setupRecorder.totals();
        const result: RunResult = {
            schemaVersion: RESULT_SCHEMA_VERSION,
            scenario: scenario.name,
            description: scenario.description,
            commit: this.options.commit ?? SystemInfo.commit(),
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs,
            agents,
            iterations: recorder.completedIterations,
            rateLimitPerSecond: this.options.rateLimitPerSecond ?? null,
            machineSpec: SystemInfo.machineSpec(this.options.machineNote),
            calls: total.calls,
            errors: total.errors + setupTotal.errors,
            bytes: total.bytes,
            p50: total.latency.p50,
            p95: total.latency.p95,
            p99: total.latency.p99,
            max: total.latency.max,
            heap: figures.heap,
            rss: figures.rss,
            steps: recorder.steps(),
            errorSamples: [...recorder.failureMessages(), ...setupRecorder.failureMessages()].slice(
                0,
                MAX_ERROR_SAMPLES
            ),
            warnings,
        };
        if (scenario.setup.length > 0) {
            result.setupSteps = setupRecorder.steps();
        }
        if (backend !== undefined) {
            copyBackendFigures(result, backend);
        }
        return { result, captured: simulated[0].captures };
    }
}

/**
 * Copies every measured figure of the backend watch into a result. A figure that is undefined is left out.
 *
 * @param result - result to fill, changed in place
 * @param figures - figures returned by the backend watch
 */
function copyBackendFigures(result: RunResult, figures: BackendFigures): void {
    if (figures.metricsDelta !== undefined) {
        result.metricsDelta = figures.metricsDelta;
    }
    if (figures.dbStatements !== undefined) {
        result.dbStatements = figures.dbStatements;
    }
    if (figures.dbStatementsSource !== undefined) {
        result.dbStatementsSource = figures.dbStatementsSource;
    }
    if (figures.backendHeap !== undefined) {
        result.backendHeap = figures.backendHeap;
    }
    if (figures.gc !== undefined) {
        result.gc = figures.gc;
    }
    if (figures.backendCpuSeconds !== undefined) {
        result.backendCpuSeconds = figures.backendCpuSeconds;
    }
    if (figures.backendRequests !== undefined) {
        result.backendRequests = figures.backendRequests;
    }
    if (figures.mcpCommands !== undefined) {
        result.mcpCommands = figures.mcpCommands;
    }
    if (figures.connectionCheckouts !== undefined) {
        result.connectionCheckouts = figures.connectionCheckouts;
    }
    if (figures.pg !== undefined) {
        result.pg = figures.pg;
    }
    if (figures.serverRss !== undefined) {
        result.serverRss = figures.serverRss;
    }
}

/**
 * One simulated agent with its own MCP session, token, captured variables and call rate.
 */
class SimulatedAgent {
    /** Iterations in a row that may abort before the agent gives up, so that a broken scenario does not spin. */
    private static readonly MAX_ABORTED_IN_ROW = 10;

    /** Values captured by this agent, updated in place as steps finish. */
    readonly captures: Record<string, unknown> = {};

    private readonly client = new McpLoadClient();
    private readonly resolver: VariableResolver;
    /** The one rate limiter of this agent, shared by every step and every iteration. */
    private readonly limiter = new RateLimiter();
    /** Start time of the last run of each step by this agent, read by steps that set everyMs. */
    private readonly lastRunAt = new Map<ScenarioStep, number>();

    /**
     * @param index - agent number, from 0
     * @param token - MCP token of this agent
     * @param options - settings of the run
     * @param runId - short identifier of the run, visible to scenarios as ${runId}
     */
    constructor(
        private readonly index: number,
        private readonly token: string,
        private readonly options: RunOptions,
        private readonly runId: string
    ) {
        this.resolver = new VariableResolver(options.vars, options.env, this.captures);
    }

    /**
     * Opens the MCP session of this agent.
     */
    async connect(): Promise<void> {
        await this.client.connect(this.options.url, this.token);
    }

    /**
     * Closes the MCP session of this agent.
     */
    async close(): Promise<void> {
        await this.client.close();
    }

    /**
     * Runs the scenario for this agent. Each iteration runs the setup steps when they are due, then every step. The
     * loop stops at the time limit when one is set.
     *
     * @param scenario - scenario to run
     * @param recorder - collects the outcome of every call of the steps
     * @param setupRecorder - collects the outcome of every call of the setup steps
     * @param deadline - performance.now() value at which to stop, or undefined to run the iterations
     */
    async play(
        scenario: Scenario,
        recorder: RunRecorder,
        setupRecorder: RunRecorder,
        deadline: number | undefined
    ): Promise<void> {
        let abortedInRow = 0;
        let setupDone = false;
        for (let iteration = 0; ; iteration++) {
            if (deadline === undefined && iteration >= scenario.iterations) {
                return;
            }
            if (deadline !== undefined && iteration > 0 && performance.now() >= deadline) {
                return;
            }
            let finished = true;
            if (scenario.setup.length > 0 && (scenario.setupPer === "iteration" || !setupDone)) {
                setupDone = await this.runSteps(scenario.setup, iteration, setupRecorder, deadline, true);
                finished = setupDone;
            }
            if (finished) {
                finished = await this.runSteps(scenario.steps, iteration, recorder, deadline, false);
            }
            if (finished) {
                abortedInRow = 0;
                recorder.countIteration();
            } else if (++abortedInRow >= SimulatedAgent.MAX_ABORTED_IN_ROW) {
                return;
            }
        }
    }

    /**
     * Runs a list of steps once. The run stops early when a call fails and the step captures variables, because the
     * steps after it cannot use those variables. With stopOnAnyFailure, any failed call stops the run.
     *
     * @param steps - steps to run in order
     * @param iteration - iteration number, from 0
     * @param recorder - collects the outcome of every call of these steps
     * @param deadline - performance.now() value at which to stop, or undefined for none
     * @param stopOnAnyFailure - true for setup steps, which stop at the first failed call
     * @returns true when the list ran to its end
     */
    private async runSteps(
        steps: readonly ScenarioStep[],
        iteration: number,
        recorder: RunRecorder,
        deadline: number | undefined,
        stopOnAnyFailure: boolean
    ): Promise<boolean> {
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
            const step = steps[stepIndex];
            if (this.pastDeadline(deadline)) {
                return false;
            }
            const now = performance.now();
            const lastRun = this.lastRunAt.get(step);
            if (step.everyMs !== undefined && lastRun !== undefined && now - lastRun < step.everyMs) {
                continue;
            }
            this.lastRunAt.set(step, now);
            let repeat: number;
            try {
                repeat = VariableResolver.countOf(this.resolver.expand(step.repeat, this.scope(iteration, 0)));
            } catch (error) {
                recorder.fail(stepIndex, error);
                return false;
            }
            const accumulate = repeat > 1;
            for (const name of Object.keys(step.capture)) {
                if (accumulate) {
                    this.captures[name] = [];
                }
            }
            for (let copy = 0; copy < repeat; copy++) {
                if (this.pastDeadline(deadline)) {
                    return false;
                }
                await this.limiter.wait(this.effectiveRate(step));
                const passed = await this.callStep(step, stepIndex, iteration, copy, accumulate, recorder);
                if (!passed && (stopOnAnyFailure || Object.keys(step.capture).length > 0)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Substitutes the arguments of one call, makes the call, checks it, records it and captures from it.
     *
     * @param accumulate - true when the step repeats, so captured values are appended to arrays
     * @returns true when the call passed its checks and its captures were stored
     */
    private async callStep(
        step: ScenarioStep,
        stepIndex: number,
        iteration: number,
        copy: number,
        accumulate: boolean,
        recorder: RunRecorder
    ): Promise<boolean> {
        let args: Record<string, unknown>;
        try {
            args = this.resolver.expand(step.args, this.scope(iteration, copy)) as Record<string, unknown>;
        } catch (error) {
            recorder.fail(stepIndex, error);
            return false;
        }
        const outcome = await this.client.callTool(step.tool, args);
        const failure = this.judge(step, outcome, iteration, copy);
        recorder.record(stepIndex, outcome, failure);
        if (failure !== undefined) {
            return false;
        }
        try {
            this.capture(step, outcome.json, accumulate);
        } catch (error) {
            recorder.fail(stepIndex, error);
            return false;
        }
        return true;
    }

    /**
     * Decides whether a finished call failed, and why. It applies expectError, the expectations and maxDurationMs.
     *
     * @param step - step that made the call
     * @param outcome - outcome of the call
     * @param iteration - iteration number, from 0
     * @param copy - copy number of the step, from 0
     * @returns the failure message, or undefined when the call passed
     */
    private judge(step: ScenarioStep, outcome: ToolCallOutcome, iteration: number, copy: number): string | undefined {
        if (step.expectError !== undefined) {
            const label = `/${step.expectError}/i`;
            if (outcome.ok) {
                return `expected an error matching ${label}, got a success`;
            }
            const text = outcome.error ?? outcome.text;
            if (!new RegExp(step.expectError, "i").test(text)) {
                return `expected an error matching ${label}, got: ${text}`;
            }
        } else if (!outcome.ok) {
            return outcome.error ?? outcome.text;
        } else if (step.expect !== undefined) {
            const problem = this.checkExpect(step.expect, outcome.json, iteration, copy);
            if (problem !== undefined) {
                return problem;
            }
        }
        if (step.maxDurationMs !== undefined && outcome.durationMs > step.maxDurationMs) {
            return `took ${Math.round(outcome.durationMs)} ms, over the limit of ${step.maxDurationMs} ms`;
        }
        return undefined;
    }

    /**
     * Resolves the placeholders of the expectations of a step, then checks the parsed result against them.
     *
     * @param expectations - expectations of the step
     * @param json - parsed result of the call
     * @param iteration - iteration number, from 0
     * @param copy - copy number of the step, from 0
     * @returns a description of the first problem, or undefined when every expectation holds
     */
    private checkExpect(
        expectations: readonly ScenarioExpectation[],
        json: unknown,
        iteration: number,
        copy: number
    ): string | undefined {
        let resolved: ScenarioExpectation[];
        try {
            resolved = this.resolver.expand(expectations, this.scope(iteration, copy)) as ScenarioExpectation[];
        } catch (error) {
            return (error as Error).message;
        }
        return checkExpectation(resolved, json);
    }

    /**
     * Stores the captured values of a step. A step that repeats appends to arrays created when the step started.
     *
     * @param step - step with its capture map
     * @param json - parsed result of the call
     * @param accumulate - true when the step repeats, so values are appended
     * @throws Error when a path matches nothing
     */
    private capture(step: ScenarioStep, json: unknown, accumulate: boolean): void {
        for (const [name, expression] of Object.entries(step.capture)) {
            const value = JsonPath.parse(expression).read({ result: json });
            if (value === undefined) {
                throw new Error(`capture ${name} found nothing at ${expression} in the result of ${step.tool}`);
            }
            if (accumulate) {
                const list = this.captures[name];
                if (!Array.isArray(list)) {
                    throw new Error(`capture ${name} is not an array`);
                }
                list.push(value);
            } else {
                this.captures[name] = value;
            }
        }
    }

    /**
     * Builds the names visible to one call.
     *
     * @param iteration - iteration number, from 0
     * @param copy - copy number of the step, from 0
     */
    private scope(iteration: number, copy: number): Scope {
        return { agent: this.index, iteration, index: copy, runId: this.runId };
    }

    /**
     * Returns the lower of the command-line rate and the step's own rate.
     *
     * @param step - step being run
     */
    private effectiveRate(step: ScenarioStep): number | undefined {
        const rates = [this.options.rateLimitPerSecond, step.rateLimitPerSecond].filter(
            (rate): rate is number => rate !== undefined
        );
        return rates.length === 0 ? undefined : Math.min(...rates);
    }

    /**
     * Tells whether the time limit has passed.
     *
     * @param deadline - performance.now() value of the limit, or undefined when there is none
     */
    private pastDeadline(deadline: number | undefined): boolean {
        return deadline !== undefined && performance.now() >= deadline;
    }
}

/**
 * Spaces the calls of one agent so that they do not exceed a rate.
 *
 * One instance serves an agent for the whole run, so that the spacing carries across steps and iterations. Each
 * call names the rate that applies to it.
 */
export class RateLimiter {
    private nextSlot = 0;

    /**
     * Waits until the next call may start, then reserves the slot after it.
     *
     * @param perSecond - calls allowed per second for this call, or undefined for no limit
     */
    async wait(perSecond: number | undefined): Promise<void> {
        if (perSecond === undefined) {
            return;
        }
        const now = performance.now();
        const slot = Math.max(now, this.nextSlot);
        this.nextSlot = slot + 1000 / perSecond;
        if (slot > now) {
            await new Promise((resolve) => setTimeout(resolve, slot - now));
        }
    }
}

/**
 * Checks a parsed result against resolved expectations. The first expectation that fails is reported.
 *
 * @param expectations - expectations of a step, with placeholders already resolved, or undefined
 * @param json - parsed result of the call
 * @returns a description of the first mismatch, or undefined when the result matches
 */
export function checkExpectation(
    expectations: readonly ScenarioExpectation[] | undefined,
    json: unknown
): string | undefined {
    for (const expect of expectations ?? []) {
        const problem = checkOne(expect, json);
        if (problem !== undefined) {
            return problem;
        }
    }
    return undefined;
}

/**
 * Checks a parsed result against one resolved expectation.
 *
 * @param expect - one expectation with placeholders already resolved
 * @param json - parsed result of the call
 * @returns a description of the mismatch, or undefined when the result matches
 */
function checkOne(expect: ScenarioExpectation, json: unknown): string | undefined {
    let value: unknown;
    try {
        value = JsonPath.parse(expect.path).read({ result: json });
    } catch (error) {
        return (error as Error).message;
    }
    const length = Array.isArray(value) || typeof value === "string" ? value.length : undefined;
    if (expect.length !== undefined) {
        const wanted = wholeNumberOf(expect.length);
        if (wanted === undefined) {
            return `expect.length must resolve to a whole number, got ${JSON.stringify(expect.length)}`;
        }
        if (length !== wanted) {
            return `expected ${expect.path} to have length ${wanted}, got ${length ?? "no array"}`;
        }
    }
    if (expect.maxLength !== undefined) {
        const largest = wholeNumberOf(expect.maxLength);
        if (largest === undefined) {
            return `expect.maxLength must resolve to a whole number, got ${JSON.stringify(expect.maxLength)}`;
        }
        if (length === undefined || length > largest) {
            return `expected ${expect.path} to have length at most ${largest}, got ${length ?? "no array"}`;
        }
    }
    if (expect.sum !== undefined) {
        const wanted = wholeNumberOf(expect.sum);
        if (wanted === undefined) {
            return `expect.sum must resolve to a whole number, got ${JSON.stringify(expect.sum)}`;
        }
        if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
            return `expected ${expect.path} to be an array of numbers`;
        }
        const total = (value as number[]).reduce((sum, item) => sum + item, 0);
        if (total !== wanted) {
            return `expected ${expect.path} to sum to ${wanted}, got ${total}`;
        }
    }
    if (expect.contains !== undefined) {
        if (!Array.isArray(value)) {
            return `expected ${expect.path} to be an array`;
        }
        const wantedJson = JSON.stringify(expect.contains);
        if (!value.some((item) => JSON.stringify(item) === wantedJson)) {
            return `expected ${expect.path} to contain ${wantedJson}`;
        }
    }
    if (expect.equals !== undefined && JSON.stringify(value) !== JSON.stringify(expect.equals)) {
        return `expected ${expect.path} to equal ${JSON.stringify(expect.equals)}, got ${JSON.stringify(value)}`;
    }
    return undefined;
}

/**
 * Reads a whole number from a resolved value. A numeric string is converted with Number.
 *
 * @param value - resolved value
 * @returns the number, or undefined when the value is not a whole number
 */
function wholeNumberOf(value: unknown): number | undefined {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof number === "number" && Number.isInteger(number) ? number : undefined;
}

/**
 * Collects the outcome of every call of a run, per step and in total.
 */
class RunRecorder {
    /** Latency of every call in the run. */
    private readonly overall = new LatencyRecorder();
    private readonly perStep: StepAccumulator[];
    private readonly messages = new Set<string>();
    private calls = 0;
    private errors = 0;
    private bytes = 0;
    private iterations = 0;

    /**
     * @param steps - steps of the scenario, in order
     * @param messagePrefix - text put in front of every failure message kept in the result
     */
    constructor(
        steps: readonly ScenarioStep[],
        private readonly messagePrefix = ""
    ) {
        this.perStep = steps.map((step, index) => ({
            name: `${index + 1}. ${step.name}`,
            tool: step.tool,
            latency: new LatencyRecorder(),
            calls: 0,
            errors: 0,
            bytes: 0,
        }));
    }

    /**
     * Records a finished call.
     *
     * @param stepIndex - position of the step
     * @param outcome - outcome of the call
     * @param failure - why the call counts as an error, or undefined when it does not
     */
    record(stepIndex: number, outcome: ToolCallOutcome, failure?: string): void {
        const step = this.perStep[stepIndex];
        step.latency.add(outcome.durationMs);
        step.calls++;
        step.bytes += outcome.bytes;
        this.overall.add(outcome.durationMs);
        this.calls++;
        this.bytes += outcome.bytes;
        if (failure !== undefined) {
            this.countError(stepIndex, failure);
        }
    }

    /**
     * Records a failure that happened without a call, such as a missing variable.
     *
     * @param stepIndex - position of the step
     * @param error - the error that stopped the call
     */
    fail(stepIndex: number, error: unknown): void {
        this.countError(stepIndex, error instanceof Error ? error.message : String(error));
    }

    /**
     * Counts one completed iteration of one agent.
     */
    countIteration(): void {
        this.iterations++;
    }

    /**
     * Number of completed iterations, summed over agents.
     */
    get completedIterations(): number {
        return this.iterations;
    }

    /**
     * Totals over every step.
     */
    totals(): { calls: number; errors: number; bytes: number; latency: LatencySummary } {
        return { calls: this.calls, errors: this.errors, bytes: this.bytes, latency: this.overall.summary() };
    }

    /**
     * Per-step figures in scenario order.
     */
    steps(): StepResult[] {
        return this.perStep.map((step) => {
            const latency = step.latency.summary();
            return {
                name: step.name,
                tool: step.tool,
                calls: step.calls,
                errors: step.errors,
                bytes: step.bytes,
                p50: latency.p50,
                p95: latency.p95,
                p99: latency.p99,
                max: latency.max,
            };
        });
    }

    /**
     * Distinct failure messages, in the order they first occurred.
     */
    failureMessages(): string[] {
        return [...this.messages];
    }

    /**
     * Adds one error to a step and keeps its message when it is new.
     *
     * @param stepIndex - position of the step
     * @param message - description of the failure
     */
    private countError(stepIndex: number, message: string): void {
        this.perStep[stepIndex].errors++;
        this.errors++;
        if (this.messages.size < MAX_ERROR_SAMPLES) {
            this.messages.add((this.messagePrefix + message).slice(0, MAX_MESSAGE_LENGTH));
        }
    }
}

/** Mutable figures of one step while a run is in progress. */
interface StepAccumulator {
    name: string;
    tool: string;
    latency: LatencyRecorder;
    calls: number;
    errors: number;
    bytes: number;
}
