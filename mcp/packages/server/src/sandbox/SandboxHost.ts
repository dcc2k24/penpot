import { createHash, randomUUID } from "node:crypto";
import type { BackendServices } from "../backend/BackendServices";
import { ExportConcurrency } from "../utils/ExportConcurrency";
import { ExporterError, type ExportFormat, type RenderedFile } from "../backend/ExporterClient";
import { BackendRpcError } from "../backend/BackendRpcError";
import { TokenDigest } from "../backend/TokenDigest";
import { OperationValidator } from "../tools/backend/operations/OperationValidator";
import { ApplyTokenValues, TokenCatalogue } from "./ApplyTokenValues";
import type { SandboxHostCalls } from "./SandboxRuntime";
import { SandboxSettings } from "./SandboxSettings";

/** A node of the page tree returned by `get-mcp-page-tree`. */
interface TreeNode {
    id: string;
    /** Number of children the node has in the page, whether or not the reply carries them. */
    childCount?: number;
    children?: TreeNode[];
}

/** One page of the `get-mcp-page-tree` response. */
interface PageTreeResult {
    revn: number;
    root: TreeNode;
    truncated: boolean;
    nextCursor?: string;
    /** Shapes of the whole walk. Present when the call asked for `estimateSize`. */
    totalShapes?: number;
    /** Backend estimate of the JSON bytes of those shapes. Present when the call asked for `estimateSize`. */
    estimatedBytes?: number;
}

/** The `get-mcp-shapes` response. */
interface ShapesResult {
    revn: number;
    shapes: Array<{ id: string } & Record<string, unknown>>;
    missing?: string[];
    truncated?: boolean;
}

/** The roots of one call on one page: the file, the page, and the roots in the order given. */
export interface PartialScope {
    /** File that holds the page. */
    fileId: string;
    /** The page that loads partly. Every other page loads whole. */
    pageId: string;
    /** Shape ids of the page that load, with their subtrees and what they need. */
    rootIds: string[];
}

/** What a partial page keeps from one of its loads to the next, within one call. */
interface PartialState {
    /** Roots that the call still loads. A refresh drops a root that the backend no longer holds. */
    liveRoots: string[];
    /** Ids that the last load held, or undefined before the first load. */
    held: Set<string> | undefined;
    /** Ids that the last load held as ancestors only. */
    ancestorIds: Set<string>;
    /** Shapes and ancestors of the last load, for the partial-page warning. */
    summary: { shapes: number; ancestors: string[] } | undefined;
}

/** Thrown when the backend does not hold a root that a partial load names. */
class MissingRootError extends Error {
    /**
     * Creates the error.
     *
     * @param message - text that names the root
     */
    constructor(message: string) {
        super(message);
        this.name = "MissingRootError";
    }
}

/** A shape that a page load holds, as the backend returned it and as the JSON text the guest receives. */
interface FetchedShape {
    /** The shape as the backend returned it; its child list is cut to the loaded shapes before the text is taken. */
    shape: { id: string } & Record<string, unknown>;
    /** The JSON text of the shape. */
    text: string;
}

/** The shapes that a page load hands to the guest, and the counts that its warnings report. */
interface LoadedParts {
    /** JSON text of each shape, in the order the guest receives them. */
    pieces: string[];
    /** Shapes that the load covers: every id of a whole-page tree, or every shape of a partial load. */
    count: number;
    /** Ids of the page tree that the backend did not return. */
    missing: number;
}

/** The revn of the reads of one page load. The first answer sets it, and every later answer must match it. */
interface LoadRead {
    /** The revn that the reads agreed on, or undefined before the first answer. */
    revn: number | undefined;
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
    /**
     * Most `get-mcp-shapes` calls of one partial load that run at the same time. The backend lets one profile run 4
     * MCP reads at once and all profiles 8 (`:mcp-read/by-profile` and `:mcp-read/global` in `climit.edn`), so 2 leave
     * the user's other reads, and half of the global permits, free.
     */
    private static readonly MAX_IN_FLIGHT = 2;
    /** Most rounds of `get-mcp-shapes` calls that one partial load makes before it gives up. */
    private static readonly MAX_SUBTREE_ROUNDS = 100;
    /**
     * A whole-page load is refused at once when the estimate of its size is above the cap times this margin. The
     * backend estimate is within 0.7 to 1.3 times the real size, so a page that fits is never refused by it.
     */
    private static readonly ESTIMATE_MARGIN = 1.3;
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
    /** Most roots that one partial page takes. */
    private static readonly MAX_ROOTS = 20;
    /** Id of the page root, which the backend names with the nil uuid. It is loaded with every page. */
    private static readonly PAGE_ROOT_ID = "00000000-0000-0000-0000-000000000000";
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
        "get-mcp-subtree",
        "get-mcp-interactions",
        "find-mcp-connectors",
        "get-mcp-fonts",
        "get-mcp-page-lint",
        "find-mcp-similar-boards",
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
    /** Gives the slot of the script back during a rate-limit wait; set by the tool. */
    private waitHook: (() => () => Promise<void>) | undefined = undefined;
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
    /** The roots of the call, when the call has them. */
    private readonly scope: PartialScope | undefined;
    /** The partial state of the scoped page, from its first load. */
    private readonly partial: PartialState | undefined;
    /** Ids that the imports of this call answered as their root and as shapes. */
    private readonly importedIds = new Set<string>();

