import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { test } from "node:test";
import express from "express";
import { type BackendTokenValidator, TokenRejectedError } from "./backend/BackendTokenValidator";
import { InitializeTokenCheck, McpAuthentication } from "./McpAuthentication";
import { PenpotMcpServer, partitionToolNames } from "./PenpotMcpServer";

const whoami = { profileId: "profile-1", scopes: ["mcp:read"] };

/** A validator stub that records the tokens it sees and throws the error chosen for each token. */
class StubValidator implements Pick<BackendTokenValidator, "validate"> {
    /** Tokens passed to `validate`, in call order. */
    public readonly tokens: string[] = [];

    /**
     * Creates a stub.
     *
     * @param failureFor returns the error to throw for a token, or undefined to accept it
     */
    constructor(private readonly failureFor: (token: string) => Error | undefined = () => undefined) {}

    public async validate(token: string): Promise<typeof whoami> {
        this.tokens.push(token);
        const failure = this.failureFor(token);
        if (failure) {
            throw failure;
        }
        return whoami;
    }
}

/**
 * Starts an Express app on a random loopback port, runs the test, and closes the server.
 *
 * @param app the app to serve
 * @param run receives the base URL of the app
 */
async function withApp(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
        await run(`http://127.0.0.1:${address.port}/mcp`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

/**
 * Builds the body of a legacy `initialize` call.
 */
function initializeBody(): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "penpot-test", version: "1" },
        },
    });
}

/**
 * Builds a POST request to `/mcp` with a bearer token and a JSON body.
 *
 * @param url the endpoint URL
 * @param token the bearer token to send
 * @param body the JSON body to send
 * @param headers extra headers to send
 */
function postMcp(url: string, token: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
            ...headers,
        },
        body,
    });
}

/**
 * Serves the initialize gate on `/mcp` the way the server does: authenticate, then check the token.
 *
 * @param validator the validator the gate uses
 */
function gateApp(validator: StubValidator): express.Express {
    const authentication = new McpAuthentication("https://penpot.example/api/mcp/oauth", true);
    const check = new InitializeTokenCheck(authentication, validator);
    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
        const result = authentication.authenticate(req, res);
        if (result.isRejected) {
            return;
        }
        if (await check.rejectsRequest(req, res, result.userToken ?? "")) {
            return;
        }
        res.json({ ok: true });
    });
    return app;
}

test("a token that the backend rejects gets 401 with a WWW-Authenticate challenge on initialize", async () => {
    const validator = new StubValidator((token) => (token === "bad-token" ? new TokenRejectedError() : undefined));
    await withApp(gateApp(validator), async (url) => {
        const response = await postMcp(url, "bad-token", initializeBody());
        assert.equal(response.status, 401);
        assert.equal(
            response.headers.get("www-authenticate"),
            'Bearer resource_metadata="https://penpot.example/api/mcp/oauth/resource", scope="mcp", error="invalid_token"'
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(validator.tokens, ["bad-token"]);
    });
});

test("a token that the backend accepts passes initialize", async () => {
    const validator = new StubValidator();
    await withApp(gateApp(validator), async (url) => {
        const response = await postMcp(url, "good-token", initializeBody());
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.deepEqual(validator.tokens, ["good-token"]);
    });
});

test("a request that is not initialize is not pre-validated", async () => {
    const validator = new StubValidator(() => new TokenRejectedError());
    const toolCall = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } });
    await withApp(gateApp(validator), async (url) => {
        const response = await postMcp(url, "bad-token", toolCall);
        assert.equal(response.status, 200);
        assert.deepEqual(validator.tokens, []);
    });
});

test("an initialize with an existing session header is not pre-validated", async () => {
    const validator = new StubValidator(() => new TokenRejectedError());
    await withApp(gateApp(validator), async (url) => {
        const response = await postMcp(url, "bad-token", initializeBody(), { "mcp-session-id": "session-1" });
        assert.equal(response.status, 200);
        assert.deepEqual(validator.tokens, []);
    });
});

test("a backend failure other than a rejection lets initialize through", async () => {
    const validator = new StubValidator(() => new Error("backend unavailable"));
    await withApp(gateApp(validator), async (url) => {
        const response = await postMcp(url, "good-token", initializeBody());
        assert.equal(response.status, 200);
        assert.deepEqual(validator.tokens, ["good-token"]);
    });
});

// ── Real server against a fake backend ─────────────────────────

/** A running fake backend that answers `mcp-whoami` with a fixed status and counts the calls. */
interface FakeBackend {
    url: string;
    calls(): number;
    close(): Promise<void>;
}

/**
 * Starts a fake backend that answers `mcp-whoami` with the given status.
 *
 * @param whoamiStatus the HTTP status of `mcp-whoami` answers
 */
