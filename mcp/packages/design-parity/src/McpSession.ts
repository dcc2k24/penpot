import { McpLoadClient, type ToolCallOutcome } from "mcp-loadtest/dist/McpLoadClient.js";

/** Waits in milliseconds between the attempts of a transient failure. The last entry is the final wait. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 16000, 32000];

/** Prefix of the text the backend returns when a command fails. */
const BACKEND_FAILURE_PREFIX = "Tool execution failed:";

/** Retries of one call that the adapter rate-limited. The call did not run, so every tool may be retried. */
export const RATE_LIMIT_RETRIES = 5;

/** Wait before a rate-limited call is retried, when the error names no time. */
export const DEFAULT_RATE_WAIT_MS = 1000;

/**
 * Reads the wait that a rate-limit error asks for. The adapter says "retry after N s". The text is compared in lower
 * case and no regular expression is used.
 *
 * @param text - text of the failed call
 * @returns the wait in milliseconds, or undefined when the text is not a rate-limit error
 */
export function rateLimitWaitOf(text: string): number | undefined {
    const lower = text.toLowerCase();
    if (!lower.includes("rate limited") && !lower.includes("ratelimiterror")) {
        return undefined;
    }
    const marker = "retry after ";
    const at = lower.indexOf(marker);
    if (at < 0) {
        return DEFAULT_RATE_WAIT_MS;
    }
    const rest = lower.slice(at + marker.length).trim();
    let end = 0;
    while (end < rest.length && "0123456789.".includes(rest[end])) {
        end++;
    }
    const amount = Number(rest.slice(0, end));
    if (end === 0 || !Number.isFinite(amount)) {
        return DEFAULT_RATE_WAIT_MS;
    }
    return rest.slice(end).trimStart().startsWith("ms") ? amount : amount * 1000;
}

/**
 * Failure of one MCP tool call. The `transient` flag tells whether a retry may help. A rate-limited call has a
 * `retryAfterMs` wait.
 */
export class McpToolError extends Error {
    /** Name of the tool that failed. */
    readonly tool: string;
    /** True for a lost connection or a backend that gave no response; false for a rejected request. */
    readonly transient: boolean;
    /** Wait before the call may be retried, when the adapter rate-limited it. */
    readonly retryAfterMs: number | undefined;

    /**
     * Creates the error.
     *
     * @param tool - name of the tool that failed
     * @param message - backend error text or description of the transport failure
     * @param transient - whether a retry may succeed
     * @param retryAfterMs - wait before a retry, set when the adapter rate-limited the call
     */
    constructor(tool: string, message: string, transient: boolean, retryAfterMs?: number) {
        super(message);
        this.name = "McpToolError";
        this.tool = tool;
        this.transient = transient;
        this.retryAfterMs = retryAfterMs;
    }
}

/** The part of McpLoadClient that a session uses. Tests replace it with a fake. */
export interface ToolClient {
    /** Opens the session. */
    connect(url: string, token: string): Promise<void>;
    /** Calls one tool. */
    callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
    /** Closes the session. */
    close(): Promise<void>;
}

/** Collaborators of a session that tests replace. */
export interface SessionDeps {
    /** Builds a client for one connection. */
    createClient?: () => ToolClient;
    /** Waits for the given milliseconds. */
    wait?: (ms: number) => Promise<void>;
}

/**
 * Parsed successful result of one tool call.
 */
export interface CallResult {
    /** Parsed JSON body of the result. */
    readonly json: unknown;
    /** Raw text of the result. */
    readonly text: string;
}

/**
 * Options of one tool call.
 */
export interface CallOptions {
    /**
     * Retries transient failures with the backoff schedule when true, the default. Writes pass false. A rate-limited
     * call is retried whatever this flag says, because the adapter refused it before it ran.
     */
    readonly retryTransient?: boolean;
}

/**
 * Connection to the backend-mode MCP server with retries of transient failures.
 */
export class McpSession {
    private readonly url: string;
    private readonly token: string;
    private readonly createClient: () => ToolClient;
    private readonly wait: (ms: number) => Promise<void>;
    private client: ToolClient | undefined;

    /**
     * Creates a session that is not yet connected.
     *
     * @param url - Streamable HTTP endpoint of the MCP server
     * @param token - MCP access token, sent as a bearer token and never logged
     * @param deps - collaborators, replaced in tests
     */
    constructor(url: string, token: string, deps: SessionDeps = {}) {
        this.url = url;
        this.token = token;
        this.createClient = deps.createClient ?? (() => new McpLoadClient());
        this.wait = deps.wait ?? delay;
        this.client = undefined;
    }

    /**
     * Opens the MCP session, retrying transient failures with the backoff schedule.
     *
     * @throws McpToolError when every attempt failed
     */
    async connect(): Promise<void> {
        await this.retrying("connect", true, () => this.open());
    }

    /**
     * Calls one tool and returns its parsed result.
     *
     * @param tool - tool name, for example get_page_tree
     * @param args - tool arguments, camelCase
     * @param options - retry behaviour of this call
     * @throws McpToolError on a rejected request, or on a transient failure after the last retry
     */
    async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallResult> {
        const started = performance.now();
        const retry = options.retryTransient ?? true;
        try {
            const result = await this.retrying(tool, retry, () => this.attempt(tool, args));
            this.trace(tool, started, "ok");
            return result;
        } catch (error) {
            this.trace(tool, started, "failed");
            throw error;
        }
    }

