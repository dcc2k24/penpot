import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type CallToolResult, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";
import { PenpotMcpServer } from "./PenpotMcpServer";

let server: PenpotMcpServer;
let baseUrl: string;
let previousEnv: NodeJS.ProcessEnv;
let nextPort = 16_500;

beforeEach(async () => {
    previousEnv = { ...process.env };
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = "0";
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_REDIS_URI;
    delete process.env.PENPOT_MCP_AUTH_URI;
    server = new PenpotMcpServer(true);
    baseUrl = `http://127.0.0.1:${server.port}`;
    await server.start();
});

afterEach(async () => {
    await server?.stop();
    process.env = previousEnv;
});

async function modernRequest(method: string, params: Record<string, unknown> = {}, query = "", bearer?: string) {
    return fetch(`${baseUrl}/mcp${query}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
                ...params,
                _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": { name: "penpot-test", version: "1" },
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
            },
        }),
    });
}

test("serves repeated modern client requests without allocating a session", async () => {
    const client = new Client(
        { name: "modern-test", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
        await client.connect(transport);
        for (let i = 0; i < 2; i++) {
            const result = await client.listTools();
            assert.equal(transport.sessionId, undefined);
            const tool = result.tools.find((tool) => tool.name === "execute_code");
            assert.ok(tool);
            assert.equal(tool.inputSchema.type, "object");
            assert.deepEqual(tool.inputSchema.required, ["code"]);
        }
    } finally {
        await client.close();
    }
});

test("isolates user tokens across overlapping tool calls with the same request ID", async (t) => {
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = 0;
    t.mock.method(server.pluginBridge, "executePluginTask", async () => {
        if (++started === 2) release();
        await bothStarted;
        return { data: server.getSessionContext()?.userToken ?? null };
    });

    const results = await Promise.all(
        ["alice", "bob"].map(async (token) => {
            const response = await modernRequest(
                "tools/call",
                {
                    name: "execute_code",
                    arguments: { code: "return 1;" },
                },
                token === "alice" ? "" : `?userToken=${token}`,
                token === "alice" ? token : undefined
            );
            const body = (await response.json()) as { result: CallToolResult };
            assert.equal(response.status, 200, JSON.stringify(body));
            const content = body.result.content[0];
            assert.equal(content.type, "text");
            return JSON.parse(content.text);
        })
    );
    assert.deepEqual(results, ["alice", "bob"]);
    assert.equal(server.getSessionContext(), undefined);
});

test("passes an explicit Penpot session ID from the tool call to plugin dispatch", async (t) => {
    t.mock.method(server.pluginBridge, "executePluginTask", async (_task: unknown, sessionId?: string) => ({
        data: sessionId,
    }));
    const response = await modernRequest(
        "tools/call",
        {
            name: "execute_code",
            arguments: { code: "return penpot.currentFile.id;", sessionId: "chosen-tab" },
        },
        "?userToken=alice"
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(JSON.stringify(body), /chosen-tab/);
});

test("supports older Streamable HTTP clients without allocating a session", async () => {
    const client = new Client({ name: "legacy-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
        await client.connect(transport);
        assert.equal(transport.sessionId, undefined);
        const result = await client.listTools();
        assert.ok(result.tools.some((tool) => tool.name === "execute_code"));
    } finally {
        await client.close();
    }
});

test("OAuth challenges missing credentials and accepts bearer and query tokens", async () => {
    await server.stop();
    process.env.PENPOT_MCP_AUTH_URI = "https://penpot.example/api/mcp/oauth";
    server = new PenpotMcpServer(true);
    await server.start();

    const missing = await modernRequest("tools/list");
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /resource_metadata=/);

    for (const useBearer of [true, false]) {
        const client = new Client({ name: "oauth-test", version: "1" });
        const transport = new StreamableHTTPClientTransport(
            new URL(`${baseUrl}/mcp${useBearer ? "" : "?userToken=alice"}`),
            useBearer ? { requestInit: { headers: { Authorization: "Bearer alice" } } } : undefined
        );
        try {
            await client.connect(transport);
            const result = await client.listTools();
            const tool = result.tools.find((tool) => tool.name === "execute_code");
            assert.ok(tool, "authenticated clients can discover execute_code");
        } finally {
            await client.close();
        }
    }
});

/** A tools/list request padded to a given size, so that the body crosses a size limit. */
function paddedListBody(bytes: number): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { pad: "x".repeat(bytes) },
    });
}

test("a body over the 4 MB floor without a token is refused with 413 when no OAuth is configured", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: paddedListBody(5 * 1024 * 1024),
    });
    assert.equal(response.status, 413);
});

test("in bridge mode a Bearer string nobody validated still gets the 4 MB floor, not the large limit", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer alice",
        },
        body: paddedListBody(5 * 1024 * 1024),
    });
    assert.equal(response.status, 413);
});

test("with OAuth, an oversized body without a token gets 401 before any tool can run", async (t) => {
    await server.stop();
    process.env.PENPOT_MCP_AUTH_URI = "https://penpot.example/api/mcp/oauth";
    server = new PenpotMcpServer(true);
    await server.start();
    const run = t.mock.method(server.pluginBridge, "executePluginTask", async () => ({ data: 1 }));
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "execute_code", arguments: { code: "x".repeat(3 * 1024 * 1024) } },
        }),
    });
    assert.equal(response.status, 401);
    assert.equal(run.mock.callCount(), 0);
});

test("a request whose Host header is not a loopback name is refused, against DNS rebinding", async () => {
    const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
            {
                host: "127.0.0.1",
                port: server.port,
                path: "/mcp",
                method: "POST",
                headers: {
                    host: "evil.example",
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                },
            },
            (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            }
        );
        req.on("error", reject);
        req.end(paddedListBody(0));
    });
    assert.equal(status, 403);
});

test("healthz answers 200 while the process is up, and readyz answers 200 without a backend", async () => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
});

test("metrics count the finished tool calls in Prometheus text", async (t) => {
    t.mock.method(server.pluginBridge, "executePluginTask", async () => ({ data: 1 }));
    await modernRequest("tools/call", { name: "execute_code", arguments: { code: "return 1;" } }, "?userToken=alice");
    const response = await fetch(`${baseUrl}/metrics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /penpot_mcp_tool_calls_total{tool="execute_code",outcome="ok"} 1/);
    assert.match(text, /# TYPE penpot_mcp_tool_call_duration_seconds histogram/);
    assert.match(text, /penpot_mcp_active_sandboxes 0/);
    assert.match(text, /penpot_mcp_sandbox_calls_total{outcome="ok"} 0/);
});

test("metrics on a non-loopback bind need a validated token", async () => {
    await server.stop();
    process.env.PENPOT_MCP_SERVER_HOST = "0.0.0.0";
    server = new PenpotMcpServer(true);
    await server.start();
    const port = server.port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
});

/** Sends a GET with raw headers, so that the Host header can be set to any value. */
function rawGetStatus(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: server.port, path, method: "GET", headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
    });
}

test("metrics on a loopback bind refuse a Host that is not a loopback name", async () => {
    assert.equal(await rawGetStatus("/metrics", { host: "evil.example" }), 403);
});

test("metrics on a loopback bind need a token for a request that a proxy forwarded", async () => {
    const forwarded = await fetch(`${baseUrl}/metrics`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
    assert.equal(forwarded.status, 401);
    const direct = await fetch(`${baseUrl}/metrics`);
    assert.equal(direct.status, 200);
});
