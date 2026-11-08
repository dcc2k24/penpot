// Unit tests for the pure helpers of file-change-growth.mjs. No docker, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assertUuid,
    buildResult,
    buildSql,
    dockerArgs,
    formatReport,
    growthPer1000,
    parsePsqlRow,
    planRun,
} from "./file-change-growth.mjs";

const FILE_ID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
const COLUMNS = ["rows", "bytes"];

test("parsePsqlRow reads a pipe-separated row into named columns", () => {
    assert.deepEqual(parsePsqlRow("12|3456\n", COLUMNS), { rows: 12, bytes: 3456 });
});

test("parsePsqlRow accepts CRLF line endings and zero values", () => {
    assert.deepEqual(parsePsqlRow("0|0\r\n", COLUMNS), { rows: 0, bytes: 0 });
});

test("parsePsqlRow accepts a single column", () => {
    assert.deepEqual(parsePsqlRow("7", ["rows"]), { rows: 7 });
});

test("parsePsqlRow rejects a row with the wrong number of columns", () => {
    assert.throws(() => parsePsqlRow("12", COLUMNS), /expected 2 columns/);
    assert.throws(() => parsePsqlRow("1|2|3", COLUMNS), /expected 2 columns/);
});

test("parsePsqlRow rejects values that are not integers", () => {
    assert.throws(() => parsePsqlRow("12|", COLUMNS), /not an integer/);
    assert.throws(() => parsePsqlRow("12|1.5", COLUMNS), /not an integer/);
    assert.throws(() => parsePsqlRow("x|1", COLUMNS), /not an integer/);
});

test("parsePsqlRow rejects non-string input", () => {
    assert.throws(() => parsePsqlRow(undefined, COLUMNS), TypeError);
});

test("growthPer1000 computes the deltas and the growth per 1,000 operations", () => {
    const growth = growthPer1000({ rows: 10, bytes: 1000 }, { rows: 5010, bytes: 501000 }, 5001);
    assert.equal(growth.deltaRows, 5000);
    assert.equal(growth.deltaBytes, 500000);
    assert.ok(Math.abs(growth.rowsPer1000 - (5000 / 5001) * 1000) < 1e-9);
    assert.ok(Math.abs(growth.bytesPer1000 - (500000 / 5001) * 1000) < 1e-9);
});

test("growthPer1000 gives exact figures for round numbers", () => {
    const growth = growthPer1000({ rows: 0, bytes: 0 }, { rows: 2000, bytes: 4000 }, 1000);
    assert.equal(growth.rowsPer1000, 2000);
    assert.equal(growth.bytesPer1000, 4000);
});

test("growthPer1000 reports a negative delta when GC removed rows", () => {
    const growth = growthPer1000({ rows: 100, bytes: 900 }, { rows: 40, bytes: 300 }, 1000);
    assert.equal(growth.deltaRows, -60);
    assert.equal(growth.deltaBytes, -600);
});

test("growthPer1000 returns null for zero operations instead of dividing by zero", () => {
    assert.equal(growthPer1000({ rows: 1, bytes: 1 }, { rows: 2, bytes: 2 }, 0), null);
});

test("growthPer1000 returns null for negative or non-finite operations", () => {
    assert.equal(growthPer1000({ rows: 1, bytes: 1 }, { rows: 2, bytes: 2 }, -5), null);
    assert.equal(growthPer1000({ rows: 1, bytes: 1 }, { rows: 2, bytes: 2 }, Number.NaN), null);
    assert.equal(growthPer1000({ rows: 1, bytes: 1 }, { rows: 2, bytes: 2 }, Infinity), null);
});

