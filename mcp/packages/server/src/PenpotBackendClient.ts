import type { Dispatcher } from "undici";
import { createLogger } from "./logger";
import { BackendRateLimitError, BackendRpcError } from "./backend/BackendRpcError";
import { BackendSettings } from "./backend/BackendSettings";
import { CallContext } from "./backend/CallContext";
import { withDispatcher } from "./backend/ConnectionPools";
import { ServerSentEvents } from "./backend/ServerSentEvents";
import { Transit } from "./backend/Transit";

/** A plain-text MCP feedback report. */
export interface Feedback {
    subject: string;
    feedback: string;
}

/** A binary part of a multipart backend call. */
export interface BackendUpload {
    /** Form field that carries the file. */
    fieldName: string;
    /** File name sent with the part. */
    fileName: string;
    /** MIME type of the content. */
    mimeType: string;
    /** Raw file content. */
    content: Uint8Array;
}

/** Per-call options for backend commands. */
export interface RpcCallOptions {
    /** Overrides the configured timeout for this call, in milliseconds. */
    timeoutMs?: number;
    /**
     * Fires when the caller gives up. Defaults to the signal of the current tool call.
     *
     * A command that changes state is never aborted by this signal, even when it has not been sent yet:
     * the backend may already have applied it, and the caller then cannot tell what happened. The rule is
     * applied by name (see {@link isWriteCommand}), so writes that skip the file queue are covered too.
     */
    signal?: AbortSignal;
    /**
     * Set to `false` to stop the signal of the call from aborting this command, even a read. Use it for a
     * call that must finish, such as a cleanup after the client has gone.
     */
    abortable?: boolean;
}

/** Name prefixes of backend commands that change state. */
const WRITE_COMMAND_PREFIXES = [
    "create-",
    "delete-",
    "duplicate-",
    "move-",
    "rename-",
    "restore-",
    "update-",
    "lock-",
    "unlock-",
    "import-",
    "mcp-apply-",
    "mcp-import-",
];

/**
 * Reports whether a backend command changes state, judged by its name.
 *
 * @param name - the backend command name, for example `delete-project`
 */
