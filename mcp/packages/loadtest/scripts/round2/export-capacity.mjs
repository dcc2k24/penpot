// Exporter capacity launcher and summarizer for scenario C8.
// Runs fixtures/scenarios/c8-export-heavy.json (exporters) and c8-export-heavy-reads.json (readers) at the same
// time, then prints one summary of their result files. Token values are never printed.
//
// Usage (from any directory):
//   node scripts/round2/export-capacity.mjs --tokens <file> --vars <file> [--url <mcp url>] [--duration 3m]
//   node scripts/round2/export-capacity.mjs --dry-run --tokens <file> --vars <file>
//   node scripts/round2/export-capacity.mjs --summarize <dir>
//   node scripts/round2/export-capacity.mjs --help

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const EXPORT_SCENARIO = "C8-export-heavy";
export const READ_SCENARIO = "C8-export-heavy-reads";
export const EXPORT_TOOL = "export_shape";
export const READ_TOOLS = ["get_page_tree", "find_shapes"];
export const CATEGORIES = ["export permit", "render timeout", "exporter", "setup", "other"];

const DEFAULT_URL = "http://localhost:4401/mcp";
const DEFAULT_DURATION = "3m";
const DEFAULT_EXPORT_AGENTS = 10;
const DEFAULT_READ_AGENTS = 3;
const LOADTEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCP_ROOT = resolve(LOADTEST_ROOT, "..", "..");
const DEFAULT_RESULTS = join(LOADTEST_ROOT, "results");

const USAGE = `Exporter capacity scenario C8: exporting agents and reading agents, run at the same time.

Options:
  --tokens <file>        tokens file, one token per line (required)
  --vars <file>          setup vars file from "loadtest setup" (required)
  --url <mcp url>        MCP endpoint (default ${DEFAULT_URL})
  --duration <3m>        length of each run; a number without a unit means seconds (default ${DEFAULT_DURATION})
  --export-agents <n>    exporting agents (default ${DEFAULT_EXPORT_AGENTS})
  --read-agents <n>      reading agents (default ${DEFAULT_READ_AGENTS})
  --results <dir>        result folder (default ${DEFAULT_RESULTS})
  --dry-run              print the two commands and the expected summary; run nothing
  --summarize <dir>      print the summary of the two result files in <dir>; run nothing
  --help                 print this text

Agent i uses token i. The exporting agents take the first tokens and the reading agents take the tokens after
them, so no token is shared between an exporter and a reader. The tokens file needs at least
export-agents + read-agents lines.`;

/** A problem with the command line. Exit code 2. */
class UsageError extends Error {}

/**
 * Classifies one failure message of a run.
 *
 * "render timeout" matches the text of the render deadline in ExportConcurrency.ts: "The export did not finish
 * within 60 seconds." "export permit" matches the words "export permit", which the code does not print today.
 *
 * @param {string} message - one failure message from errorSamples
 * @returns {string} one of CATEGORIES
 */
export function classifyError(message) {
    const text = String(message ?? "");
    if (/export permit/i.test(text)) return "export permit";
    if (/did not finish within/i.test(text)) return "render timeout";
    if (/exporter/i.test(text)) return "exporter";
    if (/^setup: /.test(text)) return "setup";
    return "other";
}

/**
 * Checks that a parsed result has the fields that the summary reads. Field names follow src/ResultFile.ts.
 *
 * @param {unknown} value - parsed JSON
 * @param {string} source - file name for the error message
 * @returns {object} the same value
 * @throws {Error} when a field is missing or has the wrong type
 */
