// Samples the series that must not grow without bound during a soak run, then summarizes whether any grew.
//
// Usage:
//   node scripts/round2/soak-sampler.mjs --out <file.jsonl> [--interval-s 60] [--duration 4h10m]
//                                       [--stop-file <path>] [--backend-metrics <url>] [--adapter <url>]...
//                                       [--pg-container <name>] [--pg-db <name>] [--file-id <uuid>]...
//   node scripts/round2/soak-sampler.mjs --summarize <file.jsonl> [--json <out.json>] [--interval-s <n>]
//   node scripts/round2/soak-sampler.mjs --help
//
// Sample mode appends one JSON line per sample. It only reads: it fetches Prometheus text over HTTP and runs
// SELECT queries through `docker exec <container> psql` as argv, never through a shell.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_PATTERN = /^[A-Za-z0-9_]+$/;
const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_CONTAINER = "penpot-penpot-postgres-1";
const DEFAULT_DB = "penpot_mcpdev";
const DEFAULT_BACKEND = "http://localhost:6061/metrics";
const DEFAULT_ADAPTERS = ["http://127.0.0.1:4406/metrics", "http://127.0.0.1:4407/metrics"];
const PSQL_USER = "penpot";
const FETCH_TIMEOUT_MS = 10000;
const PSQL_TIMEOUT_MS = 20000;
const WINDOW_S = 1800;
const GROWTH_RATIO = 0.2;
const MIN_R2 = 0.5;
const BYTES_PER_MB = 1048576;

const VALUE_FLAGS = new Set([
    "--out",
    "--summarize",
    "--json",
    "--interval-s",
    "--duration",
    "--stop-file",
    "--backend-metrics",
    "--adapter",
    "--pg-container",
    "--pg-db",
    "--file-id",
]);
const SAMPLE_ONLY_FLAGS = [
    "--duration",
    "--stop-file",
    "--backend-metrics",
    "--adapter",
    "--pg-container",
    "--pg-db",
    "--file-id",
];

// [output key, Prometheus metric name, optional exact label filter]
const BACKEND_FIELDS = [
    ["heapBytes", "jvm_memory_bytes_used", { area: "heap" }],
    ["threads", "jvm_threads_current"],
    ["openFds", "process_open_fds"],
    ["hikariActive", "hikaricp_active_connections"],
    ["hikariIdle", "hikaricp_idle_connections"],
    ["hikariPending", "hikaricp_pending_threads"],
    ["cpuSeconds", "process_cpu_seconds_total"],
    ["gcSeconds", "jvm_gc_collection_seconds_sum"],
];
const ADAPTER_FIELDS = [
    ["processResidentBytes", "penpot_mcp_process_resident_bytes"],
    ["processHeapUsedBytes", "penpot_mcp_process_heap_used_bytes"],
    ["activeSandboxes", "penpot_mcp_active_sandboxes"],
    ["validatorEntries", "penpot_mcp_validator_entries"],
    ["renderSessions", "penpot_mcp_render_sessions"],
    ["redisUp", "penpot_mcp_redis_up"],
    ["toolCallsOk", "penpot_mcp_tool_calls_total", { outcome: "ok" }],
    ["toolCallsError", "penpot_mcp_tool_calls_total", { outcome: "error" }],
    ["rateLimitFallback", "penpot_mcp_rate_limit_fallback_total"],
];
const BACKEND_SERIES = ["heapBytes", "threads", "hikariActive", "hikariPending"];
const ADAPTER_SERIES = [
    "processResidentBytes",
    "processHeapUsedBytes",
    "activeSandboxes",
    "validatorEntries",
    "renderSessions",
];
const PG_SERIES = ["connectionsTotal", "connectionsDb", "fileChangeRows", "fileChangeBytes", "dbBytes"];

