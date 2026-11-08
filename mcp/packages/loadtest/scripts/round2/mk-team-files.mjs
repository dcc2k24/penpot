// Creates one file per agent in its team's project and writes the vars JSON for the round-2 scripts.
// Agent i uses token line i (0-based) and team k = floor(i / 10) from the teams file written by setup-c1-teams.sh.
// Tokens are read and never printed or put in an error message.
//
// Usage: node scripts/round2/mk-team-files.mjs --help
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const GROUP_SIZE = 10;
const MAX_AGENTS = 50;
const PAUSE_MS = 150;
const DEFAULT_URL = "http://127.0.0.1:4415/mcp";
const DEFAULT_PREFIX = "mcp-r2-c1";

const USAGE = `Usage: node scripts/round2/mk-team-files.mjs --tokens <file> --teams <file> --out <file> [options]

Creates one file per agent in the agent's team project, then writes the vars JSON that the round-2 scripts read.
Agent i uses token line i (0-based) and team floor(i / 10) of the teams file.

Required:
  --tokens <file>   token file, one token per line; read, never printed
  --teams <file>    teams JSON written by setup-c1-teams.sh (c1-teams.json)
  --out <file>      vars JSON to write (its folder is created)

Options:
  --url <url>       MCP endpoint (default ${DEFAULT_URL})
  --count <n>       number of agents, 1 to ${MAX_AGENTS} (default ${MAX_AGENTS}); teams x ${GROUP_SIZE} must cover it
  --prefix <text>   file name prefix (default ${DEFAULT_PREFIX})
  --help            print this text`;

const VALUE_FLAGS = {
    "--tokens": "tokensFile",
    "--teams": "teamsFile",
    "--out": "out",
    "--url": "url",
    "--count": "count",
    "--prefix": "prefix",
};

/** A bad command line or a file that does not fit the options. Exit code 2. */
class UsageError extends Error {}

/**
 * Reads the command line. Throws on an unknown flag, a flag without a value, a bad number or a missing required option.
 *
 * @param argv - arguments after the script name
 * @returns the parsed options
 */
export function parseArgs(argv) {
    const opts = {
        tokensFile: undefined,
        teamsFile: undefined,
        out: undefined,
        url: DEFAULT_URL,
        count: MAX_AGENTS,
        prefix: DEFAULT_PREFIX,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help") {
            opts.help = true;
            continue;
        }
        const field = VALUE_FLAGS[arg];
        if (field === undefined) {
            throw new UsageError(`unknown argument ${arg}`);
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            throw new UsageError(`${arg} needs a value`);
        }
        i++;
        if (field === "count") {
            const value = Number(next);
            if (!Number.isInteger(value) || value < 1 || value > MAX_AGENTS) {
                throw new UsageError(`--count must be a whole number from 1 to ${MAX_AGENTS}, got "${next}"`);
            }
            opts.count = value;
        } else {
            opts[field] = next;
        }
    }
    if (opts.help) {
        return opts;
    }
    for (const [flag, field] of [
        ["--tokens", "tokensFile"],
        ["--teams", "teamsFile"],
        ["--out", "out"],
    ]) {
        if (!opts[field]) {
            throw new UsageError(`${flag} is required`);
        }
    }
    return opts;
}

/**
 * Waits the given number of milliseconds.
 *
 * @param ms - milliseconds to wait
 */
function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates the agent files and writes the vars JSON. Returns the exit code.
 *
 * @param opts - parsed options
 */
async function run(opts) {
    const { McpLoadClient } = await import("../../dist/McpLoadClient.js");
    const tokens = readFileSync(opts.tokensFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim());
    const data = JSON.parse(readFileSync(opts.teamsFile, "utf8"));
    const teams = Array.isArray(data.teams) ? data.teams : [];
    if (teams.length * GROUP_SIZE < opts.count) {
        const needed = Math.ceil(opts.count / GROUP_SIZE);
        throw new UsageError(`--count ${opts.count} needs ${needed} teams, the teams file has ${teams.length}`);
    }
    for (let i = 0; i < opts.count; i++) {
        if (!tokens[i]) {
            throw new Error(`token line ${i} is missing or empty in the token file`);
        }
    }

    const agentFileIds = [];
    const agentPageIds = [];
    const agentTeamIds = [];
    for (let i = 0; i < opts.count; i++) {
        const k = Math.floor(i / GROUP_SIZE);
        const team = teams[k];
        const client = new McpLoadClient();
        await client.connect(opts.url, tokens[i]);
        try {
            const created = await client.callTool("manage_files", {
                action: "create_file",
                projectId: team.projectId,
                name: `${opts.prefix}-t${k}-a${i}`,
            });
            if (!created.ok) {
                throw new Error(`create_file failed for agent ${i}: ${created.text || created.error}`);
            }
            const fileId = created.json?.id;
            if (typeof fileId !== "string") {
                throw new Error(`create_file for agent ${i} returned no file id`);
            }
            const outline = await client.callTool("get_file_outline", { fileId });
            if (!outline.ok) {
                throw new Error(`get_file_outline failed for agent ${i}: ${outline.text || outline.error}`);
            }
            const pageId = outline.json?.pages?.[0]?.id;
            if (typeof pageId !== "string") {
                throw new Error(`get_file_outline for agent ${i} returned no first page`);
            }
            agentFileIds.push(fileId);
            agentPageIds.push(pageId);
            agentTeamIds.push(team.teamId);
        } finally {
            await client.close();
        }
        if (i < opts.count - 1) {
            await pause(PAUSE_MS);
        }
    }

    const vars = {
        projectId: teams[0].projectId,
        fileId: agentFileIds[0],
        pageId: agentPageIds[0],
        agentFileIds,
        agentPageIds,
        agentTeamIds,
        teams,
    };
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(vars, null, 2) + "\n", "utf8");
    console.log(`created ${agentFileIds.length} agent files`);
    console.log(`vars written to ${opts.out}`);
    console.log(`projectId ${vars.projectId}`);
    console.log(`fileId ${vars.fileId}`);
    console.log(`pageId ${vars.pageId}`);
    return 0;
}

/**
 * Entry point. Returns the exit code: 0 on success, 1 on a runtime error, 2 on a usage error.
 *
 * @param argv - arguments after the script name
 */
export async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (error) {
        console.error(error.message);
        console.error(USAGE);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }
    try {
        return await run(opts);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(error.message);
            return 2;
        }
        console.error(`mk-team-files failed: ${error.message}`);
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`mk-team-files failed: ${error.message}`);
            process.exitCode = 1;
        }
    );
}
