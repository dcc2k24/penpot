// Cross-adapter write check: two adapters, one token, writes interleaved on one file.
//
// Sequence i goes to adapter A when i is even and to adapter B when i is odd. Each write creates one rectangle
// named "xa-seq-" plus the sequence number (4 digits). The lanes run at the same time, so the two adapters' writes
// overlap. A shared timer pacer caps the overall send rate. After the writes, one find_shapes read checks that every
// name is on the page, the revn values rise strictly, and how many writes met mcp-file-busy.
//
// Usage: node scripts/round2/cross-adapter-writes.mjs --help
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const NAME_PREFIX = "xa-seq-";
const NAME_REGEX = "^xa-seq-";
// The find_shapes limit maximum (1 to 1000) in the server tool. 200 writes fit in one read.
const FIND_SHAPES_LIMIT = 1000;
const MAX_WRITES = 9999;
const LABELS = ["A", "B"];
const BUSY_PATTERN = /mcp-file-busy/;

const USAGE = `Usage: node scripts/round2/cross-adapter-writes.mjs --url-a <url> --url-b <url> --token-file <file> --vars <file> [options]

Required:
  --url-a <url>        MCP endpoint of adapter A, for example http://localhost:4401/mcp
  --url-b <url>        MCP endpoint of adapter B
  --token-file <file>  file holding the MCP token (read, never printed)
  --vars <file>        JSON file with fileId and pageId

Options:
  --writes <n>         number of writes, 1 to ${MAX_WRITES} (default 200)
  --per-second <n>     overall send rate across both lanes (default 10)
  --lanes <n>          1 uses adapter A only, 2 uses both adapters (default 2)
  --dry-run            print the plan and send nothing
  --out <file>         write the full result as JSON (no token in it)
  --help               print this text

Use a page with no xa-seq- shapes in it, or the presence check counts the old ones.`;

/**
 * Nearest-rank percentile, the same method as src/Statistics.ts. Takes unsorted values and sorts a copy.
 * Differs from Statistics.ts in one way: an empty list gives null, not 0, so an empty lane is not read as fast.
 *
 * @param values - sample durations in any order
 * @param percent - percentile from 0 to 100
 * @returns the nearest-rank value, or null when there are no samples
 */
export function percentile(values, percent) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((percent / 100) * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[index];
}

/**
 * Name of the rectangle written for one sequence number.
 *
 * @param seq - sequence number, from 0
 */
export function nameFor(seq) {
    return `${NAME_PREFIX}${String(seq).padStart(4, "0")}`;
}

/**
 * Tells whether an error text or code is the file-lock conflict mcp-file-busy.
 *
 * @param text - error text or code
 */
export function isBusyError(text) {
    return BUSY_PATTERN.test(String(text ?? ""));
}

/**
 * Checks that the revn values of the successful writes rise strictly when sorted by revn.
 *
 * @param entries - objects with seq and revn, one per successful write that returned a revn
 * @returns strictlyIncreasing (false on any repeat or drop), duplicates (revn values seen more than once), and
 *   seqOrderMatches (informational: whether the sequence order is the same as the revn order)
 */
export function checkRevnOrder(entries) {
    const sorted = [...entries].sort((a, b) => a.revn - b.revn || a.seq - b.seq);
    let strictlyIncreasing = true;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].revn <= sorted[i - 1].revn) {
            strictlyIncreasing = false;
        }
    }
    const counts = new Map();
    for (const entry of sorted) {
        counts.set(entry.revn, (counts.get(entry.revn) ?? 0) + 1);
    }
    const duplicates = [...counts]
        .filter(([, count]) => count > 1)
        .map(([revn]) => revn)
        .sort((a, b) => a - b);
    const seqOrderMatches = sorted.every((entry, i) => i === 0 || sorted[i - 1].seq < entry.seq);
    return { strictlyIncreasing, duplicates, seqOrderMatches, count: entries.length };
}

/**
 * Checks which expected names are on the page.
 *
 * @param names - names read back from the page, in any order
 * @param expectedCount - how many writes were expected; names are nameFor(0) to nameFor(expectedCount - 1)
 * @returns present (expected names found, once each), missing (expected names not found), duplicated (any name
 *   seen more than once) and unexpected (distinct names outside the expected set)
 */