export function isWriteCommand(name: string): boolean {
    return WRITE_COMMAND_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Backend operations available to MCP tools. */
export interface PenpotBackend {
    /** Queues a feedback mail for the given user token. */
    submitFeedback(userToken: string, feedback: Feedback): Promise<void>;

    /**
     * Calls a backend RPC command with JSON parameters and returns its parsed result.
     *
     * @throws BackendRpcError when the backend answers with an error status
     */
    callCommand<T = unknown>(userToken: string, name: string, params: object, options?: RpcCallOptions): Promise<T>;

    /**
     * Calls a backend RPC command as multipart form data and returns its parsed result.
     *
     * Server-sent event responses resolve to the data of their `end` event, and fail when there is none.
     *
     * @throws BackendRpcError when the backend answers with an error status
     */
    callMultipart<T = unknown>(
        userToken: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[],
        options?: RpcCallOptions
    ): Promise<T>;
}

/** Client for the configured Penpot instance's backend services. */
export class PenpotBackendClient implements PenpotBackend {
    /** Timeout of the feedback mail submission, in milliseconds. */
    private static readonly FEEDBACK_TIMEOUT_MS = 10_000;
    /** Bytes in one megabyte, the unit of the response body cap. */
    private static readonly BYTES_PER_MB = 1024 * 1024;

    private readonly logger = createLogger("PenpotBackendClient");
    private readonly baseUri: URL;
    private readonly maxResponseMb: number;
    private readonly maxResponseBytes: number;

    /**
     * Creates a client for one Penpot instance.
     *
     * @param baseUri - absolute HTTP(S) URI of the instance, without credentials, query or fragment
     * @param timeoutSeconds - default timeout of backend commands, in seconds
     * @param maxResponseMb - cap on the body of one backend response, in megabytes
     * @param dispatcher - connection pool passed to `fetch` for every call, or undefined for the global pool
     */
    constructor(
        baseUri: string,
        private readonly timeoutSeconds: number = BackendSettings.DEFAULT_TIMEOUT_SECONDS,
        maxResponseMb: number = BackendSettings.DEFAULT_MAX_RESPONSE_MB,
        private readonly dispatcher?: Dispatcher
    ) {
        try {
            this.baseUri = new URL(baseUri);
        } catch {
            throw new Error("PENPOT_MCP_BACKEND_URI must be an absolute HTTP(S) instance URI.");
        }
        if (
            !["http:", "https:"].includes(this.baseUri.protocol) ||
            this.baseUri.username ||
            this.baseUri.password ||
            this.baseUri.search ||
            this.baseUri.hash
        ) {
            throw new Error(
                "PENPOT_MCP_BACKEND_URI must be an HTTP(S) instance URI without credentials, query or fragment."
            );
        }
        if (!this.baseUri.pathname.endsWith("/")) this.baseUri.pathname += "/";
        if (!Number.isFinite(maxResponseMb) || maxResponseMb <= 0) {
            throw new Error("The backend response cap must be a positive number of megabytes.");
        }
        this.maxResponseMb = maxResponseMb;
        this.maxResponseBytes = Math.floor(maxResponseMb * PenpotBackendClient.BYTES_PER_MB);
    }

    public async submitFeedback(userToken: string, feedback: Feedback): Promise<void> {
        await this.postFeedback("send-mcp-feedback", userToken, feedback);
    }

    public async callCommand<T = unknown>(
        userToken: string,
        name: string,
        params: object,
        options: RpcCallOptions = {}
    ): Promise<T> {
        const response = await this.send(
            name,
            {
                method: "POST",
                headers: this.headers(userToken, { "Content-Type": "application/json" }),
                body: JSON.stringify(params),
            },
            options.timeoutMs ?? this.timeoutSeconds * 1000,
            PenpotBackendClient.abortSignalFor(name, options)
        );
        return (await this.readResult(name, response)) as T;
    }

    public async callMultipart<T = unknown>(
        userToken: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[],
        options: RpcCallOptions = {}
    ): Promise<T> {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            form.append(key, String(value));
        }
        for (const upload of uploads) {
            form.append(
                upload.fieldName,
                new Blob([upload.content as Uint8Array<ArrayBuffer>], { type: upload.mimeType }),
                upload.fileName
            );
        }
        // fetch sets the multipart content type and boundary itself
        const response = await this.send(
            name,
            { method: "POST", headers: this.headers(userToken), body: form },
            options.timeoutMs ?? this.timeoutSeconds * 1000,
            PenpotBackendClient.abortSignalFor(name, options)
        );
        return (await this.readResult(name, response)) as T;
    }

    /**
     * Picks the signal that may abort a command. Writes and calls marked `abortable: false` get none.
     *
     * @param name - the command name
     * @param options - the options of the call
     */
    private static abortSignalFor(name: string, options: RpcCallOptions): AbortSignal | undefined {
        if (options.abortable === false || isWriteCommand(name)) {
            return undefined;
        }
        return options.signal ?? CallContext.current()?.signal;
    }

    /**
     * Builds the headers shared by every backend call. The request id of the tool call, when there is one,
     * goes in `X-Request-Id`, so the backend log line names the same call as the adapter.
     */
    private headers(userToken: string, extra: Record<string, string> = {}): Record<string, string> {
        const requestId = CallContext.current()?.requestId;
        return {
            Authorization: `Token ${userToken}`,
            "X-Client": "penpot-mcp",
            Accept: "application/json",
            ...(requestId !== undefined ? { "X-Request-Id": requestId } : {}),
            ...extra,
        };
    }

    /**
     * Sends one request to a backend command and returns the response with its body still unread.
     *
     * The request stops at the timeout or when the caller's signal fires, whichever comes first.
     *
     * @param name - command name, for error messages
     * @param init - request method, headers and body
     * @param timeoutMs - time limit for the whole call, in milliseconds
     * @param signal - fires when the caller gives up, or undefined
     * @throws Error when the request fails before a response arrives
     */
    private async send(name: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
        const timeout = AbortSignal.timeout(timeoutMs);
        try {
            return await fetch(
                this.commandUrl(name),
                withDispatcher(
                    {
                        ...init,
                        redirect: "manual",
                        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
                    },
                    this.dispatcher
                )
            );
        } catch (error) {
            this.logger.error(error, "Penpot RPC request failed: %s", name);
            const reason = error instanceof Error ? error.name : "unknown";
            throw new Error(
                `Backend command "${name}" got no response (${reason}). ` +
                    "The operation may or may not have been applied; check the file before retrying."
            );
        }
    }

    /**
     * Reads a response: parses its JSON result, decodes its event stream, or throws a {@link BackendRpcError}
     * for an error status, or a {@link BackendRateLimitError} for the rate limit of the backend.
     *
     * @param name - command name, for error messages
     * @param response - response whose body is still unread
     * @throws BackendRpcError when the status is an error, or when the stream carries an `error` event
     */
    private async readResult(name: string, response: Response): Promise<unknown> {
        const text = await this.readBody(response);
        if (!response.ok) {
            const body = BackendRpcError.decodeBody(text);
            if (BackendRateLimitError.matches(response.status, body)) {
                throw new BackendRateLimitError(BackendRateLimitError.secondsFrom(response.headers.get("retry-after")));
            }
            throw new BackendRpcError(response.status, name, body);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
            return this.readEventStream(name, response.status, text);
        }
        return this.parseJsonPayload(name, text);
    }

    /**
     * Reads the result of an event stream: the data of its `end` event, decoded from transit.
     *
     * The backend writes every frame in transit form and names it with an `event:` field. An `error` event
     * ends the command with a {@link BackendRpcError} that carries the decoded error body. A stream that
     * ends without an `end` event did not finish, so the command is not reported as a success: the
     * operation may still have been applied, and the caller must check the state before retrying.
     *
     * @param name - command name, for error messages
     * @param status - HTTP status of the response, which is success when the stream was read
     * @param text - complete stream body
     * @throws BackendRpcError when the stream carries an `error` event
     * @throws Error when the stream carries no `end` event
     */
    private readEventStream(name: string, status: number, text: string): unknown {
        const events = ServerSentEvents.parse(text);
        const failure = events.find((event) => event.name === "error");
        if (failure !== undefined) {
            throw new BackendRpcError(status, name, this.decodeErrorBody(failure.data));
        }
        const end = events.find((event) => event.name === "end");
        if (end === undefined) {
            throw new Error(
                name === "import-binfile"
                    ? "import did not finish; check list_files before retrying"
                    : `Backend command "${name}" did not finish; check the state before retrying`
            );
        }
        if (end.data.trim() === "") {
            return undefined;
        }
        try {
            return Transit.decode(end.data);
        } catch {
            throw new Error(`Backend command "${name}" returned an event that is not decodable transit JSON.`);
        }
    }

    /**
     * Decodes the transit data of an `error` event into an error body object.
     *
     * @param data - event data in transit form
     * @returns the decoded object, or `undefined` when the data is not a transit object
     */
    private decodeErrorBody(data: string): Record<string, unknown> | undefined {
        try {
            const decoded = Transit.decode(data);
            if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
                return decoded as Record<string, unknown>;
            }
        } catch {
            // not decodable: the error keeps only its status
        }
        return undefined;
    }

    /**
     * Parses a JSON response body, where an empty body is an empty result.
     *
     * @param name - command name, for error messages
     * @param text - complete response body
     * @throws Error when the body is not JSON
     */
    private parseJsonPayload(name: string, text: string): unknown {
        if (text.trim() === "") {
            return undefined;
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Backend command "${name}" returned a body that is not JSON.`);
        }
    }

    /**
     * Reads a response body as text, refusing bodies over the configured cap.
     *
     * A declared Content-Length over the cap is refused before any byte is read. Otherwise the bytes are
     * counted while they stream in, and the read stops as soon as the count passes the cap. Each chunk is
     * decoded as it arrives, so only the text is held, never the raw chunks next to a joined copy.
     *
     * @param response - response whose body is still unread
     * @returns the body decoded as UTF-8
     * @throws Error naming the cap and its environment variable when the body is over the cap
     */
    private async readBody(response: Response): Promise<string> {
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > this.maxResponseBytes) {
            await response.body?.cancel();
            throw this.oversizeError();
        }
        if (response.body === null) {
            return "";
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let total = 0;
        for (let result = await reader.read(); !result.done; result = await reader.read()) {
            total += result.value.byteLength;
            if (total > this.maxResponseBytes) {
                await reader.cancel();
                throw this.oversizeError();
            }
            text += decoder.decode(result.value, { stream: true });
        }
        return text + decoder.decode();
    }

    /** Builds the error for a response body over the cap. */
    private oversizeError(): Error {
        return new Error(`Backend response exceeds ${this.maxResponseMb} MB (PENPOT_MCP_BACKEND_MAX_RESPONSE_MB)`);
    }

    private commandUrl(name: string): URL {
        return new URL(`api/main/methods/${encodeURIComponent(name)}`, this.baseUri);
    }

    /**
     * Posts the feedback mail. The response body is discarded and failures keep their fixed messages.
     *
     * @param methodName - backend command name
     * @param userToken - MCP user token
     * @param params - command parameters
     */
    private async postFeedback(methodName: string, userToken: string, params: object): Promise<void> {
        let response: Response;
        try {
            response = await fetch(
                this.commandUrl(methodName),
                withDispatcher(
                    {
                        method: "POST",
                        headers: this.headers(userToken, { "Content-Type": "application/json" }),
                        body: JSON.stringify(params),
                        redirect: "manual",
                        signal: AbortSignal.timeout(PenpotBackendClient.FEEDBACK_TIMEOUT_MS),
                    },
                    this.dispatcher
                )
            );
            // discard backend diagnostics, which may contain private data
            await response.body?.cancel();
        } catch (error) {
            this.logger.error(error, "Penpot RPC request failed");
            throw new Error("The backend operation could not be confirmed. Do not retry automatically.");
        }

        if (response.ok) return;

        switch (response.status) {
            case 401:
                throw new Error(
                    "The backend did not accept the MCP user token. It may be outdated, " +
                        "or the Penpot instance may not have access tokens enabled."
                );
            case 403:
                throw new Error("The MCP user token is not authorized for this backend operation.");
            case 400:
                throw new Error("The backend rejected the request parameters or the operation is disabled.");
            case 429:
                throw new Error("The backend request limit has been reached. Do not retry automatically.");
            default:
                throw new Error(
                    `The backend operation could not be confirmed (HTTP ${response.status}). Do not retry automatically.`
                );
        }
    }
}
