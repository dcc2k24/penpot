// Measures how much storage one file uses per 1,000 operations, and what the next objects GC run would reclaim.
//
// Usage:
//   node scripts/round2/file-change-growth.mjs --file-id <uuid> [--vars <file>] [--tokens <file>] [--url <mcp url>]
//                                             [--run <scenario>] [--run-command <command>] [--operations <n>]
//                                             [--container <name>] [--database <name>] [--user <name>]
//                                             [--out <json file>] [--measure-only] [--dry-run]
//   node scripts/round2/file-change-growth.mjs --help
//
// A full run takes one measurement, runs the scenario (or the --run-command shell string), takes a second
// measurement and prints the growth per 1,000 operations. Every query goes through
// `docker exec <container> psql` as argv, never through a shell, so Windows quoting does not matter.
// Each query returns one row. All queries filter on one file_id.

import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CONTAINER = "penpot-penpot-postgres-1";
const DEFAULT_DATABASE = "penpot_mcpdev";
const DEFAULT_USER = "penpot";
const DEFAULT_RUN = "bulk-allowsplit";
// Operations written by a scenario, for the scenarios whose count is fixed.
const KNOWN_OPERATIONS = { "bulk-allowsplit": 5001 };
const PLACEHOLDER_FILE_ID = "00000000-0000-0000-0000-000000000000";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOADTEST_ENTRY = resolve(HERE, "..", "..", "dist", "index.js");