async function startFakeBackend(whoamiStatus: number): Promise<FakeBackend> {
    let calls = 0;
    const server: HttpServer = createHttpServer((req, res) => {
        if (req.url?.endsWith("/api/main/methods/mcp-whoami")) {
            calls++;
            const body = whoamiStatus === 200 ? whoami : { type: "authentication", code: "invalid-token" };
            res.writeHead(whoamiStatus, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${address.port}/`,
        calls: () => calls,
        close: () =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}

/**
 * Finds a free loopback port by binding a probe server to port 0.
 */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Runs a function with some environment variables set, and restores the environment afterwards.
 *
 * @param overrides variables to set, or undefined to remove
 * @param run the function to run
 */
async function withEnvironment(overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
    const previous = process.env;
    const next: NodeJS.ProcessEnv = { ...previous };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
            delete next[key];
        } else {
            next[key] = value;
        }
    }
    process.env = next;
    try {
        await run();
    } finally {
        process.env = previous;
    }
}

test("with OAuth and a backend, a rejected token gets 401 on initialize from the real server", async () => {
    const backend = await startFakeBackend(401);
    try {
        const port = await freePort();
        await withEnvironment(serverEnvironment(port, backend.url), async () => {
            const server = new PenpotMcpServer(true);
            await server.start();
            try {
                const response = await postMcp(`http://127.0.0.1:${port}/mcp`, "bad-token", initializeBody());
                assert.equal(response.status, 401);
                assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
                assert.equal(backend.calls(), 1);
            } finally {
                await server.stop();
            }
        });
    } finally {
        await backend.close();
    }
});

test("with OAuth and a backend, an accepted token completes initialize on the real server", async () => {
    const backend = await startFakeBackend(200);
    try {
        const port = await freePort();
        await withEnvironment(serverEnvironment(port, backend.url), async () => {
            const server = new PenpotMcpServer(true);
            await server.start();
            try {
                const response = await postMcp(`http://127.0.0.1:${port}/mcp`, "good-token", initializeBody());
                assert.equal(response.status, 200);
                assert.match(await response.text(), /protocolVersion|serverInfo|result/);
                assert.equal(backend.calls(), 1);
            } finally {
                await server.stop();
            }
        });
    } finally {
        await backend.close();
    }
});

/**
 * Builds the environment of a multi-user server with OAuth and a backend.
 *
 * @param port the server port
 * @param backendUrl the backend base URL
 */
function serverEnvironment(port: number, backendUrl: string | undefined): Record<string, string | undefined> {
    return {
        PENPOT_MCP_SERVER_HOST: "127.0.0.1",
        PENPOT_MCP_SERVER_PORT: String(port),
        PENPOT_MCP_WEBSOCKET_PORT: "0",
        PENPOT_MCP_DEVENV: "false",
        PENPOT_MCP_REPL_ENABLE: "false",
        PENPOT_MCP_REDIS_URI: undefined,
        PENPOT_MCP_AUTH_URI: "http://localhost:3449/api/mcp/oauth",
        PENPOT_MCP_BACKEND_URI: backendUrl,
        PENPOT_MCP_MODE: undefined,
    };
}

// ── Tool names in both mode ────────────────────────────────────

test("partitionToolNames sorts the plain names and the bridge names separately", () => {
    assert.deepEqual(
        partitionToolNames(
            ["whoami", "export_shape_from_tab", "execute_code_in_tab", "apply_operations"],
            ["execute_code_in_tab", "export_shape_from_tab"]
        ),
        {
            plain: ["apply_operations", "whoami"],
            bridge: ["execute_code_in_tab", "export_shape_from_tab"],
        }
    );
});

test("both mode gives the plugin tools their own names and leaves the plain names to the backend", async () => {
    await withEnvironment(
        { ...serverEnvironment(0, "http://127.0.0.1:9/"), PENPOT_MCP_AUTH_URI: undefined },
        async () => {
            const server = new PenpotMcpServer(false);
            try {
                const names = server.getToolNames();
                assert.equal(server.getMode(), "both");
                assert.deepEqual(server.getBridgeToolNames(), [
                    "execute_code_in_tab",
                    "export_shape_from_tab",
                    "import_image_in_tab",
                ]);
                for (const name of server.getBridgeToolNames()) {
                    assert.ok(names.includes(name), name);
                }
                for (const name of ["execute_code", "export_shape", "import_image", "whoami", "submit_feedback"]) {
                    assert.ok(names.includes(name), name);
                }
            } finally {
                await server.stop();
            }
        }
    );
});

test("bridge mode keeps the plain plugin tool names", async () => {
    await withEnvironment(
        {
            ...serverEnvironment(0, undefined),
            PENPOT_MCP_MODE: "bridge",
            PENPOT_MCP_BACKEND_URI: undefined,
            PENPOT_MCP_AUTH_URI: undefined,
        },
        async () => {
            const server = new PenpotMcpServer(false);
            try {
                assert.equal(server.getMode(), "bridge");
                assert.deepEqual(server.getBridgeToolNames(), []);
                assert.ok(server.getToolNames().includes("execute_code"));
            } finally {
                await server.stop();
            }
        }
    );
});
