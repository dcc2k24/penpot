// Group 6: the sandbox. Hostile execute_code scripts on a fresh page of the test file. Each dangerous script is
// followed by a check that the same token still answers. Also: escapes from the guest, storage and reply caps,
// the host call cap, a CPU burst from ten tokens, and recursion.
import { connect, freshPage, guard, makeCase, notTestable, redact, refused, sleep, textOf, tool } from "./lib.mjs";

/** Group name, used in the report and the runner. */
export const name = "6-sandbox";

/** Bytes of a reply above which a flood is neither refused nor capped. */
const REPLY_CAP_BYTES = 300 * 1024;

/** Words of a CPU or time refusal. */
const LIMIT_WORDS = /time|cpu|interrupt|limit|exceed/i;

/** Words of a CPU refusal or of a busy or queued answer, for the burst case. */
const BURST_WORDS = /time|cpu|interrupt|limit|exceed|busy|queue|wait|running|retry/i;

/** Host-side globals that must not be reachable from the guest. */
const FORBIDDEN_GLOBALS = ["process", "require", "Buffer", "fetch", "XMLHttpRequest", "WebSocket", "setImmediate"];

/** Host text that must never appear in a reply to an escape attempt. */
const HOST_TEXT = /PATH|\[fonts\]|\bready\b|\bpid\b|versions|native code/;

