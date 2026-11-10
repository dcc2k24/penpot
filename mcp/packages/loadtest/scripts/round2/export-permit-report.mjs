// Turns the files of export-permit-watch.mjs and the adapter console logs into one report.
//
// Usage (from any directory):
//   node scripts/round2/export-permit-report.mjs --dir <dir> [--adapter-log <name>=<path>]...
//                                               [--from <ISO>] [--to <ISO>] [--lease-ms <n>] [--cap <n>]
//                                               [--key <key>] [--tool <name>]
//   node scripts/round2/export-permit-report.mjs --help
//
// Writes <dir>/permit-report.json and <dir>/permit-report.txt, and prints the text.
//
// The permit waits (monitor.waitDistribution) run from the first attempt of a member to its take. They are only
// meaningful for adapters that keep one member id per caller across its polls. An adapter that uses a fresh id per
// attempt gives a wait of 0 for every take, and attempts count one granted per take.

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_KEY = "penpot.mcp.export.permits";
export const DEFAULT_TOOL = "export_shape";
const DEFAULT_LEASE_MS = 65000;
const DEFAULT_CAP = 4;
// The MONITOR stamp of a ZADD is a few milliseconds later than the TIME the Lua script read, so a lease reads short.
const LEASE_TOLERANCE_MS = 5;
const LONG_HOLD_MS = 30000;
const VERY_LONG_HOLD_MS = 60000;
const BYTES_PER_MB = 1048576;
const MAX_DISTINCT_TEXTS = 10;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ADAPTER_HEADER = /^(INFO|ERROR|WARN|DEBUG|TRACE|FATAL)\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/;
const ADAPTER_FAILURE =
    /^(INFO|ERROR|WARN)\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\].*?Tool execution #\d+ (refused|failed): (\w+) request=\S+; (reason|error): (.*)$/;
const ADAPTER_FIELD = /^\s+([A-Za-z]\w*):\s*(.*)$/;

const USAGE = `Turns the files of export-permit-watch.mjs and the adapter console logs into a report.

Usage:
  node scripts/round2/export-permit-report.mjs --dir <dir> [options]
  node scripts/round2/export-permit-report.mjs --help

Options:
  --dir <dir>                folder with permit-samples.jsonl, permit-monitor.log and adapter-metrics.jsonl (required)
  --adapter-log <name>=<path>  adapter console log, repeatable, for example 4406=logs/adapter-4406.log
  --from <ISO>               only events, samples, scrapes and tool calls at or after this time
  --to <ISO>                 only events, samples, scrapes and tool calls at or before this time
  --lease-ms <n>             lease of a permit in ms, a whole number (default ${DEFAULT_LEASE_MS})
  --cap <n>                  permits at once across the adapters, a whole number of at least 1 (default ${DEFAULT_CAP})
  --key <key>                permit sorted set (default ${DEFAULT_KEY})
  --tool <name>              tool whose calls are summarized from the adapter logs (default ${DEFAULT_TOOL})
  --help                     print this text

Writes <dir>/permit-report.json and <dir>/permit-report.txt, and prints the text.
Percentiles are nearest-rank. Exit codes: 0 done, 1 runtime error, 2 usage error.
`;

/** A problem with the command line. Exit code 2. */
class UsageError extends Error {}

/**
 * Returns the text of an error.
 *
 * @param {unknown} error - any thrown value
 * @returns {string} the message
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
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
function parseCount(value, name, fallback) {
    if (value === undefined) {
        return fallback;
    }
    if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new UsageError(`${name} must be a whole number of at least 1, got "${value}"`);
    }
    return Number(value);
}

/**
 * Parses a time option. It must be a date that Date.parse reads.
 *
 * @param {string|undefined} value - the option value
 * @param {string} name - option name for messages
 * @returns {number|null} epoch milliseconds, or null when the option is absent
 * @throws {UsageError} when the value is not a date
 */
function parseTime(value, name) {
    if (value === undefined) {
        return null;
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
        throw new UsageError(`${name} must be an ISO date, got "${value}"`);
    }
    return ms;
}

/**
 * Parses one --adapter-log value, name=path, split on the first equals sign.
 *
 * @param {string} value - the option value
 * @returns {{name: string, path: string}} the adapter name and the log path
 * @throws {UsageError} when the value has no name or no path
 */
function parseAdapterLogArg(value) {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) {
        throw new UsageError(`--adapter-log must be <name>=<path>, got "${value}"`);
    }
    return { name: value.slice(0, index), path: value.slice(index + 1) };
}

/**
 * Parses the command line.
 *
 * @param {string[]} argv - arguments after the script name
 * @returns {object} the options, with help set when --help was given
 * @throws {UsageError} on unknown options or bad values
 */
