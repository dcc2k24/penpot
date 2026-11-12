import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendRateLimitError, BackendRpcError } from "../../backend/BackendRpcError";
import { RateLimitError } from "../../backend/TokenRateLimiter";
import { BackendSettings } from "../../backend/BackendSettings";
import { CallContext } from "../../backend/CallContext";
import { ExportDirectory } from "../../utils/ExportDirectory";
import { FileUtils } from "../../utils/FileUtils";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";
import { FilePathAccess } from "./FilePathAccess";

/** Id of the page root, which the backend uses as the root of a whole page. */
const PAGE_ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Most shapes in one reply, and the default: the reply cap, not the count, limits a reply. */
const MAX_LIMIT = 5000;

/** Smallest byte budget the backend accepts for a window. */
const MIN_WINDOW_BYTES = 1000;

/** Smallest window that file mode and inline mode ask for, however low PENPOT_MCP_BACKEND_MAX_RESPONSE_MB is. */
const MIN_BIG_WINDOW_BYTES = 64_000;

/** Share of the backend response cap (PENPOT_MCP_BACKEND_MAX_RESPONSE_MB) that one window may take. */
const RESPONSE_SHARE = 0.5;

/**
 * Most bytes of JSON text, before any compression, that one tool call gathers, whatever the encoding. It bounds the
 * memory of a call when the cap is raised and the shapes compress well.
 */
const MAX_PLAIN_BYTES_PER_CALL = 16 * 1024 * 1024;

/** Share of the cap that a window cut by the estimate of its compressed size aims at, to leave room for the error. */
const GZIP_FIT_SHARE = 0.95;

/** Factor on the estimated compressed size of a window that was not compressed alone, to cover the error. */
const GZIP_ESTIMATE_MARGIN = 1.1;

/** Compresses text without blocking the event loop. */
const gzipAsync = (text: Buffer): Promise<Buffer> => promisify(zlib.gzip)(text);

/** Attributes that are cut first when one shape alone is larger than the response cap. */
const TRIM_FIRST = ["content", "positionData", "shapes"];

/** Other strings and arrays above this many bytes are cut next, largest first. */
const OVERSIZE_BYTES = 2000;

/** Largest byte budget the backend accepts for a window (the hard maximum of `max-json-bytes`). */
const MAX_WINDOW_BYTES = 4_000_000;

/**
 * Share of the room left in a reply that one window asks for. The backend counts the JSON it writes, and the adapter
 * writes a little more (a circle is called ellipse), so a window asked for the whole room could overflow it by a few
 * bytes.
 */
const WINDOW_SHARE = 0.98;

/** Bytes kept free in the reply for the fields around the shapes, before the first window shows their size. */
const HEAD_RESERVE_BYTES = 1024;

/** Characters added to the first nextCursor when the head is measured, since a later cursor can be a little longer. */
const CURSOR_PAD_CHARS = 40;

/** Most backend windows that one tool call reads. */
const MAX_WINDOWS_PER_CALL = 24;

/** Most times that a first window that does not fit is asked again with fewer shapes. */
const MAX_SHRINKS = 8;

/** Bytes of JSON that one byte of the gzip-base64 form holds, until a window shows the real ratio. */
const GZIP_RATIO_GUESS = 3;

/** Name of the encoding that compresses the shapes of a reply. */
const GZIP_ENCODING = "gzip-base64";

/** The response cap of one call, and whether the caller asked for it with maxResponseKb. */
interface CallCap {
    /** Cap in bytes. */
    bytes: number;
    /** True when the cap is the maxResponseKb of the call, so advice about the cap names that parameter. */
    asked: boolean;
}

/** Size of one window as the backend is asked for it. */
interface WindowSize {
    /** Most shapes in the window. */
    limit: number;
    /** Most bytes of JSON text in the window. */
    maxJsonBytes: number;
}

/** Backend error code of a cursor whose page version is no longer the current one. */
const STALE_CURSOR = "mcp-stale-cursor";