export const USAGE = `Usage:
  node scripts/round2/soak-sampler.mjs --out <file.jsonl> [sample options]
  node scripts/round2/soak-sampler.mjs --summarize <file.jsonl> [summarize options]
  node scripts/round2/soak-sampler.mjs --help

Sample mode: appends one JSON line per sample, the first one right away.
  --out <file.jsonl>        output file, appended to (required)
  --interval-s <n>          seconds between samples, a positive number (default ${DEFAULT_INTERVAL_S})
  --duration <d>            stop after this long, e.g. 4h10m, 90m, 30s (default: run until stopped)
  --stop-file <path>        stop after a sample when this file exists
  --backend-metrics <url>   backend Prometheus URL (default ${DEFAULT_BACKEND})
  --adapter <url>           adapter Prometheus URL, repeatable (default ${DEFAULT_ADAPTERS.join(", ")})
  --pg-container <name>     Postgres container (default ${DEFAULT_CONTAINER})
  --pg-db <name>            database, letters, digits and _ only (default ${DEFAULT_DB})
  --file-id <uuid>          file whose file_change rows are counted, repeatable

Summarize mode: reads a JSONL file written by sample mode and prints a table.
  --summarize <file.jsonl>  file to summarize (required)
  --json <out.json>         also write the summary as pretty JSON
  --interval-s <n>          sample interval used for gap detection (default: median spacing of the file)

SIGINT or SIGTERM finishes the current sample line, then exits with code 0.
Exit codes: 0 done, 1 runtime error, 2 usage error.
`;

/**
 * Fails unless the value is a UUID. Keeps file ids safe to put into SQL.
 * @param {string} value
 * @returns {string} the value, unchanged
 */
export function assertUuid(value) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new Error(`not a UUID: ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Fails unless the value is a plain database name (letters, digits and underscore). It goes into SQL as a literal.
 * @param {string} value
 * @returns {string} the value, unchanged
 */
export function assertDbName(value) {
    if (typeof value !== "string" || !DB_PATTERN.test(value)) {
        throw new Error(`database name must be letters, digits and underscore only: ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Parses a duration such as 4h10m, 90m or 30s. The parts must come in h, m, s order and the total must be positive.
 * @param {string} text
 * @returns {number} seconds
 */
export function parseDuration(text) {
    const match = typeof text === "string" && text.length > 0 ? DURATION_PATTERN.exec(text) : null;
    if (match === null) {
        throw new Error(`bad duration ${JSON.stringify(text)}: use h, m and s parts in that order, e.g. 4h10m`);
    }
    const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    if (seconds <= 0) {
        throw new Error(`duration must be positive: ${JSON.stringify(text)}`);
    }
    return seconds;
}

function parsePositiveNumber(value, flag) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`${flag} must be a positive number, got ${JSON.stringify(value)}`);
    }
    return number;
}

/**
 * Parses the command line by hand. Throws on unknown flags, missing values and bad values.
 * @param {string[]} argv arguments after the script name
 * @returns {{help: boolean, mode: "sample" | "summarize" | null, out: string | null, summarize: string | null,
 *   json: string | null, intervalS: number | null, durationS: number | null, stopFile: string | null,
 *   backendMetrics: string, adapters: string[], pgContainer: string, pgDb: string, fileIds: string[]}}
 */
