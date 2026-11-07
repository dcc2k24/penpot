import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { existsSync, readFileSync } from "node:fs";
import { delay, RATE_LIMIT_RETRIES, rateLimitWaitOf, RETRY_DELAYS_MS } from "../McpSession.js";
import { tokenFilePath } from "../Paths.js";

/** Prefix of the text the backend returns when a command fails. */
const BACKEND_FAILURE_PREFIX = "Tool execution failed:";

/** Name of the MCP tool that exports a shape as an image. */
const EXPORT_TOOL = "export_shape";

/**
 * Reads the MCP token from its file. The token is returned to the caller only and never printed.
 *
 * @returns the trimmed token
 * @throws Error when the file is missing or empty
 */
function readToken(): string {
    const tokenFile = tokenFilePath();
    if (!existsSync(tokenFile)) {
        throw new Error(`token file not found: ${tokenFile}`);
    }
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token === "") {
        throw new Error(`token file is empty: ${tokenFile}`);
    }
    return token;
}

/**
 * Reads the fields of a content block that this module uses. Any value that is not an object gives an empty record.
 *
 * @param block - one entry of a tool result's content array
 */
function recordOf(block: unknown): { type?: unknown; text?: unknown; data?: unknown } {
    if (typeof block !== "object" || block === null) {
        return {};
    }
    return block as { type?: unknown; text?: unknown; data?: unknown };
}

/**
 * Runs one tool call with the same retries as the session. A rejected call waits on the backoff schedule. A call that
 * the adapter rate-limited waits the time it names, at most RATE_LIMIT_RETRIES times, and the rate-limited call did not
 * run, so it is safe to repeat.
 *
 * @param call - makes one attempt of the call
 * @param wait - waits for the given milliseconds, replaced in tests
 * @returns the result of the first attempt that was not rejected or rate-limited
 * @throws the last rejection when every retry failed
 */
export async function callWithRetry(
    call: () => Promise<CallToolResult>,
    wait: (ms: number) => Promise<void> = delay
): Promise<CallToolResult> {
    let transientRetries = 0;
    let rateRetries = 0;
    for (;;) {
        let result: CallToolResult;
        try {
            result = await call();
        } catch (error) {
            if (transientRetries >= RETRY_DELAYS_MS.length) {
                throw error;
            }
            await wait(RETRY_DELAYS_MS[transientRetries] ?? 0);
            transientRetries++;
            continue;
        }
        const text = textOf(result);
        const failed = result.isError === true || text.startsWith(BACKEND_FAILURE_PREFIX);
        const waitMs = failed ? rateLimitWaitOf(text) : undefined;
        if (waitMs !== undefined && rateRetries < RATE_LIMIT_RETRIES) {
            rateRetries++;
            await wait(waitMs);
            continue;
        }
        return result;
    }
}

/**
 * Joins the text blocks of a tool result.
 *
 * @param result - tool result
 */
function textOf(result: CallToolResult): string {
    const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
    return blocks
        .flatMap((block) => {
            const candidate = recordOf(block);
            return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
        })
        .join("\n");
}

/**
 * MCP client that exports shapes as PNG images from the backend-mode MCP server.
 */
export class McpImageClient {
    private client: Client | undefined = undefined;

    /**
     * Opens an MCP session at the given endpoint, authenticated with the token from the token file.
     * An open session is closed first.
     *
     * @param url - full URL of the MCP endpoint, for example http://127.0.0.1:4405/mcp
     * @throws Error when the token file is missing or empty, or when the connection fails
     */
    async connect(url: string): Promise<void> {
        const token = readToken();
        await this.close();
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        const client = new Client({ name: "mcp-design-parity", version: "1.0.0" });
        await client.connect(transport);
        this.client = client;
    }

    /**
     * Closes the MCP session. Closing a client that is not connected does nothing.
     */
    async close(): Promise<void> {
        await this.client?.close();
        this.client = undefined;
    }

    /**
     * Exports one shape as a PNG at the given scale. Transport failures are retried with the backoff schedule.
     * A tool that reports an error is not retried.
     *
     * @param fileId - id of the file that holds the shape
     * @param pageId - id of the page that holds the shape
     * @param shapeId - id of the shape to export
     * @param scale - device scale of the export, an integer from 1 to 3
     * @returns the decoded PNG bytes, or the literal "empty" when the tool returned an empty image
     * @throws Error when connect was not called, when the tool reports an error, or when the result has no image
     */
    async exportPng(fileId: string, pageId: string, shapeId: string, scale: number): Promise<Buffer | "empty"> {
        const client = this.client;
        if (client === undefined) {
            throw new Error("exportPng was called before connect");
        }
        const result = await callWithRetry(() =>
            client.callTool({
                name: EXPORT_TOOL,
                arguments: { fileId, pageId, shapeId, format: "png", scale },
            })
        );
        const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
        const texts = blocks.flatMap((block) => {
            const candidate = recordOf(block);
            return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
        });
        const text = texts.join("\n");
        if (result.isError === true) {
            throw new Error(`${EXPORT_TOOL} failed: ${text}`);
        }
        const failure = texts.find((item) => item.startsWith(BACKEND_FAILURE_PREFIX));
        if (failure !== undefined) {
            throw new Error(failure);
        }
        const data = McpImageClient.imageDataOf(blocks);
        if (data === undefined) {
            throw new Error(`${EXPORT_TOOL} returned no image block`);
        }
        if (data === "") {
            return "empty";
        }
        return Buffer.from(data, "base64");
    }

    /**
     * Finds the base64 data of the first image block.
     *
     * @param blocks - content blocks of a tool result
     * @returns the base64 string, or undefined when no image block has string data
     */
    private static imageDataOf(blocks: readonly unknown[]): string | undefined {
        for (const block of blocks) {
            const candidate = recordOf(block);
            if (candidate.type === "image" && typeof candidate.data === "string") {
                return candidate.data;
            }
        }
        return undefined;
    }
}