/** File name extensions that a subtree file may have. */
const FILE_EXTENSIONS = [".json"];

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
                "nextCursor of an earlier inline response, to read the next shapes. Not allowed with filePath: " +
                    "the file always holds the whole subtree."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .optional()
            .describe(
                "Most shapes in one inline reply (1 to 5000, default 5000). A reply holds as many shapes as fit " +
                    "the response cap of this tool, so leave it out unless you want fewer. Applies to inline " +
                    "mode only: a call with filePath reads the whole subtree."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path to write the whole subtree to, as one JSON file. It must lie inside the export " +
                    "directory (PENPOT_MCP_EXPORT_DIR, or penpot-exports in the home directory by default) and end " +
                    "in .json. When omitted, the shapes are returned in the response."
            ),
        overwrite: z
            .boolean()
            .optional()
            .describe("When true, replace the file at filePath if one is there. Default false: it is refused."),
        compact: z
            .boolean()
            .optional()
            .describe(
                "When true, each shape leaves out its keys whose value is null, and its top-level keys that hold " +
                    "the value that defaults lists for them (hidden false, blocked false, opacity 1). Inside each " +
                    "stroke of strokes, strokeAlignment is left out when it is center (defaults.strokes names that). " +
                    "The reply says compact: true and lists defaults once. A top-level key that is absent is null " +
                    "when defaults has no value for it; defaults.strokes is not a value for a missing strokes key. Smaller " +
                    "replies, so fewer calls. Works with filePath too."
            ),
        encoding: z
            .enum([GZIP_ENCODING])
            .optional()
            .describe(
                "For scripts only: a model should not ask for it, since base64 text is waste in a model's context. " +
                    "With gzip-base64 the reply's shapes become {encoding, bytes, count, data}: data is the base64 " +
                    "text of the gzip of the JSON array of the shapes, bytes its size before compression and count " +
                    "the number of shapes. The other fields stay plain, and the cap applies to the reply as sent. " +
                    "Inline mode only: it is refused with filePath."
            ),
        maxResponseKb: z
            .number()
            .int()
            .min(1)
            .max(10_000)
            .optional()
            .describe(
                "For scripts only: a model should not ask for it. The most kilobytes this one reply may take, " +
                    "in place of the default cap of the server, so that a script reads a page in fewer calls. " +
                    "Allowed only with encoding gzip-base64, and up to the server maximum " +
                    "(PENPOT_MCP_SUBTREE_MAX_REQUEST_KB; default 2000, or the default reply cap if that is larger): a larger value is " +
                    "refused. Leave it out and the server's cap applies, as before. Inline mode only: it is " +
                    "refused with filePath."
            ),
    };

    fileId!: string;

    pageId!: string;

    rootId?: string;

    cursor?: string;

    limit?: number;

    filePath?: string;

    overwrite?: boolean;

    compact?: boolean;

    encoding?: typeof GZIP_ENCODING;

    maxResponseKb?: number;
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
    /** True when the shapes are compact. */
    compact?: boolean;
    /** Values to assume for the keys that compact shapes leave out. */
    defaults?: Record<string, unknown>;
}

/** The fields of a reply that do not depend on which windows it holds. */
interface ReplyHead {
    /** Revision of the file the walk reads. */
    revn: number | undefined;
    /** Id of the page. */
    pageId: string | undefined;
    /** Id of the root of the walk. */
    rootId: string | undefined;
    /** Number of shapes in the whole walk. */
    total: number | undefined;
    /** True when the shapes are compact. */
    compact: boolean;
    /** Defaults of a compact walk. */
    defaults: Record<string, unknown> | undefined;
}

/** One backend window that an inline reply holds, in the caller's form. */
interface ReadWindow {
    /** The window as the backend answered it. */
    raw: SubtreeWindow;
    /** Shapes of the window, with the types as the other tools show them. */
    shapes: unknown[];
    /** Bytes that the window adds to the reply, as it will be sent. */
    cost: number;
    /** Bytes of the JSON text of the shapes, before any compression. */
    plainBytes: number;
    /** Cursor that continues the walk after the window, or undefined at the end. */
    nextCursor: string | undefined;
    /** Set when the window holds one shape that was cut to fit the cap: its id, real size and the cut attributes. */
    oversize?: { id: unknown; bytes: number; omitted: string[] };
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
 * @param value - the value to test
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the length of the base64 text of some bytes.
 *
 * @param bytes - the number of bytes to encode
 */
function base64Length(bytes: number): number {
    return Math.ceil(bytes / 3) * 4;
}

/**
 * Exports every attribute of every shape under one root as data, in windows, inline or to a JSON file.
 *
 * Without filePath the tool reads as many backend windows as fit its response cap and returns them as one reply with
 * the cursor of the next shapes; a reply never lacks a cursor while shapes remain. With filePath it reads every window
 * and streams one JSON document to the file, so the whole subtree never sits in memory.
 */
export class ExportSubtreeTool extends BackendTool<ExportSubtreeArgs> {
    /** Environment variable that sets the response cap of this tool, in kilobytes. */
    public static readonly CAP_VARIABLE = "PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB";

    /** Environment variable that sets the largest cap a call may ask for with maxResponseKb, in kilobytes. */
    public static readonly REQUEST_MAX_VARIABLE = "PENPOT_MCP_SUBTREE_MAX_REQUEST_KB";

    /** Largest cap a call may ask for when PENPOT_MCP_SUBTREE_MAX_REQUEST_KB is unset, in bytes. */
    private static readonly DEFAULT_REQUEST_MAX_BYTES = 2_000_000;

    /** Response cap of this tool, in bytes. */
    private readonly capBytes: number;

    /** Largest cap that one call may ask for with maxResponseKb, in bytes. */
    private readonly requestMaxBytes: number;