export function parseSoakArgs(argv) {
    const options = {
        help: false,
        mode: null,
        out: null,
        summarize: null,
        json: null,
        intervalS: null,
        durationS: null,
        stopFile: null,
        backendMetrics: DEFAULT_BACKEND,
        adapters: [],
        pgContainer: DEFAULT_CONTAINER,
        pgDb: DEFAULT_DB,
        fileIds: [],
    };
    const given = new Set();
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        if (flag === "--help") {
            options.help = true;
            continue;
        }
        if (!VALUE_FLAGS.has(flag)) {
            throw new Error(`unknown argument ${JSON.stringify(flag)}`);
        }
        const value = argv[i + 1];
        if (value === undefined || value === "" || value.startsWith("--")) {
            throw new Error(`${flag} needs a value`);
        }
        i += 1;
        given.add(flag);
        switch (flag) {
            case "--out":
                options.out = value;
                break;
            case "--summarize":
                options.summarize = value;
                break;
            case "--json":
                options.json = value;
                break;
            case "--interval-s":
                options.intervalS = parsePositiveNumber(value, flag);
                break;
            case "--duration":
                options.durationS = parseDuration(value);
                break;
            case "--stop-file":
                options.stopFile = value;
                break;
            case "--backend-metrics":
                options.backendMetrics = value;
                break;
            case "--adapter":
                options.adapters.push(value);
                break;
            case "--pg-container":
                options.pgContainer = value;
                break;
            case "--pg-db":
                options.pgDb = assertDbName(value);
                break;
            case "--file-id":
                options.fileIds.push(assertUuid(value));
                break;
            default:
                break;
        }
    }
    if (options.help) {
        return options;
    }
    if (options.out !== null && options.summarize !== null) {
        throw new Error("give either --out or --summarize, not both");
    }
    if (options.out === null && options.summarize === null) {
        throw new Error("give --out <file.jsonl> to sample, or --summarize <file.jsonl> to summarize");
    }
    if (options.summarize !== null) {
        const wrong = SAMPLE_ONLY_FLAGS.filter((flag) => given.has(flag));
        if (wrong.length > 0) {
            throw new Error(`${wrong.join(", ")} apply to sample mode only`);
        }
        options.mode = "summarize";
        return options;
    }
    if (given.has("--json")) {
        throw new Error("--json applies to --summarize only");
    }
    options.mode = "sample";
    options.intervalS = options.intervalS ?? DEFAULT_INTERVAL_S;
    if (options.adapters.length === 0) {
        options.adapters = [...DEFAULT_ADAPTERS];
    }
    return options;
}

/**
 * Parses one Prometheus text exposition. Comment and blank lines are skipped, and malformed lines are dropped.
 * Label values may be quoted and may hold escaped quotes, backslashes, commas and braces.
 * @param {string} text
 * @returns {{name: string, labels: Record<string, string>, value: number}[]}
 */
export function parsePrometheus(text) {
    const samples = [];
    for (const rawLine of String(text).split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const sample = parseSampleLine(line);
        if (sample !== null) {
            samples.push(sample);
        }
    }
    return samples;
}

function parseSampleLine(line) {
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(line);
    if (nameMatch === null) {
        return null;
    }
    const name = nameMatch[0];
    let pos = name.length;
    let labels = {};
    if (line[pos] === "{") {
        const parsed = parseLabels(line, pos + 1);
        if (parsed === null) {
            return null;
        }
        labels = parsed.labels;
        pos = parsed.end;
    }
    // Anything after the value (an optional timestamp) is ignored.
    const token = line.slice(pos).trim().split(/\s+/)[0] ?? "";
    const value = parseValue(token);
    if (value === null) {
        return null;
    }
    return { name, labels, value };
}

function parseLabels(line, start) {
    const labels = {};
    let pos = start;
    for (;;) {
        while (pos < line.length && (/\s/.test(line[pos]) || line[pos] === ",")) {
            pos += 1;
        }
        if (pos >= line.length) {
            return null;
        }
        if (line[pos] === "}") {
            return { labels, end: pos + 1 };
        }
        const eq = line.indexOf("=", pos);
        if (eq < 0) {
            return null;
        }
        const key = line.slice(pos, eq).trim();
        pos = eq + 1;
        if (line[pos] !== '"') {
            return null;
        }
        pos += 1;
        let value = "";
        for (;;) {
            if (pos >= line.length) {
                return null;
            }
            const ch = line[pos];
            if (ch === "\\") {
                const next = line[pos + 1];
                if (next === undefined) {
                    return null;
                }
                value += next === "n" ? "\n" : next;
                pos += 2;
            } else if (ch === '"') {
                pos += 1;
                break;
            } else {
                value += ch;
                pos += 1;
            }
        }
        labels[key] = value;
    }
}

