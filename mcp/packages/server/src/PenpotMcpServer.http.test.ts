import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type CallToolResult, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { PenpotMcpServer, readKeepAliveSeconds } from "./PenpotMcpServer";

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
    assert.match(text, /^penpot_mcp_sandbox_workers 0$/m);
    assert.match(text, /^# TYPE process_resident_memory_bytes gauge$/m);
    assert.match(text, /^# TYPE nodejs_heap_used_bytes gauge$/m);
    assert.match(text, /^nodejs_eventloop_lag_p99_seconds [0-9.e+-]+$/m);
    assert.match(text, /penpot_mcp_sandbox_calls_total{outcome="ok"} 0/);
    assert.match(text, /^penpot_mcp_rate_limit_fallback_total 0$/m);
    assert.doesNotMatch(text, /^penpot_mcp_redis_up /m);
});

test("stop resolves, and a second stop does not throw", async () => {
    await server.stop();
    await assert.doesNotReject(server.stop());
    server = new PenpotMcpServer(true);
    baseUrl = `http://127.0.0.1:${server.port}`;
    await server.start();
});

test("metrics show the Redis gauge when Redis is configured", async () => {
    await server.stop();
    process.env.PENPOT_MCP_MODE = "backend";
    process.env.PENPOT_MCP_BACKEND_URI = "http://127.0.0.1:1/";
    process.env.PENPOT_MCP_EXPORTER_URI = "http://127.0.0.1:1/";
    process.env.PENPOT_MCP_REDIS_URI = "redis://127.0.0.1:1";
    server = new PenpotMcpServer(true);
    baseUrl = `http://127.0.0.1:${server.port}`;
    await server.start();
    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(text, /^# TYPE penpot_mcp_redis_up gauge$/m);
    // the URI points at a dead port, so the gauge reads 0 before and after the first call
    assert.match(text, /^penpot_mcp_redis_up 0$/m);
    assert.match(text, /^penpot_mcp_rate_limit_fallback_total 0$/m);
    // the export permits have their own counter and one gauge per configured client
    assert.match(text, /^# TYPE penpot_mcp_export_permit_fallback_total counter$/m);
    assert.match(text, /^penpot_mcp_export_permit_fallback_total 0$/m);
    // exports refused as busy, by the gate that refused them: one series per gate, present from the start
    assert.match(text, /^# TYPE penpot_mcp_export_busy_total counter$/m);
    assert.match(text, /^penpot_mcp_export_busy_total\{gate="token"\} \d+$/m);
    assert.match(text, /^penpot_mcp_export_busy_total\{gate="process"\} \d+$/m);
    assert.match(text, /^penpot_mcp_export_busy_total\{gate="shared"\} \d+$/m);
    assert.match(text, /^# TYPE penpot_mcp_redis_client_up gauge$/m);
    assert.match(text, /^penpot_mcp_redis_client_up\{client="rate-limiter"\} 0$/m);
    assert.match(text, /^penpot_mcp_redis_client_up\{client="storage"\} 1$/m);
    assert.match(text, /^penpot_mcp_redis_client_up\{client="export-permits"\} 1$/m);
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

/** Parses a JSON error body and asserts that it is the short answer: no stack, no path, no library name. */
function assertShortJsonError(text: string): { error: { code: number; message: string } } {
    const body = JSON.parse(text) as { error: { code: number; message: string } };
    for (const leak of ["\n    at ", "node_modules", ".ts:", ".js:"]) {
        assert.equal(text.includes(leak), false, `the answer carries ${JSON.stringify(leak)}`);
    }
    assert.doesNotMatch(text, /[A-Z]:/);
    assert.equal(body.error.message.length < 60, true);
    return body;
}

test("a 5 MB body without a token is a 413 with a short JSON-RPC error, not the Express page", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: paddedListBody(5 * 1024 * 1024),
    });
    assert.equal(response.status, 413);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = assertShortJsonError(await response.text());
    assert.deepEqual(body.error, { code: -32600, message: "request body too large" });
});

test("a body that is truncated JSON is a 400 parse error, with no SyntaxError stack", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer alice",
        },
        body: '{"jsonrpc":"2.0",',
    });
    assert.equal(response.status, 400);
    const body = assertShortJsonError(await response.text());
    assert.deepEqual(body.error, { code: -32700, message: "invalid JSON" });
});

test("10,000 levels of nesting are a 400 before the MCP handler runs, and the server stays up", async (t) => {
    const run = t.mock.method(server.pluginBridge, "executePluginTask", async () => ({ data: 1 }));
    const nested = `${'{"a":'.repeat(10_000)}1${"}".repeat(10_000)}`;
    const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${nested}}`;
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer alice",
        },
        body,
    });
    assert.equal(response.status, 400);
    const parsed = assertShortJsonError(await response.text());
    assert.deepEqual(parsed.error, { code: -32600, message: "request nested too deeply" });
    assert.equal(run.mock.callCount(), 0);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test("an unknown route is a 404 JSON answer, not the Express page", async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = assertShortJsonError(await response.text());
    assert.equal(body.error.message, "not found");
});

test("metrics include the process memory and the cache sizes", async (t) => {
    t.mock.method(server.pluginBridge, "executePluginTask", async () => ({ data: 1 }));
    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(text, /^penpot_mcp_process_resident_bytes \d+$/m);
    assert.match(text, /^penpot_mcp_process_heap_used_bytes \d+$/m);
    assert.match(text, /^penpot_mcp_render_sessions 0$/m);
});

/**
 * Reads the Node HTTP server that a PenpotMcpServer started.
 *
 * @param target - the server
 * @returns the Node HTTP server of the target
 */
function nodeHttpServerOf(target: PenpotMcpServer): HttpServer {
    const found = (target as unknown as { httpServer?: HttpServer }).httpServer;
    assert.ok(found, "the HTTP server is listening");
    return found;
}

test("the HTTP server keeps idle connections 65 s by default, with headers allowed one second more", () => {
    const http = nodeHttpServerOf(server);
    assert.equal(http.keepAliveTimeout, 65_000);
    assert.equal(http.headersTimeout, 66_000);
});

test("PENPOT_MCP_KEEPALIVE_S sets the keep-alive timeout of the HTTP server", async () => {
    process.env.PENPOT_MCP_KEEPALIVE_S = "120";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    const other = new PenpotMcpServer(true);
    await other.start();
    try {
        const http = nodeHttpServerOf(other);
        assert.equal(http.keepAliveTimeout, 120_000);
        assert.equal(http.headersTimeout, 121_000);
    } finally {
        await other.stop();
    }
});

test("readKeepAliveSeconds takes a positive integer and refuses anything else", () => {
    assert.equal(readKeepAliveSeconds({}), 65);
    assert.equal(readKeepAliveSeconds({ PENPOT_MCP_KEEPALIVE_S: "" }), 65);
    assert.equal(readKeepAliveSeconds({ PENPOT_MCP_KEEPALIVE_S: " 90 " }), 90);
    for (const bad of ["0", "-3", "1.5", "abc"]) {
        assert.throws(() => readKeepAliveSeconds({ PENPOT_MCP_KEEPALIVE_S: bad }), /PENPOT_MCP_KEEPALIVE_S/, bad);
    }
});
