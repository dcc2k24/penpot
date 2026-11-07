import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ResultComparison, type ComparisonReport } from "./Compare.js";
import {
    formatElapsed,
    LARGE_FILE_DEFAULTS,
    LargeFileGenerator,
    type GeneratorOptions,
    type GeneratorResult,
} from "./LargeFileGenerator.js";
import { McpLoadClient } from "./McpLoadClient.js";
import { parseWarmup } from "./Pacing.js";
import { PgStats, type PgStatsTarget } from "./PgStats.js";
import { formatMegabytes, HtmlReport, summaryLines } from "./Report.js";
import { ResultFile, type RunResult } from "./ResultFile.js";
import { ScenarioLoader, type Scenario } from "./Scenario.js";
import { ScenarioRunner, type RunOptions } from "./Runner.js";
import { percentileNote } from "./Statistics.js";
import { VarsFile } from "./VarsFile.js";

/** Endpoint of a local devenv MCP server. */
const DEFAULT_URL = "http://localhost:4401/mcp";

/** Default vars file written by the setup command. */
const DEFAULT_VARS_FILE = "vars.json";

/** Default number of agent files created by the setup command, enough for the C1 agent counts. */
const DEFAULT_FILE_COUNT = 20;

/** Default vars file written by the generate-large command. */
const DEFAULT_LARGE_VARS_FILE = "large-vars.json";

/** Text shown when the pointer-map variant is asked for, which the harness cannot build. */
const POINTER_MAP_NOTE = `The backend decides pointer-map for a new file from its feature flag (enable-feature-fdata-pointer-map)
and from the team's features, not per call, so this harness cannot build that variant. Restart the backend without
the flag and create the file in a team that does not have the feature, then run generate-large again.`;

/** Shape of a function that reads the size of a file in bytes, or undefined when no size is known. */
type SizeProbe = (fileId: string) => Promise<number | undefined>;

/** Directory that holds result files, next to the package sources. */
const RESULTS_DIRECTORY = fileURLToPath(new URL("../results/", import.meta.url));

/** Options accepted on the command line. */
const OPTIONS = {
    url: { type: "string" },
    tokens: { type: "string" },
    agents: { type: "string" },
    vars: { type: "string" },
    rate: { type: "string" },
    duration: { type: "string" },
    metrics: { type: "string" },
    "pg-stats": { type: "string" },
    "server-pid": { type: "string" },
    "sample-interval": { type: "string" },
    "pg-settle": { type: "string" },
    iterations: { type: "string" },
    compare: { type: "string" },
    results: { type: "string" },
    "machine-note": { type: "string" },
    "arrival-rate": { type: "string" },
    warmup: { type: "string" },
    "backend-flags": { type: "string" },
    "db-pool-size": { type: "string" },
    "fail-on-regression": { type: "boolean" },
    threshold: { type: "string" },
    "team-id": { type: "string" },
    "project-id": { type: "string" },
    files: { type: "string" },
    out: { type: "string" },
    shapes: { type: "string" },
    pages: { type: "string" },
    batch: { type: "string" },
    components: { type: "string" },
    instances: { type: "string" },
    seed: { type: "string" },
    name: { type: "string" },
    "without-pointer-map": { type: "boolean" },
    help: { type: "boolean", short: "h" },
} as const;

/** Text shown for help, and when no command is given. */
const USAGE = `Usage:
  pnpm loadtest run <scenario> --tokens <file> [--url <mcp url>] [--agents n] [--vars <file>]
                    [--rate n] [--duration 30m] [--iterations n] [--metrics <metrics url>]
                    [--pg-stats docker:<container>:<database>[:user]] [--server-pid <n>]
                    [--sample-interval 5s] [--pg-settle 11s] [--compare <result.json>]
                    [--results <dir>] [--machine-note <text>] [--fail-on-regression]
                    [--arrival-rate n] [--warmup 60s|200] [--backend-flags <text>] [--db-pool-size n]
  pnpm loadtest compare <baseline.json> <candidate.json> [--threshold 0.2] [--fail-on-regression]
  pnpm loadtest setup --tokens <file> [--url <mcp url>] [--team-id <id>] [--project-id <id>]
                      [--files n] [--out <vars.json>]
  pnpm loadtest generate-large --tokens <file> [--url <mcp url>] [--vars <file>] [--project-id <id>]
                      [--shapes 100000] [--pages 40] [--batch 300] [--components 50] [--instances 20]
                      [--seed 1] [--name <file name>] [--out <large-vars.json>] [--without-pointer-map]
                      [--pg-stats docker:<container>:<database>[:user]]

Environment: PENPOT_LOADTEST_URL, PENPOT_LOADTEST_TOKENS (tokens file), PENPOT_LOADTEST_MACHINE_NOTE,
PENPOT_LOADTEST_BACKEND_FLAGS (the flags the backend was started with), PENPOT_LOADTEST_PG_STATS (same form as
--pg-stats), and PENPOT_LOADTEST_<NAME> for each scenario variable
such as PENPOT_LOADTEST_FILE_ID.
Scenarios: a bundled fixture name (see fixtures/scenarios) or a path to a JSON file.`;