function parseValue(token) {
    if (token === "+Inf" || token === "Inf") {
        return Infinity;
    }
    if (token === "-Inf") {
        return -Infinity;
    }
    if (token === "NaN") {
        return NaN;
    }
    const value = Number(token);
    return token !== "" && !Number.isNaN(value) ? value : null;
}

/**
 * Sums the values of the samples with this name whose labels match every pair in the filter.
 * @param {{name: string, labels: Record<string, string>, value: number}[]} samples
 * @param {string} name
 * @param {Record<string, string>} [labelFilter] exact label matches
 * @returns {number | null} the sum, or null when nothing matched
 */
export function metricSum(samples, name, labelFilter = {}) {
    let total = 0;
    let matched = false;
    for (const sample of samples) {
        if (sample.name !== name) {
            continue;
        }
        const fits = Object.entries(labelFilter).every(([key, value]) => sample.labels[key] === value);
        if (!fits) {
            continue;
        }
        total += sample.value;
        matched = true;
    }
    return matched ? total : null;
}

/**
 * Builds the SQL for every Postgres series. Validates the database name and every file id.
 * @param {string} db database name
 * @param {string[]} [fileIds] file ids (UUIDs)
 * @returns {{connectionsTotal: string, connectionsDb: string, stateCounts: string, fileChangeRows: string,
 *   fileChangeBytes: string, dbBytes: string, fileChangeRowsById: Record<string, string>}}
 */
export function buildPsqlQueries(db, fileIds = []) {
    const name = assertDbName(db);
    const queries = {
        connectionsTotal: "select count(*) from pg_stat_activity",
        connectionsDb: `select count(*) from pg_stat_activity where datname = '${name}'`,
        stateCounts: `select state, count(*) from pg_stat_activity where datname='${name}' group by state`,
        // count(*) scans the whole table (138 seq scans in the soak); n_live_tup is the live-row estimate
        fileChangeRows: "select n_live_tup from pg_stat_user_tables where relname = 'file_change'",
        fileChangeBytes: "select pg_total_relation_size('file_change')",
        dbBytes: `select pg_database_size('${name}')`,
        fileChangeRowsById: {},
    };
    for (const id of fileIds) {
        const safe = assertUuid(id);
        queries.fileChangeRowsById[safe] = `select count(*) from file_change where file_id = '${safe}'`;
    }
    return queries;
}

/**
 * Parses the one-value output of a psql query, using the first non-empty line.
 * @param {string} stdout
 * @returns {number}
 */
export function parseSingleValue(stdout) {
    const line = String(stdout)
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item !== "");
    if (line === undefined) {
        throw new Error("empty psql result");
    }
    const value = Number(line);
    if (!Number.isFinite(value)) {
        throw new Error(`not a number: ${JSON.stringify(line)}`);
    }
    return value;
}

/**
 * Parses `state|count` lines from psql. An empty state (NULL) is keyed "none".
 * @param {string} stdout
 * @returns {Record<string, number>}
 */
export function parseStateCounts(stdout) {
    const counts = {};
    for (const rawLine of String(stdout).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "") {
            continue;
        }
        const bar = line.indexOf("|");
        if (bar < 0) {
            throw new Error(`expected state|count, got ${JSON.stringify(line)}`);
        }
        const state = line.slice(0, bar).trim() || "none";
        counts[state] = (counts[state] ?? 0) + parseSingleValue(line.slice(bar + 1));
    }
    return counts;
}

function errorMessage(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
}