function readOptions(argv) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            strict: true,
            allowPositionals: false,
            options: {
                dir: { type: "string" },
                "adapter-log": { type: "string", multiple: true },
                from: { type: "string" },
                to: { type: "string" },
                "lease-ms": { type: "string" },
                cap: { type: "string" },
                key: { type: "string" },
                tool: { type: "string" },
                help: { type: "boolean", short: "h" },
            },
        }));
    } catch (error) {
        throw new UsageError(messageOf(error));
    }
    if (values.help === true) {
        return { help: true };
    }
    if (values.dir === undefined) {
        throw new UsageError("--dir <dir> is required");
    }
    const fromMs = parseTime(values.from, "--from");
    const toMs = parseTime(values.to, "--to");
    if (fromMs !== null && toMs !== null && fromMs > toMs) {
        throw new UsageError("--from must not be later than --to");
    }
    return {
        help: false,
        dir: values.dir,
        adapterLogs: (values["adapter-log"] ?? []).map(parseAdapterLogArg),
        window: { from: fromMs, to: toMs },
        leaseMs: parseCount(values["lease-ms"], "--lease-ms", DEFAULT_LEASE_MS),
        cap: parseCount(values.cap, "--cap", DEFAULT_CAP),
        key: values.key ?? DEFAULT_KEY,
        tool: values.tool ?? DEFAULT_TOOL,
    };
}

/**
 * Computes the nearest-rank percentile of a sorted list: the value at index ceil(p * n) - 1, minimum index 0.
 *
 * @param {number[]} sortedValues - numbers sorted in ascending order
 * @param {number} p - the fraction, from 0 to 1
 * @returns {number|null} the value, or null for an empty list
 */
export function percentile(sortedValues, p) {
    const n = sortedValues.length;
    if (n === 0) {
        return null;
    }
    const index = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return sortedValues[index];
}

/**
 * Summarizes numbers: count, min, nearest-rank p50 and p95, and max. Non-numbers are left out.
 *
 * @param {unknown[]} values - the values
 * @returns {{count: number, min: number|null, p50: number|null, p95: number|null, max: number|null}} the figures
 */
export function distribution(values) {
    const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
    return {
        count: sorted.length,
        min: sorted.length === 0 ? null : sorted[0],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.length === 0 ? null : sorted[sorted.length - 1],
    };
}

/**
 * Reads the Redis MONITOR log of the watcher. Only lines that name the key are used, for the takes, the releases,
 * the attempts and the first and last times. Other lines are not counted in the first and last times either.
 *
 * A take is a ZADD on the key (score = expiry in ms, member). A release is a ZREM on the key. An attempt is an
 * EVAL or EVALSHA whose KEYS include the key. The arguments are [command, sha, numkeys, ...keys, ...argv], so the
 * member is the first ARGV, at index 3 + numkeys. The take script also gets the waiter keys, so the member is not
 * the argument after the key. The one-key script of older adapters fits the same layout.
 *
 * @param {string} text - the log text, one tab separated line per event
 * @param {string} key - the permit key
 * @returns {{takes: Array<{member: string, atMs: number, expiresAtMs: number}>, releases: Array<{member: string,
 *   atMs: number}>, attempts: Array<{member: string, atMs: number}>, firstMs: number|null, lastMs: number|null,
 *   skipped: number}} the parsed events; skipped counts the broken lines
 */
export function parseMonitorLog(text, key) {
    const takes = [];
    const releases = [];
    const attempts = [];
    let skipped = 0;
    let firstMs = null;
    let lastMs = null;
    for (const raw of String(text).split(/\r?\n/)) {
        if (raw.trim() === "") {
            continue;
        }
        const fields = raw.split("\t");
        if (fields.length < 4) {
            skipped++;
            continue;
        }
        const time = Number(fields[0]);
        if (!Number.isFinite(time)) {
            skipped++;
            continue;
        }
        let args;
        try {
            args = JSON.parse(fields.slice(3).join("\t"));
        } catch {
            skipped++;
            continue;
        }
        if (!Array.isArray(args) || args.length === 0 || !args.includes(key)) {
            continue;
        }
        const atMs = Math.round(time * 1000);
        firstMs = firstMs === null ? atMs : Math.min(firstMs, atMs);
        lastMs = lastMs === null ? atMs : Math.max(lastMs, atMs);
        const command = String(args[0]).toLowerCase();
        if (command === "zadd" && args[1] === key) {
            takes.push({ member: String(args[3]), atMs, expiresAtMs: Number(args[2]) });
        } else if (command === "zrem" && args[1] === key) {
            releases.push({ member: String(args[2]), atMs });
        } else if (command === "evalsha" || command === "eval") {
            const numKeys = Number(args[2]);
            if (!Number.isInteger(numKeys) || numKeys < 1 || 3 + numKeys >= args.length) {
                continue;
            }
            if (args.slice(3, 3 + numKeys).includes(key)) {
                attempts.push({ member: String(args[3 + numKeys]), atMs });
            }
        }
    }
    return { takes, releases, attempts, firstMs, lastMs, skipped };
}

/**
 * Keeps the events inside a time window. The first and last times are clipped to the window.
 *
 * @param {ReturnType<typeof parseMonitorLog>} parsed - the parsed log
 * @param {{from: number|null, to: number|null}} window - epoch milliseconds, null when open
 * @returns {ReturnType<typeof parseMonitorLog>} the events inside the window
 */
export function applyWindow(parsed, window) {
    const inside = (atMs) => (window.from === null || atMs >= window.from) && (window.to === null || atMs <= window.to);
    return {
        ...parsed,
        takes: parsed.takes.filter((take) => inside(take.atMs)),
        releases: parsed.releases.filter((release) => inside(release.atMs)),
        attempts: parsed.attempts.filter((attempt) => inside(attempt.atMs)),
        firstMs:
            parsed.firstMs === null || window.from === null ? parsed.firstMs : Math.max(parsed.firstMs, window.from),
        lastMs: parsed.lastMs === null || window.to === null ? parsed.lastMs : Math.min(parsed.lastMs, window.to),
    };
}

