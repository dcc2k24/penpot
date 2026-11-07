import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PenpotMcpServer } from "./PenpotMcpServer";

/** One request received by the backend stub. */
interface Received {
    url: string;
    authorization?: string;
    client?: string;
}

const WHOAMI = {
    profileId: "profile-1",
    fullname: "Alice",
    scopes: ["mcp:read"],
    version: { full: "2.17", base: "2.17" },
    contractVersion: 1,
};

let stub: Server;
let backendUri: string;
let received: Received[];
let previousEnv: NodeJS.ProcessEnv;
let server: PenpotMcpServer | undefined;
let client: Client | undefined;
let nextPort = 19_100;

beforeEach(async () => {
    previousEnv = { ...process.env };
    received = [];
    stub = createServer(async (req: IncomingMessage, res) => {
        for await (const _chunk of req) {
            // drain the body
        }
        received.push({
            url: req.url!,
            authorization: req.headers.authorization,
            client: req.headers["x-client"] as string | undefined,
        });
        const body = req.url!.endsWith("/mcp-whoami") ? WHOAMI : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const address = stub.address();
    assert.ok(address && typeof address === "object");
    backendUri = `http://127.0.0.1:${address.port}/penpot/`;

    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = "0";
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_REDIS_URI;
    delete process.env.PENPOT_MCP_MODE;
    delete process.env.PENPOT_MCP_BACKEND_URI;
});

afterEach(async () => {
    await client?.close();
    await server?.stop();
    client = undefined;
    server = undefined;
    stub.closeAllConnections();
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    process.env = previousEnv;
});

/** Starts the server with the current environment and connects a client that carries a bearer token. */
async function connect(multiUser = false): Promise<Client> {
    server = new PenpotMcpServer(multiUser);
    await server.start();
    client = new Client({ name: "backend-mode-test", version: "1" });
    const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer alice" } } })
    );
    return client;
}

/** Returns the names of the tools the connected client lists. */
async function toolNames(connected: Client): Promise<string[]> {
    return (await connected.listTools()).tools.map((tool) => tool.name);
}

/** Returns the text of the first content item of a tool result. */
function textOf(result: { content: unknown }): string {
    return (result.content as { text: string }[])[0].text;
}

// ── resolveMode ──

const MODE_CASES: [string, Record<string, string | undefined>, string | RegExp][] = [
    ["unset without a backend URI is bridge", {}, "bridge"],
    ["unset with a backend URI stays bridge", { PENPOT_MCP_BACKEND_URI: "http://localhost:9001/" }, "bridge"],
    ["blank mode counts as unset", { PENPOT_MCP_MODE: "  ", PENPOT_MCP_BACKEND_URI: "http://x/" }, "bridge"],
    ["bridge ignores a backend URI", { PENPOT_MCP_MODE: "bridge", PENPOT_MCP_BACKEND_URI: "http://x/" }, "bridge"],
    ["backend with a URI", { PENPOT_MCP_MODE: "backend", PENPOT_MCP_BACKEND_URI: "http://x/" }, "backend"],
    ["mode names are case-insensitive", { PENPOT_MCP_MODE: "BOTH", PENPOT_MCP_BACKEND_URI: "http://x/" }, "both"],
    ["backend without a URI is an error", { PENPOT_MCP_MODE: "backend" }, /requires PENPOT_MCP_BACKEND_URI/],
    ["both without a URI is an error", { PENPOT_MCP_MODE: "both" }, /requires PENPOT_MCP_BACKEND_URI/],
    [
        "an unknown mode is an error",
        { PENPOT_MCP_MODE: "fast", PENPOT_MCP_BACKEND_URI: "http://x/" },
        /must be one of bridge, backend, both/,
    ],
];

for (const [label, env, expected] of MODE_CASES) {
    test(`resolveMode: ${label}`, () => {
        if (expected instanceof RegExp) {
            assert.throws(() => PenpotMcpServer.resolveMode(env), expected);
        } else {
            assert.equal(PenpotMcpServer.resolveMode(env), expected);
        }
    });
}

// ── backend mode over HTTP ──

test("backend mode serves backend tools, opens no plugin bridge and lists no bridge tools", async () => {
    process.env.PENPOT_MCP_MODE = "backend";
    process.env.PENPOT_MCP_BACKEND_URI = backendUri;
    const connected = await connect();
    const names = await toolNames(connected);
    for (const expected of [
        "whoami",
        "list_teams",
        "apply_operations",
        "batch_create_shapes",
        "import_image",
        "export_shape",
        "submit_feedback",
        "high_level_overview",
        "execute_code",
    ]) {
        assert.ok(names.includes(expected), `${expected} is listed`);
    }
    for (const absent of ["execute_code_in_tab", "export_shape_from_tab", "import_image_in_tab"]) {
        assert.ok(!names.includes(absent), `${absent} is not listed`);
    }
    assert.throws(() => server!.pluginBridge, /disabled in backend mode/);
});

test("backend mode answers whoami with the backend identity, sending the token as a Token header", async () => {
    process.env.PENPOT_MCP_MODE = "backend";
    process.env.PENPOT_MCP_BACKEND_URI = backendUri;
    const connected = await connect();
    const result = await connected.callTool({ name: "whoami", arguments: {} });
    assert.match(textOf(result), /"profileId": ?"profile-1"/);
    const whoamiCalls = received.filter((request) => request.url.endsWith("/api/main/methods/mcp-whoami"));
    assert.ok(whoamiCalls.length >= 1);
    assert.equal(whoamiCalls[0].authorization, "Token alice");
    assert.equal(whoamiCalls[0].client, "penpot-mcp");
});

test("backend mode returns the backend overview from high_level_overview", async () => {
    process.env.PENPOT_MCP_MODE = "backend";
    process.env.PENPOT_MCP_BACKEND_URI = backendUri;
    const connected = await connect();
    const result = await connected.callTool({ name: "high_level_overview", arguments: {} });
    assert.match(textOf(result), /Penpot backend mode/);
    assert.doesNotMatch(textOf(result), /Penpot High-Level Overview/);
});

test("both mode renames the plugin tools and lists backend tools under the plain names", async () => {
    process.env.PENPOT_MCP_MODE = "both";
    process.env.PENPOT_MCP_BACKEND_URI = backendUri;
    const connected = await connect();
    const names = await toolNames(connected);
    for (const expected of [
        "whoami",
        "execute_code_in_tab",
        "export_shape_from_tab",
        "import_image_in_tab",
        "import_image",
        "export_shape",
        "submit_feedback",
        "execute_code",
    ]) {
        assert.ok(names.includes(expected), `${expected} is listed`);
    }
});

test("both mode overview separates the backend and plugin sections", async () => {
    process.env.PENPOT_MCP_MODE = "both";
    process.env.PENPOT_MCP_BACKEND_URI = backendUri;
    const connected = await connect();
    const text = textOf(await connected.callTool({ name: "high_level_overview", arguments: {} }));
    const backendAt = text.indexOf("=== Backend tools");
    const pluginAt = text.indexOf("=== Plugin bridge tools");
    assert.ok(backendAt >= 0 && pluginAt > backendAt, "backend section comes first, then the plugin section");
    assert.match(text, /Penpot backend mode/);
    assert.match(text, /execute_code/);
});

test("bridge mode keeps the plugin tools under their plain names and lists no backend tools", async () => {
    process.env.PENPOT_MCP_MODE = "bridge";
    const connected = await connect();
    const names = await toolNames(connected);
    for (const expected of ["execute_code", "export_shape", "import_image", "high_level_overview", "penpot_api_info"]) {
        assert.ok(names.includes(expected), `${expected} is listed`);
    }
    for (const absent of ["whoami", "apply_operations", "submit_feedback", "execute_code_in_tab"]) {
        assert.ok(!names.includes(absent), `${absent} is not listed`);
    }
    assert.ok(server!.pluginBridge);
});

test("an unset mode without a backend URI behaves as bridge mode", async () => {
    const connected = await connect();
    assert.equal(server!.getMode(), "bridge");
    assert.ok((await toolNames(connected)).includes("execute_code"));
});
