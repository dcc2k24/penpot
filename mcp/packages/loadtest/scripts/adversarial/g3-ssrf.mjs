// Group 3: server-side request forgery. Every internal or non-HTTP target must be refused with a clear reason, and
// no reply may carry the content of the target.
import { tool, textOf, refused, makeCase, notTestable, guard, sleep, rpc } from "./lib.mjs";

/** Pause before each call, so that the adapter rate limit (burst 20, 10 per second) is never exhausted. */
const PACE_MS = 700;

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
export const name = "3-ssrf";

/** Words of a refusal that names the reason. */
const REFUSAL =
    /private|loopback|link-local|refus|not allowed|forbidden|scheme|http:\/\/ or https:\/\/|invalid|blocked|redirect|ssrf|not accepted|exactly one of/i;

/** Text that only the content of an internal target would hold. */
const CONTENT = /\bready\b|root:|\[fonts\]|redis_version|ami-id/i;

/** Text that shows the fetch reached the target and tried to read it as an image. */
const REACHED =
    /not an image|unsupported media|content[- ]type|invalid media|not a valid image|unsupported image|unsupported format/i;

/** Text of a failure on the network, not in the policy. */
const NETWORK = /ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timed? ?out/i;

/** Internal, local, and non-HTTP targets. Each one is tried with import_image and with import_archive. */
const TARGETS = [
    "http://127.0.0.1:6060/readyz",
    "http://localhost:6061/readyz",
    "http://[::1]:4405/healthz",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://0.0.0.0:6060/",
    "http://127.0.0.1.nip.io:6060/",
    "http://2130706433:6060/",
    "http://0177.0.0.1:6060/",
    "http://0x7f.0.0.1:6060/",
    "http://127.1:6060/",
    "http://[::ffff:127.0.0.1]:6060/",
    "http://[::ffff:7f00:1]:6060/",
    "http://[::127.0.0.1]:6060/",
    "http://[fd00:ec2::254]/",
    "http://localhost./",
    "http://penpot-postgres:5432/",
    "http://penpot-valkey:6379/",
    "http://host.docker.internal:4405/healthz",
    "file:///etc/passwd",
    "file:///C:/Windows/win.ini",
    "gopher://127.0.0.1:6379/_INFO",
    "ftp://127.0.0.1/",
    "dict://127.0.0.1:6379/info",
    "http://user:pass@127.0.0.1:6060/",
];

/** Public redirectors that send the fetch on to a target. The last one is a chain of twelve redirects. */
const REDIRECTS = [
    { inner: "http://127.0.0.1:6060/readyz", chain: false },
    { inner: "http://169.254.169.254/latest/meta-data/", chain: false },
    { inner: "file:///etc/passwd", chain: false },
    { inner: null, chain: true },
];

/** Name of the DNS rebinding host: it answers 127.0.0.1 and 8.8.8.8 in turn. */
const REBIND_URL = "http://7f000001.08080808.rbndr.us:6060/readyz";

/**
 * Judges the outcome of a request for an internal target.
 *
 * @param {object} o - the outcome of the tool call
 * @param {string} target - the URL that was requested
 * @returns {{verdict: true|string, severity: string}} true when refused with a clear reason and no content
 */
function judgeTarget(o, target) {
    const text = textOf(o);
    if (o.timedOut) {
        return { verdict: "not refused up front: no answer within 30 s", severity: "medium" };
    }
    if (o.ok) {
        return { verdict: "accepted: the request succeeded", severity: "critical" };
    }
    if (REACHED.test(text)) {
        return { verdict: "the fetch reached the target (not an image)", severity: "critical" };
    }
    if (CONTENT.test(text)) {
        return { verdict: "the reply holds content of the target", severity: "critical" };
    }
    if (target.includes("user:pass") && /user:pass|pass@/.test(text)) {
        return { verdict: "the reply echoes the credentials of the URL", severity: "medium" };
    }
    if (!REFUSAL.test(text)) {
        return { verdict: "refusal text does not name the reason", severity: "medium" };
    }
    return { verdict: true, severity: "critical" };
}

/**
 * Runs one target case.
 *
 * @param {object} control - the connected client with the full token
 * @param {object} meta - the case metadata
 * @param {string} target - the URL under test
 * @param {string} toolName - import_image or import_archive
 * @param {object} args - the tool arguments
 * @returns {Promise<object>} the case
 */
