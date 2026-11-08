// Shared helpers for the adversarial suite: config, MCP and HTTP calls, redaction, leak checks and case builders.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpLoadClient } from "../../dist/McpLoadClient.js";

/** Largest response body the suite keeps, in bytes. */
const MAX_KEEP_BYTES = 2 * 1024 * 1024;

/** Largest slice of the adapter log that the suite reads, in bytes. */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** Config of the last {@link loadConfig} call. Used by {@link redact} and {@link makeCase} when no config is given. */
let activeCfg = undefined;

/** Clients opened by {@link connect}, so the runner can close them all. */
const openClients = new Set();

/**
 * Reads a file when it exists.
 *
 * @param {string | undefined} path - file to read
 * @returns {string | undefined} the text, or undefined when the path is unset or the file is missing
 */
function readOptional(path) {
    if (!path || !existsSync(path)) {
        return undefined;
    }
    return readFileSync(path, "utf8");
}

/**
 * Reads a required token file and trims it.
 *
 * @param {string | undefined} path - file to read
 * @param {string} name - environment variable name, for the error message
 * @returns {string} the trimmed text
 */
function requireFile(path, name) {
    if (!path) {
        throw new Error(`${name} is required: set it to a file path`);
    }
    if (!existsSync(path)) {
        throw new Error(`${name} points at a missing file`);
    }
    const text = readFileSync(path, "utf8").trim();
    if (!text) {
        throw new Error(`${name} points at an empty file`);
    }
    return text;
}

/**
 * Reads one token from the token folder of setup-dev.sh.
 *
 * @param {string | undefined} dir - token folder, or undefined
 * @param {string} file - file name inside the folder
 * @returns {string | undefined} the trimmed token, or undefined when absent
 */
function tokenIn(dir, file) {
    if (!dir) {
        return undefined;
    }
    const text = readOptional(join(dir, file));
    const value = text?.trim();
    return value ? value : undefined;
}

/**
 * Reads the auth-token value of a Netscape cookie file.
 *
 * @param {string | undefined} path - cookie file, or undefined
 * @returns {string | undefined} the cookie value, or undefined when absent
 */
function cookieValueOf(path) {
    const text = readOptional(path);
    if (text === undefined) {
        return undefined;
    }
    for (const raw of text.split(/\r?\n/)) {
        let line = raw;
        if (line.startsWith("#HttpOnly_")) {
            line = line.slice("#HttpOnly_".length);
        } else if (line.startsWith("#") || line.trim() === "") {
            continue;
        }
        const columns = line.split("\t");
        if (columns[5] === "auth-token" && columns[6]) {
            return columns[6].trim();
        }
    }
    return undefined;
}

/**
 * Builds the suite configuration from environment variables. See the brief for each variable.
 *
 * @param {Record<string, string | undefined>} env - environment, default process.env
 * @returns {object} the config (Cfg)
 * @throws {Error} when a required variable or file is missing or malformed
 */
export function loadConfig(env = process.env) {
    const fullToken = requireFile(env.ADV_TOKEN_FILE, "ADV_TOKEN_FILE");

    const varsSource = env.ADV_VARS;
    if (!varsSource) {
        throw new Error("ADV_VARS is required: set it to the vars.json path");
    }
    const varsText = varsSource.trim().startsWith("{") ? varsSource : readFileSync(varsSource, "utf8");
    let vars;
    try {
        vars = JSON.parse(varsText);
    } catch {
        throw new Error("ADV_VARS is not valid JSON");
    }
    for (const key of ["profileId", "teamId", "projectId", "fileId", "pageId"]) {
        if (!vars[key]) {
            throw new Error(`ADV_VARS is missing "${key}"`);
        }
    }

    const agentTokens = (readOptional(env.ADV_AGENT_TOKENS) ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const tokenDir = env.ADV_TOKEN_DIR || undefined;
    const idsText = readOptional(tokenDir ? join(tokenDir, "adv-ids.json") : undefined);
    let advIds = {};
    if (idsText !== undefined) {
        try {
            advIds = JSON.parse(idsText);
        } catch {
            throw new Error("adv-ids.json is not valid JSON");
        }
    }

    const groupsText = env.ADV_GROUPS?.trim();
    const groups = groupsText
        ? groupsText
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n))
        : null;

    const cfg = {
        mcpUrl: env.ADV_MCP_URL || "http://127.0.0.1:4405/mcp",
        backendUrl: (env.ADV_BACKEND_URL || "http://localhost:6061").replace(/\/+$/, ""),
        publicUrl: (env.ADV_PUBLIC_URL || "http://localhost:9002").replace(/\/+$/, ""),
        fullToken,
        readToken: tokenIn(tokenDir, "adv-read.txt"),
        offToken: tokenIn(tokenDir, "adv-off.txt"),
        expToken: tokenIn(tokenDir, "adv-exp.txt"),
        revokedToken: tokenIn(tokenDir, "adv-revoked.txt"),
        outsiderToken: tokenIn(tokenDir, "adv-outsider.txt"),
        agentTokens,
        vars,
        advIds,
        sessionCookie: cookieValueOf(env.ADV_SESSION_COOKIE_FILE),
        exportDir: env.ADV_EXPORT_DIR || join(homedir(), "penpot-exports"),
        importDir: env.ADV_IMPORT_DIR || join(homedir(), "penpot-imports"),
        adapterLog: env.ADV_ADAPTER_LOG || undefined,
        outFile: env.ADV_OUT || join(tmpdir(), "penpot-adversarial-report.json"),
        groups: groups && groups.length > 0 ? groups : null,
        scratchDir: mkdtempSync(join(tmpdir(), "penpot-adv-")),
    };
    activeCfg = cfg;
    return cfg;
}