    /**
     * Closes the MCP session. Closing a session that is not connected does nothing.
     */
    async close(): Promise<void> {
        await this.drop();
    }

    /**
     * Runs one operation. A rate-limited call waits the time the adapter names, at most RATE_LIMIT_RETRIES times. A
     * transient failure waits on the backoff schedule when `retry` is true.
     *
     * @param tool - tool name used in errors
     * @param retry - whether transient failures are retried
     * @param run - the operation to run
     */
    private async retrying<T>(tool: string, retry: boolean, run: () => Promise<T>): Promise<T> {
        let transientRetries = 0;
        let rateRetries = 0;
        for (;;) {
            try {
                return await run();
            } catch (error) {
                const failure = McpSession.toToolError(tool, error);
                if (failure.retryAfterMs !== undefined) {
                    if (rateRetries >= RATE_LIMIT_RETRIES) {
                        throw failure;
                    }
                    rateRetries++;
                    await this.wait(failure.retryAfterMs);
                    continue;
                }
                if (!failure.transient || !retry || transientRetries >= RETRY_DELAYS_MS.length) {
                    throw failure;
                }
                await this.wait(RETRY_DELAYS_MS[transientRetries] ?? 0);
                transientRetries++;
            }
        }
    }

    /**
     * Makes one attempt of a tool call, connecting first when needed.
     *
     * @param tool - tool name
     * @param args - tool arguments
     */
    private async attempt(tool: string, args: Record<string, unknown>): Promise<CallResult> {
        if (this.client === undefined) {
            await this.open();
        }
        const client = this.client;
        if (client === undefined) {
            throw new McpToolError(tool, "MCP session is not connected", true);
        }
        const outcome = await client.callTool(tool, args);
        if (outcome.error !== undefined) {
            await this.drop();
            throw new McpToolError(tool, `transport failure: ${outcome.error}`, true);
        }
        const text = outcome.text.trim();
        if (outcome.isError || text.startsWith(BACKEND_FAILURE_PREFIX)) {
            const waitMs = rateLimitWaitOf(text);
            if (waitMs !== undefined) {
                throw new McpToolError(tool, text, false, waitMs);
            }
        }
        if (text.startsWith(BACKEND_FAILURE_PREFIX)) {
            throw new McpToolError(tool, text, /got no response/.test(text));
        }
        if (outcome.isError) {
            throw new McpToolError(tool, text === "" ? "tool reported an error" : text, false);
        }
        if (outcome.json === undefined) {
            throw new McpToolError(tool, "tool result is not JSON", false);
        }
        return { json: outcome.json, text: outcome.text };
    }

    /**
     * Opens a new client and stores it, replacing any previous client.
     */
    private async open(): Promise<void> {
        const client = this.createClient();
        try {
            await client.connect(this.url, this.token);
        } catch (error) {
            throw new McpToolError("connect", `connection failed: ${McpSession.messageOf(error)}`, true);
        }
        this.client = client;
    }

    /**
     * Closes and forgets the current client, ignoring close errors.
     */
    private async drop(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        if (client !== undefined) {
            try {
                await client.close();
            } catch {
                // a dead transport cannot be closed cleanly, and the next attempt opens a new one
            }
        }
    }

    /**
     * Prints one trace line for a finished call when DESIGN_PARITY_TRACE is 1.
     *
     * @param tool - tool name
     * @param started - start time from performance.now()
     * @param outcome - "ok" or "failed"
     */
    private trace(tool: string, started: number, outcome: string): void {
        if (process.env.DESIGN_PARITY_TRACE === "1") {
            console.log(`[mcp] ${tool} ${(performance.now() - started).toFixed(0)} ms ${outcome}`);
        }
    }

    /**
     * Converts any thrown value into an McpToolError. Unknown failures count as transient.
     *
     * @param tool - tool name used when the value is not already an McpToolError
     * @param error - the thrown value
     */
    private static toToolError(tool: string, error: unknown): McpToolError {
        if (error instanceof McpToolError) {
            return error;
        }
        return new McpToolError(tool, McpSession.messageOf(error), true);
    }

    /**
     * Reads the message of a thrown value.
     *
     * @param error - the thrown value
     */
    private static messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Waits for the given time.
 *
 * @param ms - milliseconds to wait
 */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks that a parsed value is a JSON object and returns it typed.
 *
 * @param value - parsed JSON value
 * @param context - name of the call, used in the error
 * @throws Error when the value is not an object
 */
export function expectRecord(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context}: expected a JSON object`);
    }
    return value as Record<string, unknown>;
}

/**
 * Checks that a parsed value is an array and returns it typed.
 *
 * @param value - parsed JSON value
 * @param context - name of the field, used in the error
 * @throws Error when the value is not an array
 */
export function expectArray(value: unknown, context: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${context}: expected a JSON array`);
    }
    return value;
}
