// Shared-state check across two MCP adapters that share one Redis: the per-token rate limiter and the storage object
// of execute_code. Five cases run in order against the two adapters. Each case prints one PASS, FAIL or SKIP line,
// and the whole run is written as one JSON result. Without --dry-run this sends real calls, so point it at a test
// stack.
//
// Usage: node scripts/round2/shared-state.mjs --help
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CASE_NAMES = ["storage-alternation", "rate-limit-shared", "storage-isolation", "render-isolation", "revocation"];
const LABELS = ["A", "B"];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_CONTAINER = "penpot-penpot-postgres-1";
const PG_ARGS = ["-U", "penpot", "-d", "penpot_mcpdev"];
const REFUSAL_PATTERN = /rate limited/;
const WHOAMI_SAMPLE = /^penpot_mcp_tool_calls_total\{tool="whoami",outcome="(ok|error)"\}\s+([0-9.eE+-]+)$/;
const METRICS_TIMEOUT_MS = 10_000;
const TEXT_CUT = 200;

const ALTERNATION_CALLS = 50;
const RESET_CODE = "storage.r2counter = 0; return 0;";
const COUNT_CODE = "storage.r2counter = (storage.r2counter ?? 0) + 1; return storage.r2counter;";
const READ_SECRET_CODE = "return storage.r2secret ?? null;";

const REFILL_WAIT_MS = 3000;
/** Pause before each call of the storage alternation case (about 8 calls per second, under the shared limit). */
const ALTERNATION_GAP_MS = 120;
const BURST_BUCKET = 20;
const REFILL_PER_SECOND = 10;
const REFILL_SLACK_BURST = 4;
const REFILL_SLACK_SUSTAINED = 5;
const BURST_PER_ADAPTER = 20;
const BURST_LIMIT = BURST_BUCKET + REFILL_SLACK_BURST;
const MIN_REFUSED = 12;
const SUSTAINED_PER_SECOND = 20;
const SUSTAINED_SECONDS = 5;
const SUSTAINED_LIMIT = BURST_BUCKET + REFILL_PER_SECOND * SUSTAINED_SECONDS + REFILL_SLACK_SUSTAINED;

const REVOKE_POLL_MS = 2000;
const REVOKE_EXTRA_MS = 30_000;
const REVOKE_SLACK_S = 5;

const TOKEN_FILE_FIELD = {
    main: "tokenFile",
    second: "tokenFile2",
    outsider: "outsiderTokenFile",
    revoke: "revokeTokenFile",
};

const USAGE = `Usage: node scripts/round2/shared-state.mjs --url-a <url> --url-b <url> --token-file <file> --vars <file>
                 [options]

Required:
  --url-a <url>                 MCP endpoint of adapter A, for example http://127.0.0.1:4406/mcp
  --url-b <url>                 MCP endpoint of adapter B, for example http://127.0.0.1:4407/mcp
  --token-file <file>           file holding the main MCP token (first non-empty line; never printed)
  --vars <file>                 JSON file with string fileId and pageId

Inputs of some cases (a case without its input is skipped):
  --token-file-2 <file>         token of another profile in the same team (storage-isolation)
  --outsider-token-file <file>  token of a profile outside the file's team (render-isolation)
  --revoke-token-file <file>    throwaway token that the revocation case deletes (revocation)
  --revoke-token-id <uuid>      access_token row id of that token (revocation)

Options:
  --only <a,b>                  run only these cases (comma-separated), in the usual order:
                                ${CASE_NAMES.join(", ")}
  --metrics-a <url>             /metrics of adapter A (default: origin of --url-a plus /metrics)
  --metrics-b <url>             /metrics of adapter B (default: origin of --url-b plus /metrics)
  --cache-s <n>                 token cache time of the adapters, 1 to 3600 seconds (default 60)
  --out <file>                  write the JSON result (paths and results only, never a token)
  --dry-run                     print the plan and send nothing
  --help                        print this text

Exit codes: 0 when no selected case fails (a skipped case is not a failure), 1 when one fails, 2 for a usage error.
The revocation case deletes one access_token row with docker exec and psql.`;

/**
 * Reads the command line. Throws on a bad or missing option.
 *
 * @param argv - arguments after the script name
 * @returns the parsed options; metrics URLs get their default when not given
 */
