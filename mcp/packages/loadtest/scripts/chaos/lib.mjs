// Shared helpers for the T4 failure-injection cases (see mcp/docs/production-readiness-plan.md).
//
// Every case is one Node script. It runs its steps in order, records what the agent saw (MCP answers) and what the
// database holds (psql through docker exec), checks the expectations, and writes one JSON result file. Nothing here
// stops or starts a container unless the case calls `docker` for that inside a step and the operator passed --yes.
//
// Environment (or the same options as flags):
//   PENPOT_LOADTEST_URL          adapter MCP endpoint, default http://127.0.0.1:4405/mcp
//   PENPOT_LOADTEST_TOKEN_FILE   file with the MCP token on its first non-empty line (never printed)
//   PENPOT_LOADTEST_VARS_FILE    vars.json written by `loadtest setup` (needs fileId)
//   PENPOT_LOADTEST_ADAPTER_LOG  optional adapter log file; lines written during a case are copied into its result
//   CHAOS_HOST_ADAPTER_START_<port>  bash command line that starts the host adapter on 127.0.0.1:<port>
//   CHAOS_HOST_ADAPTER_LOG_<port>    log file of that host adapter (used for container log lines)

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpLoadClient } from "../../dist/McpLoadClient.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Root of the loadtest package: the results folder and git both start here. */
export const LOADTEST_DIR = resolve(here, "../..");
export const DEFAULT_RESULTS_DIR = join(LOADTEST_DIR, "results");

/** Containers of the dev stack. Names as `docker ps` shows them. */
export const CONTAINERS = {
    backend: "penpot-tc", // toolchain container that runs the dev backend JVM
    postgres: "penpot-penpot-postgres-1",
    valkey: "penpot-penpot-valkey-1",
    exporter: "penpot-mcp-exporter",
    frontend: "penpot-mcp-frontend",
};

export const PG_DB = "penpot_mcpdev";
export const PG_USER = "penpot";
/** Host port of the dev backend (container port 6060). */
export const BACKEND_READY_URL = "http://127.0.0.1:6061/readyz";
export const DEFAULT_MCP_URL = "http://127.0.0.1:4405/mcp";
/** The balancer of the two-adapter stack (mcp/deploy/README.md, port 4415). */
export const BALANCER_MCP_URL = "http://127.0.0.1:4415/mcp";

/** The adapter's write path waits at most 15 s for a file lock, and the adapter gives up at 55 s. */
export const FILE_LOCK_WAIT_MS = 15_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function assertUuid(value, label) {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
        throw new Error(`${label} is not a uuid: refusing to put it into SQL`);
    }
    return value;
}

/**
 * Parses the command line. `extra` maps extra flags of one case to their default values; a number default makes
 * the flag a number.
 */
export function parseArgs(argv, extra = {}) {
    const opts = {
        dryRun: false,
        yes: false,
        help: false,
        resultsDir: DEFAULT_RESULTS_DIR,
        url: undefined,
        tokenFile: undefined,
        varsFile: undefined,
        adapterLog: undefined,
        noCleanup: false,
        extra: { ...extra },
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) {
                throw new Error(`${flag} needs a value`);
            }
            i++;
            return argv[i];
        };
        switch (flag) {
            case "--dry-run":
                opts.dryRun = true;
                break;
            case "--yes":
                opts.yes = true;
                break;
            case "--help":
            case "-h":
                opts.help = true;
                break;
            case "--results-dir":
                opts.resultsDir = resolve(value());
                break;
            case "--url":
                opts.url = value();
                break;
            case "--token-file":
                opts.tokenFile = resolve(value());
                break;
            case "--vars":
                opts.varsFile = resolve(value());
                break;
            case "--adapter-log":
                opts.adapterLog = resolve(value());
                break;
            case "--no-cleanup":
                opts.noCleanup = true;
                break;
            default:
                if (!(flag in extra)) {
                    throw new Error(`unknown option ${flag}`);
                }
                opts.extra[flag] = typeof extra[flag] === "number" ? Number(value()) : value();
        }
    }
    return opts;
}