/**
 * Lists every secret value of the config: tokens and the session cookie.
 *
 * @param {object} cfg - config
 * @returns {string[]} the non-empty secret values, longest first
 */
function secretsOf(cfg) {
    const values = [
        cfg.fullToken,
        cfg.readToken,
        cfg.offToken,
        cfg.expToken,
        cfg.revokedToken,
        cfg.outsiderToken,
        cfg.sessionCookie,
        ...(cfg.agentTokens ?? []),
    ];
    return values.filter((v) => typeof v === "string" && v.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Replaces every token and cookie value of the config with `<secret>`.
 *
 * @param {string} text - text to clean
 * @param {object} [cfg] - config, default the last loaded one
 * @returns {string} the cleaned text
 */
export function redact(text, cfg = activeCfg) {
    let out = String(text ?? "");
    if (!cfg) {
        return out;
    }
    for (const secret of secretsOf(cfg)) {
        out = out.split(secret).join("<secret>");
    }
    return out;
}

/**
 * Opens an MCP client with a bearer token.
 *
 * @param {object} cfg - config
 * @param {string} token - bearer token
 * @returns {Promise<McpLoadClient>} the connected client
 */
export async function connect(cfg, token) {
    const client = new McpLoadClient();
    await client.connect(cfg.mcpUrl, token);
    openClients.add(client);
    return client;
}

/**
 * Closes every client that {@link connect} opened. Errors are ignored.
 *
 * @returns {Promise<void>}
 */
export async function closeAll() {
    for (const client of openClients) {
        try {
            await client.close();
        } catch {
            // a closed or broken client needs no more work
        }
    }
    openClients.clear();
}

/**
 * Calls an MCP tool with a timeout. Never throws.
 *
 * Rate-limited answers (text "rate limited, retry after N s") are retried after N s + 200 ms, up to 4 times, unless
 * `noRetry` is true. The returned outcome is the last one, with `rateLimitRetries` set to the number of retries.
 * Timeouts above 55 s bypass the SDK's default 60 s request timeout by calling the SDK client directly.
 *
 * @param {McpLoadClient} client - connected client
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {{ timeoutMs?: number, noRetry?: boolean }} [options] - timeoutMs default 60000; noRetry true disables the
 *   rate-limit retry (flood cases pass it)
 * @returns {Promise<object>} the outcome: ok, isError, text, json, error, durationMs, timedOut, bytes, rateLimitRetries
 */
export async function tool(client, name, args, { timeoutMs = 60000, noRetry = false } = {}) {
    let outcome = await callOnce(client, name, args ?? {}, timeoutMs);
    let retries = 0;
    while (!noRetry && retries < 4) {
        const match = /rate limited, retry after (\d+) s/.exec(outcome.text ?? "");
        if (!match) {
            break;
        }
        await sleep(Number(match[1]) * 1000 + 200);
        retries++;
        outcome = await callOnce(client, name, args ?? {}, timeoutMs);
    }
    return { ...outcome, rateLimitRetries: retries };
}

/**
 * One tool call with the race timer. Never throws.
 *
 * @param {McpLoadClient} client - connected client
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {number} timeoutMs - timeout in milliseconds
 * @returns {Promise<object>} the outcome
 */
async function callOnce(client, name, args, timeoutMs) {
    const started = performance.now();
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs + (timeoutMs > 55000 ? 5000 : 0));
    });
    const call = (timeoutMs > 55000 ? sdkCall(client, name, args, timeoutMs) : client.callTool(name, args))
        .then((outcome) => ({ outcome }))
        .catch((error) => ({ failure: error instanceof Error ? error.message : String(error) }));
    try {
        const settled = await Promise.race([call, timeout]);
        const elapsed = Math.round(performance.now() - started);
        if (settled.timedOut) {
            return {
                ok: false,
                isError: true,
                timedOut: true,
                text: "",
                json: undefined,
                error: `timeout after ${timeoutMs} ms`,
                durationMs: elapsed,
                bytes: 0,
            };
        }
        if (settled.failure !== undefined) {
            return {
                ok: false,
                isError: true,
                timedOut: false,
                text: "",
                json: undefined,
                error: settled.failure,
                durationMs: elapsed,
                bytes: 0,
            };
        }
        const o = settled.outcome;
        return {
            ok: o.ok,
            isError: o.isError,
            timedOut: false,
            text: o.text,
            json: o.json,
            error: o.error,
            durationMs: Math.round(o.durationMs ?? elapsed),
            bytes: o.bytes ?? 0,
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Calls a tool through the SDK client with a request timeout above the 60 s default, and builds the same outcome
 * shape that McpLoadClient builds. Reads the SDK client from McpLoadClient's private field `client`.
 *
 * @param {McpLoadClient} client - connected client
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {number} timeoutMs - request timeout in milliseconds
 * @returns {Promise<object>} the outcome (durationMs, ok, text, isError, bytes, json)
 */
async function sdkCall(client, name, args, timeoutMs) {
    const started = performance.now();
    const sdk = client.client;
    if (!sdk) {
        throw new Error("callTool was called before connect");
    }
    // SDK 2.x: callTool(params, options); the request timeout is an option, not a third argument
    const result = await sdk.callTool(
        { name, arguments: args },
        {
            timeout: timeoutMs,
            resetTimeoutOnProgress: false,
        }
    );
    const text = (Array.isArray(result.content) ? result.content : [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    const isError = result.isError === true || text.startsWith("Tool execution failed:");
    let json;
    try {
        json = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
        json = undefined;
    }
    return {
        durationMs: performance.now() - started,
        ok: !isError,
        text,
        isError,
        bytes: Buffer.byteLength(text, "utf8"),
        json,
    };
}

/**
 * Reads a response body, keeping at most MAX_KEEP_BYTES.
 *
 * @param {Response} res - fetch response
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>} the kept bytes
 */
async function readCapped(res) {
    const reader = res.body?.getReader?.();
    if (!reader) {
        return { buffer: Buffer.alloc(0), truncated: false };
    }
    const parts = [];
    let kept = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const room = MAX_KEEP_BYTES - kept;
        if (value.length > room) {
            parts.push(Buffer.from(value.subarray(0, room)));
            kept = MAX_KEEP_BYTES;
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
        }
        parts.push(Buffer.from(value));
        kept += value.length;
    }
    return { buffer: Buffer.concat(parts), truncated };
}

/**
 * Makes one HTTP request. Never throws: a network error is status 0.
 *
 * @param {string} url - full URL
 * @param {object} [options] - method, headers, body (string, Buffer or JSON-able object), timeoutMs, redirect
 * @returns {Promise<object>} HttpOutcome: status, headers, text, json, durationMs, error?, timedOut?, isError, ok
 */
export async function http(url, { method = "GET", headers = {}, body, timeoutMs = 30000, redirect = "manual" } = {}) {
    const started = performance.now();
    const init = { method, headers: { ...headers }, redirect, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
        if (typeof body === "string" || Buffer.isBuffer(body)) {
            init.body = body;
        } else {
            init.body = JSON.stringify(body);
            const hasType = Object.keys(init.headers).some((k) => k.toLowerCase() === "content-type");
            if (!hasType) {
                init.headers["Content-Type"] = "application/json";
            }
        }
    }
    try {
        const res = await fetch(url, init);
        const outHeaders = {};
        res.headers.forEach((value, key) => {
            outHeaders[key.toLowerCase()] = value;
        });
        const { buffer, truncated } = await readCapped(res);
        const text = buffer.toString("utf8");
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        const isError = res.status === 0 || res.status >= 400;
        return {
            status: res.status,
            headers: outHeaders,
            text,
            json,
            truncated,
            durationMs: Math.round(performance.now() - started),
            isError,
            ok: !isError,
        };
    } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        const message = [error?.message, error?.cause?.message].filter(Boolean).join(": ") || "request failed";
        return {
            status: 0,
            headers: {},
            text: "",
            json: undefined,
            truncated: false,
            durationMs: Math.round(performance.now() - started),
            error: timedOut ? `timeout after ${timeoutMs} ms` : message,
            timedOut,
            isError: true,
            ok: false,
        };
    }
}

/**
 * Calls a backend RPC command.
 *
 * @param {object} cfg - config
 * @param {string} command - command name, kebab-case, for example mcp-whoami
 * @param {object} [params] - JSON body, default {}
 * @param {{ token?: string, cookie?: string, headers?: object, timeoutMs?: number, base?: string }} [options]
 * @returns {Promise<object>} HttpOutcome
 */
export async function rpc(cfg, command, params, { token, cookie, headers = {}, timeoutMs = 30000, base } = {}) {
    const h = { Accept: "application/json", "X-Client": "penpot-mcp", ...headers };
    if (token) {
        h.Authorization = `Token ${token}`;
    }
    if (cookie) {
        h.Cookie = `auth-token=${cookie}`;
    }
    return http(`${base ?? cfg.backendUrl}/api/rpc/command/${command}`, {
        method: "POST",
        headers: h,
        body: params ?? {},
        timeoutMs,
    });
}

/**
 * Posts one body to the adapter MCP endpoint and reads the messages of the answer.
 *
 * @param {object} cfg - config
 * @param {object} [options] - token, body (string, Buffer or object), headers, sessionId, timeoutMs
 * @returns {Promise<object>} HttpOutcome plus messages (parsed JSON objects of the body or of its data lines)
 */
export async function mcpRaw(cfg, { token, body, headers = {}, sessionId, timeoutMs = 30000 } = {}) {
    const h = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...headers,
    };
    if (token) {
        h.Authorization = `Bearer ${token}`;
    }
    if (sessionId) {
        h["mcp-session-id"] = sessionId;
    }
    let payload = body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
        payload = JSON.stringify(body);
    }
    const res = await http(cfg.mcpUrl, { method: "POST", headers: h, body: payload, timeoutMs });
    let messages = [];
    const contentType = res.headers["content-type"] ?? "";
    if (contentType.includes("text/event-stream")) {
        for (const line of res.text.split(/\r?\n/)) {
            if (line.startsWith("data:")) {
                const data = line.slice(5).trim();
                if (data) {
                    try {
                        messages.push(JSON.parse(data));
                    } catch {
                        // a data line that is not JSON is not a message
                    }
                }
            }
        }
    } else if (res.json !== undefined) {
        messages = Array.isArray(res.json) ? res.json : [res.json];
    }
    return { ...res, messages };
}

