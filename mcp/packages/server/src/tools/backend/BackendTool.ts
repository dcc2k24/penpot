import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { BackendUpload, PenpotBackend, RpcCallOptions } from "../../PenpotBackendClient";
import { Tool } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import { CallContext } from "../../backend/CallContext";
import type { BackendServices } from "../../backend/BackendServices";
import { TokenDigest } from "../../backend/TokenDigest";
import { WriteCounter } from "./WriteCounter";

/**
 * Base class of tools that call the Penpot backend with the MCP token of the request.
 *
 * Every call validates the token, applies the per-token rate limit and, for writes, waits for earlier
 * writes to the same file. Subclasses implement {@link executeBackend}, which receives the token.
 *
 * @template TArgs - the strongly-typed arguments class for this tool
 */
export abstract class BackendTool<TArgs extends object> extends Tool<TArgs> {
    /** Largest JSON response returned to the client, in bytes, unless the setting changes it. */
    public static readonly MAX_RESPONSE_BYTES = 100_000;

    /** Environment variable that sets the response cap, in kilobytes. */
    public static readonly MAX_RESPONSE_KB_VARIABLE = "PENPOT_MCP_MAX_TOOL_RESPONSE_KB";

    /** Most files whose write counts are kept in this process. */
    private static readonly WRITE_COUNT_FILES = 4096;

    /** Longest string kept whole in a truncated response; longer strings are cut when arrays alone do not fit. */
    private static readonly STRING_CUT_CHARS = 200;

    /** Note added when the adapter drops `nextCursor` from a truncated answer. */
    private static readonly CURSOR_NOTE =
        "nextCursor was removed, because it points past the nodes that were cut. Repeat the call with a smaller limit.";

    /** Note added when the adapter drops `nextOffset` from a truncated answer. */
    private static readonly OFFSET_NOTE =
        "nextOffset was removed, because it points past the items that were cut. Narrow the request instead.";

    /** Writes that ended, per token and file, in this process; bounded, so that many files cannot grow it. */
    private static readonly writeCounter = new WriteCounter(BackendTool.WRITE_COUNT_FILES);

    /** Largest JSON response this tool returns, in bytes. */
    private readonly maxResponseBytes: number;

    /**
     * Creates a backend tool.
     *
     * @param mcpServer - The MCP server instance
     * @param inputSchema - zod shape of the tool arguments
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     * @throws Error when the response cap setting is not a whole number of kilobytes
     */
    constructor(
        mcpServer: PenpotMcpServer,
        inputSchema: z.ZodRawShape,
        protected readonly services: BackendServices
    ) {
        super(mcpServer, inputSchema);
        this.maxResponseBytes = BackendTool.readMaxResponseBytes(process.env);
    }

    /**
     * Resolves the MCP token, applies the rate limit and token validation, then runs the tool.
     *
     * @param args - the validated tool arguments
     * @throws Error when the request carries no token, the token is rejected or the rate limit is reached
     */
    protected async executeCore(args: TArgs): Promise<ToolResponse> {
        const userToken = this.getSessionContext()?.userToken;
        if (!userToken?.trim()) {
            throw new Error("No MCP token was given. Send it as an Authorization: Bearer header.");
        }
        await this.services.rateLimiter.acquire(userToken);
        await this.services.validator.validate(userToken);
        return this.executeBackend(args, userToken);
    }

    /**
     * Runs the tool against the backend once the token is validated and admitted by the rate limiter.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected abstract executeBackend(args: TArgs, userToken: string): Promise<ToolResponse>;

    /**
     * Calls a backend command that does not change the design.
     *
     * @param userToken - the MCP token of the request
     * @param name - backend command name, for example `get-teams`
     * @param params - command parameters, in camelCase
     * @param options - per-call options such as the timeout
     */
    protected callCommand<T = unknown>(
        userToken: string,
        name: string,
        params: object,
        options: RpcCallOptions = {}
    ): Promise<T> {
        return this.backend().callCommand<T>(userToken, name, params, options);
    }

    /**
     * Calls a backend command that changes a file, after earlier writes to the same file finished.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file the write targets
     * @param name - backend command name, for example `mcp-apply-operations`
     * @param params - command parameters, in camelCase
     */
    protected callWrite<T = unknown>(userToken: string, fileId: string, name: string, params: object): Promise<T> {
        return this.queueWrite(userToken, fileId, () => this.callCommand<T>(userToken, name, params));
    }