const OPTIONS = {
    "file-id": { type: "string" },
    vars: { type: "string" },
    tokens: { type: "string" },
    url: { type: "string" },
    run: { type: "string" },
    "run-command": { type: "string" },
    operations: { type: "string" },
    container: { type: "string" },
    database: { type: "string" },
    user: { type: "string" },
    out: { type: "string" },
    "measure-only": { type: "boolean" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean" },
};

const USAGE = `Usage: node scripts/round2/file-change-growth.mjs --file-id <uuid> [options]

Options:
  --file-id <uuid>        file to measure (or read fileId from --vars)
  --vars <file>          vars JSON written by setup; supplies fileId and is passed to the run
  --tokens <file>        tokens file, passed to the run (required for a full run)
  --url <mcp url>        MCP URL, passed to the run
  --run <scenario>       scenario started between the two measurements (default ${DEFAULT_RUN})
  --run-command <cmd>    shell command to run instead of the default loadtest run
  --operations <n>       operations written by the run (default ${KNOWN_OPERATIONS[DEFAULT_RUN]} for ${DEFAULT_RUN};
                         required with --measure-only)
  --container <name>     Postgres container (default ${DEFAULT_CONTAINER})
  --database <name>      database (default ${DEFAULT_DATABASE})
  --user <name>          database user (default ${DEFAULT_USER})
  --out <json file>      write the measurements and deltas as JSON (default: nothing written)
  --measure-only         take one measurement and print it; run nothing else
  --dry-run              print the SQL and the commands; run nothing, no docker call
  --help                 show this text
`;

const RETENTION_LINES = [
    "Objects GC runs daily (cron 0 0 0 * * ?) and hard-deletes rows whose deleted_at <= now:",
    "  file_change and file_data (all fragments and snapshot payloads).",
    "File GC runs daily at 02:00. It does not delete file_change, snapshot or file_data rows.",
    "  It only marks unused file_media_object, file_thumbnail and unused fragment file_data with deleted_at.",
    "MCP write revisions get deleted_at = write time + 1 hour. Snapshots get deleted_at = now + deletion delay (7 days by default).",
    "The MCP replay check reads file_change rows by file_id and session_id, so the replay window is at least",
    "  1 hour and up to about a day (until the daily objects GC removes the row).",
    "Does the one-hour replay window fit? Yes. GC removes a row only after its deleted_at, which is at least",
    "  one hour after the write, so the replay check still finds the row for that hour.",
    "The expiredOneHour group counts rows already past one hour of deleted_at. GC removes every row with",
    "  deleted_at <= now, so this group is a floor for what the next GC run reclaims.",
];

/**
 * Fails when the value is not a UUID. The check keeps the file id safe to put into SQL.
 * @param {string} value
 * @returns {string} the value, unchanged
 */
export function assertUuid(value) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new Error(`not a UUID: ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Builds the named measurement queries for one file. Each query is one SELECT statement that returns one row.
 * Bytes are sums of pg_column_size, so they are stored (possibly compressed) sizes, not raw sizes.
 * @param {string} fileId
 * @returns {Record<string, {sql: string, columns: string[]}>}
 */
export function buildSql(fileId) {
    const id = `'${assertUuid(fileId)}'`;
    return {
        fileChange: {
            columns: ["rows", "bytes"],
            sql:
                "SELECT count(*), coalesce(sum(coalesce(pg_column_size(data), 0) + coalesce(pg_column_size(changes), 0)), 0)" +
                ` FROM file_change WHERE file_id = ${id}`,
        },
        snapshots: {
            columns: ["rows", "bytes"],
            sql:
                "SELECT count(*), coalesce(sum(coalesce(pg_column_size(data), 0) + coalesce(pg_column_size(changes), 0)), 0)" +
                ` FROM file_change WHERE file_id = ${id} AND label IS NOT NULL`,
        },
        expiredOneHour: {
            columns: ["rows", "bytes"],
            sql:
                "SELECT count(*), coalesce(sum(coalesce(pg_column_size(data), 0) + coalesce(pg_column_size(changes), 0)), 0)" +
                ` FROM file_change WHERE file_id = ${id} AND deleted_at < now() - interval '1 hour'`,
        },
        fileData: {
            columns: ["rows", "bytes"],
            sql: `SELECT count(*), coalesce(sum(coalesce(pg_column_size(data), 0)), 0) FROM file_data WHERE file_id = ${id}`,
        },
        fileDataFragments: {
            columns: ["rows", "bytes"],
            sql:
                "SELECT count(*), coalesce(sum(coalesce(pg_column_size(data), 0)), 0)" +
                ` FROM file_data WHERE file_id = ${id} AND type = 'fragment'`,
        },
    };
}

/**
 * Parses one line of `psql -Atc` output with the given column names. Values must be integers.
 * @param {string} line
 * @param {string[]} columns
 * @returns {Record<string, number>}
 */
export function parsePsqlRow(line, columns) {
    if (typeof line !== "string") {
        throw new TypeError("psql output must be a string");
    }
    const text = line.trim();
    const cells = text.split("|");
    if (cells.length !== columns.length) {
        throw new Error(`expected ${columns.length} columns, got ${cells.length}: ${JSON.stringify(text)}`);
    }
    const row = {};
    columns.forEach((name, index) => {
        const raw = cells[index].trim();
        if (!/^-?\d+$/.test(raw)) {
            throw new Error(`column ${name} is not an integer: ${JSON.stringify(raw)}`);
        }
        row[name] = Number(raw);
    });
    return row;
}

/**
 * Growth between two measurements of one group ({rows, bytes}), per 1,000 operations.
 * @param {{rows: number, bytes: number}} before
 * @param {{rows: number, bytes: number}} after
 * @param {number} operations
 * @returns {{deltaRows: number, deltaBytes: number, rowsPer1000: number, bytesPer1000: number} | null}
 *   null when there are no operations (no division by zero)
 */
export function growthPer1000(before, after, operations) {
    if (!Number.isFinite(operations) || operations <= 0) {
        return null;
    }
    const deltaRows = after.rows - before.rows;
    const deltaBytes = after.bytes - before.bytes;
    return {
        deltaRows,
        deltaBytes,
        rowsPer1000: (deltaRows / operations) * 1000,
        bytesPer1000: (deltaBytes / operations) * 1000,
    };
}

/**
 * Joins two measurements into one result with the growth of every group.
 * @param {{fileId: string, operations: number, before: object, after: object}} input
 * @returns {object} result used by formatReport and the JSON output
 */
export function buildResult({ fileId, operations, before, after }) {
    const growth = {};
    for (const group of Object.keys(after)) {
        growth[group] = growthPer1000(before[group], after[group], operations);
    }
    return { fileId, operations, before, after, growth };
}

/**
 * Builds the plan for the run that the script starts between the two measurements.
 * @param {{run: string, tokens?: string, vars?: string, url?: string, runCommand?: string}} options
 * @returns {{kind: "shell", command: string} | {kind: "argv", file: string, args: string[]}}
 */
export function planRun({ run, tokens, vars, url, runCommand }) {
    if (runCommand !== undefined) {
        return { kind: "shell", command: runCommand };
    }
    const args = [LOADTEST_ENTRY, "run", run];
    if (tokens !== undefined) args.push("--tokens", tokens);
    if (vars !== undefined) args.push("--vars", vars);
    if (url !== undefined) args.push("--url", url);
    return { kind: "argv", file: process.execPath, args };
}

/**
 * Builds the docker argv for one query. Used by the real run and by --dry-run.
 * @param {{container: string, database: string, user: string}} target
 * @param {string} sql
 * @returns {string[]}
 */
export function dockerArgs(target, sql) {
    return ["exec", target.container, "psql", "-U", target.user, "-d", target.database, "-Atc", sql];
}

/**
 * Formats the result as a plain-text report: before and after, deltas, growth per 1,000 operations and retention.
 * @param {ReturnType<typeof buildResult>} result
 * @returns {string}
 */
export function formatReport(result) {
    const lines = [];
    lines.push(`File ${result.fileId}`);
    lines.push(`Operations written by the run: ${result.operations ?? "not known"}`);
    lines.push("Columns: bytes = sum of pg_column_size (file_change: data + changes; file_data: data).");
    lines.push("Scope: every count filters on this file_id; rows of other files are not counted.");
    lines.push("");
    lines.push(
        [
            "group",
            "rows before",
            "rows after",
            "rows delta",
            "rows per 1,000",
            "bytes before",
            "bytes after",
            "bytes delta",
            "bytes per 1,000",
        ]
            .map((cell, index) => (index === 0 ? cell.padEnd(20) : cell.padStart(14)))
            .join("")
    );
    for (const group of Object.keys(result.after)) {
        const before = result.before[group];
        const after = result.after[group];
        const growth = result.growth[group];
        const cells = [
            String(before.rows),
            String(after.rows),
            String(after.rows - before.rows),
            growth ? growth.rowsPer1000.toFixed(2) : "n/a",
            String(before.bytes),
            String(after.bytes),
            String(after.bytes - before.bytes),
            growth ? growth.bytesPer1000.toFixed(2) : "n/a",
        ];
        lines.push(group.padEnd(20) + cells.map((cell) => cell.padStart(14)).join(""));
    }
    if (result.growth && Object.values(result.growth).every((value) => value === null)) {
        lines.push("");
        lines.push("No operations given: growth per 1,000 operations is not computed.");
    }
    lines.push("");
    lines.push(formatRetention());
    return lines.join("\n") + "\n";
}

/**
 * Formats the retention block printed with every report and with --dry-run.
 * @returns {string}
 */
export function formatRetention() {
    return ["Retention", ...RETENTION_LINES.map((line) => `  ${line}`)].join("\n");
}

/**
 * Takes one measurement: runs every named query through the given runner and parses each row.
 * @param {Record<string, {sql: string, columns: string[]}>} queries
 * @param {(sql: string) => Promise<string>} runSql
 * @returns {Promise<Record<string, {rows: number, bytes: number}>>}
 */
export async function takeMeasurement(queries, runSql) {
    const measurement = {};
    for (const [group, query] of Object.entries(queries)) {
        const stdout = await runSql(query.sql);
        measurement[group] = parsePsqlRow(stdout, query.columns);
    }
    return measurement;
}

function runPsqlWithDocker(target, sql) {
    return new Promise((resolvePromise, reject) => {
        execFile(
            "docker",
            dockerArgs(target, sql),
            { windowsHide: true, maxBuffer: 1 << 20 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`docker exec psql failed: ${String(stderr).trim() || error.message}`));
                } else {
                    resolvePromise(String(stdout));
                }
            }
        );
    });
}

function runScenario(plan) {
    return new Promise((resolvePromise, reject) => {
        const child =
            plan.kind === "shell"
                ? spawn(plan.command, { shell: true, stdio: "inherit" })
                : spawn(plan.file, plan.args, { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) {
                resolvePromise();
            } else {
                reject(new Error(`run exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
            }
        });
    });
}

