// Follows one MCP tool call by its request id through the adapter log, the backend log and the audit log.
//
// The adapter makes a new request id for every tool call and sends it to the backend as X-Request-Id. The adapter
// logs it on the "Tool execution ... request=<id>" lines, the backend logs it as request-id on its "mcp-tool"
// line, and the backend stores it in the audit row of a call (context, and props for writes; key ~:request-id).
//
// Usage:
//   node scripts/correlate-request-id.mjs [--request-id <uuid>] [--tool <name>] [--call]
//
// Options and environment:
//   --request-id <uuid>        follow this id; by default the newest id the adapter log has for --tool
//   --tool <name>              tool whose newest call is followed (default get_file_outline)
//   --call                     first make one get_file_outline call through the adapter; needs
//                              PENPOT_MCP_TOKEN_FILE (a file with one MCP key, never printed) and
//                              PENPOT_MCP_FILE_ID; PENPOT_MCP_URL defaults to http://127.0.0.1:4405/mcp
//   --adapter-log <file>       default: mcp-backend-mode.log at the repository root
//   --backend-exec <c>:<path>  backend log file inside container <c> (default penpot-tc:/tmp/backend-dev.log, the
//                              dev backend that serves the MCP calls on port 6061)
//   --backend-docker <name>    docker logs of a container, such as the penpot stack backend
//   --backend-log <file>       backend log in a file on this machine
//   PENPOT_CORRELATE_DATABASE_URL  a postgresql:// URL; when set, the audit_log row is looked up with psql
//   PENPOT_CORRELATE_PSQL_CONTAINER  or a container whose psql is used instead (docker exec), with
//                              PENPOT_CORRELATE_PSQL_USER (default penpot) and PENPOT_CORRELATE_PSQL_DB
//                              (default penpot_mcpdev, the database of the dev stack)
//
// Prints one line per source with the matching lines, and exits 0 only when every source that was read has the
// id. Exit 2 is a usage error. The script never changes data: the only write is the one optional tool call.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ANSI colour codes that the adapter writes to its console log.
const ANSI = /\u001b\[[0-9;]*m/g;

/** Reads the options of the command line. */
export function parseArgs(argv) {
    const options = {
        requestId: undefined,
        tool: "get_file_outline",
        call: false,
        adapterLog: resolve(repoRoot, "mcp-backend-mode.log"),
        backend: { kind: "exec", container: "penpot-tc", path: "/tmp/backend-dev.log" },
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (argv[i + 1] === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            i += 1;
            return argv[i];
        };
        switch (arg) {
            case "--request-id":
                options.requestId = next();
                break;
            case "--tool":
                options.tool = next();
                break;
            case "--call":
                options.call = true;
                break;
            case "--adapter-log":
                options.adapterLog = resolve(next());
                break;
            case "--backend-exec": {
                const value = next();
                const cut = value.indexOf(":");
                if (cut <= 0 || cut === value.length - 1) {
                    throw new Error("--backend-exec needs <container>:<path>");
                }
                options.backend = { kind: "exec", container: value.slice(0, cut), path: value.slice(cut + 1) };
                break;
            }
            case "--backend-docker":
                options.backend = { kind: "docker", container: next() };
                break;
            case "--backend-log":
                options.backend = { kind: "file", path: resolve(next()) };
                break;
            default:
                throw new Error(`unknown argument ${arg}`);
        }
    }
    if (options.requestId !== undefined && !UUID.test(options.requestId)) {
        throw new Error("--request-id must be a UUID");
    }
    return options;
}

/** Returns the lines of a text with the colour codes removed. */
export function linesOf(text) {
    return text.replace(ANSI, "").split(/\r?\n/);
}

/**
 * Finds the newest request id that the adapter logged for a tool.
 *
 * @param {string[]} lines - adapter log lines, oldest first
 * @param {string} tool - tool name
 * @returns {string | undefined}
 */
export function newestRequestId(lines, tool) {
    const pattern = new RegExp(
        `Tool execution #\\d+ starting: ${escapeRegExp(tool)} request=(${UUID.source.slice(1, -1)})`,
        "i"
    );
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = pattern.exec(lines[i]);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Makes one get_file_outline call through the adapter, with the MCP key read from a file.
 *
 * @returns {Promise<void>}
 */
async function makeCall() {
    const tokenFile = process.env.PENPOT_MCP_TOKEN_FILE;
    const fileId = process.env.PENPOT_MCP_FILE_ID;
    const url = process.env.PENPOT_MCP_URL ?? "http://127.0.0.1:4405/mcp";
    if (!tokenFile || !fileId) {
        throw new Error("--call needs PENPOT_MCP_TOKEN_FILE and PENPOT_MCP_FILE_ID");
    }
    const clientModule = pathToFileURL(resolve(here, "../dist/McpLoadClient.js")).href;
    const { McpLoadClient } = await import(clientModule);
    const token = readFileSync(tokenFile, "utf8").trim();
    const client = new McpLoadClient();
    await client.connect(url, token);
    const result = await client.callTool("get_file_outline", { fileId });
    console.log(`call: get_file_outline ok=${result.ok && !result.isError}`);
    await client.close?.();
}

/** Reads the backend log from the source that the options name. */
function readBackendLog(options) {
    const source = options.backend;
    if (source.kind === "file") {
        if (!existsSync(source.path)) {
            return { ok: false, text: "", note: `${source.path} does not exist` };
        }
        return { ok: true, text: readFileSync(source.path, "utf8"), note: source.path };
    }
    const isExec = source.kind === "exec";
    const args = isExec ? ["exec", source.container, "cat", source.path] : ["logs", source.container];
    const note = isExec ? `${source.container}:${source.path}` : `docker logs ${source.container}`;
    const run = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (run.status !== 0) {
        return { ok: false, text: "", note: `${note}: ${(run.stderr ?? "").trim()}` };
    }
    // docker logs writes the container output to both stdout and stderr; both are the backend log
    return { ok: true, text: `${run.stdout ?? ""}${run.stderr ?? ""}`, note };
}

/**
 * Looks the request id up in the audit log through psql.
 *
 * @param {string} requestId - the id
 * @returns {{status: "found" | "missing" | "skipped" | "error", detail: string}}
 */
function auditLookup(requestId) {
    const url = process.env.PENPOT_CORRELATE_DATABASE_URL;
    const container = process.env.PENPOT_CORRELATE_PSQL_CONTAINER;
    if (!url && !container) {
        return { status: "skipped", detail: "set PENPOT_CORRELATE_DATABASE_URL or PENPOT_CORRELATE_PSQL_CONTAINER" };
    }
    // psql quotes the variable itself (:'rid'), so the id is never spliced into the SQL text
    const sql =
        "select count(*) as rows, min(created_at) as first_at, min(name) as name " +
        // the props and the context are transit-encoded JSON, so the key is "~:request-id"; reads keep the id in the
        // context only (contract section 8.2)
        "from audit_log where props->>'~:request-id' = :'rid' or context->>'~:request-id' = :'rid';";
    const psqlArgs = ["-v", `rid=${requestId}`, "-tA", "-F", "|", "-X", "-f", "-"];
    const run = container
        ? spawnSync(
              "docker",
              [
                  "exec",
                  "-i",
                  container,
                  "psql",
                  "-U",
                  process.env.PENPOT_CORRELATE_PSQL_USER ?? "penpot",
                  "-d",
                  process.env.PENPOT_CORRELATE_PSQL_DB ?? "penpot_mcpdev",
                  ...psqlArgs,
              ],
              { input: sql, encoding: "utf8" }
          )
        : spawnSync("psql", [url, ...psqlArgs], { input: sql, encoding: "utf8" });
    if (run.error) {
        return { status: "error", detail: `psql: ${run.error.message}` };
    }
    if (run.status !== 0) {
        return { status: "error", detail: (run.stderr ?? "").trim() || `psql exited ${run.status}` };
    }
    const [rows, firstAt, name] = (run.stdout ?? "").trim().split("|");
    if (Number(rows) === 0) {
        return { status: "missing", detail: "no audit row" };
    }
    return { status: "found", detail: `${rows} row(s), first at ${firstAt}, name ${name}` };
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`usage error: ${error.message}`);
        console.error("usage: node scripts/correlate-request-id.mjs [--request-id <uuid>] [--tool <name>] [--call]");
        process.exit(2);
    }

    if (options.call) {
        try {
            await makeCall();
        } catch (error) {
            console.error(`call failed: ${error.message}`);
            process.exit(1);
        }
    }

    if (!existsSync(options.adapterLog)) {
        console.log(`adapter log: ${options.adapterLog} does not exist`);
        process.exit(1);
    }
    const adapterLines = linesOf(readFileSync(options.adapterLog, "utf8"));
    const requestId = options.requestId ?? newestRequestId(adapterLines, options.tool);
    if (requestId === undefined) {
        console.log(`no "${options.tool}" call in ${options.adapterLog}; nothing to follow`);
        console.log("pass --request-id, or make a call with --call");
        process.exit(1);
    }
    console.log(`request id: ${requestId}`);

    const adapterMatches = adapterLines.filter((line) => line.includes(`request=${requestId}`));
    const adapterOk = adapterMatches.length > 0;
    console.log(`adapter (${options.adapterLog}): ${adapterMatches.length} line(s)`);
    for (const line of adapterMatches.slice(0, 3)) {
        console.log(`  ${line.slice(0, 220)}`);
    }

    const backend = readBackendLog(options);
    let backendOk = false;
    if (!backend.ok) {
        console.log(`backend: not read; ${backend.note}`);
    } else {
        const backendLines = linesOf(backend.text).filter((line) => line.includes(requestId));
        backendOk = backendLines.length > 0;
        console.log(`backend (${backend.note}): ${backendLines.length} line(s)`);
        for (const line of backendLines.slice(0, 3)) {
            console.log(`  ${line.slice(0, 220)}`);
        }
    }

    const audit = auditLookup(requestId);
    console.log(`audit: ${audit.status}${audit.detail ? ` (${audit.detail})` : ""}`);

    const missing = [];
    if (!adapterOk) missing.push("adapter");
    if (!backend.ok || !backendOk) missing.push("backend");
    if (audit.status === "missing" || audit.status === "error") missing.push("audit");
    if (missing.length === 0) {
        const auditNote = audit.status === "found" ? " and the audit row" : " (audit not checked)";
        console.log(`OK: the request id is in the adapter log and the backend log${auditNote}`);
        process.exit(0);
    }
    console.log(`MISSING: ${missing.join(", ")}`);
    process.exit(1);
}

if (process.argv[1]?.endsWith("correlate-request-id.mjs")) {
    await main();
}
