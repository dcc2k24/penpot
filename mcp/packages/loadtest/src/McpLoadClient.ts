import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";

/**
 * Outcome of one MCP tool call as seen by the load driver.
 */
export interface ToolCallOutcome {
    /** Wall-clock time from sending the request to receiving the result, in milliseconds. */
    durationMs: number;
    /** True when the call completed and the tool did not report an error. */
    ok: boolean;
    /** Concatenated text content of the result. */
    text: string;
    /** True when the tool reported an error result (isError or the failure text prefix), or when the call threw. */
    isError: boolean;
    /** UTF-8 size of the text content, in bytes. */
    bytes: number;
    /** Parsed JSON value of the text, or undefined when the text is not JSON. */
    json: unknown;
    /** Message of the protocol or transport error when the call threw, otherwise undefined. */
    error?: string;
}

/**
 * One simulated agent: a Streamable HTTP MCP client that authenticates with its own bearer token.
 */
export class McpLoadClient {
    /** Text prefix that the server gives a failed tool call, in addition to the MCP isError flag. */
    public static readonly FAILURE_PREFIX = "Tool execution failed:";

    private client: Client | undefined;

    /**
     * Opens an MCP session at the given endpoint.
     *
     * @param url - full URL of the MCP endpoint, for example http://localhost:4401/mcp
     * @param token - MCP access token sent as a bearer token on every request
     */
    async connect(url: string, token: string): Promise<void> {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        const client = new Client({ name: "mcp-loadtest", version: "1.0.0" });
        await client.connect(transport);
        this.client = client;
    }

    /**
     * Calls a tool and measures the call. MCP and transport failures are reported in the outcome, not thrown.
     *
     * @param name - tool name, for example apply_operations
     * @param args - tool arguments, already substituted
     * @param timeoutMs - longest wait for the reply, in milliseconds. Left out, the SDK default of 60 s applies.
     */
    async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallOutcome> {
        if (!this.client) {
            throw new Error("callTool was called before connect");
        }
        const started = performance.now();
        try {
            const result = await this.client.callTool(
                { name, arguments: args },
                timeoutMs === undefined ? undefined : { timeout: timeoutMs }
            );
            const durationMs = performance.now() - started;
            const text = McpLoadClient.textOf(result);
            // servers that predate isError report failures only as this text prefix
            const isError = result.isError === true || text.startsWith(McpLoadClient.FAILURE_PREFIX);
            return {
                durationMs,
                ok: !isError,
                text,
                isError,
                bytes: Buffer.byteLength(text, "utf8"),
                json: McpLoadClient.parseJson(text),
            };
        } catch (error) {
            const durationMs = performance.now() - started;
            const message = error instanceof Error ? error.message : String(error);
            return { durationMs, ok: false, text: "", isError: true, bytes: 0, json: undefined, error: message };
        }
    }

    /**
     * Closes the session. Closing a client that never connected does nothing.
     */
    async close(): Promise<void> {
        await this.client?.close();
        this.client = undefined;
    }

    /**
     * Joins the text blocks of a tool result. Non-text blocks contribute nothing to the text.
     *
     * @param result - tool result returned by the MCP client
     */
    private static textOf(result: CallToolResult): string {
        const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
        return blocks
            .filter((block): block is { type: "text"; text: string } => {
                const candidate = block as { type?: unknown; text?: unknown };
                return candidate.type === "text" && typeof candidate.text === "string";
            })
            .map((block) => block.text)
            .join("\n");
    }

    /**
     * Parses the text of a result as JSON.
     *
     * @param text - text content of a tool result
     * @returns the parsed value, or undefined when the text is empty or not JSON
     */
    private static parseJson(text: string): unknown {
        if (text.trim() === "") {
            return undefined;
        }
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }
}
