import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { TokenDigest } from "../../backend/TokenDigest";
import { AwaitRewriter } from "../../sandbox/AwaitRewriter";
import { CallSlots } from "../../sandbox/CallSlots";
import { SandboxHost, type SandboxSummary, type SandboxWriteOptions } from "../../sandbox/SandboxHost";
import {
    HOST_PRIMITIVE_NAMES,
    RUNTIME_DISCARDED_MESSAGE,
    SandboxRuntimeError,
    type GuestRuntime,
    type SandboxHostCalls,
} from "../../sandbox/GuestRuntime";
import type { CallOutcome } from "../../sandbox/SandboxSessions";
import { CallContext, type CallContextData } from "../../backend/CallContext";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";

/** Most characters of the result, of the console log and of the error text that leave the host. */
const TEXT_LIMIT = 256 * 1024;

/** Arguments of {@link ExecuteCodeBackendTool}. */
export class ExecuteCodeBackendArgs {
    static schema = {
        code: z
            .string()
            .min(1)
            .describe(
                "The JavaScript to run, as the body of a function. Use the facade names: " +
                    "penpot, penpotMgmt, penpotUtils, storage and console. " +
                    "await is allowed only in front of penpot, penpotMgmt and penpotUtils calls and .export() or .exportImage(); " +
                    "those run synchronously, so await is dropped. Promises (then, catch, finally) are refused."
            ),
        fileId: BackendIds.uuid().describe(
            "Id of the file the script works on, from list_files. Penpot calls use this file without naming it."
        ),
        pageId: BackendIds.uuid()
            .optional()
            .describe("Id of the page that becomes penpot.currentPage. Default: the first page of the file."),
        snapshot: WriteOptions.schema.snapshot.describe(
            "Whether the first write of the script takes a snapshot. Unset: the backend decides, as for " +
                "apply_operations. true: the first write takes one, so one restore undoes the whole script. " +
                "false: no snapshot."
        ),
        requestId: BackendIds.uuid()
            .optional()
            .describe(
                "Id of this script, for a safe retry: give a retry the same id, and the backend answers a write " +
                    "it already applied instead of applying it again. When absent, the call makes one and returns " +
                    "it as requestId, also when it fails."
            ),
        baseRevn: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                "Revision you read the file at (from get_file_outline). The first write of the script reports " +
                    "changes made since then as warnings; each later write checks against the script's own last write."
            ),
        failOnConflict: WriteOptions.schema.failOnConflict,
        allowSplit: z
            .boolean()
            .optional()
            .describe(
                "Kept for older clients. Batches are cut by size on the backend and every call of a flush " +
                    "commits in one transaction; a failed call changes nothing. Default false."
            ),
    };

    code!: string;

    fileId!: string;

    pageId?: string;

    snapshot?: boolean;

    requestId?: string;

    baseRevn?: number;

    failOnConflict?: boolean;

    allowSplit?: boolean;
}

/** Envelope that the sandbox returns for one script run. */
const EnvelopeSchema = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    undefinedResult: z.boolean().optional(),
    error: z
        .object({
            name: z.string(),
            message: z.string(),
            stack: z.string().nullable().optional(),
        })
        .optional(),
    log: z.string().optional(),
});

/** Envelope that the sandbox returned for one run, checked against its shape. */
type ScriptEnvelope = z.infer<typeof EnvelopeSchema>;

/** Whether the call has started to run, and so has used its host and its write options. */
interface CallState {
    started: boolean;
    /** Id of the script: the request id of its first write and the base of its later ones. */
    scriptId: string;
    /** Context of the tool call, which every backend read and write of the script runs in. */
    context: CallContextData | undefined;
}

/**
 * Wraps the host so that each primitive runs in the context of the tool call that made it.
 *
 * A runtime is shared by the calls of one token, and a continuation inside it can belong to an earlier call. The
 * backend reads its request signal from the context, and the signal of an earlier call is already closed, so a
 * later call would fail at its first read. Binding the context here keeps every read on its own call.
 *
 * @param host - host of the call
 * @param context - context of the tool call, or undefined outside a call
 * @returns the host that runs each primitive in the context
 */