async function targetCase(ctx, meta, target, toolName, args) {
    if (target.includes("0177.0.0.1") && toolName === "import_image") {
        return octalCase(ctx, meta, target);
    }
    await sleep(PACE_MS);
    const o = await callPaced(ctx.control, toolName, args, { timeoutMs: 30000 });
    const j = judgeTarget(o, target);
    return makeCase({ ...meta, severity: j.severity }, o, j.verdict);
}

/**
 * Runs the octal-host case with a long timeout, then asks the backend directly whether it reaches the target.
 *
 * @param {object} ctx - the group context
 * @param {object} meta - the case metadata
 * @param {string} target - the octal URL
 * @returns {Promise<object>} the case
 */
async function octalCase(ctx, meta, target) {
    const { cfg, control } = ctx;
    await sleep(PACE_MS);
    const o = await callPaced(
        control,
        "import_image",
        { fileId: cfg.vars.fileId, url: target, createShape: false },
        { timeoutMs: 90000 }
    );
    await sleep(PACE_MS);
    const probe = await rpc(
        cfg,
        "create-file-media-object-from-url",
        { fileId: cfg.vars.fileId, isLocal: true, url: target, name: "adv" },
        { token: cfg.fullToken, timeoutMs: 90000 }
    );
    const probeText = `backend probe HTTP ${probe.status}: ${String(probe.text ?? probe.error ?? "").slice(0, 200)}`;
    const text = textOf(o);
    let verdict;
    let severity;
    if (probe.ok || CONTENT.test(String(probe.text ?? ""))) {
        verdict = "backend probe reached loopback or returned target content";
        severity = "critical";
    } else if (CONTENT.test(text)) {
        verdict = "the reply holds content of the target";
        severity = "critical";
    } else if (o.timedOut || /request timeout|timed out/i.test(text)) {
        verdict = "not refused up front; the backend does not reach loopback (WHATWG reads 127.0.0.1, Java does not)";
        severity = "low";
    } else {
        const j = judgeTarget(o, target);
        verdict = j.verdict;
        severity = j.severity;
    }
    const c = makeCase({ ...meta, severity }, o, verdict);
    c.note = `${c.note ? c.note + "; " : ""}${probeText}`;
    return c;
}

/**
 * Classifies one attempt at the DNS rebinding host.
 *
 * @param {object} o - the outcome of the tool call
 * @returns {string} "fetched content", "refused private", "network error/timeout" or "other"
 */
function classifyAttempt(o) {
    const text = textOf(o);
    if (o.ok || REACHED.test(text) || CONTENT.test(text)) {
        return "fetched content";
    }
    if (o.timedOut) {
        return "network error/timeout";
    }
    if (REFUSAL.test(text)) {
        return "refused private";
    }
    if (NETWORK.test(text)) {
        return "network error/timeout";
    }
    return "other";
}

/**
 * Runs the DNS rebinding probe: six sequential imports of the rebinding host.
 *
 * @param {object} ctx - the group context
 * @param {object} meta - the case metadata
 * @returns {Promise<object>} the case
 */
async function rebindingCase(ctx, meta) {
    const { cfg, control } = ctx;
    const kinds = [];
    let reached = null;
    for (let i = 0; i < 6; i++) {
        await sleep(PACE_MS);
        const o = await callPaced(
            control,
            "import_image",
            { fileId: cfg.vars.fileId, url: REBIND_URL, createShape: false },
            { timeoutMs: 20000 }
        );
        const kind = classifyAttempt(o);
        kinds.push(kind);
        if (kind === "fetched content" && reached === null) {
            reached = o;
        }
    }
    if (kinds.every((k) => k === "other")) {
        return notTestable(meta, "no attempt got an answer that could be classified");
    }
    const summary = kinds.map((k, i) => `${i + 1}:${k}`).join(", ");
    const verdict = reached === null ? true : `DNS rebinding reached content (${summary})`;
    const c = makeCase(
        { ...meta, severity: "critical" },
        reached ?? { ok: false, isError: true, text: summary },
        verdict
    );
    c.note = `${c.note ? c.note + "; " : ""}attempts: ${summary}. DNS rebinding can only be probed, not proven absent.`;
    return c;
}

/**
 * Runs the control case: a public image must import.
 *
 * @param {object} ctx - the group context
 * @param {object} meta - the case metadata
 * @returns {Promise<object>} the case, or a not-testable case when the public host is unreachable
 */
