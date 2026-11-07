import { parentPort, workerData } from "node:worker_threads";
import { SandboxRuntimeError, type HostPrimitiveName, type SandboxHostCalls } from "./GuestRuntime";
import { SandboxRuntime } from "./SandboxRuntime";
import {
    STORAGE_GETTER,
    STORAGE_LIMIT_BYTES,
    STORAGE_SETTER,
    WORKER_WRITE_GRACE_MS,
    type WorkerError,
    type WorkerHostResult,
    type WorkerInit,
    type WorkerInvoke,
    type WorkerMessage,
    type WorkerRequest,
} from "./SandboxWorkerProtocol";

/*
 * Entry of a sandbox worker thread. The main thread (SandboxWorkerRuntime) starts one per guest runtime. The
 * worker holds one in-process runtime, runs the calls that it sends, and asks the main thread for host calls.
 */

const port = parentPort;
if (port === null) {
    throw new Error("The sandbox worker entry must run in a worker thread.");
}

/** Sends a message to the main thread. */
function post(message: WorkerMessage): void {
    port?.postMessage(message);
}

/** Host calls of the worker: each one waits for the answer of the main thread. */
class RemoteHost implements SandboxHostCalls {
    /** Id of the last host call. */
    private lastId = 0;
    /** Host calls that wait for an answer, by id. */
    private readonly pending = new Map<
        number,
        {
            readonly name: HostPrimitiveName;
            readonly resolve: (value: string) => void;
            readonly reject: (e: Error) => void;
        }
    >();

    public loadFileOutline(fileId: string): Promise<string> {
        return this.call("loadFileOutline", [fileId]);
    }

    public loadPage(fileId: string, pageId: string): Promise<string> {
        return this.call("loadPage", [fileId, pageId]);
    }

    public flush(fileId: string, operationsJson: string, dryRun: boolean): Promise<string> {
        return this.call("flush", [fileId, operationsJson, dryRun]);
    }

    public importSvg(paramsJson: string): Promise<string> {
        return this.call("importSvg", [paramsJson]);
    }

    public rpc(name: string, paramsJson: string): Promise<string> {
        return this.call("rpc", [name, paramsJson]);
    }

    public exportShape(paramsJson: string): Promise<string> {
        return this.call("exportShape", [paramsJson]);
    }

    public uploadMediaUrl(paramsJson: string): Promise<string> {
        return this.call("uploadMediaUrl", [paramsJson]);
    }

    public uploadMediaData(paramsJson: string): Promise<string> {
        return this.call("uploadMediaData", [paramsJson]);
    }

    /**
     * Sends a host call and waits for its answer.
     *
     * @param name - primitive that the guest called
     * @param args - arguments of the call
     * @returns the answer text
     */
    private call(name: HostPrimitiveName, args: (string | boolean)[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.lastId += 1;
            const id = this.lastId;
            this.pending.set(id, { name, resolve, reject });
            post({ type: "host-call", id, name, args });
        });
    }

    /**
     * Settles the host call that an answer belongs to. A failure reaches the guest as a thrown error.
     *
     * @param answer - the answer of the main thread
     */
    public settle(answer: WorkerHostResult): void {
        const entry = this.pending.get(answer.id);
        if (entry === undefined) {
            return;
        }
        this.pending.delete(answer.id);
        if (!answer.ok) {
            entry.reject(new Error(answer.message ?? "host call failed"));
            return;
        }
        if (typeof answer.value !== "string") {
            entry.reject(new Error(`${entry.name} must resolve to a string.`));
            return;
        }
        entry.resolve(answer.value);
    }
}

const host = new RemoteHost();
const init = workerData as WorkerInit;
let runtime: SandboxRuntime | undefined = undefined;
/**
 * Storage text that the main thread holds: the text it last sent, or the text that this worker last saved. The
 * worker sends its storage only when the text differs from this one.
 */
let held: string | undefined = undefined;

/** Options of the storage restore and read: no host access, so the storage code cannot start a host call. */
const STORAGE_OPTIONS = { refuseHost: true };

SandboxRuntime.createInProcess(init.prelude, init.options).then(
    (created) => {
        runtime = created;
        post({ type: "ready", memoryBytes: created.wasmMemoryBytes });
    },
    (error: unknown) => {
        post({ type: "init-failed", message: messageOf(error) });
    }
);

