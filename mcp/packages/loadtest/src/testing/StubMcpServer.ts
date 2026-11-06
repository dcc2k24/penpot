import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";

/** One call that the stub received, kept for assertions. */
export interface StubCall {
    /** Tool name. */
    tool: string;
    /** Bearer token of the request that carried the call. */
    token: string;
    /** Arguments as received. */
    args: Record<string, unknown>;
}

/**
 * A tiny MCP server over Streamable HTTP for tests. It exposes whoami, apply_operations, a failing tool (fail_tool)
 * and a slow tool (sleep) with fake results, and records every call together with the bearer token that made it. It
 * accepts any token.
 */
export class StubMcpServer {
    /** Calls received so far, in arrival order. */
    readonly calls: StubCall[] = [];

    private httpServer: Server | undefined;

    /** Bearer token of the request whose tool call is running, kept per async context so agents do not mix. */
    private readonly requestTokens = new AsyncLocalStorage<string>();

    /**
     * Starts listening on the loopback interface.
     *
     * @param port - port to listen on, 0 for a random free port
     * @returns the MCP endpoint URL
     */
    async start(port = 0): Promise<string> {
        const handler = toNodeHandler(createMcpHandler(() => this.createMcpServer()));
        this.httpServer = createServer(async (req, res) => {
            if (req.url !== "/mcp") {
                res.statusCode = 404;
                res.end();
                return;
            }
            const body = await StubMcpServer.readBody(req);
            const token = StubMcpServer.bearerOf(req);
            await this.requestTokens.run(token, () => handler(req, res, body === "" ? undefined : JSON.parse(body)));
        });
        this.httpServer.listen(port, "127.0.0.1");
        await once(this.httpServer, "listening");
        const address = this.httpServer.address() as AddressInfo;
        return `http://127.0.0.1:${address.port}/mcp`;
    }

    /**
     * Stops the server and closes open connections.
     */
    async stop(): Promise<void> {
        if (this.httpServer === undefined) {
            return;
        }
        this.httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            this.httpServer?.close((error) => (error ? reject(error) : resolve()));
        });
        this.httpServer = undefined;
    }

    /**
     * Builds the MCP server with the two stub tools.
     */
    private createMcpServer(): McpServer {
        const server = new McpServer({ name: "penpot-stub", version: "1.0.0" });
        server.registerTool("whoami", { description: "Stub whoami.", inputSchema: {} }, async () =>
            this.respond("whoami", {}, { profileId: "stub-profile" })
        );
        // a tool that fails the way the server reports failures: the isError flag and the failure text prefix
        server.registerTool(
            "fail_tool",
            { description: "Stub tool that always fails.", inputSchema: { reason: z.string().optional() } },
            async (args: { reason?: string }) => {
                this.calls.push({ tool: "fail_tool", token: this.requestTokens.getStore() ?? "", args });
                return {
                    isError: true,
                    content: [
                        { type: "text" as const, text: `Tool execution failed: ${args.reason ?? "stub failure"}` },
                    ],
                };
            }
        );
        // a tool that answers after the given number of milliseconds, to test duration limits
        server.registerTool(
            "sleep",
            { description: "Stub tool that waits, then answers.", inputSchema: { ms: z.number() } },
            async (args: { ms: number }) => {
                await new Promise((resolve) => setTimeout(resolve, args.ms));
                return this.respond("sleep", args, { slept: args.ms });
            }
        );
        server.registerTool(
            "apply_operations",
            {
                description: "Stub apply_operations: returns a UUID for every $tmp handle.",
                inputSchema: {
                    fileId: z.string(),
                    operations: z.array(z.record(z.string(), z.unknown())),
                },
            },
            async (args: { fileId: string; operations: Record<string, unknown>[] }) => {
                const createdIds: Record<string, string> = {};
                for (const operation of args.operations) {
                    const id = operation.id;
                    if (typeof id === "string" && id.startsWith("$tmp:")) {
                        createdIds[id] = randomUUID();
                    }
                }
                return this.respond("apply_operations", args, { revn: this.calls.length, createdIds });
            }
        );
        return server;
    }

    /**
     * Records a call and builds the text result.
     *
     * @param tool - tool name
     * @param args - arguments as received
     * @param value - JSON value returned to the client
     */
    private respond(tool: string, args: Record<string, unknown>, value: unknown) {
        this.calls.push({ tool, token: this.requestTokens.getStore() ?? "", args });
        return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    }

    /**
     * Reads the whole request body.
     *
     * @param req - incoming request
     */
    private static async readBody(req: IncomingMessage): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf8");
    }

    /**
     * Extracts the token of a Bearer authorization header.
     *
     * @param req - incoming request
     */
    private static bearerOf(req: IncomingMessage): string {
        const header = req.headers.authorization ?? "";
        return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    }
}
