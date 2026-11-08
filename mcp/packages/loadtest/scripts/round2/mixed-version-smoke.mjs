// Mixed-version smoke test. Runs the same four steps against two adapter URLs that share one backend, one client per
// adapter, and reports each step per adapter. The script starts nothing: it only calls the two MCP endpoints it is given.
// Usage: node scripts/round2/mixed-version-smoke.mjs --old-url <url> --new-url <url> --token-file <file> --vars <file>
//        [--dry-run] [--help]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Text that the adapter puts in a tool error when the backend is too old (BackendTokenValidator.assertContract). */
export const CONTRACT_MISMATCH_TEXT = "backend too old for backend mode";
export const CONTRACT_MISMATCH = "contract mismatch";
export const FAILURE = "failure";

const USAGE = `Usage: node scripts/round2/mixed-version-smoke.mjs --old-url <url> --new-url <url> --token-file <file> --vars <file> [--dry-run] [--help]

Runs whoami, get_file_outline, apply_operations (one rectangle) and find_shapes against each adapter URL.
Options:
  --old-url <url>     MCP endpoint of the old adapter, for example http://localhost:4401/mcp (required)
  --new-url <url>     MCP endpoint of the new adapter, for example http://localhost:4402/mcp (required)
  --token-file <file> file that holds the MCP token; the token is read, never printed (required)
  --vars <file>       setup vars JSON with fileId and pageId (required)
  --dry-run           print the steps per adapter and run nothing
  --help              print this text
Exit code 1 when any step fails on either adapter, otherwise 0.`;

const VALUE_FLAGS = {
    "--old-url": "oldUrl",
    "--new-url": "newUrl",
    "--token-file": "tokenFile",
    "--vars": "varsFile",
};

const ADAPTERS_FOR_RUN = ["old", "new"];

/**
 * Reads the command line.
 *
 * @param argv - arguments after the script name
 * @returns the parsed options
 * @throws Error on an unknown flag, a flag without a value, or a missing required option
 */
export function parseArgs(argv) {
    const opts = {
        oldUrl: undefined,
        newUrl: undefined,
        tokenFile: undefined,
        varsFile: undefined,
        dryRun: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            opts.help = true;
        } else if (arg === "--dry-run") {
            opts.dryRun = true;
        } else if (Object.hasOwn(VALUE_FLAGS, arg)) {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error(`${arg} needs a value`);
            }
            opts[VALUE_FLAGS[arg]] = value;
            i++;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (opts.help) {
        return opts;
    }
    const missing = Object.entries(VALUE_FLAGS)
        .filter(([, key]) => opts[key] === undefined)
        .map(([flag]) => flag);
    if (missing.length > 0) {
        throw new Error(`missing required option(s): ${missing.join(", ")}`);
    }
    return opts;
}

/**
 * Names the rectangle that one adapter creates.
 *
 * @param label - adapter label, old or new
 * @param timestamp - run timestamp, shared by both adapters of one run
 * @returns the shape name
 */
export function rectName(label, timestamp) {
    return `mixed-smoke-${label}-${timestamp}`;
}

/**
 * Builds the operations of the write step: one create_rect on the page.
 *
 * @param label - adapter label, old or new
 * @param timestamp - run timestamp
 * @param pageId - id of the page that receives the rectangle
 * @returns the operations array for apply_operations
 */
export function buildOps(label, timestamp, pageId) {
    return [
        {
            op: "create_rect",
            pageId,
            name: rectName(label, timestamp),
            x: 100,
            y: 100,
            width: 10,
            height: 10,
        },
    ];
}

/**
 * Escapes a string so that a regular expression matches it literally.
 *
 * @param text - plain text
 * @returns the escaped text
 */
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Says whether a failure text is the contract refusal of an old backend.
 *
 * @param text - the error text of a failed step
 * @returns CONTRACT_MISMATCH when the text holds the contract error, otherwise FAILURE
 */
export function classifyFailure(text) {
    return typeof text === "string" && text.includes(CONTRACT_MISMATCH_TEXT) ? CONTRACT_MISMATCH : FAILURE;
}

/**
 * Counts the step results.
 *
 * @param results - objects with ok (boolean) and errorText (string, for failed steps)
 * @returns total, pass and fail counts, and contractMismatch (true when any failed step is a contract mismatch)
 */
export function summarizeSteps(results) {
    let pass = 0;
    let fail = 0;
    let contractMismatchCount = 0;
    for (const result of results) {
        if (result.ok) {
            pass++;
            continue;
        }
        fail++;
        if (classifyFailure(result.errorText) === CONTRACT_MISMATCH) {
            contractMismatchCount++;
        }
    }
    return {
        total: results.length,
        pass,
        fail,
        contractMismatchCount,
        contractMismatch: contractMismatchCount > 0,
    };
}

/**
 * Lists the steps of one adapter run.
 *
 * @param ctx - fileId, pageId, label (adapter label) and timestamp
 * @returns the steps, in order, each with name, tool, args and check
 */
