import { RateLimitError } from "./TokenRateLimiter";

/** Seconds to wait that the message names when the backend refusal gives no retry time. */
const DEFAULT_RETRY_SECONDS = 10;

/**
 * Longest wait that the message names, in seconds. For a bucket limit the `retry-after` header of the backend is the
 * time until the whole bucket is full again (about 120 s for the read bucket), but a permit comes back every 100 ms,
 * so a short wait is enough to go on. The header is used only up to this value.
 */
const MAX_RETRY_SECONDS = 10;

/**
 * The backend refused a call on its own rate limit (HTTP 429, type `rate-limit`, code `request-blocked`).
 *
 * The refusal comes before the command runs, so nothing was changed, and a cursor from an earlier reply stays
 * valid. It is a {@link RateLimitError}, so tools report it like the limit of the adapter.
 */
export class BackendRateLimitError extends RateLimitError {
    /**
     * Creates the error.
     *
     * @param retryAfterSeconds - whole seconds to wait, from the `retry-after` header of the refusal, or
     *     `undefined` when the refusal gave none
     */
    constructor(public readonly retryAfterSeconds: number | undefined) {
        super(
            retryAfterSeconds === undefined
                ? `backend rate limit reached, wait about ${DEFAULT_RETRY_SECONDS} s and retry. A cursor from an ` +
                      "earlier reply stays valid."
                : `backend rate limit reached, retry after ${retryAfterSeconds} s. A cursor from an earlier reply ` +
                      "stays valid."
        );
        this.name = "BackendRateLimitError";
    }

    /**
     * Reads the seconds to wait from the `retry-after` header of a refusal, rounded up and at most
     * {@link MAX_RETRY_SECONDS}, because the header gives the time to a full bucket, not to the next permit.
     *
     * @param header - value of the header, or null when it is absent
     * @returns whole seconds from 1 to 10, or `undefined` when the header is absent or not a number of seconds
     */
    public static secondsFrom(header: string | null): number | undefined {
        if (header === null || header.trim() === "") {
            return undefined;
        }
        const seconds = Number(header);
        return Number.isFinite(seconds) && seconds >= 0
            ? Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(seconds)))
            : undefined;
    }

    /**
     * Tells whether a decoded error body and status are the rate-limit refusal of the backend.
     *
     * @param status - HTTP status of the response
     * @param body - decoded error body, if any
     */
    public static matches(status: number, body: Record<string, unknown> | undefined): boolean {
        return status === 429 && (body?.type === "rate-limit" || body?.code === "request-blocked");
    }
}

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
