// Group 1: scopes, authorization and token states. Read-only tokens on every write and manage tool and on every
// raw RPC write, MCP tokens on commands they must never reach, render sessions, token states and OAuth client
// tokens. Every case asserts a refusal; the creative writes run on a fresh page and the destructive ones use
// random ids, so a missing check cannot change real data.
import { createHash, randomBytes } from "node:crypto";
import { request as nodeRequest } from "node:http";
import {
    connect,
    freshPage,
    guard,
    http as httpCall,
    makeCase,
    notTestable,
    pngBase64,
    refused,
    rpc,
    sleep,
    textOf,
    tool,
    uuid,
} from "./lib.mjs";

/** Name of the group, used in the report and the case ids. */
export const name = "1-scopes";

/** Refusal text of a token that lacks the scope. */
const SCOPE_RE = /mcp-scope-required/;
/** Refusal text of a token that is expired, revoked or switched off. */
const TOKEN_STATE_RE = /rejected|401|unauthor|expired|mcp-disabled|authentication|invalid_token/i;
/** Refusal text of a request for a file the caller cannot see. */
const NOT_VISIBLE_RE = /not[- ]?found|authori[sz]|permission|forbidden|missing-perms|denied|mcp-scope|mcp-token/i;
/** Redirect URI of the OAuth clients. The suite never listens on it. */
const CB = "http://127.0.0.1:65530/cb";
/** Page root frame id that a comment thread uses by default. */
const ROOT_FRAME = "00000000-0000-0000-0000-000000000000";

/**
 * Returns the parsed JSON of a tool or HTTP outcome, parsing the text when needed.
 * @param {object} o - an outcome
 * @returns {unknown} the JSON value, or undefined
 */
function outcomeJson(o) {
    if (o.json !== undefined) {
        return o.json;
    }
    try {
        return JSON.parse(o.text);
    } catch {
        return undefined;
    }
}

/**
 * Returns the array of a list reply, or an empty array.
 * @param {unknown} json - the parsed reply
 * @returns {object[]} the list
 */
function listOf(json) {
    return Array.isArray(json) ? json : [];
}

/**
 * Builds an outcome for a failure that happened outside a tool or HTTP call.
 * @param {{status?: number, text?: string, error?: string, json?: unknown}} parts - the known parts
 * @returns {object} an outcome shaped like the lib outcomes
 */
function syntheticOutcome({ status = 0, text = "", error, json } = {}) {
    return {
        status,
        ok: status > 0 && status < 400,
        isError: status === 0 || status >= 400,
        text,
        error,
        json,
        headers: {},
        durationMs: 0,
        timedOut: false,
        bytes: 0,
    };
}

/**
 * Reports whether a contract code gap applies to a refusal, marking it low severity.
 * @param {object} c - the failing case
 * @param {object} o - the outcome
 * @returns {object} the case, low severity
 */
function contractCodeGap(c, o) {
    c.severity = "low";
    c.note =
        "refused, but the code differs from contract 1.6 and its hint (access token authentication required) is misleading for a token caller (HTTP " +
        o.status +
        " " +
        (o.json?.code ?? "") +
        ")";
    return c;
}

/**
 * Uploads a 1x1 png as multipart form data, with the token in the Authorization header.
 * @param {object} cfg - the suite config
 * @param {string} token - the MCP token
 * @param {Record<string, string>} fields - plain form fields
 * @returns {Promise<object>} an outcome shaped like the lib outcomes
 */
