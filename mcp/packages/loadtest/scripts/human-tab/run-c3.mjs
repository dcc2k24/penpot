#!/usr/bin/env node
/**
 * C3 orchestrator (PERF-RUNBOOK row 2-C3): runs the human tab, and after a 120 s baseline starts an agent scenario
 * (c2-same-file by default) as a child process on the same file. Compares the tab's save p95 before and during the
 * agent run, and prints the gate verdict.
 *
 * Usage:
 *   node scripts/human-tab/run-c3.mjs --tokens <file> --vars <vars.json> [--agents 5] [--minutes 3]
 *       [--scenario c2-same-file] [--baseline-s 120]
 *
 * The gate: the save p95 during the agent run must rise by less than 500 ms against the baseline, no edit may be
 * lost, and no save may fail. Each verdict is INCONCLUSIVE when either window has fewer than 20 samples.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    createFreshFile,
    parseArgs as parseHumanArgs,
    percentile,
    readToken,
    readVarsFile,
    runHumanTab,
} from "./human-tab.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(PKG_ROOT, "dist", "index.js");
const MIN_SAMPLES = 20;
const GATE_MS = 500;

/** Splits the arguments into the C3 options and the options for human-tab. */
export function parseArgs(argv) {
    const c3 = { scenario: "c2-same-file", agents: 5, baselineS: 120, agentDurationS: null };
    const passThrough = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return v;
        };
        switch (arg) {
            case "--scenario":
                c3.scenario = value();
                break;
            case "--agents":
                c3.agents = Number(value());
                break;
            case "--baseline-s":
                c3.baselineS = Number(value());
                break;
            case "--agent-duration":
                c3.agentDurationS = Number(value());
                break;
            default:
                passThrough.push(arg);
                if (
                    [
                        "--minutes",
                        "--interval-ms",
                        "--save-delay-ms",
                        "--frontend",
                        "--backend",
                        "--mcp",
                        "--email",
                        "--tokens",
                        "--vars",
                        "--results",
                    ].includes(arg)
                ) {
                    passThrough.push(value());
                }
        }
    }
    const human = parseHumanArgs(passThrough);
    if (!Number.isInteger(c3.agents) || c3.agents < 1) {
        throw new Error("--agents must be a positive integer");
    }
    if (!(c3.baselineS >= 0)) {
        throw new Error("--baseline-s must be zero or more");
    }
    if (human.minutes * 60 <= c3.baselineS + 60) {
        throw new Error("--minutes must leave at least a minute after the baseline");
    }
    // by default the agents run until 20 s before the tab stops, so they write for the whole window
    if (c3.agentDurationS === null) {
        c3.agentDurationS = Math.max(60, Math.round(human.minutes * 60 - c3.baselineS - 20));
    }
    if (!(c3.agentDurationS > 0)) {
        throw new Error("--agent-duration must be positive");
    }
    return { ...c3, human };
}

function runAgents(c3, human) {
    const args = [
        CLI,
        "run",
        c3.scenario,
        "--tokens",
        human.tokens,
        "--url",
        human.mcp,
        "--vars",
        human.vars,
        "--agents",
        String(c3.agents),
        "--duration",
        `${Math.round(c3.agentDurationS)}s`,
        "--results",
        human.results,
    ];
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        let tail = "";
        const keep = (chunk) => {
            tail = (tail + chunk.toString("utf8")).slice(-4000);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        child.on("close", (code) => resolve({ code, tail }));
    });
}

/**
 * Computes the C3 verdicts from the tab result and the agent window (both as offsets from the start of editing).
 * Each verdict needs at least MIN_SAMPLES samples in both the baseline and the agent window; otherwise INCONCLUSIVE.
 *
 * - rawSaves: the p95 of the HTTP round trip of each update-file save (start to end of the request).
 * - gateAsWritten: the runbook gate. The p95 of press-to-save (from a key press to the end of the save response that
 *   carries it) may rise by less than 500 ms.
 * Both: no edit may be lost, and no save may fail.
 *
 * @param {object} tab - the result of runHumanTab
 * @param {number | null} agentStartMs
 * @param {number | null} agentEndMs
 */
