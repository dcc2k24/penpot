import { z } from "zod";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { TextResponse, ToolResponse } from "./ToolResponse";
import type { PenpotMcpServer, SessionContext } from "./PenpotMcpServer";
import { createLogger } from "./logger";
import { TokenDigest } from "./backend/TokenDigest";
import { CallContext, type CallContextData, type ProgressReporter } from "./backend/CallContext";
import { RateLimitError } from "./backend/TokenRateLimiter";
import { BackendTooOldError, TokenRejectedError } from "./backend/BackendTokenValidator";

/** The facts of one finished tool call, as the server logs them. The token itself is never part of it. */
export interface ToolCallRecord {
    /** Name of the tool. */
    tool: string;
    /**
     * Fingerprint of the MCP token of the call, or `<none>`. The token id that the backend reports is
     * used when there is one, so the adapter and backend lines match.
     */
    tokenFp: string;
    /** Id of the call, which the backend logs as its request id. */
    requestId: string;
    /** Wall-clock duration of the call, in milliseconds. */
    durationMs: number;
    /** `ok` when the tool returned a result, `error` when it failed. */
    outcome: "ok" | "error";
}

/**
 * Hints that tell an MCP client what a tool does. Clients use them to decide whether to ask before a call.
 */
export interface ToolAnnotations {
    /** True when the tool only reads. */
    readOnlyHint?: boolean;
    /** True when the tool can destroy data. */
    destructiveHint?: boolean;
    /** True when repeating the call with the same arguments has no further effect. */
    idempotentHint?: boolean;
    /** True when the tool reaches outside the server, such as the web. */
    openWorldHint?: boolean;
}

/**
 * An empty arguments class for tools that do not require any parameters.
 */
export class EmptyToolArgs {
    static schema = {};
}

/**
 * Reports whether a failure is one the caller can fix, such as a rate limit or a rejected token. Such a
 * failure is a normal event, so the tool log records it at info, not as an error.
 *
 * @param error - the failure of a tool call
 */
function isExpectedFailure(error: unknown): boolean {
    return (
        error instanceof RateLimitError || error instanceof TokenRejectedError || error instanceof BackendTooOldError
    );
}

/**
 * Base class for type-safe tools with automatic schema generation and validation.
 *
 * This class provides type safety through automatic validation and strongly-typed
 * protected methods. All tools should extend this class.
 *
 * @template TArgs - The strongly-typed arguments class for this tool
 */
export abstract class Tool<TArgs extends object> {
    public static readonly SESSION_ID_SCHEMA = z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
            "Penpot session to use. Optional when exactly one session is connected. " +
                "If several sessions are listed in an error, ask the user to select one and pass its sessionId."
        );

    private readonly logger = createLogger("Tool");

    /** monotonically increasing counter for unique tool execution IDs */
    private static executionCounter = 0;

    protected constructor(
        protected mcpServer: PenpotMcpServer,
        private inputSchema: z.ZodRawShape
    ) {}

    /**
     * Executes the tool with automatic validation and type safety.
     *
     * This method handles the unknown args from the MCP protocol,
     * delegating to the type-safe implementation. Each call gets its own request id, and the signal of
     * the request, which fires when the client gives up. The backend layer reads both from the call context.
     *
     * @param args - the arguments of the call, as the MCP protocol delivered them
     * @param signal - fires when the MCP request is aborted, or undefined when there is no request
     * @param progress - reports progress to the client, or undefined when the client sent no progress token;
     *   a tool reads it through `CallContext.current()?.progress`
     */
    async execute(args: unknown, signal?: AbortSignal, progress?: ProgressReporter): Promise<ToolResponse> {
        const executionId = ++Tool.executionCounter;
        const started = performance.now();
        const call: CallContextData = { requestId: randomUUID(), signal, progress };
        const toolName = this.getToolName();
        let outcome: ToolCallRecord["outcome"] = "error";
        try {
            return await CallContext.run(call, async () => {
                const argsInstance: TArgs = args as TArgs;
                this.logger.info("Tool execution #%d starting: %s request=%s", executionId, toolName, call.requestId);
                if (this.logger.isLevelEnabled("debug")) {
                    this.logger.debug("Tool execution #%d arguments: %s", executionId, this.formatArgs(argsInstance));
                }

                // execute the actual tool logic
                const result = await this.executeCore(argsInstance);

                this.logger.info("Tool execution #%d complete: %s request=%s", executionId, toolName, call.requestId);
                outcome = "ok";
                return result;
            });
        } catch (error) {
            if (isExpectedFailure(error)) {
                this.logger.info(
                    "Tool execution #%d refused: %s request=%s; reason: %s",
                    executionId,
                    toolName,
                    call.requestId,
                    String(error)
                );
            } else {
                this.logger.error(
                    "Tool execution #%d failed: %s request=%s; error: %s",
                    executionId,
                    toolName,
                    call.requestId,
                    error
                );
            }
            return TextResponse.failure(`Tool execution failed: ${String(error)}`);
        } finally {
            // the hook is optional, so that stub servers in tests need not provide it
            this.mcpServer.recordToolCall?.({
                tool: toolName,
                tokenFp: call.tokenFp ?? TokenDigest.fingerprintOrNone(this.getSessionContext()?.userToken),
                requestId: call.requestId ?? "",
                durationMs: Math.round(performance.now() - started),
                outcome,
            });
        }
    }

    /**
     * Formats tool arguments for readable logging.
     *
     * Multi-line strings are preserved with proper indentation.
     */
    protected formatArgs(args: TArgs): string {
        const formatted: string[] = [];

        for (const [key, value] of Object.entries(args)) {
            if (typeof value === "string" && value.includes("\n")) {
                // multi-line string - preserve formatting with indentation
                const indentedValue = value
                    .split("\n")
                    .map((line, index) => (index === 0 ? line : "    " + line))
                    .join("\n");
                formatted.push(`  ${key}: ${indentedValue}`);
            } else if (typeof value === "string") {
                // single-line string
                formatted.push(`  ${key}: "${value}"`);
            } else if (value === null || value === undefined) {
                formatted.push(`  ${key}: ${value}`);
            } else {
                // other types (numbers, booleans, objects, arrays)
                const stringified = JSON.stringify(value, null, 2);
                if (stringified.includes("\n")) {
                    // multi-line JSON - indent it
                    const indented = stringified
                        .split("\n")
                        .map((line, index) => (index === 0 ? line : "    " + line))
                        .join("\n");
                    formatted.push(`  ${key}: ${indented}`);
                } else {
                    formatted.push(`  ${key}: ${stringified}`);
                }
            }
        }

        return formatted.length > 0 ? "\n" + formatted.join("\n") : "{}";
    }

    /**
     * Retrieves the current session context.
     *
     * @returns The session context for the current request, or undefined if not in a request context
     */
    protected getSessionContext(): SessionContext | undefined {
        return this.mcpServer.getSessionContext();
    }

    public getInputSchema() {
        return this.inputSchema;
    }

    /**
     * Returns the MCP annotations of the tool.
     *
     * The default is the safe one: the tool may write and may destroy data. A read-only tool overrides this to
     * return `readOnlyHint: true`, so that clients let it run without a prompt.
     */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: false, destructiveHint: true };
    }

    /**
     * Returns the tool's unique name.
     */
    public abstract getToolName(): string;

    /**
     * Returns the tool's description.
     */
    public abstract getToolDescription(): string;

    /**
     * Executes the tool's core logic.
     *
     * @param args - The (typed) tool arguments
     */
    protected abstract executeCore(args: TArgs): Promise<ToolResponse>;
}
