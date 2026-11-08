// Runs the adversarial suite: node scripts/adversarial/run.mjs [--groups 1,3] [--out <file>]
// Config comes from the ADV_* environment variables (see the brief); --groups and --out override them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeAll, connect, guard, healthCheck, loadConfig, redact } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Group modules in run order: number and file name. */
const GROUP_FILES = [
    [1, "g1-scopes.mjs"],
    [2, "g2-backend-switch.mjs"],
    [3, "g3-ssrf.mjs"],
    [4, "g4-paths.mjs"],
    [5, "g5-bodies.mjs"],
    [6, "g6-sandbox.mjs"],
    [7, "g7-replay-limits.mjs"],
    [8, "g8-leaks.mjs"],
];

/**
 * Reads the value of a command-line option.
 *
 * @param {string[]} argv - arguments after the script name
 * @param {string} flag - option name, for example --out
 * @returns {string | undefined} the value, or undefined when absent
 */
function optionOf(argv, flag) {
    const at = argv.indexOf(flag);
    if (at === -1) {
        return undefined;
    }
    return argv[at + 1];
}

/**
 * Runs a git command in the repository and returns its trimmed output, or null on failure.
 *
 * @param {string[]} args - git arguments
 * @param {string} cwd - working directory
 * @returns {string | null} the output, or null
 */
function git(args, cwd) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

/**
 * Replaces secrets in every string of a value, recursively.
 *
 * @param {unknown} value - JSON-able value
 * @param {object} cfg - config
 * @returns {unknown} the cleaned value
 */
function redactDeep(value, cfg) {
    if (typeof value === "string") {
        return redact(value, cfg);
    }
    if (Array.isArray(value)) {
        return value.map((v) => redactDeep(v, cfg));
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactDeep(v, cfg);
        }
        return out;
    }
    return value;
}

/**
 * Prints one case in the runner format.
 *
 * @param {object} c - the Case
 * @param {object} cfg - config, for redaction
 */
function printCase(c, cfg) {
    const label = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "N/T";
    console.log(`${label} ${c.id} ${redact(c.title, cfg)} (${c.durationMs ?? 0} ms)`);
    if (c.status === "fail") {
        console.log(`    note: ${redact(c.note ?? "", cfg)}`);
        console.log(`    observed: ${redact(c.observed ?? "", cfg)}`);
    } else if (c.status === "not-testable") {
        console.log(`    reason: ${redact(c.note ?? "", cfg)}`);
    }
}

/**
 * Entry point: runs the selected groups, prints the cases and writes the JSON report.
 *
 * @returns {Promise<number>} the process exit code
 */
async function main() {
    const argv = process.argv.slice(2);
    let cfg;
    try {
        cfg = loadConfig(process.env);
    } catch (error) {
        console.error(`config error: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
    const groupsArg = optionOf(argv, "--groups");
    if (groupsArg !== undefined) {
        cfg.groups = groupsArg
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n));
    }
    const outArg = optionOf(argv, "--out");
    if (outArg !== undefined) {
        cfg.outFile = outArg;
    }
    if (cfg.groups && cfg.groups.length === 0) {
        cfg.groups = null;
    }

    const startedAt = new Date().toISOString();
    let control;
    try {
        control = await connect(cfg, cfg.fullToken);
    } catch (error) {
        console.error(
            `cannot connect to the MCP adapter at ${cfg.mcpUrl}: ${redact(String(error?.message ?? error), cfg)}`
        );
        return 2;
    }

    const cases = [];

    for (const [number, file] of GROUP_FILES) {
        if (cfg.groups && !cfg.groups.includes(number)) {
            continue;
        }
        const path = join(here, file);
        if (!existsSync(path)) {
            console.log(`skip group ${number}: ${file} does not exist yet`);
            continue;
        }
        let mod;
        try {
            mod = await import(pathToFileURL(path).href);
        } catch (error) {
            console.log(`skip group ${number}: ${file} does not load: ${redact(String(error?.message ?? error), cfg)}`);
            const broken = {
                group: `${number}`,
                id: `${number}.00`,
                title: "group module loads",
                request: `import ${file}`,
                expected: "module loads",
                status: "fail",
                observed: "",
                note: redact(`suite error: ${String(error?.message ?? error)}`, cfg),
                severity: "low",
                durationMs: 0,
            };
            cases.push(broken);
            continue;
        }
        const name = mod.name ?? `${number}`;
        console.log(`== group ${name}`);
        const groupCases = await guard(
            {
                group: name,
                id: `${number}.00`,
                title: "group runs to completion",
                request: `run() of ${file}`,
                expected: "no suite error",
                severity: "low",
            },
            () => mod.run({ cfg, control, log: (msg) => console.log(redact(String(msg), cfg)) })
        );
        cases.push(...groupCases);
        cases.push(await healthCheck(cfg, control, name));
    }

    for (const c of cases) {
        printCase(c, cfg);
    }

    const summary = {
        pass: cases.filter((c) => c.status === "pass").length,
        fail: cases.filter((c) => c.status === "fail").length,
        notTestable: cases.filter((c) => c.status === "not-testable").length,
        total: cases.length,
    };
    console.log(
        `SUMMARY pass=${summary.pass} fail=${summary.fail} not-testable=${summary.notTestable} total=${summary.total}`
    );

    const repoRoot = git(["rev-parse", "--show-toplevel"], here) ?? null;
    const commit = repoRoot ? git(["rev-parse", "--short", "HEAD"], repoRoot) : null;
    const dirty = repoRoot ? (git(["status", "--porcelain"], repoRoot) ?? "").length > 0 : null;

    const report = {
        startedAt,
        finishedAt: new Date().toISOString(),
        commit,
        dirty,
        config: {
            mcpUrl: cfg.mcpUrl,
            backendUrl: cfg.backendUrl,
            publicUrl: cfg.publicUrl,
            groups: cfg.groups ?? "all",
            tokens: {
                full: true,
                read: Boolean(cfg.readToken),
                off: Boolean(cfg.offToken),
                exp: Boolean(cfg.expToken),
                revoked: Boolean(cfg.revokedToken),
                outsider: Boolean(cfg.outsiderToken),
                agents: cfg.agentTokens.length,
            },
            sessionCookie: Boolean(cfg.sessionCookie),
            adapterLog: Boolean(cfg.adapterLog),
            advIds: Object.keys(cfg.advIds ?? {}).length > 0,
        },
        summary,
        cases,
    };
    const outDir = dirname(cfg.outFile);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(cfg.outFile, JSON.stringify(redactDeep(report, cfg), null, 2) + "\n", "utf8");
    console.log(`report written to ${cfg.outFile}`);

    await closeAll();
    return summary.fail > 0 ? 1 : 0;
}

const code = await main().catch((error) => {
    console.error(`suite crashed: ${String(error?.message ?? error)}`);
    return 2;
});
process.exit(code);
