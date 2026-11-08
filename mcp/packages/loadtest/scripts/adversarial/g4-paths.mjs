// Group 4: file paths. export_shape filePath and import filePath must stay inside their roots: no traversal, no UNC,
// no device names, no alternate streams, no wrong extensions, and no link (junction or file symlink) that leads out.
import * as fs from "node:fs";
import * as path from "node:path";
import {
    tool,
    textOf,
    refused,
    makeCase,
    notTestable,
    guard,
    freshPage,
    pngBase64,
    sleep,
    mcpSession,
    mcpRaw,
} from "./lib.mjs";

/** Pause before each call, so that the adapter rate limit (burst 20, 10 per second) is never exhausted. */
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
export const name = "4-paths";

/** Words of a refusal that names a path problem. */
const PATH_REFUSAL =
    /absolute|relative|inside|outside|directory|extension|not allowed|invalid|null|link|junction|symbolic|must|forbidden|refus|denied|reserved|device|stream|filePath|file path/i;

/** Words of a refusal of a page export that takes a filePath. */
const PAGE_REFUSAL = /page|file ?path|by id|one shape|not supported|refus|not allowed/i;

/** Reserved Windows device names, with or without an extension. */
const DEVICE = /^(con|nul|prn|aux|com\d|lpt\d)(\.|$)/i;

/**
 * Tells whether something exists at a path, without touching device names.
 *
 * @param {string} p - the path to check
 * @returns {boolean} true when a file or link exists there
 */