port.on("message", (msg: WorkerRequest) => {
    if (msg.type === "host-result") {
        host.settle(msg);
        return;
    }
    void serve(msg);
});

/**
 * Runs one call and sends its answer, with the storage and the memory of the runtime.
 *
 * A storage that cannot be restored is dropped: the call fails with that reason, and the main thread drops its saved
 * copy too.
 *
 * @param request - the call
 */
async function serve(request: WorkerInvoke): Promise<void> {
    const current = runtime;
    if (current === undefined) {
        post({
            type: "result",
            id: request.id,
            ok: false,
            error: { message: "The sandbox worker is not ready.", runtime: false, fatal: false },
            storage: undefined,
            memoryBytes: 0,
            poisoned: false,
        });
        return;
    }
    let outcome: { ok: true; value: string } | { ok: false; error: WorkerError };
    let restoreFailed = false;
    try {
        if (request.storage !== undefined && request.storage !== held) {
            try {
                await current.invoke(STORAGE_SETTER, [request.storage], host, init.storageBudgetMs, STORAGE_OPTIONS);
                held = request.storage;
            } catch (error) {
                restoreFailed = true;
                held = undefined;
                throw new SandboxRuntimeError(
                    `The saved storage could not be restored, so it was dropped: ${messageOf(error)}`
                );
            }
        }
        const value = await current.invoke(request.functionName, [...request.args], host, request.budgetMs, {
            wallMs: request.wallMs,
            // the main thread owns the hard stop of a write, so this watchdog must not cut one short.
            writeGraceMs: WORKER_WRITE_GRACE_MS,
        });
        outcome = { ok: true, value };
    } catch (error) {
        outcome = { ok: false, error: describe(error) };
    }
    let saved: SavedStorage = { storage: undefined };
    if (restoreFailed) {
        saved = { storage: null };
    } else if (!current.poisoned && !current.disposed) {
        saved = await saveStorage(current);
    }
    const common = {
        type: "result" as const,
        id: request.id,
        storage: saved.storage,
        warning: saved.warning,
        memoryBytes: current.wasmMemoryBytes,
        poisoned: current.poisoned,
    };
    post(outcome.ok ? { ...common, ok: true, value: outcome.value } : { ...common, ok: false, error: outcome.error });
}

/** What the worker tells the main thread about storage after a call. */
interface SavedStorage {
    /** New storage text; null when the storage cannot be saved, and undefined when the saved copy stays. */
    readonly storage: string | null | undefined;
    /** Note for the caller, when the storage was too large to save. */
    readonly warning?: string;
}

/**
 * Reads `storage` as JSON text, and reports it when it changed.
 *
 * A text above the limit is not reported: the saved copy stays at the last size that fit, and the caller gets a note.
 *
 * @param current - runtime to read
 * @returns what to report about storage
 */
async function saveStorage(current: SandboxRuntime): Promise<SavedStorage> {
    let text: string;
    try {
        text = await current.invoke(STORAGE_GETTER, [], host, init.storageBudgetMs, STORAGE_OPTIONS);
    } catch {
        return { storage: undefined };
    }
    if (text === "") {
        if (held === undefined) {
            return { storage: undefined };
        }
        held = undefined;
        return { storage: null };
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > STORAGE_LIMIT_BYTES) {
        const megabytes = (bytes / (1024 * 1024)).toFixed(1);
        return {
            storage: undefined,
            warning: `storage is ${megabytes} MB of JSON, above the 8 MB limit; the saved copy stays at its last size that fit.`,
        };
    }
    if (text === held) {
        return { storage: undefined };
    }
    held = text;
    return { storage: text };
}

/**
 * Describes an error of a call for the main thread.
 *
 * @param error - the thrown value
 * @returns the error as the main thread rebuilds it
 */
function describe(error: unknown): WorkerError {
    if (error instanceof SandboxRuntimeError) {
        return {
            message: error.message,
            runtime: true,
            guestName: error.guestName,
            fatal: error.fatal,
            limit: error.limit,
        };
    }
    return { message: messageOf(error), runtime: false, fatal: false };
}

/**
 * Returns the text of an unknown thrown value.
 *
 * @param error - thrown value
 * @returns the message of an Error, or the string form of any other value
 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