    /**
     * Most bytes of JSON text that one window asks for: the largest the backend takes, or less when the backend
     * response cap of the adapter (PENPOT_MCP_BACKEND_MAX_RESPONSE_MB) is low.
     */
    private readonly windowBytes: number;

    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     * @throws Error when PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB or PENPOT_MCP_SUBTREE_MAX_REQUEST_KB is set and is not a
     *   whole number of kilobytes from 1 to 10000, or PENPOT_MCP_SUBTREE_MAX_REQUEST_KB is below the default reply cap
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ExportSubtreeArgs.schema, services);
        this.capBytes = ExportSubtreeTool.readCapBytes(process.env);
        this.requestMaxBytes = ExportSubtreeTool.readRequestMaxBytes(process.env, this.capBytes);
        this.windowBytes = ExportSubtreeTool.windowBytesFor(BackendSettings.readMaxResponseMb(process.env));
    }

    /**
     * Returns the byte budget of one window for a backend response cap: the largest window the backend takes, cut to
     * half of the cap so that a window and the envelope around it fit one response, and not below a floor.
     *
     * @param maxResponseMb - the backend response cap in megabytes (PENPOT_MCP_BACKEND_MAX_RESPONSE_MB)
     * @returns the budget in bytes of JSON text
     */
    public static windowBytesFor(maxResponseMb: number): number {
        const share = Math.floor(maxResponseMb * 1024 * 1024 * RESPONSE_SHARE);
        return Math.min(MAX_WINDOW_BYTES, Math.max(MIN_BIG_WINDOW_BYTES, share));
    }

    /**
     * Reads the response cap of this tool: PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB, or the shared cap when it is unset.
     *
     * @param env - environment to read; the process environment in production
     * @returns the cap in bytes
     * @throws Error when either setting is not a whole number of kilobytes from 1 to 10000
     */
    public static readCapBytes(env: NodeJS.ProcessEnv): number {
        return BackendTool.readCapBytes(env, ExportSubtreeTool.CAP_VARIABLE, BackendTool.readMaxResponseBytes(env));
    }

    /**
     * Reads the largest cap that a call may ask for with maxResponseKb: PENPOT_MCP_SUBTREE_MAX_REQUEST_KB, or 2000 kB
     * when it is unset (or the default reply cap when that is larger). A maximum that is set below the default reply
     * cap is refused, so that a script that asks for the default size is never turned away.
     *
     * @param env - environment to read; the process environment in production
     * @param defaultCapBytes - the default reply cap in bytes, which the maximum may not be below; 0 for none
     * @returns the largest cap in bytes
     * @throws Error when the setting is not a whole number of kilobytes from 1 to 10000, or is below the default cap
     */
    public static readRequestMaxBytes(env: NodeJS.ProcessEnv, defaultCapBytes = 0): number {
        const maximum = BackendTool.readCapBytes(
            env,
            ExportSubtreeTool.REQUEST_MAX_VARIABLE,
            Math.max(ExportSubtreeTool.DEFAULT_REQUEST_MAX_BYTES, defaultCapBytes)
        );
        if (maximum < defaultCapBytes) {
            throw new Error(
                `${ExportSubtreeTool.REQUEST_MAX_VARIABLE} (${maximum / 1_000} kB) must not be below the default ` +
                    `reply cap of ${defaultCapBytes / 1_000} kB (${ExportSubtreeTool.CAP_VARIABLE}), so that a ` +
                    "script can always ask for the default size."
            );
        }
        return maximum;
    }

    /**
     * Returns the advice to raise the cap, in the words that fit how the cap of the call was set.
     *
     * @param cap - the cap of the call
     * @param server - the advice when the cap is the cap of the server
     */
    /** Whether the call already asked for the server maximum, so a larger cap cannot be asked for. */
    private atServerMax(cap: CallCap): boolean {
        return cap.asked && cap.bytes >= this.requestMaxBytes;
    }

    private raiseAdvice(cap: CallCap, server: string): string {
        if (!cap.asked) {
            return server;
        }
        return (
            `maxResponseKb (up to the server maximum of ${this.requestMaxBytes / 1_000} kB, ` +
            `${ExportSubtreeTool.REQUEST_MAX_VARIABLE})`
        );
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
            "Exports every attribute of every shape under rootId (or the whole page) as data. " +
            "Each shape carries all its stored attributes, such as content, fills, strokes, shadows, interactions, " +
            "points and transform, plus x, y, width, height, characters for text, depth, index (its place in the " +
            "walk) and worldMatrix (maps the four corners of the selrect, in order, onto the four points; for a flipped " +
            "group it can differ from the stored transform). A path's or boolean's content is an SVG " +
            "path string in page space; a text's content is its tree of paragraphs. " +
            "Shapes come in walk order, parents first. " +
            "Without filePath the reply is revn, pageId, rootId, total (shapes in the whole walk), windows (backend " +
            "windows read for this reply), shapes, truncated, and nextCursor when shapes remain. " +
            "A reply holds as many shapes as fit the response cap, and has a nextCursor whenever shapes remain: " +
            "pass it as cursor to read the next shapes, until there is none. " +
            "A reply read through the backend rate limit may hold fewer shapes, with a note: wait a little and pass " +
            "the same cursor again. A cursor stays valid while revn is unchanged. " +
            "A single shape above the response cap comes back alone with its large attributes shown as omitted, " +
            "listed in oversize with its id and real size, and nextCursor continues after it; the note says how " +
            "to get the whole shape. " +
            "With compact: true each shape leaves out its null keys and its default values, and the reply lists the " +
            "defaults once. For scripts there is also encoding gzip-base64 (the shapes come as a base64 gzip " +
            "text); a model should not ask for it. " +
            "A script can also pass maxResponseKb (with gzip-base64 only) to raise the cap of one call, up to the " +
            "server maximum PENPOT_MCP_SUBTREE_MAX_REQUEST_KB, to read a page in fewer calls; a model should not " +
            "ask for it either. ";
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
     * Returns the next shapes as one inline reply, or walks every window into a file.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when filePath is refused, the path is not allowed, a cursor, an encoding or maxResponseKb comes
     *   with filePath, maxResponseKb comes without gzip-base64 or above the server maximum, or the walk fails
     */
    protected async executeBackend(args: ExportSubtreeArgs, userToken: string): Promise<ToolResponse> {
        if (args.filePath !== undefined && args.maxResponseKb !== undefined) {
            throw new Error("maxResponseKb cannot be used with filePath: a file holds the whole subtree.");
        }
        if (args.filePath === undefined) {
            return this.inlineReply(args, userToken, this.capOf(args));
        }
        this.checkFilePath(args.filePath, args.overwrite === true);
        if (args.cursor !== undefined) {
            throw new Error("cursor cannot be used with filePath: the file always holds the whole subtree.");
        }
        if (args.encoding !== undefined) {
            throw new Error(
                "encoding cannot be used with filePath: a file is plain JSON, and the encoding is for replies."
            );
        }
        const result = await this.writeFile(args, userToken, args.filePath, args.overwrite === true);
        return this.jsonResponse(result);
    }

    /**
     * Returns the response cap of one call: maxResponseKb when it is given, else the cap of the server.
     *
     * @param args - the validated tool arguments
     * @returns the cap
     * @throws Error when maxResponseKb comes without gzip-base64, or is above the server maximum
     */
    private capOf(args: ExportSubtreeArgs): CallCap {
        if (args.maxResponseKb === undefined) {
            return { bytes: this.capBytes, asked: false };
        }
        if (args.encoding !== GZIP_ENCODING) {
            throw new Error(
                `maxResponseKb can only be used with encoding "${GZIP_ENCODING}": it is for scripts, and a model ` +
                    "client keeps the default cap."
            );
        }
        const asked = args.maxResponseKb * 1_000;
        if (asked > this.requestMaxBytes) {
            throw new Error(
                `maxResponseKb ${args.maxResponseKb} is above the server maximum of ` +
                    `${this.requestMaxBytes / 1_000} kB (${ExportSubtreeTool.REQUEST_MAX_VARIABLE}).`
            );
        }
        return { bytes: asked, asked: true };
    }

    /**
     * Compresses text for the gzip-base64 form. It runs off the event loop; tests replace it to count the runs.
     *
     * @param text - the JSON text of some shapes
     * @returns the gzip bytes
     */
    protected compress(text: string): Promise<Buffer> {
        return gzipAsync(Buffer.from(text, "utf8"));
    }

    /**
     * Returns one inline reply that fits the response cap and never lacks a cursor while shapes remain.
     *
     * It reads backend windows one after the other, each asked for the room that is left in the reply, and stops
     * before the first window that does not fit, with the cursor that resumes there. It also stops when the plain
     * text it holds reaches {@link MAX_PLAIN_BYTES_PER_CALL}. When the first window does not fit, it asks again for
     * fewer shapes. One shape that is above the cap by itself comes back alone, with its large attributes cut, listed
     * in `oversize`, and the cursor after it.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @param cap - the response cap of this call
     * @throws Error when a shape cannot fit even cut, or a window fails
     */
    private async inlineReply(args: ExportSubtreeArgs, userToken: string, cap: CallCap): Promise<ToolResponse> {
        const gzip = args.encoding === GZIP_ENCODING;
        const limit = args.limit ?? MAX_LIMIT;
        const windows: ReadWindow[] = [];
        let head: ReplyHead | undefined;
        let budget = cap.bytes - HEAD_RESERVE_BYTES;
        let used = 0;
        let plain = 0;
        let count = 0;
        // bytes of JSON per byte of the compressed window, as the first window shows it; later windows are not
        // compressed alone, their size is estimated from it
        let measured: number | undefined;
        let cursor = args.cursor;
        let limitNote: string | undefined;
        for (;;) {
            CallContext.current()?.signal?.throwIfAborted();
            const ratio = used > 0 ? plain / used : GZIP_RATIO_GUESS;
            const size = {
                limit: limit - count,
                maxJsonBytes: this.askBytes(
                    budget - used,
                    // a later window is costed with the margin, so it is asked for what fits with the margin
                    gzip ? (used > 0 ? ratio / GZIP_ESTIMATE_MARGIN : ratio) : 1,
                    MAX_PLAIN_BYTES_PER_CALL - plain
                ),
            };
            let window: ReadWindow;
            try {
                window = await this.readWindow(await this.callWindow(userToken, args, cursor, size), gzip, measured);
            } catch (error) {
                // the page changed after some shapes were read: they are one revision, and the next call restarts
                if (windows.length > 0 && ExportSubtreeTool.isStaleCursor(error)) {
                    limitNote = ExportSubtreeTool.staleNote();
                    break;
                }
                // a rate limit after some windows: send those, with the cursor that continues after them
                if (windows.length > 0 && error instanceof RateLimitError) {
                    limitNote = ExportSubtreeTool.rateLimitNote(error, windows.length);
                    break;
                }
                throw error;
            }
            if (head === undefined) {
                budget = cap.bytes - this.headBytes(ExportSubtreeTool.headOf(window.raw), window.nextCursor, gzip);
                const fitted = await this.fitFirstWindow(
                    userToken,
                    args,
                    cursor,
                    ExportSubtreeTool.headOf(window.raw),
                    window,
                    budget,
                    gzip,
                    cap
                );
                head = fitted.head;
                window = fitted.window;
                if (gzip && window.oversize === undefined && window.cost > 0) {
                    measured = window.plainBytes / window.cost;
                }
            } else if (
                window.raw.revn !== head.revn ||
                used + window.cost > budget ||
                plain + window.plainBytes > MAX_PLAIN_BYTES_PER_CALL
            ) {
                break;
            }
            windows.push(window);
            used += window.cost;
            plain += window.plainBytes;
            count += window.shapes.length;
            if (window.oversize !== undefined || window.nextCursor === undefined) {
                break;
            }
            if (window.nextCursor === cursor) {
                throw new Error("The backend repeated a cursor, so the walk would not end.");
            }
            cursor = window.nextCursor;
            if (
                count >= limit ||
                windows.length >= MAX_WINDOWS_PER_CALL ||
                budget - used < MIN_WINDOW_BYTES ||
                MAX_PLAIN_BYTES_PER_CALL - plain < MIN_BIG_WINDOW_BYTES
            ) {
                break;
            }
        }
        return this.finishReply(head, windows, gzip, limitNote, cap);
    }

    /**
     * Returns the note of a reply that a stale cursor cut: the page changed after the windows of the reply were read.
     */
    private static staleNote(): string {
        return (
            "The page changed (its revn moved) while this call read it. The shapes in this reply are from before " +
            "the change, and the backend will refuse nextCursor as stale. Start the walk again without a cursor."
        );
    }

    /**
     * Returns the note of a reply that the rate limit cut.
     *
     * @param error - the refusal
     * @param windows - the number of windows the reply holds
     */
    private static rateLimitNote(error: RateLimitError, windows: number): string {
        const wait =
            error instanceof BackendRateLimitError && error.retryAfterSeconds !== undefined
                ? `${error.retryAfterSeconds} s`
                : "10 s";
        return (
            `The rate limit stopped this call after ${windows} backend ` +
            `${windows === 1 ? "window" : "windows"}. Wait about ${wait}, then pass nextCursor as cursor to go on.`
        );
    }

    /**
     * Returns the first window of a reply, cut to a prefix that fits the room of the reply. A window that does not
     * fit is asked again with the number of leading shapes that fit, so that the cursor resumes right after them.
     * When even the first shape does not fit, the window is that shape alone, cut to fit.
     *
     * The window is asked for again, so the page may have changed since the first answer. The reply then takes the
     * head (revision and total) of the newest answer, so its fields and its shapes are one revision.
     *
     * @param userToken - the MCP token of the request
     * @param args - the validated tool arguments
     * @param cursor - cursor the window was read at
     * @param head - the fields of the reply that the first answer gave
     * @param first - the first window, as the backend answered it
     * @param budget - the bytes that the shapes may take in the reply
     * @param gzip - whether the shapes are compressed
     * @param cap - the response cap of this call
     * @returns the window that fits, and the head of the answer it came from
     * @throws Error when a shape cannot fit even cut, or the window will not fit after a few tries
     */
    private async fitFirstWindow(
        userToken: string,
        args: ExportSubtreeArgs,
        cursor: string | undefined,
        head: ReplyHead,
        first: ReadWindow,
        budget: number,
        gzip: boolean,
        cap: CallCap
    ): Promise<{ window: ReadWindow; head: ReplyHead }> {
        let window = first;
        let current = head;
        for (let attempt = 0; attempt < MAX_SHRINKS; attempt++) {
            if (window.cost <= budget) {
                return { window, head: current };
            }
            const fitting = ExportSubtreeTool.fittingCount(window, budget, gzip);
            const size = { limit: Math.max(1, fitting), maxJsonBytes: this.windowBytes };
            if (fitting > 0 || window.shapes.length > 1) {
                window = await this.readWindow(await this.callWindow(userToken, args, cursor, size), gzip, undefined);
                current = ExportSubtreeTool.sameRevision(current, window);
            }
            if (fitting === 0) {
                // the first shape alone is the window: it comes whole when it fits, and cut when it does not
                if (window.cost <= budget) {
                    return { window, head: current };
                }
                return { window: await this.trimmedWindow(current, window, gzip, cap), head: current };
            }
        }
        const advice = this.atServerMax(cap)
            ? `The window does not fit even at the server maximum of ${this.requestMaxBytes / 1_000} kB.`
            : `Raise ${this.raiseAdvice(cap, ExportSubtreeTool.CAP_VARIABLE)}, or read the shapes with get_shapes and fields.`;
        throw new Error(
            `A window would not fit the response cap of ${cap.bytes} bytes after ${MAX_SHRINKS} tries. ${advice}`
        );
    }

    /**
     * Returns the head to use after a window was asked for again: the old head when the revision and the total are
     * the same, else the head of the new answer.
     *
     * @param head - the head so far
     * @param window - the window that was read last
     */
    private static sameRevision(head: ReplyHead, window: ReadWindow): ReplyHead {
        if (window.raw.revn === head.revn && window.raw.total === head.total) {
            return head;
        }
        return ExportSubtreeTool.headOf(window.raw);
    }

    /**
     * Builds the reply from the windows that were read, and checks that it fits the cap as it will be sent. The
     * check is for what the sums could not see: the estimate of a compressed size, or the bytes around the shapes.
     * When it fails, whole trailing windows are left for the next call. A gzip reply is compressed once, and once
     * more after windows are dropped.
     *
     * @param head - the fields of the reply that the first window gave
     * @param windows - the windows to send, in order; at least one
     * @param gzip - whether the shapes are compressed
     * @param limitNote - note to add when the rate limit or a stale cursor cut the call, or undefined. A reply of
     *   one window that fits only without the note is sent without it: the note never makes the call fail.
     * @param cap - the response cap of this call; the cap of the server by default
     * @throws Error when one window alone does not fit
     */
    private async finishReply(
        head: ReplyHead | undefined,
        windows: ReadWindow[],
        gzip: boolean,
        limitNote?: string,
        cap: CallCap = { bytes: this.capBytes, asked: false }
    ): Promise<ToolResponse> {
        if (head === undefined || windows.length === 0) {
            throw new Error("The backend answered no window.");
        }
        let held = [...windows];
        let note = limitNote;
        for (;;) {
            const shapes = held.flatMap((window) => window.shapes);
            const text = JSON.stringify(
                ExportSubtreeTool.replyOf(
                    head,
                    held,
                    gzip ? await this.packed(shapes) : shapes,
                    ExportSubtreeTool.withLimitNote(this.noteOf(held, cap), note)
                )
            );
            const bytes = Buffer.byteLength(text, "utf8");
            if (bytes <= cap.bytes) {
                return new TextResponse(text);
            }
            if (held.length === 1 && note !== undefined) {
                note = undefined;
                continue;
            }
            if (held.length === 1) {
                throw this.oversizeError(held[0].shapes[0], cap);
            }
            held = gzip
                ? ExportSubtreeTool.leadingWindows(held, (cap.bytes * GZIP_FIT_SHARE) / bytes)
                : held.slice(0, -1);
        }
    }

    /**
     * Adds the rate-limit note to the note of a reply.
     *
     * @param note - the oversize note, or undefined
     * @param limitNote - the rate-limit note, or undefined
     */
    private static withLimitNote(
        note: { oversize: unknown[]; note: string } | undefined,
        limitNote: string | undefined
    ): { oversize?: unknown[]; note: string } | undefined {
        if (limitNote === undefined) {
            return note;
        }
        return note === undefined ? { note: limitNote } : { ...note, note: `${note.note} ${limitNote}` };
    }

    /**
     * Returns the leading windows whose plain bytes are at most a share of the plain bytes of all of them: at least
     * one window, and at least one fewer than all.
     *
     * @param windows - the windows, in order; at least two
     * @param share - the share of the plain bytes to keep
     */
    private static leadingWindows(windows: ReadWindow[], share: number): ReadWindow[] {
        const allowed = windows.reduce((sum, window) => sum + window.plainBytes, 0) * share;
        let sum = 0;
        let keep = 0;
        while (keep < windows.length - 1 && sum + windows[keep].plainBytes <= allowed) {
            sum += windows[keep].plainBytes;
            keep += 1;
        }
        return windows.slice(0, Math.max(1, keep));
    }

    /**
     * Builds the reply of some windows. Its cursor is the one after the last window.
     *
     * @param head - the fields of the reply that do not depend on the windows
     * @param windows - the windows to send, in order; at least one
     * @param shapes - the `shapes` field: the shapes, or their gzip-base64 envelope
     * @param note - the note about a cut shape, or undefined
     */
    private static replyOf(
        head: ReplyHead,
        windows: ReadWindow[],
        shapes: unknown,
        note: { oversize?: unknown[]; note: string } | undefined
    ): Record<string, unknown> {
        const nextCursor = windows[windows.length - 1].nextCursor;
        return {
            revn: head.revn,
            pageId: head.pageId,
            rootId: head.rootId,
            total: head.total,
            ...(head.compact ? { compact: true, defaults: head.defaults } : {}),
            windows: windows.length,
            shapes,
            truncated: nextCursor !== undefined,
            ...(nextCursor !== undefined ? { nextCursor } : {}),
            ...(note !== undefined ? note : {}),
        };
    }

    /**
     * Returns the `oversize` list and the note of a reply that holds a cut shape, or undefined.
     *
     * @param windows - the windows of the reply
     * @param cap - the response cap of this call
     */
    private noteOf(windows: ReadWindow[], cap: CallCap): { oversize: unknown[]; note: string } | undefined {
        const oversize = windows.flatMap((window) => (window.oversize === undefined ? [] : [window.oversize]));
        if (oversize.length === 0) {
            return undefined;
        }
        const raise = this.raiseAdvice(cap, "PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB (up to 10000)");
        const files = this.mcpServer.isFileSystemAccessEnabled();
        const way = this.atServerMax(cap)
            ? `The shape does not fit even at the server maximum of ${this.requestMaxBytes / 1_000} kB.` +
              (files ? " Write the subtree to a file with filePath." : "")
            : files
              ? `Raise ${raise}, or write the subtree to a file with filePath.`
              : `Raise ${raise}.`;
        return {
            oversize,
            note:
                `A shape is larger than the response cap of ${cap.bytes} bytes, so its large attributes are ` +
                `shown as omitted; nextCursor continues after it. To get the whole shape: ${way}`,
        };
    }

    /**
     * Returns the fields of the reply that come from the first window.
     *
     * @param window - the first window, as the backend answered it
     */
    private static headOf(window: SubtreeWindow): ReplyHead {
        return {
            revn: window.revn,
            pageId: window.pageId,
            rootId: window.rootId,
            total: window.total,
            compact: window.compact === true,
            defaults: window.defaults,
        };
    }

    /**
     * Returns the bytes of the reply without its shapes: the head fields, the largest count of windows, the largest
     * envelope of packed shapes and a cursor a little longer than the first one. The shapes of a plain reply take
     * their own bytes besides, so this overstates the bytes around them by a few.
     *
     * @param head - the fields of the reply that do not depend on the windows
     * @param nextCursor - the cursor after the first window
     * @param gzip - whether the shapes are compressed
     */
    private headBytes(head: ReplyHead, nextCursor: string | undefined, gzip: boolean): number {
        const sample = {
            revn: head.revn,
            pageId: head.pageId,
            rootId: head.rootId,
            total: head.total,
            ...(head.compact ? { compact: true, defaults: head.defaults } : {}),
            windows: MAX_WINDOWS_PER_CALL,
            shapes: gzip ? { encoding: GZIP_ENCODING, bytes: 1_000_000_000, count: MAX_LIMIT, data: "" } : [],
            truncated: true,
            nextCursor: "x".repeat((nextCursor?.length ?? 0) + CURSOR_PAD_CHARS),
        };
        return jsonBytes(sample);
    }

    /**
     * Turns a backend window into the form of the reply and measures what it adds to the reply: the JSON text of
     * its shapes and one comma each, or the base64 text of their gzip. A gzip window is compressed alone only when
     * no ratio is known yet; later windows are estimated from the ratio of the first, with a margin.
     *
     * @param window - the window as the backend answered it
     * @param gzip - whether the shapes are compressed
     * @param measured - bytes of JSON per byte of the compressed first window, or undefined when none is known
     * @throws Error when the window has no shapes, or is cut without a cursor
     */
    private async readWindow(
        window: SubtreeWindow | undefined,
        gzip: boolean,
        measured: number | undefined
    ): Promise<ReadWindow> {
        if (!Array.isArray(window?.shapes)) {
            throw new Error("The backend answered a window without shapes.");
        }
        if (window.truncated === true && typeof window.nextCursor !== "string") {
            throw new Error("The backend cut a window without a cursor to continue from.");
        }
        const shapes = window.shapes.map((shape) => BackendShapeTypes.toCallerShape(shape));
        const nextCursor = typeof window.nextCursor === "string" ? window.nextCursor : undefined;
        if (!gzip) {
            const plainBytes = shapes.reduce<number>((sum, shape) => sum + jsonBytes(shape), 0);
            return { raw: window, shapes, nextCursor, cost: plainBytes + shapes.length, plainBytes };
        }
        const text = JSON.stringify(shapes);
        const plainBytes = Buffer.byteLength(text, "utf8");
        const cost =
            measured === undefined
                ? base64Length((await this.compress(text)).length)
                : Math.ceil((plainBytes / measured) * GZIP_ESTIMATE_MARGIN);
        return { raw: window, shapes, nextCursor, cost, plainBytes };
    }

    /**
     * Returns the byte budget to ask the backend for, from the room left in the reply and in the plain bytes of the
     * call.
     *
     * @param room - bytes left in the reply
     * @param ratio - bytes of JSON that one byte in the reply holds: 1, or the gzip ratio
     * @param plainLeft - bytes of JSON text that the call may still gather
     */
    private askBytes(room: number, ratio: number, plainLeft: number): number {
        const asked = Math.floor(room * ratio * WINDOW_SHARE);
        return Math.max(MIN_WINDOW_BYTES, Math.min(this.windowBytes, asked, Math.floor(plainLeft * WINDOW_SHARE)));
    }

    /**
     * Wraps the shapes of a reply in the gzip-base64 form, compressing them once.
     *
     * @param shapes - the shapes, in the caller's form
     */
    private async packed(shapes: unknown[]): Promise<Record<string, unknown>> {
        const text = JSON.stringify(shapes);
        return {
            encoding: GZIP_ENCODING,
            bytes: Buffer.byteLength(text, "utf8"),
            count: shapes.length,
            data: (await this.compress(text)).toString("base64"),
        };
    }

    /**
     * Returns the largest number of leading shapes of a window that fit a budget. A plain window is counted exactly.
     * A gzip window is counted by the compression ratio of the whole window, which is one compression and no search.
     *
     * @param window - the window, with its cost
     * @param budget - the bytes that the shapes may take in the reply
     * @param gzip - whether the shapes are compressed
     * @returns the count, which is 0 when even the first shape does not fit
     */
    private static fittingCount(window: ReadWindow, budget: number, gzip: boolean): number {
        const allowed = gzip ? budget * (window.plainBytes / window.cost) * GZIP_FIT_SHARE : budget;
        let sum = 0;
        for (let index = 0; index < window.shapes.length; index++) {
            sum += jsonBytes(window.shapes[index]) + (gzip ? 0 : 1);
            if (sum > allowed) {
                return index;
            }
        }
        return window.shapes.length;
    }

    /**
     * Returns a window that holds one shape, cut until the reply fits the response cap. The cut attributes are
     * listed in `oversize` with the id and the real size of the shape, and the cursor is the one after the shape. A
     * gzip reply is fitted by its plain size with some room, since the compressed size is known only at the end.
     *
     * @param head - the fields of the reply
     * @param window - the window that holds the shape, and only it
     * @param gzip - whether the shapes are compressed
     * @param cap - the response cap of this call
     * @throws Error when the shape does not fit even with every attribute but its id and type cut
     */
    private async trimmedWindow(head: ReplyHead, window: ReadWindow, gzip: boolean, cap: CallCap): Promise<ReadWindow> {
        const shape = window.shapes[0];
        if (!isRecord(shape)) {
            throw this.oversizeError(shape, cap);
        }
        const bytes = jsonBytes(shape);
        const trimmed: Record<string, unknown> = { ...shape };
        const omitted: string[] = [];
        const build = (): ReadWindow => ({
            ...window,
            shapes: [trimmed],
            cost: jsonBytes(trimmed) + 1,
            plainBytes: jsonBytes(trimmed),
            oversize: { id: shape.id, bytes, omitted: [...omitted] },
        });
        // a gzip reply is measured as it will be sent: compressed text can be larger than plain text
        const fits = async (): Promise<boolean> => {
            const built = build();
            const field = gzip ? await this.packed([trimmed]) : [trimmed];
            const reply = ExportSubtreeTool.replyOf(head, [built], field, this.noteOf([built], cap));
            return jsonBytes(reply) <= cap.bytes;
        };
        for (const key of ExportSubtreeTool.trimOrder(shape)) {
            if (await fits()) {
                break;
            }
            trimmed[key] = { omitted: true, bytes: jsonBytes(shape[key]) };
            omitted.push(key);
        }
        // with every value cut, only the id, the type and the markers are left, which fits any sane cap
        if (!(await fits())) {
            throw this.oversizeError(shape, cap);
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
     * Builds the error of one shape that does not fit the response cap even with its large attributes cut.
     *
     * @param shape - the shape, in the caller's form
     * @param cap - the response cap of this call
     */
    private oversizeError(shape: unknown, cap: CallCap): Error {
        const id = isRecord(shape) ? shape.id : undefined;
        return new Error(
            `Shape ${String(id)} is ${jsonBytes(shape)} bytes of JSON and does not fit the response cap of ` +
                `${cap.bytes} bytes even with its large attributes cut. ` +
                (this.atServerMax(cap)
                    ? `It does not fit even at the server maximum of ${this.requestMaxBytes / 1_000} kB.`
                    : `Raise ${this.raiseAdvice(cap, `${ExportSubtreeTool.CAP_VARIABLE} (in kilobytes, up to 10000)`)}.`)
        );
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
                const part = await this.callWindow(userToken, args, cursor, {
                    limit: MAX_LIMIT,
                    maxJsonBytes: this.windowBytes,
                });
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
                        ...(part.compact === true ? { compact: true, defaults: part.defaults } : {}),
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
     * @param size - the most shapes and bytes of JSON text of the window
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
            ...(args.compact === true ? { compact: true } : {}),
            limit: size.limit,
            maxJsonBytes: size.maxJsonBytes,
        };
        return this.callCommand<SubtreeWindow>(userToken, "get-mcp-subtree", params);
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
