// Records the shared export permits in Redis and the adapters' /metrics until it is told to stop.
//
// Usage (from any directory):
//   node scripts/round2/export-permit-watch.mjs --out <dir> [--redis <uri>] [--key <key>] [--interval-ms <n>]
//                                              [--adapter <metrics url>]... [--metrics-interval-ms <n>]
//                                              [--stop-file <path>]
//   node scripts/round2/export-permit-watch.mjs --help
//
// Why ioredis is loaded from the server package: the loadtest package does not depend on ioredis. The server
// package does, so the client is resolved from its folder. That is the same client version the adapters use.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const LOADTEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromServer = createRequire(join(LOADTEST_ROOT, "..", "server", "package.json"));
const ioredisModule = requireFromServer("ioredis");
const Redis = ioredisModule.Redis ?? ioredisModule.default ?? ioredisModule;

export const DEFAULT_REDIS = "redis://127.0.0.1:6390";
export const DEFAULT_KEY = "penpot.mcp.export.permits";
export const DEFAULT_ADAPTERS = ["http://127.0.0.1:4406/metrics", "http://127.0.0.1:4407/metrics"];
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_METRICS_INTERVAL_MS = 5000;
const CONNECT_TIMEOUT_MS = 4000;
const SCRAPE_TIMEOUT_MS = 4000;
const TAB = "\t";

/** Metric names (or name prefixes) kept from each adapter scrape. */
const METRIC_PREFIXES = [
    "penpot_mcp_export_permit_fallback_total",
    "penpot_mcp_redis_up",
    "penpot_mcp_redis_client_up",
    "penpot_mcp_rate_limit_fallback_total",
    "penpot_mcp_render_sessions",
    "nodejs_eventloop_lag_",
    "process_resident_memory_bytes",
    "nodejs_heap_used_bytes",
];

const USAGE = `Records the shared export permits in Redis and the adapters' /metrics until it is stopped.

Usage:
  node scripts/round2/export-permit-watch.mjs --out <dir> [options]
  node scripts/round2/export-permit-watch.mjs --help

Options:
  --out <dir>                 output folder, created when missing (required)
  --redis <uri>              Redis URI (default ${DEFAULT_REDIS})
  --key <key>                permit sorted set (default ${DEFAULT_KEY})
  --interval-ms <n>          permit sample period in ms, a whole number of at least 1 (default ${DEFAULT_INTERVAL_MS})
  --adapter <url>            adapter /metrics URL, repeatable (default ${DEFAULT_ADAPTERS.join(", ")})
  --metrics-interval-ms <n>  metrics scrape period in ms (default ${DEFAULT_METRICS_INTERVAL_MS})
  --stop-file <path>         stop when this file exists (checked on every permit sample)
  --help                     print this text

Files written to <dir> (appended to):
  permit-samples.jsonl       one line per permit sample: Redis TIME and the members of the set
  permit-monitor.log         MONITOR lines that name the key: time, source, database, JSON args (tab separated)
  adapter-metrics.jsonl      the metric lines of each adapter per scrape, or the error

SIGINT or SIGTERM stops the watcher too. Exit codes: 0 stopped, 1 runtime error, 2 usage error.
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
 * Builds the object of one permit sample from the Redis TIME and the flat ZRANGE ... WITHSCORES reply.
 *
 * @param {string[]} redisTime - the reply of TIME: [seconds, microseconds]
 * @param {string[]} flatMembers - the flat reply of ZRANGE WITHSCORES: [member1, score1, member2, score2, ...]
 * @param {string} hostIso - the host time of the sample, in ISO form
 * @returns {{t: string, redisMs: number, zcard: number, live: number, members: Array<[string, number]>}} the sample
 */
export function sampleOf(redisTime, flatMembers, hostIso) {
    const redisMs = Number(redisTime[0]) * 1000 + Math.floor(Number(redisTime[1]) / 1000);
    const members = [];
    for (let index = 0; index + 1 < flatMembers.length; index += 2) {
        members.push([String(flatMembers[index]), Number(flatMembers[index + 1])]);
    }
    const live = members.filter(([, score]) => score > redisMs).length;
    return { t: hostIso, redisMs, zcard: members.length, live, members };
}

/**
 * Returns the tab separated line of one MONITOR event, or null when the command does not name the key.
 *
 * @param {string} time - the time Redis gave, seconds with microseconds
 * @param {string[]} args - the command and its arguments
 * @param {string} source - the client that sent the command
 * @param {number|string} database - the database number
 * @param {string} key - the permit key
 * @returns {string|null} the line without a newline, or null
 */
export function monitorLineOf(time, args, source, database, key) {
    if (!Array.isArray(args) || !args.includes(key)) {
        return null;
    }
    return [time, source, String(database), JSON.stringify(args)].join(TAB);
}

/**
 * Keeps only the metric lines the report reads: the named series and every export_shape line. Comments and blank
 * lines are dropped.
 *
 * @param {string} text - a Prometheus text scrape
 * @returns {string[]} the kept lines
 */
export function selectMetricLines(text) {
    return String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
            (line) =>
                line !== "" &&
                !line.startsWith("#") &&
                (METRIC_PREFIXES.some((prefix) => line.startsWith(prefix)) || line.includes('tool="export_shape"'))
        );
}

/**
 * Reads the permit sample of the Redis connection.
 *
 * @param {object} redis - an ioredis client
 * @param {string} key - the permit key
 * @param {string} hostIso - the host time of the sample
 * @returns {Promise<object>} the sample, or an object with the error text when the call failed
 */
async function takeSample(redis, key, hostIso) {
    try {
        const replies = await redis.multi().time().zrange(key, 0, -1, "WITHSCORES").exec();
        if (!Array.isArray(replies) || replies.length !== 2) {
            throw new Error("the MULTI returned no replies");
        }
        const [[timeError, time], [zrangeError, flat]] = replies;
        if (timeError) {
            throw timeError;
        }
        if (zrangeError) {
            throw zrangeError;
        }
        return sampleOf(time, flat, hostIso);
    } catch (error) {
        return { t: hostIso, error: messageOf(error) };
    }
}

/**
 * Fetches one adapter's /metrics and keeps the report lines.
 *
 * @param {string} url - the metrics URL of the adapter
 * @returns {Promise<object>} the scrape entry: ok with the lines, or ok false with the error
 */
async function scrapeAdapter(url) {
    const t = new Date().toISOString();
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
        if (response.status !== 200) {
            await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status}`);
        }
        return { t, adapter: url, ok: true, lines: selectMetricLines(await response.text()) };
    } catch (error) {
        return { t, adapter: url, ok: false, error: messageOf(error) };
    }
}