/**
 * Reads the endpoint, the token (first line of its file) and the vars. Throws with the names to set when a
 * value is missing. The token is never printed.
 */
export function loadConfig(opts, defaultUrl = DEFAULT_MCP_URL) {
    const url = opts.url ?? process.env.PENPOT_LOADTEST_URL ?? defaultUrl;
    const tokenFile = opts.tokenFile ?? process.env.PENPOT_LOADTEST_TOKEN_FILE;
    const varsFile = opts.varsFile ?? process.env.PENPOT_LOADTEST_VARS_FILE;
    if (!tokenFile || !varsFile) {
        throw new Error("set PENPOT_LOADTEST_TOKEN_FILE and PENPOT_LOADTEST_VARS_FILE (or --token-file and --vars)");
    }
    const token = readFileSync(tokenFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    if (!token) {
        throw new Error(`token file ${tokenFile} has no token`);
    }
    const vars = JSON.parse(readFileSync(varsFile, "utf8"));
    if (typeof vars.fileId !== "string") {
        throw new Error(`vars file ${varsFile} has no fileId`);
    }
    return { url, token, vars };
}

/**
 * Runs a program and waits for it. Never throws: the answer carries the exit code, the output and whether the
 * timeout ended it. A timed-out `docker exec` leaves its process inside the container running.
 */
export function run(cmd, args, { timeoutMs = 120_000, input } = {}) {
    return new Promise((done) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            done({ code: -1, stdout, stderr: String(error), timedOut });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            done({ code, stdout, stderr, timedOut });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input ?? "");
    });
}

/** Runs a command in a container and returns its output, or throws on failure. */
export async function dockerExec(container, args, { timeoutMs = 120_000, input, interactive = false } = {}) {
    const flags = interactive ? ["exec", "-i", container] : ["exec", container];
    const result = await run("docker", [...flags, ...args], { timeoutMs, input });
    if (result.code !== 0) {
        const why = result.timedOut ? "timed out" : `exit ${result.code}`;
        throw new Error(`docker exec ${container} ${args[0]} ${why}: ${result.stderr.trim().slice(0, 400)}`);
    }
    return result.stdout;
}

// A container name of the form host:<port> (e.g. host:4407) selects a host adapter process on 127.0.0.1:<port>,
// not a Docker container. Every other name uses Docker as before.

/**
 * Port of a host adapter name `host:<port>`, or undefined for a Docker container name. Throws when a `host:` name
 * has no valid port (digits only, 1024 to 65535).
 */
export function hostPort(name) {
    if (!name.startsWith("host:")) {
        return undefined;
    }
    const digits = name.slice("host:".length);
    const port = Number(digits);
    if (!/^\d+$/.test(digits) || port < 1024 || port > 65535) {
        throw new Error(`"${name}" is not a valid host adapter name: expected host:<port>, port 1024 to 65535`);
    }
    return port;
}

/** True when the host adapter on 127.0.0.1:<port> answers /healthz with 200. Any error gives false. */
export async function hostHealthy(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
        return response.status === 200;
    } catch {
        return false;
    }
}

/** PID of the process that listens on port <port> (netstat). Undefined when nothing listens. */
export async function hostPid(port) {
    const result = await run("netstat", ["-ano", "-p", "TCP"], { timeoutMs: 20_000 });
    const rows = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields.length >= 5);
    const match = rows.find(([, local, , state]) => local.endsWith(`:${port}`) && state === "LISTENING");
    return match && /^\d+$/.test(match[4]) ? match[4] : undefined;
}

/**
 * Stops the host adapter on port <port> with taskkill, then waits until it no longer answers. Does nothing when
 * nothing listens there.
 */