function makeSteps(ctx) {
    const name = rectName(ctx.label, ctx.timestamp);
    return [
        {
            name: "whoami",
            tool: "whoami",
            args: {},
            check: (json) => {
                if (!(Array.isArray(json?.scopes) && json.scopes.includes("mcp:write"))) {
                    throw new Error("scopes do not include mcp:write");
                }
                return "scopes include mcp:write";
            },
        },
        {
            name: "get_file_outline",
            tool: "get_file_outline",
            args: { fileId: ctx.fileId },
            check: (json) => {
                if (!Array.isArray(json?.pages) || json.pages.length < 1) {
                    throw new Error("pages is not an array with at least one entry");
                }
                return `pages=${json.pages.length}`;
            },
        },
        {
            name: "apply_operations create_rect",
            tool: "apply_operations",
            args: { fileId: ctx.fileId, operations: buildOps(ctx.label, ctx.timestamp, ctx.pageId) },
            check: (json) => (typeof json?.revn === "number" ? `revn=${json.revn}` : "no revn in result"),
        },
        {
            name: "find_shapes by name",
            tool: "find_shapes",
            args: { fileId: ctx.fileId, pageId: ctx.pageId, nameRegex: `^${escapeRegex(name)}$` },
            check: (json) => {
                const count = Array.isArray(json?.matches) ? json.matches.length : undefined;
                if (count !== 1) {
                    throw new Error(`expected 1 match, got ${count === undefined ? "no matches list" : count}`);
                }
                return "1 match";
            },
        },
    ];
}

/**
 * Trims a failure text to one line of at most 160 characters.
 *
 * @param text - raw error text
 * @returns the shortened text
 */
function shortText(text) {
    return String(text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 160);
}

/**
 * Prints the steps of each adapter without connecting to anything.
 *
 * @param opts - parsed options
 */
function printPlan(opts) {
    const ctx = { fileId: "<fileId from vars>", pageId: "<pageId from vars>", timestamp: "<timestamp>" };
    const urls = { old: opts.oldUrl, new: opts.newUrl };
    console.log("Dry run: nothing is sent.");
    for (const label of ADAPTERS_FOR_RUN) {
        console.log(`\nAdapter ${label}: ${urls[label]}`);
        makeSteps({ ...ctx, label }).forEach((step, index) => {
            console.log(`  ${index + 1}. ${step.name}: ${step.tool} ${JSON.stringify(step.args)}`);
        });
    }
}

/**
 * Runs the four steps against one adapter with its own client. The client is always closed.
 *
 * @param label - adapter label, old or new
 * @param url - MCP endpoint of the adapter
 * @param token - MCP token
 * @param vars - fileId and pageId
 * @param timestamp - run timestamp
 * @returns one result per step
 */
async function runAdapter(label, url, token, vars, timestamp) {
    const ctx = { fileId: vars.fileId, pageId: vars.pageId, label, timestamp };
    const steps = makeSteps(ctx);
    const results = [];
    const record = (step, ok, durationMs, errorText, note) => {
        results.push({ adapter: label, step: step.name, ok, durationMs, errorText });
        if (ok) {
            console.log(`[${label}] PASS ${step.name} (${durationMs.toFixed(0)} ms)${note ? " " + note : ""}`);
        } else {
            const tag = classifyFailure(errorText) === CONTRACT_MISMATCH ? " (contract mismatch)" : "";
            console.log(
                `[${label}] FAIL ${step.name} (${durationMs.toFixed(0)} ms)${tag} :: ${shortText(errorText).slice(0, 160)}`
            );
        }
    };

    const { McpLoadClient } = await import("../../dist/McpLoadClient.js");
    const client = new McpLoadClient();
    try {
        try {
            await client.connect(url, token);
        } catch (error) {
            const message = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
            for (const step of steps) {
                record(step, false, 0, message);
            }
            return results;
        }
        for (const step of steps) {
            const outcome = await client.callTool(step.tool, step.args);
            if (!outcome.ok || outcome.isError) {
                record(step, false, outcome.durationMs, outcome.error ?? outcome.text ?? "tool reported an error");
                continue;
            }
            try {
                const note = step.check(outcome.json);
                record(step, true, outcome.durationMs, "", note);
            } catch (error) {
                record(step, false, outcome.durationMs, error instanceof Error ? error.message : String(error));
            }
        }
        return results;
    } finally {
        try {
            await client.close();
        } catch {
            // closing a broken session is not a smoke result
        }
    }
}

/**
 * Prints the summary table.
 *
 * @param results - all step results
 */
function printTable(results) {
    console.log("\nadapter  step                         result  duration_ms");
    for (const r of results) {
        const step = r.step.padEnd(28);
        console.log(`${r.adapter.padEnd(8)} ${step} ${(r.ok ? "PASS" : "FAIL").padEnd(7)} ${r.durationMs.toFixed(0)}`);
    }
}

/**
 * Runs the command.
 *
 * @param argv - arguments after the script name
 * @returns the exit code
 */
async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }
    if (opts.dryRun) {
        printPlan(opts);
        return 0;
    }
    const token = readFileSync(opts.tokenFile, "utf8").trim();
    const vars = JSON.parse(readFileSync(opts.varsFile, "utf8"));
    if (typeof vars.fileId !== "string" || typeof vars.pageId !== "string") {
        console.error("the vars file must hold string fileId and pageId");
        return 2;
    }
    const timestamp = Date.now();
    const urls = { old: opts.oldUrl, new: opts.newUrl };
    const results = [];
    for (const label of ADAPTERS_FOR_RUN) {
        results.push(...(await runAdapter(label, urls[label], token, vars, timestamp)));
    }
    printTable(results);
    const summary = summarizeSteps(results);
    console.log(
        `\n${summary.pass} PASS, ${summary.fail} FAIL of ${summary.total}` +
            (summary.contractMismatch ? `, contract mismatch on ${summary.contractMismatchCount} step(s)` : "")
    );
    return summary.fail > 0 ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 2;
        }
    );
}