test("buildSql names the expected groups and every query carries the file id", () => {
    const queries = buildSql(FILE_ID);
    assert.deepEqual(Object.keys(queries), [
        "fileChange",
        "snapshots",
        "expiredOneHour",
        "fileData",
        "fileDataFragments",
    ]);
    for (const [group, query] of Object.entries(queries)) {
        assert.ok(query.sql.includes(`'${FILE_ID}'`), `${group} lacks the file id`);
        assert.ok(/file_id = '/.test(query.sql), `${group} is not file-scoped`);
        assert.deepEqual(query.columns, COLUMNS);
    }
});

test("buildSql queries are single statements with no semicolon", () => {
    for (const [group, query] of Object.entries(buildSql(FILE_ID))) {
        assert.ok(!query.sql.includes(";"), `${group} contains a semicolon`);
        assert.ok(query.sql.startsWith("SELECT "), `${group} is not a SELECT`);
    }
});

test("buildSql reads the real tables and columns", () => {
    const queries = buildSql(FILE_ID);
    assert.ok(queries.fileChange.sql.includes("FROM file_change"));
    assert.ok(queries.snapshots.sql.includes("label IS NOT NULL"));
    assert.ok(queries.expiredOneHour.sql.includes("deleted_at < now() - interval '1 hour'"));
    assert.ok(queries.fileData.sql.includes("FROM file_data"));
    assert.ok(queries.fileDataFragments.sql.includes("type = 'fragment'"));
});

test("buildSql rejects a file id that is not a UUID", () => {
    assert.throws(() => buildSql("not-a-uuid"), /not a UUID/);
    assert.throws(() => buildSql(`${FILE_ID}' OR '1'='1`), /not a UUID/);
});

test("assertUuid accepts upper and lower case UUIDs", () => {
    assert.equal(assertUuid(FILE_ID.toUpperCase()), FILE_ID.toUpperCase());
});

test("dockerArgs builds argv with the SQL as one element and no shell", () => {
    const args = dockerArgs(
        { container: "c1", database: "db1", user: "u1" },
        `SELECT 1 FROM file_change WHERE file_id = '${FILE_ID}'`
    );
    assert.deepEqual(args.slice(0, 7), ["exec", "c1", "psql", "-U", "u1", "-d", "db1"]);
    assert.equal(args[7], "-Atc");
    assert.equal(args.length, 9);
});

test("planRun builds an argv run with the pass-through options", () => {
    const plan = planRun({ run: "bulk-allowsplit", tokens: "t.txt", vars: "v.json", url: "http://x/mcp" });
    assert.equal(plan.kind, "argv");
    assert.deepEqual(plan.args.slice(1), [
        "run",
        "bulk-allowsplit",
        "--tokens",
        "t.txt",
        "--vars",
        "v.json",
        "--url",
        "http://x/mcp",
    ]);
});

test("planRun uses the shell string when a run command is given", () => {
    assert.deepEqual(planRun({ run: "bulk-allowsplit", runCommand: "echo hi" }), {
        kind: "shell",
        command: "echo hi",
    });
});

test("buildResult computes growth for every group", () => {
    const before = { fileChange: { rows: 1, bytes: 10 }, snapshots: { rows: 0, bytes: 0 } };
    const after = { fileChange: { rows: 1001, bytes: 2010 }, snapshots: { rows: 0, bytes: 0 } };
    const result = buildResult({ fileId: FILE_ID, operations: 1000, before, after });
    assert.equal(result.growth.fileChange.rowsPer1000, 1000);
    assert.equal(result.growth.fileChange.bytesPer1000, 2000);
    assert.equal(result.growth.snapshots.deltaRows, 0);
});

test("buildResult gives null growth when there are no operations", () => {
    const before = { fileChange: { rows: 1, bytes: 1 } };
    const after = { fileChange: { rows: 2, bytes: 2 } };
    const result = buildResult({ fileId: FILE_ID, operations: 0, before, after });
    assert.equal(result.growth.fileChange, null);
});

test("formatReport prints the file, the groups, the retention block and no undefined values", () => {
    const before = { fileChange: { rows: 1, bytes: 10 } };
    const after = { fileChange: { rows: 1001, bytes: 2010 } };
    const text = formatReport(buildResult({ fileId: FILE_ID, operations: 1000, before, after }));
    assert.ok(text.includes(FILE_ID));
    assert.ok(text.includes("fileChange"));
    assert.ok(text.includes("1000.00"));
    assert.ok(text.includes("Retention"));
    assert.ok(text.includes("replay window"));
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("NaN"));
});

test("formatReport shows n/a and a note when growth is null", () => {
    const before = { fileChange: { rows: 1, bytes: 1 } };
    const after = { fileChange: { rows: 2, bytes: 2 } };
    const text = formatReport(buildResult({ fileId: FILE_ID, operations: 0, before, after }));
    assert.ok(text.includes("n/a"));
    assert.ok(text.includes("not computed"));
});
