#!/usr/bin/env node
/**
 * Human-tab actor for the C3 and C5 gates (PERF-RUNBOOK rows 2-C3, 2-C5 and 5).
 *
 * A headless Chromium logs in to the dev frontend as the test profile, opens the workspace of one file, selects
 * a board that this run created through the MCP, and nudges it one canvas unit every 5 s (ArrowRight, then
 * ArrowDown). Each nudge is one change that Penpot saves through the update-file RPC. The run records the
 * duration and status of every save, counts the websocket frames that mention file-change, and after the run
 * reads the board back through the MCP to check that the last position was kept.
 *
 * Usage (see README.md in this folder):
 *   node scripts/human-tab/human-tab.mjs --tokens <file> --vars <vars.json> [--minutes 3]
 *
 * The password is never a flag. It comes from PENPOT_HUMAN_PASSWORD (the test profile's password is not
 * recorded in the repo or in the vars file).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpLoadClient } from "../../dist/McpLoadClient.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");
// the frontend on 9002 sends RPCs under /api/main/methods/, the backend under /api/rpc/command/
// Penpot saves with the update-file command. Match the path exactly: update-file-snapshot and
// update-file-library-sync-status are other commands.
function isSaveUrl(url) {
    try {
        return new URL(url).pathname.endsWith("/update-file");
    } catch {
        return false;
    }
}
const KEYS = ["ArrowRight", "ArrowDown"];
const READY_TIMEOUT_MS = 10 * 60 * 1000;
// the workspace canvas wrapper; Penpot names it through CSS modules, so the hashed prefix is matched
const VIEWPORT_SELECTOR = '.viewport, [class*="workspace_viewport__viewport"]';

export const DEFAULTS = Object.freeze({
    minutes: 3,
    intervalMs: 5000,
    frontend: "http://localhost:9002",
    backend: "http://localhost:6061",
    mcp: "http://127.0.0.1:4405/mcp",
    email: "mcpdev@example.com",
    headed: false,
    loginOnly: false,
    freshFile: false,
});

const USAGE = `Usage: node scripts/human-tab/human-tab.mjs --tokens <file> --vars <vars.json> [options]

Options:
  --tokens <file>     MCP token file (first non-comment line is used). Not needed with --login-only
  --vars <file>       vars file with fileId, pageId (or pageIds) and teamId/projectId
  --minutes <n>       editing time (default 3; fractions allowed)
  --interval-ms <n>   time between edits (default 5000; the frontend persists 3 s after a change)
  --frontend <url>    dev frontend (default http://localhost:9002)
  --backend <url>     dev backend, polled for /readyz (default http://localhost:6061)
  --mcp <url>         MCP adapter endpoint (default http://127.0.0.1:4405/mcp)
  --email <address>   test profile (default mcpdev@example.com, or PENPOT_HUMAN_EMAIL)
  --results <dir>     where the JSON result is written (default packages/loadtest/results)
  --headed            show the browser window
  --login-only        log in, open the workspace and stop (no seed, no edits)
  --fresh-file        create a new file in the vars' project and run on it; writes
                      results/human-tab-vars-<file id>.json (pass that file to the agents too)
  --help              print this text

Environment: PENPOT_HUMAN_PASSWORD (required).
`;

/**
 * Parses the command line of human-tab.mjs.
 *
 * @param {string[]} argv - arguments after the script name
 * @returns {object} options, with defaults applied
 * @throws {Error} on an unknown flag or a missing value
 */