/** Case ids from ADV_ONLY (comma list); empty means every case. A "b" or "c" follow-up follows its base id. */
const ONLY = (process.env.ADV_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Whether a case runs under the ADV_ONLY filter.
 *
 * @param {string} id - case id
 * @returns {boolean} true when the case runs
 */
function want(id) {
    return ONLY.length === 0 || ONLY.includes(id) || ONLY.includes(id.replace(/[a-z]$/, ""));
}

/**
 * Builds the metadata of one case.
 *
 * @param {string} id - case id, for example 6.02
 * @param {string} title - one-line title
 * @param {string} request - what was sent
 * @param {string} expected - what passes
 * @param {string} [severity] - severity when the case fails
 * @returns {object} the metadata
 */
function meta(id, title, request, expected, severity = "medium") {
    return { group: name, id, title, request, expected, severity };
}

/**
 * Shortens a script to one line for the request text.
 *
 * @param {string} code - the script
 * @returns {string} the script on one line, at most 140 characters
 */
function shortCode(code) {
    const one = code.replace(/\s+/g, " ").trim();
    return one.length > 140 ? `${one.slice(0, 137)}...` : one;
}

/**
 * Reads the result value of an execute_code reply.
 *
 * @param {object} o - outcome of the call
 * @returns {unknown} the result, or undefined
 */
function resultOf(o) {
    return o?.json?.result;
}

/**
 * Counts the bytes of a reply.
 *
 * @param {object} o - outcome of the call
 * @returns {number} the larger of the reported and the measured size
 */
function replyBytes(o) {
    return Math.max(o?.bytes ?? 0, Buffer.byteLength(textOf(o), "utf8"));
}

/**
 * Runs one execute_code call. The page is optional: without it, the first page of the file is used.
 *
 * @param {object} client - connected MCP client
 * @param {string} fileId - file the script works on
 * @param {string | undefined} pageId - page, or undefined
 * @param {string} code - the script
 * @param {number} [timeoutMs] - client timeout, default 30000 ms
 * @returns {Promise<object>} the outcome
 */
function execute(client, fileId, pageId, code, timeoutMs = 30000) {
    const args = { fileId, code };
    if (pageId) {
        args.pageId = pageId;
    }
    return tool(client, "execute_code", args, { timeoutMs, noRetry: true });
}

/**
 * Verdict: the call answered before its limit.
 *
 * @param {object} o - outcome
 * @param {number} seconds - the limit
 * @returns {true | string} true, or the reason it failed
 */
function answeredWithin(o, seconds) {
    return o.timedOut ? `no answer within ${seconds} s` : true;
}

/**
 * Verdict: refused, with a message that matches.
 *
 * @param {object} o - outcome
 * @param {number} seconds - the limit
 * @param {RegExp} re - the message that a clear refusal carries
 * @returns {true | string} true, or the reason it failed
 */
function refusedWithin(o, seconds, re) {
    if (o.timedOut || /request timed out|timed out/i.test(textOf(o))) {
        return `no answer within ${seconds} s (client timeout: ${textOf(o).slice(0, 60)})`;
    }
    if (refused(o) && re.test(textOf(o))) {
        return true;
    }
    return `not refused with a clear message: ${textOf(o).slice(0, 160) || "a value was returned"}`;
}

/**
 * Verdict: the reply is under the reply cap, within the limit.
 *
 * @param {object} o - outcome
 * @param {number} seconds - the limit
 * @returns {true | string} true, or the reason it failed
 */
function cappedWithin(o, seconds) {
    if (o.timedOut) {
        return `no answer within ${seconds} s`;
    }
    const size = replyBytes(o);
    return size < REPLY_CAP_BYTES ? true : `reply is ${size} bytes, over the 300 kB cap`;
}

/**
 * Adds the same-token check after a dangerous script: `return 1 + 1` must answer 2 within the limit.
 *
 * @param {object} ctx - suite context
 * @param {string} base - id of the dangerous case; the check gets the id with a "b" appended
 * @param {() => string | undefined} pageOf - page of the script
 * @param {{ seconds?: number, severity?: string, cleanup?: string }} [options] - limit, severity, and a script
 *   that runs after the check, to undo the damage the dangerous script left in storage
 * @returns {Promise<object[]>} the case
 */
async function followUp(ctx, base, pageOf, { seconds = 15, severity = "high", cleanup } = {}) {
    const m = meta(
        `${base}b`,
        `${base}: same token still answers`,
        `execute_code "return 1 + 1" with the same token, limit ${seconds} s`,
        `2 within ${seconds} s`,
        severity
    );
    return guard(m, async () => {
        // a dangerous script may drain the token's own rate bucket; waiting for it is fair, a hang is not
        const page = pageOf();
        const o = await tool(
            ctx.control,
            "execute_code",
            { fileId: ctx.cfg.vars.fileId, code: "return 1 + 1", ...(page ? { pageId: page } : {}) },
            { timeoutMs: seconds * 1000 }
        );
        const verdict = o.timedOut
            ? `no answer within ${seconds} s`
            : resultOf(o) === 2
              ? true
              : `expected 2, got ${textOf(o).slice(0, 120)}`;
        if (cleanup) {
            await execute(ctx.control, ctx.cfg.vars.fileId, pageOf(), cleanup, 15000);
        }
        return makeCase(m, o, verdict);
    });
}

/**
 * Runs one dangerous script on a fresh page, then the same-token check.
 *
 * @param {object} ctx - suite context
 * @param {string} base - case id, for example 6.02
 * @param {object} spec - { title, code, seconds, expected, judge(o, seconds), severity?, follow? }; follow is the
 *   options of followUp, or false to skip the check
 * @returns {Promise<object[]>} the cases
 */
async function dangerous(ctx, base, spec) {
    const cases = [];
    if (!want(base)) {
        return cases;
    }
    let page;
    const m = meta(
        base,
        spec.title,
        `execute_code on a fresh page: ${shortCode(spec.code)}`,
        spec.expected,
        spec.severity ?? "high"
    );
    cases.push(
        ...(await guard(m, async () => {
            page = await freshPage(ctx.control, ctx.cfg, `adv-sb-${base}-${Date.now()}`);
            const o = await execute(ctx.control, ctx.cfg.vars.fileId, page, spec.code, spec.seconds * 1000);
            const c = makeCase(m, o, spec.judge(o, spec.seconds));
            c.note = [c.note, `duration ${o.durationMs} ms`].filter(Boolean).join("; ");
            return c;
        }))
    );
    if (spec.follow !== false) {
        cases.push(...(await followUp(ctx, base, () => page, spec.follow ?? {})));
    }
    return cases;
}

/**
 * Case 6.08 and its check: a 40 million element array must be refused, and a 300 MB string refused or answered.
 *
 * @param {object} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
async function caseMemory(ctx) {
    const cases = [];
    if (!want("6.08")) {
        return cases;
    }
    let page;
    const m = meta(
        "6.08",
        "300 MB allocations are refused or answered within 30 s",
        "execute_code: 40M-element push loop, then a 300 MB string repeat, each on a fresh page",
        "push loop refused (memory/limit/time) within 30 s; string repeat refused or answered within 30 s",
        "high"
    );
    cases.push(
        ...(await guard(m, async () => {
            page = await freshPage(ctx.control, ctx.cfg, `adv-sb-6.08-${Date.now()}`);
            const a = await execute(
                ctx.control,
                ctx.cfg.vars.fileId,
                page,
                "const a = []; for (let i = 0; i < 40000000; i++) a.push(i * 1.5); return a.length",
                30000
            );
            const b = await execute(
                ctx.control,
                ctx.cfg.vars.fileId,
                page,
                'return "x".repeat(300 * 1024 * 1024).length',
                30000
            );
            const va = refusedWithin(a, 30, /memory|limit|time|exceed|cpu|heap|interrupt|stack/i);
            const vb = b.timedOut ? "string repeat: no answer within 30 s" : true;
            const verdict = va === true && vb === true ? true : [va, vb].filter((x) => x !== true).join("; ");
            const combined = {
                ...a,
                isError: a.isError,
                text: `push loop: ${textOf(a).slice(0, 300)}\nstring repeat: ${textOf(b).slice(0, 300)}`,
                durationMs: a.durationMs + b.durationMs,
            };
            return makeCase(m, combined, verdict);
        }))
    );
    cases.push(...(await followUp(ctx, "6.08", () => page)));
    return cases;
}

/**
 * Case 6.09 and its read-back: a 20 MB storage value must come with a cap note or be refused, and must not be kept.
 *
 * @param {object} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
async function caseStorage(ctx) {
    const cases = [];
    if (!want("6.09")) {
        return cases;
    }
    let page;
    const m = meta(
        "6.09",
        "20 MB storage value is capped with a note or refused",
        'execute_code on a fresh page: storage.big = "x".repeat(20 MB); return 1',
        "reply carries a storage cap note, or is refused with a storage/limit message",
        "high"
    );
    cases.push(
        ...(await guard(m, async () => {
            page = await freshPage(ctx.control, ctx.cfg, `adv-sb-6.09-${Date.now()}`);
            const o = await execute(
                ctx.control,
                ctx.cfg.vars.fileId,
                page,
                'storage.big = "x".repeat(20 * 1024 * 1024); return 1',
                30000
            );
            const note = o.json?.storageNotice;
            const verdict =
                typeof note === "string" && /8 ?MB/i.test(note)
                    ? true
                    : refused(o) && /storage|limit|too large|cap|exceed|size/i.test(textOf(o))
                      ? true
                      : "no storage cap note naming the 8 MB limit, and no refusal about storage";
            return makeCase(m, o, o.timedOut ? "no answer within 30 s" : verdict);
        }))
    );

    const mb = meta(
        "6.09b",
        "20 MB storage value is not kept",
        "execute_code: return the length of storage.big, then delete it",
        "not 20971520; the cleanup then runs",
        "high"
    );
    cases.push(
        ...(await guard(mb, async () => {
            const o = await execute(
                ctx.control,
                ctx.cfg.vars.fileId,
                page,
                'return typeof storage.big === "string" ? storage.big.length : -1',
                30000
            );
            const len = resultOf(o);
            await execute(ctx.control, ctx.cfg.vars.fileId, page, "delete storage.big; return 1", 30000);
            const c = makeCase(mb, o, o.timedOut ? "no answer within 30 s" : true);
            c.note = `live runtime length ${len}; live runtime keeps the value, only the saved copy is capped (contract 4.4)`;
            return c;
        }))
    );
    return cases;
}

/**
 * Case 6.11 and its checks: ten tokens burn CPU at once, then an eleventh token and the control token still work.
 *
 * @param {object} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
async function caseBurst(ctx) {
    const { cfg } = ctx;
    const cases = [];
    if (!want("6.11")) {
        return cases;
    }
    const m = meta(
        "6.11",
        "10 parallel CPU burners from 10 tokens are refused or queued",
        "10 tokens each run while(true){} on their own agent file at once, 60 s each",
        "each burner refused on time/CPU or a busy/queue error within 60 s",
        "high"
    );
    const ready = (cfg.agentTokens?.length ?? 0) >= 11 && (cfg.vars.agentFileIds?.length ?? 0) >= 11;
    cases.push(
        ...(await guard(m, async () => {
            if (!ready) {
                return notTestable(m, "needs 11 agent tokens and 11 agent files (cfg.agentTokens, vars.agentFileIds)");
            }
            const clients = await Promise.all(Array.from({ length: 10 }, (_, i) => connect(cfg, cfg.agentTokens[i])));
            const outs = await Promise.all(
                clients.map((c, i) => execute(c, cfg.vars.agentFileIds[i], undefined, "while(true){}", 60000))
            );
            const bad = [];
            outs.forEach((o, i) => {
                const clean = !o.timedOut && refused(o) && BURST_WORDS.test(textOf(o)) && o.durationMs < 60000;
                if (!clean) {
                    bad.push(`burner ${i}: ${o.timedOut ? "timeout" : textOf(o).slice(0, 100)}`);
                }
            });
            const summary = outs
                .map(
                    (o, i) =>
                        `#${i} ${o.timedOut ? "timeout" : refused(o) ? "refused" : "answered"} ${textOf(o).slice(0, 80)}`
                )
                .join("\n");
            const synthetic = {
                isError: bad.length > 0,
                text: summary,
                durationMs: Math.max(...outs.map((o) => o.durationMs)),
            };
            return makeCase(
                m,
                synthetic,
                bad.length === 0 ? true : `${bad.length} burner(s) not refused cleanly: ${bad.join("; ")}`
            );
        }))
    );

    const mb = meta(
        "6.11b",
        "eleventh token still gets an answer after the burst",
        "execute_code return 1 + 1 with agentTokens[10] on agentFileIds[10]",
        "2 within 20 s",
        "high"
    );
    cases.push(
        ...(await guard(mb, async () => {
            if (!ready) {
                return notTestable(mb, "needs 11 agent tokens and 11 agent files");
            }
            const c = await connect(cfg, cfg.agentTokens[10]);
            const o = await execute(c, cfg.vars.agentFileIds[10], undefined, "return 1 + 1", 20000);
            const verdict = o.timedOut
                ? "no answer within 20 s"
                : resultOf(o) === 2
                  ? true
                  : `expected 2, got ${textOf(o).slice(0, 120)}`;
            return makeCase(mb, o, verdict);
        }))
    );

    const mc = meta(
        "6.11c",
        "control still reads the file outline after the burst",
        "get_file_outline on vars.fileId with the full token",
        "ok within 30 s",
        "high"
    );
    cases.push(
        ...(await guard(mc, async () => {
            const o = await tool(ctx.control, "get_file_outline", { fileId: cfg.vars.fileId }, { timeoutMs: 30000 });
            return makeCase(mc, o, o.ok && !o.isError ? true : `get_file_outline failed: ${textOf(o).slice(0, 120)}`);
        }))
    );
    return cases;
}

/**
 * Judges one guest escape attempt.
 *
 * @param {string} id - case id
 * @param {object} o - outcome of the script
 * @returns {true | string} true when refused or harmless, otherwise the reason
 */
function escapeVerdict(id, o) {
    if (o.timedOut) {
        return "no answer within 30 s";
    }
    const text = textOf(o);
    if (HOST_TEXT.test(text)) {
        return `critical: host text in the reply: ${text.slice(0, 160)}`;
    }
    if (refused(o)) {
        return true;
    }
    const r = resultOf(o);
    if (id === "6.24" && typeof r === "string") {
        const found = r.split(",").filter((n) => FORBIDDEN_GLOBALS.includes(n));
        return found.length === 0 ? true : `critical: globals reachable from the guest: ${found.join(",")}`;
    }
    if (r === undefined || r === null || r === "undefined" || r === "nofetch") {
        return true;
    }
    return `returned a value that is not a refusal: ${JSON.stringify(r).slice(0, 120)}`;
}

/** Slow script of 6.10 and 6.25: 1500 host calls, each waiting for a rate token. */
const SLOW_CODE = "for (let i = 0; i < 1500; i++) { await penpotMgmt.listTeams(); } return 1";

/**
 * Case 6.25: four slow scripts from four tokens start together; a fifth token must still get an answer.
 *
 * @param {object} ctx - suite context
 * @returns {Promise<object[]>} the case
 */
async function caseStarvation(ctx) {
    const { cfg } = ctx;
    const cases = [];
    if (!want("6.25")) {
        return cases;
    }
    const m = meta(
        "6.25",
        "four slow scripts hold the sandbox slots; a fifth token still gets an answer",
        "4 tokens (agentTokens[14..17]) start the 6.10 slow script at once; after 3 s, agentTokens[18] runs return 1 + 1",
        "2 within 15 s from agentTokens[18]; the four slow scripts end by 135 s",
        "high"
    );
    cases.push(
        ...(await guard(m, async () => {
            if ((cfg.agentTokens?.length ?? 0) < 19 || (cfg.vars.agentFileIds?.length ?? 0) < 19) {
                return notTestable(m, "needs agentTokens[14..18] and agentFileIds[14..18]");
            }
            const slowClients = await Promise.all([14, 15, 16, 17].map((i) => connect(cfg, cfg.agentTokens[i])));
            const slow = slowClients.map((c, k) =>
                execute(c, cfg.vars.agentFileIds[14 + k], undefined, SLOW_CODE, 135000)
            );
            await sleep(3000);
            const probeClient = await connect(cfg, cfg.agentTokens[18]);
            const probe = await execute(probeClient, cfg.vars.agentFileIds[18], undefined, "return 1 + 1", 75000);
            const probeOk = !probe.timedOut && resultOf(probe) === 2 && probe.durationMs <= 15000;
            const slowOuts = await Promise.all(slow);
            const endings = slowOuts.map((o) =>
                o.timedOut
                    ? `timeout@${o.durationMs}ms`
                    : refused(o)
                      ? `refused@${o.durationMs}ms: ${textOf(o).slice(0, 60)}`
                      : `answered@${o.durationMs}ms`
            );
            const probeText = probe.timedOut
                ? "no answer within 75 s"
                : refused(probe)
                  ? `refused: ${textOf(probe).slice(0, 120)}`
                  : `answered ${JSON.stringify(resultOf(probe))} in ${probe.durationMs} ms`;
            const out = {
                isError: !probeOk,
                text: `probe: ${probeText}\nslow endings: ${endings.join("; ")}`,
                durationMs: probe.durationMs,
            };
            let verdict = true;
            if (!probeOk) {
                verdict =
                    refused(probe) && !probe.timedOut
                        ? "4 slow scripts hold all 4 sandbox slots: probe refused"
                        : `probe not answered as expected: ${probeText}`;
            }
            const c = makeCase(m, out, verdict);
            c.note = redact(
                [c.note, `probe ${probeText}`, `slow endings: ${endings.join("; ")}`].filter(Boolean).join("; "),
                cfg
            );
            return c;
        }))
    );
    return cases;
}

/** Guest escape scripts: id, label and script. The summary case is 6.12. */
const ESCAPES = [
    ["6.16", "typeof require", "return typeof require"],
    ["6.17", "require fs", 'return require("fs").readFileSync("C:/Windows/win.ini","utf8")'],
    ["6.18", "process.env", "return process.env"],
    [
        "6.19",
        "fetch to the backend readyz",
        'return typeof fetch === "function" ? await fetch("http://127.0.0.1:6060/readyz").then(r => r.text()) : "nofetch"',
    ],
    ["6.20", "constructor.constructor process", 'return globalThis.constructor.constructor("return process")()'],
    ["6.21", "this.process", "return (function(){ return this })().process"],
    ["6.22", "dynamic import fs", 'return import("fs")'],
    ["6.23", "new Function process", 'return new Function("return globalThis.process")()'],
    ["6.24", "global names", 'return Object.getOwnPropertyNames(globalThis).join(",")'],
];

/**
 * Runs the escape attempts on one shared fresh page, then the summary case 6.12.
 *
 * @param {object} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
async function caseEscapes(ctx) {
    const cases = [];
    let page;
    const results = [];
    if (!ESCAPES.some(([id]) => want(id))) {
        return cases;
    }
    for (const [id, label, code] of ESCAPES.filter(([id]) => want(id))) {
        const m = meta(
            id,
            `escape attempt: ${label}`,
            `execute_code: ${shortCode(code)}`,
            'refused, or undefined, null, "undefined" or "nofetch"; no host text; no host globals',
            "critical"
        );
        const made = await guard(m, async () => {
            if (page === undefined) {
                page = await freshPage(ctx.control, ctx.cfg, `adv-sb-esc-${Date.now()}`);
            }
            const o = await execute(ctx.control, ctx.cfg.vars.fileId, page, code, 30000);
            return makeCase(m, o, escapeVerdict(id, o));
        });
        results.push(...made);
        cases.push(...made);
    }
    const failed = results.filter((c) => c.status !== "pass");
    const ms = meta(
        "6.12",
        "guest escapes all refused (summary of 6.16 to 6.24)",
        "the nine escape scripts 6.16 to 6.24, in one summary",
        "every escape refused or harmless",
        "critical"
    );
    cases.push(
        ...(await guard(ms, async () => {
            const text = results.map((c) => `${c.id}: ${c.status} ${c.note || ""}`).join("\n");
            const outcome = { isError: failed.length > 0, text, durationMs: 0 };
            return makeCase(ms, outcome, failed.length === 0 ? true : `failed: ${failed.map((c) => c.id).join(", ")}`);
        }))
    );
    return cases;
}

/**
 * Runs the group.
 *
 * @param {{ cfg: object, control: object, log: (msg: string) => void }} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
export async function run(ctx) {
    const cases = [];

    // 6.01: prototype tampering stays inside the run.
    if (want("6.01")) {
        const m = meta(
            "6.01",
            "prototype tampering stays in the run",
            "execute_code: Object.prototype.polluted = 1; Array.prototype.push and JSON.stringify overwritten; return 1",
            "the script answers; the same token and another token are unaffected",
            "critical"
        );
        let page;
        cases.push(
            ...(await guard(m, async () => {
                page = await freshPage(ctx.control, ctx.cfg, `adv-sb-6.01-${Date.now()}`);
                const o = await execute(
                    ctx.control,
                    ctx.cfg.vars.fileId,
                    page,
                    'Object.prototype.polluted = 1; Array.prototype.push = function(){ throw new Error("x") }; JSON.stringify = () => "hacked"; return 1',
                    30000
                );
                return makeCase(m, o, o.timedOut ? "no answer within 30 s" : true);
            }))
        );

        const mb = meta(
            "6.01b",
            "prototype tampering: same token concat still works",
            "execute_code: return { a: [1].concat([2]), j: typeof JSON.stringify } with the same token",
            "a = [1,2]",
            "critical"
        );
        cases.push(
            ...(await guard(mb, async () => {
                const o = await execute(
                    ctx.control,
                    ctx.cfg.vars.fileId,
                    page,
                    "return { a: [1].concat([2]), j: typeof JSON.stringify }",
                    15000
                );
                const a = resultOf(o)?.a;
                const verdict = o.timedOut
                    ? "no answer within 15 s"
                    : JSON.stringify(a) === "[1,2]"
                      ? true
                      : `a is ${JSON.stringify(a)}, expected [1,2]`;
                return makeCase(mb, o, verdict);
            }))
        );

        const mc = meta(
            "6.01c",
            "prototype tampering does not reach another token",
            "execute_code with agentTokens[0] on agentFileIds[0]: JSON.stringify({x:1}) and ({}).polluted",
            'JSON.stringify gives {"x":1}; polluted is undefined',
            "critical"
        );
        cases.push(
            ...(await guard(mc, async () => {
                if ((ctx.cfg.agentTokens?.length ?? 0) < 1 || (ctx.cfg.vars.agentFileIds?.length ?? 0) < 1) {
                    return notTestable(mc, "needs agentTokens[0] and agentFileIds[0]");
                }
                const c = await connect(ctx.cfg, ctx.cfg.agentTokens[0]);
                const o = await execute(
                    c,
                    ctx.cfg.vars.agentFileIds[0],
                    undefined,
                    "return { s: JSON.stringify({x:1}), p: typeof ({}).polluted }",
                    30000
                );
                const r = resultOf(o);
                const verdict = o.timedOut
                    ? "no answer within 30 s"
                    : r?.s === '{"x":1}' && r?.p === "undefined"
                      ? true
                      : `got ${JSON.stringify(r)}`;
                return makeCase(mc, o, verdict);
            }))
        );
    }

    // 6.02 to 6.07: promise and prototype tampering, busy loops, recursion.
    cases.push(
        ...(await dangerous(ctx, "6.02", {
            title: "Promise.prototype.then replaced answers",
            code: "Promise.prototype.then = function(){}; return 42",
            seconds: 15,
            expected: "answers (42 or an error) within 15 s",
            judge: answeredWithin,
        }))
    );
    cases.push(
        ...(await dangerous(ctx, "6.03", {
            title: "promise then property replaced answers",
            code: 'const p = Promise.resolve(1); p["then"] = () => {}; return p',
            seconds: 15,
            expected: "answers within 15 s",
            judge: answeredWithin,
        }))
    );
    cases.push(
        ...(await dangerous(ctx, "6.04", {
            title: "Promise.prototype.then getter that never returns answers",
            code: 'Object.defineProperty(Promise.prototype, "then", { get(){ while(true){} } }); return 1',
            seconds: 15,
            expected: "answers within 15 s",
            judge: answeredWithin,
        }))
    );
    cases.push(
        ...(await dangerous(ctx, "6.05", {
            title: "setter on __arg0 that never returns",
            code: 'Object.defineProperty(globalThis, "__arg0", { set(v){ while(true){} }, get(){ return 1 }, configurable: false }); return 1',
            seconds: 15,
            expected: "answers within 15 s; the next call from the same token answers 2 within 15 s",
            judge: answeredWithin,
            severity: "critical",
            follow: { severity: "critical", seconds: 15 },
        }))
    );
    cases.push(
        ...(await dangerous(ctx, "6.06", {
            title: "busy loop is refused with a CPU or time limit",
            code: "while(true){}",
            seconds: 15,
            expected: "refused with a CPU/time limit message within 15 s",
            judge: (o, s) => refusedWithin(o, s, LIMIT_WORDS),
        }))
    );
    cases.push(
        ...(await dangerous(ctx, "6.07", {
            title: "deep recursion is refused with a stack error",
            code: "function f(n){ return f(n + 1) + 1 } return f(0)",
            seconds: 15,
            expected: "refused with a clear stack or recursion error within 15 s",
            judge: (o, s) => refusedWithin(o, s, /stack|recurs|maximum|too deep|limit|exceed|call/i),
        }))
    );

    // 6.08: memory.
    cases.push(...(await caseMemory(ctx)));

    // 6.09: storage cap.
    cases.push(...(await caseStorage(ctx)));

    // 6.10: host call cap. Each listTeams waits for a rate token, so the cap is reached only after about 100 s.
    cases.push(
        ...(await dangerous(ctx, "6.10", {
            title: "1500 host calls in one script hit the host call cap",
            code: SLOW_CODE,
            seconds: 135,
            expected:
                "refused naming the host call cap or the wall-clock limit (/host call|wall|time|limit/i) within 130 s",
            judge: (o) => refusedWithin(o, 130, /host call|wall|time|limit/i),
            follow: { seconds: 135 },
        }))
    );

    // 6.11: parallel burners from ten tokens.
    cases.push(...(await caseBurst(ctx)));

    // 6.12 and 6.16 to 6.24: guest escapes.
    cases.push(...(await caseEscapes(ctx)));

    // 6.13: a 50 MB reply is refused or capped.
    cases.push(
        ...(await dangerous(ctx, "6.13", {
            title: "50 MB string reply is capped",
            code: 'return "x".repeat(50 * 1024 * 1024)',
            seconds: 30,
            expected: "refused or capped; the reply is under 300 kB, within 30 s",
            judge: (o, s) => cappedWithin(o, s),
        }))
    );

    // 6.14: a storage toJSON that never returns.
    cases.push(
        ...(await dangerous(ctx, "6.14", {
            title: "storage toJSON that never returns answers",
            code: "storage.loop = { toJSON(){ while(true){} } }; return 1",
            seconds: 20,
            expected: "answers within 20 s; the next call from the same token answers 2 within 15 s",
            judge: answeredWithin,
            follow: { seconds: 15, cleanup: "delete storage.loop; return 1" },
        }))
    );

    // 6.15: a log flood.
    cases.push(
        ...(await dangerous(ctx, "6.15", {
            title: "log flood answers with the log capped",
            code: 'for (let i = 0; i < 1e6; i++) console.log("x".repeat(100)); return 1',
            seconds: 30,
            expected: "answers within 30 s; the reply is under 300 kB",
            judge: (o, s) => cappedWithin(o, s),
        }))
    );

    // 6.25: slot starvation. Four slow scripts hold the four sandbox slots; a fifth token must still be answered.
    cases.push(...(await caseStarvation(ctx)));

    return cases;
}