/**
 * Command-line entry point: run a scenario, compare two results, or create the files a scenario needs.
 */
export class LoadTestCli {
    /**
     * Runs one command.
     *
     * @param argv - arguments after the program name
     * @returns the process exit code
     */
    static async main(argv: string[]): Promise<number> {
        const { values, positionals } = parseCommandLine(argv);
        const [command, ...rest] = positionals;
        if (values.help === true || command === undefined) {
            console.log(USAGE);
            return 0;
        }
        switch (command) {
            case "run":
                return LoadTestCli.runCommand(rest, values);
            case "compare":
                return LoadTestCli.compareCommand(rest, values);
            case "setup":
                return LoadTestCli.setupCommand(values);
            case "generate-large":
                return LoadTestCli.generateLargeCommand(values);
            default:
                console.error(`unknown command "${command}"\n\n${USAGE}`);
                return 2;
        }
    }

    /**
     * Runs a scenario, writes the result and its HTML report, and optionally compares with an earlier result.
     *
     * @param positionals - the scenario name or path
     * @param values - parsed options
     */
    private static async runCommand(positionals: string[], values: ParsedValues): Promise<number> {
        if (positionals.length !== 1) {
            throw new Error("run needs one scenario: a fixture name or a path");
        }
        const scenario = await ScenarioLoader.load(positionals[0]);
        if (values.iterations !== undefined) {
            scenario.iterations = parsePositiveInteger(values.iterations, "--iterations");
        }
        const options = await LoadTestCli.runOptions(values, scenario);
        const output = await new ScenarioRunner(options).run(scenario);

        const comparison =
            values.compare === undefined ? undefined : await LoadTestCli.compareWith(values.compare, output.result);
        const directory = values.results === undefined ? RESULTS_DIRECTORY : resolve(values.results);
        const file = await ResultFile.write(directory, output.result);
        const htmlFile = file.replace(/\.json$/, ".html");
        await HtmlReport.write(htmlFile, output.result, comparison);

        LoadTestCli.printSummary(output.result, file, htmlFile, comparison);
        return values["fail-on-regression"] === true && comparison !== undefined && gateFails(comparison) ? 1 : 0;
    }

    /**
     * Prints the table of two stored results.
     *
     * @param positionals - baseline and candidate result files
     * @param values - parsed options
     */
    private static async compareCommand(positionals: string[], values: ParsedValues): Promise<number> {
        if (positionals.length !== 2) {
            throw new Error("compare needs two result files: baseline and candidate");
        }
        const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
        const baseline = await ResultFile.read(positionals[0]);
        const candidate = await ResultFile.read(positionals[1]);
        const report = new ResultComparison(threshold ?? ResultComparison.DEFAULT_THRESHOLD).compare(
            baseline,
            candidate,
            basename(positionals[0]),
            basename(positionals[1])
        );
        console.log(ResultComparison.format(report));
        return values["fail-on-regression"] === true && gateFails(report) ? 1 : 0;
    }

    /**
     * Runs the setup fixture against the server and writes the variables that the other scenarios need.
     *
     * @param values - parsed options
     */
    private static async setupCommand(values: ParsedValues): Promise<number> {
        const scenario = await ScenarioLoader.load("setup");
        const pins: Record<string, unknown> = {
            fileCount: values.files === undefined ? DEFAULT_FILE_COUNT : Number(values.files),
        };
        if (values["team-id"] !== undefined) {
            pins.teamId = values["team-id"];
        }
        if (values["project-id"] !== undefined) {
            pins.projectId = values["project-id"];
        }
        const options = await LoadTestCli.runOptions(values, scenario, { ...pins }, 1);
        const output = await new ScenarioRunner(options).run(scenario);
        if (output.result.errors > 0) {
            const details = output.result.errorSamples.map((message) => `  - ${message}`).join("\n");
            throw new Error(`setup failed with ${output.result.errors} error(s):\n${details}`);
        }
        const vars: Record<string, unknown> = { ...output.captured, ...pins };
        delete vars.fileCount;
        const file = resolve(values.out ?? DEFAULT_VARS_FILE);
        await VarsFile.write(file, vars);
        console.log(JSON.stringify(vars, null, 2));
        console.log(`\nwrote ${file}`);
        return 0;
    }