async function readFileId(varsPath) {
    const vars = JSON.parse(await readFile(varsPath, "utf8"));
    if (typeof vars.fileId !== "string") {
        throw new Error(`${varsPath} has no fileId`);
    }
    return vars.fileId;
}

function parsePositive(value, flag) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return number;
}

async function main(argv) {
    const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
    if (values.help) {
        process.stdout.write(USAGE);
        return 0;
    }

    const run = values.run ?? DEFAULT_RUN;
    const dryRun = values["dry-run"] === true;
    const measureOnly = values["measure-only"] === true;
    let fileId = values["file-id"];
    if (fileId === undefined && values.vars !== undefined) {
        fileId = await readFileId(values.vars);
    }
    if (fileId === undefined) {
        if (!dryRun) throw new Error("give --file-id <uuid> or --vars <file> with a fileId");
        fileId = PLACEHOLDER_FILE_ID;
    }
    assertUuid(fileId);

    let operations;
    if (values.operations !== undefined) {
        operations = parsePositive(values.operations, "--operations");
    } else if (values["run-command"] === undefined && KNOWN_OPERATIONS[run] !== undefined) {
        operations = KNOWN_OPERATIONS[run];
    }

    const target = {
        container: values.container ?? DEFAULT_CONTAINER,
        database: values.database ?? DEFAULT_DATABASE,
        user: values.user ?? DEFAULT_USER,
    };
    const queries = buildSql(fileId);
    const plan = planRun({
        run,
        tokens: values.tokens,
        vars: values.vars,
        url: values.url,
        runCommand: values["run-command"],
    });

    if (dryRun) {
        const out = [];
        out.push(`File ${fileId}`);
        out.push(`Operations: ${operations ?? "not known (give --operations)"}`);
        out.push("");
        out.push("Queries (each run as one docker exec call, argv not shell):");
        for (const [group, query] of Object.entries(queries)) {
            out.push(`  ${group}:`);
            out.push(
                `    docker ${dockerArgs(target, query.sql)
                    .map((arg) => JSON.stringify(arg))
                    .join(" ")}`
            );
        }
        out.push("");
        out.push("Run between the two measurements:");
        out.push(
            plan.kind === "shell"
                ? `  shell: ${plan.command}`
                : `  ${[process.execPath, ...plan.args].map((arg) => JSON.stringify(arg)).join(" ")}`
        );
        out.push("");
        out.push(formatRetention());
        process.stdout.write(out.join("\n") + "\n");
        return 0;
    }

    const runSql = (sql) => runPsqlWithDocker(target, sql);

    if (measureOnly) {
        if (operations === undefined) throw new Error("--measure-only needs --operations <n>");
        const measurement = await takeMeasurement(queries, runSql);
        const output = { fileId, operations, measurement };
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
        if (values.out !== undefined) await writeFile(values.out, JSON.stringify(output, null, 2) + "\n");
        return 0;
    }

    if (plan.kind === "argv" && values.tokens === undefined) {
        throw new Error("give --tokens <file> for the run (or use --measure-only or --dry-run)");
    }
    if (operations === undefined) {
        throw new Error("give --operations <n>: it cannot be derived for this run");
    }

    const before = await takeMeasurement(queries, runSql);
    await runScenario(plan);
    const after = await takeMeasurement(queries, runSql);
    const result = buildResult({ fileId, operations, before, after });
    process.stdout.write(formatReport(result));
    if (values.out !== undefined) {
        await writeFile(
            values.out,
            JSON.stringify({ ...result, run: plan.kind === "shell" ? plan.command : run }, null, 2) + "\n"
        );
    }
    return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    );
}
