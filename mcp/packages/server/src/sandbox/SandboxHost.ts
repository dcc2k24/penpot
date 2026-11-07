import { createHash, randomUUID } from "node:crypto";
import type { BackendServices } from "../backend/BackendServices";
import { ExportConcurrency } from "../utils/ExportConcurrency";
import { ExporterError, type ExportFormat, type RenderedFile } from "../backend/ExporterClient";
import { TokenDigest } from "../backend/TokenDigest";
import { OperationValidator } from "../tools/backend/operations/OperationValidator";
import { ApplyTokenValues, TokenCatalogue } from "./ApplyTokenValues";
import type { SandboxHostCalls } from "./SandboxRuntime";
import { SandboxSettings } from "./SandboxSettings";

/** A node of the page tree returned by `get-mcp-page-tree`. */
interface TreeNode {
    id: string;
    children?: TreeNode[];
}

/** One page of the `get-mcp-page-tree` response. */
interface PageTreeResult {
    revn: number;
    root: TreeNode;
    truncated: boolean;
    nextCursor?: string;
}

/** The `get-mcp-shapes` response. */
interface ShapesResult {
    revn: number;
    shapes: Array<{ id: string } & Record<string, unknown>>;
    missing?: string[];
}

/** The result of a write command that reports the revn and the created ids. */
interface WriteResult {
    revn?: number;
    createdIds?: Record<string, string>;
    warnings?: unknown[];
    dryRun?: boolean;
    validation?: { ok?: boolean; errors?: unknown[] };
}

/** A token catalogue with the time it was read. */
interface CatalogueEntry {
    readonly catalogue: TokenCatalogue;
    readonly readAt: number;
}

/** Write options of one execute_code call, sent with every `mcp-apply-operations` call that its flushes make. */
export interface SandboxWriteOptions {
    /** Whether the backend takes a version snapshot before the script's first write; unset for the backend default. */
    snapshot?: boolean;
    /** Revision the caller read the file at. Later calls of the script use the revn of its own last write. */
    baseRevn?: number;
    /** Whether the backend refuses a call that touches shapes changed since the base revision. */
    failOnConflict?: boolean;
    /** Whether the backend may commit one call in several transactions. */
    allowSplit?: boolean;
}

/** Receives the progress of a flush: operations done, operations in the flush, and a line of text. */
export type ProgressSink = (done: number, total: number, text: string) => void;

/**
 * Thrown when a later call of a flush fails. The earlier calls stayed applied; the error carries what they created.
 */
class ChunkFailure extends Error {
    /**
     * Creates the failure.
     *
     * @param message - text that names the failed call
     * @param committed - operations of the earlier calls, which stay applied
     * @param createdIds - ids that the earlier calls created, by handle
     */
    constructor(
        message: string,
        public readonly committed: number,
        public readonly createdIds: Record<string, string>
    ) {
        super(message);
        this.name = "ChunkFailure";
    }
}

/** Summary of the writes and reads of one execute_code call. */
export interface SandboxSummary {
    /** Operations applied by successful, non-dry-run `mcp-apply-operations` calls. */
    opsApplied: number;
    /** Successful, non-dry-run flushes and SVG imports. A flush counts once all of its calls succeeded. */
    flushes: number;
    /** Successful, non-dry-run `mcp-apply-operations` calls; a flush of more than 2000 operations makes several. */
    chunks: number;
    /** Revn reported by the latest page load or applied write, or `null` when there was none. */
    revn: number | null;
    /** Warnings collected from the applied writes and from the page loads. */
    warnings: unknown[];
    /** Temporary ids of all applied writes mapped to the created ids. */
    createdIds: Record<string, string>;
}

/**
 * Host side of the execute_code sandbox: reads pages and applies operations for one MCP token.
 *
 * The sandbox calls the methods of this class through {@link SandboxHostCalls}. Every method runs under the
 * token the host was built with, and every write goes through the per-file write queue. Counters are kept per
 * call and reset by {@link beginCall}. Token validation happens before the script runs, in the tool that owns
 * the call.
 *
 * A flush arrives already folded by the guest (see `CoreSource`). It goes to the backend in one call when it
 * has at most {@link MAX_CALL_OPERATIONS} operations, which the backend commits as one transaction. A larger
 * flush goes in calls of {@link CHUNK_SIZE} operations, all under one hold of the write queue of the file.
 *
 * Every call of a script carries an id derived from one script id, so the writes of a script can be found
 * together. The first write of the script takes a snapshot, so one restore undoes the whole script.
 */
export class SandboxHost implements SandboxHostCalls {
    /** Most distinct pages one call may load. A page loaded again does not count twice. */
    private static readonly MAX_PAGE_LOADS = 20;
    /** Most operations one call may send, counted over all flushes, dry runs included. */
    private static readonly MAX_OPERATIONS = 5000;
    /**
     * Most operations one `mcp-apply-operations` call carries when a flush is split. The backend takes up to
     * {@link MAX_CALL_OPERATIONS} in one call.
     */
    private static readonly CHUNK_SIZE = 1500;
    /** Most operations the backend takes in one `mcp-apply-operations` call (`max-operations`). */
    private static readonly MAX_CALL_OPERATIONS = 2000;
    /** Most ids sent in one `get-mcp-shapes` request. */
    private static readonly SHAPE_BATCH_SIZE = 200;
    /** Depth of the page tree requested for each page load. */
    private static readonly TREE_DEPTH = 20;
    /** Most nodes returned in one `get-mcp-page-tree` response. */
    private static readonly TREE_LIMIT = 5000;
    /** Largest rendered file that one export returns to the guest, in bytes. */
    private static readonly MAX_EXPORT_BYTES = 8 * 1024 * 1024;
    /** Largest image that one media upload sends, in bytes. */
    private static readonly MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
    /** Most exports and media uploads one call may make, counted together. */
    private static readonly MAX_EXPORTS_PER_CALL = 20;
    /** How long a token catalogue is kept, in milliseconds, before the next `apply_token` reads it again. */
    private static readonly TOKEN_CATALOGUE_MAX_AGE_MS = 10_000;
    /** Time between two tries to take a rate-limit token, in milliseconds. */
    private static readonly RATE_RETRY_MS = 100;
    /** Message of the error that a primitive raises once the wall-clock limit of the call has passed. */
    private static readonly WALL_CLOCK_MESSAGE = "The script exceeded the wall-clock time limit";
    /**
     * Time the watchdog allows for each backend call of a flush: the backend request timeout (55 s by default),
     * rounded up. A call that is still running within its allowance is committing, not stuck.
     */
    private static readonly CALL_ALLOWANCE_MS = 60_000;
    /** Operation fields that name shapes, where a handle of an earlier call can stand. */
    private static readonly ID_FIELDS: readonly string[] = [
        "id",
        "ids",
        "parentId",
        "frameId",
        "shapeId",
        "shapeIds",
        "shapes",
        "componentId",
    ];
    /** Formats that the exporter renders. */
    private static readonly EXPORT_FORMATS: ReadonlySet<string> = new Set(["png", "svg", "jpeg", "webp", "pdf"]);

