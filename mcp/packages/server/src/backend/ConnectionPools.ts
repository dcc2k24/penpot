import { Agent, type Dispatcher } from "undici";
import { BackendSettings } from "./BackendSettings";

/**
 * Adds a connection pool to the options of a `fetch` call. The pool types of the `undici` package and of the
 * global `fetch` differ, so the merge is done here once.
 *
 * @param init - the options of the call
 * @param dispatcher - the pool, or undefined to keep the global pool
 */
export function withDispatcher(init: RequestInit, dispatcher: Dispatcher | undefined): RequestInit {
    return dispatcher === undefined ? init : Object.assign({}, init, { dispatcher });
}

/**
 * Creates the connection pools of the backend and the exporter.
 *
 * Node's global `fetch` keeps its own pool, with header and body timeouts of 300 s that the settings do not
 * show. A pool made here takes its timeouts from the configured ones, and a connection limit.
 */
export class ConnectionPools {
    /**
     * Creates a pool for one origin.
     *
     * @param timeoutSeconds - the configured timeout of calls, in seconds; it is the header and body timeout too
     * @returns a pool to pass to `fetch` as its dispatcher
     */
    public static create(timeoutSeconds: number): Agent {
        const timeoutMs = Math.ceil(timeoutSeconds * 1000);
        return new Agent({
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            connections: BackendSettings.CONNECTIONS_PER_ORIGIN,
        });
    }
}