export function checkPresence(names, expectedCount) {
    const expected = [];
    for (let i = 0; i < expectedCount; i++) {
        expected.push(nameFor(i));
    }
    const expectedSet = new Set(expected);
    const counts = new Map();
    for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const missing = expected.filter((name) => !counts.has(name));
    const duplicated = [...counts]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
        .sort();
    const unexpected = [...counts.keys()].filter((name) => !expectedSet.has(name)).sort();
    return { present: expected.length - missing.length, missing, duplicated, unexpected };
}

/**
 * Plans which adapter gets which sequence number. Sequence i goes to labels[i % labels.length].
 *
 * @param count - number of writes
 * @param labels - adapter labels, in lane order
 * @returns one entry per write: seq, label and the rectangle name
 */
export function planSequence(count, labels) {
    const plan = [];
    for (let seq = 0; seq < count; seq++) {
        plan.push({ seq, label: labels[seq % labels.length], name: nameFor(seq) });
    }
    return plan;
}

/**
 * Summarizes the writes of one lane. Latency figures use only the successful writes.
 *
 * @param entries - write records of one lane: label, ok, busy, error and durationMs
 * @returns counts, the mcp-file-busy count, the other errors grouped by text, and p50 and p95 in milliseconds
 */
export function summarizeLane(entries) {
    const okDurations = entries.filter((e) => e.ok).map((e) => e.durationMs);
    const busy = entries.filter((e) => !e.ok && e.busy).length;
    const others = new Map();
    for (const entry of entries) {
        if (!entry.ok && !entry.busy) {
            const key = entry.error ?? "unknown error";
            others.set(key, (others.get(key) ?? 0) + 1);
        }
    }
    const otherErrors = [...others].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
    return {
        label: entries[0]?.label,
        total: entries.length,
        ok: okDurations.length,
        busy,
        other: otherErrors.reduce((sum, item) => sum + item.count, 0),
        otherErrors,
        p50: percentile(okDurations, 50),
        p95: percentile(okDurations, 95),
    };
}

/**
 * Makes a pacer that gives each call the next free send slot, so all lanes share one rate.
 *
 * @param perSecond - overall send rate
 * @param now - clock in milliseconds (injected for tests)
 * @param sleep - waits the given milliseconds (injected for tests)
 * @returns an async function; await it before each send
 */
export function createPacer(perSecond, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const interval = 1000 / perSecond;
    let nextAt = 0;
    return async function pace() {
        const slot = Math.max(now(), nextAt);
        nextAt = slot + interval;
        const wait = slot - now();
        if (wait > 0) {
            await sleep(wait);
        }
    };
}

/**
 * Reads the command line. Throws on a bad or missing option.
 *
 * @param argv - arguments after the script name
 */
