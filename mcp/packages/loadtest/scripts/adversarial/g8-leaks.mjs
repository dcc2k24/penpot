// Group 8: refusals are clear and leak nothing (no stack, SQL, class names or foreign ids). Also /metrics access and
// X-Request-Id injection.
import {
    connect,
    freshPage,
    guard,
    http,
    makeCase,
    mcpRaw,
    mcpSession,
    notTestable,
    readLogTail,
    redact,
    refused,
    rpc,
    textOf,
    tool,
    uuid,
} from "./lib.mjs";

/** Group name, used in the report and the runner. */
export const name = "8-leaks";

/** A refusal text must name a code or say what is wrong. */
const CLEAR = /[a-z]+-[a-z-]+|invalid|not found|required|must|expected/i;

/** Hostile X-Request-Id values. Node refuses the ones with control characters. */
const REQUEST_IDS = [
    "<script>alert(1)</script>",
    "../../etc/passwd",
    "a".repeat(300),
    "id with spaces;and=semicolons",
    "\u001b[31mred",
];

/** The only shape an X-Request-Id may take in a response. */
const ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Builds the metadata of one case of this group.
 *
 * @param {string} id - case id, for example 8.01
 * @param {string} title - one line
 * @param {string} request - one line: what is sent
 * @param {string} expected - one line: what must happen
 * @param {string} [severity] - severity if it fails, default medium
 * @param {object} [extra] - more fields for makeCase, such as allowIds
 * @returns {object} the metadata
 */
function metaOf(id, title, request, expected, severity = "medium", extra = {}) {
    return { group: name, id, title, request, expected, severity, ...extra };
}

/**
 * Checks that a tool outcome is a refusal with a clear text, optionally naming a code.
 *
 * @param {object} o - tool outcome
 * @param {RegExp} [codeRe] - the text must match this
 * @returns {true | string} true, or the reason it fails
 */
function refusedClearly(o, codeRe) {
    if (!refused(o)) {
        return "request was not refused";
    }
    const text = textOf(o);
    if (codeRe && !codeRe.test(text)) {
        return `error does not name ${codeRe.source}`;
    }
    if (!CLEAR.test(text)) {
        return "error text is not clear";
    }
    return true;
}

/**
 * Calls one tool with a token of its own. A connect refusal becomes an error outcome.
 *
 * @param {object} cfg - config
 * @param {string} token - bearer token
 * @param {string} toolName - tool name
 * @param {object} args - tool arguments
 * @returns {Promise<object>} the outcome
 */
async function callAs(cfg, token, toolName, args) {
    let client;
    try {
        client = await connect(cfg, token);
    } catch (error) {
        return {
            ok: false,
            isError: true,
            timedOut: false,
            text: "",
            error: redact(String(error?.message ?? error), cfg),
            durationMs: 0,
        };
    }
    try {
        return await tool(client, toolName, args);
    } finally {
        await client.close().catch(() => {});
    }
}

/**
 * Sends each hostile X-Request-Id and checks the answer, the response header and (optionally) the adapter log.
 *
 * @param {object} cfg - config
 * @param {(index: number, value: string) => Promise<object>} sendOne - sends one request, returns its HttpOutcome
 * @param {(o: object) => boolean} answered - true when the answer is a success
 * @param {boolean} useLog - also read the adapter log for verbatim injected values
 * @returns {Promise<{ failures: string[], notes: string[], evidence: boolean }>} the findings
 */
async function sendRequestIds(cfg, sendOne, answered, useLog) {
    const failures = [];
    const notes = [];
    let evidence = false;
    for (let i = 0; i < REQUEST_IDS.length; i++) {
        const value = REQUEST_IDS[i];
        const o = await sendOne(i, value);
        if (o.status === 0) {
            if (/invalid|header/i.test(o.error ?? "")) {
                notes.push(`value ${i + 1}: not sent (Node refuses the header)`);
            } else {
                failures.push(`value ${i + 1}: transport failed`);
            }
            continue;
        }
        if (!answered(o)) {
            failures.push(`value ${i + 1}: call not answered (HTTP ${o.status})`);
        }
        const rid = o.headers?.["x-request-id"];
        if (rid !== undefined) {
            evidence = true;
            if (rid === value) {
                failures.push(`value ${i + 1}: response echoes the injected id`);
            }
            if (!ID_SHAPE.test(rid)) {
                failures.push(`value ${i + 1}: response x-request-id has a bad shape`);
            }
        }
    }
    if (useLog) {
        const log = readLogTail(cfg.adapterLog);
        if (log !== undefined) {
            evidence = true;
            REQUEST_IDS.forEach((value, i) => {
                if (log.includes(value)) {
                    failures.push(`value ${i + 1} appears verbatim in the adapter log`);
                }
            });
        }
    }
    return { failures, notes, evidence };
}