    /**
     * Runs a task that changes a file, after earlier writes to the same file finished.
     *
     * The task runs in the queue, so it sees what the earlier writes changed. A task whose request was cancelled
     * before it started is not run. When the task ends, the write count of the file grows, which ends the life of
     * any token catalogue read before it.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file the write targets
     * @param task - the work to run in the queue
     * @param countsAsWrite - false for a task that leaves the file as it is, such as a dry run
     */
    protected queueWrite<T>(
        userToken: string,
        fileId: string,
        task: () => Promise<T>,
        countsAsWrite: boolean = true
    ): Promise<T> {
        const key = BackendTool.writeKey(userToken, fileId);
        // the queue skips a write whose call was abandoned, and runs a started write without its signal
        return this.services.writeQueue.run(TokenDigest.sha256Hex(userToken), fileId, async () => {
            try {
                return await task();
            } finally {
                if (countsAsWrite) {
                    BackendTool.writeCounter.recordWrite(key);
                }
            }
        });
    }

    /**
     * Returns the number of writes to a file that ended in this process, as a version of the file.
     *
     * A reader that caches something of the file compares this number to tell whether the cache is still valid.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file to look up
     */
    protected writeCount(userToken: string, fileId: string): number {
        return BackendTool.writeCounter.countOf(BackendTool.writeKey(userToken, fileId));
    }

    /**
     * Calls a multipart backend command, which carries form fields and file parts.
     *
     * @param userToken - the MCP token of the request
     * @param name - backend command name, for example `import-binfile`
     * @param fields - form fields of the request, keyed by their kebab-case names
     * @param uploads - file parts of the request
     * @param options - per-call options such as the timeout
     */
    protected callMultipart<T = unknown>(
        userToken: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[],
        options: RpcCallOptions = {}
    ): Promise<T> {
        return this.backend().callMultipart<T>(userToken, name, fields, uploads, options);
    }

    /**
     * Calls a multipart backend command that changes a file, after earlier writes to the same file finished.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file the write targets
     * @param name - backend command name, for example `upload-file-media-object`
     * @param fields - form fields of the request, keyed by their kebab-case names
     * @param uploads - file parts of the request
     */
    protected callMultipartWrite<T = unknown>(
        userToken: string,
        fileId: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[]
    ): Promise<T> {
        return this.queueWrite(userToken, fileId, () => this.callMultipart<T>(userToken, name, fields, uploads));
    }

    /**
     * Wraps a value as a compact JSON text response, cut when it is above the response cap of this tool.
     *
     * @param value - the value to return
     */
    protected jsonResponse(value: unknown): ToolResponse {
        return new TextResponse(BackendTool.formatJson(value, this.maxResponseBytes));
    }

    /**
     * Runs backend calls that must finish once sent, so the caller's abort signal does not reach them.
     *
     * Use it for writes that do not go through the file queue. Writes in the queue already run without the
     * signal once they start.
     *
     * @param run - the calls to make
     */
    protected withoutAbort<T>(run: () => Promise<T>): Promise<T> {
        return CallContext.withoutSignal(run);
    }

    /**
     * Reports progress of the current call to the client, when the client asked for progress.
     *
     * Does nothing when the call carries no progress callback, which is the case outside an MCP request.
     *
     * @param step - the number of steps done
     * @param total - the number of steps in all
     * @param message - what has just happened, in words
     */
    protected reportProgress(step: number, total: number, message: string): void {
        // a progress notification that fails must not fail the call that reports it
        CallContext.current()
            ?.progress?.(step, total, message)
            ?.catch(() => undefined);
    }

    /**
     * Reads the response cap from the environment.
     *
     * @param env - environment to read; the process environment in production
     * @returns the cap in bytes, the default when the setting is unset
     * @throws Error when the setting is set and is not a whole number of kilobytes from 1 to 10000
     */
    public static readMaxResponseBytes(env: NodeJS.ProcessEnv): number {
        return BackendTool.readCapBytes(env, BackendTool.MAX_RESPONSE_KB_VARIABLE, BackendTool.MAX_RESPONSE_BYTES);
    }