/**
 * Pairs each take with its release and works out the hold of each take.
 *
 * A release belongs to the first take of the same member that was taken at or before it and has no release yet.
 * expiredBeforeRelease is true when the release came after the expiry of the take. A take with no release counts
 * as expired when the recording went on past its expiry, and as held at the end when the recording stopped before
 * its expiry. Such a take is not expired.
 *
 * @param {{takes: Array<{member: string, atMs: number, expiresAtMs: number}>, releases: Array<{member: string,
 *   atMs: number}>, lastMs: number|null}} events - the parsed events
 * @param {number} leaseMs - the configured lease; a take whose lease differs from it by more than LEASE_TOLERANCE_MS
 *   is counted in leaseMismatch
 * @returns {{holds: object[], heldAtEnd: number, exceededLease: number, leaseMismatch: number,
 *   holdDistribution: object, leaseValues: number[]}} one hold record per take, and the counts
 */
export function permitHolds({ takes, releases, lastMs }, leaseMs) {
    const records = [...takes]
        .sort((a, b) => a.atMs - b.atMs)
        .map((take) => ({
            member: take.member,
            takenAtMs: take.atMs,
            expiresAtMs: take.expiresAtMs,
            releasedAtMs: null,
        }));
    for (const release of [...releases].sort((a, b) => a.atMs - b.atMs)) {
        const record = records.find(
            (candidate) =>
                candidate.member === release.member &&
                candidate.releasedAtMs === null &&
                candidate.takenAtMs <= release.atMs
        );
        if (record !== undefined) {
            record.releasedAtMs = release.atMs;
        }
    }
    const holds = records.map((record) => {
        const released = record.releasedAtMs !== null;
        return {
            member: record.member,
            takenAtMs: record.takenAtMs,
            releasedAtMs: record.releasedAtMs,
            holdMs: released ? record.releasedAtMs - record.takenAtMs : null,
            leaseMs: record.expiresAtMs - record.takenAtMs,
            expiredBeforeRelease: released
                ? record.releasedAtMs > record.expiresAtMs
                : lastMs !== null && lastMs > record.expiresAtMs,
        };
    });
    const heldAtEnd = records.filter(
        (record) => record.releasedAtMs === null && lastMs !== null && lastMs <= record.expiresAtMs
    ).length;
    const leaseValues = [...new Set(holds.map((hold) => hold.leaseMs))].sort((a, b) => a - b);
    return {
        holds,
        heldAtEnd,
        exceededLease: holds.filter((hold) => hold.expiredBeforeRelease).length,
        leaseMismatch: holds.filter((hold) => Math.abs(hold.leaseMs - leaseMs) > LEASE_TOLERANCE_MS).length,
        holdDistribution: distribution(holds.filter((hold) => hold.holdMs !== null).map((hold) => hold.holdMs)),
        leaseValues,
    };
}

/**
 * Sweeps the holds over time to find the most permits held at once, and the time spent at each level.
 *
 * A hold starts at its take. It ends at its release, or at its expiry when it was never released; either end is
 * capped at lastMs. At equal times a release is counted before a take. The time is counted from the first take to
 * lastMs.
 *
 * @param {Array<{takenAtMs: number, releasedAtMs: number|null, leaseMs: number}>} holds - holds from permitHolds
 * @param {number|null} lastMs - the last time of the recording
 * @returns {{max: number, msAt: Record<string, number>}} the peak, and the milliseconds at each level (levels with
 *   no time are left out)
 */
export function concurrency(holds, lastMs) {
    if (holds.length === 0) {
        return { max: 0, msAt: {} };
    }
    const events = [];
    for (const hold of holds) {
        let end = hold.releasedAtMs ?? hold.takenAtMs + hold.leaseMs;
        if (lastMs !== null) {
            end = Math.min(end, lastMs);
        }
        end = Math.max(end, hold.takenAtMs);
        events.push({ t: hold.takenAtMs, delta: 1 }, { t: end, delta: -1 });
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta);
    const msAt = {};
    let level = 0;
    let max = 0;
    let previous = events[0].t;
    for (const event of events) {
        if (event.t > previous) {
            msAt[level] = (msAt[level] ?? 0) + (event.t - previous);
            previous = event.t;
        }
        level += event.delta;
        max = Math.max(max, level);
    }
    if (lastMs !== null && lastMs > previous) {
        msAt[level] = (msAt[level] ?? 0) + (lastMs - previous);
    }
    return { max, msAt };
}

/**
 * Counts the attempts that got a permit. A caller keeps one member id across its polls, so a member that was
 * taken counts as ONE granted attempt, however many attempts it made. granted is the number of distinct taken
 * members that appear in the attempts, and refusedPolls is the other attempts. An adapter that uses a fresh member
 * id for each attempt gives one granted attempt per take, as before.
 *
 * @param {{takes: Array<{member: string}>, attempts: Array<{member: string}>}} parsed - the parsed log
 * @returns {{attempts: number, granted: number, refusedPolls: number}} the counts
 */