async function controlCase(ctx, meta) {
    const { cfg, control } = ctx;
    await sleep(PACE_MS);
    const o = await callPaced(
        control,
        "import_image",
        { fileId: cfg.vars.fileId, url: "https://httpbin.org/image/png", createShape: false },
        { timeoutMs: 30000 }
    );
    const text = textOf(o);
    if (!o.ok && (o.timedOut || NETWORK.test(text))) {
        return notTestable(meta, `public host unreachable: ${text.slice(0, 120)}`);
    }
    return makeCase(meta, o, o.ok ? true : `public image import failed: ${text.slice(0, 200)}`);
}

/**
 * Runs one redirect case. The chain case passes on a refusal for too many redirects or a not-an-image error.
 *
 * @param {object} ctx - the group context
 * @param {object} meta - the case metadata
 * @param {string} url - the redirector URL
 * @param {boolean} chain - true for the redirect chain
 * @returns {Promise<object>} the case
 */
async function redirectCase(ctx, meta, url, chain) {
    await sleep(PACE_MS);
    const o = await callPaced(
        ctx.control,
        "import_image",
        { fileId: ctx.cfg.vars.fileId, url, createShape: false },
        { timeoutMs: 30000 }
    );
    const text = textOf(o);
    if (chain) {
        if (o.timedOut) {
            return makeCase({ ...meta, severity: "medium" }, o, "hang: no answer within 30 s");
        }
        const pass = !o.ok && /redirect|too many|not an image|unsupported|invalid/i.test(text);
        return makeCase(
            { ...meta, severity: "medium" },
            o,
            pass ? true : "redirect chain was not refused with a clear reason"
        );
    }
    if (!o.timedOut && !o.ok && NETWORK.test(text) && !REFUSAL.test(text)) {
        return notTestable(meta, `public redirector unreachable: ${text.slice(0, 120)}`);
    }
    const j = judgeTarget(o, meta.allowText[1] ?? url);
    return makeCase({ ...meta, severity: j.severity }, o, j.verdict);
}

/**
 * Runs group 3.
 *
 * @param {{cfg: object, control: object, log: Function}} ctx - the group context
 * @returns {Promise<object[]>} the cases of the group
 */
export async function run(ctx) {
    const { cfg, control } = ctx;
    const cases = [];
    let n = 0;
    const nextId = () => `3.${String(++n).padStart(2, "0")}`;

    for (const target of TARGETS) {
        const variants = [
            ["import_image", { fileId: cfg.vars.fileId, url: target, createShape: false }],
            ["import_archive", { projectId: cfg.vars.projectId, url: target }],
        ];
        for (const [toolName, args] of variants) {
            const meta = {
                group: name,
                id: nextId(),
                title: `${toolName} refuses ${target}`,
                request: `${toolName} url=${target}`,
                expected: "refused with a clear reason; no content of the target",
                severity: "critical",
                allowText: [target],
            };
            cases.push(...(await guard(meta, () => targetCase(ctx, meta, target, toolName, args))));
        }
    }

    // let the rate limiter refill after the slow octal-host case
    await sleep(5000);
    for (const r of REDIRECTS) {
        const inner = r.inner ?? "";
        const url = r.chain
            ? "http://httpbin.org/redirect/12"
            : `http://httpbin.org/redirect-to?url=${encodeURIComponent(inner)}`;
        const meta = {
            group: name,
            id: nextId(),
            title: r.chain ? "redirect chain of 12 is refused or fails cleanly" : `redirect to ${inner} is refused`,
            request: `import_image url=${url}`,
            expected: "refused on the redirect hop or a clear error; no content of the target",
            severity: "critical",
            allowText: [url, inner],
        };
        cases.push(...(await guard(meta, () => redirectCase(ctx, meta, url, r.chain))));
    }

    const rebindMeta = {
        group: name,
        id: nextId(),
        title: "DNS rebinding host never yields content (6 attempts)",
        request: `import_image url=${REBIND_URL} x6, 20 s each`,
        expected: "every attempt refused or unreachable; none fetches content",
        severity: "critical",
        allowText: [REBIND_URL],
    };
    cases.push(...(await guard(rebindMeta, () => rebindingCase(ctx, rebindMeta))));

    const controlMeta = {
        group: name,
        id: nextId(),
        title: "control: public image URL imports",
        request: "import_image url=https://httpbin.org/image/png createShape=false",
        expected: "success",
        severity: "medium",
        allowText: [],
    };
    cases.push(...(await guard(controlMeta, () => controlCase(ctx, controlMeta))));

    return cases;
}