    /**
     * Reads a response cap, in whole kilobytes, from one environment variable. The shared cap and the cap of one
     * tool use the same range.
     *
     * @param env - environment to read; the process environment in production
     * @param variable - name of the variable that holds the cap in kilobytes
     * @param fallback - cap in bytes when the variable is unset or empty
     * @returns the cap in bytes
     * @throws Error when the variable is set and is not a whole number of kilobytes from 1 to 10000
     */
    public static readCapBytes(env: NodeJS.ProcessEnv, variable: string, fallback: number): number {
        const raw = env[variable];
        if (raw === undefined || raw.trim() === "") {
            return fallback;
        }
        const kilobytes = Number(raw);
        if (!Number.isInteger(kilobytes) || kilobytes < 1 || kilobytes > 10_000) {
            throw new Error(`${variable} must be a whole number of kilobytes from 1 to 10000, got "${raw}".`);
        }
        return kilobytes * 1_000;
    }

    /**
     * Serialises a value as compact JSON, or returns valid JSON that describes a trimmed copy when it is too large.
     *
     * A value within the limit is returned as compact JSON. A larger one becomes the object
     * `{ truncated, note, partial }`, where `partial` keeps the first items of every array (the same count for
     * all arrays, as large as fits). When even that does not fit, strings longer than a short cut are cut too.
     * `note` names each array it cut by its JSON path. A `nextCursor` of the value is dropped, since it would
     * skip the cut items.
     *
     * @param value - the value to format; `undefined` is printed as `null`
     * @param maxBytes - largest text returned, in UTF-8 bytes
     */
    public static formatJson(value: unknown, maxBytes: number = BackendTool.MAX_RESPONSE_BYTES): string {
        const text = JSON.stringify(value) ?? "null";
        if (Buffer.byteLength(text, "utf8") <= maxBytes) {
            return text;
        }
        return BackendTool.truncatedText(value, maxBytes);
    }

    /**
     * Wraps a reply that holds one list as a JSON text response, with whole items only.
     *
     * A reply within the cap is returned as it is. A larger one keeps as many leading items of the list as fit,
     * leaving room for the other fields, and gets `truncated: true`, `nextOffset` (the `offset` of the call plus
     * the items kept) and a `note`. A client that calls again with `nextOffset` as its `offset` reads every item
     * once while `revn` stays the same. A reply with `timedOut` true is cut at whole items too, but gets no
     * `nextOffset`: its list is not complete and cannot be continued, so the note says to narrow the call. When
     * not even one item fits, the generic cut of {@link formatJson} applies, and it drops `nextOffset`.
     *
     * @param value - the reply of the backend; an object that holds the list at `listKey`
     * @param listKey - name of the list field
     * @param offset - the offset the call asked for, 0 when it asked for none
     * @param narrow - what a caller can narrow after a time cut, for the note, for example "fewer rules"
     */
    protected pagedJsonResponse(value: unknown, listKey: string, offset: number, narrow: string): ToolResponse {
        return new TextResponse(BackendTool.formatPagedJson(value, listKey, offset, narrow, this.maxResponseBytes));
    }