async function fetchText(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

function extractFields(samples, specs) {
    const values = {};
    for (const [key, name, labels] of specs) {
        values[key] = metricSum(samples, name, labels);
    }
    return values;
}

async function collectBackend(url, errors) {
    try {
        return { url, ...extractFields(parsePrometheus(await fetchText(url)), BACKEND_FIELDS) };
    } catch (error) {
        errors.push(`backend ${url}: ${errorMessage(error)}`);
        return { url, down: true };
    }
}

async function collectAdapter(url, errors) {
    try {
        return { url, ...extractFields(parsePrometheus(await fetchText(url)), ADAPTER_FIELDS) };
    } catch (error) {
        errors.push(`adapter ${url}: ${errorMessage(error)}`);
        return { url, down: true };
    }
}

function runPsqlDocker(container, db, sql) {
    const args = ["exec", container, "psql", "-U", PSQL_USER, "-d", db, "-Atc", sql];
    return new Promise((resolvePromise, reject) => {
        execFile(
            "docker",
            args,
            { timeout: PSQL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(String(stderr).trim() || error.message));
                } else {
                    resolvePromise(String(stdout));
                }
            }
        );
    });
}

async function attempt(label, errors, action) {
    try {
        return await action();
    } catch (error) {
        errors.push(`${label}: ${errorMessage(error)}`);
        return null;
    }
}

/**
 * Runs every Postgres query for one sample. A failed query records an error and gives null. Never throws for a query.
 * @param {{pgContainer: string, pgDb: string, fileIds: string[]}} options
 * @param {string[]} errors receives one string per failed query
 * @param {(sql: string) => Promise<string>} [runner] runs one query; defaults to docker exec psql
 * @returns {Promise<Record<string, unknown>>}
 */
export async function collectPg(options, errors, runner) {
    const run = runner ?? ((sql) => runPsqlDocker(options.pgContainer, options.pgDb, sql));
    const queries = buildPsqlQueries(options.pgDb, options.fileIds);
    const pg = {};
    for (const key of PG_SERIES) {
        pg[key] = await attempt(`pg.${key}`, errors, async () => parseSingleValue(await run(queries[key])));
    }
    pg.stateCounts = await attempt("pg.stateCounts", errors, async () =>
        parseStateCounts(await run(queries.stateCounts))
    );
    pg.fileChangeRowsById = {};
    for (const [id, sql] of Object.entries(queries.fileChangeRowsById)) {
        pg.fileChangeRowsById[id] = await attempt(`pg.fileChangeRowsById[${id}]`, errors, async () =>
            parseSingleValue(await run(sql))
        );
    }
    return pg;
}

/**
 * Takes one sample: backend, every adapter and Postgres. Failures are recorded in `errors`, never thrown.
 * @param {object} options parsed sample-mode options
 * @param {number} startMs run start, in epoch milliseconds
 * @param {(sql: string) => Promise<string>} [runner] optional Postgres runner (for tests)
 * @returns {Promise<{t: string, elapsedS: number, backend: object, adapters: object[], pg: object, errors: string[]}>}
 */
export async function collectSample(options, startMs, runner) {
    const errors = [];
    const now = Date.now();
    const backend = await collectBackend(options.backendMetrics, errors);
    const adapters = [];
    for (const url of options.adapters) {
        adapters.push(await collectAdapter(url, errors));
    }
    const pg = await collectPg(options, errors, runner);
    return {
        t: new Date(now).toISOString(),
        elapsedS: (now - startMs) / 1000,
        backend,
        adapters,
        pg,
        errors,
    };
}

function portOf(url) {
    try {
        const parsed = new URL(url);
        return parsed.port !== "" ? parsed.port : parsed.host;
    } catch {
        return url;
    }
}

function adapterLabel(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port}`;
    } catch {
        return url;
    }
}

function formatMb(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${(value / BYTES_PER_MB).toFixed(1)}MB` : "n/a";
}

function formatCount(value) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

/**
 * Formats one sample as a single console line, for example:
 * 12:01:00 heap=512.3MB adapter4406 rss=180.2MB adapter4407 rss=175.0MB pg_conn=42 file_change=12034
 * @param {{t: string, backend: object, adapters: object[], pg: object, errors: string[]}} sample
 * @returns {string}
 */