export function attemptStats(parsed) {
    const taken = new Set(parsed.takes.map((take) => take.member));
    const grantedMembers = new Set(
        parsed.attempts.map((attempt) => attempt.member).filter((member) => taken.has(member))
    );
    const granted = grantedMembers.size;
    return { attempts: parsed.attempts.length, granted, refusedPolls: parsed.attempts.length - granted };
}

/**
 * Gives the wait for the shared permit of each take, in the order of the takes. The wait runs from the first
 * attempt of the member to its take, in milliseconds. It is 0 when the first attempt is the take, or when the
 * member has no attempt in the log. The wait is only meaningful for adapters that keep one member id per caller:
 * an adapter that uses a fresh id per attempt gives 0 for every take.
 *
 * @param {{takes: Array<{member: string, atMs: number}>, attempts: Array<{member: string, atMs: number}>}} parsed - the parsed log
 * @returns {number[]} one wait per take, in milliseconds
 */
export function permitWaits(parsed) {
    const firstAttempt = new Map();
    for (const attempt of parsed.attempts) {
        const known = firstAttempt.get(attempt.member);
        if (known === undefined || attempt.atMs < known) {
            firstAttempt.set(attempt.member, attempt.atMs);
        }
    }
    return parsed.takes.map((take) => {
        const first = firstAttempt.get(take.member);
        return first === undefined ? 0 : Math.max(0, take.atMs - first);
    });
}

/**
 * Adds one value to a histogram keyed by integer strings.
 *
 * @param {Record<string, number>} histogram - the histogram to change
 * @param {number} value - the value to count
 */
function countInto(histogram, value) {
    const key = String(value);
    histogram[key] = (histogram[key] ?? 0) + 1;
}

/**
 * Summarizes the parsed permit samples. Error lines are counted apart and left out of the rest.
 *
 * @param {unknown[]} lines - the parsed objects of permit-samples.jsonl
 * @param {number} cap - the permits allowed at once
 * @returns {object} the counts, the histograms and the peaks
 */
export function summarizeSamples(lines, cap) {
    const samples = [];
    let errors = 0;
    for (const line of lines) {
        if (line === null || typeof line !== "object") {
            continue;
        }
        if ("error" in line) {
            errors++;
        } else if (Array.isArray(line.members)) {
            samples.push(line);
        }
    }
    const zcardHistogram = {};
    const liveHistogram = {};
    let aboveCap = 0;
    let withExpiredMember = 0;
    for (const sample of samples) {
        countInto(zcardHistogram, sample.zcard);
        countInto(liveHistogram, sample.live);
        if (sample.zcard > cap) {
            aboveCap++;
        }
        if (sample.members.some(([, score]) => score <= sample.redisMs)) {
            withExpiredMember++;
        }
    }
    const times = samples.map((sample) => sample.t).sort();
    return {
        samples: samples.length,
        errors,
        firstT: times[0] ?? null,
        lastT: times[times.length - 1] ?? null,
        zcardHistogram,
        liveHistogram,
        maxZcard: samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.zcard)),
        maxLive: samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.live)),
        aboveCap,
        withExpiredMember,
    };
}

/**
 * Parses the console output of an adapter (pino-pretty, with colour codes).
 *
 * A finished tool call is a "Tool call finished" header followed by indented key: value lines. Only calls with a
 * tool and a durationMs are kept. A refused or failed call is one line; its stack lines are ignored.
 *
 * @param {string} text - the log text
 * @returns {{calls: Array<{at: Date, tool: string, durationMs: number, outcome: string|null}>,
 *   failures: Array<{at: Date, tool: string, kind: string, text: string}>}} the parsed calls and failures
 */
export function parseAdapterLog(text) {
    const calls = [];
    const failures = [];
    const clean = String(text).replace(ANSI_PATTERN, "");
    let open = null;

    const closeOpen = () => {
        if (open === null) {
            return;
        }
        const durationMs = Number(open.fields.durationMs);
        if (
            typeof open.fields.tool === "string" &&
            open.fields.durationMs !== undefined &&
            Number.isFinite(durationMs)
        ) {
            calls.push({
                at: open.at,
                tool: open.fields.tool,
                durationMs,
                outcome: open.fields.outcome ?? null,
            });
        }
        open = null;
    };

    for (const raw of clean.split(/\r?\n/)) {
        if (raw.trim() === "") {
            continue;
        }
        if (/^\s/.test(raw)) {
            const field = ADAPTER_FIELD.exec(raw);
            if (open !== null && field !== null) {
                open.fields[field[1]] = unquote(field[2].trim());
            }
            continue;
        }
        closeOpen();
        const failure = ADAPTER_FAILURE.exec(raw);
        if (failure !== null) {
            failures.push({
                at: stampToDate(failure[2]),
                tool: failure[4],
                kind: failure[3],
                text: failure[6].trim(),
            });
            continue;
        }
        const header = ADAPTER_HEADER.exec(raw);
        if (header !== null && raw.includes("Tool call finished")) {
            open = { at: stampToDate(header[2]), fields: {} };
        }
    }
    closeOpen();
    return { calls, failures };
}

/**
 * Removes one pair of double quotes around a value.
 *
 * @param {string} value - the value text
 * @returns {string} the value without the quotes
 */