export function judge(tab, agentStartMs, agentEndMs) {
    const end = (agentEndMs ?? Infinity) + 5000;
    const windowOf = (atMs) => {
        if (agentStartMs === null) return null;
        if (atMs < agentStartMs) return "before";
        if (atMs <= end) return "during";
        return null;
    };
    const okSaves = tab.saves.filter((s) => s.status === 200 && s.durationMs !== null && !s.error);
    const samplesFor = (items, value) => {
        const out = { before: [], during: [] };
        for (const item of items) {
            const w = windowOf(item.atMs);
            if (w) out[w].push(value(item));
        }
        return out;
    };
    const raw = samplesFor(okSaves, (s) => s.durationMs);
    const pts = samplesFor(tab.pressToSave?.samples ?? [], (p) => p.latencyMs);
    const broken = tab.lostEdits?.count > 0 || tab.lostEdits?.checked === false || tab.saveSummary.errors > 0;

    const rule = (sets) => {
        const beforeP95 = percentile(sets.before, 95);
        const duringP95 = percentile(sets.during, 95);
        const riseMs = beforeP95 !== null && duringP95 !== null ? Math.round(duringP95 - beforeP95) : null;
        let verdict;
        if (sets.before.length < MIN_SAMPLES || sets.during.length < MIN_SAMPLES) verdict = "INCONCLUSIVE";
        else if (broken) verdict = "FAIL";
        else verdict = riseMs < GATE_MS ? "PASS" : "FAIL";
        return {
            verdict,
            before: { samples: sets.before.length, p95: round(beforeP95) },
            during: { samples: sets.during.length, p95: round(duringP95) },
            riseMs,
        };
    };
    return {
        verdicts: { rawSaves: rule(raw), gateAsWritten: rule(pts) },
        minSamples: MIN_SAMPLES,
        gateMs: GATE_MS,
        lostEdits: tab.lostEdits,
        saveErrors: tab.saveSummary.errors,
        pressToSaveUnmatched: tab.pressToSave?.unmatchedPresses ?? null,
    };
}

function round(v) {
    return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

async function main() {
    let c3;
    try {
        c3 = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(
            `${error.message}\nUsage: node scripts/human-tab/run-c3.mjs --tokens <file> --vars <vars.json> [--agents 5] [--minutes 3] [--scenario c2-same-file] [--baseline-s 120]`
        );
        process.exit(2);
    }
    let { human } = c3;
    if (human.freshFile) {
        // one fresh file for the tab and the agents, so both start from the same rows
        const token = await readToken(human.tokens);
        const fresh = await createFreshFile(human, await readVarsFile(human.vars), token, (line) =>
            console.error(`[run-c3] ${line}`)
        );
        human = { ...human, vars: fresh.file, freshFile: false };
        console.error(`[run-c3] agents use ${fresh.file}`);
    }
    let agentStartMs = null;
    let agentEndMs = null;
    let agentRun = null;
    let editStart = null;
    const agentsDone = (async () => {
        // the agent window opens baseline seconds after the first edit
        await new Promise((resolve) => {
            const check = setInterval(() => {
                if (editStart !== null) {
                    clearInterval(check);
                    setTimeout(resolve, c3.baselineS * 1000);
                }
            }, 200);
        });
        agentStartMs = Date.now() - editStart;
        console.error(`[run-c3] starting ${c3.scenario} with ${c3.agents} agents at +${agentStartMs} ms`);
        agentRun = await runAgents(c3, human);
        agentEndMs = Date.now() - editStart;
        console.error(`[run-c3] agents exited with ${agentRun.code} at +${agentEndMs} ms`);
    })();

    let tab;
    try {
        tab = await runHumanTab(human, {
            onEditingStart: (epoch) => {
                editStart = epoch;
            },
        });
    } catch (error) {
        // a child agent run started by this process keeps going until it ends on its own
        console.error(`human tab failed: ${error.message}`);
        process.exit(1);
    }
    // the tab runs for the whole window; wait for the agent run if it is still going
    await agentsDone;
    const verdict = judge(tab, agentStartMs, agentEndMs);
    const summary = {
        kind: "c3-human-tab",
        scenario: c3.scenario,
        agents: c3.agents,
        baselineS: c3.baselineS,
        agentDurationS: c3.agentDurationS,
        agentStartMs,
        agentEndMs,
        agentExitCode: agentRun?.code ?? null,
        agentOutputTail: agentRun?.tail ?? "",
        ...verdict,
        humanResult: tab.file,
    };
    await mkdir(human.results, { recursive: true });
    const file = path.join(human.results, `c3-human-tab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify({ ...verdict, agentExitCode: summary.agentExitCode, file }, null, 2));
    process.exit(verdict.verdicts.gateAsWritten === "PASS" ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