function bindCallContext(host: SandboxHostCalls, context: CallContextData | undefined): SandboxHostCalls {
    if (context === undefined) {
        return host;
    }
    const bound: Record<string, unknown> = {};
    for (const name of HOST_PRIMITIVE_NAMES) {
        const method = (host as unknown as Record<string, (...args: unknown[]) => Promise<string>>)[name];
        bound[name] = (...args: unknown[]) => CallContext.run(context, () => method.apply(host, args));
    }
    return bound as unknown as SandboxHostCalls;
}

/** Runs a JavaScript script against one file through the sandbox facade. */
export class ExecuteCodeBackendTool extends BackendTool<ExecuteCodeBackendArgs> {
    /** Name of the guest function that runs one script. */
    private static readonly RUN_FUNCTION = "__runScript";

    /** Name of the guest function that returns and clears the console log. */
    private static readonly LOG_FUNCTION = "__drainLog";

    /** Guest CPU time allowed for reading the console log, in milliseconds. */
    private static readonly LOG_BUDGET_MS = 1000;

    /** Longest wait for a flush in flight after a fatal error, in milliseconds. */
    private static readonly SETTLE_MS = 10_000;

    /** Time between two periodic progress lines of a running script, in milliseconds. */
    private static readonly PROGRESS_EVERY_MS = 10_000;