export function assertResult(value, source) {
    const problems = [];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${source}: a result must be a JSON object`);
    }
    if (typeof value.scenario !== "string") problems.push("scenario must be a string");
    for (const key of ["errors", "p50", "p95", "calls", "agents", "durationMs"]) {
        if (typeof value[key] !== "number") problems.push(`${key} must be a number`);
    }
    if (!Array.isArray(value.steps)) {
        problems.push("steps must be an array");
    } else {
        value.steps.forEach((step, index) => {
            if (typeof step?.name !== "string" || typeof step?.tool !== "string") {
                problems.push(`steps[${index}] needs name and tool strings`);
            }
            for (const key of ["calls", "errors", "p50", "p95"]) {
                if (typeof step?.[key] !== "number") problems.push(`steps[${index}].${key} must be a number`);
            }
        });
    }
    if (value.errorSamples !== undefined && !Array.isArray(value.errorSamples)) {
        problems.push("errorSamples must be an array");
    }
    if (problems.length > 0) {
        throw new Error(`${source} is not a valid result: ${problems.join("; ")}`);
    }
    return value;
}

/**
 * Reduces one result document to the figures the summary prints.
 *
 * The export p50 and p95 come from the export_shape step. The read p95 across both read steps is the run-level p95,
 * because the read run has no other steps, so every call in that run is a read. errorSamples holds distinct
 * messages only, so the grouped counts are distinct messages, not occurrences. errors is the true total.
 *
 * @param {object} result - a result document (see src/ResultFile.ts)
 * @returns {object} figures of the run
 */
export function summarizeRun(result) {
    const steps = (result.steps ?? []).map((step) => ({
        name: step.name,
        tool: step.tool,
        calls: step.calls,
        errors: step.errors,
        p50: step.p50,
        p95: step.p95,
    }));
    const samples = (result.errorSamples ?? []).map((message) => String(message));
    const errorGroups = Object.fromEntries(CATEGORIES.map((category) => [category, []]));
    for (const message of samples) {
        errorGroups[classifyError(message)].push(message);
    }
    const isReadRun = steps.length > 0 && steps.every((step) => READ_TOOLS.includes(step.tool));
    return {
        scenario: result.scenario,
        startedAt: result.startedAt,
        agents: result.agents,
        durationMs: result.durationMs,
        calls: result.calls,
        errors: result.errors,
        steps,
        errorSampleCount: samples.length,
        errorGroups,
        exportPermitMatches: samples.filter((message) => /export permit/i.test(message)).length,
        exporterMatches: samples.filter((message) => /exporter/i.test(message)).length,
        readP95: isReadRun ? result.p95 : null,
    };
}

/**
 * Picks the newest result of each scenario from a list of parsed results.
 *
 * @param {Array<{file: string, result: object}>} entries - results read from a folder
 * @returns {{exportEntry: object|undefined, readEntry: object|undefined}} newest entry per scenario
 */
export function pickLatest(entries) {
    const newest = (name) =>
        entries
            .filter((entry) => entry.result.scenario === name)
            .sort((a, b) => String(b.result.startedAt).localeCompare(String(a.result.startedAt)))[0];
    return { exportEntry: newest(EXPORT_SCENARIO), readEntry: newest(READ_SCENARIO) };
}

/**
 * Formats one step line of a run.
 *
 * @param {object} step - a step from summarizeRun
 * @returns {string} the line
 */
function stepLine(step) {
    return `  "${step.name}" (${step.tool}): calls ${step.calls}, errors ${step.errors}, p50 ${ms(step.p50)}, p95 ${ms(step.p95)}`;
}

/**
 * Formats a latency in milliseconds.
 *
 * @param {number|null|undefined} value - latency
 * @returns {string} the text
 */
function ms(value) {
    return typeof value === "number" ? `${value.toFixed(1)} ms` : "n/a";
}

/**
 * Formats the grouped error messages of a run.
 *
 * @param {object} run - a summary from summarizeRun
 * @param {boolean} showEmpty - whether to print the empty groups
 * @returns {string[]} lines
 */
function errorLines(run, showEmpty) {
    const lines = [`  error messages (distinct): ${run.errorSampleCount}`];
    for (const category of CATEGORIES) {
        const messages = run.errorGroups[category];
        if (messages.length === 0 && !showEmpty) continue;
        lines.push(`    ${category}: ${messages.length}`);
        for (const message of messages) {
            lines.push(`      - ${message}`);
        }
    }
    return lines;
}

/**
 * Formats the summary of both runs as plain text.
 *
 * @param {{exportEntry?: object, readEntry?: object}} runs - each entry has file and result
 * @returns {string} the report
 */
export function formatReport({ exportEntry, readEntry }) {
    const lines = ["Exporter capacity summary (C8)", ""];
    if (exportEntry === undefined) {
        lines.push(`Export run ${EXPORT_SCENARIO}: no result file found`);
    } else {
        const run = summarizeRun(exportEntry.result);
        lines.push(`Export run ${EXPORT_SCENARIO}`);
        lines.push(`  file: ${exportEntry.file}`);
        lines.push(
            `  agents ${run.agents}, duration ${(run.durationMs / 1000).toFixed(0)} s, calls ${run.calls}, errors ${run.errors}`
        );
        lines.push(...run.steps.map(stepLine));
        lines.push(...errorLines(run, true));
        lines.push(`  messages matching /export permit/i: ${run.exportPermitMatches}`);
        lines.push(`  messages matching /exporter/i: ${run.exporterMatches}`);
    }
    lines.push("");
    if (readEntry === undefined) {
        lines.push(`Read run ${READ_SCENARIO}: no result file found`);
    } else {
        const run = summarizeRun(readEntry.result);
        lines.push(`Read run ${READ_SCENARIO}`);
        lines.push(`  file: ${readEntry.file}`);
        lines.push(
            `  agents ${run.agents}, duration ${(run.durationMs / 1000).toFixed(0)} s, calls ${run.calls}, errors ${run.errors}`
        );
        lines.push(...run.steps.map(stepLine));
        lines.push(`  read p95 across both read steps: ${ms(run.readP95)}`);
        lines.push(...errorLines(run, false));
    }
    return lines.join("\n");
}

/**
 * Quotes one command-line argument for the shell.
 *
 * @param {string} arg - the argument
 * @returns {string} the argument, quoted when it has spaces or shell characters
 * @throws {UsageError} when the argument contains a double quote
 */
export function quoteArg(arg) {
    const text = String(arg);
    if (text.includes('"')) {
        throw new UsageError("a file path may not contain a double quote");
    }
    return /^[A-Za-z0-9_\-.:/\\=@,+]+$/.test(text) ? text : `"${text}"`;
}

/**
 * Builds the arguments of one "loadtest run" call.
 *
 * @param {object} run
 * @param {string} run.scenario - scenario name
 * @param {string} run.url - MCP endpoint
 * @param {string} run.tokensFile - tokens file of this run
 * @param {string} run.varsFile - setup vars file
 * @param {number} run.agents - agents of this run
 * @param {string} run.duration - run length, such as 3m
 * @param {string} run.resultsDir - result folder
 * @returns {string[]} arguments that follow "loadtest"
 */
export function runArgs({ scenario, url, tokensFile, varsFile, agents, duration, resultsDir }) {
    return [
        "run",
        scenario,
        "--url",
        url,
        "--tokens",
        tokensFile,
        "--vars",
        varsFile,
        "--agents",
        String(agents),
        "--duration",
        duration,
        "--results",
        resultsDir,
    ];
}

/**
 * Builds the shell command line of one run. The root alias "loadtest" runs the CLI of this package.
 *
 * @param {string[]} args - arguments from runArgs
 * @returns {string} the command line
 */
export function buildCommand(args) {
    return ["npx", "pnpm", "loadtest", ...args].map(quoteArg).join(" ");
}

/**
 * Replaces every token value in a text, so that no token reaches the console.
 *
 * @param {string} text - text to clean
 * @param {string[]} tokens - token values
 * @returns {string} the cleaned text
 */
export function redact(text, tokens) {
    let result = String(text);
    for (const token of tokens) {
        if (token !== "") result = result.split(token).join("<token>");
    }
    return result;
}

/**
 * Reads the token lines of a tokens file, skipping blank lines and lines that start with #. Same rule as the CLI.
 *
 * @param {string} file - tokens file
 * @returns {Promise<string[]>} the tokens
 */
export async function readTokenLines(file) {
    const text = await readFile(file, "utf8");
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Parses a count option. It must be a whole number of at least one.
 *
 * @param {string|undefined} value - the option value
 * @param {string} name - option name for messages
 * @param {number} fallback - value when the option is absent
 * @returns {number} the count
 * @throws {UsageError} when the value is not a whole number of at least one
 */
export function parseCount(value, name, fallback) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new UsageError(`${name} must be a whole number of at least 1, got "${value}"`);
    }
    return Number(value);
}

/**
 * Reads the result files of a folder. Files that are not valid results are listed as skipped, not used.
 *
 * @param {string} directory - result folder
 * @returns {Promise<{entries: Array<{file: string, result: object}>, skipped: string[]}>}
 */
export async function readResultDirectory(directory) {
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json"));
    const entries = [];
    const skipped = [];
    for (const name of names) {
        const file = join(directory, name);
        try {
            entries.push({ file, result: assertResult(JSON.parse(await readFile(file, "utf8")), file) });
        } catch (error) {
            skipped.push(error.message);
        }
    }
    return { entries, skipped };
}

/**
 * Prints each line of a child stream with a label, with tokens redacted.
 *
 * @param {NodeJS.ReadableStream} stream - child stdout or stderr
 * @param {string} label - prefix of each line
 * @param {string[]} tokens - token values to hide
 */
function pipeLines(stream, label, tokens) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
        pending += chunk;
        let index = pending.indexOf("\n");
        while (index !== -1) {
            console.log(redact(`${label} ${pending.slice(0, index).replace(/\r$/, "")}`, tokens));
            pending = pending.slice(index + 1);
            index = pending.indexOf("\n");
        }
    });
    stream.on("end", () => {
        if (pending !== "") console.log(redact(`${label} ${pending}`, tokens));
    });
}

/**
 * Runs one "pnpm loadtest run" in the mcp folder and resolves with its exit code.
 *
 * @param {string[]} args - arguments from runArgs
 * @param {string} label - prefix of the child output
 * @param {string[]} tokens - token values to hide
 * @returns {Promise<number>} exit code
 */
function runChild(args, label, tokens) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(buildCommand(args), {
            cwd: MCP_ROOT,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        pipeLines(child.stdout, label, tokens);
        pipeLines(child.stderr, label, tokens);
        child.on("error", reject);
        child.on("close", (code) => resolvePromise(code ?? 1));
    });
}

/**
 * Describes what the summary will show. Printed by the dry run.
 *
 * @returns {string[]} lines
 */
function expectedSummaryLines() {
    return [
        "Expected summary after both runs:",
        `  export run ${EXPORT_SCENARIO}: ${EXPORT_TOOL} step p50 and p95 (ms), errors total,`,
        "    error messages grouped as export permit, render timeout, exporter, setup, other,",
        "    and the counts matching /export permit/i and /exporter/i",
        `  read run ${READ_SCENARIO}: p95 (ms) of get_page_tree and find_shapes, read p95 across both`,
        "    steps (run-level p95), errors total and grouped error messages",
    ];
}

/**
 * Runs both scenarios at once, then prints the summary of their result files.
 *
 * @param {object} values - parsed options
 * @returns {Promise<number>} exit code
 */
async function runBoth(values) {
    if (values.tokens === undefined) throw new UsageError("--tokens <file> is required");
    if (values.vars === undefined) throw new UsageError("--vars <file> is required");
    const exportAgents = parseCount(values["export-agents"], "--export-agents", DEFAULT_EXPORT_AGENTS);
    const readAgents = parseCount(values["read-agents"], "--read-agents", DEFAULT_READ_AGENTS);
    const duration = values.duration ?? DEFAULT_DURATION;
    if (!/^\d+(\.\d+)?[smh]?$/.test(duration)) {
        throw new UsageError(`--duration must be a number with an optional unit s, m or h, got "${duration}"`);
    }
    const url = values.url ?? DEFAULT_URL;
    const resultsDir = values.results === undefined ? DEFAULT_RESULTS : resolve(values.results);
    const varsFile = resolve(values.vars);
    const tokensFile = resolve(values.tokens);
    const tokens = await readTokenLines(tokensFile);
    const needed = exportAgents + readAgents;
    if (tokens.length < needed) {
        throw new UsageError(
            `the tokens file holds ${tokens.length} tokens; ${exportAgents} exporting and ${readAgents} reading agents need ${needed}`
        );
    }
    const readTokens = tokens.slice(exportAgents, needed);

    if (values["dry-run"] === true) {
        const exportLine = buildCommand(
            runArgs({
                scenario: EXPORT_SCENARIO,
                url,
                tokensFile: "<tokens file>",
                varsFile,
                agents: exportAgents,
                duration,
                resultsDir,
            })
        );
        const readLine = buildCommand(
            runArgs({
                scenario: READ_SCENARIO,
                url,
                tokensFile: "<temporary file with the reading agents' tokens>",
                varsFile,
                agents: readAgents,
                duration,
                resultsDir,
            })
        );
        console.log("Dry run: nothing is started.");
        console.log(`Working folder: ${MCP_ROOT}`);
        console.log(`Export run: ${exportLine}`);
        console.log(`Read run:   ${readLine}`);
        console.log(
            `Tokens: ${tokens.length} in the file; exporting agents use tokens 1-${exportAgents}, ` +
                `reading agents use ${exportAgents + 1}-${needed}.`
        );
        console.log(`Results folder: ${resultsDir}`);
        console.log(expectedSummaryLines().join("\n"));
        return 0;
    }

    const tempDir = await mkdtemp(join(tmpdir(), "c8-export-capacity-"));
    try {
        const readTokensFile = join(tempDir, "read-tokens.txt");
        await writeFile(readTokensFile, `${readTokens.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        const before = new Set((await readdir(resultsDir).catch(() => [])).filter((name) => name.endsWith(".json")));
        const startedAt = Date.now();
        console.log(
            `Starting ${EXPORT_SCENARIO} (${exportAgents} agents) and ${READ_SCENARIO} (${readAgents} agents), ${duration} each.`
        );
        const [exportCode, readCode] = await Promise.all([
            runChild(
                runArgs({
                    scenario: EXPORT_SCENARIO,
                    url,
                    tokensFile,
                    varsFile,
                    agents: exportAgents,
                    duration,
                    resultsDir,
                }),
                "[export]",
                tokens
            ),
            runChild(
                runArgs({
                    scenario: READ_SCENARIO,
                    url,
                    tokensFile: readTokensFile,
                    varsFile,
                    agents: readAgents,
                    duration,
                    resultsDir,
                }),
                "[reads] ",
                tokens
            ),
        ]);
        const { entries, skipped } = await readResultDirectory(resultsDir);
        // A run's file is new in the folder, or it is a result written after this launch started.
        const fresh = entries.filter(
            (entry) => !before.has(entry.file.split(/[\\/]/).pop()) || Date.parse(entry.result.startedAt) >= startedAt
        );
        const { exportEntry, readEntry } = pickLatest(fresh);
        console.log("");
        console.log(redact(formatReport({ exportEntry, readEntry }), tokens));
        for (const note of skipped) console.log(`skipped (not a result): ${note}`);
        if (exportCode !== 0 || readCode !== 0) {
            console.log(`exit codes: export ${exportCode}, reads ${readCode}`);
            return 1;
        }
        return 0;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Parses the arguments and runs the chosen mode.
 *
 * @param {string[]} argv - arguments after the script name
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            tokens: { type: "string" },
            vars: { type: "string" },
            url: { type: "string" },
            duration: { type: "string" },
            "export-agents": { type: "string" },
            "read-agents": { type: "string" },
            results: { type: "string" },
            "dry-run": { type: "boolean" },
            summarize: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help === true) {
        console.log(USAGE);
        return 0;
    }
    if (values.summarize !== undefined) {
        const { entries, skipped } = await readResultDirectory(resolve(values.summarize));
        const { exportEntry, readEntry } = pickLatest(entries);
        console.log(formatReport({ exportEntry, readEntry }));
        for (const note of skipped) console.log(`skipped (not a result): ${note}`);
        return 0;
    }
    return runBoth(values);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`export-capacity: ${error.message}`);
            if (!(error instanceof UsageError)) console.error(error.stack);
            process.exitCode = error instanceof UsageError ? 2 : 1;
        }
    );
}
