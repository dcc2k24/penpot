import { randomUUID } from "node:crypto";
import type { BackendServices } from "../backend/BackendServices";
import { ExportConcurrency } from "../utils/ExportConcurrency";
import { ExporterError, type ExportFormat, type RenderedFile } from "../backend/ExporterClient";
import { TokenDigest } from "../backend/TokenDigest";
import { OperationValidator } from "../tools/backend/operations/OperationValidator";
import { ApplyTokenValues, TokenCatalogue } from "./ApplyTokenValues";
import type { SandboxHostCalls } from "./SandboxRuntime";

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

/** Write options of one execute_code call, sent with every `mcp-apply-operations` call that its flushes make. */
export interface SandboxWriteOptions {
    /** Whether the backend takes a version snapshot before each call commits; unset for the backend default. */
    snapshot?: boolean;
    /** Revision the caller read the file at. Later calls of the script use the revn of its own last write. */
    baseRevn?: number;
    /** Whether the backend refuses a call that touches shapes changed since the base revision. */
    failOnConflict?: boolean;
    /** Whether the backend may commit one call in several transactions. */
    allowSplit?: boolean;
}

/** Summary of the writes and reads of one execute_code call. */
export interface SandboxSummary {
    /** Operations applied by successful, non-dry-run `mcp-apply-operations` calls. */
    opsApplied: number;
    /** Successful, non-dry-run flushes and SVG imports. A flush counts once all of its calls succeeded. */
    flushes: number;
    /** Successful, non-dry-run `mcp-apply-operations` calls; a flush of more than 1500 operations makes several. */
    chunks: number;
    /** Revn reported by the latest page load or applied write, or `null` when there was none. */
    revn: number | null;
    /** Warnings collected from the applied writes. */
    warnings: unknown[];
    /** Temporary ids of all applied writes mapped to the created ids. */
    createdIds: Record<string, string>;
}

/**
 * Host side of the execute_code sandbox: reads pages and applies operations for one MCP token.
 *
 * The sandbox calls the methods of this class through {@link SandboxHostCalls}. Every method runs under the
 * token the host was built with, and every write goes through the per-file write queue. Counters are kept per
 * call and reset by {@link beginCall}. Token validation and rate limiting happen before the script runs, in the
 * tool that owns the call.
 *
 * A flush arrives already folded by the guest (see `CoreSource`), and goes to the backend in calls of at most
 * {@link CHUNK_SIZE} operations, all under one hold of the write queue of the file.
 */
export class SandboxHost implements SandboxHostCalls {
    /** Most page loads one call may make. */
    private static readonly MAX_PAGE_LOADS = 20;
    /** Most bytes of page data one call may load, counted over all page loads. */
    private static readonly MAX_LOAD_BYTES = 50 * 1024 * 1024;
    /** Most operations one call may send, counted over all flushes, dry runs included. */
    private static readonly MAX_OPERATIONS = 5000;
    /**
     * Most operations one `mcp-apply-operations` call carries. The backend refuses a call above
     * {@link MAX_CALL_OPERATIONS}, so a larger flush goes in several calls of this size.
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
    /** Message of the error that a page load raises when the call would exceed 50 MB of page data. */
    private static readonly LOAD_LIMIT_MESSAGE =
        "execute_code working copy exceeds 50 MB; narrow the script to fewer pages";
    /** Message of the error that a primitive raises once the wall-clock limit of the call has passed. */
    private static readonly WALL_CLOCK_MESSAGE = "The script exceeded the wall-clock time limit";
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