export function formatConsoleLine(sample) {
    const time = new Date(sample.t);
    const hms = [time.getHours(), time.getMinutes(), time.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
    const parts = [hms, `heap=${formatMb(sample.backend?.heapBytes)}`];
    for (const adapter of sample.adapters ?? []) {
        parts.push(`adapter${portOf(adapter.url)} rss=${formatMb(adapter.processResidentBytes)}`);
    }
    parts.push(`pg_conn=${formatCount(sample.pg?.connectionsTotal)}`);
    parts.push(`file_change=${formatCount(sample.pg?.fileChangeRows)}`);
    if (sample.errors.length > 0) {
        parts.push(`errors=${sample.errors.length}`);
    }
    return parts.join(" ");
}

function shouldStop(options, elapsedS, state) {
    if (state.stopSignal) {
        return true;
    }
    if (options.durationS !== null && elapsedS >= options.durationS) {
        return true;
    }
    return options.stopFile !== null && existsSync(options.stopFile);
}

function sleepInterruptible(ms, state) {
    return new Promise((resolvePromise) => {
        const finish = () => {
            clearTimeout(timer);
            state.wake = null;
            resolvePromise();
        };
        const timer = setTimeout(finish, ms);
        state.wake = finish;
    });
}

async function runSampler(options) {
    const startMs = Date.now();
    const state = { stopSignal: false, wake: null };
    const onSignal = () => {
        state.stopSignal = true;
        if (state.wake !== null) {
            state.wake();
        }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
        for (;;) {
            const sample = await collectSample(options, startMs);
            appendFileSync(options.out, JSON.stringify(sample) + "\n");
            process.stdout.write(formatConsoleLine(sample) + "\n");
            if (shouldStop(options, (Date.now() - startMs) / 1000, state)) {
                break;
            }
            const elapsedS = (Date.now() - startMs) / 1000;
            const remainingS = options.durationS === null ? Infinity : options.durationS - elapsedS;
            await sleepInterruptible(Math.max(0, Math.min(options.intervalS, remainingS)) * 1000, state);
            if (state.stopSignal) {
                break;
            }
        }
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
    return 0;
}

/**
 * Least-squares line through (xs, ys). R^2 is the squared correlation, which equals the usual fit R^2.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {{slope: number, intercept: number, r2: number | null} | null} null with fewer than 2 points or equal xs
 */
export function linearFit(xs, ys) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) {
        return null;
    }
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i += 1) {
        sumX += xs[i];
        sumY += ys[i];
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if (sxx === 0) {
        return null;
    }
    const slope = sxy / sxx;
    return {
        slope,
        intercept: meanY - slope * meanX,
        r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
    };
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Classifies one series. "growing" needs a rise of more than 20% of the first window mean, a positive slope
 * and R^2 above 0.5. Fewer than 2 points is "flat".
 * @param {{count: number, firstMean: number | null, lastMean: number | null, slopePerHour: number | null,
 *   r2: number | null}} stats
 * @returns {"growing" | "flat"}
 */
export function classifySeries({ count, firstMean, lastMean, slopePerHour, r2 }) {
    if (count < 2 || !isNumber(firstMean) || !isNumber(lastMean) || !isNumber(slopePerHour) || !isNumber(r2)) {
        return "flat";
    }
    const rose = lastMean - firstMean > GROWTH_RATIO * Math.abs(firstMean);
    return rose && slopePerHour > 0 && r2 > MIN_R2 ? "growing" : "flat";
}

function mean(values) {
    if (values.length === 0) {
        return null;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Summarizes one series of {x: elapsedS, y: value} points.
 * @param {{x: number, y: number}[]} points non-null values in file order
 * @param {{minElapsedS: number, maxElapsedS: number}} range elapsed range of the whole file
 * @returns {object} first, last, min, max, the two 30-minute window means, slope per hour, R^2 and verdict
 */
export function summarizeSeries(points, range) {
    const ys = points.map((point) => point.y);
    const early = points.filter((point) => point.x <= range.minElapsedS + WINDOW_S).map((point) => point.y);
    const late = points.filter((point) => point.x > range.maxElapsedS - WINDOW_S).map((point) => point.y);
    const fit =
        points.length >= 2
            ? linearFit(
                  points.map((point) => point.x),
                  ys
              )
            : null;
    const meanFirst30m = mean(early);
    const meanLast30m = mean(late);
    const slopePerHour = fit === null ? null : fit.slope * 3600;
    const r2 = fit === null ? null : fit.r2;
    return {
        first: ys.length > 0 ? ys[0] : null,
        last: ys.length > 0 ? ys[ys.length - 1] : null,
        min: ys.length > 0 ? Math.min(...ys) : null,
        max: ys.length > 0 ? Math.max(...ys) : null,
        meanFirst30m,
        meanLast30m,
        slopePerHour,
        r2,
        verdict: classifySeries({
            count: points.length,
            firstMean: meanFirst30m,
            lastMean: meanLast30m,
            slopePerHour,
            r2,
        }),
    };
}

function median(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Parses the JSONL text of a sample file. Blank lines are skipped.
 * @param {string} text
 * @returns {object[]} samples, in file order
 */
export function parseJsonl(text) {
    const samples = [];
    String(text)
        .split("\n")
        .forEach((rawLine, index) => {
            const line = rawLine.trim();
            if (line === "") {
                return;
            }
            let value;
            try {
                value = JSON.parse(line);
            } catch {
                throw new Error(`line ${index + 1} is not JSON`);
            }
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new Error(`line ${index + 1} is not a JSON object`);
            }
            if (!isNumber(value.elapsedS)) {
                throw new Error(`line ${index + 1} has no numeric elapsedS`);
            }
            samples.push(value);
        });
    if (samples.length === 0) {
        throw new Error("no samples in file");
    }
    return samples;
}

const finiteOrNull = (value) => (isNumber(value) ? value : null);

function adapterValue(sample, url, key) {
    const adapter = (sample.adapters ?? []).find((item) => item?.url === url);
    if (adapter === undefined || adapter.down === true) {
        return null;
    }
    return finiteOrNull(adapter[key]);
}

/**
 * Lists every series in the file, each with a reader that gives its value for one sample (or null).
 * @param {object[]} samples
 * @returns {{name: string, read: (sample: object) => number | null}[]}
 */
export function seriesDefinitions(samples) {
    const defs = [];
    for (const key of BACKEND_SERIES) {
        defs.push({ name: `backend.${key}`, read: (sample) => finiteOrNull(sample.backend?.[key]) });
    }
    const urls = [];
    const ids = [];
    for (const sample of samples) {
        for (const adapter of sample.adapters ?? []) {
            if (typeof adapter?.url === "string" && !urls.includes(adapter.url)) {
                urls.push(adapter.url);
            }
        }
        for (const id of Object.keys(sample.pg?.fileChangeRowsById ?? {})) {
            if (!ids.includes(id)) {
                ids.push(id);
            }
        }
    }
    for (const url of urls) {
        for (const key of ADAPTER_SERIES) {
            defs.push({
                name: `adapter ${adapterLabel(url)}.${key}`,
                read: (sample) => adapterValue(sample, url, key),
            });
        }
    }
    for (const key of PG_SERIES) {
        defs.push({ name: `pg.${key}`, read: (sample) => finiteOrNull(sample.pg?.[key]) });
    }
    for (const id of ids) {
        defs.push({
            name: `pg.fileChangeRowsById[${id}]`,
            read: (sample) => finiteOrNull(sample.pg?.fileChangeRowsById?.[id]),
        });
    }
    return defs;
}

/**
 * Summarizes a parsed sample file: every series, gaps, error counts and down adapters.
 * @param {object[]} samples
 * @param {number | null} intervalOverride --interval-s, or null to use the median spacing
 * @returns {{samples: number, durationS: number, intervalS: number | null, gaps: object[], samplesWithErrors: number,
 *   samplesWithDownAdapter: number, series: Record<string, object>}}
 */
export function summarizeSamples(samples, intervalOverride = null) {
    const elapsed = samples.map((sample) => sample.elapsedS);
    const range = { minElapsedS: Math.min(...elapsed), maxElapsedS: Math.max(...elapsed) };
    const spacings = [];
    for (let i = 1; i < elapsed.length; i += 1) {
        spacings.push(elapsed[i] - elapsed[i - 1]);
    }
    const intervalS = intervalOverride ?? median(spacings);
    const gaps = [];
    if (intervalS !== null && intervalS > 0) {
        for (let i = 1; i < elapsed.length; i += 1) {
            const gapS = elapsed[i] - elapsed[i - 1];
            if (gapS > 2 * intervalS) {
                gaps.push({ afterElapsedS: elapsed[i - 1], gapS });
            }
        }
    }
    const series = {};
    for (const def of seriesDefinitions(samples)) {
        const points = [];
        for (const sample of samples) {
            const y = def.read(sample);
            if (y !== null) {
                points.push({ x: sample.elapsedS, y });
            }
        }
        series[def.name] = summarizeSeries(points, range);
    }
    return {
        samples: samples.length,
        durationS: range.maxElapsedS,
        intervalS: intervalS !== null && intervalS > 0 ? intervalS : null,
        gaps,
        samplesWithErrors: samples.filter((sample) => Array.isArray(sample.errors) && sample.errors.length > 0).length,
        samplesWithDownAdapter: samples.filter(
            (sample) => Array.isArray(sample.adapters) && sample.adapters.some((adapter) => adapter?.down === true)
        ).length,
        series,
    };
}

function formatNumber(value) {
    if (!isNumber(value)) {
        return "n/a";
    }
    if (Math.abs(value) >= 1000) {
        return String(Math.round(value));
    }
    return String(Number(value.toPrecision(4)));
}

function formatTable(series) {
    const header = [
        "series",
        "first",
        "last",
        "min",
        "max",
        "mean first 30m",
        "mean last 30m",
        "slope/h",
        "R^2",
        "verdict",
    ];
    const rows = [header];
    for (const [name, s] of Object.entries(series)) {
        rows.push([
            name,
            formatNumber(s.first),
            formatNumber(s.last),
            formatNumber(s.min),
            formatNumber(s.max),
            formatNumber(s.meanFirst30m),
            formatNumber(s.meanLast30m),
            formatNumber(s.slopePerHour),
            isNumber(s.r2) ? s.r2.toFixed(2) : "n/a",
            s.verdict,
        ]);
    }
    const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    return rows
        .map((row) =>
            row
                .map((cell, column) => cell.padEnd(widths[column] + 2))
                .join("")
                .trimEnd()
        )
        .join("\n");
}

function runSummarize(options) {
    const samples = parseJsonl(readFileSync(options.summarize, "utf8"));
    const result = summarizeSamples(samples, options.intervalS);
    process.stdout.write(formatTable(result.series) + "\n");
    process.stdout.write(
        `${result.samples} samples, run ${result.durationS}s, ${result.gaps.length} gaps, ` +
            `${result.samplesWithErrors} samples with errors, ` +
            `${result.samplesWithDownAdapter} samples with a down adapter\n`
    );
    if (options.json !== null) {
        writeFileSync(options.json, JSON.stringify({ file: options.summarize, ...result }, null, 2) + "\n");
    }
    return 0;
}

async function main(argv) {
    let options;
    try {
        options = parseSoakArgs(argv);
    } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(USAGE);
        return 0;
    }
    try {
        return options.mode === "summarize" ? runSummarize(options) : await runSampler(options);
    } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        return 1;
    }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