export function parseArgs(argv) {
    const opts = {
        urlA: undefined,
        urlB: undefined,
        tokenFile: undefined,
        varsFile: undefined,
        writes: 200,
        perSecond: 10,
        lanes: 2,
        dryRun: false,
        out: undefined,
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
            case "--token-file":
                opts.tokenFile = value();
                break;
            case "--vars":
                opts.varsFile = value();
                break;
            case "--out":
                opts.out = value();
                break;
            case "--writes":
                opts.writes = integer(value(), arg, 1, MAX_WRITES);
                break;
            case "--per-second": {
                const text = value();
                const rate = Number(text);
                if (!Number.isFinite(rate) || rate <= 0) {
                    throw new Error(`--per-second must be a positive number, got "${text}"`);
                }
                opts.perSecond = rate;
                break;
            }
            case "--lanes":
                opts.lanes = integer(value(), arg, 1, 2);
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
 * Prints the plan: lanes, sequence numbers and pacing. Sends nothing.
 *
 * @param opts - parsed options
 * @param plan - output of planSequence
 * @param labels - lane labels in use
 */
function printPlan(opts, plan, labels) {
    const urls = { A: opts.urlA, B: opts.urlB };
    const interval = Math.round(1000 / opts.perSecond);
    console.log(`Plan: ${opts.writes} writes, ${labels.length} lane(s), ${opts.perSecond} per second overall`);
    console.log(`Pacing: one send every ${interval} ms, shared by all lanes`);
    for (const label of labels) {
        const mine = plan.filter((p) => p.label === label);
        const shown = mine
            .slice(0, 4)
            .map((p) => p.seq)
            .join(", ");
        console.log(`Lane ${label} (${urls[label]}): ${mine.length} writes, sequence ${shown}, ...`);
        console.log(`  first name ${mine[0]?.name ?? "none"}, last name ${mine[mine.length - 1]?.name ?? "none"}`);
    }
    const minMs = Math.max(0, opts.writes - 1) * interval;
    console.log(`Send phase takes at least ${(minMs / 1000).toFixed(1)} s at this rate`);
    console.log(`Then one find_shapes read: nameRegex ${NAME_REGEX}, limit ${FIND_SHAPES_LIMIT}`);
    console.log("Dry run: nothing was sent.");
}

/**
 * Runs one lane: sends its writes one after another, each after the shared pacer gives a slot.
 *
 * @param label - adapter label
 * @param client - connected McpLoadClient for this adapter
 * @param writes - the plan entries of this lane, in sequence order
 * @param ctx - fileId, pageId and pace function
 * @returns one record per write
 */
async function runLane(label, client, writes, ctx) {
    const records = [];
    for (const write of writes) {
        await ctx.pace();
        const outcome = await client.callTool("apply_operations", {
            fileId: ctx.fileId,
            operations: [
                {
                    op: "create_rect",
                    pageId: ctx.pageId,
                    name: write.name,
                    x: write.seq,
                    y: 0,
                    width: 10,
                    height: 10,
                },
            ],
        });
        const revn = typeof outcome.json?.revn === "number" ? outcome.json.revn : undefined;
        const error = outcome.ok ? undefined : collapse(outcome.error ?? outcome.text ?? "unknown error");
        records.push({
            seq: write.seq,
            label,
            name: write.name,
            ok: outcome.ok,
            busy: !outcome.ok && isBusyError(outcome.error ?? outcome.text),
            error,
            durationMs: outcome.durationMs,
            revn,
        });
    }
    return records;
}

/**
 * Joins whitespace and cuts a text to 300 characters.
 *
 * @param text - any text
 */
function collapse(text) {
    return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Runs the whole check: writes, read back, and the three checks. Returns the result object.
 *
 * @param opts - parsed options
 * @param labels - lane labels in use
 * @param token - MCP token
 * @param ids - fileId and pageId
 */
async function runCheck(opts, labels, token, ids) {
    const { McpLoadClient } = await import("../../dist/McpLoadClient.js");
    const urls = { A: opts.urlA, B: opts.urlB };
    const clients = {};
    try {
        for (const label of labels) {
            clients[label] = new McpLoadClient();
            await clients[label].connect(urls[label], token);
        }
        const plan = planSequence(opts.writes, labels);
        const pace = createPacer(opts.perSecond);
        const ctx = { fileId: ids.fileId, pageId: ids.pageId, pace };
        const laneResults = await Promise.all(
            labels.map((label) =>
                runLane(
                    label,
                    clients[label],
                    plan.filter((p) => p.label === label),
                    ctx
                )
            )
        );
        const writes = laneResults.flat().sort((a, b) => a.seq - b.seq);

        const read = await clients[labels[0]].callTool("find_shapes", {
            fileId: ids.fileId,
            pageId: ids.pageId,
            nameRegex: NAME_REGEX,
            limit: FIND_SHAPES_LIMIT,
        });
        let presence = { present: 0, missing: [], duplicated: [], unexpected: [] };
        let truncated = false;
        let readError;
        if (read.ok) {
            const names = (read.json?.matches ?? []).map((m) => m.name);
            truncated = read.json?.truncated === true;
            presence = checkPresence(names, opts.writes);
        } else {
            readError = collapse(read.error ?? read.text ?? "read failed");
        }

        const successful = writes.filter((w) => w.ok);
        const withRevn = successful.filter((w) => w.revn !== undefined).map((w) => ({ seq: w.seq, revn: w.revn }));
        const revn = checkRevnOrder(withRevn);
        const revnMissing = successful.length - withRevn.length;

        const lanes = {};
        for (const label of labels) {
            lanes[label] = summarizeLane(writes.filter((w) => w.label === label));
        }
        const busy = writes.filter((w) => !w.ok && w.busy).length;
        const others = writes.filter((w) => !w.ok && !w.busy);
        const otherGroups = summarizeLane(others.map((w) => ({ ...w, ok: false, busy: false }))).otherErrors;

        const failures = [];
        if (readError) {
            failures.push(`read failed: ${readError}`);
        }
        if (truncated) {
            failures.push(`find_shapes answer was truncated at limit ${FIND_SHAPES_LIMIT}`);
        }
        if (presence.present !== opts.writes) {
            failures.push(`present ${presence.present} of ${opts.writes}`);
        }
        if (!revn.strictlyIncreasing) {
            failures.push("revn values are not strictly increasing");
        }
        if (revnMissing > 0) {
            failures.push(`${revnMissing} successful writes had no revn`);
        }
        if (others.length > 0) {
            failures.push(`${others.length} writes failed for a reason other than mcp-file-busy`);
        }
        return {
            options: {
                writes: opts.writes,
                perSecond: opts.perSecond,
                lanes: opts.lanes,
                urls: Object.fromEntries(labels.map((l) => [l, urls[l]])),
                findShapesLimit: FIND_SHAPES_LIMIT,
            },
            writes,
            read: { ok: read.ok, error: readError, truncated, ...presence },
            revn: { ...revn, missingOnSuccess: revnMissing },
            busy,
            otherErrors: otherGroups,
            lanes,
            passed: failures.length === 0,
            failures,
        };
    } finally {
        for (const label of labels) {
            try {
                await clients[label]?.close();
            } catch {
                // closing is best effort; the result is already known
            }
        }
    }
}

/**
 * Prints the summary lines.
 *
 * @param result - output of runCheck
 */
function printSummary(result) {
    const r = result.read;
    console.log(`Writes sent: ${result.writes.length} of ${result.options.writes}`);
    console.log(
        `Present: ${r.present}/${result.options.writes} (missing ${r.missing.length}, duplicated ${r.duplicated.length}, unexpected ${r.unexpected.length})`
    );
    console.log(
        `Revn strictly increasing: ${result.revn.strictlyIncreasing ? "yes" : "no"} (${result.revn.count} values, duplicates ${result.revn.duplicates.length}; sequence order matches revn order: ${result.revn.seqOrderMatches ? "yes" : "no, informational"})`
    );
    console.log(`mcp-file-busy errors: ${result.busy}`);
    if (result.otherErrors.length === 0) {
        console.log("Other errors: none");
    } else {
        console.log("Other errors:");
        for (const item of result.otherErrors) {
            console.log(`  ${item.count} x ${item.text}`);
        }
    }
    for (const label of Object.keys(result.lanes)) {
        const lane = result.lanes[label];
        const fmt = (v) => (v === null ? "n/a" : `${v.toFixed(1)} ms`);
        console.log(
            `Adapter ${label}: writes ${lane.total}, ok ${lane.ok}, busy ${lane.busy}, other ${lane.other}, p50 ${fmt(lane.p50)}, p95 ${fmt(lane.p95)}`
        );
    }
    console.log(result.passed ? "RESULT: PASS" : `RESULT: FAIL (${result.failures.join("; ")})`);
}

/**
 * Entry point. Returns the exit code.
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
    const labels = LABELS.slice(0, opts.lanes);
    if (opts.dryRun) {
        printPlan(opts, planSequence(opts.writes, labels), labels);
        return 0;
    }
    const token = readFileSync(opts.tokenFile, "utf8").trim();
    const vars = JSON.parse(readFileSync(opts.varsFile, "utf8"));
    if (typeof vars.fileId !== "string" || typeof vars.pageId !== "string") {
        console.error("the vars file needs string fileId and pageId");
        return 2;
    }
    const result = await runCheck(opts, labels, token, { fileId: vars.fileId, pageId: vars.pageId });
    printSummary(result);
    if (opts.out) {
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, JSON.stringify(result, null, 2) + "\n", "utf8");
        console.log(`Full result written to ${opts.out}`);
    }
    return result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`cross-adapter-writes failed: ${error.message}`);
            process.exitCode = 1;
        }
    );
}
