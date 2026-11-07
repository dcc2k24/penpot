import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Reports progress of a long call to the client. The arguments follow the MCP progress notification: the
 * progress so far, the total when known, and a short message. Undefined when the client sent no progress token.
 */
export type ProgressReporter = (progress: number, total?: number, message?: string) => Promise<void>;

/** Facts about one tool call that the backend layer reads without being passed them. */
export interface CallContextData {
    /** Reports progress to the client, or undefined when the client asked for none. */
    progress?: ProgressReporter;
    /** Id of the tool call. It goes to the backend as `X-Request-Id`. */
    requestId?: string;
    /** Fires when the MCP request is aborted, for example when the client disconnects. */
    signal?: AbortSignal;
    /**
     * Fingerprint of the token id that the backend reported at validation. The adapter logs this value,
     * so the adapter and backend log lines match.
     */
    tokenFp?: string;
}

/**
 * Carries the per-call facts of a tool call through its asynchronous work.
 *
 * The tool layer sets the context once per call. The backend client and the write queue read it, so the
 * tools do not pass the request id and the signal through every method.
 */
export class CallContext {
    private static readonly storage = new AsyncLocalStorage<CallContextData>();

    /**
     * Runs a function with the given context.
     *
     * @param data - the context; the same object is returned by {@link CallContext.current} inside the call
     * @param run - the function to run
     */
    public static run<T>(data: CallContextData, run: () => T): T {
        return CallContext.storage.run(data, run);
    }

    /**
     * Runs a function with the request id of the current call but without its signal.
     *
     * Work that other calls share, such as token validation, and writes that have started, must not stop
     * when one client disconnects.
     *
     * @param run - the function to run
     */
    public static withoutSignal<T>(run: () => T): T {
        const current = CallContext.storage.getStore();
        return CallContext.storage.run({ requestId: current?.requestId }, run);
    }

    /** Returns the context of the current call, or undefined outside a call. */
    public static current(): CallContextData | undefined {
        return CallContext.storage.getStore();
    }
}