/**
 * Runs the group.
 *
 * @param {{ cfg: object, control: object, log: (msg: string) => void }} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
export async function run(ctx) {
    const { cfg, control } = ctx;
    const full = cfg.fullToken;
    const cases = [];

    // 8.01 malformed id
    cases.push(
        ...(await guard(
            metaOf(
                "8.01",
                "get_file_outline with a malformed fileId is refused by validation",
                'tool get_file_outline {fileId: "not-a-uuid"}',
                "refused with a clear validation error"
            ),
            async () => {
                const o = await tool(control, "get_file_outline", { fileId: "not-a-uuid" });
                return makeCase(
                    metaOf(
                        "8.01",
                        "get_file_outline with a malformed fileId is refused by validation",
                        'tool get_file_outline {fileId: "not-a-uuid"}',
                        "refused with a clear validation error"
                    ),
                    o,
                    refusedClearly(o)
                );
            }
        ))
    );

    // 8.02 unknown file
    cases.push(
        ...(await guard(
            metaOf(
                "8.02",
                "get_file_outline with a random uuid is refused with no SQL or stack",
                "tool get_file_outline {fileId: <random uuid>}",
                "refused as not-found or authorization"
            ),
            async () => {
                const meta = metaOf(
                    "8.02",
                    "get_file_outline with a random uuid is refused with no SQL or stack",
                    "tool get_file_outline {fileId: <random uuid>}",
                    "refused as not-found or authorization"
                );
                const o = await tool(control, "get_file_outline", { fileId: uuid() });
                return makeCase(
                    meta,
                    o,
                    refusedClearly(o, /not-found|not found|authorization|permission|missing-perms|does not exist/i)
                );
            }
        ))
    );

    // 8.03 invalid regex
    cases.push(
        ...(await guard(
            metaOf(
                "8.03",
                "find_shapes with an invalid nameRegex answers mcp-invalid-regex",
                'tool find_shapes {nameRegex: "(((("}',
                "refused with mcp-invalid-regex, no Java class name"
            ),
            async () => {
                const meta = metaOf(
                    "8.03",
                    "find_shapes with an invalid nameRegex answers mcp-invalid-regex",
                    'tool find_shapes {nameRegex: "(((("}',
                    "refused with mcp-invalid-regex, no Java class name"
                );
                const o = await tool(control, "find_shapes", {
                    fileId: cfg.vars.fileId,
                    pageId: cfg.vars.pageId,
                    nameRegex: "((((",
                });
                return makeCase(meta, o, refusedClearly(o, /mcp-invalid-regex/));
            }
        ))
    );

    // 8.04 raw change with a bad attribute value and a random id
    cases.push(
        ...(await guard(
            metaOf(
                "8.04",
                "apply_raw_changes dry run with a random id and a bad value is refused cleanly",
                "tool apply_raw_changes {dryRun: true, mod-obj of a random id, set name = {$$: 1}}",
                "refused with a clear text",
                "low"
            ),
            async () => {
                const meta = metaOf(
                    "8.04",
                    "apply_raw_changes dry run with a random id and a bad value is refused cleanly",
                    "tool apply_raw_changes {dryRun: true, mod-obj of a random id, set name = {$$: 1}}",
                    "refused with a clear text",
                    "low"
                );
                const o = await tool(control, "apply_raw_changes", {
                    fileId: cfg.vars.fileId,
                    dryRun: true,
                    changes: [
                        {
                            type: "mod-obj",
                            id: uuid(),
                            pageId: cfg.vars.pageId,
                            operations: [{ type: "set", attr: "name", val: { $$: 1 } }],
                        },
                    ],
                });
                return makeCase(
                    meta,
                    o,
                    refused(o) ? refusedClearly(o) : "dry run reports ok for a change that targets no shape"
                );
            }
        ))
    );

    // 8.04b dry run of a non-string name on a real rect must be refused
    {
        const title = "apply_raw_changes dry run with a non-string name on a real rect is refused";
        const request = "dry run mod-obj of a rect on a fresh page, set name = {$: 1}";
        const meta = metaOf("8.04b", title, request, "refused: name must be a string", "medium");
        cases.push(
            ...(await guard(meta, async () => {
                const page = await freshPage(control, cfg, "adv-8.04b");
                const made = await tool(control, "apply_operations", {
                    fileId: cfg.vars.fileId,
                    snapshot: false,
                    operations: [
                        {
                            op: "create_rect",
                            pageId: page,
                            id: "$tmp:r",
                            name: "adv-rect-8.04b",
                            x: 10,
                            y: 10,
                            width: 40,
                            height: 40,
                        },
                    ],
                });
                const rectId = made.json?.createdIds?.["$tmp:r"];
                if (!rectId) {
                    return notTestable(meta, "could not create the test rect on a fresh page");
                }
                const o = await tool(control, "apply_raw_changes", {
                    fileId: cfg.vars.fileId,
                    dryRun: true,
                    changes: [
                        {
                            type: "mod-obj",
                            id: rectId,
                            pageId: page,
                            operations: [{ type: "set", attr: "name", val: { $: 1 } }],
                        },
                    ],
                });
                // a dry run answers with its validation result instead of an error; ok:false naming the shape is the refusal
                const reported = o.json?.dryRun === true && o.json?.validation?.ok === false;
                return makeCase(meta, o, refused(o) || reported ? true : "dry run accepted a non-string name");
            }))
        );
    }

    // 8.04c the same change for real must be refused; if it is accepted, repair the name
    {
        const title = "apply_raw_changes write with a non-string name on a real rect is refused";
        const request = "write mod-obj of a rect on a fresh page, set name = {$: 1}";
        const meta = metaOf("8.04c", title, request, "refused: name must be a string", "medium");
        cases.push(
            ...(await guard(meta, async () => {
                const page = await freshPage(control, cfg, "adv-8.04c");
                const made = await tool(control, "apply_operations", {
                    fileId: cfg.vars.fileId,
                    snapshot: false,
                    operations: [
                        {
                            op: "create_rect",
                            pageId: page,
                            id: "$tmp:r",
                            name: "adv-rect-8.04c",
                            x: 10,
                            y: 10,
                            width: 40,
                            height: 40,
                        },
                    ],
                });
                const rectId = made.json?.createdIds?.["$tmp:r"];
                if (!rectId) {
                    return notTestable(meta, "could not create the test rect on a fresh page");
                }
                const o = await tool(control, "apply_raw_changes", {
                    fileId: cfg.vars.fileId,
                    dryRun: false,
                    changes: [
                        {
                            type: "mod-obj",
                            id: rectId,
                            pageId: page,
                            operations: [{ type: "set", attr: "name", val: { $: 1 } }],
                        },
                    ],
                });
                if (refused(o)) {
                    // the refusal must be a client validation error, not an internal assertion that dumps the schema and the shape
                    const internal = /Backend error assertion|malli\.core|#app\.common\./.test(textOf(o));
                    return makeCase(
                        meta,
                        o,
                        internal
                            ? "refused as an internal assertion that dumps the malli explain and the whole shape record"
                            : refusedClearly(o)
                    );
                }
                const repair = await tool(control, "apply_raw_changes", {
                    fileId: cfg.vars.fileId,
                    dryRun: false,
                    changes: [
                        {
                            type: "mod-obj",
                            id: rectId,
                            pageId: page,
                            operations: [{ type: "set", attr: "name", val: "adv-repaired" }],
                        },
                    ],
                });
                const note = repair.isError
                    ? " repair failed: " + textOf(repair).slice(0, 200)
                    : " repaired to adv-repaired";
                return makeCase(meta, o, "write accepted a non-string name, file data was corrupted;" + note);
            }))
        );
    }

    // 8.05 SQL in a uuid field of a raw backend call
    cases.push(
        ...(await guard(
            metaOf(
                "8.05",
                "raw backend get-mcp-shapes with SQL in fileId is a 400 validation with no SQL text",
                'POST rpc get-mcp-shapes {fileId: "x\'; SELECT 1;--", pageId: "1", ids: ["a"]} (full token)',
                "HTTP 400 validation, clear text"
            ),
            async () => {
                const meta = metaOf(
                    "8.05",
                    "raw backend get-mcp-shapes with SQL in fileId is a 400 validation with no SQL text",
                    'POST rpc get-mcp-shapes {fileId: "x\'; SELECT 1;--", pageId: "1", ids: ["a"]} (full token)',
                    "HTTP 400 validation, clear text"
                );
                const o = await rpc(
                    cfg,
                    "get-mcp-shapes",
                    { fileId: "x'; SELECT 1;--", pageId: "1", ids: ["a"] },
                    { token: full }
                );
                const verdict = o.status !== 400 ? `expected HTTP 400, got HTTP ${o.status}` : refusedClearly(o);
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.06 malformed JSON body
    cases.push(
        ...(await guard(
            metaOf(
                "8.06",
                "raw backend malformed JSON body is a 400 with no Java class name or stack",
                'POST rpc get-mcp-file-outline body {"fileId": (truncated) (full token)',
                "HTTP 400, clear text"
            ),
            async () => {
                const meta = metaOf(
                    "8.06",
                    "raw backend malformed JSON body is a 400 with no Java class name or stack",
                    'POST rpc get-mcp-file-outline body {"fileId": (truncated) (full token)',
                    "HTTP 400, clear text"
                );
                const o = await http(`${cfg.backendUrl}/api/rpc/command/get-mcp-file-outline`, {
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json",
                        "X-Client": "penpot-mcp",
                        Authorization: `Token ${full}`,
                    },
                    body: '{"fileId":',
                });
                const verdict = o.status !== 400 ? `expected HTTP 400, got HTTP ${o.status}` : refusedClearly(o);
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.07 unknown command
    cases.push(
        ...(await guard(
            metaOf(
                "8.07",
                "raw backend unknown command answers 404 or 400 with a clean body",
                "POST rpc no-such-command {} (full token)",
                "HTTP 404 or 400, clean text"
            ),
            async () => {
                const meta = metaOf(
                    "8.07",
                    "raw backend unknown command answers 404 or 400 with a clean body",
                    "POST rpc no-such-command {} (full token)",
                    "HTTP 404 or 400, clean text"
                );
                const o = await rpc(cfg, "no-such-command", {}, { token: full });
                const verdict =
                    o.status !== 404 && o.status !== 400
                        ? `expected HTTP 404 or 400, got HTTP ${o.status}`
                        : refusedClearly(o);
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.08 another profile's file
    cases.push(
        ...(await guard(
            metaOf(
                "8.08",
                "outsider token asking for the test file is refused and learns nothing about the owner",
                "tool get_file_outline {fileId: vars.fileId} with the outsider token",
                "refused; no owner profile id, team id or file name in the text",
                "high",
                {
                    allowIds: [cfg.advIds?.outsiderProfileId].filter(Boolean),
                }
            ),
            async () => {
                const meta = metaOf(
                    "8.08",
                    "outsider token asking for the test file is refused and learns nothing about the owner",
                    "tool get_file_outline {fileId: vars.fileId} with the outsider token",
                    "refused; no owner profile id, team id or file name in the text",
                    "high",
                    {
                        allowIds: [cfg.advIds?.outsiderProfileId].filter(Boolean),
                    }
                );
                if (!cfg.outsiderToken) {
                    return notTestable(
                        meta,
                        "needs adv-outsider.txt in ADV_TOKEN_DIR (a profile that is not in the test team)"
                    );
                }
                const own = await tool(control, "get_file_outline", { fileId: cfg.vars.fileId });
                const fileName = own.json?.name;
                const o = await callAs(cfg, cfg.outsiderToken, "get_file_outline", { fileId: cfg.vars.fileId });
                const text = textOf(o);
                let verdict = refused(o) ? true : "outsider token was not refused";
                if (verdict === true && text.includes(cfg.vars.teamId)) {
                    verdict = "refusal names the owner's team id";
                }
                if (verdict === true && fileName && text.includes(fileName)) {
                    verdict = "refusal names the file";
                }
                if (verdict === true && !CLEAR.test(text)) {
                    verdict = "error text is not clear";
                }
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.09 - 8.11 forwarded headers do not turn /metrics into a public endpoint
    const metricsUrl = new URL("/metrics", cfg.mcpUrl).href;
    const forwarded = [
        [
            "8.09",
            "/metrics refuses an unauthenticated request with X-Forwarded-For",
            { "X-Forwarded-For": "203.0.113.9" },
        ],
        ["8.10", "/metrics refuses an unauthenticated request with X-Real-IP", { "X-Real-IP": "203.0.113.9" }],
        ["8.11", "/metrics refuses an unauthenticated request with Forwarded", { Forwarded: "for=203.0.113.9" }],
    ];
    for (const [id, title, headers] of forwarded) {
        const request = `GET /metrics with ${Object.keys(headers)[0]} and no token`;
        cases.push(
            ...(await guard(metaOf(id, title, request, "HTTP 401 or 403"), async () => {
                const meta = metaOf(id, title, request, "HTTP 401 or 403");
                const o = await http(metricsUrl, { headers });
                const verdict =
                    o.status === 401 || o.status === 403 ? true : `expected 401 or 403, got HTTP ${o.status}`;
                return makeCase(meta, o, verdict);
            }))
        );
    }

    // 8.12 control: the full token opens /metrics even with a forwarded header
    cases.push(
        ...(await guard(
            metaOf(
                "8.12",
                "control: /metrics with the full token and X-Forwarded-For answers 200",
                "GET /metrics with X-Forwarded-For and Authorization Bearer (full token)",
                "HTTP 200 with metrics text"
            ),
            async () => {
                const meta = metaOf(
                    "8.12",
                    "control: /metrics with the full token and X-Forwarded-For answers 200",
                    "GET /metrics with X-Forwarded-For and Authorization Bearer (full token)",
                    "HTTP 200 with metrics text"
                );
                const o = await http(metricsUrl, {
                    headers: { "X-Forwarded-For": "203.0.113.9", Authorization: `Bearer ${full}` },
                });
                const verdict =
                    o.status === 200 && (o.text.includes("penpot_mcp") || o.text.includes("# TYPE"))
                        ? true
                        : `expected HTTP 200 with metrics, got HTTP ${o.status}`;
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.13 a bad token with a forwarded header is refused
    cases.push(
        ...(await guard(
            metaOf(
                "8.13",
                "/metrics refuses a bad bearer token with X-Forwarded-For",
                "GET /metrics with X-Forwarded-For and Authorization Bearer not-a-real-token",
                "HTTP 401"
            ),
            async () => {
                const meta = metaOf(
                    "8.13",
                    "/metrics refuses a bad bearer token with X-Forwarded-For",
                    "GET /metrics with X-Forwarded-For and Authorization Bearer not-a-real-token",
                    "HTTP 401"
                );
                const o = await http(metricsUrl, {
                    headers: { "X-Forwarded-For": "203.0.113.9", Authorization: "Bearer not-a-real-token" },
                });
                const verdict = o.status === 401 ? true : `expected 401, got HTTP ${o.status}`;
                return makeCase(meta, o, verdict);
            }
        ))
    );

    // 8.14 X-Request-Id injection through the adapter
    {
        const meta = metaOf(
            "8.14",
            "X-Request-Id injection through the adapter: calls still work, response id is clean, log has no raw value",
            "whoami tools/call x5 over MCP with hostile X-Request-Id values (full token)",
            "each call answered; x-request-id absent or a clean id; no raw value in the adapter log"
        );
        cases.push(
            ...(await guard(meta, async () => {
                const session = await mcpSession(cfg, full);
                const result = await sendRequestIds(
                    cfg,
                    (i, value) =>
                        mcpRaw(cfg, {
                            token: full,
                            sessionId: session.sessionId,
                            headers: { "X-Request-Id": value },
                            body: {
                                jsonrpc: "2.0",
                                id: 100 + i,
                                method: "tools/call",
                                params: { name: "whoami", arguments: {} },
                            },
                        }),
                    (o) => o.status === 200 && !o.messages.some((m) => m && m.error),
                    true
                );
                if (!result.evidence) {
                    return notTestable(
                        meta,
                        "no x-request-id response header and no ADV_ADAPTER_LOG: nothing to check"
                    );
                }
                const summary = {
                    status: undefined,
                    isError: result.failures.length > 0,
                    text: [...result.notes, ...result.failures].join("\n") || "all values clean",
                };
                return makeCase(meta, summary, result.failures.length ? result.failures.join("; ") : true);
            }))
        );
    }

    // 8.15 the same values straight to the backend
    {
        const meta = metaOf(
            "8.15",
            "X-Request-Id injection straight to the backend: response id is clean",
            "rpc mcp-whoami x5 with hostile X-Request-Id values (full token)",
            "each call answered; x-request-id absent or a clean id"
        );
        cases.push(
            ...(await guard(meta, async () => {
                const result = await sendRequestIds(
                    cfg,
                    (_i, value) => rpc(cfg, "mcp-whoami", {}, { token: full, headers: { "X-Request-Id": value } }),
                    (o) => o.status === 200,
                    false
                );
                if (!result.evidence) {
                    return notTestable(meta, "backend answers no x-request-id response header: nothing to check here");
                }
                const summary = {
                    status: undefined,
                    isError: result.failures.length > 0,
                    text: [...result.notes, ...result.failures].join("\n") || "all values clean",
                };
                return makeCase(meta, summary, result.failures.length ? result.failures.join("; ") : true);
            }))
        );
    }

    return cases;
}