function unquote(value) {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Builds a local Date from a log stamp of the form YYYY-MM-DD HH:MM:SS.mmm (the host time).
 *
 * @param {string} stamp - the stamp text
 * @returns {Date} the local time
 */
function stampToDate(stamp) {
    const [, year, month, day, hour, minute, second, millis] =
        /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(stamp);
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millis)
    );
}

/**
 * Joins the parsed logs of several adapters into one.
 *
 * @param {Array<{calls: object[], failures: object[]}>} parsedLogs - parsed logs from parseAdapterLog
 * @returns {{calls: object[], failures: object[]}} all calls and all failures
 */
export function mergeAdapterLogs(parsedLogs) {
    return {
        calls: parsedLogs.flatMap((parsed) => parsed.calls),
        failures: parsedLogs.flatMap((parsed) => parsed.failures),
    };
}

/**
 * Classifies the text of a refused or failed call.
 *
 * @param {string} text - the reason or error text
 * @returns {"busy"|"render-timeout"|"exporter"|"other"} the class; checked in this order
 */
export function classifyFailure(text) {
    const value = String(text ?? "");
    if (/is busy, retry later/i.test(value)) {
        return "busy";
    }
    if (/did not finish within/i.test(value)) {
        return "render-timeout";
    }
    if (/exporter/i.test(value)) {
        return "exporter";
    }
    return "other";
}

/**
 * Reads the number of seconds a busy refusal waited.
 *
 * @param {string} text - the reason text
 * @returns {number|null} the seconds, or null when the text has no wait
 */
export function busyWaitSeconds(text) {
    const match = /no slot was free for (\d+(?:\.\d+)?) seconds/.exec(String(text ?? ""));
    return match === null ? null : Number(match[1]);
}

/**
 * Converts a window bound to epoch milliseconds.
 *
 * @param {Date|number|null|undefined} value - a Date, milliseconds, or null for an open bound
 * @returns {number|null} milliseconds, or null
 */
function boundMs(value) {
    if (value === null || value === undefined) {
        return null;
    }
    return value instanceof Date ? value.getTime() : value;
}

/**
 * Summarizes the calls of one tool and the failures of that tool from a parsed adapter log.
 *
 * @param {{calls: object[], failures: object[]}} parsedLog - from parseAdapterLog or mergeAdapterLogs
 * @param {string} tool - the tool name
 * @param {Date|number|null} from - window start, or null for open
 * @param {Date|number|null} to - window end, or null for open
 * @returns {object} the counts, the duration distributions, the failure classes and sample texts
 */
export function summarizeAdapter(parsedLog, tool, from, to) {
    const window = { from: boundMs(from), to: boundMs(to) };
    const inside = (at) => (window.from === null || at >= window.from) && (window.to === null || at <= window.to);
    const calls = parsedLog.calls.filter((call) => call.tool === tool && inside(call.at.getTime()));
    const failures = parsedLog.failures.filter((failure) => failure.tool === tool && inside(failure.at.getTime()));
    const ok = calls.filter((call) => call.outcome === "ok");
    const failed = calls.filter((call) => call.outcome !== "ok");
    const counts = { busy: 0, "render-timeout": 0, exporter: 0, other: 0 };
    for (const failure of failures) {
        counts[classifyFailure(failure.text)]++;
    }
    const busyWaits = failures.map((failure) => busyWaitSeconds(failure.text));
    const distinctFailureTexts = [...new Set(failures.map((failure) => failure.text))].slice(0, MAX_DISTINCT_TEXTS);
    return {
        calls: calls.length,
        ok: ok.length,
        error: failed.length,
        all: distribution(calls.map((call) => call.durationMs)),
        okOnly: distribution(ok.map((call) => call.durationMs)),
        errorOnly: distribution(failed.map((call) => call.durationMs)),
        atLeast30s: calls.filter((call) => call.durationMs >= LONG_HOLD_MS).length,
        atLeast60s: calls.filter((call) => call.durationMs >= VERY_LONG_HOLD_MS).length,
        failures: counts,
        busyWaitSeconds: distribution(busyWaits),
        distinctFailureTexts,
    };
}

/**
 * Reads the adapter metric entries, one group per adapter URL.
 *
 * A series is the first line of its kind per scrape; the fallback counter adds up all its label variants. A series
 * that no scrape carries is null. fallbackIncrease is the last fallback value minus the first.
 *
 * @param {object[]} entries - parsed lines of adapter-metrics.jsonl
 * @returns {Record<string, object>} one summary per adapter URL
 */