    private opsApplied = 0;
    private flushes = 0;
    private chunks = 0;
    private warnings: unknown[] = [];
    private loadedPages = 0;
    private loadedBytes = 0;
    private pageLoadAttempts = 0;
    private operationsSent = 0;
    /** Primitive calls made by the current call, counted before any check. */
    private hostCalls = 0;
    /** Exports and media uploads made by the current call. */
    private exportCalls = 0;
    /** Absolute deadline of the current call, in epoch milliseconds, or infinity when it has none. */
    private deadlineAt = Number.POSITIVE_INFINITY;
    private lastRevn: number | null = null;
    private createdIds: Record<string, string> = {};
    /** Token catalogues of the files this call resolved token values in, by file id. */
    private tokenCatalogues = new Map<string, TokenCatalogue>();
    /** Write options of the current call. */
    private writeOptions: SandboxWriteOptions = {};
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
        private readonly maxHostCalls: number = 1000
    ) {
        this.tokenDigest = TokenDigest.sha256Hex(userToken);
    }

    /**
     * Resets the per-call counters before a new execute_code script runs.
     *
     * @param deadlineAt - absolute instant in epoch milliseconds after which the primitives throw, or infinity
     *   for no wall-clock limit
     * @param writeOptions - write options of the call, sent with every `mcp-apply-operations` call
     */
    public beginCall(deadlineAt: number = Number.POSITIVE_INFINITY, writeOptions: SandboxWriteOptions = {}): void {
        this.opsApplied = 0;
        this.flushes = 0;
        this.chunks = 0;
        this.writeOptions = { ...writeOptions };
        this.conflictBaseRevn = writeOptions.baseRevn;
        this.warnings = [];
        this.loadedPages = 0;
        this.loadedBytes = 0;
        this.pageLoadAttempts = 0;
        this.operationsSent = 0;
        this.hostCalls = 0;
        this.exportCalls = 0;
        this.deadlineAt = deadlineAt;
        this.lastRevn = null;
        this.createdIds = {};
        this.tokenCatalogues = new Map();
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
        this.admitPrimitive();
        const outline = await this.services.backend.callCommand(this.userToken, "get-mcp-file-outline", { fileId });
        return JSON.stringify(outline);
    }

    /**
     * Reads every shape of one page and returns them as JSON text.
     *
     * Walks the page tree up to 20 levels, so shapes nested deeper than 20 levels are not returned. Pages the tree in cursor order, then fetches the shapes in batches of 200 ids and keeps
     * the order of the tree. Every page of the tree and every batch must report the same revn.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @returns JSON text of `{ revn, pageId, fileId, shapes }`
     * @throws Error when the call already loaded 20 pages, the file changed while it was read, or the call
     *   would exceed 50 MB of page data
     */
    public async loadPage(fileId: string, pageId: string): Promise<string> {
        this.countPrimitive(false);
        if (this.pageLoadAttempts >= SandboxHost.MAX_PAGE_LOADS) {
            throw new Error("execute_code loads at most 20 pages per script");
        }
        this.pageLoadAttempts += 1;
        this.admitPrimitive();

        const ids = new Set<string>();
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
            this.collectIds(page.root, ids);
            if (page.truncated && page.nextCursor === undefined) {
                throw new Error("get-mcp-page-tree reported a truncated page without a cursor");
            }
            cursor = page.truncated ? page.nextCursor : undefined;
        } while (cursor !== undefined);

        const allIds = [...ids];
        const shapesById = new Map<string, { id: string } & Record<string, unknown>>();
        let batchBytes = 0;
        for (let start = 0; start < allIds.length; start += SandboxHost.SHAPE_BATCH_SIZE) {
            const batch = allIds.slice(start, start + SandboxHost.SHAPE_BATCH_SIZE);
            const result = await this.services.backend.callCommand<ShapesResult>(this.userToken, "get-mcp-shapes", {
                fileId,
                pageId,
                ids: batch,
                includeChildren: false,
            });
            revn = this.checkRevn(revn, result.revn);
            // the batch counts against the call before the next batch is requested.
            batchBytes += Buffer.byteLength(JSON.stringify(result.shapes), "utf8");
            if (this.loadedBytes + batchBytes > SandboxHost.MAX_LOAD_BYTES) {
                throw new Error(SandboxHost.LOAD_LIMIT_MESSAGE);
            }
            for (const shape of result.shapes) {
                shapesById.set(shape.id, shape);
            }
        }

        // keep the tree order; ids reported as missing, or absent from the response, are skipped.
        const shapes: Array<{ id: string } & Record<string, unknown>> = [];
        for (const id of allIds) {
            const shape = shapesById.get(id);
            if (shape !== undefined) {
                shapes.push(shape);
            }
        }

        const text = JSON.stringify({ revn, pageId, fileId, shapes });
        const bytes = Buffer.byteLength(text, "utf8");
        if (this.loadedBytes + bytes > SandboxHost.MAX_LOAD_BYTES) {
            throw new Error(SandboxHost.LOAD_LIMIT_MESSAGE);
        }
        this.loadedBytes += bytes;
        this.loadedPages += 1;
        this.lastRevn = revn ?? null;
        return text;
    }

    /**
     * Applies a batch of operations to a file through `mcp-apply-operations`.
     *
     * Every `apply_token` operation without a value gets one from the token catalogue, and every operation is
     * checked, before anything is sent. A flush of more than {@link CHUNK_SIZE} operations then goes in several
     * calls, in order, and each later call names the shapes that an earlier call created by their ids. The flush
     * holds the write queue of the file from its first call to its last, so no other write of this adapter to the
     * file lands between two of its calls. Each call carries the write options of the script.
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
        this.admitPrimitive();
        this.operationsSent += operations.length;
        const tokenWarnings = await this.tokenValues.fill(operations, this.tokenCatalogue(fileId));
        SandboxHost.validateOperations(operations);

        const chunks = dryRun ? [operations] : SandboxHost.splitChunks(operations);
        const answers = await this.services.writeQueue.run(this.tokenDigest, fileId, () =>
            this.sendChunks(fileId, chunks, operations.length, dryRun)
        );
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
     * Each call after the first is admitted like a primitive: it is refused once the wall-clock limit has passed,
     * and it charges the rate limit of the token.
     *
     * @param fileId - file the operations change
     * @param chunks - the operations of each call, in order
     * @param total - operations of the whole flush
     * @param dryRun - whether the calls only validate
     * @returns the answer of each call, in order
     * @throws Error with the cause of the failed call; for a flush of several calls, the error names the failed
     *   call and the operations that the earlier calls committed
     */
    private async sendChunks(
        fileId: string,
        chunks: unknown[][],
        total: number,
        dryRun: boolean
    ): Promise<WriteResult[]> {
        const created = new Map<string, string>();
        const answers: WriteResult[] = [];
        let committed = 0;
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk =
                index === 0 ? chunks[0] : chunks[index].map((operation) => SandboxHost.withIds(operation, created));
            let answer: WriteResult;
            try {
                if (index > 0) {
                    this.admitPrimitive();
                }
                answer = await this.services.backend.callCommand<WriteResult>(
                    this.userToken,
                    "mcp-apply-operations",
                    this.writeParams(fileId, chunk, dryRun)
                );
            } catch (error) {
                if (chunks.length === 1) {
                    throw error;
                }
                throw SandboxHost.chunkFailure(index + 1, chunks.length, committed, total, error);
            }
            answer = SandboxHost.isRecord(answer) ? answer : {};
            if (!dryRun) {
                committed += chunk.length;
                this.chunks += 1;
                this.recordAnswer(chunk.length, answer);
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
     * Builds the parameters of one `mcp-apply-operations` call, with the write options of the script.
     *
     * @param fileId - file the operations change
     * @param operations - the operations of the call
     * @param dryRun - whether the call only validates
     * @returns the command parameters
     */
    private writeParams(fileId: string, operations: unknown[], dryRun: boolean): Record<string, unknown> {
        const params: Record<string, unknown> = { fileId, operations, requestId: randomUUID() };
        if (dryRun) {
            params.dryRun = true;
        }
        const options = this.writeOptions;
        if (options.snapshot !== undefined) {
            params.snapshot = options.snapshot;
        }
        if (this.conflictBaseRevn !== undefined) {
            params.baseRevn = this.conflictBaseRevn;
        }
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
        this.admitPrimitive();
        const renderToken = await this.services.renderSessions.tokenFor(this.userToken, fileId);
        let file;
        if (typeof params.mediaId === "string" && params.mediaId.length > 0) {
            const mediaId = params.mediaId;
            file = await ExportConcurrency.withPermit(() =>
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
        return ExportConcurrency.withPermit(() =>
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
     * The backend downloads the image, so the call completes before the script goes on.
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
        this.admitPrimitive();
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
        this.admitPrimitive();
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
     * @param paramsJson - JSON object with the command parameters, including `fileId`
     * @returns the backend result as JSON text
     * @throws Error when the text is not a JSON object or the backend rejects the import
     */
    public async importSvg(paramsJson: string): Promise<string> {
        this.countPrimitive(false);
        const params = SandboxHost.parseObject(paramsJson, "import_svg parameters");
        const fileId = SandboxHost.fileIdOf(params);
        this.admitPrimitive();
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
     * the empty string when the command has none.
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
        this.admitPrimitive();

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
     * Refuses the call once the wall-clock limit has passed, and charges one request to the rate limit of the token.
     *
     * @throws Error when the wall-clock limit has passed or the rate limit refuses the request
     */
    private admitPrimitive(): void {
        if (Date.now() >= this.deadlineAt) {
            throw new Error(SandboxHost.WALL_CLOCK_MESSAGE);
        }
        this.services.rateLimiter.acquire(this.userToken);
    }

    /**
     * Returns the token catalogue of a file for this call. It is read at most once per file and call, and dropped
     * after a write that changes tokens.
     *
     * @param fileId - file that holds the tokens
     * @returns the catalogue
     */
    private tokenCatalogue(fileId: string): TokenCatalogue {
        let catalogue = this.tokenCatalogues.get(fileId);
        if (catalogue === undefined) {
            catalogue = new TokenCatalogue(this.services.backend, this.userToken, fileId);
            this.tokenCatalogues.set(fileId, catalogue);
        }
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
            if (this.conflictBaseRevn !== undefined) {
                this.conflictBaseRevn = result.revn;
            }
        }
    }

    /**
     * Splits the operations of a flush into calls of at most {@link CHUNK_SIZE} operations each.
     *
     * @param operations - the operations of the flush, in order
     * @returns the calls, in order; an empty flush gives one empty call
     */
    private static splitChunks(operations: unknown[]): unknown[][] {
        const chunks: unknown[][] = [];
        for (let start = 0; start < operations.length; start += SandboxHost.CHUNK_SIZE) {
            chunks.push(operations.slice(start, start + SandboxHost.CHUNK_SIZE));
        }
        return chunks.length > 0 ? chunks : [[]];
    }

    /**
     * Copies a value of an operation with every handle that an earlier call of the flush created replaced by its id.
     *
     * @param value - a value of an operation
     * @param created - ids by handle, from the earlier calls of the flush
     * @returns the copy
     */
    private static withIds(value: unknown, created: ReadonlyMap<string, string>): unknown {
        if (typeof value === "string") {
            return created.get(value) ?? value;
        }
        if (Array.isArray(value)) {
            return value.map((item) => SandboxHost.withIds(item, created));
        }
        if (SandboxHost.isRecord(value)) {
            const copy: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value)) {
                copy[key] = SandboxHost.withIds(item, created);
            }
            return copy;
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
     * @param node - the node to walk
     * @param ids - ids collected so far, in document order
     */
    private collectIds(node: TreeNode, ids: Set<string>): void {
        ids.add(node.id);
        for (const child of node.children ?? []) {
            this.collectIds(child, ids);
        }
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