    /**
     * Serialises a reply that holds one list, cutting the list at a whole item when the text is too large.
     *
     * @param value - the reply of the backend
     * @param listKey - name of the list field
     * @param offset - the offset the call asked for
     * @param narrow - what a caller can narrow after a time cut, for the note
     * @param maxBytes - largest text returned, in UTF-8 bytes
     */
    public static formatPagedJson(
        value: unknown,
        listKey: string,
        offset: number,
        narrow: string,
        maxBytes: number = BackendTool.MAX_RESPONSE_BYTES
    ): string {
        const object = value !== null && typeof value === "object" && !Array.isArray(value);
        const reply = (object ? value : {}) as Record<string, unknown>;
        const list = object ? reply[listKey] : null;
        const timedOut = reply.timedOut === true;
        // a note that the backend sent stays, and the notes of the adapter follow it
        const joined = (...notes: string[]): string =>
            [typeof reply.note === "string" ? reply.note : "", ...notes].filter((note) => note !== "").join(" ");
        const timeNote =
            "The call ran out of time, so the list and the totals are not complete, and it cannot be continued " +
            `with offset. Start again with a narrower call: ${narrow}.`;
        // a reply that ran out of time carries its note, whether or not the list is cut by bytes
        const whole = timedOut ? { ...reply, note: joined(timeNote) } : value;
        const text = JSON.stringify(whole) ?? "null";
        if (Buffer.byteLength(text, "utf8") <= maxBytes || !Array.isArray(list)) {
            return BackendTool.formatJson(whole, maxBytes);
        }
        const { nextOffset: _dropped, ...rest } = reply;
        const render = (kept: number): string =>
            JSON.stringify({
                ...rest,
                [listKey]: list.slice(0, kept),
                truncated: true,
                ...(timedOut ? {} : { nextOffset: offset + kept }),
                note: timedOut
                    ? joined(`Reply cut to fit ${maxBytes} bytes: kept ${kept} of the ${list.length} items.`, timeNote)
                    : joined(
                          `Reply cut to fit ${maxBytes} bytes: kept ${kept} of the ${list.length} items this call ` +
                              `read. Call again with offset ${offset + kept} for the rest.`
                      ),
            });
        let low = 1;
        let high = list.length - 1;
        let best: string | undefined;
        while (low <= high) {
            const kept = Math.floor((low + high) / 2);
            const candidate = render(kept);
            if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
                best = candidate;
                low = kept + 1;
            } else {
                high = kept - 1;
            }
        }
        return best ?? BackendTool.formatJson(whole, maxBytes);
    }

    /**
     * Builds the truncation envelope of a value, from the value itself and not from its text.
     *
     * @param value - the value that is too large
     * @param maxBytes - largest text returned, in UTF-8 bytes
     */
    private static truncatedText(value: unknown, maxBytes: number): string {
        const limitText = maxBytes === BackendTool.MAX_RESPONSE_BYTES ? "100 kB" : `${maxBytes} bytes`;
        const notes: string[] = [`truncated: the response exceeded ${limitText}`];
        const root = BackendTool.withoutCursor(value, notes);
        const trimmer = new ArrayTrimmer(root);
        const fitted =
            BackendTool.fitEnvelope(trimmer, maxBytes, Number.POSITIVE_INFINITY, notes) ??
            BackendTool.fitEnvelope(trimmer, maxBytes, BackendTool.STRING_CUT_CHARS, notes);
        if (fitted !== undefined) {
            return fitted;
        }
        return JSON.stringify({
            truncated: true,
            note:
                `truncated: the response exceeded ${limitText}, and even with every array emptied it is too large ` +
                "to show. Narrow the request with fewer ids, a smaller limit, explicit fields or a cursor.",
            partial: null,
        });
    }

    /**
     * Finds the largest per-array item count whose envelope fits, and renders that envelope.
     *
     * @param trimmer - trimmer over the value to fit
     * @param maxBytes - largest text returned, in UTF-8 bytes
     * @param maxString - longest string kept whole; longer strings are cut
     * @param notes - notes that every envelope carries, such as the dropped cursor
     * @returns the envelope text, or `undefined` when no item count fits
     */
    private static fitEnvelope(
        trimmer: ArrayTrimmer,
        maxBytes: number,
        maxString: number,
        notes: string[]
    ): string | undefined {
        let low = 0;
        let high = trimmer.longestArray;
        let best: string | undefined;
        while (low <= high) {
            const limit = Math.floor((low + high) / 2);
            const candidate = BackendTool.envelopeText(trimmer.trim(limit, maxString), notes);
            if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
                best = candidate;
                low = limit + 1;
            } else {
                high = limit - 1;
            }
        }
        return best;
    }

    /**
     * Renders a trimmed value as the truncation envelope, in compact JSON.
     *
     * @param trimmed - the kept structure and the notes about what it cut
     * @param notes - notes from before the trimming
     */
    private static envelopeText(trimmed: TrimmedValue, notes: string[]): string {
        const allNotes = [...notes, ...trimmed.notes];
        return JSON.stringify({ truncated: true, note: allNotes.join("; "), partial: trimmed.value });
    }

    /**
     * Removes `nextCursor` from the top level of an object, and notes it when it was there.
     *
     * @param value - the value to copy
     * @param notes - receives the cursor note when the cursor is removed
     */
    private static withoutCursor(value: unknown, notes: string[]): unknown {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return value;
        }
        if ("nextCursor" in value) {
            notes.push(BackendTool.CURSOR_NOTE);
        }
        if ("nextOffset" in value) {
            notes.push(BackendTool.OFFSET_NOTE);
        }
        return Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "nextCursor" && key !== "nextOffset")
        );
    }

    /**
     * Returns the key of the write count of a file: the token digest and the file id.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file id
     */
    private static writeKey(userToken: string, fileId: string): string {
        return `${TokenDigest.sha256Hex(userToken)}:${fileId}`;
    }

    private backend(): PenpotBackend {
        return this.services.backend;
    }
}