    /** Limits how many scripts run at once across the calls that this tool serves. */
    private readonly slots: CallSlots;

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ExecuteCodeBackendArgs.schema, services);
        this.slots = new CallSlots(
            services.sandboxes.settings.maxConcurrentCalls,
            services.sandboxes.settings.slotWaitMs
        );
    }

    public getToolName(): string {
        return "execute_code";
    }

    public getToolDescription(): string {
        return (
            "Runs a JavaScript script in a sandbox against one file, using the Penpot plugin API facade. " +
            "The script is synchronous: the penpot calls return values directly, so await is not needed. " +
            "Globals: penpot (shapes, pages, layout, components, tokens), penpotMgmt (teams, projects, files), " +
            "penpotUtils (helpers such as findShapes), storage (an object for your own data) and console. " +
            "Writes are batched: a flush happens at the end of the script and at each penpot.waitForLayoutUpdate(). " +
            "A flush of up to 2000 operations goes in one mcp-apply-operations call, which the backend commits as one " +
            "transaction; a larger flush goes in calls of 1500 operations each, in order, and no other write of this " +
            "token to the file lands between them. A dry run goes in one call of at most 2000 operations. " +
            "snapshot, baseRevn, failOnConflict and allowSplit apply to the flushes of the script: the first write " +
            "takes the snapshot, so one restore undoes the whole script. SVG imports, media uploads and rpc writes " +
            "take none of these options. Attribute updates of a shape created in the same flush are sent with its " +
            "create, and the 5000-operation limit counts the operations after that. Reads after writes see the " +
            "pending changes. The return value comes back as JSON. Console output comes back in the console array. " +
            "storage keeps its data for the MCP access token, across files, and drops it after 30 minutes idle. " +
            "Limits per call: 5000 operations, 20 pages (16 MB of page data by default; PENPOT_MCP_SANDBOX_PAGE_MB), 1000 host calls, " +
            "20 exports and media uploads, 120 s wall-clock time, 3 s CPU time, 128 MB memory. " +
            "One script runs at a time for each token, and two more may wait; at most 4 scripts run at once across " +
            "all tokens, and a queued script waits up to 60 s. " +
            "The facade objects and the built-in prototypes are frozen, so a script cannot add to Array.prototype " +
            "or replace a facade member. " +
            "Bridge-only members are not available in backend mode: selection, viewport, ui, events, " +
            "openPage and openViewer. See the backend instructions for examples."
        );
    }

    protected async executeBackend(args: ExecuteCodeBackendArgs, userToken: string): Promise<ToolResponse> {
        const sessions = this.services.sandboxes;
        const key = TokenDigest.sha256Hex(userToken);
        // the token's turn comes first, so that one token cannot hold every global slot.
        const releaseTurn = await this.admit(() => sessions.acquireTurn(key));
        try {
            const release = await this.admit(() => this.slots.acquire());
            try {
                return await this.runWithRetry(args, userToken, key);
            } finally {
                // a runtime whose memory grew past the recycle size is dropped, so the memory goes back to the process.
                sessions.recycleIfSpent(key);
                release();
            }
        } finally {
            releaseTurn();
        }
    }

    /**
     * Takes a turn or a slot, and counts a refusal as a busy call.
     *
     * @param take - takes the turn or the slot
     * @returns the value that the take returned
     * @throws Error when the queue is full or the wait runs out
     */
    private async admit<T>(take: () => Promise<T>): Promise<T> {
        try {
            return await take();
        } catch (error) {
            this.services.sandboxes.recordOutcome("busy");
            throw error;
        }
    }

    /**
     * Runs the script on the runtime of the token. A call that was queued behind a runtime that was discarded
     * runs once more on a fresh runtime. The retry is only made before the call starts, so no write is repeated.
     *
     * @param args - script, file and page of the call
     * @param userToken - MCP token that the script acts with
     * @param key - session key of the token
     * @returns the tool response with the result and the totals of the call
     */
    private async runWithRetry(args: ExecuteCodeBackendArgs, userToken: string, key: string): Promise<ToolResponse> {
        const scriptId = args.requestId ?? randomUUID();
        for (let attempt = 1; ; attempt += 1) {
            const runtime = await this.services.sandboxes.acquire(key);
            const settings = this.services.sandboxes.settings;
            const host = new SandboxHost(this.services, userToken, settings.maxHostCalls, settings.maxPageBytes);
            const state: CallState = { started: false, scriptId, context: CallContext.current() };
            try {
                return await this.runOn(runtime, host, args, key, state);
            } catch (error) {
                const discarded = error instanceof SandboxRuntimeError && error.message === RUNTIME_DISCARDED_MESSAGE;
                if (discarded && !state.started && attempt === 1) {
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Runs one script on a runtime and words its outcome.
     *
     * The wall-clock limit starts when the script starts to run, so a call that waited behind another one of the
     * same token keeps its full time.
     *
     * @param runtime - runtime of the token
     * @param host - host that serves the script's primitives
     * @param args - script, file and page of the call
     * @param key - session key of the token
     * @param state - receives `started` once the script runs
     * @returns the tool response with the result and the totals of the call
     * @throws Error with the failure text, the console output and the writes applied before the failure
     */
    private async runOn(
        runtime: GuestRuntime,
        host: SandboxHost,
        args: ExecuteCodeBackendArgs,
        key: string,
        state: CallState
    ): Promise<ToolResponse> {
        let raw: string;
        const stopProgress = this.startProgress(host);
        try {
            raw = await this.invokeScript(runtime, host, args, state);
        } catch (error) {
            if (error instanceof SandboxRuntimeError) {
                if (error.fatal) {
                    // a fatal error may leave a flush in flight: wait for it, for a bounded time, so the totals are final.
                    await host.settled(ExecuteCodeBackendTool.SETTLE_MS);
                }
                const applied = ExecuteCodeBackendTool.appliedSuffix(host.summary(), state.scriptId);
                const notice = ExecuteCodeBackendTool.noticeSuffix(runtime.takeNotice());
                this.services.sandboxes.recordOutcome(ExecuteCodeBackendTool.outcomeOf(error));
                // a fatal error leaves the guest unreliable, so the runtime is dropped and its log is not read.
                if (error.fatal) {
                    this.services.sandboxes.discard(key);
                    throw new Error(ExecuteCodeBackendTool.capText(error.message) + applied + notice);
                }
                const log = await this.drainLog(runtime, bindCallContext(host, state.context));
                throw new Error(
                    ExecuteCodeBackendTool.capText(error.message) +
                        ExecuteCodeBackendTool.logSuffix(log) +
                        applied +
                        notice
                );
            }
            throw error;
        } finally {
            stopProgress();
        }

        const notice = runtime.takeNotice();
        const envelope = this.parseEnvelope(raw);
        if (!envelope.ok) {
            this.services.sandboxes.recordOutcome("failed");
            const failure = envelope.error ?? { name: "Error", message: "The script failed." };
            throw new Error(
                (failure.name && failure.name !== "Error" ? failure.name + ": " : "") +
                    ExecuteCodeBackendTool.capText(failure.message) +
                    ExecuteCodeBackendTool.logSuffix(ExecuteCodeBackendTool.capLog(envelope.log ?? "")) +
                    ExecuteCodeBackendTool.appliedSuffix(host.summary(), state.scriptId) +
                    ExecuteCodeBackendTool.noticeSuffix(notice)
            );
        }

        const summary: SandboxSummary = host.summary();
        const consoleLines = ExecuteCodeBackendTool.capLog(envelope.log ?? "")
            .split("\n")
            .filter((line) => line.length > 0);
        this.services.sandboxes.recordOutcome("ok");
        return this.jsonResponse({
            ...(envelope.undefinedResult === true ? {} : { result: ExecuteCodeBackendTool.capResult(envelope.result) }),
            console: consoleLines,
            requestId: state.scriptId,
            revn: summary.revn,
            opsApplied: summary.opsApplied,
            flushes: summary.flushes,
            chunks: summary.chunks,
            warnings: summary.warnings,
            createdIds: summary.createdIds,
            ...(notice === undefined ? {} : { storageNotice: notice }),
        });
    }

    /**
     * Runs the script on the runtime, with the write allowance of the flush in flight.
     *
     * @param runtime - runtime of the token
     * @param host - host that serves the script's primitives
     * @param args - script, file and page of the call
     * @param state - receives `started` once the script runs, and carries the script id
     * @returns the raw envelope of the run
     */
    private async invokeScript(
        runtime: GuestRuntime,
        host: SandboxHost,
        args: ExecuteCodeBackendArgs,
        state: CallState
    ): Promise<string> {
        const settings = this.services.sandboxes.settings;
        const writeOptions = ExecuteCodeBackendTool.writeOptionsOf(args);
        return runtime.invoke(
            ExecuteCodeBackendTool.RUN_FUNCTION,
            [AwaitRewriter.rewrite(args.code), args.fileId, args.pageId ?? ""],
            bindCallContext(host, state.context),
            settings.cpuBudgetMs,
            {
                wallMs: settings.wallMs,
                onStart: (deadlineAt) => {
                    state.started = true;
                    host.beginCall(deadlineAt, writeOptions, state.scriptId);
                },
                writeAllowanceMs: () => host.writeAllowanceMs(),
                onAbandon: () => host.abandon(),
            }
        );
    }

    /**
     * Sends progress lines to the caller: one after each chunk of a flush, and one every 10 s of a long script.
     *
     * @param host - host whose flushes report their chunks
     * @returns the function that stops the periodic lines
     */
    private startProgress(host: SandboxHost): () => void {
        // the reporter is read here, inside the call context; the writes of a flush run in a context without it.
        const reporter = CallContext.current()?.progress;
        const report = (done: number, total: number | undefined, text: string): void => {
            if (reporter !== undefined) {
                Promise.resolve(reporter(done, total, text)).catch(() => undefined);
            }
        };
        host.setProgress(report);
        const timer = setInterval(
            () => report(host.summary().opsApplied, undefined, "script running"),
            ExecuteCodeBackendTool.PROGRESS_EVERY_MS
        );
        timer.unref();
        return () => {
            clearInterval(timer);
            host.setProgress(undefined);
        };
    }

    /**
     * Maps a runtime error to the outcome that the counters record.
     *
     * @param error - the error that stopped the call
     * @returns the outcome: discarded, interrupted by a CPU or wall-clock limit, or failed
     */
    private static outcomeOf(error: SandboxRuntimeError): CallOutcome {
        if (error.message === RUNTIME_DISCARDED_MESSAGE) {
            return "discarded";
        }
        return error.limit === "cpu" || error.limit === "wall" ? "interrupted" : "failed";
    }

    /**
     * Picks the write options of the call from its arguments.
     *
     * @param args - arguments of the call
     * @returns the options that are set
     */
    private static writeOptionsOf(args: ExecuteCodeBackendArgs): SandboxWriteOptions {
        const options: SandboxWriteOptions = {};
        if (args.snapshot !== undefined) {
            options.snapshot = args.snapshot;
        }
        if (args.baseRevn !== undefined) {
            options.baseRevn = args.baseRevn;
        }
        if (args.failOnConflict !== undefined) {
            options.failOnConflict = args.failOnConflict;
        }
        if (args.allowSplit !== undefined) {
            options.allowSplit = args.allowSplit;
        }
        return options;
    }

    /**
     * Reads and clears the console log of the runtime after a failed call.
     *
     * @param runtime - runtime that ran the call
     * @param host - host that serves the primitives of the read
     * @returns the log text, or an empty string when the log cannot be read
     */
    private async drainLog(runtime: GuestRuntime, host: SandboxHostCalls): Promise<string> {
        if (runtime.poisoned || runtime.disposed) {
            return "";
        }
        try {
            const log = await runtime.invoke(
                ExecuteCodeBackendTool.LOG_FUNCTION,
                [],
                host,
                ExecuteCodeBackendTool.LOG_BUDGET_MS
            );
            return ExecuteCodeBackendTool.capLog(log);
        } catch {
            return "";
        }
    }

    /**
     * Parses the envelope that the sandbox returned for one run, and checks its shape.
     *
     * @param raw - envelope as JSON text
     * @returns the parsed envelope
     * @throws Error when the text is not an envelope
     */
    private parseEnvelope(raw: string): ScriptEnvelope {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error("execute_code: the sandbox returned an unreadable result.");
        }
        const checked = EnvelopeSchema.safeParse(parsed);
        if (!checked.success) {
            throw new Error("execute_code: the sandbox returned an unreadable result.");
        }
        return checked.data;
    }

    /**
     * Caps the text of the console log. The head and the tail are kept, so the start and the last lines both show.
     *
     * @param log - console text of the run
     * @returns the log, or the log with its middle cut out and a note
     */
    private static capLog(log: string): string {
        if (log.length <= TEXT_LIMIT) {
            return log;
        }
        const half = Math.floor(TEXT_LIMIT / 2);
        const omitted = log.length - 2 * half;
        return (
            log.slice(0, half) +
            `\n[truncated: ${omitted} characters left out of the middle of the console output]\n` +
            log.slice(log.length - half)
        );
    }

    /**
     * Caps a text that leaves the host, such as an error message. The start is kept, with a note.
     *
     * @param text - the text
     * @returns the text, or its first characters and a note
     */
    private static capText(text: string): string {
        if (text.length <= TEXT_LIMIT) {
            return text;
        }
        return text.slice(0, TEXT_LIMIT) + `\n[truncated: ${text.length - TEXT_LIMIT} more characters]`;
    }

    /**
     * Caps the result value. A value whose JSON text is too long is replaced by its first characters.
     *
     * @param value - the result as the guest returned it
     * @returns the value, or a note with the first characters of its JSON text
     */
    private static capResult(value: unknown): unknown {
        const text = JSON.stringify(value) ?? "null";
        if (text.length <= TEXT_LIMIT) {
            return value ?? null;
        }
        return {
            truncated: true,
            preview: text.slice(0, TEXT_LIMIT),
            note: `the result is ${text.length} characters of JSON; only the first ${TEXT_LIMIT} are shown`,
        };
    }

    /**
     * Formats a note of the runtime, such as storage that was not saved, as a suffix of an error message.
     *
     * @param notice - the note, or undefined when there is none
     * @returns an empty string when there is no note, otherwise the note under a heading
     */
    private static noticeSuffix(notice: string | undefined): string {
        return notice === undefined ? "" : "\n\nNote: " + notice;
    }

    /**
     * Formats the console log as a suffix of an error message.
     *
     * @param log - console text of the run
     * @returns an empty string when there is no log, otherwise the log under a heading
     */
    private static logSuffix(log: string): string {
        return log.length > 0 ? "\n\nConsole output:\n" + log : "";
    }

    /**
     * Formats the writes that a failed script applied before it failed.
     *
     * @param summary - totals of the call, read after the failure
     * @returns an empty string when no call was applied, otherwise the totals under a heading
     */
    private static appliedSuffix(summary: SandboxSummary, scriptId: string): string {
        const retry = "\n\nrequestId: " + scriptId + " (pass it to a retry of this script)";
        if (summary.flushes === 0 && summary.chunks === 0) {
            return retry;
        }
        return (
            retry +
            "\n\nApplied before the failure: opsApplied=" +
            summary.opsApplied +
            ", flushes=" +
            summary.flushes +
            ", chunks=" +
            summary.chunks +
            ", revn=" +
            String(summary.revn) +
            ", createdIds=" +
            ExecuteCodeBackendTool.capText(JSON.stringify(summary.createdIds))
        );
    }
}
