import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CommandRunner, type PgCounters, PgStats, type PgStatsTarget } from "./PgStats.js";

const TARGET: PgStatsTarget = { container: "penpot-postgres", database: "penpot", user: "penpot" };
const FILE_ID = "0b6f7c1e-3a9d-4f5e-8c2b-1d2e3f4a5b6c";

/**
 * Builds a runner that answers the PgStats queries with fixed output. A query that matches no rule fails the test.
 *
 * @param statements - output of the pg_stat_statements query, or an Error to make it fail
 * @param calls - receives every command the runner got
 */
function fakeRunner(statements: string | Error, calls: string[][] = []): CommandRunner {
    return async (file, args) => {
        calls.push([file, ...args]);
        const sql = args[args.length - 1];
        if (sql.includes("pg_stat_statements")) {
            if (statements instanceof Error) {
                throw statements;
            }
            return statements;
        }
        if (sql.includes("pg_stat_database")) {
            return "40|900|30\n";
        }
        if (sql.includes("file_change")) {
            return "7|11\n";
        }
        if (sql.includes("pg_stat_user_tables")) {
            return "123\n";
        }
        throw new Error(`unexpected query: ${sql}`);
    };
}

const BEFORE: PgCounters = {
    statements: 100,
    transactions: 10,
    tableScans: 50,
    rowsRead: 500,
    rowsWritten: 20,
    fileChangeSeqScans: 2,
    fileChangeIdxScans: 3,
};

const AFTER: PgCounters = {
    statements: 350,
    transactions: 25,
    tableScans: 80,
    rowsRead: 1500,
    rowsWritten: 90,
    fileChangeSeqScans: 4,
    fileChangeIdxScans: 9,
};

describe("PgStats.parseTarget", () => {
    test("reads the container and the database, and the user defaults to penpot", () => {
        assert.deepEqual(PgStats.parseTarget("docker:penpot-postgres:penpot"), {
            container: "penpot-postgres",
            database: "penpot",
            user: "penpot",
        });
    });

    test("reads an explicit user", () => {
        assert.deepEqual(PgStats.parseTarget("docker:pg:penpot_test:admin"), {
            container: "pg",
            database: "penpot_test",
            user: "admin",
        });
    });

    test("rejects every other form", () => {
        for (const text of [
            "",
            "postgres:pg:penpot",
            "docker:pg",
            "docker::penpot",
            "docker:pg:penpot:a:b",
            "docker:p g:db",
        ]) {
            assert.throws(() => PgStats.parseTarget(text), /invalid Postgres target/, text);
        }
    });
});

describe("PgStats.sample", () => {
    test("runs every query through docker exec psql and reads the counters", async () => {
        const calls: string[][] = [];
        const counters = await new PgStats(TARGET, fakeRunner("500\n", calls)).sample();
        assert.deepEqual(counters, {
            statements: 500,
            transactions: 40,
            tableScans: 123,
            rowsRead: 900,
            rowsWritten: 30,
            fileChangeSeqScans: 7,
            fileChangeIdxScans: 11,
        });
        assert.equal(calls.length, 4);
        for (const [file, ...args] of calls) {
            assert.equal(file, "docker");
            assert.deepEqual(args.slice(0, 10), [
                "exec",
                "penpot-postgres",
                "psql",
                "-U",
                "penpot",
                "-d",
                "penpot",
                "-At",
                "-F",
                "|",
            ]);
            assert.equal(args[10], "-c");
        }
    });

    test("leaves statements out when pg_stat_statements fails", async () => {
        const counters = await new PgStats(TARGET, fakeRunner(new Error("relation does not exist"))).sample();
        assert.equal("statements" in counters, false);
        assert.equal(counters.transactions, 40);
        assert.equal(counters.fileChangeIdxScans, 11);
    });

    test("reads zero file_change scans when the table has no row", async () => {
        const runner: CommandRunner = async (_file, args) => {
            const sql = args[args.length - 1];
            if (sql.includes("file_change")) {
                return "";
            }
            return sql.includes("pg_stat_database") ? "1|2|3\n" : "9\n";
        };
        const counters = await new PgStats(TARGET, runner).sample();
        assert.equal(counters.fileChangeSeqScans, 0);
        assert.equal(counters.fileChangeIdxScans, 0);
    });

    test("throws a clear error when the database counters have an unexpected shape", async () => {
        const runner: CommandRunner = async (_file, args) => {
            const sql = args[args.length - 1];
            return sql.includes("pg_stat_database") ? "1|2\n" : "0\n";
        };
        await assert.rejects(new PgStats(TARGET, runner).sample(), /unexpected output for pg_stat_database/);
    });
});

describe("PgStats.delta", () => {
    test("subtracts the first sample from the second, field by field", () => {
        assert.deepEqual(PgStats.delta(BEFORE, AFTER), {
            statements: 250,
            transactions: 15,
            tableScans: 30,
            rowsRead: 1000,
            rowsWritten: 70,
            fileChangeSeqScans: 2,
            fileChangeIdxScans: 6,
        });
    });

    test("leaves statements out when one sample does not have it", () => {
        const { statements: _unused, ...withoutStatements } = AFTER;
        const change = PgStats.delta(BEFORE, withoutStatements);
        assert.equal("statements" in change, false);
        assert.equal(change.transactions, 15);
    });
});

describe("PgStats.fileDataBytes", () => {
    test("rejects a value that is not a UUID before it reaches any SQL", async () => {
        const calls: string[][] = [];
        const stats = new PgStats(TARGET, fakeRunner("1", calls));
        await assert.rejects(stats.fileDataBytes("abc'; drop table file; --"), /is not a UUID/);
        assert.equal(calls.length, 0);
    });

    test("sums the data pages and the legacy column in one query", async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (...command) => {
            calls.push([command[0], ...command[1]]);
            return "4096\n";
        };
        assert.equal(await new PgStats(TARGET, runner).fileDataBytes(FILE_ID), 4096);
        assert.equal(calls.length, 1);
        const sql = calls[0][calls[0].length - 1];
        assert.match(sql, new RegExp(`file_id = '${FILE_ID}' and deleted_at is null`));
        assert.match(sql, new RegExp(`from file where id = '${FILE_ID}'`));
    });

    test("retries without the legacy column term when the first query fails", async () => {
        const sqls: string[] = [];
        const runner: CommandRunner = async (_file, args) => {
            const sql = args[args.length - 1];
            sqls.push(sql);
            if (sql.includes("from file where id")) {
                throw new Error('column "data" does not exist');
            }
            return "2048\n";
        };
        assert.equal(await new PgStats(TARGET, runner).fileDataBytes(FILE_ID), 2048);
        assert.equal(sqls.length, 2);
        assert.equal(sqls[1].includes("from file where id"), false);
    });

    test("returns undefined when both queries fail", async () => {
        const runner: CommandRunner = async () => {
            throw new Error("docker is not running");
        };
        assert.equal(await new PgStats(TARGET, runner).fileDataBytes(FILE_ID), undefined);
    });
});
