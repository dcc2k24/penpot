/** A request failure, reduced to what the client may see: a status, a JSON-RPC code and a short message. */
export interface RequestFailure {
    /** HTTP status of the answer. */
    status: number;
    /** JSON-RPC error code. */
    code: number;
    /** Short message, with no stack, path or library name. */
    message: string;
}

/** JSON-RPC codes used for request failures. */
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Maps an error from the HTTP layer to the answer that the client gets.
 *
 * The body parser marks its errors with a `type`, and the status of the error is kept. Everything else is an
 * internal error. The answer never carries the stack of the error, which names local paths.
 *
 * @param error - the error that a middleware or a parser passed on
 * @returns the status, the JSON-RPC code and the message of the answer
 */
export function failureOf(error: unknown): RequestFailure {
    const detail = (typeof error === "object" && error !== null ? error : {}) as {
        type?: unknown;
        status?: unknown;
        statusCode?: unknown;
    };
    if (detail.type === "entity.too.large") {
        return { status: 413, code: JSON_RPC_INVALID_REQUEST, message: "request body too large" };
    }
    if (detail.type === "entity.parse.failed") {
        return { status: 400, code: JSON_RPC_PARSE_ERROR, message: "invalid JSON" };
    }
    const status = typeof detail.status === "number" ? detail.status : detail.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
        return { status, code: JSON_RPC_INVALID_REQUEST, message: "invalid request" };
    }
    return { status: 500, code: JSON_RPC_INTERNAL_ERROR, message: "internal error" };
}

/**
 * Builds the JSON-RPC error body for a failure.
 *
 * @param failure - the failure to render
 * @returns the body, which has no id because the request could not be read
 */
export function jsonRpcErrorBody(failure: RequestFailure): {
    jsonrpc: "2.0";
    error: { code: number; message: string };
    id: null;
} {
    return { jsonrpc: "2.0", error: { code: failure.code, message: failure.message }, id: null };
}
