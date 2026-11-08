// Group 7: replay of writes, rate limits per token, the turn queue of execute_code, and export permits.
import {
    connect,
    freshPage,
    guard,
    makeCase,
    notTestable,
    redact,
    refused,
    sleep,
    textOf,
    tool,
    uuid,
} from "./lib.mjs";

/** Group name, used in the report and the runner. */
export const name = "7-replay-limits";

/** Case ids from ADV_ONLY (comma list); empty means every case. A "b" follow-up follows its base id. */
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

/** Words of a rate-limit refusal. */
const RATE_RE = /rate limit|retry after|429|too many/i;

/** Words of a clear busy, queue or limit refusal of an export or a script. */
const BUSY_RE = /busy|queue|running|wait|limit|retry/i;

/** Words of a clear refusal of a replayed write that is in flight. */
const RACE_RE = /busy|conflict|already|retry|queue|wait/i;

/** Longest time a render may wait before the case fails, in milliseconds (contract 4.5: a render waits 60 s). */
const RENDER_FAIL_MS = 70000;

/**
 * Builds the metadata of one case.
 *
 * @param {string} id - case id, for example 7.01
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
 * Makes a rectangle create operation for the root of a page.
 *
 * @param {string} pageId - page
 * @param {string} shapeName - name of the rectangle
 * @param {string} [handle] - the $tmp handle of the rectangle
 * @returns {object} the operation
 */
function rectOp(pageId, shapeName, handle = "$tmp:r") {
    return { op: "create_rect", pageId, id: handle, name: shapeName, x: 10, y: 10, width: 20, height: 20 };
}

/**
 * Runs apply_operations on a page of the file, with snapshots off.
 *
 * @param {object} client - connected MCP client
 * @param {string} fileId - file
 * @param {string} pageId - page
 * @param {string | undefined} requestId - the requestId of the write, or undefined
 * @param {object[]} operations - the operations
 * @param {number} [timeoutMs] - client timeout, default 60000 ms
 * @returns {Promise<object>} the outcome
 */
function applyOps(client, fileId, pageId, requestId, operations, timeoutMs = 60000) {
    const args = { fileId, pageId, snapshot: false, operations };
    if (requestId) {
        args.requestId = requestId;
    }
    return tool(client, "apply_operations", args, { timeoutMs, noRetry: true });
}

/**
 * Calls whoami once, without the retry on rate-limit text.
 *
 * @param {object} client - connected MCP client
 * @param {number} [timeoutMs] - client timeout, default 30000 ms
 * @returns {Promise<object>} the outcome
 */
function whoami(client, timeoutMs = 30000) {
    return tool(client, "whoami", {}, { timeoutMs, noRetry: true });
}

/**
 * Counts the shapes of a page whose name matches a regex.
 *
 * @param {object} client - connected MCP client
 * @param {string} fileId - file
 * @param {string} pageId - page
 * @param {string} regex - the name regex
 * @returns {Promise<{ n: number, o: object }>} the number of matches (-1 when the search failed), and the outcome
 */
async function countNamed(client, fileId, pageId, regex) {
    const o = await tool(client, "find_shapes", { fileId, pageId, nameRegex: regex }, { timeoutMs: 60000 });
    if (!o.ok || o.isError) {
        return { n: -1, o };
    }
    return { n: Array.isArray(o.json?.matches) ? o.json.matches.length : -1, o };
}

/**
 * Makes one outcome from several, for a case that checks several calls.
 *
 * @param {object[]} outs - outcomes
 * @param {string} text - the text to show
 * @returns {object} an outcome with the text, the error flag and the longest duration
 */
function combined(outs, text) {
    return {
        isError: outs.some((o) => o.isError),
        text,
        durationMs: Math.max(0, ...outs.map((o) => o.durationMs ?? 0)),
    };
}

