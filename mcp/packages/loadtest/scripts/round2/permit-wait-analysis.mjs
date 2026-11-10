#!/usr/bin/env node
// Rebuilds each export_shape call of a run from the adapter logs and the Redis MONITOR log, and reports how long
// it waited at the per-process gate and at the shared permit, who overtook whom, and same-token overlaps.
// Usage: node permit-wait-analysis.mjs --dir <result folder> --from <ISO> --to <ISO>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
    options: {
        dir: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
    },
    strict: true,
});

function fail(msg) {
    console.error(`ABORT: ${msg}`);
    process.exit(1);
}

if (!values.dir || !values.from || !values.to) {
    fail("usage: node permit-wait-analysis.mjs --dir <folder> --from <ISO> --to <ISO>");
}

const dir = values.dir;
const fromMs = Date.parse(values.from);
const toMs = Date.parse(values.to);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) fail("bad --from or --to");

const ADAPTER_PORTS = ["4406", "4407"];
const KEY = "penpot.mcp.export.permits";
const SLOTS = 4;
const BUDGET_S = 30;
const ANSI = /\x1b\[[0-9;]*m/g;
const HEADER = /^(\w+)\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \((\w+)\): (.*)$/;
const FIELD = /^\s+(\w+):\s*"?([^"]*?)"?\s*$/;
const MON_SRC = "(\\d{10}\\.\\d{6})\\t(lua|\\d{1,3}(?:\\.\\d{1,3}){3}:\\d{1,5})\\t(\\d+)\\t(\\[.*\\])$";

const out = [];
const log = (s = "") => out.push(s);

