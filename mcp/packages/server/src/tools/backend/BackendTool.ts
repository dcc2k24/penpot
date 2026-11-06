import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { BackendUpload, PenpotBackend, RpcCallOptions } from "../../PenpotBackendClient";
import { Tool } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { TokenDigest } from "../../backend/TokenDigest";

/**
 * Base class of tools that call the Penpot backend with the MCP token of the request.
 *
 * Every call validates the token, applies the per-token rate limit and, for writes, waits for earlier
 * writes to the same file. Subclasses implement {@link executeBackend}, which receives the token.
 *
 * @template TArgs - the strongly-typed arguments class for this tool
 */
export abstract class BackendTool<TArgs extends object> extends Tool<TArgs> {
    /** Largest JSON response returned to the client, in bytes. */
    public static readonly MAX_RESPONSE_BYTES = 1_000_000;

    /**
     * Creates a backend tool.
     *
     * @param mcpServer - The MCP server instance
     * @param inputSchema - zod shape of the tool arguments
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     */
    constructor(
        mcpServer: PenpotMcpServer,
        inputSchema: z.ZodRawShape,
        protected readonly services: BackendServices
    ) {
        super(mcpServer, inputSchema);
    }

    /**
     * Resolves the MCP token, applies the rate limit and token validation, then runs the tool.
     *
     * @throws Error when the request carries no token, the token is rejected or the rate limit is reached
     */
    protected async executeCore(args: TArgs): Promise<ToolResponse> {
        const userToken = this.getSessionContext()?.userToken;
        if (!userToken?.trim()) {
            throw new Error(
                "No MCP token was given. Send it as an Authorization: Bearer header, " +
                    "or as the userToken query parameter of the server URL."
            );
        }
        this.services.rateLimiter.acquire(userToken);
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
        options?: RpcCallOptions
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
        return this.services.writeQueue.run(TokenDigest.sha256Hex(userToken), fileId, () =>
            this.callCommand<T>(userToken, name, params)
        );
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
        options?: RpcCallOptions
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
        return this.services.writeQueue.run(TokenDigest.sha256Hex(userToken), fileId, () =>
            this.callMultipart<T>(userToken, name, fields, uploads)
        );
    }

    /**
     * Wraps a value as a pretty-printed JSON text response.
     *
     * @param value - the value to return
     */
    protected jsonResponse(value: unknown): ToolResponse {
        return new TextResponse(BackendTool.formatJson(value));
    }

    /**
     * Pretty-prints a value as JSON, or returns valid JSON that describes a trimmed copy when it is too large.
     *
     * A value within the limit is returned as pretty-printed JSON. A larger one becomes the object
     * `{ truncated, note, partial }`, where `partial` keeps the first items of every array (the same count
     * for all arrays, as large as fits) and `note` names each array it cut by its JSON path.
     *
     * @param value - the value to format; `undefined` is printed as `null`
     * @param maxBytes - largest text returned, in UTF-8 bytes
     */
    public static formatJson(value: unknown, maxBytes: number = BackendTool.MAX_RESPONSE_BYTES): string {
        const text = JSON.stringify(value, null, 2) ?? "null";
        if (Buffer.byteLength(text, "utf8") <= maxBytes) {
            return text;
        }
        return BackendTool.truncatedText(JSON.parse(text) as unknown, maxBytes);
    }

    /**
     * Finds the largest per-array item count whose truncation envelope fits, and renders that envelope.
     *
     * @param root - the parsed value to trim; it is not modified
     * @param maxBytes - largest text returned, in UTF-8 bytes
     */
    private static truncatedText(root: unknown, maxBytes: number): string {
        const trimmer = new ArrayTrimmer(root);
        let low = 0;
        let high = trimmer.longestArray;
        let best: string | undefined;
        while (low <= high) {
            const limit = Math.floor((low + high) / 2);
            const candidate = BackendTool.envelopeText(trimmer.trim(limit));
            if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
                best = candidate;
                low = limit + 1;
            } else {
                high = limit - 1;
            }
        }
        if (best !== undefined) {
            return best;
        }
        const limitText = maxBytes === BackendTool.MAX_RESPONSE_BYTES ? "1 MB" : `${maxBytes} bytes`;
        return JSON.stringify(
            {
                truncated: true,
                note:
                    `truncated: the response exceeded ${limitText}, and even with every array emptied it is too large ` +
                    "to show. Narrow the request with fewer ids, a smaller limit, explicit fields or a cursor.",
                partial: null,
            },
            null,
            2
        );
    }

    /**
     * Renders a trimmed value as the truncation envelope.
     *
     * @param trimmed - the kept structure and the notes about the arrays it cut
     */
    private static envelopeText(trimmed: TrimmedValue): string {
        return JSON.stringify({ truncated: true, note: trimmed.notes.join("; "), partial: trimmed.value }, null, 2);
    }

    private backend(): PenpotBackend {
        return this.services.backend;
    }
}

/** A trimmed copy of a parsed value and one note per array it cut. */
interface TrimmedValue {
    value: unknown;
    notes: string[];
}

/**
 * Copies a parsed JSON value, keeping the same number of leading items in every array.
 *
 * Each array longer than the limit is cut, and its JSON path with the kept and total item counts is noted.
 */
class ArrayTrimmer {
    /** Length of the longest array in the value, which bounds any limit that trims something. */
    public readonly longestArray: number;

    /**
     * Creates a trimmer for one parsed value.
     *
     * @param root - the parsed JSON value; it is not modified
     */
    public constructor(private readonly root: unknown) {
        this.longestArray = ArrayTrimmer.measureLongest(root);
    }

    /**
     * Copies the value, keeping at most `limit` items of each array.
     *
     * @param limit - the number of leading items kept per array
     */
    public trim(limit: number): TrimmedValue {
        const notes: string[] = [];
        const value = this.copy(this.root, "$", limit, notes);
        return { value, notes };
    }

    /**
     * Copies one node of the value, trimming the arrays below it.
     *
     * @param node - the parsed node to copy
     * @param path - JSON path of the node, for the notes
     * @param limit - the number of leading items kept per array
     * @param notes - receives one note per array that is cut
     */
    private copy(node: unknown, path: string, limit: number, notes: string[]): unknown {
        if (Array.isArray(node)) {
            if (node.length > limit) {
                notes.push(`${path}: kept ${limit} of ${node.length} items`);
            }
            return node
                .slice(0, limit)
                .map((item: unknown, index: number) => this.copy(item, `${path}[${index}]`, limit, notes));
        }
        if (node !== null && typeof node === "object") {
            return Object.fromEntries(
                Object.entries(node).map(([key, child]) => [
                    key,
                    this.copy(child, ArrayTrimmer.childPath(path, key), limit, notes),
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
     * @param root - the parsed JSON value
     */
    private static measureLongest(root: unknown): number {
        let longest = 0;
        const pending: unknown[] = [root];
        let current = pending.pop();
        while (current !== undefined) {
            if (Array.isArray(current)) {
                longest = Math.max(longest, current.length);
            }
            if (current !== null && typeof current === "object") {
                for (const child of Object.values(current)) {
                    pending.push(child);
                }
            }
            current = pending.pop();
        }
        return longest;
    }
}