/**
 * Opens a raw MCP session (initialize, then notifications/initialized).
 *
 * @param {object} cfg - config
 * @param {string} token - bearer token
 * @returns {Promise<{ sessionId: string, protocolVersion: string }>} the session
 * @throws {Error} when the server gives no session id
 */
export async function mcpSession(cfg, token) {
    const init = await mcpRaw(cfg, {
        token,
        body: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "adv-suite", version: "1" },
            },
        },
    });
    if (init.status !== 200) {
        throw new Error(
            `mcpSession: initialize answered HTTP ${init.status} ${redact(textOf(init), cfg).slice(0, 200)}`
        );
    }
    // the adapter may run stateless: then it sends no mcp-session-id and sessionId stays undefined
    const sessionId = init.headers["mcp-session-id"];
    const result = init.messages.find((m) => m && m.result)?.result;
    const protocolVersion = result?.protocolVersion ?? "2025-06-18";
    await mcpRaw(cfg, {
        token,
        sessionId,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    return { sessionId, protocolVersion };
}

/**
 * Returns the text of an outcome, or its error message.
 *
 * @param {object} outcome - tool or HTTP outcome
 * @returns {string} the text, or the error, or ""
 */
export function textOf(outcome) {
    return outcome?.text || outcome?.error || "";
}

/**
 * Tells whether an outcome is a refusal: an error result, an HTTP 4xx or 5xx, a timeout, or a JSON-RPC error.
 *
 * @param {object} outcome - tool or HTTP outcome, with optional messages
 * @returns {boolean} true when refused
 */
export function refused(outcome) {
    if (!outcome) {
        return true;
    }
    if (outcome.isError || (outcome.status ?? 0) >= 400 || outcome.timedOut) {
        return true;
    }
    return Array.isArray(outcome.messages) && outcome.messages.some((m) => m && m.error);
}

/**
 * Patterns that must never reach an answer, with the name reported for each.
 *
 * @type {Array<[string, RegExp]>}
 */
const LEAK_PATTERNS = [
    ["java-class", /java\./],
    ["clojure-class", /clojure\.lang/],
    ["postgres-class", /org\.postgresql/],
    ["psql-exception", /PSQLException/],
    ["exception-thread", /Exception in thread/],
    ["node-modules-path", /node_modules/],
    ["drive-path", /(?<![A-Za-z0-9])[A-Za-z]:\\/],
    ["work-path", /\/work\//],
    ["home-path", /\/home\//],
    ["opt-path", /\/opt\//],
    ["clojure-source-line", /\.clj[cs]?:\d+/],
    ["js-source-line", /\.(ts|js|mjs):\d+:\d+/],
    ["js-stack-frame", /\n\s+at .*\(.*:\d+:\d+\)/],
    ["sql-select", /\bSELECT\b.*\bFROM\b/],
    ["sql-insert", /\bINSERT INTO\b/],
    ["sql-update", /\bUPDATE\b.*\bSET\b/],
    ["sql-error", /ERROR:\s+/],
];

/**
 * Finds leak patterns in a text.
 *
 * @param {string} text - text to check
 * @param {object} cfg - config, for the ids that must not appear
 * @param {{ allowIds?: string[] }} [options] - ids that may appear
 * @returns {string[]} the names of the patterns found, empty when clean
 */
export function leaks(text, cfg, { allowIds = [] } = {}) {
    const found = [];
    const body = String(text ?? "");
    for (const [name, pattern] of LEAK_PATTERNS) {
        if (pattern.test(body)) {
            found.push(name);
        }
    }
    const ids = [];
    for (const [key, value] of Object.entries(cfg?.advIds ?? {})) {
        if (typeof value === "string" && value.length >= 8) {
            ids.push([`adv-id:${key}`, value]);
        }
    }
    if (cfg?.vars?.profileId) {
        ids.push(["vars.profileId", cfg.vars.profileId]);
    }
    for (const [name, value] of ids) {
        if (!allowIds.includes(value) && body.includes(value)) {
            found.push(name);
        }
    }
    return found;
}

/**
 * Builds one case from its metadata, the outcome and the verdict. Runs the leak check on the observed text.
 *
 * @param {object} meta - { group, id, title, request, expected, severity?, allowText?, allowIds? }
 * @param {object} outcome - tool or HTTP outcome
 * @param {boolean | string | { status: "not-testable", note: string }} verdict - true, a fail reason, or not-testable
 * @returns {object} the Case
 */
export function makeCase(meta, outcome, verdict) {
    if (verdict && typeof verdict === "object" && verdict.status === "not-testable") {
        return notTestable(meta, verdict.note);
    }
    const cfg = activeCfg;
    const full = textOf(outcome);
    let scrubbed = full;
    for (const piece of meta.allowText ?? []) {
        if (piece) {
            scrubbed = scrubbed.split(piece).join("");
        }
    }
    const observed = redact(
        `HTTP ${outcome?.status ?? "-"} / isError=${Boolean(outcome?.isError)} / ${full.slice(0, 600)}`,
        cfg
    );
    const leakNames = leaks(redact(scrubbed, cfg), cfg, { allowIds: meta.allowIds ?? [] });

    let status = verdict === true ? "pass" : "fail";
    let note = "";
    if (status === "fail") {
        note = typeof verdict === "string" && verdict ? verdict : "assertion failed";
    }
    if (leakNames.length > 0) {
        status = "fail";
        note = [note, `leak: ${leakNames.join(", ")}`].filter(Boolean).join("; ");
    }
    return {
        group: meta.group,
        id: meta.id,
        title: meta.title,
        request: redact(meta.request ?? "", cfg),
        expected: meta.expected ?? "",
        status,
        observed,
        note: redact(note, cfg),
        severity: meta.severity ?? "medium",
        durationMs: typeof outcome?.durationMs === "number" ? Math.round(outcome.durationMs) : 0,
    };
}

/**
 * Builds a case that could not run here, with the reason.
 *
 * @param {object} meta - { group, id, title, request, expected, severity? }
 * @param {string} reason - why the case cannot run, and the manual steps
 * @returns {object} the Case with status not-testable
 */
export function notTestable(meta, reason) {
    const cfg = activeCfg;
    return {
        group: meta.group,
        id: meta.id,
        title: meta.title,
        request: redact(meta.request ?? "", cfg),
        expected: meta.expected ?? "",
        status: "not-testable",
        observed: "",
        note: redact(reason, cfg),
        severity: meta.severity ?? "medium",
        durationMs: 0,
    };
}

/**
 * Runs a case body. An exception becomes one failing case, so a broken case never stops the group.
 *
 * @param {object} meta - { group, id, title, request?, expected?, severity? } of the case that threw
 * @param {() => Promise<object | object[] | undefined>} fn - the case body
 * @returns {Promise<object[]>} the cases
 */
export async function guard(meta, fn) {
    try {
        const result = await fn();
        if (result === undefined || result === null) {
            return [];
        }
        return (Array.isArray(result) ? result : [result]).filter(Boolean);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [
            {
                group: meta.group,
                id: meta.id,
                title: meta.title,
                request: redact(meta.request ?? "", activeCfg),
                expected: meta.expected ?? "no suite error",
                status: "fail",
                observed: "",
                note: redact(`suite error: ${message}`, activeCfg),
                severity: meta.severity ?? "medium",
                durationMs: 0,
            },
        ];
    }
}

/**
 * Checks that the stack answers: /readyz is 200 and get_file_outline on the test file is ok, within 30 s.
 *
 * @param {object} cfg - config
 * @param {McpLoadClient} control - connected client with the full token
 * @param {string} [group] - group name, used in the case id
 * @returns {Promise<object>} the Case
 */
export async function healthCheck(cfg, control, group = "health") {
    const meta = {
        group,
        id: `${group}.health`,
        title: "stack healthy after group",
        request: "GET /readyz; tool get_file_outline {fileId: vars.fileId}",
        expected: "/readyz 200 and get_file_outline ok within 30 s",
        severity: "high",
        allowIds: [cfg.vars.profileId],
    };
    const started = performance.now();
    const ready = await http(new URL("/readyz", cfg.mcpUrl).href, { timeoutMs: 30000 });
    const left = Math.max(1000, 30000 - (performance.now() - started));
    const outline = await tool(control, "get_file_outline", { fileId: cfg.vars.fileId }, { timeoutMs: left });
    const combined = {
        status: ready.status,
        isError: !(ready.status === 200 && outline.ok && !outline.isError),
        text: ready.status === 200 ? textOf(outline) : `readyz HTTP ${ready.status} ${ready.text.slice(0, 200)}`,
        durationMs: performance.now() - started,
    };
    let verdict = true;
    if (ready.status !== 200) {
        verdict = `/readyz answered HTTP ${ready.status}`;
    } else if (!outline.ok || outline.isError) {
        verdict = `get_file_outline failed: ${textOf(outline).slice(0, 200)}`;
    } else if (performance.now() - started > 30000) {
        verdict = "health check took longer than 30 s";
    }
    return makeCase(meta, combined, verdict);
}

/**
 * Creates a fresh page on the test file, so a case can work on its own page.
 *
 * @param {McpLoadClient} control - connected client with the full token
 * @param {object} cfg - config
 * @param {string} label - page name
 * @returns {Promise<string>} the new page id
 * @throws {Error} when the server does not return the page id
 */
export async function freshPage(control, cfg, label) {
    const o = await tool(
        control,
        "apply_operations",
        {
            fileId: cfg.vars.fileId,
            snapshot: false,
            operations: [{ op: "create_page", id: "$tmp:page", name: label }],
        },
        { timeoutMs: 60000 }
    );
    const id = o.json?.createdIds?.["$tmp:page"];
    if (!id) {
        throw new Error(`freshPage: no page id (${redact(textOf(o), cfg).slice(0, 300)})`);
    }
    return id;
}

/**
 * Makes a random UUID.
 *
 * @returns {string} a UUID v4
 */
export function uuid() {
    return randomUUID();
}

/**
 * Waits.
 *
 * @param {number} ms - milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A valid 1x1 PNG image.
 *
 * @returns {string} base64 of the PNG
 */
export function pngBase64() {
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
}

/**
 * Reads the last 2 MB of the adapter log.
 *
 * @param {string} path - log file
 * @returns {string | undefined} the text, or undefined when the file cannot be read
 */
export function readLogTail(path) {
    if (!path) {
        return undefined;
    }
    let fd;
    try {
        const size = statSync(path).size;
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fd = openSync(path, "r");
        readSync(fd, buffer, 0, length, size - length);
        return buffer.toString("utf8");
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}
