import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendRpcError } from "../../backend/BackendRpcError";
import { CallContext } from "../../backend/CallContext";
import { ExportDirectory } from "../../utils/ExportDirectory";
import { FileUtils } from "../../utils/FileUtils";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";
import { FilePathAccess } from "./FilePathAccess";

/** Id of the page root, which the backend uses as the root of a whole page. */
const PAGE_ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Shapes per window when the caller names no limit. */
const DEFAULT_LIMIT = 100;

/** Share of the response cap that one window may fill, so that the reply fits the cap with its own fields. */
const WINDOW_SHARE = 0.8;

/** Smallest byte limit the backend accepts for a window. */
const MIN_WINDOW_BYTES = 1000;

/** Largest byte limit the backend accepts for a window. */
const MAX_WINDOW_BYTES = 1_000_000;

/** Size of one window as the backend is asked for it. */
interface WindowSize {
    /** Most shapes in the window. */
    limit: number;
    /** Most encoded bytes in the window. */
    maxBytes: number;
}

/**
 * Window of file mode: the largest the backend takes. The response cap limits what goes back to the client, not what
 * is written to disk, so a file walk is not held to the inline size.
 */
const FILE_WINDOW: WindowSize = { limit: 5000, maxBytes: MAX_WINDOW_BYTES };

/** Backend error code of a cursor whose page version is no longer the current one. */
const STALE_CURSOR = "mcp-stale-cursor";

/** File name extensions that a subtree file may have. */
const FILE_EXTENSIONS = [".json"];

/** Attributes that are cut first when one shape alone is larger than the response cap. */
const TRIM_FIRST = ["content", "positionData", "shapes"];

/** Other strings and arrays above this many bytes are cut next, largest first. */
const OVERSIZE_BYTES = 2000;

/** Note that goes with a trimmed shape in an inline reply. */
const OVERSIZE_NOTE =
    "The full shape is larger than the response cap, so its large attributes are shown as omitted. " +
    "Write the subtree to a file with filePath to get every attribute, " +
    "or read one attribute with get_shapes and fields.";

/** Arguments of {@link ExportSubtreeTool}. */
export class ExportSubtreeArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page that holds the shapes, from get_file_outline."),
        rootId: BackendIds.uuid()
            .optional()
            .describe("Id of the shape whose subtree to export, from get_page_tree. Leave it out for the whole page."),
        cursor: z
            .string()
            .max(4096)
            .optional()
            .describe(
                "nextCursor of an earlier inline response, to read the next window. Not allowed with filePath: " +
                    "the file always holds the whole subtree."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe(
                "Most shapes per window in inline mode (1 to 5000, default 100). A window also stops at about " +
                    "80 % of the cap. Applies to inline mode only: a call with filePath reads 5000 shapes per window."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path to write the whole subtree to, as one JSON file. It must lie inside the export " +
                    "directory (PENPOT_MCP_EXPORT_DIR, or penpot-exports in the home directory by default) and end " +
                    "in .json. When omitted, one window is returned in the response."
            ),
        overwrite: z
            .boolean()
            .optional()
            .describe("When true, replace the file at filePath if one is there. Default false: it is refused."),
    };

    fileId!: string;

    pageId!: string;

    rootId?: string;

    cursor?: string;

    limit?: number;

    filePath?: string;

    overwrite?: boolean;
}

/** One window of the walk, as the backend answers it. */
interface SubtreeWindow {
    /** Revision of the file the window was read at. */
    revn?: number;
    /** Id of the page. */
    pageId?: string;
    /** Id of the root of the walk, or the page root id. */
    rootId?: string;
    /** Number of shapes in the whole walk. */
    total?: number;
    /** Shapes of this window, in walk order. */
    shapes?: unknown[];
    /** True when shapes remain after this window. */
    truncated?: boolean;
    /** Cursor of the next window, present when shapes remain. */
    nextCursor?: string;
}

/** Result of a subtree export to a file. */
interface SubtreeFileResult {
    /** Absolute path of the file. */
    path: string;
    /** Number of shapes written. */
    shapes: number;
    /** Size of the file, in bytes. */
    bytes: number;
    /** Revision of the file the walk read. */
    revn: number | undefined;
    /** Number of windows read in the last walk. */
    windows: number;
}

/** Progress that survives a restart of the walk, so that a count is never reported twice or backwards. */
interface ProgressMark {
    /** Highest number of shapes reported so far. */
    reported: number;
}

/**
 * Returns the JSON size of a value, in UTF-8 bytes.
 *
 * @param value - the value to measure
 */
