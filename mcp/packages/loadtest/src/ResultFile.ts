import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type BackendFigures } from "./BackendWatch.js";
import { type PgCounters } from "./PgStats.js";

/** Version of the result document. Bump it when a field changes meaning. */
export const RESULT_SCHEMA_VERSION = 1;

/** Hardware and software that produced a result. Results from different specs are not compared directly. */
export interface MachineSpec {
    /** Operating system family, for example win32 or linux. */
    platform: string;
    /** CPU architecture, for example x64 or arm64. */
    arch: string;
    /** Model name of the first CPU. */
    cpuModel: string;
    /** Number of logical CPU cores. */
    cpuCores: number;
    /** Installed memory in bytes. */
    totalMemoryBytes: number;
    /** Node.js version of the load driver. */
    nodeVersion: string;
    /** Free text, for example Docker Desktop limits or the Postgres and JVM settings. */
    note?: string;
}

/** Memory of the load driver process, in bytes. */
export interface MemoryFigures {
    /** Value when the run started. */
    startBytes: number;
    /** Value when the run ended. */
    endBytes: number;
    /** Largest value sampled during the run. */
    peakBytes: number;
}

/** Latency and error figures of one step of a scenario. */
export interface StepResult {
    /** Position and name of the step, for example "2. get shapes". */
    name: string;
    /** MCP tool name. */
    tool: string;
    /** Calls made, including failed ones. */
    calls: number;
    /** Failed calls, failed checks and aborted calls. */
    errors: number;
    /** Total size of the text results in bytes. */
    bytes: number;
    /** Median latency in milliseconds. */
    p50: number;
    /** 95th percentile latency in milliseconds. */
    p95: number;
    /** 99th percentile latency in milliseconds. */
    p99: number;
    /** Largest latency in milliseconds. */
    max: number;
}

/** One scenario run. This is the document written to results/. */
export interface RunResult {
    /** Version of this document, see RESULT_SCHEMA_VERSION. */
    schemaVersion: number;
    /** Scenario name. */
    scenario: string;
    /** Scenario summary. */
    description: string;
    /** Git commit of the code under test, or "unknown" outside a git checkout. */
    commit: string;
    /** ISO time when the run started. */
    startedAt: string;
    /** ISO time when the run ended. */
    finishedAt: string;
    /** Wall-clock length of the run in milliseconds. */
    durationMs: number;
    /** Number of simulated agents, each with its own token. */
    agents: number;
    /** Completed iterations, summed over all agents. */
    iterations: number;
    /** Per-agent call rate cap from the command line, or null when none was set. */
    rateLimitPerSecond: number | null;
    /** Hardware and software of the load driver. */
    machineSpec: MachineSpec;
    /** Calls made over all steps. */
    calls: number;
    /** Failed calls, failed checks and aborted calls over all steps, setup steps included. */
    errors: number;
    /** Total size of the text results in bytes. */
    bytes: number;
    /** Median latency over all calls in milliseconds. */
    p50: number;
    /** 95th percentile latency over all calls in milliseconds. */
    p95: number;
    /** 99th percentile latency over all calls in milliseconds. */
    p99: number;
    /** Largest latency over all calls in milliseconds. */
    max: number;
    /** Heap of the load driver. */
    heap: MemoryFigures;
    /** Resident set size of the load driver. */
    rss: MemoryFigures;
    /** Change in backend statement counter during the run, when a metrics endpoint or Postgres was sampled. */
    dbStatements?: number;
    /** Where dbStatements came from: the backend metrics, or pg_stat_statements in Postgres. */
    dbStatementsSource?: "metrics" | "pg_stat_statements";
    /** Change in every penpot_* counter during the run, when a metrics endpoint was sampled. */
    metricsDelta?: Record<string, number>;
    /** JVM heap of the backend in bytes, when a metrics endpoint was watched. The peak covers every sample. */
    backendHeap?: NonNullable<BackendFigures["backendHeap"]>;
    /** Garbage collection of the backend during the run, when a metrics endpoint was watched. */
    gc?: NonNullable<BackendFigures["gc"]>;
    /** CPU seconds the backend used during the run, when a metrics endpoint was watched. */
    backendCpuSeconds?: number;
    /** RPC requests the backend served during the run, when a metrics endpoint was watched. */
    backendRequests?: number;
    /** MCP tool calls the backend served during the run, when a metrics endpoint was watched. */
    mcpCommands?: number;
    /** Connections the backend took from its database pools during the run, when a metrics endpoint was watched. */
    connectionCheckouts?: number;
    /** Change of the Postgres counters during the run, when a Postgres target was watched. */
    pg?: PgCounters;
    /** Resident memory of the MCP server in bytes, when its process id was watched. The peak covers every sample. */
    serverRss?: MemoryFigures;
    /** Per-step figures in scenario order. */
    steps: StepResult[];
    /**
     * Per-step figures of the setup steps, present only when the scenario has setup steps. Setup calls are left out of
     * calls, bytes, latency and steps, but their errors count in errors.
     */
    setupSteps?: StepResult[];
    /** First distinct failure messages of the run, for diagnosis. Setup failures start with "setup: ". */
    errorSamples: string[];
    /** Problems that did not stop the run, such as an unreachable metrics endpoint. */
    warnings: string[];
}