export async function hostStop(port, timeoutS) {
    const pid = await hostPid(port);
    if (pid === undefined) {
        return;
    }
    // cmd.exe is called directly so that Git Bash does not rewrite /PID.
    const result = await run("cmd.exe", ["/c", "taskkill", "/PID", pid, "/F"], { timeoutMs: 20_000 });
    if (result.code !== 0) {
        throw new Error(`taskkill failed: ${result.stderr.trim().slice(0, 200)}`);
    }
    await waitFor(`host adapter ${port} stopped`, async () => !(await hostHealthy(port)), {
        timeoutMs: Math.max(20_000, timeoutS * 1000),
        intervalMs: 500,
    });
}

/**
 * Starts the host adapter on port <port> with the bash command in CHAOS_HOST_ADAPTER_START_<port>, detached, then
 * waits until it answers /healthz. The command is never printed.
 */
export async function hostStart(port, timeoutS) {
    const varName = `CHAOS_HOST_ADAPTER_START_${port}`;
    const cmd = process.env[varName];
    if (!cmd) {
        throw new Error(`set ${varName} to the bash command that starts the host adapter`);
    }
    const child = spawn("bash", ["-c", cmd], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    await waitFor(`host adapter ${port} healthy`, () => hostHealthy(port), {
        timeoutMs: timeoutS * 1000,
        intervalMs: 1000,
    });
}

/**
 * Log lines of the host adapter on port <port> since an ISO time that match `pattern`. Reads the file named by
 * CHAOS_HOST_ADAPTER_LOG_<port>. Lines without a timestamp take the time of the line before them.
 */
export function hostLogLines(port, sinceIso, pattern) {
    const varName = `CHAOS_HOST_ADAPTER_LOG_${port}`;
    const path = process.env[varName];
    if (!path) {
        return [`host adapter log not set: ${varName}`];
    }
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [`host adapter log unreadable: ${message.slice(0, 200)}`];
    }
    const since = Date.parse(sinceIso);
    const stamp = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/;
    let lastSeen;
    const kept = [];
    for (const line of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
        const found = line.match(stamp);
        if (found) {
            // This host runs in UTC, so the stamp is read as UTC.
            lastSeen = Date.parse(found[1].replace(" ", "T") + "Z");
        }
        if (lastSeen === undefined || lastSeen < since) {
            continue;
        }
        if (pattern.test(line)) {
            kept.push(line.slice(0, 300));
        }
    }
    return kept.slice(0, 60);
}

/** Stops, starts or restarts one container. Throws unless the operator passed --yes. */
export async function containerAction(action, container, { timeoutS = 60, yes }) {
    if (!yes) {
        throw new Error(`refusing to ${action} ${container} without --yes`);
    }
    const port = hostPort(container);
    if (port !== undefined) {
        if (action === "stop") {
            await hostStop(port, timeoutS);
        } else if (action === "start") {
            await hostStart(port, timeoutS);
        } else if (action === "restart") {
            await hostStop(port, timeoutS);
            await hostStart(port, timeoutS);
        } else {
            throw new Error(`${action} is not supported for host adapters (${container})`);
        }
        return;
    }
    const args = action === "restart" ? ["restart", "-t", String(timeoutS), container] : [action, container];
    const result = await run("docker", args, { timeoutMs: (timeoutS + 120) * 1000 });
    if (result.code !== 0) {
        throw new Error(`docker ${action} ${container} failed: ${result.stderr.trim().slice(0, 400)}`);
    }
}

/** Reads the running state of a container: "true" or "false", or "missing". A host adapter gives its health. */
export async function isRunning(container) {
    const port = hostPort(container);
    if (port !== undefined) {
        return hostHealthy(port);
    }
    const result = await run("docker", ["inspect", "-f", "{{.State.Running}}", container], { timeoutMs: 20_000 });
    return result.code === 0 ? result.stdout.trim() === "true" : false;
}