    /**
     * Builds a large reference file through the MCP server, prints a summary, and writes the variables that the
     * large scenarios need. The vars file is written also when the build stops early, so that it can be inspected.
     *
     * @param values - parsed options
     * @returns 0 when the file is complete, 1 when a call failed, 2 for the pointer-map variant
     */
    private static async generateLargeCommand(values: ParsedValues): Promise<number> {
        if (values["without-pointer-map"] === true) {
            console.log(POINTER_MAP_NOTE);
            return 2;
        }
        const tokensFile = values.tokens ?? process.env.PENPOT_LOADTEST_TOKENS;
        if (tokensFile === undefined) {
            throw new Error("give a tokens file with --tokens or PENPOT_LOADTEST_TOKENS");
        }
        const pgStats = pgStatsTarget(values);
        const fileVars = values.vars === undefined ? {} : await VarsFile.read(values.vars);
        const projectId = values["project-id"] ?? fileVars.projectId;
        if (typeof projectId !== "string") {
            throw new Error("give a project with --project-id or a --vars file that holds projectId");
        }
        const [token] = await LoadTestCli.readTokens(tokensFile);
        const options: GeneratorOptions = {
            projectId,
            shapes: integerOption(values.shapes, LARGE_FILE_DEFAULTS.shapes, "--shapes", 1),
            pages: integerOption(values.pages, LARGE_FILE_DEFAULTS.pages, "--pages", 1),
            batch: integerOption(values.batch, LARGE_FILE_DEFAULTS.batch, "--batch", 2),
            components: integerOption(values.components, LARGE_FILE_DEFAULTS.components, "--components", 0),
            instancesPerPage: integerOption(values.instances, LARGE_FILE_DEFAULTS.instancesPerPage, "--instances", 0),
            seed: integerOption(values.seed, LARGE_FILE_DEFAULTS.seed, "--seed", 0),
            name: values.name,
        };
        const url = values.url ?? process.env.PENPOT_LOADTEST_URL ?? DEFAULT_URL;
        const result = await LoadTestCli.generateWith(url, token, options);

        console.log(
            [
                `file ${result.fileId === "" ? "(not created)" : result.fileId}, project ${result.projectId}`,
                `pages ${result.pageIds.length} content, plus the library page`,
                `shapes ${result.shapeCount}`,
                `pointer map ${result.pointerMap === undefined ? "not reported" : String(result.pointerMap)}`,
                `calls ${result.calls}, duration ${formatElapsed(result.durationMs)}`,
                `seed ${result.seed}`,
            ].join("\n")
        );
        if (result.error !== undefined) {
            console.error(`stopped: ${result.error}`);
        }
        const sizeProbe: SizeProbe | undefined =
            pgStats === undefined ? undefined : (fileId) => new PgStats(pgStats).fileDataBytes(fileId);
        const size = await measureFile(result.fileId, sizeProbe);
        console.log(size.line);

        const vars: Record<string, unknown> = {
            fileId: result.fileId,
            projectId: result.projectId,
            pageId: result.pageId,
            pageIds: result.pageIds,
            libraryPageId: result.libraryPageId,
            componentIds: result.componentIds,
            largeShapeCount: result.shapeCount,
            generator: {
                version: result.generatorVersion,
                seed: result.seed,
                shapes: options.shapes,
                pages: options.pages,
                batch: options.batch,
                components: options.components,
                instancesPerPage: options.instancesPerPage,
                durationMs: result.durationMs,
                calls: result.calls,
                complete: result.complete,
                ...(size.bytes === undefined ? {} : { fileDataBytes: size.bytes }),
            },
        };
        if (fileVars.teamId !== undefined) {
            vars.teamId = fileVars.teamId;
        }
        const file = resolve(values.out ?? DEFAULT_LARGE_VARS_FILE);
        await VarsFile.write(file, vars);
        console.log(`\nwrote ${file}`);
        return result.complete ? 0 : 1;
    }

    /**
     * Connects with one token, builds the file, and closes the session, also when the build fails.
     *
     * @param url - full URL of the MCP endpoint
     * @param token - MCP access token of the first agent
     * @param options - generator settings
     * @returns what the generator built
     */
    private static async generateWith(url: string, token: string, options: GeneratorOptions): Promise<GeneratorResult> {
        const client = new McpLoadClient();
        try {
            await client.connect(url, token);
            return await new LargeFileGenerator(client, options).run();
        } finally {
            await client.close();
        }
    }