/**
 * Writes, reads and checks result documents.
 */
export class ResultFile {
    /**
     * Builds the file name of a result: date, short commit and scenario name.
     *
     * @param result - the run result
     */
    static fileNameFor(result: RunResult): string {
        const date = result.startedAt.slice(0, 10);
        const commit = result.commit === "unknown" ? "nogit" : result.commit.slice(0, 10);
        const scenario = result.scenario.replace(/[^A-Za-z0-9._-]+/g, "-");
        return `${date}-${commit}-${scenario}.json`;
    }

    /**
     * Writes a result into a directory. A name that is taken gets a numeric suffix instead of overwriting.
     *
     * @param directory - directory for result files, created when missing
     * @param result - the run result
     * @returns the absolute path that was written
     */
    static async write(directory: string, result: RunResult): Promise<string> {
        await mkdir(directory, { recursive: true });
        const base = ResultFile.fileNameFor(result).replace(/\.json$/, "");
        let candidate = join(directory, `${base}.json`);
        for (let suffix = 2; existsSync(candidate); suffix++) {
            candidate = join(directory, `${base}-${suffix}.json`);
        }
        await writeFile(candidate, JSON.stringify(result, null, 2) + "\n", "utf8");
        return candidate;
    }

    /**
     * Reads and checks a result file.
     *
     * @param file - path of the result file
     * @throws Error when the file is missing, not JSON, or does not match the schema
     */
    static async read(file: string): Promise<RunResult> {
        let json: unknown;
        try {
            json = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            throw new Error(`cannot read result ${file}: ${(error as Error).message}`);
        }
        return ResultFile.validate(json, file);
    }