function createdAt(p) {
    try {
        if (DEVICE.test(path.basename(p))) {
            return false;
        }
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

/**
 * Runs one refused-path case.
 *
 * @param {object} ctx - the group context
 * @param {object} meta - the case metadata
 * @param {{tool: string, args: object}} call - the tool and its arguments
 * @param {RegExp} pattern - the words a refusal must hold
 * @param {string|null} target - a path that must not hold a new file afterwards
 * @param {Function|null} after - returns a failure text when the state changed, or null
 * @returns {Promise<object>} the case
 */
async function pathCase(ctx, meta, call, pattern, target, after) {
    await sleep(PACE_MS);
    const o = await callPaced(ctx.control, call.tool, call.args, { timeoutMs: 60000 });
    const text = textOf(o);
    let verdict = true;
    let severity = meta.severity;
    if (o.timedOut) {
        verdict = "no answer within 60 s";
        severity = "medium";
    } else if (!refused(o)) {
        verdict = "accepted: the path was not refused";
    } else if (!pattern.test(text)) {
        verdict = "refusal does not name the path problem";
        severity = "medium";
    }
    if (target !== null && createdAt(target)) {
        verdict = `a file exists at the target after the call: ${target}`;
        severity = "high";
    }
    const extra = after ? after() : null;
    if (extra) {
        verdict = extra;
        severity = "high";
    }
    return makeCase({ ...meta, severity }, o, verdict);
}

/**
 * Creates one link inside the test roots and records it for removal.
 *
 * @param {Array<{link: string, kind: string}>} created - the list of links made so far
 * @param {string} target - the folder or file the link points to
 * @param {string} linkPath - the path of the link
 * @param {"junction"|"file"} kind - the link kind
 */
function makeLink(created, target, linkPath, kind) {
    fs.symlinkSync(target, linkPath, kind);
    created.push({ link: linkPath, kind });
}

/** Reason given for the cases that need a filePath argument when the server does not offer one. */
const REMOTE_REASON =
    "not testable: the server offers no filePath (remote mode, file system access is off); the argument is dropped";

/**
 * Tells whether the server offers the filePath argument of export_shape and import_image.
 *
 * @param {object} cfg - the configuration
 * @returns {Promise<boolean>} true when both tools list filePath in their input schema
 */
async function filePathOffered(cfg) {
    const s = await mcpSession(cfg, cfg.fullToken);
    const r = await mcpRaw(cfg, {
        token: cfg.fullToken,
        sessionId: s.sessionId,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        timeoutMs: 30000,
    });
    const msg = (r.messages ?? []).find((m) => m && m.result);
    const tools = msg?.result?.tools ?? [];
    const exp = tools.find((t) => t.name === "export_shape");
    const imp = tools.find((t) => t.name === "import_image");
    return Boolean(exp?.inputSchema?.properties?.filePath && imp?.inputSchema?.properties?.filePath);
}

/**
 * Removes the links that this group created, and the roots that it created when they are empty.
 *
 * @param {Array<{link: string, kind: string}>} created - the links to remove
 * @param {string[]} createdDirs - the roots that this group created
 */
function cleanup(created, createdDirs) {
    for (const { link, kind } of created) {
        try {
            if (kind === "junction") {
                fs.rmdirSync(link);
            } else {
                fs.unlinkSync(link);
            }
        } catch {
            // the link is gone or was never made
        }
    }
    for (const dir of createdDirs) {
        try {
            if (fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
            }
        } catch {
            // not empty or missing: leave it
        }
    }
}

/**
 * Runs group 4.
 *
 * @param {{cfg: object, control: object, log: Function}} ctx - the group context
 * @returns {Promise<object[]>} the cases of the group
 */
/**
 * Live case 4.00: tools/list must show no filePath property in the schemas of the three file tools.
 *
 * @param {object} cfg - the configuration
 * @returns {Promise<object[]>} the case
 */
async function schemaCase(cfg) {
    const meta = {
        group: name,
        id: "4.00",
        title: "tools/list shows no filePath in export_shape, import_image, import_archive",
        request: "tools/list via mcpRaw (session from mcpSession)",
        expected: "no filePath property in the three input schemas (remote mode)",
        severity: "medium",
        allowText: [],
    };
    return guard(meta, async () => {
        const s = await mcpSession(cfg, cfg.fullToken);
        const r = await mcpRaw(cfg, {
            token: cfg.fullToken,
            sessionId: s.sessionId,
            body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
            timeoutMs: 30000,
        });
        const msg = (r.messages ?? []).find((m) => m && m.result);
        const tools = msg?.result?.tools ?? [];
        const withFile = ["export_shape", "import_image", "import_archive"].filter((t) => {
            const found = tools.find((x) => x.name === t);
            return Boolean(found?.inputSchema?.properties?.filePath);
        });
        const verdict = withFile.length === 0 ? true : `filePath still offered by: ${withFile.join(", ")}`;
        return makeCase(meta, r, verdict);
    });
}

export async function run(ctx) {
    const { cfg, control } = ctx;
    const schemaCases = await schemaCase(cfg);
    const offered = await filePathOffered(cfg).catch(() => true);
    const stamp = Date.now();
    const exportDir = cfg.exportDir;
    const importDir = cfg.importDir;
    const scratch = cfg.scratchDir;
    const outside = `${scratch}\\outside`;
    const created = [];
    const createdDirs = [];
    let pageId;
    let shapeId;

    try {
        pageId = await freshPage(control, cfg, `adv-paths-${stamp}`);
        const o = await callPaced(control, "apply_operations", {
            fileId: cfg.vars.fileId,
            operations: [{ op: "create_rect", pageId, id: "$tmp:r", x: 40, y: 40, width: 40, height: 40 }],
        });
        shapeId = o.json?.createdIds?.["$tmp:r"];
        if (!shapeId) {
            throw new Error(`no shape id in reply: ${textOf(o).slice(0, 160)}`);
        }
    } catch (e) {
        return [
            ...schemaCases,
            notTestable(
                {
                    group: name,
                    id: "4.99",
                    title: "setup: fresh page and one rect",
                    request: "freshPage + apply_operations create_rect",
                    expected: "a shape to export",
                    severity: "high",
                },
                `setup failed: ${e.message}`
            ),
        ];
    }

    let junctionError = null;
    let fileLinkError = null;
    const outsideIn = `${outside}\\in.png`;
    let originalPng = null;
    try {
        for (const dir of [exportDir, importDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                createdDirs.push(dir);
            }
        }
        fs.mkdirSync(outside, { recursive: true });
        originalPng = Buffer.from(pngBase64(), "base64");
        fs.writeFileSync(outsideIn, originalPng);

        const exportJunction = `${exportDir}\\adv-junction-${stamp}`;
        try {
            makeLink(created, outside, exportJunction, "junction");
        } catch (e) {
            junctionError = `junction could not be made: ${e.message}`;
        }
        const importJunction = `${importDir}\\adv-junction2-${stamp}`;
        try {
            makeLink(created, outside, importJunction, "junction");
        } catch (e) {
            junctionError = junctionError ?? `junction could not be made: ${e.message}`;
        }
        const exportFileLink = `${exportDir}\\adv-filelink-${stamp}.png`;
        try {
            makeLink(created, outsideIn, exportFileLink, "file");
        } catch (e) {
            fileLinkError = `file symlink not testable: ${e.message}`;
        }

        const roots = [exportDir, importDir];
        const exp = (filePath, extra = {}) => ({
            tool: "export_shape",
            args: { fileId: cfg.vars.fileId, pageId, shapeId, format: "png", filePath, ...extra },
        });
        const imp = (filePath) => ({
            tool: "import_image",
            args: { fileId: cfg.vars.fileId, filePath, createShape: false },
        });

        const specs = [
            {
                title: "export outside root: absolute path in scratch",
                call: exp(`${scratch}\\out1.png`),
                target: `${scratch}\\out1.png`,
            },
            {
                title: "export outside root: C:\\Windows\\Temp",
                call: exp("C:\\Windows\\Temp\\adv-out.png"),
                target: "C:\\Windows\\Temp\\adv-out.png",
            },
            { title: "export relative path with traversal", call: exp("..\\adv.png"), target: "..\\adv.png" },
            { title: "export relative path", call: exp("adv.png"), target: "adv.png" },
            {
                title: "export traversal out of root",
                call: exp(`${exportDir}\\..\\adv-escape.png`),
                target: `${exportDir}\\..\\adv-escape.png`,
            },
            {
                title: "export traversal after a subfolder",
                call: exp(`${exportDir}\\sub\\..\\..\\adv-escape2.png`),
                target: `${exportDir}\\sub\\..\\..\\adv-escape2.png`,
            },
            {
                title: "export UNC path to C$ share",
                call: exp("\\\\127.0.0.1\\C$\\adv.png"),
                target: "\\\\127.0.0.1\\C$\\adv.png",
            },
            { title: "export extended-length path", call: exp("\\\\?\\C:\\adv.png"), target: "\\\\?\\C:\\adv.png" },
            { title: "export POSIX absolute path", call: exp("/etc/adv.png"), target: "/etc/adv.png" },
            {
                title: "export wrong extension .exe",
                call: exp(`${exportDir}\\adv.exe`),
                target: `${exportDir}\\adv.exe`,
            },
            {
                title: "export alternate data stream name",
                call: exp(`${exportDir}\\adv.png:evil.exe`),
                target: `${exportDir}\\adv.png:evil.exe`,
            },
            {
                title: "export reserved device name CON",
                call: exp(`${exportDir}\\CON.png`),
                target: `${exportDir}\\CON.png`,
            },
            { title: "export path with NUL byte", call: exp(`${exportDir}\\a\u0000.png`), target: null },
            {
                title: "export filePath in remote mode is refused, not silently dropped",
                call: exp(`${scratch}\\silent.png`),
                target: `${scratch}\\silent.png`,
                runsInRemote: true,
                severity: "low",
            },
            {
                title: "export page with filePath is refused",
                call: {
                    tool: "export_shape",
                    args: {
                        fileId: cfg.vars.fileId,
                        pageId,
                        shapeId: "page",
                        format: "png",
                        filePath: `${exportDir}\\pg-${stamp}.png`,
                    },
                },
                target: `${exportDir}\\pg-${stamp}.png`,
                pattern: PAGE_REFUSAL,
            },
            {
                title: "export through a junction to an outside folder",
                call: exp(`${exportDir}\\adv-junction-${stamp}\\x.png`),
                target: `${exportDir}\\adv-junction-${stamp}\\x.png`,
                skip: junctionError,
            },
            {
                title: "export over a file symlink with overwrite",
                call: exp(exportFileLink, { overwrite: true }),
                target: null,
                skip: fileLinkError,
                after: () => {
                    try {
                        return Buffer.compare(fs.readFileSync(outsideIn), originalPng) === 0
                            ? null
                            : "the outside file was replaced through the symlink";
                    } catch (e) {
                        return `could not read the outside file: ${e.message}`;
                    }
                },
            },
            { title: "import outside root: C:\\Windows\\win.ini", call: imp("C:\\Windows\\win.ini"), target: null },
            { title: "import traversal out of root", call: imp(`${importDir}\\..\\x.png`), target: null },
            { title: "import relative path", call: imp("x.png"), target: null },
            { title: "import UNC path to C$ share", call: imp("\\\\127.0.0.1\\C$\\Windows\\win.ini"), target: null },
            { title: "import from scratch folder outside root", call: imp(outsideIn), target: null },
            {
                title: "import through a junction to an outside folder",
                call: imp(`${importDir}\\adv-junction2-${stamp}\\in.png`),
                target: null,
                skip: junctionError,
            },
            {
                title: "import_archive filePath C:\\Windows\\win.ini",
                call: {
                    tool: "import_archive",
                    args: { projectId: cfg.vars.projectId, filePath: "C:\\Windows\\win.ini" },
                },
                target: null,
            },
        ];

        const cases = [];
        let n = 0;
        for (const spec of specs) {
            n++;
            const id = `4.${String(n).padStart(2, "0")}`;
            const allowText = [exportDir, importDir];
            for (const v of [spec.call.args.filePath, spec.target]) {
                if (typeof v === "string") {
                    allowText.push(v);
                }
            }
            const meta = {
                group: name,
                id,
                title: spec.title,
                request: `${spec.call.tool} ${JSON.stringify({ ...spec.call.args, fileId: "<fileId>" })}`,
                expected: "refused with a clear message about the path; no file created at the target",
                severity: spec.severity ?? "high",
                allowText,
            };
            const remoteBlocked = !offered && !spec.runsInRemote;
            const reason = spec.skip ?? (remoteBlocked ? REMOTE_REASON : null);
            if (reason) {
                cases.push(notTestable(meta, reason));
                continue;
            }
            cases.push(
                ...(await guard(meta, () =>
                    pathCase(ctx, meta, spec.call, spec.pattern ?? PATH_REFUSAL, spec.target, spec.after ?? null)
                ))
            );
        }
        return [...schemaCases, ...cases];
    } finally {
        cleanup(created, createdDirs);
    }
}