    /** Commands the sandbox may read through `rpc`. */
    private static readonly READ_COMMANDS: ReadonlySet<string> = new Set([
        "get-teams",
        "get-projects",
        "get-project-files",
        "get-mcp-library",
        "get-mcp-tokens",
        "get-mcp-file-outline",
        "get-file-snapshots",
        "get-comment-threads",
        "get-team-deleted-files",
        "get-team-shared-files",
    ]);

    /** Commands the sandbox may write through `rpc`, serialised per file. */
    private static readonly WRITE_COMMANDS: ReadonlySet<string> = new Set([
        "create-file",
        "create-project",
        "rename-file",
        "create-file-snapshot",
        "create-comment-thread",
        "create-comment",
        "create-team",
        "link-file-to-library",
    ]);

    private readonly tokenDigest: string;

    /** Id of the script, which the request ids and the snapshot label of its writes are derived from. */
    private scriptId: string = randomUUID();
    /** Receives a line after each chunk of a flush; set by the tool. */
    private progress: ProgressSink | undefined = undefined;
    /** Calls of the flush in flight or still to start; the watchdog allows time for them. */
    private chunksLeft = 0;
    private opsApplied = 0;
    private flushes = 0;
    private chunks = 0;
    private warnings: unknown[] = [];
    /** Bytes of the pages held in this call, by page key. A page loaded again replaces its entry. */
    private pageBytes = new Map<string, number>();
    private operationsSent = 0;
    /** Flushes started by the current call, dry runs included. */
    private flushCount = 0;
    /** Whether the script has taken its snapshot, which the first write of the script does. */
    private snapshotTaken = false;
    /** Primitive calls made by the current call, counted before any check. */
    private hostCalls = 0;
    /** Exports and media uploads made by the current call. */
    private exportCalls = 0;
    /** Absolute deadline of the current call, in epoch milliseconds, or infinity when it has none. */
    private deadlineAt = Number.POSITIVE_INFINITY;
    private lastRevn: number | null = null;
    private createdIds: Record<string, string> = {};
    /** Token catalogues of the files this call resolved token values in, by file id. */
    private tokenCatalogues = new Map<string, CatalogueEntry>();
    /** Write options of the current call. */
    private writeOptions: SandboxWriteOptions = {};
    /** Whether the watchdog gave up on the script: the calls of its flushes that are not sent yet are not sent. */
    private abandoned = false;
    /** Settles when the flush in flight, if any, has finished. */
    private inFlight: Promise<void> | undefined = undefined;
    /**
     * Base revision sent with the next write: the caller's `baseRevn` until the script commits, then the revn of
     * its last commit, so that a later write does not report the script's own earlier writes as conflicts.
     */
    private conflictBaseRevn: number | undefined;
    /** Fills the values of `apply_token` operations from the token catalogue. */
    private readonly tokenValues = new ApplyTokenValues("execute_code", "");

    /**
     * Creates a host bound to one MCP token.
     *
     * @param services - backend, write queue and other shared services
     * @param userToken - MCP token the sandbox acts with, already validated by the caller
     * @param maxHostCalls - most primitive calls one script may make
     */
    constructor(
        private readonly services: BackendServices,
        private readonly userToken: string,
        private readonly maxHostCalls: number = 1000,
        private readonly maxPageBytes: number = SandboxSettings.DEFAULT_MAX_PAGE_MB * 1024 * 1024
    ) {
        this.tokenDigest = TokenDigest.sha256Hex(userToken);
    }

    /**
     * Resets the per-call state before a new execute_code script runs, and gives the script its id.
     *
     * @param deadlineAt - absolute instant in epoch milliseconds after which the primitives throw, or infinity
     *   for no wall-clock limit
     * @param writeOptions - write options of the call, sent with every `mcp-apply-operations` call
     */
    public beginCall(
        deadlineAt: number = Number.POSITIVE_INFINITY,
        writeOptions: SandboxWriteOptions = {},
        scriptId: string = randomUUID()
    ): void {
        this.scriptId = scriptId;
        this.chunksLeft = 0;
        this.opsApplied = 0;
        this.flushes = 0;
        this.chunks = 0;
        this.writeOptions = { ...writeOptions };
        this.conflictBaseRevn = writeOptions.baseRevn;
        this.warnings = [];
        this.pageBytes = new Map();
        this.operationsSent = 0;
        this.flushCount = 0;
        this.snapshotTaken = false;
        this.hostCalls = 0;
        this.exportCalls = 0;
        this.deadlineAt = deadlineAt;
        this.lastRevn = null;
        this.createdIds = {};
        this.tokenCatalogues = new Map();
    }

    /**
     * Sets the function that receives a progress line after each chunk of a flush.
     *
     * @param progress - receives the text of the line
     */
    public setProgress(progress: ProgressSink | undefined): void {
        this.progress = progress;
    }

    /**
     * Milliseconds that the watchdog allows the writes in flight: one call allowance for each call of the flush
     * that is still to run, the one in flight included.
     *
     * @returns the extra time, in milliseconds
     */
    public writeAllowanceMs(): number {
        return this.chunksLeft * SandboxHost.CALL_ALLOWANCE_MS;
    }

    /**
     * Stops the script's flushes: a call that is not sent yet is not sent. A call already in flight still lands, so
     * use {@link settled} to wait for it.
     */
    public abandon(): void {
        this.abandoned = true;
    }

