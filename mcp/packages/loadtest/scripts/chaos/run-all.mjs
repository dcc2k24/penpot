// Runs the T4 failure-injection cases one after another and prints one line per case.
//
// Single-adapter stack (dev stack on this machine): exporter, backend valkey, slow write, Postgres restart, backend
// kill, and last the adapter kill, which needs the operator and runs only with --include-manual.
// Two-adapter stack (mcp/deploy, balancer on 4415): the nginx reload, one adapter down behind nginx, and the stack's
// Redis. They run only with --include-two-adapter and take the balancer URL from --lb-url.
//
// Usage:
//   node run-all.mjs --dry-run --include-manual --include-two-adapter
//   node run-all.mjs --yes --token-file <file> --vars <vars.json> [--only exporter-stopped,slow-backend]
//                    [--include-manual] [--include-two-adapter --lb-url http://127.0.0.1:4415/mcp]
//                    [--results-dir <dir>] [--adapter-log <file>] [--url <dev adapter MCP url>] [--no-cleanup]
//
// --yes is required to run any case: each one stops, starts, restarts or kills something. Run them when the stack
// owner has the stack free and no other run writes to the test file.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const CASES = [
    { name: "exporter-stopped", file: "exporter-stopped.mjs" },
    { name: "backend-valkey-stopped", file: "backend-valkey-stopped.mjs" },
    { name: "slow-backend", file: "slow-backend.mjs" },
    { name: "postgres-restarted", file: "postgres-restarted.mjs" },
    { name: "backend-stopped-during-write", file: "backend-stopped-during-write.mjs" },
    { name: "adapter-killed-during-flush", file: "adapter-killed-during-flush.mjs", manual: true },
    { name: "nginx-reload", file: "nginx-reload.mjs", twoAdapter: true },
    { name: "adapter-down-behind-nginx", file: "adapter-down-behind-nginx.mjs", twoAdapter: true },
    { name: "adapter-redis-stopped", file: "adapter-redis-stopped.mjs", twoAdapter: true },
];

const USAGE = `run-all: runs the T4 cases in order.
Options: --dry-run | --yes, --only <a,b>, --include-manual, --include-two-adapter, --lb-url <balancer MCP url>,
  --token-file, --vars, --url, --results-dir, --adapter-log, --no-cleanup`;

const SHARED = [
    "--dry-run",
    "--yes",
    "--token-file",
    "--vars",
    "--url",
    "--results-dir",
    "--adapter-log",
    "--no-cleanup",
];
const VALUED = new Set(["--token-file", "--vars", "--url", "--results-dir", "--adapter-log", "--lb-url", "--only"]);

function parse(argv) {
    const opts = {
        only: undefined,
        includeManual: false,
        includeTwoAdapter: false,
        lbUrl: undefined,
        forward: [],
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === "--help" || flag === "-h") {
            opts.help = true;
        } else if (flag === "--include-manual") {
            opts.includeManual = true;
        } else if (flag === "--include-two-adapter") {
            opts.includeTwoAdapter = true;
        } else if (flag === "--lb-url") {
            opts.lbUrl = argv[++i];
        } else if (flag === "--only") {
            opts.only = argv[++i].split(",").map((name) => name.trim());
        } else if (SHARED.includes(flag)) {
            opts.forward.push(flag);
            if (VALUED.has(flag)) {
                opts.forward.push(argv[++i]);
            }
        } else {
            throw new Error(`unknown option ${flag}`);
        }
    }
    return opts;
}

function runOne(file, args) {
    return new Promise((done) => {
        const child = spawn(process.execPath, [join(here, file), ...args], {
            stdio: ["ignore", "pipe", "inherit"],
            windowsHide: true,
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write(text);
        });
        child.on("close", (code) => {
            const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith("result: "));
            done({ code, result: resultLine ? resultLine.slice("result: ".length) : undefined });
        });
    });
}

let opts;
try {
    opts = parse(process.argv.slice(2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 2;
}

if (opts && opts.help) {
    console.log(USAGE);
} else if (opts) {
    const dryRun = opts.forward.includes("--dry-run");
    const yes = opts.forward.includes("--yes");
    if (!dryRun && !yes) {
        console.error("run-all: refusing to run without --yes (or use --dry-run to print the plan).");
        process.exitCode = 2;
    } else {
        const selected = CASES.filter((item) => {
            if (opts.only) {
                return opts.only.includes(item.name);
            }
            if (item.manual) {
                return opts.includeManual;
            }
            if (item.twoAdapter) {
                return opts.includeTwoAdapter;
            }
            return true;
        });
        const skipped = CASES.filter((item) => !selected.includes(item)).map((item) => item.name);
        const summary = [];
        for (const item of selected) {
            console.log(`\n==== ${item.name} ====`);
            let args = opts.forward;
            if (item.twoAdapter) {
                // the balancer URL replaces --url for the two-adapter cases only
                const withoutUrl = [];
                for (let i = 0; i < args.length; i++) {
                    if (args[i] === "--url") {
                        i++;
                        continue;
                    }
                    withoutUrl.push(args[i]);
                }
                args = opts.lbUrl ? [...withoutUrl, "--url", opts.lbUrl] : withoutUrl;
                if (!opts.lbUrl && !dryRun) {
                    console.log("  (no --lb-url: the case uses its default, http://127.0.0.1:4415/mcp)");
                }
            }
            const { code, result } = await runOne(item.file, args);
            summary.push({ name: item.name, code, result });
        }
        console.log("\n==== summary ====");
        for (const row of summary) {
            const verdict = row.code === 0 ? "pass or dry run" : row.code === 2 ? "refused" : "FAIL";
            console.log(`${row.name.padEnd(30)} ${verdict.padEnd(16)} ${row.result ?? "(no result file)"}`);
        }
        if (skipped.length > 0) {
            console.log(
                `not run: ${skipped.join(", ")} (adapter-killed-during-flush needs --include-manual; the others need --include-two-adapter)`
            );
        }
        process.exitCode = summary.some((row) => row.code !== 0) ? 1 : 0;
    }
}