/** Runs one SQL statement against the dev database and returns the trimmed output (unaligned, tuples only). */
export async function psql(sql, { timeoutMs = 30_000 } = {}) {
    const result = await run(
        "docker",
        [
            "exec",
            CONTAINERS.postgres,
            "psql",
            "-U",
            PG_USER,
            "-d",
            PG_DB,
            "-X",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
        ],
        { timeoutMs }
    );
    if (result.code !== 0) {
        throw new Error(`psql failed: ${result.stderr.trim().slice(0, 400)}`);
    }
    return result.stdout.trim();
}

/** The revision of a file as the database holds it. */
export async function dbRevn(fileId) {
    assertUuid(fileId, "fileId");
    return Number(await psql(`select revn from file where id = '${fileId}'`));
}

/** True when the dev backend answers /readyz with 200. */
export async function backendReady(timeoutMs = 3000) {
    try {
        const response = await fetch(BACKEND_READY_URL, { signal: AbortSignal.timeout(timeoutMs) });
        return response.status === 200;
    } catch {
        return false;
    }
}

/**
 * Polls `probe` until it returns a truthy value, and returns that value. Throws after timeoutMs with the last
 * answer, so every wait has a bound.
 */
export async function waitFor(label, probe, { timeoutMs, intervalMs = 1000 }) {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";
    while (Date.now() < deadline) {
        try {
            const value = await probe();
            if (value) {
                return value;
            }
            last = String(value);
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label} (last: ${last.slice(0, 300)})`);
}

/**
 * Resolves with `promise`, or with `fallback()` after `ms`. The timer is cleared when the promise settles, so a
 * finished race leaves no timer behind to keep the process alive.
 */
export function raceTimeout(promise, ms, fallback) {
    let timer;
    const timeout = new Promise((done) => {
        timer = setTimeout(() => done(fallback()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Size of a file in bytes, or 0 when it does not exist. Used as the cursor for adapter log lines. */
export function logOffset(path) {
    if (!path || !existsSync(path)) {
        return 0;
    }
    return statSync(path).size;
}

/** Lines that the adapter log gained after `offset`, matching `pattern`. */
export function logLinesSince(path, offset, pattern = /./) {
    if (!path || !existsSync(path)) {
        return [];
    }
    const size = statSync(path).size;
    if (size <= offset) {
        return [];
    }
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
        closeSync(fd);
    }
    return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0 && pattern.test(line))
        .map((line) => line.slice(0, 300))
        .slice(0, 60);
}

/** Shortens an MCP answer for the result file. */
export function outcome(result) {
    return {
        ok: result.ok,
        isError: result.isError,
        durationMs: Math.round(result.durationMs),
        text: (result.text ?? "").replace(/\s+/g, " ").slice(0, 400),
        error: result.error,
        json: result.json,
    };
}

/** Shape count of a page of the file, read through get_file_outline by page name. */
export async function outlineShapeCount(c, pageName) {
    const result = await c.call("get_file_outline", { fileId: c.config.vars.fileId });
    if (!result.ok) {
        throw new Error(`get_file_outline failed: ${result.text.slice(0, 200)}`);
    }
    const page = result.json?.pages?.find((entry) => entry.name === pageName);
    if (!page) {
        throw new Error(`page "${pageName}" is not in the outline`);
    }
    return page.shapeCount;
}

/** Number of shapes on a page whose name starts with `prefix`. Throws when the answer is cut. */
export async function countNamed(c, pageId, prefix) {
    const result = await c.call("find_shapes", {
        fileId: c.config.vars.fileId,
        pageId,
        nameRegex: `^${prefix}`,
        limit: 1000,
    });
    if (!result.ok) {
        throw new Error(`find_shapes failed: ${result.text.slice(0, 200)}`);
    }
    if (result.json?.truncated === true) {
        throw new Error("find_shapes answer is truncated; the count is not reliable");
    }
    return (result.json?.matches ?? []).length;
}

/**
 * Creates a page with a unique name for this case, so the case never writes to the page of the test file. Returns
 * the page id.
 */
export async function createScratchPage(c, pageName) {
    const result = await c.call("apply_operations", {
        fileId: c.config.vars.fileId,
        snapshot: false,
        operations: [{ op: "create_page", id: "$tmp:page", name: pageName }],
    });
    const pageId = result.json?.createdIds?.["$tmp:page"];
    if (!result.ok || !pageId) {
        throw new Error(`could not create scratch page: ${result.text.slice(0, 200)}`);
    }
    return pageId;
}

/** A short random tag: names of the shapes and pages of one run carry it, so a run finds only its own shapes. */
export function runTag(caseName) {
    const hex = Math.random().toString(16).slice(2, 10);
    return `${caseName}-${hex}`;
}

/** Commit and tree state of the loadtest package, for the result file. */
async function gitState() {
    const head = await run("git", ["-C", LOADTEST_DIR, "rev-parse", "--short", "HEAD"], { timeoutMs: 15_000 });
    const status = await run("git", ["-C", LOADTEST_DIR, "status", "--porcelain"], { timeoutMs: 15_000 });
    return {
        commit: head.code === 0 ? head.stdout.trim() : "unknown",
        treeDirty: status.code === 0 ? status.stdout.trim().length > 0 : null,
    };
}

/**
 * Stands in for the value of a step in dry-run. Every property read and call gives it back again, so the case body
 * can run to the end and print every step, and its expectations read as text. It is never a real answer.
 */
export const DRY = new Proxy(function dryValue() {}, {
    get(_target, prop) {
        if (prop === Symbol.toPrimitive) {
            return () => 0;
        }
        if (prop === "then") {
            return undefined;
        }
        return DRY;
    },
    apply() {
        return DRY;
    },
    construct() {
        return DRY;
    },
    has() {
        return false;
    },
});

/**
 * One case: steps, observations, checks and the result file. A case builds its steps with `c.step`, the
 * observations with `c.observe` and the expectations with `c.check`. In dry-run the steps only print.
 */
export class CaseRun {
    constructor(name, opts, config) {
        this.name = name;
        this.opts = opts;
        this.dryRun = opts.dryRun;
        this.config = config;
        this.startedAt = new Date();
        this.steps = [];
        this.observed = {};
        this.expected = {};
        this.checks = [];
        this.notes = [];
        this.error = undefined;
        this.adapterLogPath = opts.adapterLog ?? process.env.PENPOT_LOADTEST_ADAPTER_LOG;
        this.adapterLogStart = logOffset(this.adapterLogPath);
        this.client = undefined;
        this.cleanups = [];
    }

    /**
     * Registers an undo for something the case stopped or killed. The undo runs after the body, also when a step
     * threw, in reverse order. Register only inside a step, so a dry run never registers one. --no-cleanup skips
     * them and prints what to restore by hand.
     */
    registerCleanup(label, fn) {
        this.cleanups.push({ label, fn });
    }

    /** Runs the registered undos, each bounded to 5 minutes. A failed undo is recorded and reported, not thrown. */
    async runCleanups() {
        const pending = this.cleanups.splice(0).reverse();
        if (this.opts.noCleanup) {
            for (const item of pending) {
                this.note(`--no-cleanup: restore by hand: ${item.label}`);
            }
            return;
        }
        for (const item of pending) {
            const started = performance.now();
            console.log(`> cleanup: ${item.label}`);
            try {
                const outcomeOfUndo = await raceTimeout(item.fn(), 300_000, () => "timed out");
                if (outcomeOfUndo === "timed out") {
                    throw new Error("cleanup timed out after 300 s");
                }
                this.steps.push({
                    name: `cleanup: ${item.label}`,
                    ok: true,
                    ms: Math.round(performance.now() - started),
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.steps.push({ name: `cleanup: ${item.label}`, ok: false, error: message });
                this.note(`cleanup failed, restore by hand: ${item.label} (${message})`);
            }
        }
    }

    /** Runs one step. In dry-run it prints the plan and does nothing. */
    async step(label, fn, plan = "") {
        if (this.dryRun) {
            this.steps.push({ name: label, plan });
            console.log(`  [dry-run] ${label}${plan ? `: ${plan}` : ""}`);
            return DRY;
        }
        const started = performance.now();
        console.log(`> ${label}`);
        try {
            const value = await fn();
            this.steps.push({ name: label, ok: true, ms: Math.round(performance.now() - started) });
            return value;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.steps.push({ name: label, ok: false, ms: Math.round(performance.now() - started), error: message });
            throw error;
        }
    }

    /** Records a value the run saw. */
    observe(key, value) {
        if (!this.dryRun) {
            this.observed[key] = value;
        }
    }

    /** Records one expectation and whether it holds. Dry-run only records the expectation text. */
    check(key, description, condition, value) {
        this.expected[key] = description;
        if (this.dryRun) {
            return;
        }
        if (value !== undefined) {
            this.observed[key] = value;
        }
        const pass = condition === true;
        this.checks.push({ key, pass });
        console.log(`  ${pass ? "PASS" : "FAIL"} ${key}: ${description}`);
    }

    /** A note for the operator, written into the result. */
    note(text) {
        this.notes.push(text);
        console.log(`  note: ${text}`);
    }

    /** Lazily connects one MCP client; a step calls this, never the top level. */
    async mcp() {
        if (!this.client) {
            const client = new McpLoadClient();
            await client.connect(this.config.url, this.config.token);
            this.client = client;
        }
        return this.client;
    }

    /** One MCP tool call, which never throws: failures come back in the outcome. */
    async call(tool, args) {
        const client = await this.mcp();
        return client.callTool(tool, args);
    }

    /** Drops the MCP session and makes a new one. */
    async reconnect() {
        await this.client?.close().catch(() => {});
        this.client = undefined;
        return this.mcp();
    }

    /** Adapter log lines written during this case. */
    adapterLines(pattern) {
        return logLinesSince(this.adapterLogPath, this.adapterLogStart, pattern);
    }

    /** Writes the result file and returns whether the case passed (null in dry-run). */
    async finish() {
        const finishedAt = new Date();
        const pass = this.dryRun
            ? null
            : this.error === undefined && this.checks.length > 0 && this.checks.every((c) => c.pass);
        const git = await gitState();
        const stamp = finishedAt.toISOString().replace(/[:.]/g, "-");
        const result = {
            case: this.name,
            dryRun: this.dryRun,
            commit: git.commit,
            treeDirty: git.treeDirty,
            startedAt: this.startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            steps: this.steps,
            observed: this.observed,
            expected: this.expected,
            checks: this.checks,
            notes: this.notes,
            error: this.error,
            pass,
        };
        mkdirSync(this.opts.resultsDir, { recursive: true });
        const file = join(this.opts.resultsDir, `chaos-${this.name}-${stamp}.json`);
        writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
        if (this.client) {
            await this.client.close().catch(() => {});
        }
        const verdict = pass === null ? "DRY RUN (nothing executed)" : pass ? "PASS" : "FAIL";
        console.log(`\n${this.name}: ${verdict}${this.error ? ` :: ${this.error}` : ""}`);
        console.log(`result: ${file}`);
        return pass;
    }
}

/**
 * Entry point of one case. Parses the flags, refuses to touch containers without --yes, loads the config, runs
 * `body`, writes the result and sets the exit code (0 pass or dry-run, 1 fail, 2 refused).
 */
export async function runCase(name, extra, body, usage, defaultUrl = DEFAULT_MCP_URL) {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2), extra);
    } catch (error) {
        console.error(`${name}: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    if (opts.help) {
        console.log(usage);
        return;
    }
    if (!opts.dryRun && !opts.yes) {
        console.error(
            `${name}: this case stops or restarts containers of the dev stack. Re-run with --yes to run it, or with --dry-run to print the steps.`
        );
        process.exitCode = 2;
        return;
    }
    let config = {
        url: defaultUrl,
        token: "<token from PENPOT_LOADTEST_TOKEN_FILE>",
        vars: { fileId: "<fileId>" },
    };
    if (!opts.dryRun) {
        try {
            config = loadConfig(opts, defaultUrl);
        } catch (error) {
            console.error(`${name}: ${error.message}`);
            process.exitCode = 2;
            return;
        }
    }
    const c = new CaseRun(name, opts, config);
    console.log(`${name}${opts.dryRun ? " (dry run)" : ""}`);
    try {
        await body(c);
    } catch (error) {
        c.error = error instanceof Error ? error.message : String(error);
    }
    if (!c.dryRun) {
        await c.runCleanups();
    }
    const pass = await c.finish();
    process.exitCode = pass === false ? 1 : 0;
}

/** Kills the dev backend JVM (the same match restart-backend-dev uses), without killing this shell. */
export const KILL_BACKEND_JVM = [
    "me=$$",
    "killed=0",
    "for p in /proc/[0-9]*; do",
    "  pid=${p#/proc/}",
    '  [ "$pid" = "$me" ] && continue',
    '  c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)',
    '  case "$c" in *java*app.main*) kill -9 "$pid" && killed=$((killed+1));; esac',
    "done",
    'echo "killed=$killed"',
].join("\n");

/**
 * Starts a container when it is not running, and waits until it runs. Used as the undo of a stop. The caller
 * passes the --yes it was given, so the check holds.
 */
export async function ensureRunning(container, yes) {
    if (await isRunning(container)) {
        return;
    }
    await containerAction("start", container, { yes });
    await waitFor(`${container} running`, () => isRunning(container), { timeoutMs: 120_000, intervalMs: 2000 });
}

/** Health from the container's healthcheck: healthy, unhealthy, starting, none or unknown. */
export async function containerHealth(container) {
    const port = hostPort(container);
    if (port !== undefined) {
        return (await hostHealthy(port)) ? "healthy" : "unhealthy";
    }
    const format = "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
    const result = await run("docker", ["inspect", "-f", format, container], { timeoutMs: 20_000 });
    return result.code === 0 ? result.stdout.trim() : "unknown";
}

const FALLBACK_SCRIPT = String.raw`fetch('http://127.0.0.1:4401/metrics').then(r=>r.text()).then(t=>{const m=t.match(/^penpot_mcp_rate_limit_fallback_total(?:\{[^}]*\})?\s+([0-9.]+)/m);process.stdout.write(m?m[1]:'missing')})`;

/**
 * The rate-limit fallback counter of one adapter, read from inside its container: the adapter port is not
 * published to the host. Undefined when the counter is not exposed.
 */
export async function adapterFallbackCount(container) {
    const port = hostPort(container);
    if (port !== undefined) {
        const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
        const match = (await response.text()).match(/^penpot_mcp_rate_limit_fallback_total(?:\{[^}]*\})?\s+([0-9.]+)/m);
        return match ? Number(match[1]) : undefined;
    }
    const out = (await dockerExec(container, ["node", "-e", FALLBACK_SCRIPT], { timeoutMs: 20_000 })).trim();
    return out === "missing" ? undefined : Number(out);
}

/** Log lines of a container since an ISO time that match `pattern`. Both output streams are read. */
export async function containerLogLines(container, sinceIso, pattern) {
    const port = hostPort(container);
    if (port !== undefined) {
        return hostLogLines(port, sinceIso, pattern);
    }
    const result = await run("docker", ["logs", "--no-color", "--since", sinceIso, container], { timeoutMs: 30_000 });
    if (result.code !== 0) {
        return [`docker logs failed: ${result.stderr.trim().slice(0, 200)}`];
    }
    return (result.stdout + result.stderr)
        .split(/\r?\n/)
        .filter((line) => pattern.test(line))
        .map((line) => line.slice(0, 300))
        .slice(0, 60);
}