export function summarizeMetrics(entries) {
    const groups = new Map();
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || typeof entry.adapter !== "string") {
            continue;
        }
        if (!groups.has(entry.adapter)) {
            groups.set(entry.adapter, {
                scrapes: 0,
                failedScrapes: 0,
                fallback: [],
                redisUp: [],
                clientUp: [],
                lag: [],
                resident: [],
                sessions: [],
            });
        }
        const group = groups.get(entry.adapter);
        group.scrapes++;
        if (entry.ok !== true) {
            group.failedScrapes++;
            continue;
        }
        const lines = Array.isArray(entry.lines) ? entry.lines : [];
        const fallbackLines = lines.filter((line) => metricName(line) === "penpot_mcp_export_permit_fallback_total");
        if (fallbackLines.length > 0) {
            group.fallback.push(fallbackLines.reduce((sum, line) => sum + metricValue(line), 0));
        }
        pushFirst(group.redisUp, lines, (line) => metricName(line) === "penpot_mcp_redis_up");
        pushFirst(
            group.clientUp,
            lines,
            (line) => metricName(line) === "penpot_mcp_redis_client_up" && line.includes('client="export-permits"')
        );
        pushFirst(group.lag, lines, (line) => metricName(line) === "nodejs_eventloop_lag_p99_seconds");
        pushFirst(group.resident, lines, (line) => metricName(line) === "process_resident_memory_bytes");
        pushFirst(group.sessions, lines, (line) => metricName(line) === "penpot_mcp_render_sessions");
    }
    const summaries = {};
    for (const [url, group] of groups) {
        const fallbackFirst = group.fallback[0] ?? null;
        const fallbackLast = group.fallback.length > 0 ? group.fallback[group.fallback.length - 1] : null;
        summaries[url] = {
            scrapes: group.scrapes,
            failedScrapes: group.failedScrapes,
            fallbackFirst,
            fallbackLast,
            fallbackIncrease: fallbackFirst === null || fallbackLast === null ? null : fallbackLast - fallbackFirst,
            redisUpMin: minOf(group.redisUp),
            exportPermitsClientUpMin: minOf(group.clientUp),
            eventLoopLagP99Max: maxOf(group.lag),
            residentBytesMax: maxOf(group.resident),
            renderSessionsMax: maxOf(group.sessions),
        };
    }
    return summaries;
}

/**
 * Returns the metric name of one line: the text before the labels or the space.
 *
 * @param {string} line - a metric line
 * @returns {string} the name
 */
