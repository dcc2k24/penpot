import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { TokenDigest } from "../../backend/TokenDigest";
import { AwaitRewriter } from "../../sandbox/AwaitRewriter";
import { CallSlots } from "../../sandbox/CallSlots";
import { SandboxHost, type SandboxSummary, type SandboxWriteOptions } from "../../sandbox/SandboxHost";
import { SandboxRuntime, SandboxRuntimeError } from "../../sandbox/SandboxRuntime";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";

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
                    "those run synchronously, so await is dropped."
            ),
        fileId: BackendIds.uuid().describe(
            "Id of the file the script works on, from list_files. Penpot calls use this file without naming it."
        ),
        pageId: BackendIds.uuid()
            .optional()
            .describe("Id of the page that becomes penpot.currentPage. Default: the first page of the file."),
        snapshot: WriteOptions.schema.snapshot,
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
                "When true, the backend may commit each mcp-apply-operations call of a flush in several " +
                    "transactions of up to 300 creations. Default false."
            ),
    };

    code!: string;

    fileId!: string;

    pageId?: string;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    allowSplit?: boolean;
}

/** Envelope that the sandbox returns for one script run. */
interface ScriptEnvelope {
    ok: boolean;
    result?: unknown;
    undefinedResult?: boolean;
    error?: { name: string; message: string; stack?: string | null };
    log?: string;
}

/** Runs a JavaScript script against one file through the sandbox facade. */
export class ExecuteCodeBackendTool extends BackendTool<ExecuteCodeBackendArgs> {
    /** Name of the guest function that runs one script. */
    private static readonly RUN_FUNCTION = "__runScript";

    /** Name of the guest function that returns and clears the console log. */
    private static readonly LOG_FUNCTION = "__drainLog";

    /** Guest CPU time allowed for reading the console log, in milliseconds. */
    private static readonly LOG_BUDGET_MS = 1000;

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
            "A flush sends its operations in one or more mcp-apply-operations calls of at most 1500 operations each, " +
            "so a large flush takes several calls; no other write of this server lands between them. A dry run " +
            "goes in one call of at most 2000 operations. snapshot, baseRevn, failOnConflict and allowSplit apply " +
            "to every call. Attribute updates of a shape created in the same flush are sent with its create, and " +
            "the 5000-operation limit counts the operations after that. Reads after writes see the pending changes. " +
            "The return value comes back as JSON. Console output comes back in the console array. " +
            "storage keeps its data for the MCP access token, across files, and drops it after 30 minutes idle. " +
            "Limits per call: 5000 operations, 20 pages, 50 MB of page data, 1000 host calls, " +
            "20 exports and media uploads, 120 s wall-clock time, 10 s CPU time, 128 MB memory. " +
            "At most 4 scripts run at once; a queued script waits up to 60 s. " +
            "Bridge-only members are not available in backend mode: selection, viewport, ui, events, " +
            "openPage and openViewer. See the backend instructions for examples."
        );
    }

    protected async executeBackend(args: ExecuteCodeBackendArgs, userToken: string): Promise<ToolResponse> {
        const release = await this.slots.acquire();
        try {
            return await this.runScript(args, userToken);
        } finally {
            // a runtime whose memory grew past the recycle size is dropped, so the memory goes back to the process.
            this.services.sandboxes.recycleIfSpent(TokenDigest.sha256Hex(userToken));
            release();
        }
    }

    /**
     * Runs one script in the sandbox of the token. The caller must hold a call slot.
     *
     * @param args - script, file and page of the call
     * @param userToken - MCP token that the script acts with
     * @returns the tool response with the result and the totals of the call
     * @throws Error with the failure text, the console output and the writes applied before the failure
     */
    private async runScript(args: ExecuteCodeBackendArgs, userToken: string): Promise<ToolResponse> {
        const settings = this.services.sandboxes.settings;
        const key = TokenDigest.sha256Hex(userToken);
        const runtime = await this.services.sandboxes.acquire(key);
        const deadlineAt = Date.now() + settings.wallMs;
        const host = new SandboxHost(this.services, userToken, settings.maxHostCalls);
        host.beginCall(deadlineAt, ExecuteCodeBackendTool.writeOptionsOf(args));
        const budgetMs = settings.cpuBudgetMs;

        let raw: string;
        try {
            raw = await runtime.invoke(
                ExecuteCodeBackendTool.RUN_FUNCTION,
                [AwaitRewriter.rewrite(args.code), args.fileId, args.pageId ?? ""],
                host,
                budgetMs,
                deadlineAt
            );
        } catch (error) {
            if (error instanceof SandboxRuntimeError) {
                const applied = ExecuteCodeBackendTool.appliedSuffix(host.summary());
                // a fatal error leaves the guest unreliable, so the runtime is dropped and its log is not read.
                if (error.fatal) {
                    this.services.sandboxes.discard(key);
                    throw new Error(error.message + applied);
                }
                const log = await this.drainLog(runtime, host);
                throw new Error(error.message + ExecuteCodeBackendTool.logSuffix(log) + applied);
            }
            throw error;
        }

        const envelope = this.parseEnvelope(raw);
        if (!envelope.ok) {
            const failure = envelope.error ?? { name: "Error", message: "The script failed." };
            throw new Error(
                (failure.name && failure.name !== "Error" ? failure.name + ": " : "") +
                    failure.message +
                    ExecuteCodeBackendTool.logSuffix(envelope.log ?? "") +
                    ExecuteCodeBackendTool.appliedSuffix(host.summary())
            );
        }

        const summary = host.summary();
        const consoleLines = (envelope.log ?? "").split("\n").filter((line) => line.length > 0);
        return this.jsonResponse({
            ...(envelope.undefinedResult === true ? {} : { result: envelope.result ?? null }),
            console: consoleLines,
            revn: summary.revn,
            opsApplied: summary.opsApplied,
            flushes: summary.flushes,
            chunks: summary.chunks,
            warnings: summary.warnings,
            createdIds: summary.createdIds,
        });
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
    private async drainLog(runtime: SandboxRuntime, host: SandboxHost): Promise<string> {
        if (runtime.poisoned || runtime.disposed) {
            return "";
        }
        try {
            return await runtime.invoke(
                ExecuteCodeBackendTool.LOG_FUNCTION,
                [],
                host,
                ExecuteCodeBackendTool.LOG_BUDGET_MS
            );
        } catch {
            return "";
        }
    }

    /**
     * Parses the envelope that the sandbox returned for one run.
     *
     * @param raw - envelope as JSON text
     * @returns the parsed envelope
     * @throws Error when the text is not a JSON object
     */
    private parseEnvelope(raw: string): ScriptEnvelope {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error("execute_code: the sandbox returned an unreadable result.");
        }
        if (typeof parsed !== "object" || parsed === null) {
            throw new Error("execute_code: the sandbox returned an unreadable result.");
        }
        return parsed as ScriptEnvelope;
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
    private static appliedSuffix(summary: SandboxSummary): string {
        if (summary.flushes === 0 && summary.chunks === 0) {
            return "";
        }
        return (
            "\n\nApplied before the failure: opsApplied=" +
            summary.opsApplied +
            ", flushes=" +
            summary.flushes +
            ", chunks=" +
            summary.chunks +
            ", revn=" +
            String(summary.revn) +
            ", createdIds=" +
            JSON.stringify(summary.createdIds)
        );
    }
}
