import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Runs a program with an argument list and resolves with its standard output. No shell is involved. */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

/** Promise form of execFile, shared by the default runner. */
const execFileAsync = promisify(execFile);

/**
 * Runs a program without a shell, with a 30 second timeout and a 10 MB output limit. Rejects on a non-zero exit, and
 * the message then carries the stderr text.
 */
export const defaultRunner: CommandRunner = async (file, args) => {
    try {
        const { stdout } = await execFileAsync(file, args, {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        return stdout;
    } catch (error) {
        const failure = error as Error & { stderr?: string };
        const detail = failure.stderr?.trim() || failure.message;
        throw new Error(`${file} failed: ${detail}`);
    }
};

/** Where the Postgres database of a Penpot stack runs, reached through docker exec. */
export interface PgStatsTarget {
    /** Name of the Docker container that runs psql, for example penpot-postgres. */
    container: string;
    /** Database that holds the Penpot tables. */
    database: string;
    /** Database user for psql. */
    user: string;
}

/** Cumulative Postgres counters at one moment. Use PgStats.delta to get the change over a run. */
export interface PgCounters {
    /** Statements counted by pg_stat_statements, or undefined when that extension is not loaded. */
    statements?: number;
    /** Committed and rolled back transactions of the database. */
    transactions: number;
    /** Sequential and index scans over all user tables. */
    tableScans: number;
    /** Rows returned and fetched by the database. */
    rowsRead: number;
    /** Rows inserted, updated and deleted in the database. */
    rowsWritten: number;
    /** Sequential scans of the file_change table. */
    fileChangeSeqScans: number;
    /** Index scans of the file_change table. */
    fileChangeIdxScans: number;
}

/** Counts the statements of all sessions of the current database. */
const SQL_STATEMENTS =
    "select coalesce(sum(s.calls),0) from pg_stat_statements s join pg_database d on d.oid = s.dbid where d.datname = current_database()";

/** Transactions, rows read and rows written of the current database. */
const SQL_DATABASE =
    "select xact_commit + xact_rollback, tup_returned + tup_fetched, tup_inserted + tup_updated + tup_deleted from pg_stat_database where datname = current_database()";

/** Scans of all user tables, sequential and index together. */
const SQL_TABLE_SCANS = "select coalesce(sum(seq_scan),0) + coalesce(sum(idx_scan),0) from pg_stat_user_tables";

/** Scans of the file_change table. Returns no row when the table is missing. */
const SQL_FILE_CHANGE =
    "select coalesce(seq_scan,0), coalesce(idx_scan,0) from pg_stat_user_tables where relname = 'file_change'";

/** Matches a UUID in any letter case. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Reads Postgres counters through `docker exec <container> psql`, and the stored size of a file.
 */
export class PgStats {
    /**
     * @param target - container, database and user of the stack
     * @param run - command runner, replaceable in tests
     */
    constructor(
        private readonly target: PgStatsTarget,
        private readonly run: CommandRunner = defaultRunner
    ) {}

    /**
     * Parses the option form docker:<container>:<database> with an optional :<user> suffix. The user defaults to penpot.
     *
     * @param text - value of the option, for example docker:penpot-postgres:penpot
     * @throws Error when the text does not have that form
     */
    static parseTarget(text: string): PgStatsTarget {
        const match = /^docker:([^:\s]+):([^:\s]+)(?::([^:\s]+))?$/.exec(text);
        if (match === null) {
            throw new Error(
                `invalid Postgres target "${text}": expected docker:<container>:<database> or docker:<container>:<database>:<user>`
            );
        }
        return { container: match[1], database: match[2], user: match[3] ?? "penpot" };
    }

    /**
     * Reads every counter once. A failing pg_stat_statements query leaves statements undefined instead of failing the
     * whole sample.
     *
     * @throws Error when the output of the other queries does not have the expected shape
     */
    async sample(): Promise<PgCounters> {
        let statements: number | undefined;
        try {
            const [[count]] = await this.queryRows(SQL_STATEMENTS, 1, "pg_stat_statements", 1, 1);
            statements = count;
        } catch {
            statements = undefined;
        }
        const [[transactions, rowsRead, rowsWritten]] = await this.queryRows(SQL_DATABASE, 3, "pg_stat_database", 1, 1);
        const [[tableScans]] = await this.queryRows(SQL_TABLE_SCANS, 1, "pg_stat_user_tables", 1, 1);
        const fileChange = await this.queryRows(SQL_FILE_CHANGE, 2, "file_change", 0, 1);
        const [fileChangeSeqScans, fileChangeIdxScans] = fileChange[0] ?? [0, 0];

        const counters: PgCounters = {
            transactions,
            tableScans,
            rowsRead,
            rowsWritten,
            fileChangeSeqScans,
            fileChangeIdxScans,
        };
        if (statements !== undefined) {
            counters.statements = statements;
        }
        return counters;
    }

    /**
     * Returns the stored size of a file: its data pages plus the legacy data column of the file row. When the file row
     * has no data column, the query runs again without that term.
     *
     * @param fileId - UUID of the Penpot file
     * @returns the size in bytes, or undefined when neither query answers
     * @throws Error when fileId is not a UUID
     */
    async fileDataBytes(fileId: string): Promise<number | undefined> {
        if (!UUID_PATTERN.test(fileId)) {
            throw new Error(`file id "${fileId}" is not a UUID`);
        }
        const pagesSql = `select coalesce((select sum(octet_length(data)) from file_data where file_id = '${fileId}' and deleted_at is null),0)`;
        const withColumnSql = `${pagesSql} + coalesce((select octet_length(data) from file where id = '${fileId}'),0)`;
        const withColumn = await this.scalar(withColumnSql);
        if (withColumn !== undefined) {
            return withColumn;
        }
        return this.scalar(pagesSql);
    }

    /**
     * Returns the change of every counter between two samples.
     *
     * @param before - sample taken at the start of the run
     * @param after - sample taken at the end of the run
     * @returns after minus before, field by field. statements is set only when both samples have it.
     */
    static delta(before: PgCounters, after: PgCounters): PgCounters {
        const changes: PgCounters = {
            transactions: after.transactions - before.transactions,
            tableScans: after.tableScans - before.tableScans,
            rowsRead: after.rowsRead - before.rowsRead,
            rowsWritten: after.rowsWritten - before.rowsWritten,
            fileChangeSeqScans: after.fileChangeSeqScans - before.fileChangeSeqScans,
            fileChangeIdxScans: after.fileChangeIdxScans - before.fileChangeIdxScans,
        };
        if (before.statements !== undefined && after.statements !== undefined) {
            changes.statements = after.statements - before.statements;
        }
        return changes;
    }

    /**
     * Runs one query through psql and returns its single value, or undefined when the command or the parsing fails.
     *
     * @param sql - query that returns one row with one column
     */
    private async scalar(sql: string): Promise<number | undefined> {
        try {
            const [[value]] = await this.queryRows(sql, 1, "file size", 1, 1);
            return value;
        } catch {
            return undefined;
        }
    }

    /**
     * Runs one query through docker exec psql and parses the rows.
     *
     * @param sql - query to run
     * @param columns - number of integer columns each row must have
     * @param label - name used in error messages
     * @param minRows - fewest rows the output may have
     * @param maxRows - most rows the output may have
     * @throws Error when the row count or a field is not as expected
     */
    private async queryRows(
        sql: string,
        columns: number,
        label: string,
        minRows: number,
        maxRows: number
    ): Promise<number[][]> {
        const output = await this.run("docker", [
            "exec",
            this.target.container,
            "psql",
            "-U",
            this.target.user,
            "-d",
            this.target.database,
            "-At",
            "-F",
            "|",
            "-c",
            sql,
        ]);
        const lines = output
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");
        if (lines.length < minRows || lines.length > maxRows) {
            throw new Error(`unexpected output for ${label}: ${lines.length} rows, expected ${minRows} to ${maxRows}`);
        }
        return lines.map((line) => {
            const fields = line.split("|");
            if (fields.length !== columns || fields.some((field) => !/^\d+$/.test(field.trim()))) {
                throw new Error(`unexpected output for ${label}: "${line}"`);
            }
            return fields.map((field) => Number(field.trim()));
        });
    }
}