function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * Tells whether a value is a plain object.
 *
 * @param value - the value to look at
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exports every attribute of every shape under one root as data, in windows, inline or to a JSON file.
 *
 * Without filePath the tool returns one window, fitted to the response cap. With filePath it reads every window and
 * streams one JSON document to the file, so the whole subtree never sits in memory.
 */
export class ExportSubtreeTool extends BackendTool<ExportSubtreeArgs> {
    /** Response cap of this tool, in bytes. */
    private readonly capBytes: number;

    /** Largest byte limit that one inline window asks the backend for, from the response cap of this tool. */
    private readonly windowBytes: number;

    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ExportSubtreeArgs.schema, services);
        this.capBytes = BackendTool.readMaxResponseBytes(process.env);
        this.windowBytes = ExportSubtreeTool.windowBytesFor(this.capBytes);
    }

    /**
     * Marks the tool as one that may write: it writes a file only when filePath is given, and it never deletes data.
     */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: false, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "export_subtree";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        let description =
            "Exports every attribute of every shape under rootId (or the whole page) as data, in windows. " +
            "Each shape carries all its stored attributes, such as content, fills, strokes, shadows, interactions, " +
            "points and transform, plus x, y, width, height, characters for text, depth, index (its place in the " +
            "walk) and worldMatrix (maps the unrotated box to page space). A path's or boolean's content is an SVG " +
            "path string in page space; a text's content is its tree of paragraphs. " +
            "Shapes come in walk order, parents first. " +
            "Without filePath the reply is one window: revn, pageId, rootId, total (shapes in the whole walk), " +
            "shapes, truncated, and nextCursor when shapes remain; " +
            "pass nextCursor as cursor to read the next window. " +
            "A shape too large for the response comes back with its large attributes omitted, and the note says so. ";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description +=
                "With filePath the tool reads every window and writes one JSON file, " +
                "{fileId, pageId, rootId, revn, total, shapes}, to that path. The reply gives path, shapes (count), " +
                "bytes, revn and windows. The path must lie inside the export directory and end in .json, and an " +
                'existing file is refused unless overwrite is true. File names may not contain : < > " | ? *. ';
        } else {
            description += "In multi-user mode file paths are off, so a filePath is refused. ";
        }
        description +=
            "Use it when get_shapes (up to 200 ids) and get_page_tree (no content) are not enough. " +
            "Type names are as the other tools show them: a circle is an ellipse, and a board stays frame. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes for a few shapes by id, or read the file you wrote.";
        return description;
    }

    /**
     * Returns one window as inline JSON, or walks every window into a file.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when filePath is refused, the path is not allowed, a cursor comes with filePath, or the walk fails
     */
    protected async executeBackend(args: ExportSubtreeArgs, userToken: string): Promise<ToolResponse> {
        if (args.filePath === undefined) {
            return this.inlineReply(args, userToken);
        }
        this.checkFilePath(args.filePath, args.overwrite === true);
        if (args.cursor !== undefined) {
            throw new Error("cursor cannot be used with filePath: the file always holds the whole subtree.");
        }
        const result = await this.writeFile(args, userToken, args.filePath, args.overwrite === true);
        return this.jsonResponse(result);
    }

    /**
     * Returns one inline window that fits the response cap. A window too large is cut to fewer shapes; a single shape
     * too large is returned with its large attributes omitted. In every case the reply keeps nextCursor.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    private async inlineReply(args: ExportSubtreeArgs, userToken: string): Promise<ToolResponse> {
        const first = await this.callWindow(userToken, args, args.cursor, this.inlineParams(args));
        if (this.fits(this.callerWindow(first))) {
            return this.jsonResponse(this.callerWindow(first));
        }
        const count = Array.isArray(first?.shapes) ? first.shapes.length : 0;
        if (count > 1) {
            const k = this.largestFittingCount(first, count - 1);
            if (k > 0) {
                const smaller = await this.callWindow(userToken, args, args.cursor, {
                    limit: k,
                    maxBytes: this.windowBytes,
                });
                if (this.fits(this.callerWindow(smaller))) {
                    return this.jsonResponse(this.callerWindow(smaller));
                }
            }
        }
        const single =
            count === 1
                ? first
                : await this.callWindow(userToken, args, args.cursor, { limit: 1, maxBytes: this.windowBytes });
        return this.jsonResponse(this.oneShapeReply(single));
    }

    /**
     * Returns the largest number of leading shapes of a window whose reply fits the response cap.
     *
     * @param window - the window to cut
     * @param high - the largest count to try
     * @returns the count, which is 0 when even one shape does not fit
     */
    private largestFittingCount(window: SubtreeWindow | undefined, high: number): number {
        const shapes = window?.shapes ?? [];
        let low = 0;
        let top = high;
        while (low < top) {
            const middle = Math.ceil((low + top) / 2);
            if (this.fits(this.callerWindow({ ...window, shapes: shapes.slice(0, middle) }))) {
                low = middle;
            } else {
                top = middle - 1;
            }
        }
        return low;
    }

    /**
     * Returns a reply that holds one shape, cut until the reply fits the response cap. The reply lists the cut
     * attributes in `oversize` and keeps nextCursor.
     *
     * @param window - the window that holds the shape
     */
    private oneShapeReply(window: SubtreeWindow | undefined): Record<string, unknown> {
        const reply = this.callerWindow(window);
        const shape = Array.isArray(reply.shapes) ? (reply.shapes[0] as unknown) : undefined;
        if (!isRecord(shape) || this.fits(reply)) {
            return reply;
        }
        const full = jsonBytes(shape);
        const trimmed: Record<string, unknown> = { ...shape };
        const omitted: string[] = [];
        const build = (): Record<string, unknown> => ({
            ...reply,
            shapes: [trimmed],
            oversize: [{ id: shape.id, bytes: full, omitted: [...omitted] }],
            note: OVERSIZE_NOTE,
        });
        for (const key of ExportSubtreeTool.trimOrder(shape)) {
            trimmed[key] = { omitted: true, bytes: jsonBytes(shape[key]) };
            omitted.push(key);
            if (this.fits(build())) {
                break;
            }
        }
        return build();
    }

    /**
     * Lists the attributes of a shape in the order they are cut when it is too large: content, positionData and
     * shapes first, then other strings and arrays above 2 kB, largest first, then the rest, largest first. The id and
     * the type are never cut.
     *
     * @param shape - the shape to cut
     */
    private static trimOrder(shape: Record<string, unknown>): string[] {
        const size = (key: string): number => jsonBytes(shape[key]);
        const bySize = (a: string, b: string): number => size(b) - size(a);
        const first = TRIM_FIRST.filter((key) => key in shape);
        const rest = Object.keys(shape).filter((key) => !first.includes(key) && key !== "id" && key !== "type");
        const large = rest
            .filter(
                (key) => (typeof shape[key] === "string" || Array.isArray(shape[key])) && size(key) > OVERSIZE_BYTES
            )
            .sort(bySize);
        const others = rest.filter((key) => !large.includes(key)).sort(bySize);
        return [...first, ...large, ...others];
    }

    /**
     * Returns a window with its shape types in the caller's form.
     *
     * @param window - the window as the backend answered it
     */
    private callerWindow(window: SubtreeWindow | undefined): Record<string, unknown> {
        const shapes = Array.isArray(window?.shapes)
            ? window.shapes.map((shape) => BackendShapeTypes.toCallerShape(shape))
            : window?.shapes;
        return { ...window, shapes };
    }

    /**
     * Tells whether a reply fits the response cap, measured as the JSON text it would be sent as.
     *
     * @param reply - the reply to measure
     */
    private fits(reply: unknown): boolean {
        return jsonBytes(reply) <= this.capBytes;
    }

    /**
     * Checks a path that the tool is asked to write, before anything is read.
     *
     * The checks are those of export_shape: file access is on, the path is absolute and inside the export
     * directory, it passes no link, it ends in .json, and an existing file is refused unless overwrite is true. The
     * name must also be one that Windows accepts: no colon after the drive letter, and none of < > " | ? *.
     *
     * @param filePath - the path the caller gave
     * @param overwrite - whether an existing file may be replaced
     * @throws Error when any of the checks fails
     */
    private checkFilePath(filePath: string, overwrite: boolean): void {
        FilePathAccess.assertAllowed(this.mcpServer);
        FileUtils.checkPathIsAbsolute(filePath);
        if (/[:<>"|?*]/.test(filePath.replace(/^[A-Za-z]:/, ""))) {
            throw new Error('The file path may not contain : < > " | ? * (a drive letter is the only colon allowed).');
        }
        ExportDirectory.assertInside(filePath, process.env);
        ExportDirectory.assertExtension(filePath, FILE_EXTENSIONS);
        if (!overwrite) {
            ExportDirectory.assertAbsent(filePath);
        }
    }

    /**
     * Walks the whole subtree into a file. A walk that meets a stale cursor starts again once; a second stale cursor
     * fails. A failed export removes the parent folders that it created itself.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @param filePath - the checked path to write
     * @param overwrite - whether an existing file may be replaced
     * @throws Error when the walk fails twice on a stale cursor, or fails for another reason
     */
    private async writeFile(
        args: ExportSubtreeArgs,
        userToken: string,
        filePath: string,
        overwrite: boolean
    ): Promise<SubtreeFileResult> {
        const created = ExportSubtreeTool.missingFolders(filePath);
        FileUtils.createParentDirectories(filePath);
        const progress: ProgressMark = { reported: 0 };
        let restarted = false;
        try {
            for (;;) {
                try {
                    return await this.writeWalk(args, userToken, filePath, overwrite, progress);
                } catch (error) {
                    if (!ExportSubtreeTool.isStaleCursor(error)) {
                        throw error;
                    }
                    if (restarted) {
                        throw new Error(
                            "The page keeps changing while the subtree is read, so the walk did not finish. " +
                                "Try again when the page is not being edited."
                        );
                    }
                    restarted = true;
                }
            }
        } catch (error) {
            ExportSubtreeTool.removeFolders(created);
            throw error;
        }
    }

    /**
     * Runs one walk from the first window to the last, streaming the document to a temporary file. The temporary
     * file takes the path only when the walk is complete and holds as many shapes as its first window counted. A
     * failed walk removes it.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @param filePath - the checked path to write
     * @param overwrite - whether an existing file may be replaced
     * @param progress - the highest count reported so far, which a restarted walk does not report again
     * @throws Error when a window fails, or the count of shapes differs from the first window; the temporary file is
     *   removed first
     */
    private async writeWalk(
        args: ExportSubtreeArgs,
        userToken: string,
        filePath: string,
        overwrite: boolean,
        progress: ProgressMark
    ): Promise<SubtreeFileResult> {
        const writer = new JsonFileWriter(ExportSubtreeTool.tempPathOf(filePath));
        try {
            let cursor: string | undefined;
            let revn: number | undefined;
            let headTotal: number | undefined;
            let total = 0;
            let shapes = 0;
            let windows = 0;
            const usedCursors = new Set<string>();
            do {
                CallContext.current()?.signal?.throwIfAborted();
                const part = await this.callWindow(userToken, args, cursor, FILE_WINDOW);
                if (!Array.isArray(part?.shapes)) {
                    throw new Error("The backend answered a window without shapes.");
                }
                if (windows === 0) {
                    revn = part.revn;
                    headTotal = part.total;
                    const head = {
                        fileId: args.fileId,
                        pageId: part.pageId ?? args.pageId,
                        rootId: part.rootId ?? args.rootId ?? PAGE_ROOT_ID,
                        revn: part.revn,
                        total: part.total,
                    };
                    await writer.write(`${JSON.stringify(head).slice(0, -1)},"shapes":[`);
                }
                const items = part.shapes.map((shape) => JSON.stringify(BackendShapeTypes.toCallerShape(shape)));
                if (items.length > 0) {
                    await writer.write((shapes > 0 ? "," : "") + items.join(","));
                }
                shapes += items.length;
                windows += 1;
                total = part.total ?? total;
                if (shapes > progress.reported) {
                    progress.reported = shapes;
                    this.reportProgress(shapes, total, `Wrote ${shapes} of ${total} shapes.`);
                }
                if (part.truncated === true && typeof part.nextCursor !== "string") {
                    throw new Error("The backend cut a window without a cursor to continue from.");
                }
                cursor = typeof part.nextCursor === "string" ? part.nextCursor : undefined;
                if (cursor !== undefined) {
                    if (usedCursors.has(cursor)) {
                        throw new Error("The backend repeated a cursor, so the walk would not end.");
                    }
                    usedCursors.add(cursor);
                }
            } while (cursor !== undefined);
            if (shapes !== headTotal) {
                throw new Error(
                    `The page changed during the walk: the subtree has ${shapes} shapes, but its first window ` +
                        `counted ${headTotal}. Export it again.`
                );
            }
            await writer.write("]}");
            await writer.finish();
            if (!overwrite) {
                ExportDirectory.assertAbsent(filePath);
            }
            writer.publish(filePath);
            return { path: filePath, shapes, bytes: writer.bytes, revn, windows };
        } catch (error) {
            await writer.abort();
            throw error;
        }
    }

    /**
     * Calls the backend for one window of the walk.
     *
     * @param userToken - the MCP token of the request
     * @param args - the validated tool arguments
     * @param cursor - cursor of the window, or undefined for the first one
     * @param size - the most shapes and bytes of the window
     */
    private callWindow(
        userToken: string,
        args: ExportSubtreeArgs,
        cursor: string | undefined,
        size: WindowSize
    ): Promise<SubtreeWindow> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.rootId !== undefined ? { rootId: args.rootId } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            limit: size.limit,
            maxBytes: size.maxBytes,
        };
        return this.callCommand<SubtreeWindow>(userToken, "get-mcp-subtree", params);
    }

    /**
     * Returns the size of an inline window: the caller's limit, and 80 % of the response cap in bytes.
     *
     * @param args - the validated tool arguments
     */
    private inlineParams(args: ExportSubtreeArgs): WindowSize {
        return { limit: args.limit ?? DEFAULT_LIMIT, maxBytes: this.windowBytes };
    }

    /**
     * Returns the byte limit of one window: 80 % of the response cap, kept inside the range the backend accepts.
     *
     * @param capBytes - the response cap of the tool, in bytes
     */
    private static windowBytesFor(capBytes: number): number {
        const share = Math.floor(capBytes * WINDOW_SHARE);
        return Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, share));
    }

    /**
     * Tells whether an error is the backend's answer that the cursor is stale.
     *
     * @param error - the failure of a window
     */
    private static isStaleCursor(error: unknown): boolean {
        return error instanceof BackendRpcError && error.code === STALE_CURSOR;
    }

    /**
     * Returns the folders above a path that do not exist yet, deepest first.
     *
     * @param filePath - the path whose parent folders are looked up
     */
    private static missingFolders(filePath: string): string[] {
        const missing: string[] = [];
        let dir = path.dirname(filePath);
        while (!fs.existsSync(dir)) {
            missing.push(dir);
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        return missing;
    }

    /**
     * Removes folders that a failed export created, deepest first. A folder that holds anything is kept, and so are
     * the folders above it.
     *
     * @param created - the folders the export created, deepest first
     */
    private static removeFolders(created: string[]): void {
        for (const dir of created) {
            try {
                fs.rmdirSync(dir);
            } catch {
                return;
            }
        }
    }

    /**
     * Returns the path of the temporary file of a walk: a hidden file next to the target, with a short random name.
     * The file is renamed onto the target when the walk is complete.
     *
     * @param filePath - the target path
     */
    private static tempPathOf(filePath: string): string {
        return path.join(path.dirname(filePath), `.${randomBytes(6).toString("hex")}.partial`);
    }
}