    /**
     * Creates a host bound to one MCP token.
     *
     * @param services - backend, write queue and other shared services
     * @param userToken - MCP token the sandbox acts with, already validated by the caller
     * @param maxHostCalls - most primitive calls one script may make
     * @param maxPageBytes - cap of the page data of one call, in bytes
     * @param scope - the roots of the call, or undefined when every page loads whole
     */
    constructor(
        private readonly services: BackendServices,
        private readonly userToken: string,
        private readonly maxHostCalls: number = 1000,
        private readonly maxPageBytes: number = SandboxSettings.DEFAULT_MAX_PAGE_MB * 1024 * 1024,
        scope?: PartialScope
    ) {
        this.tokenDigest = TokenDigest.sha256Hex(userToken);
        this.scope = scope;
        this.partial =
            scope === undefined
                ? undefined
                : {
                      liveRoots: [...scope.rootIds],
                      held: undefined,
                      ancestorIds: new Set<string>(),
                      summary: undefined,
                  };
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
        const warnings: unknown[] = [...this.warnings];
        if (this.scope !== undefined && this.partial?.summary !== undefined) {
            // the warning is worded at the end of the call, so that its count is the final one
            warnings.push({
                code: "partial-page",
                pageId: this.scope.pageId,
                rootIds: [...this.scope.rootIds],
                shapes: this.partial.summary.shapes,
                ancestors: [...this.partial.summary.ancestors],
            });
        }
        return {
            opsApplied: this.opsApplied,
            flushes: this.flushes,
            chunks: this.chunks,
            revn: this.lastRevn,
            warnings,
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
     * Checks the roots of a partial page, and removes the repeats.
     *
     * @param fileId - file that holds the page
     * @param pageId - the page whose roots these are
     * @param rootIds - shape ids the call names as roots, in the order given
     * @returns the scope of the call
     * @throws Error when there are not 1 to 20 distinct roots, or the page root is named
     */
    public static partialScope(fileId: string, pageId: string, rootIds: readonly string[]): PartialScope {
        const unique = [...new Set(rootIds)];
        if (unique.includes(SandboxHost.PAGE_ROOT_ID)) {
            throw new Error(
                "execute_code: rootIds cannot name the page root; leave rootIds out to load the whole page"
            );
        }
        if (unique.length < 1 || unique.length > SandboxHost.MAX_ROOTS) {
            throw new Error(
                `execute_code takes 1 to ${SandboxHost.MAX_ROOTS} rootIds; this call gives ${unique.length}`
            );
        }
        return { fileId, pageId, rootIds: unique };
    }

    /**
     * Reads the shapes of one page and returns them as JSON text.
     *
     * A page that is not the scoped page of the call loads whole: the page tree is walked up to 20 levels, then the
     * shapes are fetched in batches of 200 ids and keep the order of the tree. The scoped page loads its roots (see
     * {@link loadPartial}). Every page of the tree and every batch must report the same revn. A page that is loaded
     * again in the same call replaces its earlier copy and does not count twice against the page cap.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @returns JSON text of `{ revn, pageId, fileId, shapes }`, with `partial: true` for the scoped page
     * @throws Error when the call already loaded 20 distinct pages, the first load misses a root, the file changed
     *   while it was read, or the loaded shapes would exceed the page cap
     */
    public async loadPage(fileId: string, pageId: string): Promise<string> {
        this.countPrimitive(false);
        const key = `${fileId}\n${pageId}`;
        const isNew = !this.pageBytes.has(key);
        if (isNew && this.pageBytes.size >= SandboxHost.MAX_PAGE_LOADS) {
            throw new Error("execute_code loads at most 20 pages per script");
        }
        const partial = this.partialFor(fileId, pageId);
        // a first partial load takes one rate-limit token per root; every other load takes one token
        await this.admitCalls(partial !== undefined && isNew ? partial.liveRoots.length : 1);

        const read: LoadRead = { revn: undefined };
        const deepest = { dropped: false };
        const parts =
            partial === undefined
                ? await this.loadWhole(fileId, pageId, read, deepest)
                : await this.loadPartial(fileId, pageId, partial, read);
        const text =
            '{"revn":' +
            String(read.revn ?? null) +
            ',"pageId":' +
            JSON.stringify(pageId) +
            ',"fileId":' +
            JSON.stringify(fileId) +
            ',"shapes":[' +
            parts.pieces.join(",") +
            "]" +
            (partial === undefined ? "" : ',"partial":true') +
            "}";
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > this.maxPageBytes) {
            throw this.pageTooLarge(pageId, parts.count, bytes, partial !== undefined);
        }
        const others = this.loadedBytes() - (this.pageBytes.get(key) ?? 0);
        if (others + bytes > this.maxPageBytes) {
            throw new Error(this.pagesTooLarge());
        }
        this.pageBytes.set(key, bytes);
        if (isNew) {
            this.noteDroppedShapes(fileId, pageId, deepest.dropped, parts.missing);
        }
        this.lastRevn = read.revn ?? null;
        return text;
    }

    /**
     * Returns the partial state of the call when the page is the scoped page of the call.
     *
     * @param fileId - file of the page
     * @param pageId - page to read
     * @returns the partial state, or undefined for a page that loads whole
     */
    private partialFor(fileId: string, pageId: string): PartialState | undefined {
        const scope = this.scope;
        if (this.partial === undefined || scope === undefined || scope.fileId !== fileId || scope.pageId !== pageId) {
            return undefined;
        }
        return this.partial;
    }

    /**
     * Reads the whole page: its tree, then the shapes of the tree in tree order.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @param read - receives the revn of the reads
     * @param deepest - receives `dropped` when a node below the depth limit has children
     * @returns the JSON text of each shape that the backend returned, in tree order
     * @throws Error when the page is too large to hold
     */
    private async loadWhole(
        fileId: string,
        pageId: string,
        read: LoadRead,
        deepest: { dropped: boolean }
    ): Promise<LoadedParts> {
        const ids = new Set<string>();
        await this.readTree(fileId, pageId, undefined, ids, deepest, read, (first) => {
            // the first window carries the size of the whole page: a page far above the cap is refused before the
            // rest of its tree is read.
            if (
                first.totalShapes !== undefined &&
                first.estimatedBytes !== undefined &&
                first.estimatedBytes > this.maxPageBytes * SandboxHost.ESTIMATE_MARGIN
            ) {
                throw this.pageTooLarge(pageId, first.totalShapes, first.estimatedBytes, false, true);
            }
        });
        // each shape is serialised once; the page text is then joined from those pieces.
        const allIds = [...ids];
        const fetched = new Map<string, FetchedShape>();
        await this.fetchShapes(fileId, pageId, allIds, read, fetched, (done, bytes) =>
            this.checkEstimate(pageId, allIds.length, done, bytes, false)
        );
        // keep the tree order; ids that the backend did not return are skipped and reported.
        const pieces = allIds.flatMap((id) => {
            const held = fetched.get(id);
            return held === undefined ? [] : [held.text];
        });
        return { pieces, count: allIds.length, missing: allIds.length - pieces.length };
    }

    /**
     * Reads the part of the scoped page that the roots name, and the shapes that the call needs to see the page as it
     * is now.
     *
     * The subtree of each root is read in the order of the roots, and a root inside another root adds nothing new. A
     * node at the depth limit that has children the reply does not carry starts another tree call of its own, so a
     * deep subtree loads whole. On a refresh, a root that the backend no longer holds is dropped from the call. Then
     * come the shapes that this call created or imported, with the children they hold; the shapes that the last load
     * held and that no root holds now, which the backend answers as present or deleted; and the ancestors of all of
     * these, up to the page root, which is always loaded. An ancestor that is not under a root is marked
     * `ancestorOnly`, and a shape whose child list is cut to the loaded ids is marked `partialChildren`, with the real
     * count in `childCount`.
     *
     * The result is in document order: the page root, the ancestors, the subtrees in the order of the roots, the
     * created shapes, then the shapes the last load held.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @param state - the partial state of the call; its roots and totals are updated
     * @param read - receives the revn of the reads
     * @returns the JSON text of each loaded shape, in document order
     * @throws Error when the first load misses a root, or the page is too large to hold
     */
    private async loadPartial(
        fileId: string,
        pageId: string,
        state: PartialState,
        read: LoadRead
    ): Promise<LoadedParts> {
        const refresh = state.held !== undefined;
        // the roots with their subtrees, and their ancestors, come from `get-mcp-shapes` rounds
        const pool = new Map<string, FetchedShape>();
        const tree = await this.fetchSubtrees(fileId, pageId, state.liveRoots, read, pool);
        const dropped = new Set<string>();
        for (const rootId of state.liveRoots) {
            if (pool.has(rootId)) {
                continue;
            }
            if (!refresh) {
                throw new Error(`execute_code: root shape ${rootId} is not a shape of page ${pageId}`);
            }
            dropped.add(rootId);
        }
        if (dropped.size > 0) {
            state.liveRoots = state.liveRoots.filter((id) => !dropped.has(id));
        }
        // what is left in the pool is not under a root: the ancestors that the first call returned
        const fetched = new Map<string, FetchedShape>();
        for (const id of tree) {
            fetched.set(id, pool.get(id) as FetchedShape);
            pool.delete(id);
        }

        // the shapes that this call created or imported, and the children that they hold
        const created: string[] = [];
        let pendingCreated = this.createdShapeIds().filter((id) => !fetched.has(id));
        while (pendingCreated.length > 0) {
            const stored = await this.fetchShapes(fileId, pageId, pendingCreated, read, fetched);
            created.push(...stored);
            const next = new Set<string>();
            for (const id of stored) {
                for (const child of SandboxHost.childIdsOf(fetched.get(id)?.shape)) {
                    if (!fetched.has(child)) {
                        next.add(child);
                    }
                }
            }
            pendingCreated = [...next];
        }

        // the shapes the last load held that no root holds now: moved out of the roots, or deleted (then missing)
        const moved: string[] = [];
        const movedAncestors: string[] = [];
        if (state.held !== undefined) {
            const held = state.held;
            const candidates = [...held].filter((id) => !fetched.has(id) && id !== SandboxHost.PAGE_ROOT_ID);
            // the ancestors that the roots call returned are in the pool already; the rest are asked for
            await this.fetchShapes(
                fileId,
                pageId,
                candidates.filter((id) => !pool.has(id)),
                read,
                pool
            );
            for (const id of candidates) {
                const kept = pool.get(id);
                if (kept !== undefined) {
                    fetched.set(id, kept);
                    pool.delete(id);
                    (state.ancestorIds.has(id) ? movedAncestors : moved).push(id);
                }
            }
        }

        // the ancestors of everything loaded, up to the page root, which is always loaded. They come level by level,
        // nearest first. The first call of a first load returned the ancestors of the roots already; only the parents
        // of other shapes (created, imported) cost a call.
        const ancestors: string[] = [];
        const seen = new Set([...fetched.keys(), SandboxHost.PAGE_ROOT_ID]);
        let level = SandboxHost.parentsOf(SandboxHost.shapesOf([...fetched.keys()], fetched), seen);
        let withRoot = true;
        while (level.length > 0 || withRoot) {
            const wanted = withRoot ? [...level, SandboxHost.PAGE_ROOT_ID] : level;
            withRoot = false;
            const absent = wanted.filter((id) => !fetched.has(id) && !pool.has(id));
            await this.fetchShapes(fileId, pageId, absent, read, pool);
            const stored = wanted.filter((id) => pool.has(id));
            for (const id of stored) {
                fetched.set(id, pool.get(id) as FetchedShape);
                pool.delete(id);
                seen.add(id);
            }
            ancestors.push(...stored);
            level = SandboxHost.parentsOf(SandboxHost.shapesOf(stored, fetched), seen);
        }

        const ancestorOnly = new Set([...ancestors, ...movedAncestors].filter((id) => id !== SandboxHost.PAGE_ROOT_ID));
        const order = [...new Set([SandboxHost.PAGE_ROOT_ID, ...ancestorOnly, ...tree, ...created, ...moved])].filter(
            (id) => fetched.has(id)
        );
        const loaded = new Set(order);
        const pieces: string[] = [];
        for (const id of order) {
            const held = fetched.get(id);
            if (held === undefined) {
                continue;
            }
            const shape = held.shape;
            if (ancestorOnly.has(id)) {
                shape.ancestorOnly = true;
            }
            // an ancestor is partial by definition: its subtree was not loaded whole, even when no child id is cut
            const stub = ancestorOnly.has(id) || id === SandboxHost.PAGE_ROOT_ID;
            if (Array.isArray(shape.shapes)) {
                const children: unknown[] = shape.shapes;
                const kept = children.filter(
                    (child): child is string => typeof child === "string" && loaded.has(child)
                );
                if (stub || kept.length < children.length) {
                    shape.partialChildren = true;
                    shape.childCount = children.length;
                    shape.shapes = kept;
                }
            }
            held.text = JSON.stringify(shape);
            pieces.push(held.text);
        }

        state.held = new Set(order);
        state.ancestorIds = ancestorOnly;
        state.summary = {
            shapes: order.filter((id) => id !== SandboxHost.PAGE_ROOT_ID && !ancestorOnly.has(id)).length,
            ancestors: [...ancestorOnly],
        };
        return { pieces, count: order.length, missing: 0 };
    }

    /**
     * Adds the ids of one page tree, from a root or from the page root, to a set, and records the revn of the reads.
     * Each page of the tree is read with its cursor.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @param rootId - root of the tree, or undefined for the page root
     * @param ids - receives the ids in document order, without repeats
     * @param walk - receives `dropped` for a node cut at the limit of a whole walk, and `cut` for the nodes that a
     *   partial walk must continue from
     * @param read - the revn of the reads, checked against each answer
     * @param onFirst - when given, the first window asks for the size estimate of the page (`estimateSize`), and this
     *   runs with that window before the next one is read; it may throw to stop the walk
     * @throws Error when the file changed between the pages, or a truncated page has no cursor
     */
    private async readTree(
        fileId: string,
        pageId: string,
        rootId: string | undefined,
        ids: Set<string>,
        walk: { dropped: boolean; cut?: string[] },
        read: LoadRead,
        onFirst?: (first: PageTreeResult) => void
    ): Promise<void> {
        let cursor: string | undefined;
        let isFirst = true;
        do {
            const params: Record<string, unknown> = {
                fileId,
                pageId,
                depth: SandboxHost.TREE_DEPTH,
                limit: SandboxHost.TREE_LIMIT,
            };
            if (rootId !== undefined) {
                params.rootId = rootId;
            }
            if (cursor !== undefined) {
                params.cursor = cursor;
            } else if (onFirst !== undefined) {
                params.estimateSize = true;
            }
            const page = await this.callTree(pageId, rootId, params);
            read.revn = this.checkRevn(read.revn, page.revn);
            if (isFirst) {
                isFirst = false;
                onFirst?.(page);
            }
            this.collectIds(page.root, ids, 1, walk);
            if (page.truncated && page.nextCursor === undefined) {
                throw new Error("get-mcp-page-tree reported a truncated page without a cursor");
            }
            cursor = page.truncated ? page.nextCursor : undefined;
        } while (cursor !== undefined);
    }

    /**
     * Calls `get-mcp-page-tree`, and marks an answer that a root is missing from the page.
     *
     * @param pageId - page that the tree is read from
     * @param rootId - root of the tree, or undefined for the page root
     * @param params - parameters of the call
     * @returns the page of the tree
     * @throws MissingRootError that names the root when the page does not hold it; any other backend error as it is
     */
    private async callTree(
        pageId: string,
        rootId: string | undefined,
        params: Record<string, unknown>
    ): Promise<PageTreeResult> {
        try {
            return await this.services.backend.callCommand<PageTreeResult>(this.userToken, "get-mcp-page-tree", params);
        } catch (error) {
            if (rootId !== undefined && error instanceof BackendRpcError && error.code === "shape-not-found") {
                throw new MissingRootError(`execute_code: root shape ${rootId} is not a shape of page ${pageId}`);
            }
            throw error;
        }
    }

    /**
     * Fetches shapes by id, in batches, and stores each one with its JSON text. A reply that the backend cut short is
     * asked again for the ids it neither answered nor listed as missing.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @param ids - ids to fetch, in the order to fetch them
     * @param read - the revn of the reads, checked against each answer
     * @param into - receives the shapes by id; a shape fetched again replaces its earlier copy
     * @param onBatch - runs after each batch with the number of ids read so far and the bytes of the texts stored
     * @returns the ids that were not in `into` before this call and were returned by the backend
     * @throws Error when a cut reply answers none of the ids it was asked for
     */
    private async fetchShapes(
        fileId: string,
        pageId: string,
        ids: string[],
        read: LoadRead,
        into: Map<string, FetchedShape>,
        onBatch?: (done: number, bytes: number) => void
    ): Promise<string[]> {
        const stored: string[] = [];
        let bytes = 0;
        for (let start = 0; start < ids.length; start += SandboxHost.SHAPE_BATCH_SIZE) {
            const batch = ids.slice(start, start + SandboxHost.SHAPE_BATCH_SIZE);
            let pending = batch;
            while (pending.length > 0) {
                const result = await this.services.backend.callCommand<ShapesResult>(this.userToken, "get-mcp-shapes", {
                    fileId,
                    pageId,
                    ids: pending,
                    includeChildren: false,
                });
                read.revn = this.checkRevn(read.revn, result.revn);
                const answered = new Set<string>();
                for (const shape of result.shapes) {
                    const text = JSON.stringify(shape);
                    bytes += Buffer.byteLength(text, "utf8");
                    answered.add(shape.id);
                    if (!into.has(shape.id)) {
                        stored.push(shape.id);
                    }
                    into.set(shape.id, { shape, text });
                }
                const listed = new Set(result.missing ?? []);
                const unanswered = pending.filter((id) => !answered.has(id) && !listed.has(id));
                const again = result.truncated === true ? unanswered : [];
                if (again.length > 0 && again.length === pending.length) {
                    throw new Error("get-mcp-shapes answered none of the shapes asked for, so the load cannot finish");
                }
                pending = again;
            }
            onBatch?.(start + batch.length, bytes);
        }
        return stored;
    }

    /**
     * Stops a whole-page or partial load whose first batches show that its shapes are clearly above the cap.
     *
     * @param pageId - the page
     * @param total - shapes the load will fetch
     * @param done - shapes fetched so far
     * @param bytes - bytes of the shapes fetched so far
     * @param partial - whether the load is partial, which changes the advice of the error
     * @throws Error when the estimate of the load is above the cap and shapes remain to be fetched
     */
    private checkEstimate(pageId: string, total: number, done: number, bytes: number, partial: boolean): void {
        const estimate = Math.round((bytes / done) * total);
        if (done < total && estimate > this.maxPageBytes) {
            throw this.pageTooLarge(pageId, total, estimate, partial);
        }
    }

    /**
     * Returns the ids of the shapes that this call created or imported, which a partial load fetches by id.
     *
     * @returns the distinct ids
     */
    private createdShapeIds(): string[] {
        return [...new Set([...Object.values(this.createdIds), ...this.importedIds])];
    }

    /**
     * Returns the child ids that a shape lists.
     *
     * @param shape - the shape, or undefined
     * @returns the child ids in stored order; empty when the shape lists none
     */
    private static childIdsOf(shape: Record<string, unknown> | undefined): string[] {
        const children = shape?.shapes;
        return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : [];
    }

    /**
     * Returns the parent id of a shape as the backend gives it.
     *
     * @param shape - the shape
     * @returns the parent id, or undefined when the shape has none
     */
    private static parentIdOf(shape: Record<string, unknown>): string | undefined {
        const parent = shape.parentId;
        return typeof parent === "string" ? parent : undefined;
    }

    /**
     * Returns the shapes that the given ids name, when they are loaded.
     *
     * @param ids - ids of shapes
     * @param fetched - the loaded shapes by id
     * @returns the shapes that are loaded, in the order of `ids`
     */
    private static shapesOf(ids: string[], fetched: Map<string, FetchedShape>): Record<string, unknown>[] {
        return ids.flatMap((id) => {
            const held = fetched.get(id);
            return held === undefined ? [] : [held.shape];
        });
    }

    /**
     * Returns the parents of the given shapes that are not in a set, other than the page root, without repeats.
     *
     * @param shapes - shapes whose parents are wanted
     * @param seen - ids that need no fetch: the loaded shapes and the page root
     * @returns the parent ids, in the order they are first met
     */
    private static parentsOf(shapes: Record<string, unknown>[], seen: ReadonlySet<string>): string[] {
        const parents = new Set<string>();
        for (const shape of shapes) {
            const parent = SandboxHost.parentIdOf(shape);
            if (parent !== undefined && parent !== SandboxHost.PAGE_ROOT_ID && !seen.has(parent)) {
                parents.add(parent);
            }
        }
        return [...parents];
    }

    /**
     * Returns the child ids of a shape in the order of the page tree: the stored order, reversed for a flex or grid
     * board, whose children are stored in the reverse of their visual order (`shape-children` in `mcp.clj`).
     *
     * @param shape - the shape
     * @returns the child ids in tree order
     */
    private static treeChildrenOf(shape: Record<string, unknown>): string[] {
        const children = SandboxHost.childIdsOf(shape);
        const stacked = shape.type === "frame" && (shape.layout === "flex" || shape.layout === "grid");
        return stacked ? children.reverse() : children;
    }

    /**
     * Walks the loaded shapes from the roots in the order of the page tree: each root in turn, a shape before its
     * children, each shape once.
     *
     * @param roots - ids to start from, in order
     * @param loaded - the shapes that are loaded
     * @param reported - ids that the backend reported as missing
     * @param asked - ids that a reply has returned after a request that named them with their children
     * @returns `order`, the loaded ids reached; `absent`, the ids reached that are neither loaded nor reported missing,
     *   in the order they are met; and `ask`, the ids to request for them: a loaded shape that no reply has returned after such a request
     *   and none of whose children is loaded stands for all its children, so that one call brings the children and
     *   what is below them, and any other absent id stands for itself
     */
    private static walkSubtrees(
        roots: readonly string[],
        loaded: ReadonlyMap<string, FetchedShape>,
        reported: ReadonlySet<string>,
        asked: ReadonlySet<string>
    ): { order: string[]; absent: string[]; ask: string[] } {
        const order: string[] = [];
        const absent = new Set<string>();
        const ask = new Set<string>();
        const covered = new Set<string>();
        const seen = new Set<string>();
        for (const root of roots) {
            const stack = [root];
            while (stack.length > 0) {
                const id = stack.pop() as string;
                if (seen.has(id)) {
                    continue;
                }
                const held = loaded.get(id);
                if (held === undefined) {
                    if (!reported.has(id)) {
                        absent.add(id);
                        if (!covered.has(id)) {
                            ask.add(id);
                        }
                    }
                    continue;
                }
                seen.add(id);
                order.push(id);
                const children = SandboxHost.treeChildrenOf(held.shape);
                if (
                    children.length > 0 &&
                    !asked.has(id) &&
                    children.every((child) => !loaded.has(child) && !reported.has(child))
                ) {
                    ask.add(id);
                    for (const child of children) {
                        covered.add(child);
                    }
                }
                for (let index = children.length - 1; index >= 0; index -= 1) {
                    stack.push(children[index]);
                }
            }
        }
        return { order, absent: [...absent], ask: [...ask] };
    }

    /**
     * Splits the ids of a round of a partial load into calls of at most {@link SHAPE_BATCH_SIZE} ids, the most one
     * request takes. A round with fewer ids is one call: the backend cap of a reply, not the count of ids, limits
     * what a call returns, so more calls would only cost more.
     *
     * @param ids - the ids to ask for
     * @returns the ids of each call, in order
     */
    private static splitIds(ids: string[]): string[][] {
        const parts: string[][] = [];
        for (let start = 0; start < ids.length; start += SandboxHost.SHAPE_BATCH_SIZE) {
            parts.push(ids.slice(start, start + SandboxHost.SHAPE_BATCH_SIZE));
        }
        return parts;
    }

    /**
     * Runs an async function over the items with at most `limit` runs at the same time.
     *
     * @param items - the items
     * @param limit - most runs at the same time
     * @param run - the function; it gets the item and its index
     * @returns the results, in the order of the items
     * @throws the first error of a run; runs that have not started do not start
     */
    private static async mapLimited<T, R>(
        items: readonly T[],
        limit: number,
        run: (item: T, index: number) => Promise<R>
    ): Promise<R[]> {
        const results: R[] = new Array<R>(items.length);
        let next = 0;
        let failed = false;
        const worker = async (): Promise<void> => {
            while (!failed && next < items.length) {
                const index = next;
                next += 1;
                try {
                    results[index] = await run(items[index], index);
                } catch (error) {
                    failed = true;
                    throw error;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
        return results;
    }

    /**
     * Reads the roots of a partial load with their subtrees, in rounds of `get-mcp-shapes` calls.
     *
     * Round one is one call that names every root with `includeChildren` and `includeAncestors`.
     * The backend answers a shape, then all its children in stored order, then for each child its own children and
     * theirs by the same rule, up to its cap of shapes and bytes, and sets `truncated` when it cut the reply. So a cut
     * can leave the children of a shape whose first children are loaded. After each round the shapes are walked in
     * tree order from the roots; what the walk reaches and nobody holds is asked for in the next round, as roots of
     * their own, split over up to {@link MAX_IN_FLIGHT} calls at the same time. A loaded shape that no reply has
     * returned for a request of its own yet and none of whose children is loaded is asked for in the place of its children (one id, and its
     * subtree comes with it); any other absent id is asked for by id. A round that only repeated such a shape and
     * brought nothing new is not an error: the shape counts as reached, and its children are asked for by id in
     * the next round. The size cap is checked at each reply, on the running total of the bytes of the shapes the load has
     * received, and again after each round on the shapes under the roots. A reply that passes the cap stops the load:
     * no later call starts, and the calls in flight are ignored. The ids that the backend reports as missing are dropped.
     *
     * @param fileId - file that holds the page
     * @param pageId - page to read
     * @param roots - the roots, in order
     * @param read - the revn of the reads, checked against each answer
     * @param pool - receives every shape the backend returned, the ancestors included
     * @returns the ids under the roots in tree order, each once; a root that the backend does not hold is not in it
     * @throws Error when the cap is passed, a round brings nothing new, or the rounds do not end
     */
    private async fetchSubtrees(
        fileId: string,
        pageId: string,
        roots: readonly string[],
        read: LoadRead,
        pool: Map<string, FetchedShape>
    ): Promise<string[]> {
        const reported = new Set<string>();
        let frontier = [...roots];
        const asked = new Set<string>();
        // shapes whose reply bytes the running total already holds, and that total
        const counted = new Set<string>();
        let replyBytes = 0;
        let order: string[] = [];
        for (let round = 0; frontier.length > 0; round += 1) {
            if (round >= SandboxHost.MAX_SUBTREE_ROUNDS) {
                throw new Error(
                    `get-mcp-shapes did not return the shapes of page ${pageId} in ` +
                        `${SandboxHost.MAX_SUBTREE_ROUNDS} rounds, so the load cannot finish`
                );
            }
            const parts = round === 0 ? [frontier] : SandboxHost.splitIds(frontier);
            const known = pool.size + reported.size;
            // a loaded shape in the request stands for its children; a round that only repeats it is not stuck
            const stood = round > 0 && frontier.some((id) => pool.has(id));
            const sent = new Set(frontier);
            const replies = await SandboxHost.mapLimited(parts, SandboxHost.MAX_IN_FLIGHT, async (ids) => {
                const reply = await this.services.backend.callCommand<ShapesResult>(this.userToken, "get-mcp-shapes", {
                    fileId,
                    pageId,
                    ids,
                    includeChildren: true,
                    ...(round === 0 ? { includeAncestors: true } : {}),
                });
                // the cap is checked at each reply: a call that crosses it stops the load, and no later call starts
                const texts = new Map<string, string>();
                for (const shape of reply.shapes) {
                    const text = JSON.stringify(shape);
                    texts.set(shape.id, text);
                    if (!counted.has(shape.id)) {
                        counted.add(shape.id);
                        replyBytes += Buffer.byteLength(text, "utf8");
                    }
                }
                if (replyBytes > this.maxPageBytes) {
                    throw this.pageTooLarge(pageId, counted.size, replyBytes, true);
                }
                return { reply, texts };
            });
            for (const { reply, texts } of replies) {
                read.revn = this.checkRevn(read.revn, reply.revn);
                for (const shape of reply.shapes) {
                    pool.set(shape.id, { shape, text: texts.get(shape.id) as string });
                    if (sent.has(shape.id)) {
                        // the reply reached this shape, so its children were in the cut
                        asked.add(shape.id);
                    }
                }
                for (const id of reply.missing ?? []) {
                    reported.add(id);
                }
            }
            if (pool.size + reported.size === known && !stood) {
                throw new Error("get-mcp-shapes answered none of the shapes asked for, so the load cannot finish");
            }
            const walk = SandboxHost.walkSubtrees(roots, pool, reported, asked);
            order = walk.order;
            frontier = walk.ask;
            let bytes = 0;
            for (const id of order) {
                bytes += Buffer.byteLength((pool.get(id) as FetchedShape).text, "utf8");
            }
            const total = order.length + walk.absent.length;
            if (bytes > this.maxPageBytes) {
                throw this.pageTooLarge(pageId, total, bytes, true);
            }
            if (order.length > 0) {
                this.checkEstimate(pageId, total, order.length, bytes, true);
            }
        }
        return order;
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
            this.noteImported(result);
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
        // the caller's global slot is given back while this waits, so other tokens' scripts can run
        let resume: (() => Promise<void>) | undefined = undefined;
        for (;;) {
            try {
                await this.services.rateLimiter.acquire(this.userToken);
                // a resume that fails is yielded again on the next attempt, so each yield gets exactly one resume
                const resumeNow = resume;
                resume = undefined;
                await resumeNow?.();
                return;
            } catch {
                if (Date.now() + SandboxHost.RATE_RETRY_MS >= this.deadlineAt) {
                    throw new Error(SandboxHost.WALL_CLOCK_MESSAGE);
                }
                resume ??= this.waitHook?.();
                await new Promise<void>((resolve) => setTimeout(resolve, SandboxHost.RATE_RETRY_MS));
            }
        }
    }

    /**
     * Sets the hook that a rate-limit wait calls to give back the slot of the script.
     *
     * @param hook - gives the slot back and returns the function that takes it again
     */
    public setWaitHook(hook: (() => () => Promise<void>) | undefined): void {
        this.waitHook = hook;
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
     * A node that has no children in the reply, though its `childCount` says it has some, is cut. A whole walk
     * notes such a node at the depth limit as dropped. A partial walk records it in `cut`, so that it continues from it.
     *
     * @param node - the node to walk
     * @param ids - ids collected so far, in document order
     * @param depth - depth of the node, from 1
     * @param walk - receives `dropped` or `cut`, as described above
     */
    private collectIds(
        node: TreeNode,
        ids: Set<string>,
        depth: number,
        walk: { dropped: boolean; cut?: string[] }
    ): void {
        ids.add(node.id);
        const children = node.children ?? [];
        if (walk.cut !== undefined) {
            // a partial walk goes on from a node whose children the reply does not carry
            if (children.length === 0 && (node.childCount ?? 0) > 0) {
                walk.cut.push(node.id);
            }
        } else if (depth >= SandboxHost.TREE_DEPTH && (children.length > 0 || (node.childCount ?? 0) > 0)) {
            walk.dropped = true;
        }
        for (const child of children) {
            this.collectIds(child, ids, depth + 1, walk);
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
     * Notes the ids that an import answered, so that a partial load fetches them as created shapes.
     *
     * @param result - the answer of the import
     */
    private noteImported(result: unknown): void {
        if (!SandboxHost.isRecord(result)) {
            return;
        }
        if (typeof result.rootId === "string") {
            this.importedIds.add(result.rootId);
        }
        if (Array.isArray(result.shapeIds)) {
            for (const id of result.shapeIds) {
                if (typeof id === "string") {
                    this.importedIds.add(id);
                }
            }
        }
    }

    /**
     * Words the error of one page, or of the shapes of one load, that is above the cap.
     *
     * @param pageId - the page
     * @param shapes - shapes that the load holds, or that a whole load would hold
     * @param bytes - size of the loaded shapes as JSON, or the estimate of it
     * @param partial - whether the load is partial; then the advice is to pass fewer or smaller rootIds
     * @param estimated - whether the size is an estimate, and not the measured size of shapes already loaded
     * @returns the error, which names the page, its size and shape count, the limit and the way out
     */
    private pageTooLarge(pageId: string, shapes: number, bytes: number, partial: boolean, estimated = false): Error {
        const megabytes = (bytes / (1024 * 1024)).toFixed(1);
        const limit = Number((this.maxPageBytes / (1024 * 1024)).toFixed(1));
        const advice = partial
            ? "Pass fewer or smaller rootIds, or use export_subtree, get_shapes and find_shapes for reads."
            : "Pass rootIds to load only the boards the script needs, or use export_subtree, get_shapes and find_shapes for reads.";
        return new Error(
            `page ${pageId} has ${shapes} shapes (${estimated ? "estimated at " : ""}about ${megabytes} MB); the limit is ${limit} MB ` +
                `(PENPOT_MCP_SANDBOX_PAGE_MB). ${advice}`
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