    /**
     * Waits for the flush in flight, if any, for at most the given time. Used after an abandoned call, so that the
     * totals are final before the next script of the token runs.
     *
     * @param maxMs - longest time to wait, in milliseconds
     */
    public async settled(maxMs: number): Promise<void> {
        const pending = this.inFlight;
        if (pending === undefined) {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, maxMs);
        });
        try {
            await Promise.race([pending, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Returns the totals of the current call, for the tool response.
     */
    public summary(): SandboxSummary {
        return {
            opsApplied: this.opsApplied,
            flushes: this.flushes,
            chunks: this.chunks,
            revn: this.lastRevn,
            warnings: [...this.warnings],
            createdIds: { ...this.createdIds },
        };
    }

    /**
     * Reads the outline of a file through `get-mcp-file-outline`.
     *
     * @param fileId - file to read
     * @returns the outline as JSON text
     */
    public async loadFileOutline(fileId: string): Promise<string> {
        this.countPrimitive(false);
        await this.admitPrimitive();
        const outline = await this.services.backend.callCommand(this.userToken, "get-mcp-file-outline", { fileId });
        return JSON.stringify(outline);
    }

    /**
     * Reads every shape of one page and returns them as JSON text.
     *
     * Walks the page tree up to 20 levels, then fetches the shapes in batches of 200 ids and keeps the order of the
     * tree. Every page of the tree and every batch must report the same revn. A page that is loaded again in the
     * same call replaces its earlier copy and does not count twice against the page cap.
     *
     * The result carries warnings for shapes that the model cannot hold: those below the depth limit, and ids that
     * the backend reports as missing.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @returns JSON text of `{ revn, pageId, fileId, shapes }`
     * @throws Error when the call already loaded 20 distinct pages, the file changed while it was read, or the
     *   pages would exceed 16 MB of page data
     */
    public async loadPage(fileId: string, pageId: string): Promise<string> {
        this.countPrimitive(false);
        const key = `${fileId}\n${pageId}`;
        const isNew = !this.pageBytes.has(key);
        if (isNew && this.pageBytes.size >= SandboxHost.MAX_PAGE_LOADS) {
            throw new Error("execute_code loads at most 20 pages per script");
        }
        await this.admitPrimitive();

        const ids = new Set<string>();
        const deepest = { dropped: false };
        let revn: number | undefined;
        let cursor: string | undefined;
        do {
            const params: Record<string, unknown> = {
                fileId,
                pageId,
                depth: SandboxHost.TREE_DEPTH,
                limit: SandboxHost.TREE_LIMIT,
            };
            if (cursor !== undefined) {
                params.cursor = cursor;
            }
            const page = await this.services.backend.callCommand<PageTreeResult>(
                this.userToken,
                "get-mcp-page-tree",
                params
            );
            revn = this.checkRevn(revn, page.revn);
            this.collectIds(page.root, ids, 1, deepest);
            if (page.truncated && page.nextCursor === undefined) {
                throw new Error("get-mcp-page-tree reported a truncated page without a cursor");
            }
            cursor = page.truncated ? page.nextCursor : undefined;
        } while (cursor !== undefined);

        // each shape is serialised once; the page text is then joined from those pieces.
        const allIds = [...ids];
        const shapeJson = new Map<string, string>();
        const others = this.loadedBytes() - (this.pageBytes.get(key) ?? 0);
        let shapeBytes = 0;
        for (let start = 0; start < allIds.length; start += SandboxHost.SHAPE_BATCH_SIZE) {
            const batch = allIds.slice(start, start + SandboxHost.SHAPE_BATCH_SIZE);
            const result = await this.services.backend.callCommand<ShapesResult>(this.userToken, "get-mcp-shapes", {
                fileId,
                pageId,
                ids: batch,
                includeChildren: false,
            });
            revn = this.checkRevn(revn, result.revn);
            for (const shape of result.shapes) {
                const text = JSON.stringify(shape);
                shapeJson.set(shape.id, text);
                shapeBytes += Buffer.byteLength(text, "utf8");
            }
            // The shapes read so far give the size of the page. A page that is clearly too large stops here, before
            // its other shapes are fetched and serialised.
            const read = Math.min(start + SandboxHost.SHAPE_BATCH_SIZE, allIds.length);
            const estimate = Math.round((shapeBytes / read) * allIds.length);
            if (read < allIds.length && estimate > this.maxPageBytes) {
                throw this.pageTooLarge(pageId, allIds.length, estimate, true);
            }
        }

        // keep the tree order; ids that the backend did not return are skipped and reported.
        const pieces: string[] = [];
        for (const id of allIds) {
            const text = shapeJson.get(id);
            if (text !== undefined) {
                pieces.push(text);
            }
        }
        const text =
            '{"revn":' +
            String(revn ?? null) +
            ',"pageId":' +
            JSON.stringify(pageId) +
            ',"fileId":' +
            JSON.stringify(fileId) +
            ',"shapes":[' +
            pieces.join(",") +
            "]}";
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > this.maxPageBytes) {
            throw this.pageTooLarge(pageId, allIds.length, bytes, false);
        }
        if (others + bytes > this.maxPageBytes) {
            throw new Error(this.pagesTooLarge());
        }
        this.pageBytes.set(key, bytes);
        if (isNew) {
            this.noteDroppedShapes(fileId, pageId, deepest.dropped, allIds.length - pieces.length);
        }
        this.lastRevn = revn ?? null;
        return text;
    }

    /**
     * Applies a batch of operations to a file through `mcp-apply-operations`.
     *
     * Every `apply_token` operation without a value gets one from the token catalogue, and every operation is
     * checked, before anything is sent. The calls of the flush are admitted together, before the first one, so a
     * rate limit or the wall-clock limit never stops a flush half way. A flush of up to 2000 operations is one call;
     * a larger one goes in several calls, in order, and each later call names the shapes that an earlier call
     * created by their ids. The flush holds the write queue of the file from its first call to its last. Each call
     * carries the write options of the script and a request id that is derived from the script id.
     *
     * A dry run goes in one call, so that every operation is checked against the same file; it takes at most
     * {@link MAX_CALL_OPERATIONS} operations. Only successful, non-dry-run calls count towards the totals of the
     * call. Every operation sent, dry runs included, counts towards the cap of 5000 per call.
     *
     * @param fileId - file the operations change
     * @param operationsJson - JSON array of operations
     * @param dryRun - whether the backend validates the operations without committing them
     * @returns the backend result as JSON text; for several calls, the revn of the last one with the created ids,
     *   warnings and validation of all of them
     * @throws Error when the text is not a JSON array, the call would exceed 5000 operations, a dry run has more
     *   than 2000 operations, an operation is invalid, or the backend rejects a call. When a later call fails, the
     *   error names it and the operations that the earlier calls committed.
     */
    public async flush(fileId: string, operationsJson: string, dryRun: boolean): Promise<string> {
        this.countPrimitive(false);
        const operations: unknown = JSON.parse(operationsJson);
        if (!Array.isArray(operations)) {
            throw new Error("operations must be a JSON array");
        }
        if (this.operationsSent + operations.length > SandboxHost.MAX_OPERATIONS) {
            throw new Error("execute_code allows at most 5000 operations per script");
        }
        if (dryRun && operations.length > SandboxHost.MAX_CALL_OPERATIONS) {
            throw new Error(
                `execute_code: a dry run checks its flush in one call, which takes at most ` +
                    `${SandboxHost.MAX_CALL_OPERATIONS} operations; this flush has ${operations.length}. ` +
                    "Dry run a smaller part of the script."
            );
        }
        this.operationsSent += operations.length;
        const chunks = dryRun ? [operations] : SandboxHost.splitChunks(operations);
        await this.admitCalls(chunks.length);
        const tokenWarnings = await this.tokenValues.fill(operations, this.tokenCatalogue(fileId));
        SandboxHost.validateOperations(operations);

        this.flushCount += 1;
        const flushNumber = this.flushCount;
        let answers: WriteResult[];
        // the watchdog allows time for every call of the flush, including one that waits in the write queue.
        this.chunksLeft = chunks.length;
        try {
            const sending = this.services.writeQueue.run(this.tokenDigest, fileId, () =>
                this.sendChunks(fileId, chunks, operations.length, dryRun, flushNumber)
            );
            this.inFlight = sending.then(
                () => undefined,
                () => undefined
            );
            answers = await sending;
        } catch (error) {
            // a later call failed: the earlier calls stay applied, so the guest gets their ids and the failure as data.
            if (error instanceof ChunkFailure) {
                this.chunksLeft = 0;
                return JSON.stringify({
                    failure: { message: error.message, committed: error.committed, createdIds: error.createdIds },
                });
            }
            throw error;
        } finally {
            this.chunksLeft = 0;
        }
        if (!dryRun) {
            this.flushes += 1;
            this.warnings.push(...tokenWarnings);
        }
        if (answers.length === 1 && tokenWarnings.length === 0) {
            return JSON.stringify(answers[0]);
        }
        const merged = SandboxHost.mergeAnswers(answers);
        merged.warnings = [...(merged.warnings ?? []), ...tokenWarnings];
        return JSON.stringify(merged);
    }

    /**
     * Sends the calls of one flush in order. The caller holds the write queue of the file.
     *
     * The calls were admitted before the flush started, so none is refused here. A call that fails stops the
     * flush, and the error names the operations that the earlier calls committed.
     *
     * @param fileId - file the operations change
     * @param chunks - the operations of each call, in order
     * @param total - operations of the whole flush
     * @param dryRun - whether the calls only validate
     * @param flushNumber - position of the flush in the script, from 1
     * @returns the answer of each call, in order
     * @throws Error with the cause of the failed call; for a flush of several calls, the error names the failed
     *   call and the operations that the earlier calls committed
     */
    private async sendChunks(
        fileId: string,
        chunks: unknown[][],
        total: number,
        dryRun: boolean,
        flushNumber: number
    ): Promise<WriteResult[]> {
        const created = new Map<string, string>();
        const answers: WriteResult[] = [];
        let committed = 0;
        for (let index = 0; index < chunks.length; index += 1) {
            if (this.abandoned) {
                // the watchdog gave up on the script: the earlier calls stay applied, and no later call is sent.
                throw new ChunkFailure(
                    "The script was stopped, so the remaining calls of this flush were not sent.",
                    committed,
                    Object.fromEntries(created)
                );
            }
            this.chunksLeft = chunks.length - index;
            const chunk =
                index === 0
                    ? chunks[0]
                    : chunks[index].map((operation) => SandboxHost.rewriteHandles(operation, created));
            const requestId =
                flushNumber === 1 && index === 0
                    ? this.scriptId
                    : SandboxHost.deriveRequestId(this.scriptId, `${flushNumber}/${index + 1}`);
            const snapshot = dryRun ? undefined : this.snapshotFor(index);
            let answer: WriteResult;
            try {
                answer = await this.services.backend.callCommand<WriteResult>(
                    this.userToken,
                    "mcp-apply-operations",
                    this.writeParams(fileId, chunk, dryRun, requestId, snapshot)
                );
            } catch (error) {
                if (chunks.length === 1) {
                    throw error;
                }
                const failure = SandboxHost.chunkFailure(index + 1, chunks.length, committed, total, error);
                if (index === 0) {
                    throw failure;
                }
                // the saved chunks keep their ids; the flush returns them with the failure, see flush().
                throw new ChunkFailure(failure.message, committed, Object.fromEntries(created));
            }
            answer = SandboxHost.isRecord(answer) ? answer : {};
            if (!dryRun) {
                if (snapshot === true) {
                    this.snapshotTaken = true;
                }
                committed += chunk.length;
                this.chunks += 1;
                this.recordAnswer(chunk.length, answer);
                this.progress?.(committed, total, `${committed} of ${total} operations of the flush are applied`);
                if (chunk.some((operation) => ApplyTokenValues.changesTokens(operation))) {
                    this.tokenCatalogues.delete(fileId);
                }
            }
            for (const [handle, id] of Object.entries(answer.createdIds ?? {})) {
                created.set(handle, id);
            }
            answers.push(answer);
        }
        return answers;
    }

    /**
     * Tells whether the call that is about to be sent takes the snapshot of the script.
     *
     * Only the first write of the script takes one, so a restore undoes the whole script. A script that sets
     * `snapshot: false` takes none.
     *
     * @param index - position of the call in its flush
     * @returns true for the snapshot call, false for the others
     */
    private snapshotFor(index: number): boolean | undefined {
        const requested = this.writeOptions.snapshot;
        if (requested === undefined) {
            // the backend's own rule: it snapshots deletes, more than 100 operations, or when asked.
            return undefined;
        }
        if (requested === false) {
            return false;
        }
        return index === 0 && !this.snapshotTaken;
    }

    /**
     * Builds the parameters of one `mcp-apply-operations` call, with the write options of the script.
     *
     * @param fileId - file the operations change
     * @param operations - the operations of the call
     * @param dryRun - whether the call only validates
     * @param requestId - request id of the call, which the backend uses for its snapshot label
     * @param snapshot - whether the call takes the snapshot, or undefined to leave the choice to the backend
     * @returns the command parameters
     */
    private writeParams(
        fileId: string,
        operations: unknown[],
        dryRun: boolean,
        requestId: string,
        snapshot: boolean | undefined
    ): Record<string, unknown> {
        const params: Record<string, unknown> = { fileId, operations, requestId };
        if (dryRun) {
            params.dryRun = true;
        }
        if (snapshot !== undefined) {
            params.snapshot = snapshot;
        }
        if (this.conflictBaseRevn !== undefined) {
            params.baseRevn = this.conflictBaseRevn;
        }
        const options = this.writeOptions;
        if (options.failOnConflict !== undefined) {
            params.failOnConflict = options.failOnConflict;
        }
        if (options.allowSplit !== undefined) {
            params.allowSplit = options.allowSplit;
        }
        return params;
    }

    /**
     * Renders a shape or a page through the exporter, or downloads the image of a fill, and returns the file as
     * base64 text.
     *
     * With a `mediaId`, the stored image is downloaded and the other parameters are not read. Otherwise the shape
     * is rendered in the given format and scale.
     *
     * @param paramsJson - JSON object with `fileId`, and either `mediaId` or `pageId`, `objectId`, `format` and `scale`
     * @returns JSON text of `{ mimeType, base64 }`
     * @throws Error when a parameter is invalid, the file is larger than 8 MB, or the exporter refuses the request
     */
    public async exportShape(paramsJson: string): Promise<string> {
        this.countPrimitive(true);
        const params = SandboxHost.parseObject(paramsJson, "export parameters");
        const fileId = SandboxHost.requiredString(params, "fileId");
        await this.admitPrimitive();
        const renderToken = await this.services.renderSessions.tokenFor(this.userToken, fileId);
        let file;
        if (typeof params.mediaId === "string" && params.mediaId.length > 0) {
            const mediaId = params.mediaId;
            file = await ExportConcurrency.withBackendPermit(this.tokenDigest, () =>
                this.recoverRenderSession(fileId, () => this.services.exporter.downloadAsset(renderToken, mediaId))
            );
        } else {
            file = await this.renderShape(params, fileId, renderToken);
        }
        if (file.bytes.byteLength > SandboxHost.MAX_EXPORT_BYTES) {
            throw new Error("the export is larger than 8 MB; export a smaller shape or use a lower scale");
        }
        return JSON.stringify({
            mimeType: file.mimeType,
            base64: Buffer.from(file.bytes).toString("base64"),
        });
    }

    /**
     * Renders one shape or page through the exporter.
     *
     * @param params - the parameters of the export, already checked to be an object
     * @param fileId - file that holds the shape
     * @param renderToken - render session that authorizes the export
     * @returns the rendered file
     * @throws Error when a parameter is invalid or the exporter refuses the request
     */
    private async renderShape(
        params: Record<string, unknown>,
        fileId: string,
        renderToken: string
    ): Promise<RenderedFile> {
        const pageId = SandboxHost.requiredString(params, "pageId");
        const objectId = SandboxHost.requiredString(params, "objectId");
        const format = typeof params.format === "string" ? params.format : "png";
        if (!SandboxHost.EXPORT_FORMATS.has(format)) {
            throw new Error(`export format ${format} is not supported`);
        }
        const scale = typeof params.scale === "number" && Number.isFinite(params.scale) ? params.scale : 1;
        if (scale <= 0 || scale > 10) {
            throw new Error("the export scale must be above 0 and up to 10");
        }
        const { profileId } = await this.services.validator.validate(this.userToken);
        return ExportConcurrency.withBackendPermit(this.tokenDigest, () =>
            this.recoverRenderSession(fileId, () =>
                this.services.exporter.exportShape(renderToken, {
                    fileId,
                    pageId,
                    objectId,
                    format: format as ExportFormat,
                    scale,
                    profileId,
                    name: "export",
                })
            )
        );
    }

    /**
     * Stores an image from an http or https address in the media library of a file.
     *
     * The backend downloads the image, so the call completes before the script goes on. The write options of the
     * script do not reach this call; see the tool description.
     *
     * @param paramsJson - JSON object with `fileId`, `url` and an optional `name`
     * @returns the media object as JSON text
     * @throws Error when the address is not http or https, or the backend rejects the download
     */
    public async uploadMediaUrl(paramsJson: string): Promise<string> {
        this.countPrimitive(true);
        const params = SandboxHost.parseObject(paramsJson, "uploadMediaUrl parameters");
        const fileId = SandboxHost.requiredString(params, "fileId");
        const url = SandboxHost.requiredString(params, "url");
        if (!/^https?:\/\//i.test(url)) {
            throw new Error("The url must start with http:// or https://.");
        }
        await this.admitPrimitive();
        const commandParams: Record<string, unknown> = { fileId, isLocal: true, url };
        if (typeof params.name === "string") {
            commandParams.name = params.name;
        }
        const media = await this.services.writeQueue.run(this.tokenDigest, fileId, () =>
            this.services.backend.callCommand(this.userToken, "create-file-media-object-from-url", commandParams)
        );
        return JSON.stringify(media);
    }

    /**
     * Stores image bytes in the media library of a file.
     *
     * @param paramsJson - JSON object with `fileId`, `name`, `mimeType` and `base64` content
     * @returns the media object as JSON text
     * @throws Error when the content is empty or larger than 50 MB, or the backend rejects it
     */
    public async uploadMediaData(paramsJson: string): Promise<string> {
        this.countPrimitive(true);
        const params = SandboxHost.parseObject(paramsJson, "uploadMediaData parameters");
        const fileId = SandboxHost.requiredString(params, "fileId");
        const name = SandboxHost.requiredString(params, "name");
        const mimeType = SandboxHost.requiredString(params, "mimeType");
        const content = Buffer.from(SandboxHost.requiredString(params, "base64"), "base64");
        if (content.byteLength === 0 || content.byteLength > SandboxHost.MAX_UPLOAD_BYTES) {
            throw new Error("the image must be between 1 byte and 50 MB");
        }
        await this.admitPrimitive();
        const media = await this.services.writeQueue.run(this.tokenDigest, fileId, () =>
            this.services.backend.callMultipart(
                this.userToken,
                "upload-file-media-object",
                { "file-id": fileId, "is-local": "true", name },
                [{ fieldName: "content", fileName: name, mimeType, content: new Uint8Array(content) }]
            )
        );
        return JSON.stringify(media);
    }

    /**
     * Imports an SVG document into a page through `mcp-import-svg`.
     *
     * The write options of the script do not reach this call; see the tool description.
     *
     * @param paramsJson - JSON object with the command parameters, including `fileId`
     * @returns the backend result as JSON text
     * @throws Error when the text is not a JSON object or the backend rejects the import
     */
    public async importSvg(paramsJson: string): Promise<string> {
        this.countPrimitive(false);
        const params = SandboxHost.parseObject(paramsJson, "import_svg parameters");
        const fileId = SandboxHost.fileIdOf(params);
        await this.admitPrimitive();
        const result = await this.services.writeQueue.run(this.tokenDigest, fileId, () =>
            this.services.backend.callCommand<WriteResult>(this.userToken, "mcp-import-svg", params)
        );

        if (params.dryRun !== true) {
            this.flushes += 1;
            this.recordAnswer(0, SandboxHost.isRecord(result) ? result : {});
        }
        return JSON.stringify(result);
    }

    /**
     * Calls an allow-listed backend command for the sandbox.
     *
     * Reads run directly. Writes run through the per-file write queue, keyed by the `fileId` parameter, or by
     * the empty string when the command has none. The write options of the script do not reach these calls.
     *
     * @param name - backend command name
     * @param paramsJson - JSON object with the command parameters
     * @returns the backend result as JSON text
     * @throws Error when the command is not allowed, the parameters are not a JSON object, or the backend
     *   rejects the call
     */
    public async rpc(name: string, paramsJson: string): Promise<string> {
        this.countPrimitive(false);
        const isRead = SandboxHost.READ_COMMANDS.has(name);
        const isWrite = SandboxHost.WRITE_COMMANDS.has(name);
        if (!isRead && !isWrite) {
            throw new Error(`rpc: ${name} is not available in execute_code`);
        }
        const params = SandboxHost.parseObject(paramsJson, "rpc parameters");
        await this.admitPrimitive();

        let result: unknown;
        if (isRead) {
            result = await this.services.backend.callCommand(this.userToken, name, params);
        } else {
            const fileId = SandboxHost.fileIdOf(params);
            result = await this.services.writeQueue.run(this.tokenDigest, fileId, () =>
                this.services.backend.callCommand(this.userToken, name, params)
            );
        }
        // an answer without a body is passed on as null, because the guest needs a string
        return JSON.stringify(result === undefined ? null : result);
    }

    /**
     * Counts one primitive call against the host call cap, and against the export cap when it exports.
     *
     * Runs first in every primitive, so that a refused call is still counted.
     *
     * @param isExport - whether the primitive exports or uploads media
     * @throws Error when the call exceeds the host call cap or the export cap
     */
    private countPrimitive(isExport: boolean): void {
        this.hostCalls += 1;
        if (this.hostCalls > this.maxHostCalls) {
            throw new Error(`execute_code allows at most ${this.maxHostCalls} host calls per script`);
        }
        if (isExport) {
            this.exportCalls += 1;
            if (this.exportCalls > SandboxHost.MAX_EXPORTS_PER_CALL) {
                const limit = SandboxHost.MAX_EXPORTS_PER_CALL;
                throw new Error(`execute_code allows at most ${limit} exports and media uploads per script`);
            }
        }
    }

    /**
     * Admits a primitive that reaches the backend or the exporter, after its cap checks.
     *
     * @throws Error when the wall-clock limit passes before a rate-limit token is free
     */
    private async admitPrimitive(): Promise<void> {
        await this.admitCalls(1);
    }

    /**
     * Admits a number of backend calls before they start: checks the wall-clock limit once, then takes one
     * rate-limit token per call. A call waits for its token; the wait ends at the deadline.
     *
     * @param count - number of backend calls to admit
     * @throws Error when the wall-clock limit has passed, or the deadline comes before a token is free
     */
    private async admitCalls(count: number): Promise<void> {
        if (Date.now() >= this.deadlineAt) {
            throw new Error(SandboxHost.WALL_CLOCK_MESSAGE);
        }
        for (let taken = 0; taken < count; taken += 1) {
            await this.takeRateToken();
        }
    }

    /**
     * Waits until the rate limit of the token gives one request, bounded by the deadline.
     *
     * @throws Error when the deadline passes before a token is free
     */
    private async takeRateToken(): Promise<void> {
        for (;;) {
            try {
                this.services.rateLimiter.acquire(this.userToken);
                return;
            } catch {
                if (Date.now() + SandboxHost.RATE_RETRY_MS >= this.deadlineAt) {
                    throw new Error(SandboxHost.WALL_CLOCK_MESSAGE);
                }
                await new Promise<void>((resolve) => setTimeout(resolve, SandboxHost.RATE_RETRY_MS));
            }
        }
    }

    /**
     * Returns the token catalogue of a file for this call. It is read at most once per file and call, is read
     * again after 10 s, and is dropped after a write that changes tokens.
     *
     * @param fileId - file that holds the tokens
     * @returns the catalogue
     */
    private tokenCatalogue(fileId: string): TokenCatalogue {
        const now = Date.now();
        const held = this.tokenCatalogues.get(fileId);
        if (held !== undefined && now - held.readAt < SandboxHost.TOKEN_CATALOGUE_MAX_AGE_MS) {
            return held.catalogue;
        }
        const catalogue = new TokenCatalogue(this.services.backend, this.userToken, fileId);
        this.tokenCatalogues.set(fileId, { catalogue, readAt: now });
        return catalogue;
    }

    /**
     * Runs an exporter call and drops the render session of the file when the exporter refuses it.
     *
     * @param fileId - file that the render session renders
     * @param call - the exporter call
     * @returns the value of the call
     * @throws the error of the call
     */
    private async recoverRenderSession<T>(fileId: string, call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (error instanceof ExporterError && error.status === 401) {
                this.services.renderSessions.invalidate(this.userToken, fileId);
            }
            throw error;
        }
    }

    /**
     * Adds the operations, warnings, created ids and revn of one committed backend call to the call.
     *
     * The revn also becomes the base revision of the next write, when the script has one.
     *
     * @param operationCount - number of operations the backend call applied
     * @param result - the backend result of the call
     */
    private recordAnswer(operationCount: number, result: WriteResult): void {
        this.opsApplied += operationCount;
        if (Array.isArray(result.warnings)) {
            this.warnings.push(...result.warnings);
        }
        if (result.createdIds !== undefined) {
            Object.assign(this.createdIds, result.createdIds);
        }
        if (typeof result.revn === "number") {
            this.lastRevn = result.revn;
            // The base moves only with failOnConflict. Without it the base is a hint, and moving it would hide
            // changes that others made between the caller's read and the script's first write from later checks.
            if (this.conflictBaseRevn !== undefined && this.writeOptions.failOnConflict === true) {
                this.conflictBaseRevn = result.revn;
            }
        }
    }

    /**
     * Splits the operations of a flush into calls. A flush of up to {@link MAX_CALL_OPERATIONS} operations is one
     * call, so the backend commits it as one transaction; a larger one is cut into calls of {@link CHUNK_SIZE}.
     *
     * @param operations - the operations of the flush, in order
     * @returns the calls, in order; an empty flush gives one empty call
     */
    private static splitChunks(operations: unknown[]): unknown[][] {
        if (operations.length <= SandboxHost.MAX_CALL_OPERATIONS) {
            return [operations];
        }
        const chunks: unknown[][] = [];
        for (let start = 0; start < operations.length; start += SandboxHost.CHUNK_SIZE) {
            chunks.push(operations.slice(start, start + SandboxHost.CHUNK_SIZE));
        }
        return chunks;
    }

    /**
     * Derives a request id from the script id and a label, in the form of a UUID.
     *
     * The backend takes request ids as UUIDs, so the label is hashed into one. The same script id and label always
     * give the same id.
     *
     * @param scriptId - id of the script
     * @param label - position of the call, such as `1/2` for the second call of the first flush
     * @returns a UUID text
     */
    private static deriveRequestId(scriptId: string, label: string): string {
        const hex = createHash("sha256").update(`${scriptId}/${label}`).digest("hex").slice(0, 32).split("");
        hex[12] = "5";
        hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
        const text = hex.join("");
        return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    }

    /**
     * Copies an operation with every handle that an earlier call created replaced by its id.
     *
     * Only the fields that name shapes are read, so a text that happens to equal a handle is left alone.
     *
     * @param operation - one operation of a later call
     * @param created - ids by handle, from the earlier calls of the flush
     * @returns the copy
     */
    private static rewriteHandles(operation: unknown, created: ReadonlyMap<string, string>): unknown {
        if (!SandboxHost.isRecord(operation)) {
            return operation;
        }
        const copy: Record<string, unknown> = { ...operation };
        for (const field of SandboxHost.ID_FIELDS) {
            if (field in copy) {
                copy[field] = SandboxHost.replaceHandles(copy[field], created);
            }
        }
        return copy;
    }

    /**
     * Replaces handles inside an id field, which is a text or a list of texts.
     *
     * @param value - the field value
     * @param created - ids by handle
     * @returns the value with each handle replaced
     */
    private static replaceHandles(value: unknown, created: ReadonlyMap<string, string>): unknown {
        if (typeof value === "string") {
            return created.get(value) ?? value;
        }
        if (Array.isArray(value)) {
            return value.map((item) => SandboxHost.replaceHandles(item, created));
        }
        return value;
    }

    /**
     * Joins the answers of the calls of one flush into one answer.
     *
     * @param answers - the answers, in order
     * @returns the last answer, with the created ids and warnings of all calls, and their validation joined
     */
    private static mergeAnswers(answers: WriteResult[]): WriteResult {
        const validations = answers.flatMap((answer) => (answer.validation === undefined ? [] : [answer.validation]));
        const merged: WriteResult = {
            ...answers[answers.length - 1],
            createdIds: Object.assign({}, ...answers.map((answer) => answer.createdIds ?? {})),
            warnings: answers.flatMap((answer) => answer.warnings ?? []),
        };
        if (validations.length > 0) {
            merged.validation = {
                ok: validations.every((validation) => validation.ok !== false),
                errors: validations.flatMap((validation) => validation.errors ?? []),
            };
        }
        return merged;
    }

    /**
     * Words the error of a call that failed inside a flush of several calls.
     *
     * @param chunk - position of the failed call, from 1
     * @param chunks - calls in the flush
     * @param committed - operations of the flush that the earlier calls committed
     * @param total - operations of the flush
     * @param error - the error that the call raised
     * @returns the error of the flush
     */
    private static chunkFailure(
        chunk: number,
        chunks: number,
        committed: number,
        total: number,
        error: unknown
    ): Error {
        const cause = error instanceof Error ? error.message : String(error);
        return new Error(
            `execute_code: chunk ${chunk} of ${chunks} of a flush failed. ${committed} of ${total} operations of this ` +
                `flush were committed by the earlier chunks, and those chunks stay applied. Chunk ${chunk} and the ` +
                `later chunks were not applied. ${cause}`
        );
    }

    /**
     * Checks that a response carries the same revn as the earlier responses of the same read.
     *
     * @param expected - revn of the earlier responses, or `undefined` before the first one
     * @param actual - revn of the new response
     * @returns the revn to carry forward
     * @throws Error when the file changed between the responses
     */
    private checkRevn(expected: number | undefined, actual: number): number {
        if (expected !== undefined && expected !== actual) {
            throw new Error("the file changed while the page was read; run the script again");
        }
        return actual;
    }

    /**
     * Adds the id of a tree node and of every node below it, in document order, without repeats.
     *
     * The root is at depth 1. A node below the depth limit that still has children marks the page as cut short.
     *
     * @param node - the node to walk
     * @param ids - ids collected so far, in document order
     * @param depth - depth of the node, from 1
     * @param state - receives `dropped` when a node below the depth limit has children
     */
    private collectIds(node: TreeNode, ids: Set<string>, depth: number, state: { dropped: boolean }): void {
        ids.add(node.id);
        const children = node.children ?? [];
        if (depth >= SandboxHost.TREE_DEPTH && children.length > 0) {
            state.dropped = true;
        }
        for (const child of children) {
            this.collectIds(child, ids, depth + 1, state);
        }
    }

    /**
     * Records a warning when a page load left out shapes, so the script can tell the model is incomplete.
     *
     * @param fileId - file of the page
     * @param pageId - page that was loaded
     * @param depthCut - whether shapes below the depth limit were left out
     * @param missing - number of ids in the tree that the backend did not return
     */
    private noteDroppedShapes(fileId: string, pageId: string, depthCut: boolean, missing: number): void {
        if (depthCut) {
            this.warnings.push({
                code: "shapes-below-depth-limit",
                fileId,
                pageId,
                message: `Shapes nested deeper than ${SandboxHost.TREE_DEPTH} levels are not in the model of page ${pageId}.`,
            });
        }
        if (missing > 0) {
            this.warnings.push({
                code: "shapes-missing",
                fileId,
                pageId,
                count: missing,
                message: `${missing} shape(s) of page ${pageId} were reported missing and are not in the model.`,
            });
        }
    }

    /**
     * Words the error of one page that is above the cap.
     *
     * @param pageId - the page
     * @param shapes - shapes in the page
     * @param bytes - size of the page as JSON, or the estimate of it
     * @param estimated - whether the size is an estimate from the shapes read so far
     * @returns the error, which names the page, its size and shape count, and the way out
     */
    private pageTooLarge(pageId: string, shapes: number, bytes: number, estimated: boolean): Error {
        const megabytes = (bytes / (1024 * 1024)).toFixed(1);
        return new Error(
            `page ${pageId} has ${shapes} shapes (${estimated ? "about " : ""}${megabytes} MB); ` +
                "execute_code loads a whole page; use apply_operations and get_shapes/find_shapes for a page this " +
                "large, or raise PENPOT_MCP_SANDBOX_PAGE_MB"
        );
    }

    /**
     * Words the error of the pages of one call that together are above the cap.
     *
     * @returns the error text
     */
    private pagesTooLarge(): string {
        const megabytes = (this.maxPageBytes / (1024 * 1024)).toFixed(0);
        return (
            `execute_code holds at most ${megabytes} MB of page data per script, and the pages it loads reach more; ` +
            "narrow the script to fewer pages, or raise PENPOT_MCP_SANDBOX_PAGE_MB"
        );
    }

    /**
     * Returns the bytes of all page copies that the call holds.
     *
     * @returns the total of the page byte counts
     */
    private loadedBytes(): number {
        let total = 0;
        for (const bytes of this.pageBytes.values()) {
            total += bytes;
        }
        return total;
    }

    /**
     * Parses a JSON text that must hold an object.
     *
     * @param text - the JSON text
     * @param what - name of the value, used in the error message
     * @returns the parsed object
     * @throws Error when the parsed value is not a JSON object
     */
    private static parseObject(text: string, what: string): Record<string, unknown> {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${what} must be a JSON object`);
        }
        return value as Record<string, unknown>;
    }

    /**
     * Tells whether a value is a plain JSON object.
     *
     * @param value - the value to check
     * @returns true for an object that is not an array or null
     */
    private static isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /**
     * Checks every operation of a flush against the operation vocabulary, before any of them is sent.
     *
     * Each operation is checked on its own, so the validator's limit on the size of one call does not apply to a
     * flush, and the index in the message is the position in the flush.
     *
     * @param operations - the operations of one flush, already resolved for token values
     * @throws Error naming the first invalid operation by its position in the flush
     */
    private static validateOperations(operations: unknown[]): void {
        const validator = new OperationValidator();
        for (let index = 0; index < operations.length; index += 1) {
            try {
                validator.validate([operations[index]]);
            } catch (error) {
                throw new Error(SandboxHost.invalidOperationMessage(index, error));
            }
        }
    }

    /**
     * Words the validator error of one operation with the position of the operation in the flush.
     *
     * @param index - position of the operation in the flush
     * @param error - the error that the validator raised for the operation alone
     * @returns the message, starting with `execute_code: operation <index>`
     */
    private static invalidOperationMessage(index: number, error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        const match = /^Operation 0 \(([^)]*)\) is invalid: /.exec(message);
        if (match !== null) {
            return `execute_code: operation ${index} (${match[1]}) is invalid: ${message.slice(match[0].length)}`;
        }
        // an operation without an op name, or with an unknown one, has no parameter list to report.
        return `execute_code: ${message.replace(/^Operation 0 /, `operation ${index} `)}`;
    }

    /**
     * Reads a required string member of a parameter object.
     *
     * @param params - parameter object
     * @param key - name of the member
     * @returns the string
     * @throws Error when the member is missing or not a string
     */
    private static requiredString(params: Record<string, unknown>, key: string): string {
        const value = params[key];
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(`${key} must be a non-empty string`);
        }
        return value;
    }

    /**
     * Returns the `fileId` parameter as the write queue key.
     *
     * @param params - command parameters
     * @returns the file id, or the empty string when the parameter is missing or not a string
     */
    private static fileIdOf(params: Record<string, unknown>): string {
        return typeof params.fileId === "string" ? params.fileId : "";
    }
}