export function parseArgs(argv) {
    const opts = {
        urlA: undefined,
        urlB: undefined,
        tokenFile: undefined,
        tokenFile2: undefined,
        outsiderTokenFile: undefined,
        revokeTokenFile: undefined,
        revokeTokenId: undefined,
        varsFile: undefined,
        metricsA: undefined,
        metricsB: undefined,
        only: undefined,
        cacheS: 60,
        out: undefined,
        dryRun: false,
        help: false,
    };
    const integer = (text, flag, min, max) => {
        const value = Number(text);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${flag} must be a whole number from ${min} to ${max}, got "${text}"`);
        }
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                throw new Error(`${arg} needs a value`);
            }
            i++;
            return next;
        };
        switch (arg) {
            case "--help":
                opts.help = true;
                break;
            case "--dry-run":
                opts.dryRun = true;
                break;
            case "--url-a":
                opts.urlA = value();
                break;
            case "--url-b":
                opts.urlB = value();
                break;
            case "--metrics-a":
                opts.metricsA = value();
                break;
            case "--metrics-b":
                opts.metricsB = value();
                break;
            case "--token-file":
                opts.tokenFile = value();
                break;
            case "--token-file-2":
                opts.tokenFile2 = value();
                break;
            case "--outsider-token-file":
                opts.outsiderTokenFile = value();
                break;
            case "--revoke-token-file":
                opts.revokeTokenFile = value();
                break;
            case "--revoke-token-id": {
                const text = value();
                if (!UUID_REGEX.test(text)) {
                    throw new Error(`--revoke-token-id must be a uuid, got "${text}"`);
                }
                opts.revokeTokenId = text;
                break;
            }
            case "--vars":
                opts.varsFile = value();
                break;
            case "--out":
                opts.out = value();
                break;
            case "--cache-s":
                opts.cacheS = integer(value(), arg, 1, 3600);
                break;
            case "--only":
                opts.only = parseOnly(value());
                break;
            default:
                throw new Error(`unknown argument ${arg}`);
        }
    }
    if (opts.help) {
        return opts;
    }
    for (const [flag, field] of [
        ["--url-a", "urlA"],
        ["--url-b", "urlB"],
        ["--token-file", "tokenFile"],
        ["--vars", "varsFile"],
    ]) {
        if (!opts[field]) {
            throw new Error(`${flag} is required`);
        }
    }
    return opts;
}

/**
 * Checks every URL option that is set. Run before any connection, not in parseArgs, so that --dry-run still
 * prints its plan for any text.
 *
 * @param opts - parsed options
 * @throws Error naming the first option that is not a URL
 */
function checkUrls(opts) {
    const pairs = [
        ["--url-a", opts.urlA],
        ["--url-b", opts.urlB],
        ["--metrics-a", opts.metricsA],
        ["--metrics-b", opts.metricsB],
    ];
    for (const [flag, value] of pairs) {
        if (value !== undefined) {
            checkUrl(flag, value);
        }
    }
}

/**
 * Metrics URLs of the run: the given ones, or the origin of each adapter URL plus /metrics.
 *
 * @param opts - parsed options
 * @returns metricsA and metricsB
 */
function resolveMetrics(opts) {
    return {
        metricsA: opts.metricsA ?? defaultMetricsUrl(opts.urlA),
        metricsB: opts.metricsB ?? defaultMetricsUrl(opts.urlB),
    };
}

/**
 * The /metrics URL of an adapter URL. Text that is not a URL gets /metrics appended as it is.
 *
 * @param url - adapter MCP endpoint
 */
function defaultMetricsUrl(url) {
    try {
        return new URL("/metrics", url).href;
    } catch {
        return `${url}/metrics`;
    }
}

/**
 * Reads the --only list. Every name must be a known case.
 *
 * @param text - comma-separated case names
 * @returns the names, without repeats
 * @throws Error when the list is empty or holds an unknown name
 */
function parseOnly(text) {
    const names = text
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
    if (names.length === 0) {
        throw new Error("--only needs at least one case name");
    }
    for (const name of names) {
        if (!CASE_NAMES.includes(name)) {
            throw new Error(`--only names an unknown case "${name}"`);
        }
    }
    return [...new Set(names)];
}

/**
 * Checks that a flag holds an absolute URL.
 *
 * @param flag - the flag name, for the message
 * @param text - the value of the flag
 * @throws Error when the value is not a URL
 */
function checkUrl(flag, text) {
    try {
        void new URL(text);
    } catch {
        throw new Error(`${flag} is not a URL: "${text}"`);
    }
}

/**
 * Returns the first non-empty line of a text, trimmed. Used for token files: the text itself is never printed.
 *
 * @param text - file content
 * @returns the first non-empty line
 * @throws Error when the text has no non-empty line
 */
export function firstLine(text) {
    const line = text
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item !== "");
    if (line === undefined) {
        throw new Error("the token file holds no non-empty line");
    }
    return line;
}

/**
 * Reads the whoami counters of one adapter from Prometheus text.
 *
 * @param text - body of a /metrics answer
 * @returns the finished whoami calls by outcome; a missing sample counts as 0
 */
export function parseWhoamiCounts(text) {
    const counts = { ok: 0, error: 0 };
    for (const line of text.split("\n")) {
        const match = WHOAMI_SAMPLE.exec(line.trim());
        if (match !== null) {
            counts[match[1]] = Number(match[2]);
        }
    }
    return counts;
}

/**
 * Sorts one tool outcome into admitted, refused (rate limited) or other.
 *
 * @param outcome - outcome of a tool call from McpLoadClient
 * @returns "admitted", "refused" or "other"
 */
export function classify(outcome) {
    if (outcome.ok) {
        return "admitted";
    }
    return REFUSAL_PATTERN.test(`${outcome.text ?? ""} ${outcome.error ?? ""}`) ? "refused" : "other";
}

/**
 * Counts the outcomes of a phase, in total and per adapter.
 *
 * @param entries - objects with label ("A" or "B") and outcome
 * @returns admitted, refused and other counts, in total and under perAdapter
 */
export function tallyOutcomes(entries) {
    const emptyTally = () => ({ admitted: 0, refused: 0, other: 0 });
    const perAdapter = { A: emptyTally(), B: emptyTally() };
    for (const { label, outcome } of entries) {
        perAdapter[label][classify(outcome)] += 1;
    }
    const total = emptyTally();
    for (const label of LABELS) {
        for (const key of Object.keys(total)) {
            total[key] += perAdapter[label][key];
        }
    }
    return { ...total, perAdapter };
}

/**
 * Joins whitespace and cuts a text to the given length.
 *
 * @param text - any text
 * @param limit - most characters to keep
 */
function cut(text, limit = TEXT_CUT) {
    return String(text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
}

/**
 * Describes a tool outcome for the result: ok, time, and the text or error cut to 200 characters.
 *
 * @param outcome - outcome of a tool call from McpLoadClient
 */
function brief(outcome) {
    return {
        ok: outcome.ok,
        ms: round1(outcome.durationMs),
        text: cut(outcome.text),
        ...(outcome.error === undefined ? {} : { error: cut(outcome.error) }),
    };
}

/**
 * The reason a failed call is worth showing on one line.
 *
 * @param outcome - outcome of a tool call from McpLoadClient
 */
function shortText(outcome) {
    return cut(outcome.error ?? outcome.text ?? "");
}

/**
 * Rounds to one decimal place.
 *
 * @param value - a number
 */
function round1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Waits.
 *
 * @param ms - milliseconds
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Text of an error, or its string form.
 *
 * @param error - any thrown value
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the whoami counters of one /metrics URL with a plain fetch. No token is sent.
 *
 * @param url - the /metrics URL
 * @returns the counters, or the error text when the URL cannot be read
 */
async function readMetrics(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(METRICS_TIMEOUT_MS) });
        if (!response.ok) {
            return { error: `HTTP ${response.status}` };
        }
        return { counts: parseWhoamiCounts(await response.text()) };
    } catch (error) {
        return { error: messageOf(error) };
    }
}

/**
 * Difference of two counter reads of one adapter.
 *
 * @param before - read before the phase
 * @param after - read after the phase
 * @returns the ok and error deltas, or the error text when either read failed
 */
export function metricDelta(before, after) {
    if (before.error !== undefined || after.error !== undefined) {
        return { error: before.error ?? after.error };
    }
    return {
        ok: after.counts.ok - before.counts.ok,
        error: after.counts.error - before.counts.error,
    };
}

/**
 * Holds the options, the tokens and one client per token, adapter and kind, for one run.
 */
class RunContext {
    /**
     * @param opts - parsed options
     * @param vars - fileId and pageId of the run
     * @param ClientClass - McpLoadClient from the built package
     */
    constructor(opts, vars, ClientClass) {
        this.opts = opts;
        this.vars = vars;
        this.urls = { A: opts.urlA, B: opts.urlB };
        this.ClientClass = ClientClass;
        this.tokens = new Map();
        this.clients = new Map();
    }

    /**
     * Token of one kind, read from its file once. The value stays in memory and is never printed.
     *
     * @param kind - main, second, outsider or revoke
     */
    token(kind) {
        if (!this.tokens.has(kind)) {
            this.tokens.set(kind, firstLine(readFileSync(this.opts[TOKEN_FILE_FIELD[kind]], "utf8")));
        }
        return this.tokens.get(kind);
    }

    /**
     * Client for one token kind on one adapter. The connection is made once and shared by later calls.
     *
     * @param kind - token kind
     * @param label - "A" or "B"
     */
    client(kind, label) {
        const key = `${kind}-${label}`;
        if (!this.clients.has(key)) {
            const token = this.token(kind);
            const ClientClass = this.ClientClass;
            const url = this.urls[label];
            this.clients.set(
                key,
                (async () => {
                    const client = new ClientClass();
                    await client.connect(url, token);
                    return client;
                })()
            );
        }
        return this.clients.get(key);
    }

    /**
     * Calls one tool through the client of a token kind on an adapter.
     *
     * @param kind - token kind
     * @param label - "A" or "B"
     * @param tool - tool name
     * @param args - tool arguments
     */
    async call(kind, label, tool, args) {
        const client = await this.client(kind, label);
        return client.callTool(tool, args);
    }

    /**
     * Reads the /metrics of both adapters.
     */
    async metrics() {
        return { A: await readMetrics(this.opts.metricsA), B: await readMetrics(this.opts.metricsB) };
    }

    /**
     * Closes every client. Best effort: a client that never connected is skipped.
     */
    async closeAll() {
        for (const pending of this.clients.values()) {
            try {
                const client = await pending;
                await client.close();
            } catch {
                // closing is best effort; the result is already known
            }
        }
        this.clients.clear();
    }
}

/**
 * Case 1: one token, calls alternate between the adapters, and the storage counter must count 1 to 50 in order.
 *
 * @param ctx - run context
 */
async function runStorageAlternation(ctx) {
    const { fileId } = ctx.vars;
    const reset = await ctx.call("main", "A", "execute_code", { fileId, code: RESET_CODE });
    if (!reset.ok) {
        return { pass: false, details: { summary: `reset failed: ${shortText(reset)}` } };
    }
    const calls = [];
    for (let i = 0; i < ALTERNATION_CALLS; i++) {
        const adapter = i % 2 === 0 ? "A" : "B";
        // keep under the shared bucket's 10 calls per second, so a refusal does not look like a storage fault
        await sleep(ALTERNATION_GAP_MS);
        const outcome = await ctx.call("main", adapter, "execute_code", { fileId, code: COUNT_CODE });
        const storageNotice = outcome.json?.storageNotice;
        calls.push({
            call: i + 1,
            adapter,
            value: outcome.ok ? (outcome.json?.result ?? null) : null,
            ms: round1(outcome.durationMs),
            ok: outcome.ok,
            ...(outcome.ok ? {} : { error: shortText(outcome) }),
            ...(typeof storageNotice === "string" ? { storageNotice } : {}),
        });
    }
    const bad = calls.find((entry) => !entry.ok || entry.value !== entry.call);
    let summary;
    if (bad === undefined) {
        summary = `values 1 to ${ALTERNATION_CALLS} in order across both adapters`;
    } else if (bad.ok) {
        summary = `call ${bad.call} on ${bad.adapter} returned ${JSON.stringify(bad.value)}, expected ${bad.call}`;
    } else {
        summary = `call ${bad.call} on ${bad.adapter} failed: ${bad.error}`;
    }
    return { pass: bad === undefined, details: { summary, reset: "ok", calls } };
}

/**
 * Sends the burst of the rate-limit case: 20 whoami through each adapter, all at once.
 *
 * @param ctx - run context
 */
async function burstPhase(ctx) {
    const sends = [];
    for (let i = 0; i < BURST_PER_ADAPTER; i++) {
        for (const label of LABELS) {
            sends.push(ctx.call("main", label, "whoami", {}).then((outcome) => ({ label, outcome })));
        }
    }
    return tallyOutcomes(await Promise.all(sends));
}

/**
 * Sends the sustained phase of the rate-limit case: 20 whoami per second for 5 s, alternating adapters. Each call
 * is sent on its own timer and is not awaited before the next one goes out.
 *
 * @param ctx - run context
 */
async function sustainedPhase(ctx) {
    const total = SUSTAINED_PER_SECOND * SUSTAINED_SECONDS;
    const gap = 1000 / SUSTAINED_PER_SECOND;
    const started = Date.now();
    const sends = [];
    for (let i = 0; i < total; i++) {
        const wait = started + i * gap - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        const label = i % 2 === 0 ? "A" : "B";
        sends.push(ctx.call("main", label, "whoami", {}).then((outcome) => ({ label, outcome })));
    }
    const tally = tallyOutcomes(await Promise.all(sends));
    return { ...tally, sent: total, spanMs: Date.now() - started };
}

/**
 * Case 2: the shared bucket admits about 20 burst calls and then 10 per second, across both adapters.
 *
 * @param ctx - run context
 */
async function runRateLimitShared(ctx) {
    await sleep(REFILL_WAIT_MS);
    const before = await ctx.metrics();
    const burst = await burstPhase(ctx);
    const sustained = await sustainedPhase(ctx);
    const after = await ctx.metrics();
    const checks = {
        burstAdmittedWithinLimit: burst.admitted <= BURST_LIMIT,
        burstRefusedAtLeast: burst.refused >= MIN_REFUSED,
        burstRefusalsFromBothAdapters: burst.perAdapter.A.refused > 0 && burst.perAdapter.B.refused > 0,
        sustainedAdmittedWithinLimit: sustained.admitted <= SUSTAINED_LIMIT,
    };
    const pass = Object.values(checks).every(Boolean);
    const summary =
        `burst admitted ${burst.admitted} of ${BURST_PER_ADAPTER * LABELS.length} (limit ${BURST_LIMIT}), ` +
        `refused ${burst.refused}; sustained admitted ${sustained.admitted} (limit ${SUSTAINED_LIMIT})`;
    const delta = { A: metricDelta(before.A, after.A), B: metricDelta(before.B, after.B) };
    return { pass, details: { summary, checks, burst, sustained, metrics: { before, after, delta } } };
}

/**
 * Case 3: storage written with one token is not visible to another token, and is visible to the first token on the
 * other adapter. The secret is a random id made for this run; it is compared, never printed.
 *
 * @param ctx - run context
 */
async function runStorageIsolation(ctx) {
    const { fileId } = ctx.vars;
    // the rate-limit case before this one leaves the main token's bucket empty
    await sleep(REFILL_WAIT_MS);
    const secret = randomUUID();
    const write = await ctx.call("main", "A", "execute_code", {
        fileId,
        code: `storage.r2secret = "${secret}"; return 1;`,
    });
    const secondB = await ctx.call("second", "B", "execute_code", { fileId, code: READ_SECRET_CODE });
    const secondA = await ctx.call("second", "A", "execute_code", { fileId, code: READ_SECRET_CODE });
    const mainB = await ctx.call("main", "B", "execute_code", { fileId, code: READ_SECRET_CODE });
    const describeRead = (outcome) => {
        if (!outcome.ok) {
            return { ok: false, error: shortText(outcome) };
        }
        const value = outcome.json?.result ?? null;
        const kind = value === null ? "null" : value === secret ? "the written secret" : "other value";
        return { ok: true, result: kind };
    };
    const checks = {
        writeOk: write.ok && write.json?.result === 1,
        secondTokenViaBIsNull: secondB.ok && (secondB.json?.result ?? null) === null,
        secondTokenViaAIsNull: secondA.ok && (secondA.json?.result ?? null) === null,
        mainTokenViaBReadsSecret: mainB.ok && mainB.json?.result === secret,
    };
    const failing = Object.keys(checks).filter((key) => !checks[key]);
    const summary =
        failing.length === 0
            ? "isolated per token; the first token reads its secret on the other adapter"
            : `failed checks: ${failing.join(", ")}`;
    return {
        pass: failing.length === 0,
        details: {
            summary,
            checks,
            write: brief(write),
            reads: {
                secondTokenViaB: describeRead(secondB),
                secondTokenViaA: describeRead(secondA),
                mainTokenViaB: describeRead(mainB),
            },
        },
    };
}

/**
 * Case 4: an outsider must not render or read a file that the owner's token has cached a render session for.
 *
 * @param ctx - run context
 */
async function runRenderIsolation(ctx) {
    const { fileId, pageId } = ctx.vars;
    const exportArgs = { fileId, pageId, shapeId: "page", format: "png" };
    const owner = await ctx.call("main", "A", "export_shape", exportArgs);
    const steps = [
        ["A", "export_shape", exportArgs],
        ["B", "export_shape", exportArgs],
        ["A", "get_file_outline", { fileId }],
        ["B", "get_file_outline", { fileId }],
    ];
    const outsider = [];
    for (const [label, tool, args] of steps) {
        const outcome = await ctx.call("outsider", label, tool, args);
        outsider.push({ adapter: label, tool, ...brief(outcome) });
    }
    const ownerOk = owner.ok;
    const outsiderAllFailed = outsider.every((entry) => !entry.ok);
    const pass = ownerOk && outsiderAllFailed;
    let summary;
    if (!ownerOk) {
        summary = `owner export failed: ${shortText(owner)}`;
    } else if (!outsiderAllFailed) {
        summary = `an outsider call was not refused: ${outsider.filter((entry) => entry.ok).length} of 4 succeeded`;
    } else {
        summary = "owner export ok; all 4 outsider calls refused";
    }
    return { pass, details: { summary, owner: { adapter: "A", tool: "export_shape", ...brief(owner) }, outsider } };
}

/**
 * Deletes one access_token row with docker exec and psql, and returns the number of rows removed.
 *
 * @param id - access_token row id; checked as a uuid by the caller
 * @returns the delete count reported by psql, or -1 when the output has no delete tag
 */
async function deleteTokenRow(id) {
    const sql = `DELETE FROM access_token WHERE id = '${id}'`;
    const { stdout } = await execFileAsync("docker", ["exec", PG_CONTAINER, "psql", ...PG_ARGS, "-Atc", sql]);
    const match = /^DELETE (\d+)\s*$/m.exec(stdout);
    return match === null ? -1 : Number(match[1]);
}

/**
 * Case 5: after the token row is deleted, each adapter must refuse the token within cache-s + 5 s, and must not
 * admit it again after its first refusal.
 *
 * @param ctx - run context
 */
async function runRevocation(ctx) {
    const { revokeTokenId, cacheS } = ctx.opts;
    const before = {};
    for (const label of LABELS) {
        before[label] = brief(await ctx.call("revoke", label, "whoami", {}));
    }
    if (!before.A.ok || !before.B.ok) {
        return {
            pass: false,
            details: { summary: "whoami before the delete was not ok; no row was deleted", before },
        };
    }
    const t0 = Date.now();
    const deleted = await deleteTokenRow(revokeTokenId);
    if (deleted !== 1) {
        return {
            pass: false,
            details: { summary: `delete removed ${deleted} rows, expected 1`, before },
        };
    }
    const first = { A: null, B: null };
    let readmitted = 0;
    const polls = [];
    const deadline = t0 + (cacheS * 1000 + REVOKE_EXTRA_MS);
    let extraRound = false;
    for (;;) {
        const roundStart = Date.now();
        const round = await Promise.all(
            LABELS.map(async (label) => ({ label, outcome: await ctx.call("revoke", label, "whoami", {}) }))
        );
        const at = (Date.now() - t0) / 1000;
        for (const { label, outcome } of round) {
            polls.push({ adapter: label, atS: round1(at), ok: outcome.ok, ms: round1(outcome.durationMs) });
            if (!outcome.ok) {
                if (first[label] === null) {
                    first[label] = round1(at);
                }
            } else if (first[label] !== null) {
                readmitted += 1;
            }
        }
        if (first.A !== null && first.B !== null) {
            if (extraRound) {
                break;
            }
            extraRound = true;
        }
        if (Date.now() >= deadline) {
            break;
        }
        await sleep(Math.max(0, REVOKE_POLL_MS - (Date.now() - roundStart)));
    }
    const limit = cacheS + REVOKE_SLACK_S;
    const refusedInTime = [first.A, first.B].every((s) => s !== null && s <= limit);
    const pass = refusedInTime && readmitted === 0;
    const when = (s) => (s === null ? "never refused" : `refused after ${s} s`);
    const summary = `A ${when(first.A)}, B ${when(first.B)} (limit ${limit} s); admitted again: ${readmitted}`;
    return {
        pass,
        details: {
            summary,
            deleted,
            t0: new Date(t0).toISOString(),
            firstRefusalS: first,
            limitS: limit,
            admittedAfterRefusal: readmitted,
            before,
            polls,
        },
    };
}

/**
 * The cases, in run order. missing() names the input a case lacks; steps are its plan lines.
 */
const CASES = [
    {
        name: "storage-alternation",
        missing: () => undefined,
        steps: [
            "reset: execute_code on A sets storage.r2counter to 0",
            `then ${ALTERNATION_CALLS} execute_code calls: call i on A when i is even, on B when odd (i from 0)`,
            `pass when the values returned are 1 to ${ALTERNATION_CALLS} in order`,
        ],
        run: runStorageAlternation,
    },
    {
        name: "rate-limit-shared",
        missing: () => undefined,
        steps: [
            `wait ${REFILL_WAIT_MS / 1000} s, then read /metrics of both adapters`,
            `burst: ${BURST_PER_ADAPTER} whoami through A and ${BURST_PER_ADAPTER} through B at once; ` +
                `pass when admitted <= ${BURST_LIMIT}, refused >= ${MIN_REFUSED}, refusals from both adapters`,
            `sustained: ${SUSTAINED_PER_SECOND} whoami per second for ${SUSTAINED_SECONDS} s, alternating A and B; ` +
                `pass when admitted <= ${SUSTAINED_LIMIT}`,
            "read /metrics again and report the whoami ok and error deltas per adapter",
        ],
        run: runRateLimitShared,
    },
    {
        name: "storage-isolation",
        missing: (opts) => (opts.tokenFile2 ? undefined : "needs --token-file-2"),
        steps: [
            "token 1 via A writes a random secret into storage",
            "token 2 via B and via A reads storage and must get null both times",
            "token 1 via B must read the secret back",
        ],
        run: runStorageIsolation,
    },
    {
        name: "render-isolation",
        missing: (opts) => (opts.outsiderTokenFile ? undefined : "needs --outsider-token-file"),
        steps: [
            "token 1 exports the page via A with export_shape (must succeed; caches its render session)",
            "the outsider runs export_shape via A and B, and get_file_outline via A and B (all must fail)",
        ],
        run: runRenderIsolation,
    },
    {
        name: "revocation",
        missing: (opts) =>
            opts.revokeTokenFile && opts.revokeTokenId ? undefined : "needs --revoke-token-file and --revoke-token-id",
        steps: [
            "whoami with the revoke token on both adapters (must be ok)",
            "delete the access_token row with docker exec and psql (delete count must be 1)",
            `poll whoami every ${REVOKE_POLL_MS / 1000} s on both adapters; pass when both refuse within ` +
                `cache-s + ${REVOKE_SLACK_S} s and no call is admitted after a refusal`,
        ],
        run: runRevocation,
    },
];

/**
 * Prints the plan: the options, each case with RUN or SKIP, and its steps. Sends nothing and reads no file.
 *
 * @param opts - parsed options
 * @param selected - the cases to run, in order
 */
function printPlan(opts, selected) {
    const count = `${selected.length} of ${CASES.length} case(s)`;
    console.log(`Plan: shared-state check, ${count}, token cache ${opts.cacheS} s`);
    const metrics = resolveMetrics(opts);
    console.log(`Adapter A: ${opts.urlA} (metrics ${metrics.metricsA})`);
    console.log(`Adapter B: ${opts.urlB} (metrics ${metrics.metricsB})`);
    console.log(`Main token file: ${opts.tokenFile}; vars file: ${opts.varsFile}`);
    selected.forEach((spec, index) => {
        const reason = spec.missing(opts);
        console.log(`${index + 1}. ${spec.name}: ${reason === undefined ? "RUN" : `SKIP (${reason})`}`);
        for (const step of spec.steps) {
            console.log(`     ${step}`);
        }
    });
    console.log("Dry run: nothing was opened, sent or read.");
}

/**
 * Prints one line for a finished case.
 *
 * @param record - case record with name, pass and details.summary
 */
function printLine(record) {
    const tag = record.pass === true ? "PASS" : record.pass === false ? "FAIL" : "SKIP";
    console.log(`${tag} ${record.name}: ${record.details.summary}`);
}

/**
 * Runs one case. A missing input skips it; a thrown error fails it and the run goes on.
 *
 * @param spec - the case
 * @param ctx - run context
 * @returns the case record: name, pass (true, false or null for skipped) and details
 */
async function runCase(spec, ctx) {
    const reason = spec.missing(ctx.opts);
    if (reason !== undefined) {
        return { name: spec.name, pass: null, details: { summary: `skipped: ${reason}` } };
    }
    try {
        const outcome = await spec.run(ctx);
        return { name: spec.name, pass: outcome.pass, details: outcome.details };
    } catch (error) {
        const message = cut(messageOf(error));
        return { name: spec.name, pass: false, details: { summary: `threw: ${message}`, error: message } };
    }
}

/**
 * Options of the run as they go into the result: paths and URLs only.
 *
 * @param opts - parsed options
 * @param vars - the vars file content
 * @param selected - the cases to run
 */
function resultOptions(opts, vars, selected) {
    return {
        urlA: opts.urlA,
        urlB: opts.urlB,
        metricsA: opts.metricsA,
        metricsB: opts.metricsB,
        tokenFile: opts.tokenFile,
        tokenFile2: opts.tokenFile2,
        outsiderTokenFile: opts.outsiderTokenFile,
        revokeTokenFile: opts.revokeTokenFile,
        revokeTokenId: opts.revokeTokenId,
        varsFile: opts.varsFile,
        fileId: vars.fileId,
        pageId: vars.pageId,
        cacheS: opts.cacheS,
        only: opts.only,
        cases: selected.map((spec) => spec.name),
        out: opts.out,
    };
}

/**
 * Entry point. Returns the exit code: 0 when no selected case fails, 1 when one fails, 2 for a usage error.
 *
 * @param argv - arguments after the script name
 */
export async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (error) {
        console.error(error.message);
        console.error(USAGE);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }
    const selected = CASES.filter((spec) => opts.only === undefined || opts.only.includes(spec.name));
    if (opts.dryRun) {
        printPlan(opts, selected);
        return 0;
    }
    try {
        checkUrls(opts);
    } catch (error) {
        console.error(error.message);
        console.error(USAGE);
        return 2;
    }
    Object.assign(opts, resolveMetrics(opts));
    let vars;
    try {
        vars = JSON.parse(readFileSync(opts.varsFile, "utf8"));
    } catch (error) {
        console.error(`cannot read the vars file: ${messageOf(error)}`);
        return 2;
    }
    if (typeof vars.fileId !== "string" || typeof vars.pageId !== "string") {
        console.error("the vars file needs string fileId and pageId");
        return 2;
    }
    const startedAt = new Date().toISOString();
    const { McpLoadClient } = await import("../../dist/McpLoadClient.js");
    const ctx = new RunContext(opts, { fileId: vars.fileId, pageId: vars.pageId }, McpLoadClient);
    const records = [];
    try {
        for (const spec of selected) {
            const record = await runCase(spec, ctx);
            printLine(record);
            records.push(record);
        }
    } finally {
        await ctx.closeAll();
    }
    const failed = records.filter((record) => record.pass === false).length;
    const skipped = records.filter((record) => record.pass === null).length;
    const passed = records.length - failed - skipped;
    const result = {
        options: resultOptions(opts, vars, selected),
        startedAt,
        endedAt: new Date().toISOString(),
        summary: { passed, failed, skipped },
        cases: records,
    };
    console.log(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped, of ${records.length} selected`);
    if (opts.out) {
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, JSON.stringify(result, null, 2) + "\n", "utf8");
        console.log(`Full result written to ${opts.out}`);
    }
    return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`shared-state failed: ${messageOf(error)}`);
            process.exitCode = 1;
        }
    );
}