/** A trimmed copy of a parsed value and one note per array or string it cut. */
interface TrimmedValue {
    value: unknown;
    notes: string[];
}

/**
 * Copies a JSON value, keeping the same number of leading items in every array.
 *
 * Each array longer than the limit is cut, and its JSON path with the kept and total item counts is noted.
 * Strings longer than the string cut are cut too, and one note counts them.
 */
class ArrayTrimmer {
    /** Length of the longest array in the value, which bounds any limit that trims something. */
    public readonly longestArray: number;

    /**
     * Creates a trimmer for one value.
     *
     * @param root - the JSON value; it is not modified
     */
    public constructor(private readonly root: unknown) {
        this.longestArray = ArrayTrimmer.measureLongest(root);
    }

    /**
     * Copies the value, keeping at most `limit` items of each array and at most `maxString` characters of each
     * string.
     *
     * @param limit - the number of leading items kept per array
     * @param maxString - the longest string kept whole
     */
    public trim(limit: number, maxString: number): TrimmedValue {
        const notes: string[] = [];
        const counter = { cutStrings: 0 };
        const value = this.copy(this.root, "$", limit, maxString, notes, counter);
        if (counter.cutStrings > 0) {
            const plural = counter.cutStrings === 1 ? "" : "s";
            notes.push(`${counter.cutStrings} long string${plural} cut to ${maxString} characters`);
        }
        return { value, notes };
    }

    /**
     * Copies one node of the value, trimming the arrays and strings below it.
     *
     * @param node - the node to copy
     * @param path - JSON path of the node, for the notes
     * @param limit - the number of leading items kept per array
     * @param maxString - the longest string kept whole
     * @param notes - receives one note per array that is cut
     * @param counter - counts the strings that are cut
     */
    private copy(
        node: unknown,
        path: string,
        limit: number,
        maxString: number,
        notes: string[],
        counter: { cutStrings: number }
    ): unknown {
        if (typeof node === "string") {
            if (node.length <= maxString) {
                return node;
            }
            counter.cutStrings += 1;
            return `${node.slice(0, maxString)}...`;
        }
        if (Array.isArray(node)) {
            if (node.length > limit) {
                notes.push(`${path}: kept ${limit} of ${node.length} items`);
            }
            return node
                .slice(0, limit)
                .map((item: unknown, index: number) =>
                    this.copy(item, `${path}[${index}]`, limit, maxString, notes, counter)
                );
        }
        if (node !== null && typeof node === "object") {
            return Object.fromEntries(
                Object.entries(node).map(([key, child]) => [
                    key,
                    this.copy(child, ArrayTrimmer.childPath(path, key), limit, maxString, notes, counter),
                ])
            );
        }
        return node;
    }

    /**
     * Builds the JSON path of an object member, quoting keys that are not identifiers.
     *
     * @param path - JSON path of the object
     * @param key - member name
     */
    private static childPath(path: string, key: string): string {
        return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
    }

    /**
     * Finds the length of the longest array in a value, without recursion.
     *
     * @param root - the JSON value
     */
    private static measureLongest(root: unknown): number {
        let longest = 0;
        const pending: unknown[] = [root];
        while (pending.length > 0) {
            const current = pending.pop();
            if (Array.isArray(current)) {
                longest = Math.max(longest, current.length);
            }
            if (current !== null && typeof current === "object") {
                for (const child of Object.values(current)) {
                    pending.push(child);
                }
            }
        }
        return longest;
    }
}