    /**
     * Checks that a parsed document has every field of a result with the right type.
     *
     * @param value - parsed JSON document
     * @param source - file name used in error messages
     * @throws Error listing every problem found
     */
    static validate(value: unknown, source: string): RunResult {
        const problems: string[] = [];
        const root = value as Record<string, unknown>;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${source}: a result must be a JSON object`);
        }
        ResultFile.expectString(root, ["scenario", "description", "commit", "startedAt", "finishedAt"], problems);
        ResultFile.expectNumber(
            root,
            [
                "schemaVersion",
                "durationMs",
                "agents",
                "iterations",
                "calls",
                "errors",
                "bytes",
                "p50",
                "p95",
                "p99",
                "max",
            ],
            problems
        );
        ResultFile.expectMemory(root.heap, "heap", problems);
        ResultFile.expectMemory(root.rss, "rss", problems);
        ResultFile.expectBackendFigures(root, problems);
        ResultFile.expectMachineSpec(root.machineSpec, problems);
        if (root.rateLimitPerSecond !== null && typeof root.rateLimitPerSecond !== "number") {
            problems.push("rateLimitPerSecond must be a number or null");
        }
        if (!Array.isArray(root.steps)) {
            problems.push("steps must be an array");
        } else {
            root.steps.forEach((step: unknown, index: number) =>
                ResultFile.expectStep(step, `steps[${index}]`, problems)
            );
        }
        if (root.setupSteps !== undefined) {
            if (!Array.isArray(root.setupSteps)) {
                problems.push("setupSteps must be an array when present");
            } else {
                root.setupSteps.forEach((step: unknown, index: number) =>
                    ResultFile.expectStep(step, `setupSteps[${index}]`, problems)
                );
            }
        }
        if (!Array.isArray(root.errorSamples) || !Array.isArray(root.warnings)) {
            problems.push("errorSamples and warnings must be arrays");
        }
        if (problems.length > 0) {
            throw new Error(`${source} is not a valid result:\n  ${problems.join("\n  ")}`);
        }
        return root as unknown as RunResult;
    }

    /**
     * Records a problem for each named field that is not a string.
     *
     * @param target - object that holds the fields
     * @param keys - field names to check
     * @param problems - list that receives the problems
     * @param prefix - location of the object, prepended to each field name in messages
     */
    private static expectString(
        target: Record<string, unknown>,
        keys: string[],
        problems: string[],
        prefix = ""
    ): void {
        for (const key of keys) {
            if (typeof target[key] !== "string") {
                problems.push(`${prefix}${key} must be a string`);
            }
        }
    }

    /**
     * Records a problem for each named field that is not a finite number.
     *
     * @param target - object that holds the fields
     * @param keys - field names to check
     * @param problems - list that receives the problems
     * @param prefix - location of the object, prepended to each field name in messages
     */
    private static expectNumber(
        target: Record<string, unknown>,
        keys: string[],
        problems: string[],
        prefix = ""
    ): void {
        for (const key of keys) {
            if (typeof target[key] !== "number" || !Number.isFinite(target[key])) {
                problems.push(`${prefix}${key} must be a finite number`);
            }
        }
    }

    /**
     * Checks a memory figure object.
     *
     * @param value - the heap or rss field of the document
     * @param name - field name used in messages
     * @param problems - list that receives the problems
     */
    private static expectMemory(value: unknown, name: string, problems: string[]): void {
        const memory = value as Record<string, unknown> | null | undefined;
        if (memory === null || memory === undefined || typeof memory !== "object") {
            problems.push(`${name} must be an object`);
            return;
        }
        ResultFile.expectNumber(memory, ["startBytes", "endBytes", "peakBytes"], problems, `${name}.`);
    }

    /**
     * Checks the optional backend figures. Each one is left out of a result that did not watch its source, so a field
     * is checked only when it is present.
     *
     * @param root - the whole document
     * @param problems - list that receives the problems
     */
    private static expectBackendFigures(root: Record<string, unknown>, problems: string[]): void {
        ResultFile.expectOptionalNumber(
            root,
            ["dbStatements", "backendCpuSeconds", "backendRequests", "mcpCommands", "connectionCheckouts"],
            problems
        );
        const source = root.dbStatementsSource;
        if (source !== undefined && source !== "metrics" && source !== "pg_stat_statements") {
            problems.push('dbStatementsSource must be "metrics" or "pg_stat_statements" when present');
        }
        if (root.backendHeap !== undefined) {
            ResultFile.expectFigures(
                root.backendHeap,
                "backendHeap",
                ["startBytes", "endBytes", "peakBytes"],
                ["maxBytes"],
                problems
            );
        }
        if (root.gc !== undefined) {
            ResultFile.expectFigures(root.gc, "gc", ["seconds", "collections"], [], problems);
        }
        if (root.pg !== undefined) {
            ResultFile.expectFigures(
                root.pg,
                "pg",
                ["transactions", "tableScans", "rowsRead", "rowsWritten", "fileChangeSeqScans", "fileChangeIdxScans"],
                ["statements"],
                problems
            );
        }
        if (root.serverRss !== undefined) {
            ResultFile.expectMemory(root.serverRss, "serverRss", problems);
        }
    }

    /**
     * Checks an object of figures: the required fields must be finite numbers, and the optional ones must be finite
     * numbers when present.
     *
     * @param value - the field of the document
     * @param name - field name used in messages
     * @param required - fields that must be present
     * @param optional - fields that may be left out
     * @param problems - list that receives the problems
     */
    private static expectFigures(
        value: unknown,
        name: string,
        required: string[],
        optional: string[],
        problems: string[]
    ): void {
        const figures = value as Record<string, unknown> | null;
        if (figures === null || typeof figures !== "object" || Array.isArray(figures)) {
            problems.push(`${name} must be an object`);
            return;
        }
        ResultFile.expectNumber(figures, required, problems, `${name}.`);
        ResultFile.expectOptionalNumber(figures, optional, problems, `${name}.`);
    }

    /**
     * Records a problem for each named field that is present but is not a finite number.
     *
     * @param target - object that holds the fields
     * @param keys - field names to check
     * @param problems - list that receives the problems
     * @param prefix - location of the object, prepended to each field name in messages
     */
    private static expectOptionalNumber(
        target: Record<string, unknown>,
        keys: string[],
        problems: string[],
        prefix = ""
    ): void {
        for (const key of keys) {
            const value = target[key];
            if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
                problems.push(`${prefix}${key} must be a finite number when present`);
            }
        }
    }

    /**
     * Checks the machine spec object.
     *
     * @param value - the machineSpec field of the document
     * @param problems - list that receives the problems
     */
    private static expectMachineSpec(value: unknown, problems: string[]): void {
        const spec = value as Record<string, unknown> | null | undefined;
        if (spec === null || spec === undefined || typeof spec !== "object") {
            problems.push("machineSpec must be an object");
            return;
        }
        ResultFile.expectString(spec, ["platform", "arch", "cpuModel", "nodeVersion"], problems, "machineSpec.");
        ResultFile.expectNumber(spec, ["cpuCores", "totalMemoryBytes"], problems, "machineSpec.");
    }

    /**
     * Checks one step entry.
     *
     * @param value - one element of the steps or setupSteps array
     * @param label - location of the element, used in messages, for example steps[0]
     * @param problems - list that receives the problems
     */
    private static expectStep(value: unknown, label: string, problems: string[]): void {
        const step = value as Record<string, unknown> | null;
        if (step === null || typeof step !== "object") {
            problems.push(`${label} must be an object`);
            return;
        }
        const prefix = `${label}.`;
        ResultFile.expectString(step, ["name", "tool"], problems, prefix);
        ResultFile.expectNumber(step, ["calls", "errors", "bytes", "p50", "p95", "p99", "max"], problems, prefix);
    }
}