/**
 * Sets the note of a case, which shows on pass as well as on fail.
 *
 * @param {object} c - the case
 * @param {string} text - the note
 * @param {object} cfg - config, for redaction
 * @returns {object} the same case
 */
function noted(c, text, cfg) {
    c.note = [c.note, redact(text, cfg)].filter(Boolean).join("; ");
    return c;
}

/**
 * Median of a list of numbers.
 *
 * @param {number[]} xs - values
 * @returns {number} the median, or 0 for an empty list
 */
function median(xs) {
    if (xs.length === 0) {
        return 0;
    }
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Creates the rectangle that the export cases export, on a fresh page.
 *
 * @param {object} ctx - suite context
 * @param {string} label - page name
 * @returns {Promise<{ page: string, shapeId: string }>} the page and the rectangle
 * @throws {Error} when the rectangle is not created
 */
async function exportRect(ctx, label) {
    const page = await freshPage(ctx.control, ctx.cfg, label);
    const o = await applyOps(ctx.control, ctx.cfg.vars.fileId, page, undefined, [
        { op: "create_rect", pageId: page, id: "$tmp:r", name: label, x: 10, y: 10, width: 40, height: 40 },
    ]);
    const shapeId = o.json?.createdIds?.["$tmp:r"];
    if (!shapeId) {
        throw new Error(`exportRect: no shape id (${textOf(o).slice(0, 200)})`);
    }
    return { page, shapeId };
}

/**
 * Classifies one export reply by what it says.
 *
 * @param {object} o - outcome
 * @returns {"image" | "refused" | "other"} an image with no text, a clear busy or limit refusal, or anything else
 */
function exportKind(o) {
    if (o.timedOut) {
        return "other";
    }
    if (o.ok && !o.isError && textOf(o).trim() === "") {
        return "image";
    }
    if (refused(o) && BUSY_RE.test(textOf(o))) {
        return "refused";
    }
    return "other";
}

/**
 * Summarises the export calls of a case: counts, latency and whether a call waited past the render limit.
 *
 * @param {object[]} outs - outcomes
 * @returns {{ text: string, late: number, kinds: string[] }} the summary, the calls past the limit, and the kinds
 */
function exportSummary(outs) {
    const kinds = outs.map(exportKind);
    const lat = outs.map((o) => o.durationMs ?? 0);
    const late = outs.filter((o) => o.timedOut || (o.durationMs ?? 0) > RENDER_FAIL_MS).length;
    const count = (k) => kinds.filter((x) => x === k).length;
    const text =
        `images=${count("image")} clearRefusals=${count("refused")} other=${count("other")} of ${outs.length}; ` +
        `latency min=${Math.min(...lat)} median=${median(lat)} max=${Math.max(...lat)} ms; past ${RENDER_FAIL_MS} ms=${late}`;
    return { text, late, kinds };
}

/**
 * Runs the group.
 *
 * @param {{ cfg: object, control: object, log: (msg: string) => void }} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
export async function run(ctx) {
    const { cfg, control } = ctx;
    const fileId = cfg.vars.fileId;
    const ts = Date.now();
    const cases = [];

    // 7.01: the same requestId and the same payload is answered alreadyApplied, and the shape is made once.
    if (want("7.01")) {
        const nm = `adv-replay-${ts}`;
        const m = meta(
            "7.01",
            "same requestId and payload is answered alreadyApplied",
            `apply_operations create_rect "${nm}" twice with one requestId; find_shapes ^${nm}$`,
            "second reply alreadyApplied true; exactly 1 shape named " + nm,
            "high"
        );
        cases.push(
            ...(await guard(m, async () => {
                const page = await freshPage(control, cfg, `adv-replay-${ts}`);
                const r = uuid();
                const ops = [rectOp(page, nm)];
                const first = await applyOps(control, fileId, page, r, ops);
                const second = await applyOps(control, fileId, page, r, ops);
                const cnt = await countNamed(control, fileId, page, `^${nm}$`);
                const out = combined(
                    [first, second],
                    `first: ${textOf(first).slice(0, 200)}\nsecond: ${textOf(second).slice(0, 300)}\nfind_shapes count=${cnt.n}`
                );
                let verdict = true;
                if (!first.ok || first.isError) {
                    verdict = `first write failed: ${textOf(first).slice(0, 120)}`;
                } else if (second.json?.alreadyApplied !== true) {
                    verdict = "second reply has no alreadyApplied true";
                } else if (cnt.n !== 1) {
                    verdict = `find_shapes found ${cnt.n} shapes, expected 1`;
                }
                return makeCase(m, out, verdict);
            }))
        );
    }

    // 7.02: the same requestId with another payload is a new write (contract 4.3).
    if (want("7.02")) {
        const n2 = `adv-replay2-${ts}`;
        const n3 = `adv-replay3-${ts}`;
        const m = meta(
            "7.02",
            "same requestId with a changed payload is a new write",
            `apply_operations create_rect "${n2}", then the same requestId with "${n3}"; find_shapes each name`,
            "no alreadyApplied on the second; both shapes present, 1 match each",
            "medium"
        );
        cases.push(
            ...(await guard(m, async () => {
                const page = await freshPage(control, cfg, `adv-replay2-${ts}`);
                const r = uuid();
                const a = await applyOps(control, fileId, page, r, [rectOp(page, n2)]);
                const b = await applyOps(control, fileId, page, r, [rectOp(page, n3)]);
                const c2 = await countNamed(control, fileId, page, `^${n2}$`);
                const c3 = await countNamed(control, fileId, page, `^${n3}$`);
                const out = combined(
                    [a, b],
                    `first: ${textOf(a).slice(0, 200)}\nsecond: ${textOf(b).slice(0, 300)}\ncount ${n2}=${c2.n}, count ${n3}=${c3.n}`
                );
                let verdict = true;
                if (!a.ok || a.isError) {
                    verdict = `first write failed: ${textOf(a).slice(0, 120)}`;
                } else if (b.json?.alreadyApplied === true) {
                    verdict = `silent drop: the backend answered alreadyApplied and did not write ${n3}`;
                } else if (c2.n !== 1 || c3.n !== 1) {
                    verdict = `expected 1 match each, got ${c2.n} and ${c3.n}`;
                }
                return makeCase(m, out, verdict);
            }))
        );
    }

    // 7.03: one token: about 200 whoami calls in 2 s. Successes are limited by the bucket (burst 20, 10 per s).
    if (want("7.03")) {
        const m = meta(
            "7.03",
            "one token is rate limited to its bucket",
            "200 whoami from one fresh client of agentTokens[11], in two batches of 100 about 1 s apart",
            "successes <= 45; every refusal says rate limit, retry after, 429 or too many",
            "high"
        );
        cases.push(
            ...(await guard(m, async () => {
                if ((cfg.agentTokens?.length ?? 0) < 13) {
                    return notTestable(m, "needs agentTokens[11] and [12]");
                }
                const c = await connect(cfg, cfg.agentTokens[11]);
                const outs = [];
                for (let batch = 0; batch < 2; batch += 1) {
                    const t0 = Date.now();
                    const part = await Promise.all(Array.from({ length: 100 }, () => whoami(c)));
                    outs.push(...part);
                    const wait = 1000 - (Date.now() - t0);
                    if (batch === 0 && wait > 0) {
                        await sleep(wait);
                    }
                }
                const ok = outs.filter((o) => o.ok && !o.isError).length;
                const limited = outs.filter((o) => refused(o) && !o.timedOut && RATE_RE.test(textOf(o))).length;
                const timedOut = outs.filter((o) => o.timedOut).length;
                const other = outs.length - ok - limited;
                const out = combined(
                    outs,
                    `successes=${ok} rateLimited=${limited} other=${other} timedOut=${timedOut} of ${outs.length}\n` +
                        outs
                            .filter((o) => !(o.ok && !o.isError) && !(refused(o) && RATE_RE.test(textOf(o))))
                            .slice(0, 2)
                            .map((o) => textOf(o).slice(0, 150))
                            .join("\n")
                );
                let verdict = true;
                if (ok > 45) {
                    verdict = `successes=${ok}, expected at most 45`;
                } else if (other > 0) {
                    verdict = `${other} call(s) neither succeeded nor said rate limit`;
                }
                return makeCase(m, out, verdict);
            }))
        );
    }

    // 7.04: right after 7.03, another token is not affected.
    if (want("7.04")) {
        const m = meta(
            "7.04",
            "another token is not affected by the flood",
            "whoami once from a fresh client of agentTokens[12], right after 7.03",
            "ok",
            "high"
        );
        cases.push(
            ...(await guard(m, async () => {
                if ((cfg.agentTokens?.length ?? 0) < 13) {
                    return notTestable(m, "needs agentTokens[12]");
                }
                const c = await connect(cfg, cfg.agentTokens[12]);
                const o = await whoami(c);
                return makeCase(m, o, o.ok && !o.isError ? true : `whoami refused: ${textOf(o).slice(0, 120)}`);
            }))
        );
    }

    // 7.05: 20 tokens, 30 whoami each, all at once. Each token is limited on its own. Per token: counts by category
    // and the first non-success text; connect failures are counted apart.
    if (want("7.05")) {
        const m = meta(
            "7.05",
            "20 tokens at once are each limited on their own",
            "agentTokens[0..19], 30 whoami each in 2 s, all 600 calls at once; noRetry",
            "every token has 15 to 50 successes; none starved",
            "medium"
        );
        cases.push(
            ...(await guard(m, async () => {
                if ((cfg.agentTokens?.length ?? 0) < 20) {
                    return notTestable(m, "needs 20 agent tokens");
                }
                const conn = await Promise.allSettled(
                    Array.from({ length: 20 }, (_, i) => connect(cfg, cfg.agentTokens[i]))
                );
                const perToken = await Promise.all(
                    conn.map((r) =>
                        r.status === "fulfilled"
                            ? Promise.all(Array.from({ length: 30 }, () => whoami(r.value, 30000)))
                            : null
                    )
                );
                const lines = [];
                const counts = [];
                const all = [];
                perToken.forEach((outs, i) => {
                    if (outs === null) {
                        counts.push(0);
                        const reason =
                            conn[i].reason instanceof Error ? conn[i].reason.message : String(conn[i].reason);
                        lines.push(`#${i} connectFailed: ${reason.slice(0, 150)}`);
                        return;
                    }
                    all.push(...outs);
                    const ok = outs.filter((o) => o.ok && !o.isError).length;
                    const rl = outs.filter((o) => refused(o) && !o.timedOut && RATE_RE.test(textOf(o))).length;
                    const to = outs.filter((o) => o.timedOut).length;
                    const other = outs.length - ok - rl - to;
                    counts.push(ok);
                    let line = `#${i} ok=${ok} rateLimited=${rl} timedOut=${to} other=${other}`;
                    const firstBad = outs.find(
                        (o) => !(o.ok && !o.isError) && !(refused(o) && RATE_RE.test(textOf(o)))
                    );
                    if (firstBad) {
                        line += ` first: ${textOf(firstBad).slice(0, 150)}`;
                    }
                    lines.push(line);
                });
                const starved = counts.findIndex((n) => n < 15 || n > 50);
                const out = combined(all, lines.join("\n"));
                const verdict =
                    starved === -1 ? true : `token ${starved} had ${counts[starved]} successes, expected 15 to 50`;
                return noted(makeCase(m, out, verdict), lines.join("\n"), cfg);
            }))
        );
    }

    // 7.06: turn queue: 30 execute_code at once from one token.
    if (want("7.06")) {
        const m = meta(
            "7.06",
            "30 concurrent execute_code from one token are queued or refused",
            "30 execute_code from agentTokens[13] on agentFileIds[13], each busy-waits 1.5 s",
            "all answer within 90 s; at most 10 succeed; every refusal says busy, queue, running, rate limit, retry or wait",
            "high"
        );
        cases.push(
            ...(await guard(m, async () => {
                if ((cfg.agentTokens?.length ?? 0) < 14 || (cfg.vars.agentFileIds?.length ?? 0) < 14) {
                    return notTestable(m, "needs agentTokens[13] and agentFileIds[13]");
                }
                const c = await connect(cfg, cfg.agentTokens[13]);
                const code = "const t = Date.now(); while (Date.now() - t < 1500) {} return 1";
                const outs = await Promise.all(
                    Array.from({ length: 30 }, () =>
                        tool(
                            c,
                            "execute_code",
                            { fileId: cfg.vars.agentFileIds[13], code },
                            { timeoutMs: 90000, noRetry: true }
                        )
                    )
                );
                const ok = outs.filter((o) => o.ok && !o.isError).length;
                const refusedClear = outs.filter((o) => refused(o) && !o.timedOut && BUSY_RE.test(textOf(o))).length;
                const hung = outs.filter((o) => o.timedOut).length;
                const unclear = outs.length - ok - refusedClear - hung;
                const out = combined(
                    outs,
                    `successes=${ok} clearRefusals=${refusedClear} unclear=${unclear} timedOut=${hung} of 30`
                );
                let verdict = true;
                if (hung > 0) {
                    verdict = `${hung} call(s) did not answer within 90 s`;
                } else if (ok > 10) {
                    verdict = `${ok} successes, expected at most 10`;
                } else if (unclear > 0) {
                    verdict = `${unclear} refusal(s) without a clear busy or queue message`;
                }
                return makeCase(m, out, verdict);
            }))
        );
    }

    // 7.07: one token, 20 exports at once. A call still waiting at 70 s fails (contract 4.5: a render waits 60 s).
    let exportTarget;
    if (want("7.07")) {
        const m = meta(
            "7.07",
            "20 concurrent exports from one token are answered or refused clearly",
            "one 40x40 rect on a fresh page; 20 export_shape png at once from the control token; timeout 150 s, noRetry",
            "each call is an image or a clear busy, queue, wait, limit or retry refusal; none still waiting at 70 s",
            "medium"
        );
        cases.push(
            ...(await guard(m, async () => {
                exportTarget = await exportRect(ctx, `adv-exp-${ts}`);
                const args = { fileId, pageId: exportTarget.page, shapeId: exportTarget.shapeId, format: "png" };
                const outs = await Promise.all(
                    Array.from({ length: 20 }, () =>
                        tool(control, "export_shape", args, { timeoutMs: 150000, noRetry: true })
                    )
                );
                const s = exportSummary(outs);
                const out = combined(outs, s.text);
                const other = s.kinds.filter((k) => k === "other").length;
                const verdict =
                    s.late === 0 && other === 0 ? true : `${s.late} call(s) past ${RENDER_FAIL_MS} ms, ${other} other`;
                return noted(makeCase(m, out, verdict), s.text, cfg);
            }))
        );
    }

    // 7.08: the same export from 20 different tokens at once. The adapter logged "Max parallel exports
    // (multi-user mode): 0 (0 = unbounded)", so the process-wide permit (contract 4.5) is off in this stack.
    if (want("7.08")) {
        const m = meta(
            "7.08",
            "the same export from 20 tokens at once: every call answers, and the exporter stays healthy",
            "export_shape png of the 7.07 rectangle from agentTokens[0..19]; timeout 150 s, noRetry; the adapter logged 'Max parallel exports (multi-user mode): 0 (0 = unbounded)', so the process-wide permit is off here",
            "each call is an image or a clear refusal, none still waiting at 70 s; a follow-up single export works (7.08b)",
            "medium"
        );
        cases.push(
            ...(await guard(m, async () => {
                if (!exportTarget) {
                    return notTestable(m, "7.07 did not create the rectangle");
                }
                if ((cfg.agentTokens?.length ?? 0) < 20) {
                    return notTestable(m, "needs 20 agent tokens");
                }
                const args = { fileId, pageId: exportTarget.page, shapeId: exportTarget.shapeId, format: "png" };
                const clients = await Promise.all(
                    Array.from({ length: 20 }, (_, i) => connect(cfg, cfg.agentTokens[i]))
                );
                const outs = await Promise.all(
                    clients.map((c) => tool(c, "export_shape", args, { timeoutMs: 150000, noRetry: true }))
                );
                const s = exportSummary(outs);
                const out = combined(outs, s.text);
                const other = s.kinds.filter((k) => k === "other").length;
                const verdict =
                    s.late === 0 && other === 0 ? true : `${s.late} call(s) past ${RENDER_FAIL_MS} ms, ${other} other`;
                return noted(makeCase(m, out, verdict), s.text, cfg);
            }))
        );
    }

    // 7.08b: the exporter stays healthy after the burst.
    if (want("7.08")) {
        const m = meta(
            "7.08b",
            "a single export works after the 20-token burst",
            "export_shape png of the 7.07 rectangle from the control token",
            "an image, no text, within 120 s",
            "medium"
        );
        cases.push(
            ...(await guard(m, async () => {
                if (!exportTarget) {
                    return notTestable(m, "7.07 did not create the rectangle");
                }
                const o = await tool(
                    control,
                    "export_shape",
                    { fileId, pageId: exportTarget.page, shapeId: exportTarget.shapeId, format: "png" },
                    { timeoutMs: 120000, noRetry: true }
                );
                return makeCase(
                    m,
                    o,
                    exportKind(o) === "image" ? true : `export did not return an image: ${textOf(o).slice(0, 120)}`
                );
            }))
        );
    }

    // 7.09: the same write five times at once. One shape only.
    if (want("7.09")) {
        const nm = `adv-race-${ts}`;
        const m = meta(
            "7.09",
            "one write with one requestId sent 5 times at once makes one shape",
            `apply_operations create_rect "${nm}" with one requestId, 5 concurrent calls; find_shapes ^${nm}$`,
            "exactly 1 shape named " + nm + "; each other reply is alreadyApplied or a clear busy or conflict",
            "high"
        );
        cases.push(
            ...(await guard(m, async () => {
                const page = await freshPage(control, cfg, `adv-race-${ts}`);
                const r = uuid();
                const ops = [rectOp(page, nm)];
                const outs = await Promise.all(
                    Array.from({ length: 5 }, () => applyOps(control, fileId, page, r, ops))
                );
                const cnt = await countNamed(control, fileId, page, `^${nm}$`);
                const kinds = outs.map((o) => {
                    if (o.ok && !o.isError) {
                        return o.json?.alreadyApplied === true ? "already" : "applied";
                    }
                    if (!o.timedOut && refused(o) && RACE_RE.test(textOf(o))) {
                        return "refused";
                    }
                    return "bad";
                });
                const out = combined(
                    outs,
                    `kinds=${kinds.join(",")} find_shapes count=${cnt.n}\n` +
                        textOf(outs.find((o) => o.isError) ?? outs[0]).slice(0, 200)
                );
                let verdict = true;
                if (cnt.n !== 1) {
                    verdict = `find_shapes found ${cnt.n} shapes, expected 1`;
                } else if (kinds.includes("bad")) {
                    verdict = "a reply was neither alreadyApplied nor a clear busy or conflict";
                }
                return makeCase(m, out, verdict);
            }))
        );
    }

    return cases;
}
