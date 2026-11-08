// Group 5: request bodies and argument limits. Oversized, malformed, deeply nested, batched and out-of-range input
// must be refused with a clear answer. No input may crash the adapter or return more than the limit allows.
import { tool, textOf, refused, makeCase, guard, mcpRaw, mcpSession, http, uuid, sleep } from "./lib.mjs";

/** Pause before each case, so that the adapter rate limit (burst 20, 10 per second) is never exhausted. */
const PACE_MS = 250;

/**
 * Calls a tool after a pause, and waits out the adapter rate limit when it answers with one. The limit is shared by
 * every caller that uses the same token, so a refusal for rate limiting is retried, not judged.
 *
 * @param {object} control - the connected client
 * @param {string} toolName - the tool to call
 * @param {object} args - the tool arguments
 * @param {object} [opts] - the tool options, such as timeoutMs
 * @returns {Promise<object>} the outcome of the last attempt
 */
async function callPaced(control, toolName, args, opts) {
    let o;
    for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(PACE_MS);
        o = await tool(control, toolName, args, opts);
        if (!/rate limited/i.test(textOf(o))) {
            return o;
        }
        await sleep(3000);
    }
    return o;
}

/** Name of this group, as it appears in the report. */
export const name = "5-bodies";

/** Largest reply, in bytes, that an over-large list may return before it counts as unbounded. */
const REPLY_MAX_BYTES = 110000;

/**
 * Tells whether the adapter still answers /readyz with 200.
 *
 * @param {object} cfg - the configuration
 * @returns {Promise<boolean>} true when /readyz answers 200
 */
async function readyzOk(cfg) {
    const o = await http(new URL("/readyz", cfg.mcpUrl).href, { timeoutMs: 10000 });
    return o.status === 200;
}

/**
 * Tells whether the adapter still answers /healthz with 200.
 *
 * @param {object} cfg - the configuration
 * @returns {Promise<boolean>} true when /healthz answers 200
 */
async function healthzOk(cfg) {
    const o = await http(new URL("/healthz", cfg.mcpUrl).href, { timeoutMs: 10000 });
    return o.status === 200;
}

/** Notes added to every case of the given id: the Express default error page is the finding. */
const EXPRESS_NOTE =
    "Express default error page with stack trace and host paths (no error middleware after the JSON parser)";
const ID_NOTES = { 5.01: EXPRESS_NOTE, 5.02: EXPRESS_NOTE, 5.03: EXPRESS_NOTE };

/**
 * Opens an MCP session with the full token.
 *
 * @param {object} cfg - the configuration
 * @returns {Promise<string>} the session id
 */
async function sessionId(cfg) {
    const s = await mcpSession(cfg, cfg.fullToken);
    return s.sessionId;
}

/**
 * Builds a string of n characters.
 *
 * @param {number} n - the length
 * @returns {string} the string
 */
function filler(n) {
    return "x".repeat(n);
}

/**
 * Runs group 5.
 *
 * @param {{cfg: object, control: object, log: Function}} ctx - the group context
 * @returns {Promise<object[]>} the cases of the group
 */