async function multipartUpload(cfg, token, fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.append(key, value);
    }
    form.append("content", new Blob([Buffer.from(pngBase64(), "base64")], { type: "image/png" }), "adv.png");
    const res = await fetch(cfg.backendUrl + "/api/rpc/command/upload-file-media-object", {
        method: "POST",
        headers: { Authorization: "Token " + token, Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return syntheticOutcome({ status: res.status, text, json });
}

/**
 * Hides the given secret values in the text of an outcome before it becomes part of a case.
 * @param {object} o - the outcome
 * @param {...(string | undefined)} secrets - values to hide
 * @returns {object} a copy of the outcome with the secrets replaced
 */
function scrub(o, ...secrets) {
    let text = o.text ?? "";
    for (const secret of secrets) {
        if (secret) {
            text = text.split(secret).join("<secret>");
        }
    }
    return { ...o, text };
}

/**
 * Judges a tool outcome that must be a refusal, optionally with a text pattern.
 * @param {object} m - case meta
 * @param {object} o - the tool outcome
 * @param {RegExp | null} re - the text the refusal must carry, or null for any refusal
 * @returns {object} the case
 */
function judgeRefusal(m, o, re) {
    if (!refused(o)) {
        return makeCase(m, o, "accepted: no refusal was returned");
    }
    if (re && !re.test(textOf(o))) {
        return makeCase(m, o, `refused, but the text does not match ${re}`);
    }
    return makeCase(m, o, true);
}

/**
 * Judges an HTTP outcome against an expected status and, optionally, an error code.
 * @param {object} m - case meta
 * @param {object} o - the HTTP outcome
 * @param {number[]} statuses - the accepted refusal statuses
 * @param {RegExp | null} codeRe - the accepted error codes, or null for any
 * @returns {object} the case
 */
function judgeStatus(m, o, statuses, codeRe = null) {
    if (o.status === 200) {
        return makeCase(m, o, "accepted: HTTP 200");
    }
    if (!statuses.includes(o.status)) {
        const c = makeCase(m, o, `expected HTTP ${statuses.join(" or ")}, got HTTP ${o.status}`);
        if (o.status === 400) {
            c.note = "validation ran before the auth check (inconclusive)";
        }
        return c;
    }
    const got = o.json?.code ?? "";
    if (codeRe && !codeRe.test(got)) {
        return makeCase(m, o, `refused with code "${got}", expected ${codeRe}`);
    }
    return makeCase(m, o, true);
}

/**
 * Judges an HTTP outcome against one status and one error code.
 * @param {object} m - case meta
 * @param {object} o - the HTTP outcome
 * @param {number} status - the expected status
 * @param {string} code - the expected error code
 * @returns {object} the case
 */
function judgeRpc(m, o, status, code) {
    const got = o.json?.code;
    if (o.status === status && got === code) {
        return makeCase(m, o, true);
    }
    const c = makeCase(m, o, `expected HTTP ${status} ${code}, got HTTP ${o.status}${got ? ` ${got}` : ""}`);
    if (o.status === 400) {
        c.note = "validation ran before the scope check (inconclusive)";
    }
    return c;
}

/**
 * Runs a case body only when the secret it needs is configured; otherwise the case is not testable.
 * @param {object} m - case meta
 * @param {unknown} secret - the configured token, cookie or other input
 * @param {string} what - the missing input, for the note
 * @param {() => Promise<object | object[]>} fn - the case body
 * @returns {Promise<object[]>} the cases
 */
function gated(m, secret, what, fn) {
    return secret ? guard(m, fn) : Promise.resolve([notTestable(m, `${what} is missing`)]);
}

/**
 * Closes an MCP client and ignores errors from it.
 * @param {object | undefined} client - the client
 */
async function closeQuietly(client) {
    try {
        await client?.close?.();
    } catch {
        // already closed
    }
}

/**
 * Opens a websocket upgrade request and reports the status the server answers.
 * @param {string} url - the full ws URL with the http scheme
 * @param {string | undefined} cookie - the auth-token value, or undefined for no cookie
 * @returns {Promise<{status: number, note?: string}>} the answer; status 101 means the upgrade was accepted
 */
function wsProbe(url, cookie) {
    return new Promise((resolve) => {
        const headers = {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        };
        if (cookie) {
            headers.Cookie = `auth-token=${cookie}`;
        }
        let done = false;
        const finish = (value) => {
            if (!done) {
                done = true;
                resolve(value);
            }
        };
        const req = nodeRequest(url, { method: "GET", headers, timeout: 10000 });
        req.on("upgrade", (_res, socket) => {
            socket.destroy();
            finish({ status: 101 });
        });
        req.on("response", (res) => {
            res.resume();
            finish({ status: res.statusCode });
        });
        req.on("timeout", () => {
            req.destroy();
            finish({ status: 0, note: "timeout" });
        });
        req.on("error", (e) => finish({ status: 0, note: e.code ?? "error" }));
        req.end();
    });
}

/**
 * Runs every case of group 1.
 * @param {{cfg: object, control: object, log: (msg: string) => void}} ctx - the suite context
 * @returns {Promise<object[]>} the cases
 */
export async function run(ctx) {
    const { cfg, control, log } = ctx;
    const out = [];
    let seq = 0;
    /** Own profile ids of the caller; the leak check must not flag them. */
    let own = [];
    const setOwn = (...ids) => {
        own = ids.filter((id) => typeof id === "string" && id.length > 0);
    };
    const adv = cfg.advIds ?? {};
    const readId = adv.readProfileId;
    const offId = adv.offProfileId;
    const expId = adv.expProfileId;
    const revId = adv.revokedProfileId;
    const outId = adv.outsiderProfileId;
    const testId = cfg.vars.profileId;
    /** Builds the meta of the next case; ids follow the order of the calls. */
    const meta = (title, request, expected, severity = "critical") => ({
        group: name,
        id: `1.${String(++seq).padStart(2, "0")}`,
        title,
        request,
        expected,
        severity,
        allowIds: [...own],
    });
    const push = (cases) => out.push(...cases);
    const F = cfg.vars.fileId;
    const T = cfg.vars.teamId;
    const P = cfg.vars.projectId;
    const base = cfg.backendUrl;
    const ts = Date.now();
    const ADV = `adv-${ts}`;

    // Shared, lazily created state. Secrets stay in memory and never reach a case.
    let readClient;
    const readC = async () => (readClient ??= await connect(cfg, cfg.readToken));
    /** Waits 150 ms, then returns the read-token client, so read calls are paced. */
    const pacedC = async () => {
        await sleep(150);
        return readC();
    };
    let freshPromise;
    const pageOf = () => (freshPromise ??= freshPage(control, cfg, "g1-scopes"));
    let renderToken;
    const outsiderRef = {};
    let outsiderPromise;
    const setupOutsider = async () => {
        const c = await connect(cfg, cfg.outsiderToken);
        try {
            const teams = listOf(outcomeJson(await tool(c, "list_teams", {})));
            const team = teams.find((t) => t.isDefault) ?? teams[0];
            if (!team) {
                throw new Error("the outsider has no team");
            }
            const projects = listOf(outcomeJson(await tool(c, "list_projects", { teamId: team.id })));
            const project = projects.find((p) => p.isDefault) ?? projects[0];
            if (!project) {
                throw new Error("the outsider has no project");
            }
            const fileReply = await tool(c, "manage_files", {
                action: "create_file",
                projectId: project.id,
                name: `adv-${ts}-outsider`,
            });
            const fj = outcomeJson(fileReply);
            log(`outsider create_file reply keys: ${Object.keys(fj ?? {}).join(",")}`);
            outsiderRef.fileId = fj?.id ?? fj?.fileId;
            if (!outsiderRef.fileId) {
                throw new Error("create_file gave no file id");
            }
            const imageReply = await tool(c, "import_image", {
                fileId: outsiderRef.fileId,
                base64: pngBase64(),
                mimeType: "image/png",
                createShape: false,
            });
            const ij = outcomeJson(imageReply);
            log(`outsider import_image reply keys: ${Object.keys(ij ?? {}).join(",")}`);
            outsiderRef.mediaId = ij?.mediaId;
            if (!outsiderRef.mediaId) {
                throw new Error("import_image gave no mediaId");
            }
        } finally {
            await closeQuietly(c);
        }
        return outsiderRef;
    };
    const outsider = () => (outsiderPromise ??= setupOutsider());

    // ---- A. read-only token through the adapter: every write, manage and delete tool ----
    setOwn(readId);

    /** One write attempt through the adapter with the read token; it must be refused by scope. */
    const attempt = async (title, toolName, build, soft = false) => {
        const m = meta(title, toolName, "refused with mcp-scope-required, nothing written", "critical");
        push(
            await gated(m, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
                const args = await build();
                m.request = `${toolName} ${JSON.stringify(args).slice(0, 240)} [read token]`;
                const o = await tool(await pacedC(), toolName, args);
                if (soft && refused(o) && !SCOPE_RE.test(textOf(o))) {
                    const c = makeCase(m, o, true);
                    c.note = "scope not reached: the adapter refused the request first";
                    return c;
                }
                return judgeRefusal(m, o, SCOPE_RE);
            })
        );
    };

    await attempt("apply_operations create_rect, not a dry run", "apply_operations", async () => ({
        fileId: F,
        operations: [
            {
                op: "create_rect",
                pageId: await pageOf(),
                id: "$tmp:adv",
                name: ADV,
                x: 10,
                y: 10,
                width: 10,
                height: 10,
            },
        ],
    }));
    await attempt("apply_raw_changes mod-obj of a random id", "apply_raw_changes", async () => ({
        fileId: F,
        changes: [
            {
                type: "mod-obj",
                id: uuid(),
                pageId: await pageOf(),
                operations: [{ type: "set", attr: "name", val: ADV }],
            },
        ],
    }));
    await attempt("batch_create_shapes one rect", "batch_create_shapes", async () => ({
        fileId: F,
        pageId: await pageOf(),
        tree: [{ type: "rect", x: 10, y: 10, width: 10, height: 10, name: ADV }],
    }));
    await attempt("import_svg one small rect", "import_svg", async () => ({
        fileId: F,
        pageId: await pageOf(),
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>',
    }));
    await attempt("import_image a 1x1 png, createShape false", "import_image", () => ({
        fileId: F,
        base64: pngBase64(),
        mimeType: "image/png",
        createShape: false,
    }));
    await attempt(
        "import_archive a few random bytes (adapter may refuse the format first)",
        "import_archive",
        () => ({ projectId: P, base64: randomBytes(16).toString("base64") }),
        true
    );

    const manage = (title, args) => attempt(title, "manage_files", () => args);
    await manage("manage_files create_team", { action: "create_team", name: ADV });
    await manage("manage_files rename_team on a random team", {
        action: "rename_team",
        teamId: uuid(),
        name: ADV,
    });
    await manage("manage_files create_project in the test team", {
        action: "create_project",
        teamId: T,
        name: ADV,
    });
    await manage("manage_files rename_project on a random project", {
        action: "rename_project",
        projectId: uuid(),
        name: ADV,
    });
    await manage("manage_files pin_project on a random project", {
        action: "pin_project",
        projectId: uuid(),
        teamId: uuid(),
        isPinned: true,
    });
    await manage("manage_files delete_project on a random project", {
        action: "delete_project",
        projectId: uuid(),
    });
    await manage("manage_files create_file in the test project", {
        action: "create_file",
        projectId: P,
        name: ADV,
    });
    await manage("manage_files rename_file on a random file", { action: "rename_file", fileId: uuid(), name: ADV });
    await manage("manage_files duplicate_file on a random file", { action: "duplicate_file", fileId: uuid() });
    await manage("manage_files duplicate_project on a random project", {
        action: "duplicate_project",
        projectId: uuid(),
    });
    await manage("manage_files move_files of random ids", {
        action: "move_files",
        fileIds: [uuid()],
        projectId: uuid(),
    });
    await manage("manage_files move_project of random ids", {
        action: "move_project",
        projectId: uuid(),
        teamId: uuid(),
    });
    await manage("manage_files delete_file on a random file", { action: "delete_file", fileId: uuid() });
    await manage("manage_files restore_files of random ids", {
        action: "restore_files",
        teamId: uuid(),
        fileIds: [uuid()],
    });
    await manage("manage_files set_shared on a random file", {
        action: "set_shared",
        fileId: uuid(),
        isShared: true,
    });
    await manage("manage_files link_library of random ids", {
        action: "link_library",
        fileId: uuid(),
        libraryId: uuid(),
    });
    await manage("manage_files unlink_library of random ids", {
        action: "unlink_library",
        fileId: uuid(),
        libraryId: uuid(),
    });

    const versions = (title, args) => attempt(title, "manage_versions", () => args);
    await versions("manage_versions create a snapshot of the test file", {
        fileId: F,
        action: "create",
        label: ADV,
    });
    await versions("manage_versions restore a random snapshot", {
        fileId: F,
        action: "restore",
        snapshotId: uuid(),
    });
    await versions("manage_versions pin a random snapshot", { fileId: F, action: "pin", snapshotId: uuid() });
    await versions("manage_versions unpin a random snapshot", { fileId: F, action: "unpin", snapshotId: uuid() });
    await versions("manage_versions delete a random snapshot", {
        fileId: F,
        action: "delete",
        snapshotId: uuid(),
    });
    await versions("manage_versions rename a random snapshot", {
        fileId: F,
        action: "rename",
        snapshotId: uuid(),
        label: ADV,
    });

    const comments = (title, args) => attempt(title, "comments", typeof args === "function" ? args : () => args);
    await comments("comments create_thread on a fresh page", async () => ({
        fileId: F,
        action: "create_thread",
        pageId: await pageOf(),
        position: { x: 10, y: 10 },
        content: ADV,
    }));
    await comments("comments reply to a random thread", {
        fileId: F,
        action: "reply",
        threadId: uuid(),
        content: ADV,
    });
    await comments("comments resolve a random thread", { fileId: F, action: "resolve", threadId: uuid() });
    await comments("comments reopen a random thread", { fileId: F, action: "reopen", threadId: uuid() });
    await comments("comments move a random thread", {
        fileId: F,
        action: "move",
        threadId: uuid(),
        position: { x: 10, y: 10 },
    });
    await comments("comments delete_thread on a random thread", {
        fileId: F,
        action: "delete_thread",
        threadId: uuid(),
    });
    await comments("comments delete a random comment", { fileId: F, action: "delete", commentId: uuid() });

    await attempt("execute_code creates a rect on a fresh page", "execute_code", async () => ({
        code: "penpot.createRectangle(); return 1",
        fileId: F,
        pageId: await pageOf(),
    }));

    // Positive controls: the read token must still do what it may do.
    const mW = meta(
        "whoami with the read token reports only mcp:read",
        "whoami {} [read token]",
        "scopes is exactly [mcp:read]",
        "medium"
    );
    push(
        await gated(mW, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await tool(await pacedC(), "whoami", {});
            const scopes = outcomeJson(o)?.scopes;
            const only = o.ok && Array.isArray(scopes) && scopes.length > 0 && scopes.every((s) => s === "mcp:read");
            return makeCase(mW, o, only || `scopes are ${JSON.stringify(scopes)}`);
        })
    );
    const mO = meta(
        "get_file_outline with the read token (control)",
        "get_file_outline {fileId: test file} [read token]",
        "ok: read is permitted",
        "medium"
    );
    push(
        await gated(mO, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await tool(await pacedC(), "get_file_outline", { fileId: F });
            return makeCase(mO, o, o.ok && !o.isError ? true : `read refused: ${textOf(o).slice(0, 160)}`);
        })
    );
    const mDry = meta(
        "apply_operations dryRun with the read token (control, needs only mcp:read)",
        "apply_operations dryRun:true create_rect [read token]",
        "ok: a dry run needs only mcp:read",
        "medium"
    );
    push(
        await gated(mDry, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await tool(await pacedC(), "apply_operations", {
                fileId: F,
                dryRun: true,
                operations: [
                    {
                        op: "create_rect",
                        pageId: await pageOf(),
                        id: "$tmp:adv",
                        name: ADV,
                        x: 10,
                        y: 10,
                        width: 10,
                        height: 10,
                    },
                ],
            });
            return makeCase(mDry, o, o.ok && !o.isError ? true : `dry run refused: ${textOf(o).slice(0, 160)}`);
        })
    );

    // ---- B. read-only token on the raw backend: every write command must answer 403 mcp-scope-required ----
    setOwn(readId);

    /** One raw RPC write with the read token; it must answer HTTP 403 mcp-scope-required. */
    const rpcRead = async (title, command, build) => {
        const m = meta(title, command, "HTTP 403 mcp-scope-required (read token)", "critical");
        push(
            await gated(m, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
                const params = await build();
                m.request = `rpc ${command} ${JSON.stringify(params).slice(0, 240)} [read token]`;
                const o = await rpc(cfg, command, params, { token: cfg.readToken });
                return judgeRpc(m, o, 403, "mcp-scope-required");
            })
        );
    };

    await rpcRead("raw mcp-apply-operations create_rect", "mcp-apply-operations", async () => ({
        fileId: F,
        operations: [
            { op: "create_rect", pageId: await pageOf(), id: "$tmp:adv", name: ADV, x: 1, y: 1, width: 1, height: 1 },
        ],
    }));
    await rpcRead("raw mcp-apply-changes mod-obj of a random id", "mcp-apply-changes", async () => ({
        fileId: F,
        changes: [{ type: "mod-obj", id: uuid(), pageId: await pageOf(), operations: [] }],
    }));
    await rpcRead("raw mcp-import-svg on a fresh page", "mcp-import-svg", async () => ({
        fileId: F,
        pageId: await pageOf(),
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    }));
    await rpcRead("raw delete-file of a random file", "delete-file", () => ({ id: uuid() }));
    await rpcRead("raw delete-project of a random project", "delete-project", () => ({ id: uuid() }));
    await rpcRead("raw create-project in the test team", "create-project", () => ({ teamId: T, name: ADV }));
    await rpcRead("raw create-file in the test project", "create-file", () => ({ projectId: P, name: ADV }));
    await rpcRead("raw rename-file of a random file", "rename-file", () => ({ id: uuid(), name: ADV }));
    await rpcRead("raw restore-file-snapshot of a random snapshot", "restore-file-snapshot", () => ({
        fileId: F,
        id: uuid(),
    }));
    await rpcRead("raw delete-file-snapshot of a random snapshot", "delete-file-snapshot", () => ({ id: uuid() }));
    await rpcRead("raw create-file-snapshot on the test file", "create-file-snapshot", () => ({
        fileId: F,
        label: ADV,
    }));
    await rpcRead("raw create-comment-thread on a fresh page", "create-comment-thread", async () => ({
        fileId: F,
        pageId: await pageOf(),
        frameId: ROOT_FRAME,
        position: { x: 10, y: 10 },
        content: ADV,
    }));
    await rpcRead("raw delete-comment-thread of a random thread", "delete-comment-thread", () => ({ id: uuid() }));
    await rpcRead("raw update-comment-thread (resolve) of a random thread", "update-comment-thread", () => ({
        id: uuid(),
        isResolved: true,
    }));
    await rpcRead("raw set-file-shared of a random file", "set-file-shared", () => ({ id: uuid(), isShared: true }));
    await rpcRead("raw duplicate-file of a random file", "duplicate-file", () => ({ fileId: uuid() }));
    await rpcRead("raw move-files of random ids", "move-files", () => ({ ids: [uuid()], projectId: uuid() }));
    await rpcRead("raw create-team", "create-team", () => ({ name: ADV }));
    await rpcRead("raw link-file-to-library of random ids", "link-file-to-library", () => ({
        fileId: uuid(),
        libraryId: uuid(),
    }));
    {
        const m = meta(
            "raw upload-file-media-object on the test file (multipart)",
            "upload-file-media-object",
            "HTTP 403 mcp-scope-required (read token)",
            "critical"
        );
        push(
            await gated(m, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
                m.request = "multipart upload-file-media-object {fileId, name, isLocal, content: 1x1 png} [read token]";
                const o = await multipartUpload(cfg, cfg.readToken, { "file-id": F, name: ADV, "is-local": "true" });
                return judgeRpc(m, o, 403, "mcp-scope-required");
            })
        );
    }
    await rpcRead(
        "raw create-file-media-object-from-url, unresolvable host",
        "create-file-media-object-from-url",
        () => ({
            fileId: F,
            name: ADV,
            url: "http://example.invalid/adv.png",
            isLocal: true,
        })
    );

    // ---- C. commands an MCP token must not reach at all: full MCP token, must answer 401 or 403 ----
    setOwn(testId);

    /** One raw RPC with the full MCP token; it must be refused before the command runs. */
    const rpcFull = async (title, command, build, codeRe = null) => {
        const m = meta(title, command, "HTTP 401 or 403 refusal (MCP token cannot reach it)", "critical");
        push(
            await gated(m, cfg.fullToken, "the full MCP token", async () => {
                const params = await build();
                m.request = `rpc ${command} ${JSON.stringify(params).slice(0, 240)} [full MCP token]`;
                const o = await rpc(cfg, command, params, { token: cfg.fullToken });
                if (codeRe && o.json?.code === "token-auth-required") {
                    return contractCodeGap(
                        makeCase(m, o, "refused with token-auth-required, contract 1.6 says session-required"),
                        o
                    );
                }
                return judgeStatus(m, o, [401, 403], codeRe);
            })
        );
    };

    await rpcFull("get-file with the full MCP token", "get-file", () => ({ id: F }));
    await rpcFull("update-file (editor save) with the full MCP token", "update-file", () => ({
        id: F,
        revn: 0,
        vern: 0,
        sessionId: uuid(),
        changes: [],
    }));
    await rpcFull("export-binfile with the full MCP token", "export-binfile", () => ({ fileId: F }));
    await rpcFull("get-access-tokens with the full MCP token", "get-access-tokens", () => ({}));
    await rpcFull("create-access-token with the full MCP token", "create-access-token", () => ({
        name: "adv",
        type: "mcp",
    }));
    await rpcFull(
        "update-mcp-token-scopes with the full MCP token (must be session-required)",
        "update-mcp-token-scopes",
        () => ({ scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"] }),
        /session-required/
    );
    await rpcFull("update-profile-props mcpEnabled true with the full MCP token", "update-profile-props", () => ({
        props: { mcpEnabled: true },
    }));
    await rpcFull("delete-team of a random team", "delete-team", () => ({ id: uuid() }));
    await rpcFull("create-team-invitations with the full MCP token", "create-team-invitations", () => ({
        teamId: T,
        emails: [`adv-${ts}@example.invalid`],
        role: "editor",
    }));
    await rpcFull("create-webhook with the full MCP token", "create-webhook", () => ({
        uri: "http://example.invalid/adv",
    }));
    await rpcFull("update-profile with the full MCP token", "update-profile", () => ({ fullname: "adv" }));
    await rpcFull(
        "update-profile-password with the full MCP token (wrong old password)",
        "update-profile-password",
        () => ({
            oldPassword: "adv-not-the-password",
            password: "adv-not-the-password-2",
        })
    );

    // ---- D. render sessions (contract 1.5) ----
    setOwn(readId);

    /** Runs a case body only when the render session control minted a token. */
    const renderGate = (m, fn) =>
        renderToken
            ? guard(m, fn)
            : Promise.resolve([notTestable(m, "render session control case did not mint a token")]);

    const mD0 = meta(
        "create-mcp-render-session with the read token (control)",
        "rpc create-mcp-render-session {fileId: test file} [read token]",
        "HTTP 200 with a token",
        "medium"
    );
    push(
        await gated(mD0, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await rpc(cfg, "create-mcp-render-session", { fileId: F }, { token: cfg.readToken });
            const t = o.json?.token;
            if (o.status === 200 && typeof t === "string") {
                renderToken = t;
                return makeCase(mD0, scrub(o, t), true);
            }
            return makeCase(mD0, scrub(o), `expected HTTP 200 with a token, got HTTP ${o.status}`);
        })
    );

    const rpcRender = async (title, command, build, expected, judge) => {
        const m = meta(title, command, expected, "critical");
        push(
            await renderGate(m, async () => {
                const params = await build();
                m.request = `rpc ${command} ${JSON.stringify(params).slice(0, 200)} [render session cookie]`;
                const o = await rpc(cfg, command, params, { cookie: renderToken });
                return judge(m, scrub(o, renderToken));
            })
        );
    };

    const mP = meta(
        "get-profile with the render session (control)",
        "rpc get-profile {} [render session cookie]",
        "HTTP 200",
        "medium"
    );
    push(
        await renderGate(mP, async () => {
            const o = await rpc(cfg, "get-profile", {}, { cookie: renderToken });
            return makeCase(mP, scrub(o, renderToken), o.status === 200 ? true : `expected HTTP 200, got ${o.status}`);
        })
    );
    const mGF = meta(
        "get-file on the covered test file with the render session (allowed)",
        "rpc get-file {id: test file} [render session cookie]",
        "HTTP 200",
        "medium"
    );
    push(
        await renderGate(mGF, async () => {
            const o = await rpc(cfg, "get-file", { id: F }, { cookie: renderToken });
            return makeCase(mGF, scrub(o, renderToken), o.status === 200 ? true : `expected HTTP 200, got ${o.status}`);
        })
    );
    await rpcRender(
        "get-file on an agent file the session does not cover",
        "get-file",
        () => ({ id: cfg.vars.agentFileIds[0] }),
        "HTTP 403 session-restricted",
        (m, o) => judgeRpc(m, o, 403, "session-restricted")
    );
    const restrictedCalls = [
        ["update-file", () => ({ id: F, revn: 0, vern: 0, sessionId: uuid(), changes: [] })],
        ["create-access-token", () => ({ name: "adv", type: "mcp" })],
        ["update-mcp-token-scopes", () => ({ scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"] })],
        ["update-profile-props", () => ({ props: { mcpEnabled: true } })],
        ["get-teams", () => ({})],
        ["delete-file", () => ({ id: uuid() })],
        [
            "mcp-apply-operations",
            async () => ({
                fileId: F,
                operations: [
                    {
                        op: "create_rect",
                        pageId: await pageOf(),
                        id: "$tmp:adv",
                        name: ADV,
                        x: 1,
                        y: 1,
                        width: 1,
                        height: 1,
                    },
                ],
            }),
        ],
    ];
    for (const [command, build] of restrictedCalls) {
        await rpcRender(
            `render session calls ${command}`,
            command,
            build,
            "HTTP 403 session-restricted (or 401/403)",
            (m, o) => judgeStatus(m, o, [401, 403])
        );
    }

    // Websocket and debug routes: a render session must not open them.
    const mWs = meta(
        "websocket /ws/notifications with the render session cookie",
        "GET /ws/notifications upgrade [render session cookie] vs no cookie",
        "not 101, and the same status as with no cookie",
        "critical"
    );
    push(
        await renderGate(mWs, async () => {
            const url = `${base}/ws/notifications`;
            const none = await wsProbe(url, undefined);
            const withRender = await wsProbe(url, renderToken);
            const o = syntheticOutcome({
                status: withRender.status,
                text: `no-cookie=${none.status} render=${withRender.status}`,
            });
            if (withRender.status === 101) {
                return makeCase(mWs, o, "the render session opened a websocket (101)");
            }
            return makeCase(
                mWs,
                o,
                withRender.status === none.status ? true : "status differs from the no-cookie status"
            );
        })
    );
    for (const path of ["/dbg/", "/dbg/error"]) {
        const mDbg = meta(
            `GET ${path} with the render session cookie`,
            `GET ${base}${path} [render session cookie] vs no cookie`,
            "same status as with no cookie, never 200",
            "critical"
        );
        push(
            await renderGate(mDbg, async () => {
                const none = await httpCall(`${base}${path}`);
                const withRender = await httpCall(`${base}${path}`, {
                    headers: { cookie: `auth-token=${renderToken}` },
                });
                const o = scrub(withRender, renderToken);
                if (withRender.status === 200) {
                    return makeCase(mDbg, o, "the render session got HTTP 200 on a debug route");
                }
                return makeCase(
                    mDbg,
                    o,
                    withRender.status === none.status
                        ? true
                        : `status ${withRender.status}, no-cookie status ${none.status}`
                );
            })
        );
    }

    setOwn(outId);
    // Assets of another file: the outsider's media must not be served to the render session.
    const mAsset = meta(
        "render session reads media of an outsider file via /assets/by-file-media-id",
        "GET /assets/by-file-media-id/<outsider media> [render session cookie]",
        "HTTP 401, 403 or 404 (not 200)",
        "critical"
    );
    push(
        await gated(mAsset, cfg.outsiderToken, "ADV_TOKEN_DIR/adv-outsider.txt", () =>
            renderGate(mAsset, async () => {
                const st = await outsider();
                mAsset.request = "GET /assets/by-file-media-id/<outsider media> [render session cookie]";
                const o = await httpCall(`${base}/assets/by-file-media-id/${st.mediaId}`, {
                    headers: { cookie: `auth-token=${renderToken}` },
                });
                const safe = scrub(o, renderToken);
                if ([401, 403, 404].includes(o.status)) {
                    return makeCase(mAsset, safe, true);
                }
                return makeCase(mAsset, safe, `served media of another file: HTTP ${o.status}`);
            })
        )
    );
    const mAssetId = meta(
        "render session reads an outsider asset via /assets/by-id (contract 1.5 says no file check)",
        "GET /assets/by-id/<storage id of outsider media> [render session cookie]",
        "refused; a 200 is a documented gap (low)",
        "low"
    );
    push([notTestable(mAssetId, "import_image reply exposes no storage id, so the by-id route cannot be probed")]);

    // Cross-tenant reads with the outsider and read tokens.
    setOwn(outId);
    const mX1 = meta(
        "outsider token reads the test file outline",
        "get_file_outline {fileId: test file} [outsider token]",
        "refused (not found or authorization)",
        "critical"
    );
    push(
        await gated(mX1, cfg.outsiderToken, "ADV_TOKEN_DIR/adv-outsider.txt", async () => {
            const c = await connect(cfg, cfg.outsiderToken);
            try {
                const o = await tool(c, "get_file_outline", { fileId: F });
                return judgeRefusal(mX1, o, NOT_VISIBLE_RE);
            } finally {
                await closeQuietly(c);
            }
        })
    );
    setOwn(readId, outId);
    const mX2 = meta(
        "read token reads the outsider file outline",
        "get_file_outline {fileId: outsider file} [read token]",
        "refused (not found or authorization)",
        "critical"
    );
    push(
        await gated(
            mX2,
            cfg.readToken && cfg.outsiderToken,
            "ADV_TOKEN_DIR/adv-read.txt and adv-outsider.txt",
            async () => {
                const st = await outsider();
                mX2.request = "get_file_outline {fileId: outsider file} [read token]";
                const o = await tool(await pacedC(), "get_file_outline", { fileId: st.fileId });
                return judgeRefusal(mX2, o, NOT_VISIBLE_RE);
            }
        )
    );

    // Clean up the outsider file, with the outsider token, if it was created.
    if (outsiderRef.fileId) {
        try {
            const c = await connect(cfg, cfg.outsiderToken);
            await tool(c, "manage_files", { action: "delete_file", fileId: outsiderRef.fileId });
            await closeQuietly(c);
            log("outsider file cleaned up");
        } catch (e) {
            log(`outsider cleanup failed: ${e.message}`);
        }
    }

    // ---- E. token states: expired, revoked, switched off ----

    /** A token state through the adapter: connect or whoami must be refused. */
    const tokenStateCase = async (title, token, what) => {
        const m = meta(
            title,
            "connect with the token, then whoami",
            "connect or whoami refused (401, expired, revoked or mcp-disabled)",
            "critical"
        );
        push(
            await gated(m, token, what, async () => {
                let client;
                try {
                    client = await connect(cfg, token);
                } catch (e) {
                    const msg = String(e?.message ?? e);
                    return makeCase(
                        m,
                        syntheticOutcome({ error: msg }),
                        TOKEN_STATE_RE.test(msg) ? true : `connect failed without a refusal text: ${msg.slice(0, 120)}`
                    );
                }
                try {
                    const o = await tool(client, "whoami", {});
                    return judgeRefusal(m, o, TOKEN_STATE_RE);
                } finally {
                    await closeQuietly(client);
                }
            })
        );
    };
    setOwn(expId);
    await tokenStateCase("expired token through the adapter", cfg.expToken, "ADV_TOKEN_DIR/adv-exp.txt");
    setOwn(revId);
    await tokenStateCase("revoked token through the adapter", cfg.revokedToken, "ADV_TOKEN_DIR/adv-revoked.txt");
    setOwn(offId);
    await tokenStateCase("switched-off token through the adapter", cfg.offToken, "ADV_TOKEN_DIR/adv-off.txt");

    setOwn(expId);
    const mRawExp = meta(
        "expired token on the raw mcp-whoami",
        "rpc mcp-whoami [expired token]",
        "HTTP 401",
        "critical"
    );
    push(
        await gated(mRawExp, cfg.expToken, "ADV_TOKEN_DIR/adv-exp.txt", async () => {
            const o = await rpc(cfg, "mcp-whoami", {}, { token: cfg.expToken });
            return makeCase(mRawExp, o, o.status === 401 ? true : `expected HTTP 401, got ${o.status}`);
        })
    );
    setOwn(revId);
    const mRawRev = meta(
        "revoked token on the raw mcp-whoami",
        "rpc mcp-whoami [revoked token]",
        "HTTP 401",
        "critical"
    );
    push(
        await gated(mRawRev, cfg.revokedToken, "ADV_TOKEN_DIR/adv-revoked.txt", async () => {
            const o = await rpc(cfg, "mcp-whoami", {}, { token: cfg.revokedToken });
            return makeCase(mRawRev, o, o.status === 401 ? true : `expected HTTP 401, got ${o.status}`);
        })
    );
    setOwn(offId);
    const mRawOff = meta(
        "switched-off token on the raw mcp-whoami",
        "rpc mcp-whoami [switched-off token]",
        "HTTP 400 mcp-disabled",
        "critical"
    );
    push(
        await gated(mRawOff, cfg.offToken, "ADV_TOKEN_DIR/adv-off.txt", async () => {
            const o = await rpc(cfg, "mcp-whoami", {}, { token: cfg.offToken });
            return judgeRpc(mRawOff, o, 400, "mcp-disabled");
        })
    );

    setOwn(offId);
    const mSwitch = meta(
        "switched-off token tries to turn MCP back on",
        "rpc update-profile-props {mcpEnabled:true} [switched-off token]",
        "refused (HTTP 4xx)",
        "critical"
    );
    push(
        await gated(mSwitch, cfg.offToken, "ADV_TOKEN_DIR/adv-off.txt", async () => {
            const o = await rpc(cfg, "update-profile-props", { props: { mcpEnabled: true } }, { token: cfg.offToken });
            return makeCase(mSwitch, o, o.status >= 400 ? true : `accepted: HTTP ${o.status}`);
        })
    );
    setOwn(offId);
    const mSwitchStill = meta(
        "switched-off token is still refused after the switch attempt",
        "rpc mcp-whoami [switched-off token, after the switch attempt]",
        "HTTP 400 mcp-disabled (the switch did not flip)",
        "critical"
    );
    push(
        await gated(mSwitchStill, cfg.offToken, "ADV_TOKEN_DIR/adv-off.txt", async () => {
            const o = await rpc(cfg, "mcp-whoami", {}, { token: cfg.offToken });
            return judgeRpc(mSwitchStill, o, 400, "mcp-disabled");
        })
    );

    setOwn(readId);
    const mRdScopes = meta(
        "read token calls update-mcp-token-scopes with all scopes",
        "rpc update-mcp-token-scopes {all four} [read token]",
        "HTTP 403 session-required",
        "critical"
    );
    push(
        await gated(mRdScopes, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await rpc(
                cfg,
                "update-mcp-token-scopes",
                { scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"] },
                { token: cfg.readToken }
            );
            if (o.status === 403 && o.json?.code === "token-auth-required") {
                return contractCodeGap(
                    makeCase(mRdScopes, o, "refused with token-auth-required, contract 1.6 says session-required"),
                    o
                );
            }
            return judgeRpc(mRdScopes, o, 403, "session-required");
        })
    );
    setOwn(readId);
    const mRdStill = meta(
        "read token still shows only mcp:read after the scope change attempt",
        "whoami {} [read token, after the scope change attempt]",
        "scopes is exactly [mcp:read]",
        "critical"
    );
    push(
        await gated(mRdStill, cfg.readToken, "ADV_TOKEN_DIR/adv-read.txt", async () => {
            const o = await tool(await pacedC(), "whoami", {});
            const scopes = outcomeJson(o)?.scopes;
            const only = o.ok && Array.isArray(scopes) && scopes.length > 0 && scopes.every((s) => s === "mcp:read");
            return makeCase(mRdStill, o, only || `scopes are ${JSON.stringify(scopes)}`);
        })
    );

    // ---- F. OAuth client tokens (needs the session cookie of the test profile) ----
    setOwn(testId);

    const oauth = {};
    /** Generates a PKCE verifier and its S256 challenge. */
    const pkce = () => {
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        return { verifier, challenge };
    };
    const sessionHeader = () => `auth-token=${cfg.sessionCookie}`;
    /** Authorizes a client and returns the opaque request handle. */
    const authorize = async (clientId, challenge) => {
        const q = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: CB,
            code_challenge: challenge,
            code_challenge_method: "S256",
            scope: "mcp:read",
            state: "s1",
        });
        const o = await httpCall(`${base}/api/mcp/oauth/authorize?${q.toString()}`, { redirect: "manual" });
        if (o.status !== 302 && o.status !== 303) {
            throw new Error(`authorize answered HTTP ${o.status}`);
        }
        const handle = new URL(o.headers.location, base).searchParams.get("request");
        if (!handle) {
            throw new Error("authorize redirect has no request handle");
        }
        return handle;
    };
    /** Reads the approval page data (csrf) for a handle, as the logged-in user. */
    const prepareApproval = async (clientId) => {
        const handle = await authorize(clientId, pkce().challenge);
        const o = await httpCall(`${base}/api/mcp/oauth/request?request=${encodeURIComponent(handle)}`, {
            headers: { cookie: sessionHeader() },
        });
        if (o.status !== 200 || !o.json?.csrf) {
            throw new Error(`request answered HTTP ${o.status}`);
        }
        return { handle, csrf: o.json.csrf };
    };
    /** Posts a decision and returns the outcome. Origin is sent only when given. */
    const decide = async (prep, decision, origin) => {
        const headers = { cookie: sessionHeader(), "content-type": "application/x-www-form-urlencoded" };
        if (origin) {
            headers.origin = origin;
        }
        const body = new URLSearchParams({ request: prep.handle, csrf: prep.csrf, decision }).toString();
        return httpCall(`${base}/api/mcp/oauth/decision`, { method: "POST", headers, body });
    };
    /** Approves a fresh request for a client and returns the authorization code. */
    const approve = async (clientId, challenge) => {
        const handle = await authorize(clientId, challenge);
        const page = await httpCall(`${base}/api/mcp/oauth/request?request=${encodeURIComponent(handle)}`, {
            headers: { cookie: sessionHeader() },
        });
        if (page.status !== 200 || !page.json?.csrf) {
            throw new Error(`request answered HTTP ${page.status}`);
        }
        const d = await decide({ handle, csrf: page.json.csrf }, "approve", cfg.publicUrl);
        if (d.status !== 200) {
            throw new Error(`decision answered HTTP ${d.status}`);
        }
        const redirect = d.json?.["redirect-uri"] ?? d.json?.redirectUri;
        const code = redirect ? new URL(redirect).searchParams.get("code") : null;
        if (!code) {
            throw new Error("decision gave no code");
        }
        return code;
    };
    /** Exchanges a code at the token endpoint. */
    const exchange = (clientId, code, verifier) =>
        httpCall(`${base}/api/mcp/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: CB,
                code_verifier: verifier,
                client_id: clientId,
            }).toString(),
        });
    const gateF = (m, fn) => gated(m, cfg.sessionCookie, "ADV_SESSION_COOKIE_FILE", fn);

    const mF1 = meta(
        "register two public OAuth clients",
        "POST /api/mcp/oauth/register x2 (public, authorization_code)",
        "HTTP 201 with client_id for both",
        "medium"
    );
    push(
        await gateF(mF1, async () => {
            const reg = (client_name) =>
                httpCall(`${base}/api/mcp/oauth/register`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        client_name,
                        redirect_uris: [CB],
                        token_endpoint_auth_method: "none",
                        grant_types: ["authorization_code"],
                        response_types: ["code"],
                    }),
                });
            const a = await reg("adv-suite-A");
            const b = await reg("adv-suite-B");
            if (a.status === 201 && b.status === 201 && a.json?.client_id && b.json?.client_id) {
                oauth.a = a.json.client_id;
                oauth.b = b.json.client_id;
                return makeCase(mF1, a, true);
            }
            return makeCase(mF1, a, `register answered HTTP ${a.status} and ${b.status}`);
        })
    );

    const mF2 = meta(
        "code issued to client A cannot be exchanged by client B",
        "POST /api/mcp/oauth/token client_id=B with the code of client A",
        "refused: invalid_grant or invalid_client, no access_token",
        "critical"
    );
    push(
        await gateF(mF2, async () => {
            const p = pkce();
            const code = await approve(oauth.a, p.challenge);
            const o = await exchange(oauth.b, code, p.verifier);
            const leaked = o.json?.access_token;
            if (leaked) {
                return makeCase(mF2, scrub(o, leaked), "client B received an access_token for the code of client A");
            }
            return makeCase(
                mF2,
                o,
                o.status >= 400 && /invalid_grant|invalid_client/.test(textOf(o))
                    ? true
                    : `expected invalid_grant or invalid_client, got HTTP ${o.status}`
            );
        })
    );

    // One code for the verifier sequence: wrong verifier, right verifier, then reuse.
    let flow3;
    const getFlow3 = () =>
        (flow3 ??= (async () => {
            const p = pkce();
            const code = await approve(oauth.a, p.challenge);
            return { p, code };
        })());

    const mF3 = meta(
        "client A exchange with a wrong code_verifier",
        "POST /api/mcp/oauth/token client_id=A, wrong verifier",
        "refused: invalid_grant",
        "critical"
    );
    push(
        await gateF(mF3, async () => {
            const f = await getFlow3();
            const o = await exchange(oauth.a, f.code, pkce().verifier);
            const leaked = o.json?.access_token;
            if (leaked) {
                return makeCase(mF3, scrub(o, leaked), "a wrong verifier got an access_token");
            }
            return makeCase(
                mF3,
                o,
                o.status >= 400 && /invalid_grant/.test(textOf(o))
                    ? true
                    : `expected invalid_grant, got HTTP ${o.status}`
            );
        })
    );
    const mF4 = meta(
        "client A exchange with the right code_verifier (control)",
        "POST /api/mcp/oauth/token client_id=A, right verifier",
        "HTTP 200 with access_token and scope mcp:read",
        "medium"
    );
    push(
        await gateF(mF4, async () => {
            const f = await getFlow3();
            const o = await exchange(oauth.a, f.code, f.p.verifier);
            const token = o.json?.access_token;
            if (o.status === 200 && typeof token === "string") {
                oauth.accessToken = token;
                const scopeOk = o.json?.scope === "mcp:read";
                return makeCase(
                    mF4,
                    scrub(o, token),
                    scopeOk ? true : `scope is "${o.json?.scope}", expected "mcp:read"`
                );
            }
            return makeCase(mF4, scrub(o), `expected HTTP 200 with access_token, got HTTP ${o.status}`);
        })
    );
    const mF5 = meta(
        "the same code used again by client A",
        "POST /api/mcp/oauth/token client_id=A, code reused",
        "refused: invalid_grant (single use)",
        "critical"
    );
    push(
        await gateF(mF5, async () => {
            const f = await getFlow3();
            const o = await exchange(oauth.a, f.code, f.p.verifier);
            const leaked = o.json?.access_token;
            if (leaked) {
                return makeCase(mF5, scrub(o, leaked), "a reused code got a second access_token");
            }
            return makeCase(
                mF5,
                o,
                o.status >= 400 && /invalid_grant/.test(textOf(o))
                    ? true
                    : `expected invalid_grant, got HTTP ${o.status}`
            );
        })
    );

    const mF6 = meta(
        "client A token (mcp:read) through the adapter: apply_operations create_rect",
        "apply_operations create_rect on a fresh page [client A token]",
        "refused mcp-scope-required, nothing written",
        "critical"
    );
    push(
        await gated(mF6, oauth.accessToken, "the OAuth access token from case 1.xx", async () => {
            const c = await connect(cfg, oauth.accessToken);
            try {
                const o = await tool(c, "apply_operations", {
                    fileId: F,
                    operations: [
                        {
                            op: "create_rect",
                            pageId: await pageOf(),
                            id: "$tmp:adv",
                            name: ADV,
                            x: 10,
                            y: 10,
                            width: 10,
                            height: 10,
                        },
                    ],
                });
                return judgeRefusal(mF6, scrub(o, oauth.accessToken), SCOPE_RE);
            } finally {
                await closeQuietly(c);
            }
        })
    );

    const mF7 = meta(
        "decision POST without an Origin header",
        "POST /api/mcp/oauth/decision, no Origin, valid session and csrf",
        "HTTP 403 access_denied",
        "critical"
    );
    push(
        await gateF(mF7, async () => {
            const prep = await prepareApproval(oauth.a);
            const o = await decide(prep, "approve", null);
            return makeCase(
                mF7,
                o,
                o.status === 403 && /access_denied/.test(textOf(o))
                    ? true
                    : `expected 403 access_denied, got HTTP ${o.status}`
            );
        })
    );
    const mF8 = meta(
        "decision POST with Origin http://evil.example",
        "POST /api/mcp/oauth/decision, Origin http://evil.example, valid session and csrf",
        "HTTP 403",
        "critical"
    );
    push(
        await gateF(mF8, async () => {
            const prep = await prepareApproval(oauth.a);
            const o = await decide(prep, "approve", "http://evil.example");
            return makeCase(mF8, o, o.status === 403 ? true : `expected 403, got HTTP ${o.status}`);
        })
    );

    // Cleanup, not a case: remove only the OAuth client rows this suite created.
    if (cfg.sessionCookie) {
        try {
            const list = await rpc(cfg, "get-access-tokens", {}, { cookie: cfg.sessionCookie });
            const rows = listOf(list.json);
            let removed = 0;
            for (const row of rows) {
                if (typeof row.clientName === "string" && row.clientName.startsWith("adv-suite-")) {
                    const d = await rpc(cfg, "delete-access-token", { id: row.id }, { cookie: cfg.sessionCookie });
                    if (d.status === 200) {
                        removed += 1;
                    }
                }
            }
            log(`group 1 cleanup: removed ${removed} adv-suite OAuth token row(s)`);
        } catch (e) {
            log(`group 1 cleanup failed: ${e.message}`);
        }
    }

    return out;
}