export function parseArgs(argv) {
    const opts = {
        ...DEFAULTS,
        tokens: undefined,
        vars: undefined,
        results: path.join(PKG_ROOT, "results"),
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (value === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return value;
        };
        switch (arg) {
            case "--minutes":
                opts.minutes = Number(next());
                break;
            case "--interval-ms":
                opts.intervalMs = Number(next());
                break;
            case "--frontend":
                opts.frontend = next();
                break;
            case "--backend":
                opts.backend = next();
                break;
            case "--mcp":
                opts.mcp = next();
                break;
            case "--email":
                opts.email = next();
                break;
            case "--tokens":
                opts.tokens = next();
                break;
            case "--vars":
                opts.vars = next();
                break;
            case "--results":
                opts.results = next();
                break;
            case "--headed":
                opts.headed = true;
                break;
            case "--login-only":
                opts.loginOnly = true;
                break;
            case "--fresh-file":
                opts.freshFile = true;
                break;
            case "--help":
            case "-h":
                opts.help = true;
                break;
            default:
                throw new Error(`unknown option ${arg}`);
        }
    }
    if (opts.help) {
        return opts;
    }
    if (!opts.vars) {
        throw new Error("--vars is required");
    }
    if (!opts.loginOnly && !opts.tokens) {
        throw new Error("--tokens is required (the MCP token of the test profile)");
    }
    if (!(Number.isFinite(opts.minutes) && opts.minutes > 0)) {
        throw new Error("--minutes must be a positive number");
    }
    if (!(Number.isFinite(opts.intervalMs) && opts.intervalMs >= 500)) {
        throw new Error("--interval-ms must be at least 500");
    }
    return opts;
}

/**
 * Returns the nearest-rank percentile of a list of numbers, or null for an empty list.
 *
 * @param {number[]} values
 * @param {number} p - percentile in (0, 100]
 */
export function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Summarizes save records: attempts, errors, and the percentiles of the successful round trips.
 *
 * @param {{status: number, durationMs: number | null, error?: string}[]} saves
 */
export function summarizeSaves(saves) {
    const ok = saves.filter((s) => s.status === 200 && s.durationMs !== null && !s.error);
    const durations = ok.map((s) => s.durationMs);
    return {
        count: saves.length,
        errors: saves.length - ok.length,
        p50: round(percentile(durations, 50)),
        p95: round(percentile(durations, 95)),
        max: durations.length ? round(Math.max(...durations)) : null,
    };
}

/**
 * Press-to-save: for each key press, the first successful save that was issued after the press. Penpot saves a
 * batch of changes, so several presses can share one save; each press then waits for that save. The latency runs
 * from the press to the end of the response that carries it.
 *
 * @param {{atMs: number, at: number}[]} presses
 * @param {{status: number, startEpoch: number | null, endEpoch: number | null}[]} saves
 * @returns {{atMs: number, latencyMs: number}[]} one sample per matched press
 */
export function pressToSave(presses, saves) {
    const ok = saves
        .filter((s) => s.status === 200 && s.startEpoch && s.endEpoch)
        .sort((a, b) => a.startEpoch - b.startEpoch);
    const samples = [];
    let j = 0;
    for (const press of [...presses].sort((a, b) => a.at - b.at)) {
        while (j < ok.length && ok[j].startEpoch < press.at) {
            j += 1;
        }
        if (j < ok.length) {
            samples.push({ atMs: press.atMs, latencyMs: round(ok[j].endEpoch - press.at) });
        }
    }
    return samples;
}

function summarizeNumbers(values) {
    return {
        p50: round(percentile(values, 50)),
        p95: round(percentile(values, 95)),
        max: values.length ? round(Math.max(...values)) : null,
    };
}

function round(value) {
    return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readToken(file) {
    const text = await readFile(file, "utf8");
    const line = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#"));
    if (!line) {
        throw new Error(`no token in ${file}`);
    }
    return line;
}

export async function readVarsFile(file) {
    return readVars(file);
}

async function readVars(file) {
    const vars = JSON.parse(await readFile(file, "utf8"));
    const pageId = vars.pageId ?? (Array.isArray(vars.pageIds) ? vars.pageIds[0] : undefined);
    if (typeof vars.fileId !== "string" || typeof pageId !== "string") {
        throw new Error(`${file} must hold fileId and pageId (or pageIds)`);
    }
    return { ...vars, fileId: vars.fileId, pageId };
}

/** Polls a URL until it answers 200, for up to timeoutMs. */
async function waitForReady(url, timeoutMs, label, log) {
    const end = Date.now() + timeoutMs;
    let announced = false;
    for (;;) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (response.ok) {
                return;
            }
        } catch {
            // not up yet
        }
        if (!announced) {
            log(`waiting for ${label} at ${url}`);
            announced = true;
        }
        if (Date.now() > end) {
            throw new Error(`${label} did not answer 200 at ${url} within ${Math.round(timeoutMs / 60000)} minutes`);
        }
        await sleep(5000);
    }
}