    /**
     * Builds the run options from the command line and the environment.
     *
     * @param values - parsed options
     * @param scenario - scenario to run, which supplies the default agent count
     * @param extraVars - variables that take precedence over the vars file
     * @param agentsOverride - agent count that replaces the scenario default
     */
    private static async runOptions(
        values: ParsedValues,
        scenario: Scenario,
        extraVars: Record<string, unknown> = {},
        agentsOverride?: number
    ): Promise<RunOptions> {
        const tokensFile = values.tokens ?? process.env.PENPOT_LOADTEST_TOKENS;
        if (tokensFile === undefined) {
            throw new Error("give a tokens file with --tokens or PENPOT_LOADTEST_TOKENS");
        }
        const tokens = await LoadTestCli.readTokens(tokensFile);
        const agents =
            agentsOverride ??
            (values.agents === undefined ? scenario.agents : parsePositiveInteger(values.agents, "--agents"));
        const fileVars = values.vars === undefined ? {} : await VarsFile.read(values.vars);
        return {
            url: values.url ?? process.env.PENPOT_LOADTEST_URL ?? DEFAULT_URL,
            tokens,
            agents,
            vars: { ...fileVars, ...extraVars },
            env: process.env,
            rateLimitPerSecond: values.rate === undefined ? undefined : parsePositiveNumber(values.rate, "--rate"),
            durationMs: values.duration === undefined ? undefined : parseDuration(values.duration, "--duration"),
            metricsUrl: values.metrics,
            pgStats: pgStatsTarget(values),
            serverPid:
                values["server-pid"] === undefined
                    ? undefined
                    : parsePositiveInteger(values["server-pid"], "--server-pid"),
            sampleIntervalMs:
                values["sample-interval"] === undefined
                    ? undefined
                    : parsePositiveDuration(values["sample-interval"], "--sample-interval"),
            pgSettleMs:
                values["pg-settle"] === undefined ? undefined : parseDuration(values["pg-settle"], "--pg-settle"),
            machineNote: values["machine-note"] ?? process.env.PENPOT_LOADTEST_MACHINE_NOTE,
            arrivalRatePerSecond:
                values["arrival-rate"] === undefined
                    ? undefined
                    : parsePositiveNumber(values["arrival-rate"], "--arrival-rate"),
            warmup: values.warmup === undefined ? undefined : parseWarmup(values.warmup),
            backendFlags: values["backend-flags"] ?? process.env.PENPOT_LOADTEST_BACKEND_FLAGS,
            dbPoolSize:
                values["db-pool-size"] === undefined
                    ? undefined
                    : parsePositiveInteger(values["db-pool-size"], "--db-pool-size"),
        };
    }

    /**
     * Reads one token per line. Blank lines and lines that start with # are skipped.
     *
     * @param file - path of the tokens file
     */
    private static async readTokens(file: string): Promise<string[]> {
        const text = await readFile(file, "utf8").catch((error: Error) => {
            throw new Error(`cannot read tokens file ${file}: ${error.message}`);
        });
        const tokens = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"));
        if (tokens.length === 0) {
            throw new Error(`tokens file ${file} holds no tokens`);
        }
        return tokens;
    }

    /**
     * Compares a finished run with a stored result.
     *
     * @param baselineFile - path of the stored result
     * @param candidate - the finished run
     */
    private static async compareWith(baselineFile: string, candidate: RunResult): Promise<ComparisonReport> {
        const baseline = await ResultFile.read(baselineFile);
        return new ResultComparison().compare(baseline, candidate, basename(baselineFile), "this run");
    }

    /**
     * Prints the figures of a run and, when present, its comparison.
     *
     * @param result - the finished run
     * @param file - path of the JSON result
     * @param htmlFile - path of the HTML report
     * @param comparison - comparison with an earlier run, or undefined
     */
    private static printSummary(
        result: RunResult,
        file: string,
        htmlFile: string,
        comparison: ComparisonReport | undefined
    ): void {
        console.log(
            [
                `scenario ${result.scenario} on commit ${result.commit.slice(0, 10)}`,
                `agents ${result.agents}, iterations ${result.iterations}, calls ${result.calls}, errors ${result.errors}`,
                `p50 ${result.p50.toFixed(1)} ms${percentileNote("p50", result.calls)}, ` +
                    `p95 ${result.p95.toFixed(1)} ms${percentileNote("p95", result.calls)}, ` +
                    `p99 ${result.p99.toFixed(1)} ms${percentileNote("p99", result.calls)}, ` +
                    `max ${result.max.toFixed(1)} ms`,
                ...summaryLines(result),
                `json ${file}`,
                `html ${htmlFile}`,
            ].join("\n")
        );
        if (comparison !== undefined) {
            console.log("\n" + ResultComparison.format(comparison));
        }
    }
}