/**
 * Writes one text file in pieces through a stream, and counts the bytes written.
 *
 * The file is created exclusively, so that the writer never replaces a file that appeared meanwhile. Writes wait for
 * the stream to drain, so the memory held stays near one window.
 */
class JsonFileWriter {
    /** Bytes written so far, in UTF-8. */
    public bytes = 0;

    /** Stream that holds the file open. */
    private readonly stream: fs.WriteStream;

    /** The first error of the stream, which the next call reports. */
    private error: Error | undefined;

    /**
     * Opens the temporary file for writing.
     *
     * @param tempPath - path of the temporary file; it must not exist yet
     */
    public constructor(private readonly tempPath: string) {
        this.stream = fs.createWriteStream(tempPath, { flags: "wx" });
        this.stream.on("error", (error: Error) => {
            this.error = error;
        });
    }

    /**
     * Writes a piece of text, and waits when the stream asks for it.
     *
     * @param text - the text to write
     * @throws Error when the stream has failed
     */
    public async write(text: string): Promise<void> {
        this.throwIfFailed();
        this.bytes += Buffer.byteLength(text, "utf8");
        if (!this.stream.write(text)) {
            await this.drained();
        }
    }

    /**
     * Closes the file and waits until it is written.
     *
     * @throws Error when the stream has failed
     */
    public async finish(): Promise<void> {
        this.throwIfFailed();
        this.stream.end();
        await finished(this.stream);
    }

    /**
     * Moves the finished temporary file onto the target path.
     *
     * @param filePath - the target path
     */
    public publish(filePath: string): void {
        fs.renameSync(this.tempPath, filePath);
    }

    /**
     * Closes the stream and removes the temporary file, after a failure. Nothing is left behind.
     */
    public async abort(): Promise<void> {
        this.stream.destroy();
        await finished(this.stream).catch(() => undefined);
        fs.rmSync(this.tempPath, { force: true });
    }

    /**
     * Resolves when the stream has drained, and rejects when it fails first.
     */
    private drained(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onDrain = (): void => {
                this.stream.off("error", onError);
                resolve();
            };
            const onError = (error: Error): void => {
                this.stream.off("drain", onDrain);
                reject(error);
            };
            this.stream.once("drain", onDrain);
            this.stream.once("error", onError);
        });
    }

    /**
     * Throws the first error of the stream, when there was one.
     *
     * @throws Error with the stream error
     */
    private throwIfFailed(): void {
        if (this.error !== undefined) {
            throw this.error;
        }
    }
}