function findById(node, id) {
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findById(item, id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    if (node && typeof node === "object") {
        if (node.id === id) {
            return node;
        }
        for (const value of Object.values(node)) {
            const found = findById(value, id);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

/**
 * Calls an MCP tool, and retries when the server rate-limits the token (up to 6 times, 2 s apart).
 */
async function callWithRetry(client, name, args) {
    let out;
    for (let attempt = 1; ; attempt++) {
        out = await client.callTool(name, args);
        const limited = out.isError && /rate limited/i.test(out.text ?? "");
        if (!limited || attempt >= 6) {
            return out;
        }
        await sleep(2000 * attempt);
    }
}

async function withMcp(opts, token, fn) {
    const client = new McpLoadClient();
    await client.connect(opts.mcp, token);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

/** Creates the board this run edits, through the MCP. Returns its id. */
async function seedBoard(client, vars, name) {
    const out = await callWithRetry(client, "apply_operations", {
        fileId: vars.fileId,
        operations: [
            {
                op: "create_board",
                id: "$tmp:human",
                pageId: vars.pageId,
                name,
                x: 100,
                y: 100,
                width: 300,
                height: 200,
            },
        ],
    });
    // the server returns createdIds at the top level; accept a result wrapper too
    const id = (out.json?.result ?? out.json)?.createdIds?.["$tmp:human"];
    if (!out.ok || typeof id !== "string") {
        throw new Error(`seed board failed: ${out.error ?? out.text.slice(0, 300)}`);
    }
    return id;
}

/** Reads the x and y of one shape through the MCP. */
async function readPosition(client, vars, id) {
    const out = await callWithRetry(client, "get_shapes", { fileId: vars.fileId, pageId: vars.pageId, ids: [id] });
    if (!out.ok) {
        throw new Error(`get_shapes failed: ${out.error ?? out.text.slice(0, 300)}`);
    }
    const shape = findById(out.json, id);
    if (!shape || typeof shape.x !== "number" || typeof shape.y !== "number") {
        throw new Error(`get_shapes returned no x and y for ${id}`);
    }
    return { x: shape.x, y: shape.y };
}

async function login(page, opts, password) {
    await page.goto(`${opts.frontend}/#/auth/login`, { waitUntil: "domcontentloaded", timeout: 120000 });
    const email = page.locator('input[name="email"]');
    await email.waitFor({ state: "visible", timeout: 120000 });
    const passwordInput = page.locator('input[name="password"]');
    if (!(await passwordInput.isVisible().catch(() => false))) {
        await page
            .getByText(/log ?in with password|password/i)
            .first()
            .click({ timeout: 10000 });
        await passwordInput.waitFor({ state: "visible", timeout: 30000 });
    }
    await email.fill(opts.email);
    await passwordInput.fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForFunction(() => !location.hash.startsWith("#/auth"), null, { timeout: 120000 });
}

function workspaceUrl(opts, vars) {
    const params = new URLSearchParams();
    if (vars.teamId) {
        params.set("team-id", vars.teamId);
    }
    if (vars.projectId) {
        params.set("project-id", vars.projectId);
    }
    params.set("file-id", vars.fileId);
    params.set("page-id", vars.pageId);
    return `${opts.frontend}/#/workspace?${params.toString()}`;
}

/**
 * Selects a board by its name. The layers panel row is preferred: the board label on the canvas can sit under the
 * guides overlay, which intercepts the click.
 */
async function selectBoard(page, name) {
    const matches = page.getByText(name, { exact: true });
    const count = await matches.count();
    for (let i = 0; i < count; i++) {
        const item = matches.nth(i);
        const cls = (await item.getAttribute("class").catch(() => null)) ?? "";
        if (!cls.includes("frame-title-label")) {
            await item.click({ timeout: 60000 });
            return;
        }
    }
    await matches.first().click({ timeout: 60000, force: true });
}

/**
 * Creates a new file in the project of the vars file, through the MCP, and writes a vars file for it to
 * results/human-tab-vars-<file id>.json. A fresh file keeps the fragment rows of older runs out of the workspace
 * load (the test file has thousands of them, and a load bursts past the get-light limit).
 *
 * @returns {Promise<{file: string, vars: object}>} the written vars file and its content
 */
export async function createFreshFile(opts, vars, token, log = () => {}) {
    const created = await withMcp(opts, token, async (client) => {
        const out = await callWithRetry(client, "manage_files", {
            action: "create_file",
            projectId: vars.projectId,
            name: `human-tab ${Date.now().toString(36)}`,
        });
        const fileId = (out.json?.result ?? out.json)?.id;
        if (!out.ok || typeof fileId !== "string") {
            throw new Error(`create_file failed: ${out.error ?? out.text.slice(0, 300)}`);
        }
        const outline = await callWithRetry(client, "get_file_outline", { fileId });
        const pages = (outline.json?.result ?? outline.json)?.pages;
        if (!outline.ok || !Array.isArray(pages) || pages.length === 0) {
            throw new Error(`get_file_outline failed for ${fileId}: ${outline.error ?? outline.text.slice(0, 300)}`);
        }
        return { fileId, pageIds: pages.map((p) => p.id) };
    });
    const fresh = {
        teamId: vars.teamId,
        projectId: vars.projectId,
        fileId: created.fileId,
        pageId: created.pageIds[0],
        pageIds: created.pageIds,
        freshFile: true,
    };
    await mkdir(opts.results, { recursive: true });
    const file = path.join(opts.results, `human-tab-vars-${created.fileId}.json`);
    await writeFile(file, JSON.stringify(fresh, null, 2) + "\n");
    log(`created fresh file ${created.fileId}; vars in ${file}`);
    return { file, vars: fresh };
}

/**
 * Runs the human tab once. Resolves with the result object, which is also written to the results folder.
 *
 * @param {object} input - options from parseArgs (partial is fine; defaults fill the rest)
 * @param {{onEditingStart?: (epochMs: number) => void, log?: (line: string) => void}} [hooks]
 *        onEditingStart is called once the first edit is about to be made, with the epoch time (ms).
 */
export async function runHumanTab(input, hooks = {}) {
    const opts = { ...DEFAULTS, results: path.join(PKG_ROOT, "results"), ...input };
    const log = hooks.log ?? ((line) => console.error(`[human-tab] ${line}`));
    const password = process.env.PENPOT_HUMAN_PASSWORD;
    if (!password) {
        throw new Error(
            "PENPOT_HUMAN_PASSWORD is not set. The test profile's password is not recorded in the repo or the vars file"
        );
    }
    let vars = await readVars(opts.vars);
    const token = opts.loginOnly ? undefined : await readToken(opts.tokens);
    let freshVars = null;
    if (opts.freshFile && !opts.loginOnly) {
        freshVars = await createFreshFile(opts, vars, token, log);
        vars = freshVars.vars;
    }
    const runId = Date.now().toString(36);
    const boardName = `human-${runId}`;
    const errors = [];
    const saves = [];
    // one entry per successful key press: the offset from the start of editing and the epoch time
    const presses = [];
    const result = {
        kind: "human-tab",
        runId,
        startedAt: new Date().toISOString(),
        freshVars: freshVars ? freshVars.file : null,
        options: {
            minutes: opts.minutes,
            intervalMs: opts.intervalMs,
            frontend: opts.frontend,
            mcp: opts.mcp,
            fileId: vars.fileId,
            pageId: vars.pageId,
            loginOnly: opts.loginOnly,
        },
        login: { ok: false },
        seed: null,
        saves: [],
        saveSummary: null,
        notifications: { frames: 0, fileChange: 0, note: "frames whose text contains file-change" },
        edits: { keyPresses: 0, pressFailures: 0, expectedDelta: null, presses },
        lostEdits: null,
        errors,
    };

    // Save timing is measured against the start of the edit loop, so saves are kept as offsets from it.
    let editStartEpoch = null;
    const saveRequests = [];
    // save requests that have answered or failed, counted on the same hooks as saveRequests
    let saveSettled = 0;

    await waitForReady(`${opts.backend}/readyz`, READY_TIMEOUT_MS, "dev backend", log);

    let boardId = null;
    let start = null;
    if (!opts.loginOnly) {
        await waitForReady(new URL("/readyz", opts.mcp).href, READY_TIMEOUT_MS, "MCP adapter", log);
        await withMcp(opts, token, async (client) => {
            boardId = await seedBoard(client, vars, boardName);
            start = await readPosition(client, vars, boardId);
        });
        result.seed = { boardId, boardName, x0: start.x, y0: start.y };
        log(`seeded board ${boardName} at x=${start.x} y=${start.y}`);
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: !opts.headed });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();

        // Websocket frames come through the DevTools protocol of the context, so they are seen from the first
        // request on (a page-level listener missed the notifications socket).
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        cdp.on("Network.webSocketFrameReceived", ({ response }) => {
            result.notifications.frames += 1;
            if (String(response.payloadData ?? "").includes("file-change")) {
                result.notifications.fileChange += 1;
            }
        });

        page.on("request", (request) => {
            if (isSaveUrl(request.url())) {
                saveRequests.push(request);
            }
        });
        page.on("requestfinished", async (request) => {
            if (isSaveUrl(request.url())) {
                saveSettled += 1;
            }
            if (!isSaveUrl(request.url()) || editStartEpoch === null) {
                return;
            }
            const timing = request.timing();
            const response = await request.response().catch(() => null);
            saves.push({
                atMs: Math.round(timing.startTime - editStartEpoch),
                startEpoch: timing.startTime,
                endEpoch: timing.responseEnd >= 0 ? timing.startTime + timing.responseEnd : null,
                status: response ? response.status() : 0,
                durationMs: timing.responseEnd >= 0 ? timing.responseEnd : null,
            });
        });
        page.on("requestfailed", (request) => {
            if (isSaveUrl(request.url())) {
                saveSettled += 1;
            }
            if (!isSaveUrl(request.url()) || editStartEpoch === null) {
                return;
            }
            const timing = request.timing();
            saves.push({
                atMs: Math.round((timing.startTime > 0 ? timing.startTime : Date.now()) - editStartEpoch),
                status: 0,
                durationMs: null,
                error: request.failure()?.errorText ?? "request failed",
            });
        });

        const loginStarted = Date.now();
        await login(page, opts, password);
        result.login = { ok: true, ms: Date.now() - loginStarted };
        log("logged in");

        const openStarted = Date.now();
        await page.goto(workspaceUrl(opts, vars), { waitUntil: "domcontentloaded", timeout: 120000 });
        await page.waitForSelector(VIEWPORT_SELECTOR, { timeout: 180000 });
        result.open = { ms: Date.now() - openStarted };
        log(`workspace canvas is up after ${result.open.ms} ms`);

        if (opts.loginOnly) {
            result.login.workspace = true;
            return await finish(result, opts, saves, errors, null, log);
        }

        await selectBoard(page, boardName);
        log(`selected ${boardName}`);

        editStartEpoch = Date.now();
        hooks.onEditingStart?.(editStartEpoch);
        const deadline = editStartEpoch + opts.minutes * 60 * 1000;
        let dx = 0;
        let dy = 0;
        for (let tick = 0; ; tick++) {
            const due = editStartEpoch + tick * opts.intervalMs;
            if (due >= deadline) {
                break;
            }
            const wait = due - Date.now();
            if (wait > 0) {
                await sleep(wait);
            }
            const key = KEYS[tick % KEYS.length];
            try {
                const pressedAt = Date.now();
                await page.keyboard.press(key);
                presses.push({ atMs: pressedAt - editStartEpoch, at: pressedAt });
                result.edits.keyPresses += 1;
                if (key === "ArrowRight") {
                    dx += 1;
                } else {
                    dy += 1;
                }
            } catch (error) {
                result.edits.pressFailures += 1;
                errors.push(`key ${key} at tick ${tick}: ${error.message}`);
            }
        }
        result.edits.expectedDelta = { x: dx, y: dy };

        // Let the last save finish before the readback. A save still in flight, or one the 3 s save buffer
        // has not sent yet, would make the readback look like a lost press. Wait until every save request
        // has answered and no save has started or answered for 4 s (the buffer drains in 3 s). Cap: 60 s.
        const settleStart = Date.now();
        let seen = `${saveRequests.length}/${saveSettled}`;
        let quietSince = Date.now();
        while (Date.now() - settleStart < 60000) {
            await sleep(500);
            const now = `${saveRequests.length}/${saveSettled}`;
            if (now !== seen) {
                seen = now;
                quietSince = Date.now();
            }
            const inFlight = saveRequests.length - saveSettled;
            if (inFlight === 0 && Date.now() - quietSince >= 4000) {
                break;
            }
        }
        await sleep(1000);
        return await finish(result, opts, saves, errors, { boardId, start, dx, dy, token, vars }, log);
    } finally {
        await browser.close();
    }
}

async function finish(result, opts, saves, errors, check, log) {
    result.saves = saves;
    result.saveSummary = summarizeSaves(saves);
    const samples = pressToSave(result.edits.presses ?? [], saves);
    const latencies = samples.map((x) => x.latencyMs);
    result.pressToSave = {
        samples,
        count: samples.length,
        unmatchedPresses: (result.edits.presses ?? []).length - samples.length,
        p50: summarizeNumbers(latencies).p50,
        p95: summarizeNumbers(latencies).p95,
        max: summarizeNumbers(latencies).max,
    };
    if (check) {
        try {
            const actual = await withMcp(opts, check.token, (client) =>
                readPosition(client, check.vars, check.boardId)
            );
            const expected = { x: check.start.x + check.dx, y: check.start.y + check.dy };
            const mismatched = [actual.x !== expected.x, actual.y !== expected.y].filter(Boolean).length;
            result.lostEdits = { checked: true, expected, actual, count: mismatched };
            if (mismatched > 0) {
                errors.push(`lost edits: expected x=${expected.x} y=${expected.y}, found x=${actual.x} y=${actual.y}`);
            }
        } catch (error) {
            result.lostEdits = { checked: false, error: error.message };
            errors.push(`lost-edit check failed: ${error.message}`);
        }
    }
    result.finishedAt = new Date().toISOString();
    await mkdir(opts.results, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(opts.results, `human-tab-${stamp}.json`);
    await writeFile(file, JSON.stringify(result, null, 2) + "\n");
    result.file = file;
    log(`wrote ${file}`);
    return result;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`${error.message}\n\n${USAGE}`);
        process.exit(2);
    }
    if (opts.help) {
        console.log(USAGE);
        return;
    }
    let result;
    try {
        result = await runHumanTab(opts);
    } catch (error) {
        console.error(`human tab failed: ${error.message}`);
        process.exit(1);
    }
    console.log(
        JSON.stringify(
            {
                login: result.login.ok,
                saves: result.saveSummary,
                notifications: result.notifications,
                lostEdits: result.lostEdits,
                errors: result.errors.length,
                file: result.file,
            },
            null,
            2
        )
    );
    const failed = result.errors.length > 0 || (result.lostEdits && result.lostEdits.count > 0);
    process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
