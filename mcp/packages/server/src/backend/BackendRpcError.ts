/**
 * Error raised when the Penpot backend answers an RPC call with an error status.
 *
 * Keeps the decoded `{type, code, hint}` body so that callers can branch on the status or code. The
 * message names the code and hint, plus the `explain` text when the backend sends one. It never
 * contains the raw response body.
 */
export class BackendRpcError extends Error {
    /** Longest `context` rendering included in the message, in characters. */
    private static readonly MAX_CONTEXT_LENGTH = 500;

    /**
     * Creates an error for a failed backend command.
     *
     * @param status - HTTP status returned by the backend
     * @param commandName - name of the RPC command that failed
     * @param body - decoded error body, or `undefined` when the response was not a JSON object
     */
    constructor(
        public readonly status: number,
        public readonly commandName: string,
        public readonly body: Record<string, unknown> | undefined
    ) {
        super(BackendRpcError.describe(status, body));
        this.name = "BackendRpcError";
    }

    /** Backend error code (for example `not-found`), when the body carries one. */
    public get code(): string | undefined {
        return BackendRpcError.stringField(this.body, "code");
    }

    /** Backend error type (for example `validation`), when the body carries one. */
    public get type(): string | undefined {
        return BackendRpcError.stringField(this.body, "type");
    }

    /** Human-readable hint from the backend, when the body carries one. */
    public get hint(): string | undefined {
        return BackendRpcError.stringField(this.body, "hint");
    }

    /**
     * Decodes a response body text into an error body object.
     *
     * @param text - raw response body
     * @returns the decoded JSON object, or `undefined` when the text is not a JSON object
     */
    public static decodeBody(text: string): Record<string, unknown> | undefined {
        try {
            const parsed: unknown = JSON.parse(text);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // not JSON: the caller reports the status only
        }
        return undefined;
    }

    /**
     * Builds the message shown to users: the code (or status), the hint, and any explanation.
     *
     * @param status - HTTP status of the failed response
     * @param body - decoded error body, if any
     */
    private static describe(status: number, body: Record<string, unknown> | undefined): string {
        const code = BackendRpcError.stringField(body, "code") ?? `HTTP ${status}`;
        const hint = BackendRpcError.stringField(body, "hint") ?? "no details were returned";
        let message = `Backend error ${code}: ${hint}`;
        const explain = BackendRpcError.stringField(body, "explain");
        if (explain) {
            message += ` ${explain}`;
        }
        const context = body?.context;
        if (context !== undefined && context !== null) {
            const rendered = typeof context === "string" ? context : JSON.stringify(context);
            message += ` Context: ${rendered.slice(0, BackendRpcError.MAX_CONTEXT_LENGTH)}`;
        }
        return message;
    }

    /**
     * Returns a string field of an optional error body.
     *
     * @param body - decoded error body, if any
     * @param key - field name
     */
    private static stringField(body: Record<string, unknown> | undefined, key: string): string | undefined {
        const value = body?.[key];
        return typeof value === "string" ? value : undefined;
    }
}