function metricName(line) {
    return line.split(/[{ ]/)[0];
}

/**
 * Returns the value of one metric line: its last space separated field.
 *
 * @param {string} line - a metric line
 * @returns {number} the value, or NaN
 */
function metricValue(line) {
    return Number(line.slice(line.lastIndexOf(" ") + 1));
}

/**
 * Adds the value of the first line that matches to a series, when a line matches.
 *
 * @param {number[]} series - the series to add to
 * @param {string[]} lines - the metric lines of one scrape
 * @param {(line: string) => boolean} matches - the test of the line
 */
function pushFirst(series, lines, matches) {
    const line = lines.find(matches);
    if (line !== undefined) {
        series.push(metricValue(line));
    }
}

/**
 * Returns the smallest value of a series.
 *
 * @param {number[]} series - the values
 * @returns {number|null} the minimum, or null for an empty series
 */
function minOf(series) {
    return series.length === 0 ? null : Math.min(...series);
}

/**
 * Returns the largest value of a series.
 *
 * @param {number[]} series - the values
 * @returns {number|null} the maximum, or null for an empty series
 */
function maxOf(series) {
    return series.length === 0 ? null : Math.max(...series);
}

/**
 * Reads a file, or returns null when it does not exist.
 *
 * @param {string} file - the path
 * @returns {Promise<string|null>} the text, or null
 */
async function readOptional(file) {
    try {
        return await readFile(file, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

/**
 * Parses JSON lines. Lines that are not JSON are counted and left out.
 *
 * @param {string} text - the file text
 * @returns {{objects: object[], unreadable: number}} the parsed objects and the count of bad lines
 */
export function parseJsonLines(text) {
    const objects = [];
    let unreadable = 0;
    for (const line of String(text).split(/\r?\n/)) {
        if (line.trim() === "") {
            continue;
        }
        try {
            objects.push(JSON.parse(line));
        } catch {
            unreadable++;
        }
    }
    return { objects, unreadable };
}

/**
 * Tests whether an epoch time is inside a window. A time that is not a number is outside.
 *
 * @param {number} ms - the time
 * @param {{from: number|null, to: number|null}} window - the bounds, null when open
 * @returns {boolean} true when inside
 */
function insideWindow(ms, window) {
    if (Number.isNaN(ms)) {
        return false;
    }
    return (window.from === null || ms >= window.from) && (window.to === null || ms <= window.to);
}

/**
 * Formats an epoch time as ISO text.
 *
 * @param {number|null} ms - the time
 * @returns {string} the ISO text, or n/a
 */
function isoOf(ms) {
    return ms === null || ms === undefined ? "n/a" : new Date(ms).toISOString();
}

/**
 * Formats a duration in milliseconds as seconds with one decimal.
 *
 * @param {number|null|undefined} ms - the duration
 * @returns {string} the text, or n/a
 */
function secs(ms) {
    return typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "n/a";
}

/**
 * Formats a number with a fixed count of decimals.
 *
 * @param {number|null|undefined} value - the number
 * @param {number} digits - the decimals
 * @param {string} unit - text after the number
 * @returns {string} the text, or n/a
 */
function fixed(value, digits, unit) {
    return typeof value === "number" ? `${value.toFixed(digits)}${unit}` : "n/a";
}

/**
 * Formats a histogram as "key: count" pairs.
 *
 * @param {Record<string, number>} histogram - the histogram
 * @returns {string} the text, or none
 */
function histText(histogram) {
    const entries = Object.entries(histogram);
    return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key}: ${count}`).join(", ");
}

/**
 * Formats a distribution of milliseconds as seconds.
 *
 * @param {{count: number, min: number|null, p50: number|null, p95: number|null, max: number|null}} dist - the figures
 * @returns {string} the text
 */
function holdDistText(dist) {
    return `count ${dist.count}, min ${secs(dist.min)}, p50 ${secs(dist.p50)}, p95 ${secs(dist.p95)}, max ${secs(dist.max)}`;
}

/**
 * Formats a distribution of durations that are already in milliseconds.
 *
 * @param {{count: number, p50: number|null, p95: number|null, max: number|null}} dist - the figures
 * @returns {string} the text
 */
function durationText(dist) {
    return `count ${dist.count}, p50 ${secs(dist.p50)}, p95 ${secs(dist.p95)}, max ${secs(dist.max)}`;
}

/**
 * Formats the lines of one adapter summary.
 *
 * @param {object} summary - from summarizeAdapter
 * @returns {string[]} the lines, each indented by four spaces
 */
function adapterLines(summary) {
    return [
        `    calls ${summary.calls}, ok ${summary.ok}, error ${summary.error}`,
        `    duration all: ${durationText(summary.all)}`,
        `    duration ok: ${durationText(summary.okOnly)}`,
        `    duration error: ${durationText(summary.errorOnly)}`,
        `    calls at least 30 s: ${summary.atLeast30s}, at least 60 s: ${summary.atLeast60s}`,
        `    failures: busy ${summary.failures.busy}, render-timeout ${summary.failures["render-timeout"]}, ` +
            `exporter ${summary.failures.exporter}, other ${summary.failures.other}`,
        `    busy waits: count ${summary.busyWaitSeconds.count}, p50 ${fixed(summary.busyWaitSeconds.p50, 1, " s")}, ` +
            `p95 ${fixed(summary.busyWaitSeconds.p95, 1, " s")}`,
        ...summary.distinctFailureTexts.map((text) => `    - ${text}`),
    ];
}

/**
 * Formats the report as plain text. Percentiles are nearest-rank, and durations are in seconds.
 *
 * @param {object} report - the report built by main
 * @returns {string} the text
 */
export function formatReport(report) {
    const { monitor, samples, cap, leaseMs } = report;
    const lines = [
        "Export permit report",
        `Key ${report.key}, tool ${report.tool}, lease ${leaseMs} ms, cap ${cap}.`,
        `Window: ${report.window.from ?? "start"} to ${report.window.to ?? "end"}.`,
        "Percentiles are nearest-rank. Durations are in seconds.",
    ];
    if (report.missing.length > 0) {
        lines.push(`Missing: ${report.missing.join(", ")}`);
    }
    if (report.unreadableLines.samples > 0 || report.unreadableLines.metrics > 0) {
        lines.push(
            `Unreadable lines: samples ${report.unreadableLines.samples}, metrics ${report.unreadableLines.metrics}`
        );
    }

    const levels = Object.entries(monitor.concurrency.msAt)
        .map(([level, ms]) => `${level}: ${secs(ms)}`)
        .join(", ");
    lines.push(
        "",
        "Permits (Redis MONITOR)",
        `  attempts ${monitor.attempts}, granted ${monitor.granted}, refused polls ${monitor.refusedPolls}`,
        `  takes ${monitor.takes}, releases ${monitor.releases}, broken lines ${monitor.skipped}`,
        `  first ${isoOf(monitor.firstMs)}, last ${isoOf(monitor.lastMs)}`,
        `  holds ${monitor.holdsSummary.count}, still held at the end ${monitor.holdsSummary.heldAtEnd}, ` +
            `outlived the lease ${monitor.holdsSummary.exceededLease}`,
        `  hold time: ${holdDistText(monitor.holdsSummary.holdDistribution)}`,
        `  wait for the permit: ${holdDistText(monitor.waitDistribution)}`,
        `  max concurrent permits ${monitor.concurrency.max} (cap ${cap})`,
        `  time at each level: ${levels || "none"}`,
        "",
        "Permit samples (ZRANGE samples)",
        `  samples ${samples.samples}, error lines ${samples.errors}, first ${samples.firstT ?? "n/a"}, ` +
            `last ${samples.lastT ?? "n/a"}`,
        `  zcard histogram: ${histText(samples.zcardHistogram)}`,
        `  live histogram: ${histText(samples.liveHistogram)}`,
        `  max zcard ${samples.maxZcard ?? "n/a"}, max live ${samples.maxLive ?? "n/a"}`,
        `  samples above the cap: ${samples.aboveCap}`,
        `  samples with an expired member still in the set: ${samples.withExpiredMember}`,
        "",
        "Adapters (console logs)"
    );
    for (const [name, summary] of Object.entries(report.adapters)) {
        if (name === "all") {
            continue;
        }
        lines.push(`  ${name}`, ...adapterLines(summary));
    }
    lines.push("  all adapters", ...adapterLines(report.adapters.all));
    lines.push("", "Adapter metrics");
    const urls = Object.keys(report.metrics);
    if (urls.length === 0) {
        lines.push("  none");
    }
    for (const url of urls) {
        const metric = report.metrics[url];
        lines.push(
            `  ${url}: scrapes ${metric.scrapes}, failed ${metric.failedScrapes}`,
            `    permit fallbacks: first ${metric.fallbackFirst ?? "n/a"}, last ${metric.fallbackLast ?? "n/a"}, ` +
                `increase ${metric.fallbackIncrease ?? "n/a"}`,
            `    redis up (min) ${metric.redisUpMin ?? "n/a"}, export permits client up (min) ` +
                `${metric.exportPermitsClientUpMin ?? "n/a"}`,
            `    event loop lag p99 (max) ${fixed(metric.eventLoopLagP99Max, 3, " s")}, ` +
                `resident memory (max) ${typeof metric.residentBytesMax === "number" ? `${(metric.residentBytesMax / BYTES_PER_MB).toFixed(1)} MB` : "n/a"}, ` +
                `render sessions (max) ${metric.renderSessionsMax ?? "n/a"}`
        );
    }
    lines.push(
        "",
        "Lease check",
        `  lease values seen (ms): ${monitor.holdsSummary.leaseValues.join(", ") || "n/a"}, ` +
            `configured ${leaseMs} ms`,
        `  takes whose lease differs from the configured lease by more than ${LEASE_TOLERANCE_MS} ms: ` +
            `${monitor.holdsSummary.leaseMismatch}`,
        `  longest hold: ${secs(monitor.holdsSummary.holdDistribution.max)}`,
        `  holds that outlived the lease: ${monitor.holdsSummary.exceededLease}`,
        `  permits still held at the end: ${monitor.holdsSummary.heldAtEnd}`,
        `  max concurrent permits: ${monitor.concurrency.max} against cap ${cap}`,
        `  samples above the cap: ${samples.aboveCap}`
    );
    return lines.join("\n");
}

/**
 * Reads the files, builds the report, writes the JSON and text files, and prints the text.
 *
 * @param {string[]} argv - arguments after the script name
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
    let options;
    try {
        options = readOptions(argv);
    } catch (error) {
        if (!(error instanceof UsageError)) {
            throw error;
        }
        console.error(`export-permit-report: ${error.message}\n\n${USAGE}`);
        return 2;
    }
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const dir = resolve(options.dir);
    const info = await stat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) {
        console.error(`export-permit-report: --dir is not a folder: ${dir}\n\n${USAGE}`);
        return 2;
    }

    const { window, leaseMs, cap, key, tool } = options;
    const missing = [];
    const read = async (name) => {
        const text = await readOptional(join(dir, name));
        if (text === null) {
            missing.push(name);
        }
        return text;
    };

    const monitorText = await read("permit-monitor.log");
    const rawMonitor = parseMonitorLog(monitorText ?? "", key);
    const monitorEvents = applyWindow(rawMonitor, window);
    const holdInfo = permitHolds(monitorEvents, leaseMs);
    const { holds, ...holdsSummary } = holdInfo;
    const monitor = {
        ...attemptStats(monitorEvents),
        takes: monitorEvents.takes.length,
        releases: monitorEvents.releases.length,
        skipped: rawMonitor.skipped,
        firstMs: monitorEvents.firstMs,
        lastMs: monitorEvents.lastMs,
        holdsSummary: { count: holds.length, ...holdsSummary },
        waitDistribution: distribution(permitWaits(monitorEvents)),
        concurrency: concurrency(holds, monitorEvents.lastMs),
        holds,
    };

    const samplesText = await read("permit-samples.jsonl");
    const samplesParsed = parseJsonLines(samplesText ?? "");
    const sampleObjects = samplesParsed.objects.filter((line) => insideWindow(Date.parse(line?.t), window));
    const samples = summarizeSamples(sampleObjects, cap);

    const metricsText = await read("adapter-metrics.jsonl");
    const metricsParsed = parseJsonLines(metricsText ?? "");
    const metricEntries = metricsParsed.objects.filter((entry) => insideWindow(Date.parse(entry?.t), window));
    const metrics = summarizeMetrics(metricEntries);

    const parsedLogs = [];
    for (const { name, path } of options.adapterLogs) {
        const text = await readOptional(resolve(path));
        if (text === null) {
            missing.push(`adapter log ${name} (${path})`);
            continue;
        }
        parsedLogs.push({ name, parsed: parseAdapterLog(text) });
    }
    const merged = mergeAdapterLogs(parsedLogs.map((log) => log.parsed));
    const from = window.from;
    const to = window.to;
    const adapters = {};
    for (const log of parsedLogs) {
        adapters[log.name] = summarizeAdapter(log.parsed, tool, from, to);
    }
    adapters.all = summarizeAdapter(merged, tool, from, to);

    const report = {
        window: { from: from === null ? null : isoOf(from), to: to === null ? null : isoOf(to) },
        key,
        tool,
        leaseMs,
        cap,
        monitor,
        samples,
        adapters,
        metrics,
        missing,
        unreadableLines: { samples: samplesParsed.unreadable, metrics: metricsParsed.unreadable },
    };
    const text = formatReport(report);
    await writeFile(join(dir, "permit-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(dir, "permit-report.txt"), `${text}\n`);
    console.log(text);
    return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`export-permit-report: ${messageOf(error)}`);
            process.exitCode = 1;
        }
    );
}