/**
 * Runs an async tick again and again, with the next tick starting one period after the previous one finished.
 * Ticks never overlap. The loop can be stopped; a stop ends the wait at once and lets a running tick finish.
 *
 * @param {number} periodMs - wait between the end of one tick and the start of the next
 * @param {() => Promise<void>} tick - the work; it must not throw
 * @returns {{done: Promise<void>, stop: () => void}} the loop promise, and the stop function
 */
function startLoop(periodMs, tick) {
    let stopped = false;
    let timer = null;
    let wake = null;
    const done = (async () => {
        while (!stopped) {
            await tick();
            if (stopped) {
                break;
            }
            await new Promise((resolvePromise) => {
                wake = resolvePromise;
                timer = setTimeout(resolvePromise, periodMs);
            });
            wake = null;
        }
    })();
    return {
        done,
        stop() {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            if (wake !== null) {
                wake();
            }
        },
    };
}

/**
 * Ends a write stream and waits for its finish event.
 *
 * @param {import("node:fs").WriteStream} stream - the stream to end
 * @returns {Promise<void>} resolves when the data is flushed
 */
function closeStream(stream) {
    return new Promise((resolvePromise, reject) => {
        stream.once("finish", resolvePromise);
        stream.once("error", reject);
        stream.end();
    });
}

/**
 * Closes a Redis connection with QUIT, or drops it when QUIT fails.
 *
 * @param {object} redis - an ioredis client
 * @returns {Promise<void>}
 */
async function closeRedis(redis) {
    try {
        await redis.quit();
    } catch {
        redis.disconnect();
    }
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
                out: { type: "string" },
                redis: { type: "string" },
                key: { type: "string" },
                "interval-ms": { type: "string" },
                adapter: { type: "string", multiple: true },
                "metrics-interval-ms": { type: "string" },
                "stop-file": { type: "string" },
                help: { type: "boolean", short: "h" },
            },
        }));
    } catch (error) {
        throw new UsageError(messageOf(error));
    }
    if (values.help === true) {
        return { help: true };
    }
    if (values.out === undefined) {
        throw new UsageError("--out <dir> is required");
    }
    const redisUri = values.redis ?? DEFAULT_REDIS;
    try {
        new URL(redisUri);
    } catch {
        throw new UsageError(`--redis is not a URI: ${redisUri.replace(/\/\/[^@]*@/, "//<credentials>@")}`);
    }
    return {
        help: false,
        out: values.out,
        redisUri,
        key: values.key ?? DEFAULT_KEY,
        intervalMs: parseCount(values["interval-ms"], "--interval-ms", DEFAULT_INTERVAL_MS),
        adapters: values.adapter ?? DEFAULT_ADAPTERS,
        metricsIntervalMs: parseCount(
            values["metrics-interval-ms"],
            "--metrics-interval-ms",
            DEFAULT_METRICS_INTERVAL_MS
        ),
        stopFile: values["stop-file"] === undefined ? null : resolve(values["stop-file"]),
    };
}