function parseTs(s) {
    return Date.parse(s.replace(" ", "T") + "Z");
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function secs(ms) {
    return ms === null || ms === undefined || Number.isNaN(ms) ? "n/a" : `${(ms / 1000).toFixed(3)} s`;
}

function pad(v, n) {
    return String(v).padEnd(n);
}

function stats(arr) {
    const v = arr.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
    const n = v.length;
    if (!n) return { n: 0, p50: null, p95: null, max: null };
    const pick = (p) => v[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
    return { n, p50: pick(50), p95: pick(95), max: v[n - 1] };
}

function statLine(label, st, fmt) {
    if (st.n === 0) return `${pad(label, 34)} count 0`;
    return `${pad(label, 34)} count ${st.n}  p50 ${fmt(st.p50)}  p95 ${fmt(st.p95)}  max ${fmt(st.max)}`;
}

// ---------- 1. Adapter logs

function parseAdapter(port) {
    const file = join(dir, "logs", `adapter-${port}.log`);
    if (!existsSync(file)) fail(`missing adapter log ${file}`);
    const lines = readFileSync(file, "utf8").replace(ANSI, "").split(/\r?\n/);
    const starts = new Map();
    const busy = new Map();
    const otherFailed = [];
    const finishes = [];
    let finishBlocks = 0;
    for (let i = 0; i < lines.length; i++) {
        const h = HEADER.exec(lines[i]);
        if (!h) continue;
        const ts = parseTs(h[2]);
        const src = h[3];
        const msg = h[4].trim();
        if (src === "Tool") {
            let m = /^Tool execution #\d+ starting: (\w+) request=([0-9a-f-]+)$/.exec(msg);
            if (m) {
                if (m[1] === "export_shape") starts.set(m[2], ts);
                continue;
            }
            m = /^Tool execution #\d+ failed: (\w+) request=([0-9a-f-]+); error: (.*)$/.exec(msg);
            if (m && m[1] === "export_shape") {
                const b = /no slot was free for ([\d.]+) seconds/.exec(m[3]);
                if (b) busy.set(m[2], { x: Number(b[1]), ts });
                else otherFailed.push(msg);
            }
        } else if (src === "PenpotMcpServer" && msg === "Tool call finished") {
            finishBlocks++;
            const fields = {};
            let j = i + 1;
            while (j < lines.length) {
                const f = FIELD.exec(lines[j]);
                if (!f) break;
                fields[f[1]] = f[2];
                j++;
            }
            i = j - 1;
            if (fields.tool === "export_shape") {
                finishes.push({
                    reqId: fields.requestId,
                    tokenFp: fields.tokenFp,
                    durationMs: Number(fields.durationMs),
                    outcome: fields.outcome,
                    f: ts,
                });
            }
        }
    }

    const finByReq = new Map();
    let dupFinish = 0;
    for (const fi of finishes) {
        if (finByReq.has(fi.reqId)) dupFinish++;
        finByReq.set(fi.reqId, fi);
    }

    const all = [];
    let unfinished = 0;
    let outcomeMismatch = 0;
    for (const [reqId, s] of starts) {
        const fi = finByReq.get(reqId);
        if (!fi) {
            unfinished++;
            continue;
        }
        const b = busy.get(reqId);
        if (b && fi.outcome !== "error") outcomeMismatch++;
        all.push({
            id: reqId,
            adapter: port,
            s,
            f: fi.f,
            tokenFp: fi.tokenFp,
            durationMs: fi.durationMs,
            busyX: b ? b.x : null,
            outcome: b ? "busy" : fi.outcome === "ok" ? "ok" : "error",
        });
    }
    const orphanFinish = finishes.filter((fi) => !starts.has(fi.reqId)).length;
    const busyWithoutFinish = [...busy.keys()].filter((k) => !finByReq.has(k)).length;

    return {
        port,
        file,
        all,
        raw: {
            starts: starts.size,
            finishBlocks,
            exportFinishes: finishes.length,
            busyLines: busy.size,
            otherFailed,
            unfinished,
            orphanFinish,
            dupFinish,
            outcomeMismatch,
            busyWithoutFinish,
        },
    };
}

const adapterData = ADAPTER_PORTS.map(parseAdapter);
const callsAllAdapters = adapterData.flatMap((a) => a.all);
const callsInWindow = callsAllAdapters.filter((c) => c.s >= fromMs && c.s <= toMs).sort((a, b) => a.s - b.s);
const byAdapter = Object.fromEntries(ADAPTER_PORTS.map((p) => [p, []]));
for (const c of callsInWindow) byAdapter[c.adapter].push(c);

// Duration check.
let maxDurDiff = 0;
let maxDurCall = null;
for (const c of callsInWindow) {
    const d = Math.abs(c.durationMs - (c.f - c.s));
    if (d > maxDurDiff) {
        maxDurDiff = d;
        maxDurCall = c;
    }
}

// ---------- 2. Clock offset

let offsetMs = 0;
let offsetNote = "no permit-samples.jsonl; offset 0";
let sampleCount = 0;
let offsetSpread = null;
const SAMPLES = join(dir, "permit-samples.jsonl");
if (existsSync(SAMPLES)) {
    const diffs = [];
    for (const line of readFileSync(SAMPLES, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        const hostMs = Date.parse(o.t);
        if (Number.isFinite(hostMs) && typeof o.redisMs === "number") diffs.push(o.redisMs - hostMs);
    }
    diffs.sort((a, b) => a - b);
    sampleCount = diffs.length;
    if (diffs.length) {
        const m = diffs.length;
        offsetMs = m % 2 ? diffs[(m - 1) / 2] : (diffs[m / 2 - 1] + diffs[m / 2]) / 2;
        offsetSpread = [diffs[0], diffs[m - 1]];
        offsetNote = `median of ${m} samples (redis minus host)`;
    }
}

// ---------- 3. Monitor log

const monRe = new RegExp(MON_SRC, "g");
const monitorPath = join(dir, "permit-monitor.log");
if (!existsSync(monitorPath)) fail(`missing ${monitorPath}`);
const monRecs = [];
let monMalformed = 0;
let monPrefixCorrupt = 0;
for (const raw of readFileSync(monitorPath, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    monRe.lastIndex = 0;
    let last = null;
    let m;
    while ((m = monRe.exec(line)) !== null) last = m;
    if (!last) {
        monMalformed++;
        continue;
    }
    if (last.index !== 0) monPrefixCorrupt++;
    let args;
    try {
        args = JSON.parse(last[4]);
    } catch {
        monMalformed++;
        continue;
    }
    if (!Array.isArray(args) || args.length === 0) {
        monMalformed++;
        continue;
    }
    monRecs.push({
        hostMs: Number(last[1]) * 1000 - offsetMs,
        client: last[2],
        cmd: String(args[0]).toLowerCase(),
        args: args.map(String),
    });
}

const monLo = fromMs - 5000;
const monHi = toMs + 5000;
const monWin = monRecs.filter((e) => e.hostMs >= monLo && e.hostMs <= monHi).sort((a, b) => a.hostMs - b.hostMs);

const polls = monWin.filter((e) => e.cmd === "evalsha" && e.client !== "lua");
const adapterConns = [...new Set(polls.map((e) => e.client))].sort();
if (adapterConns.length !== 2) {
    fail(`expected 2 adapter connections sending evalsha, found ${adapterConns.length}: ${adapterConns.join(", ")}`);
}

const grants = [];
const grantByMember = new Map();
let lastPollConn = null;
let grantDupMember = 0;
for (const e of monWin) {
    if (e.cmd === "evalsha" && e.client !== "lua") {
        lastPollConn = e.client;
        continue;
    }
    if (e.client === "lua" && e.cmd === "zadd" && e.args[1] === KEY && e.args.length >= 4) {
        const g = { hostMs: e.hostMs, member: e.args[3], score: e.args[2], conn: lastPollConn };
        if (grantByMember.has(g.member)) grantDupMember++;
        grants.push(g);
        grantByMember.set(g.member, g);
    }
}

const releases = [];
let releasesOtherConn = 0;
for (const e of monWin) {
    if (e.client !== "lua" && e.cmd === "zrem" && e.args[1] === KEY && e.args.length >= 3) {
        if (adapterConns.includes(e.client)) releases.push({ hostMs: e.hostMs, conn: e.client, member: e.args[2] });
        else releasesOtherConn++;
    }
}

// ---------- 4. Connection to adapter mapping

const nearCount = {};
for (const c of adapterConns) nearCount[c] = Object.fromEntries(ADAPTER_PORTS.map((p) => [p, 0]));
for (const r of releases) {
    for (const p of ADAPTER_PORTS) {
        const hit = byAdapter[p].some((c) => c.outcome === "ok" && c.f - r.hostMs >= 0 && c.f - r.hostMs <= 1500);
        if (hit) nearCount[r.conn][p]++;
    }
}
const connToAdapter = {};
const mappingLines = [];
for (const c of adapterConns) {
    const counts = nearCount[c];
    const sorted = ADAPTER_PORTS.slice().sort((a, b) => counts[b] - counts[a]);
    const top = sorted[0];
    const second = sorted[1];
    const relsOnConn = releases.filter((r) => r.conn === c).length;
    if (counts[top] === 0) fail(`connection ${c}: no near matches in either adapter log`);
    if (counts[top] === counts[second])
        fail(`connection ${c}: tie between adapters (${counts[top]} vs ${counts[second]})`);
    connToAdapter[c] = top;
    mappingLines.push(
        `connection ${c} -> adapter ${top}  (near matches ${counts[top]}/${relsOnConn} releases; ` +
            `adapter ${second} ${counts[second]}/${relsOnConn})`
    );
}
if (connToAdapter[adapterConns[0]] === connToAdapter[adapterConns[1]]) {
    fail("both connections map to the same adapter");
}
const adapterToConn = Object.fromEntries(Object.entries(connToAdapter).map(([c, p]) => [p, c]));

// ---------- 5. Match releases to ok calls

const okByAdapter = Object.fromEntries(ADAPTER_PORTS.map((p) => [p, byAdapter[p].filter((c) => c.outcome === "ok")]));
const matchedOkIds = new Set();
const unmatchedReleases = [];
const grantMismatch = [];
for (const p of ADAPTER_PORTS) {
    const rels = releases.filter((r) => r.conn === adapterToConn[p]).sort((a, b) => a.hostMs - b.hostMs);
    for (const r of rels) {
        let best = null;
        let bestD = Infinity;
        for (const c of okByAdapter[p]) {
            if (matchedOkIds.has(c.id)) continue;
            const d = c.f - r.hostMs;
            if (d >= -50 && d <= 2000 && d < bestD) {
                best = c;
                bestD = d;
            }
        }
        if (!best) {
            unmatchedReleases.push({ adapter: p, member: r.member, at: iso(r.hostMs) });
            continue;
        }
        matchedOkIds.add(best.id);
        best.member = r.member;
        best.r = r.hostMs;
        best.conn = r.conn;
        const g = grantByMember.get(r.member);
        if (!g) {
            grantMismatch.push(`no grant for member ${r.member}`);
        } else {
            if (g.conn !== r.conn) grantMismatch.push(`grant conn ${g.conn} != release conn ${r.conn} for ${r.member}`);
            best.g = g.hostMs;
        }
    }
}
const unmatchedOk = callsInWindow.filter((c) => c.outcome === "ok" && !matchedOkIds.has(c.id));

// ---------- 6. Per-call fields and process gate replay

for (const c of callsInWindow) {
    if (c.g !== undefined && c.r !== undefined) {
        c.hold = c.r - c.g;
    }
    if (c.g !== undefined) c.w = c.g - c.s;
    if (c.outcome === "busy") c.wBusy = c.f - c.s;
}

for (const p of ADAPTER_PORTS) {
    const calls = byAdapter[p];
    const ev = [];
    for (const c of calls) {
        ev.push({ t: c.s, k: 1, c });
        ev.push({ t: c.f, k: 0, c });
    }
    ev.sort((x, y) => x.t - y.t || x.k - y.k);
    const holders = new Set();
    const queue = [];
    for (const e of ev) {
        const c = e.c;
        if (e.k === 1) {
            if (holders.size < SLOTS) {
                holders.add(c);
                c.enter = c.s;
            } else {
                queue.push(c);
            }
        } else if (holders.has(c)) {
            holders.delete(c);
            if (queue.length) {
                const h = queue.shift();
                holders.add(h);
                h.enter = e.t;
            }
        } else {
            const qi = queue.indexOf(c);
            if (qi >= 0) {
                queue.splice(qi, 1);
                c.processRefused = true;
            }
        }
    }
    for (const c of calls) {
        if (c.enter !== undefined) {
            c.p = c.enter - c.s;
            c.a = c.enter;
            if (c.g !== undefined) c.q = c.g - c.a;
            else if (c.outcome === "busy") c.q = c.f - c.a;
        }
    }
}

// ---------- 7. Redis-level overtakes and related figures

const withArrival = callsInWindow.filter((c) => c.a !== undefined);
const grantedCalls = callsInWindow.filter((c) => c.g !== undefined && c.a !== undefined);

// For each call X (granted), overtakesBy(X) = list of Y that arrived earlier and were still waiting when X was granted.
const overtakeCount = new Map();
let totalOvertakes = 0;
let overtakeSame = 0;
let overtakeOther = 0;
const grantsOvertook = new Set();
for (const x of grantedCalls) {
    for (const y of withArrival) {
        if (y === x || !(y.a < x.a)) continue;
        const yAhead = (y.g !== undefined && y.g > x.g) || (y.outcome === "busy" && y.f > x.g);
        if (!yAhead) continue;
        totalOvertakes++;
        if (y.adapter === x.adapter) overtakeSame++;
        else overtakeOther++;
        grantsOvertook.add(x.id);
        overtakeCount.set(y.id, (overtakeCount.get(y.id) || 0) + 1);
    }
}

function laterGrantedAhead(x) {
    const endRef = x.g !== undefined ? x.g : x.f;
    let same = 0;
    let other = 0;
    if (x.a === undefined) return null;
    for (const y of withArrival) {
        if (y === x) continue;
        if (y.a <= x.a) continue;
        if (y.g === undefined || !(y.g < endRef)) continue;
        if (y.adapter === x.adapter) same++;
        else other++;
    }
    return { same, other };
}

// ---------- 8. Contention

const contentionAtGrant = [];
for (const x of grantedCalls) {
    let waiting = 0;
    for (const z of withArrival) {
        if (z === x) continue;
        if (z.a > x.g) continue;
        const zWaiting = (z.g !== undefined && z.g > x.g) || (z.outcome === "busy" && z.f > x.g);
        if (zWaiting) waiting++;
    }
    contentionAtGrant.push(waiting);
}
const inflightAtStart = [];
for (const p of ADAPTER_PORTS) {
    const calls = byAdapter[p];
    for (const c of calls) {
        let n = 0;
        for (const o of calls) if (o.s <= c.s && o.f > c.s) n++;
        inflightAtStart.push(n);
    }
}

// ---------- 9. Distributions

const pVals = callsInWindow.filter((c) => c.p !== undefined).map((c) => c.p);
const qVals = callsInWindow.filter((c) => c.q !== undefined).map((c) => c.q);
const wVals = callsInWindow
    .map((c) => (c.g !== undefined ? c.w : c.outcome === "busy" ? c.wBusy : undefined))
    .filter((x) => x !== undefined);
const holdVals = callsInWindow.filter((c) => c.hold !== undefined).map((c) => c.hold);
const holdStats = stats(holdVals);
const medianHold = holdStats.p50 !== null ? holdStats.p50 : 0;

// ---------- 10. Ideal single FIFO

const idealSlots = new Array(SLOTS).fill(0);
const idealWaits = [];
for (const c of callsInWindow) {
    let hold;
    if (c.hold !== undefined) hold = c.hold;
    else hold = medianHold;
    let mi = 0;
    for (let i = 1; i < SLOTS; i++) if (idealSlots[i] < idealSlots[mi]) mi = i;
    const start = Math.max(c.s, idealSlots[mi]);
    idealWaits.push(start - c.s);
    idealSlots[mi] = start + hold;
}
const idealStats = stats(idealWaits);
const idealOver30 = idealWaits.filter((w) => w > BUDGET_S * 1000).length;

// ---------- 11. Token gate

let tokenOverlaps = 0;
const tokenOverlapExamples = [];
for (let i = 0; i < callsInWindow.length; i++) {
    for (let j = i + 1; j < callsInWindow.length; j++) {
        const x = callsInWindow[i];
        const y = callsInWindow[j];
        if (x.tokenFp !== y.tokenFp) continue;
        if (y.s < x.f && x.s < y.f) {
            tokenOverlaps++;
            if (tokenOverlapExamples.length < 5) tokenOverlapExamples.push(`${x.id} / ${y.id} token ${x.tokenFp}`);
        }
    }
}

// ---------- Output

const offsetLabel = offsetSpread
    ? `${offsetMs.toFixed(1)} ms (samples range ${offsetSpread[0]} to ${offsetSpread[1]} ms)`
    : `${offsetMs} ms`;
const folderName = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop();

log(`EXPORT PERMIT WAIT ANALYSIS`);
log(`folder: ${folderName}`);
log(`window: ${values.from} to ${values.to} (call starts; monitor +/- 5 s)`);
log(`clock offset: ${offsetLabel}, ${offsetNote}`);
log("");

log("SANITY");
for (const d of adapterData) {
    const win = byAdapter[d.port];
    const ok = win.filter((c) => c.outcome === "ok").length;
    const busy = win.filter((c) => c.outcome === "busy").length;
    const err = win.filter((c) => c.outcome === "error").length;
    log(`adapter ${d.port}: calls in window ${win.length} (ok ${ok}, busy ${busy}, other error ${err})`);
    log(
        `  raw: export_shape starts ${d.raw.starts}, export finish blocks ${d.raw.exportFinishes}, busy lines ${d.raw.busyLines}`
    );
    log(
        `  raw anomalies: unfinished starts ${d.raw.unfinished}, orphan finishes ${d.raw.orphanFinish}, duplicate finishes ${d.raw.dupFinish}, busy-without-error-outcome ${d.raw.outcomeMismatch}, other failed lines ${d.raw.otherFailed.length}`
    );
}
const totalWin = callsInWindow.length;
const totalOk = callsInWindow.filter((c) => c.outcome === "ok").length;
const totalBusy = callsInWindow.filter((c) => c.outcome === "busy").length;
log(
    `total calls in window: ${totalWin} (ok ${totalOk}, busy ${totalBusy}, other error ${totalWin - totalOk - totalBusy})`
);
log(`grant ZADD lines in window: ${grants.length} (duplicate members ${grantDupMember})`);
log(
    `release ZREM lines in window (adapter conns): ${releases.length}; other-client ZREM on the key: ${releasesOtherConn}`
);
log(
    `monitor records parsed: ${monRecs.length}; malformed lines ${monMalformed}; lines with corrupted prefix recovered ${monPrefixCorrupt}`
);
log(`evalsha polls in window: ${polls.length}; adapter connections: ${adapterConns.join(", ")}`);
log(
    `matched ok calls: ${matchedOkIds.size} of ${totalOk}; unmatched ok calls ${unmatchedOk.length}; unmatched releases ${unmatchedReleases.length}`
);
log(`grant/release consistency issues: ${grantMismatch.length}`);
for (const g of grantMismatch.slice(0, 5)) log(`  ${g}`);
log(`duration check: max |durationMs - (f - s)| = ${maxDurDiff} ms${maxDurCall ? ` (call ${maxDurCall.id})` : ""}`);
log(`busy calls with X: ${callsInWindow.filter((c) => c.outcome === "busy").length}`);
log("");

log("CONNECTION TO ADAPTER MAPPING");
for (const l of mappingLines) log(l);
log("");

log("TOKEN GATE");
log(`same-token overlapping call pairs: ${tokenOverlaps} (expected 0)`);
for (const ex of tokenOverlapExamples) log(`  ${ex}`);
log("");

log("PROCESS GATE REPLAY (4 slots per adapter, FIFO)");
const queuedRefused = callsInWindow.filter((c) => c.processRefused).length;
log(`calls refused while queued at process gate: ${queuedRefused}`);
log(statLine("p (process-gate wait)", stats(pVals), secs));
log("");

log("REDIS LEVEL");
log(`grants: ${grantedCalls.length}`);
log(`total overtakes: ${totalOvertakes} (same adapter ${overtakeSame}, other adapter ${overtakeOther})`);
const shareOvertook = grantedCalls.length ? ((grantsOvertook.size / grantedCalls.length) * 100).toFixed(1) : "n/a";
log(`grants that overtook at least one earlier arrival: ${grantsOvertook.size} (${shareOvertook}% of grants)`);
log(statLine("q (Redis wait)", stats(qVals), secs));
log(statLine("w (total wait; busy = f - s)", stats(wVals), secs));
log(statLine("hold (grant to release)", stats(holdVals), secs));
log("");

log("LISTED CALLS (busy, or total wait >= 20 s)");
log(
    `${pad("adapter", 8)}${pad("start (UTC)", 26)}${pad("p", 12)}${pad("q", 12)}${pad("w", 12)}${pad("hold", 12)}${pad("outcome", 9)}${pad("later ahead same", 18)}other`
);
const listed = callsInWindow.filter(
    (c) => c.outcome === "busy" || (c.w !== undefined && c.w >= 20000) || c.outcome === "busy"
);
const listedUnique = [...new Set(listed)];
for (const c of listedUnique) {
    const ahead = laterGrantedAhead(c);
    const pLabel = c.p !== undefined ? secs(c.p) : c.processRefused ? `${secs(c.f - c.s)}(q)` : "n/a";
    const wv = c.g !== undefined ? c.w : c.outcome === "busy" ? c.wBusy : undefined;
    log(
        `${pad(c.adapter, 8)}${pad(iso(c.s), 26)}${pad(pLabel, 12)}${pad(c.q !== undefined ? secs(c.q) : "n/a", 12)}${pad(secs(wv), 12)}${pad(c.hold !== undefined ? secs(c.hold) : "n/a", 12)}${pad(c.outcome, 9)}${pad(ahead ? ahead.same : "n/a", 18)}${ahead ? ahead.other : "n/a"}`
    );
}
log(`(p marked (q) = refused while queued at process gate, shown as time queued before refusal)`);
log("");

log("CONTENTION");
log(statLine("calls waiting at Redis per grant", stats(contentionAtGrant), (x) => String(x)));
log(statLine("calls in flight per adapter start", stats(inflightAtStart), (x) => String(x)));
log("");

log("DISTRIBUTIONS (nearest rank)");
log(statLine("p", stats(pVals), secs));
log(statLine("q", stats(qVals), secs));
log(statLine("w", stats(wVals), secs));
log(statLine("hold", stats(holdVals), secs));
log(
    statLine(
        "busy total wait (f - s)",
        stats(callsInWindow.filter((c) => c.outcome === "busy").map((c) => c.wBusy)),
        secs
    )
);
log("");

log("IDEAL SINGLE FIFO (4 slots, arrival at s, measured hold; busy and unmatched use median hold)");
log(`median hold used: ${secs(medianHold)}`);
log(
    `simulated wait p50 ${secs(idealStats.p50)}, p95 ${secs(idealStats.p95)}, max ${secs(idealStats.max)}; waits over 30 s: ${idealOver30}`
);
log("");

log("BUSY CROSS-CHECK (X from busy text next to 30 - p)");
for (const c of callsInWindow.filter((x) => x.outcome === "busy")) {
    const pv = c.p !== undefined ? c.p : c.f - c.s;
    log(
        `${c.id}  X ${c.busyX} s   30 - p ${(BUDGET_S - pv / 1000).toFixed(3)} s   ${c.p !== undefined ? "" : "(refused in queue, p = time queued)"}`
    );
}
log("");

log("CAVEATS");
log(`unmatched releases: ${unmatchedReleases.length}`);
for (const u of unmatchedReleases.slice(0, 10)) log(`  adapter ${u.adapter} member ${u.member} at ${u.at}`);
log(`unmatched ok calls: ${unmatchedOk.length}`);
for (const c of unmatchedOk.slice(0, 10)) log(`  ${c.adapter} ${c.id} s ${iso(c.s)} f ${iso(c.f)}`);
log(`monitor lines with corrupted prefix (recovered by regex, the lost prefix event is unknown): ${monPrefixCorrupt}`);
log(`monitor malformed lines skipped: ${monMalformed}`);

const text = out.join("\n") + "\n";
const txtPath = join(dir, "wait-analysis.txt");
writeFileSync(txtPath, text, "utf8");

const jsonObj = {
    folder: folderName,
    window: { from: values.from, to: values.to },
    clockOffsetMs: offsetMs,
    clockOffsetNote: offsetNote,
    sampleCount,
    connectionMapping: connToAdapter,
    mappingCounts: nearCount,
    sanity: {
        totalWindowCalls: totalWin,
        ok: totalOk,
        busy: totalBusy,
        grants: grants.length,
        releases: releases.length,
        matchedOk: matchedOkIds.size,
        unmatchedOk: unmatchedOk.length,
        unmatchedReleases: unmatchedReleases.length,
        grantMismatch,
        monitorMalformed: monMalformed,
        monitorPrefixCorrupt: monPrefixCorrupt,
        tokenOverlaps,
        maxDurationDiffMs: maxDurDiff,
    },
    overtakes: {
        total: totalOvertakes,
        same: overtakeSame,
        other: overtakeOther,
        grantsThatOvertook: grantsOvertook.size,
        grants: grantedCalls.length,
    },
    distributions: { p: stats(pVals), q: stats(qVals), w: stats(wVals), hold: stats(holdVals) },
    contention: { atGrant: stats(contentionAtGrant), inflightAtStart: stats(inflightAtStart) },
    idealFifo: { ...idealStats, over30s: idealOver30, medianHoldMs: medianHold },
    calls: callsInWindow.map((c) => ({
        id: c.id,
        adapter: c.adapter,
        tokenFp: c.tokenFp,
        startIso: iso(c.s),
        finishIso: iso(c.f),
        outcome: c.outcome,
        busyX: c.busyX,
        durationMs: c.durationMs,
        conn: c.conn ?? null,
        member: c.member ?? null,
        enterMs: c.enter !== undefined ? c.enter - c.s : null,
        processRefused: !!c.processRefused,
        pMs: c.p ?? null,
        qMs: c.q ?? null,
        wMs: c.g !== undefined ? c.w : c.outcome === "busy" ? c.wBusy : null,
        holdMs: c.hold ?? null,
        overtakenBy: overtakeCount.get(c.id) || 0,
    })),
};
writeFileSync(join(dir, "wait-analysis.json"), JSON.stringify(jsonObj, null, 2) + "\n", "utf8");

process.stdout.write(text);