/**
 * Tells whether a comparison fails the gate. A regression fails it, and so does a figure that is not measured:
 * too few samples is not a pass.
 *
 * @param report - comparison of two runs
 */
function gateFails(report: ComparisonReport): boolean {
    return report.regressions > 0 || report.notMeasured > 0;
}

/**
 * Parses the command line against the option table.
 *
 * @param argv - arguments after the program name
 */
function parseCommandLine(argv: string[]) {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

/** Parsed command-line values. */
type ParsedValues = ReturnType<typeof parseCommandLine>["values"];

/**
 * Parses a whole number of at least 1.
 *
 * @param text - value from the command line
 * @param flag - option name for error messages
 */
function parsePositiveInteger(text: string, flag: string): number {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} must be a whole number of at least 1`);
    }
    return value;
}

/**
 * Parses a positive number.
 *
 * @param text - value from the command line
 * @param flag - option name for error messages
 */
function parsePositiveNumber(text: string, flag: string): number {
    const value = Number(text);
    if (!(value > 0)) {
        throw new Error(`${flag} must be a positive number`);
    }
    return value;
}

/**
 * Parses a duration above zero, such as 5s or 500ms.
 *
 * @param text - duration from the command line
 * @param flag - option name for error messages
 * @returns the duration in milliseconds
 */
function parsePositiveDuration(text: string, flag: string): number {
    const value = parseDuration(text, flag);
    if (!(value > 0)) {
        throw new Error(`${flag} must be longer than zero`);
    }
    return value;
}

/**
 * Parses a duration such as 90s, 30m or 2h. A number without a unit counts as seconds.
 *
 * @param text - duration from the command line
 * @param flag - option name for error messages
 * @returns the duration in milliseconds
 */
function parseDuration(text: string, flag: string): number {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
    if (match === null) {
        throw new Error(`${flag} must look like 90s, 30m or 2h, got "${text}"`);
    }
    const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
    return Number(match[1]) * factor[match[2] ?? "s"];
}

/**
 * Reads a whole-number option, with a default when the option is not given.
 *
 * @param text - value from the command line, or undefined when the option is not given
 * @param fallback - value used when the option is not given
 * @param flag - option name for error messages
 * @param minimum - smallest allowed value
 */
function integerOption(text: string | undefined, fallback: number, flag: string, minimum: number): number {
    if (text === undefined) {
        return fallback;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`${flag} must be a whole number of at least ${minimum}`);
    }
    return value;
}

/**
 * Reads the Postgres target from --pg-stats, or from PENPOT_LOADTEST_PG_STATS when the option is not given.
 *
 * @param values - parsed options
 * @returns the target, or undefined when neither is set
 * @throws Error when the text is not docker:<container>:<database>[:<user>]
 */
function pgStatsTarget(values: ParsedValues): PgStatsTarget | undefined {
    const text = values["pg-stats"] ?? process.env.PENPOT_LOADTEST_PG_STATS;
    if (text === undefined || text.trim() === "") {
        return undefined;
    }
    return PgStats.parseTarget(text.trim());
}

/** Result of measuring the stored size of the generated file. */
interface FileMeasure {
    /** Size in bytes, or undefined when it is not known. */
    bytes?: number;
    /** Line for the summary. */
    line: string;
}

/**
 * Measures the stored size of a file for the summary. Without a probe, the MCP tools do not report the size.
 *
 * @param fileId - file to measure, empty when the build did not create one
 * @param sizeProbe - reads the size in bytes, or undefined when no probe is set
 */
async function measureFile(fileId: string, sizeProbe?: SizeProbe): Promise<FileMeasure> {
    if (sizeProbe === undefined) {
        return { line: "file size: not reported by the MCP tools (use --pg-stats)" };
    }
    if (fileId === "") {
        return { line: "file size: not measured, no file was created" };
    }
    try {
        const bytes = await sizeProbe(fileId);
        if (bytes === undefined) {
            return { line: `file size: Postgres did not answer for ${fileId}` };
        }
        return {
            bytes,
            line: `file size: ${bytes} bytes (${formatMegabytes(bytes)} MB) of stored file data, from Postgres`,
        };
    } catch (error) {
        return { line: `file size: not read from Postgres: ${(error as Error).message}` };
    }
}

LoadTestCli.main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
);