/**
 * Records the permits and the metrics until a stop: the stop file, SIGINT or SIGTERM.
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
        console.error(`export-permit-watch: ${error.message}\n\n${USAGE}`);
        return 2;
    }
    if (options.help) {
        console.log(USAGE);
        return 0;
    }

    const outDir = resolve(options.out);
    await mkdir(outDir, { recursive: true });
    const url = new URL(options.redisUri);
    console.log(
        `redis ${url.hostname}:${url.port || "6379"} key ${options.key} out ${outDir} ` +
            `(permits every ${options.intervalMs} ms, metrics every ${options.metricsIntervalMs} ms)`
    );

    const counts = { samples: 0, sampleErrors: 0, monitorLines: 0, metricScrapes: 0, metricErrors: 0 };
    const samplesStream = createWriteStream(join(outDir, "permit-samples.jsonl"), { flags: "a" });
    const monitorStream = createWriteStream(join(outDir, "permit-monitor.log"), { flags: "a" });
    const metricsStream = createWriteStream(join(outDir, "adapter-metrics.jsonl"), { flags: "a" });
    const streams = [samplesStream, monitorStream, metricsStream];

    let requestStop = () => undefined;
    const stopRequested = new Promise((resolvePromise) => {
        requestStop = resolvePromise;
    });
    process.once("SIGINT", () => requestStop("SIGINT"));
    process.once("SIGTERM", () => requestStop("SIGTERM"));

    // The sampling connection and the MONITOR connection are separate: a MONITOR connection cannot run commands.
    const redisSample = new Redis(options.redisUri, {
        maxRetriesPerRequest: 1,
        connectTimeout: CONNECT_TIMEOUT_MS,
        commandTimeout: CONNECT_TIMEOUT_MS,
    });
    const redisMonitor = new Redis(options.redisUri, {
        maxRetriesPerRequest: 1,
        connectTimeout: CONNECT_TIMEOUT_MS,
    });
    // Failed commands report their error to the caller, so the connection errors need no listener of their own.
    redisSample.on("error", () => undefined);
    redisMonitor.on("error", () => undefined);

    let monitor = null;
    let recording = true;
    let loops = [];
    let closed = false;

    const shutdown = async () => {
        if (closed) {
            return;
        }
        closed = true;
        recording = false;
        for (const loop of loops) {
            loop.stop();
        }
        await Promise.all(loops.map((loop) => loop.done));
        if (monitor !== null) {
            monitor.disconnect();
        }
        await closeRedis(redisSample);
        await closeRedis(redisMonitor);
        await Promise.all(streams.map(closeStream));
    };

    try {
        monitor = await redisMonitor.monitor();
        monitor.on("error", (error) => console.error(`monitor: ${messageOf(error)}`));
        monitor.on("monitor", (time, args, source, database) => {
            if (!recording) {
                return;
            }
            const line = monitorLineOf(time, args, source, database, options.key);
            if (line === null) {
                return;
            }
            monitorStream.write(`${line}\n`);
            counts.monitorLines++;
        });

        const sampleLoop = startLoop(options.intervalMs, async () => {
            if (options.stopFile !== null && existsSync(options.stopFile)) {
                requestStop("stop file");
                return;
            }
            const sample = await takeSample(redisSample, options.key, new Date().toISOString());
            if (!recording) {
                return;
            }
            samplesStream.write(`${JSON.stringify(sample)}\n`);
            counts.samples++;
            if (sample.error !== undefined) {
                counts.sampleErrors++;
            }
        });

        const metricsLoop = startLoop(options.metricsIntervalMs, async () => {
            for (const adapter of options.adapters) {
                const entry = await scrapeAdapter(adapter);
                if (!recording) {
                    return;
                }
                metricsStream.write(`${JSON.stringify(entry)}\n`);
                counts.metricScrapes++;
                if (entry.ok !== true) {
                    counts.metricErrors++;
                }
            }
        });
        loops = [sampleLoop, metricsLoop];

        await stopRequested;
        await shutdown();
    } catch (error) {
        await shutdown();
        throw error;
    }

    console.log(
        `samples=${counts.samples} sampleErrors=${counts.sampleErrors} monitorLines=${counts.monitorLines} ` +
            `metricScrapes=${counts.metricScrapes} metricErrors=${counts.metricErrors}`
    );
    return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`export-permit-watch: ${messageOf(error)}`);
            process.exitCode = 1;
        }
    );
}