export async function run(ctx) {
    const { cfg, control } = ctx;
    const cases = [];
    const fileId = cfg.vars.fileId;
    const pageId = cfg.vars.pageId;

    /**
     * Adds the guarded cases of one meta to the list.
     *
     * @param {object} meta - the case metadata
     * @param {Function} fn - the case body, returning a case
     */
    const add = async (meta, fn) => {
        await sleep(PACE_MS);
        const built = await guard(meta, fn);
        for (const c of built) {
            if (ID_NOTES[c.id] && c.status === "fail") {
                c.note = `${c.note ? c.note + "; " : ""}${ID_NOTES[c.id]}`;
            }
        }
        cases.push(...built);
    };

    const base = (id, title, request, expected, severity = "high") => ({
        group: name,
        id,
        title,
        request,
        expected,
        severity,
        allowText: [],
    });

    // 5.01 unauthenticated 5 MB body
    await add(
        base(
            "5.01",
            "5 MB unauthenticated body is refused",
            "POST /mcp no token, 5 MB tools/list",
            "401 or 413 within 10 s"
        ),
        async () => {
            const meta = base(
                "5.01",
                "5 MB unauthenticated body is refused",
                "POST /mcp no token, 5 MB tools/list",
                "401 or 413 within 10 s",
                "medium"
            );
            const body = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${filler(5 * 1024 * 1024)}"}}`;
            const o = await mcpRaw(cfg, { body, timeoutMs: 10000 });
            const ready = await readyzOk(cfg);
            let verdict = [401, 413].includes(o.status) ? true : `status ${o.status} for an unauthenticated 5 MB body`;
            if (verdict === true && !ready) {
                verdict = "readyz not 200 afterwards";
            }
            return makeCase(meta, o, verdict);
        }
    );

    // 5.02 authenticated 40 MB body
    await add(
        base(
            "5.02",
            "40 MB authenticated body is refused",
            "POST /mcp with session, tools/call whoami, 40 MB pad",
            "413 within 30 s"
        ),
        async () => {
            const meta = base(
                "5.02",
                "40 MB authenticated body is refused",
                "POST /mcp with session, tools/call whoami, 40 MB pad",
                "413 within 30 s",
                "medium"
            );
            const sid = await sessionId(cfg);
            const body = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{"pad":"${filler(40 * 1024 * 1024)}"}}}`;
            const o = await mcpRaw(cfg, { token: cfg.fullToken, sessionId: sid, body, timeoutMs: 30000 });
            const ready = await readyzOk(cfg);
            let verdict = o.status === 413 ? true : `status ${o.status} for a 40 MB body (expected 413)`;
            if (o.timedOut) {
                verdict = "no answer within 30 s";
            } else if (verdict === true && !ready) {
                verdict = "readyz not 200 afterwards";
            }
            return makeCase(meta, o, verdict);
        }
    );

    // 5.03 malformed JSON
    await add(
        base(
            "5.03",
            "malformed JSON is a 400",
            'POST /mcp with token and session, body {"jsonrpc":"2.0",',
            "400 with a parse error or a clear 400"
        ),
        async () => {
            const meta = base(
                "5.03",
                "malformed JSON is a 400",
                "POST /mcp with token and session, truncated JSON",
                "400 with a parse error or a clear 400",
                "medium"
            );
            const sid = await sessionId(cfg);
            const o = await mcpRaw(cfg, {
                token: cfg.fullToken,
                sessionId: sid,
                body: '{"jsonrpc":"2.0",',
                timeoutMs: 30000,
            });
            const verdict = o.status === 400 ? true : `status ${o.status} for malformed JSON (expected 400)`;
            return makeCase(meta, o, verdict);
        }
    );

    // 5.04 batch of 1000 whoami calls
    await add(
        base(
            "5.04",
            "batch of 1000 tool calls is refused or capped",
            "POST /mcp with session, JSON-RPC batch of 1000 whoami tools/call",
            "4xx, or at most 25 successful results",
            "high"
        ),
        async () => {
            const meta = base(
                "5.04",
                "batch of 1000 tool calls is refused or capped",
                "POST /mcp with session, JSON-RPC batch of 1000 whoami tools/call",
                "4xx, or at most 25 successful results",
                "high"
            );
            const sid = await sessionId(cfg);
            const batch = Array.from({ length: 1000 }, (_, i) => ({
                jsonrpc: "2.0",
                id: i + 10,
                method: "tools/call",
                params: { name: "whoami", arguments: {} },
            }));
            const o = await mcpRaw(cfg, { token: cfg.fullToken, sessionId: sid, body: batch, timeoutMs: 60000 });
            const succeeded = (o.messages ?? []).filter((m) => m && m.result && !m.result.isError).length;
            let verdict = true;
            if (o.timedOut) {
                verdict = "no answer within 60 s";
            } else if (succeeded > 25) {
                verdict = `${succeeded} whoami calls succeeded in one batch (limit 25)`;
            } else if (o.status >= 500 || o.status === 0) {
                verdict = `status ${o.status} for the batch`;
            }
            const c = makeCase(meta, o, verdict);
            c.note = `${c.note ? c.note + "; " : ""}status ${o.status}, ${succeeded} successful results`;
            return c;
        }
    );

    // 5.05 deeply nested JSON
    await add(
        base(
            "5.05",
            "10,000 levels of JSON nesting are a 4xx",
            "POST /mcp with token and session, 10000 nested objects in params",
            "4xx within 10 s; readyz 200 afterwards"
        ),
        async () => {
            const meta = base(
                "5.05",
                "10,000 levels of JSON nesting are a 4xx",
                "POST /mcp with token and session, 10000 nested objects in params",
                "4xx within 10 s; readyz 200 afterwards"
            );
            const sid = await sessionId(cfg);
            const body = `{"jsonrpc":"2.0","id":5,"method":"tools/list","params":${'{"a":'.repeat(10000)}1${"}".repeat(10000)}}`;
            const o = await mcpRaw(cfg, { token: cfg.fullToken, sessionId: sid, body, timeoutMs: 10000 });
            const ready = await readyzOk(cfg);
            let verdict;
            let severity = "high";
            if (o.timedOut) {
                verdict = "no answer within 10 s";
            } else if (o.status >= 500 || o.status === 0) {
                verdict = `status ${o.status} for deep JSON (crash or reset)`;
                severity = o.status === 500 ? "low" : "high";
            } else if (o.status >= 400 && o.status < 500) {
                verdict = true;
            } else {
                verdict = `status ${o.status} accepted the deep JSON`;
                severity = "medium";
            }
            const healthy = await healthzOk(cfg);
            const who = await callPaced(control, "whoami", {}, { timeoutMs: 15000 });
            if (!healthy || !who.ok) {
                verdict = `server did not stay up (healthz ${healthy ? 200 : "not 200"}, whoami ${who.ok ? "ok" : "failed"})`;
                severity = "high";
            } else if (verdict === true && !ready) {
                verdict = "readyz not 200 afterwards";
            }
            const c = makeCase({ ...meta, severity }, o, verdict);
            if (o.status === 500) {
                c.note = `${c.note ? c.note + "; " : ""}500 internal error instead of 4xx; the server stays up`;
            }
            return c;
        }
    );

    // 5.06 apply_operations with 2001 operations, dry run
    await add(
        base(
            "5.06",
            "2001 operations are refused (dry run)",
            "apply_operations 2001 create_rect, dryRun true",
            "refused with the batch limit named",
            "medium"
        ),
        async () => {
            const meta = base(
                "5.06",
                "2001 operations are refused (dry run)",
                "apply_operations 2001 create_rect, dryRun true",
                "refused with the batch limit named",
                "medium"
            );
            const operations = Array.from({ length: 2001 }, (_, i) => ({
                op: "create_rect",
                pageId,
                id: `$tmp:r${i}`,
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            }));
            const o = await callPaced(
                control,
                "apply_operations",
                { fileId, operations, dryRun: true },
                { timeoutMs: 60000 }
            );
            const text = textOf(o);
            let verdict;
            if (o.ok) {
                verdict = "limit not enforced on dry runs";
            } else if (!refused(o)) {
                verdict = "neither accepted nor refused clearly";
            } else if (!/batch|too[- ](big|large|many)|limit|maximum|at most|<=|2000|2,000/i.test(text)) {
                verdict = "refusal does not name the limit";
            } else {
                verdict = true;
            }
            return makeCase(meta, o, verdict);
        }
    );

    // 5.07 get_shapes with 1000 ids
    await add(
        base(
            "5.07",
            "get_shapes with 1000 ids is refused or bounded",
            "get_shapes with 1000 random uuids",
            "refused by validation, or answered within 15 s under 110 kB",
            "medium"
        ),
        async () => {
            const meta = base(
                "5.07",
                "get_shapes with 1000 ids is refused or bounded",
                "get_shapes with 1000 random uuids",
                "refused by validation, or answered within 15 s under 110 kB",
                "medium"
            );
            const ids = Array.from({ length: 1000 }, () => uuid());
            const o = await callPaced(control, "get_shapes", { fileId, pageId, ids }, { timeoutMs: 15000 });
            let verdict;
            if (o.timedOut) {
                verdict = "no answer within 15 s";
            } else if (refused(o)) {
                verdict = /200|max|too[- ](many|big|large)|at most|limit|<=|maximum|ids/i.test(textOf(o))
                    ? true
                    : "refusal does not name the id limit";
            } else if ((o.bytes ?? textOf(o).length) < REPLY_MAX_BYTES) {
                verdict = true;
            } else {
                verdict = `accepted 1000 ids with a ${o.bytes ?? "large"} byte reply`;
            }
            return makeCase(meta, o, verdict);
        }
    );

    // 5.08 limit 999999 on four tools
    const limitCases = [
        ["get_page_tree", { fileId, pageId, limit: 999999 }],
        ["find_shapes", { fileId, pageId, limit: 999999 }],
        ["list_files", { projectId: cfg.vars.projectId, limit: 999999 }],
        ["comments", { fileId, action: "list", limit: 999999 }],
    ];
    for (const [toolName, args] of limitCases) {
        const title = `${toolName} with limit 999999 is refused`;
        const request = `${toolName} ${JSON.stringify(args)}`;
        await add(base("5.08", title, request, "refused by validation, text names the limit", "medium"), async () => {
            const meta = base("5.08", title, request, "refused by validation, text names the limit", "medium");
            const o = await callPaced(control, toolName, args, { timeoutMs: 15000 });
            let verdict;
            if (o.timedOut) {
                verdict = "no answer within 15 s";
            } else if (!refused(o)) {
                verdict = "accepted limit 999999";
            } else if (!/limit|maximum|max|too[- ](big|large)|<=|at most|1000|5000/i.test(textOf(o))) {
                verdict = "refusal does not name the limit";
            } else {
                verdict = true;
            }
            return makeCase(meta, o, verdict);
        });
    }

    // 5.09 get_page_tree with depth 1000000
    await add(
        base(
            "5.09",
            "get_page_tree with depth 1000000 is refused or bounded",
            "get_page_tree depth 1000000",
            "refused by validation, or bounded within 15 s",
            "medium"
        ),
        async () => {
            const meta = base(
                "5.09",
                "get_page_tree with depth 1000000 is refused or bounded",
                "get_page_tree depth 1000000",
                "refused by validation, or bounded within 15 s",
                "medium"
            );
            const o = await callPaced(
                control,
                "get_page_tree",
                { fileId, pageId, depth: 1000000 },
                { timeoutMs: 15000 }
            );
            let verdict;
            if (o.timedOut) {
                verdict = "no answer within 15 s";
            } else if (refused(o)) {
                verdict = /depth|max|too[- ](big|large)|<=|at most|limit/i.test(textOf(o))
                    ? true
                    : "refusal does not name the depth limit";
            } else if ((o.bytes ?? textOf(o).length) < REPLY_MAX_BYTES) {
                verdict = true;
            } else {
                verdict = "accepted depth 1000000 with an unbounded reply";
            }
            return makeCase(meta, o, verdict);
        }
    );

    // 5.10 tools/call with a 3.9 MB argument and no token
    await add(
        base(
            "5.10",
            "unauthenticated tools/call is refused",
            "POST /mcp no token, tools/call whoami, 3.9 MB pad",
            "401 (no tool result)",
            "critical"
        ),
        async () => {
            const meta = base(
                "5.10",
                "unauthenticated tools/call is refused",
                "POST /mcp no token, tools/call whoami, 3.9 MB pad",
                "401 (no tool result)",
                "critical"
            );
            const body = `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"whoami","arguments":{"pad":"${filler(Math.floor(3.9 * 1024 * 1024))}"}}}`;
            const o = await mcpRaw(cfg, { body, timeoutMs: 30000 });
            let verdict;
            if (o.timedOut) {
                verdict = "no answer within 30 s";
            } else if (o.status === 401 || o.status === 403) {
                verdict = true;
            } else if (
                o.status === 200 &&
                (o.messages ?? []).some((m) => m && m.result !== undefined && !m.result.isError)
            ) {
                verdict = "tool executed without a token";
            } else if (o.status === 200 && /unauth|token|auth|401/i.test(textOf(o))) {
                verdict = true;
            } else if (o.status >= 400 && o.status < 500) {
                verdict = true;
            } else {
                verdict = `status ${o.status} for an unauthenticated tool call`;
            }
            return makeCase(meta, o, verdict);
        }
    );

    return cases;
}
