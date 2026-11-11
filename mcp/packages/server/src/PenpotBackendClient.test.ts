import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { BackendRateLimitError, BackendRpcError } from "./backend/BackendRpcError";
import { RateLimitError } from "./backend/TokenRateLimiter";
import { PenpotBackendClient, isWriteCommand } from "./PenpotBackendClient";
import { CallContext } from "./backend/CallContext";

/** One request received by the local backend stub. */
interface Received {
    method: string | undefined;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
}

/** The canned answer of the local backend stub. */
interface Reply {
    status: number;
    contentType: string;
    body: string;
    delayMs: number;
    /** Sends the body in pieces without a Content-Length, so the client reads it as a stream. */
    chunked: boolean;
    /** Headers sent with the answer, besides the content type. */
    headers?: Record<string, string>;
}

/** Piece size of a chunked stub reply, in bytes. */
const CHUNK_BYTES = 64 * 1024;

let stub: Server;
let baseUri: string;
let received: Received[];
let reply: Reply;

beforeEach(async () => {
    received = [];
    reply = { status: 200, contentType: "application/json", body: "{}", delayMs: 0, chunked: false };
    stub = createServer(async (req, res) => {
        res.on("error", () => undefined);
        let body = "";
        for await (const chunk of req) body += chunk;
        received.push({ method: req.method, url: req.url!, headers: req.headers, body: body });
        if (reply.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        }
        res.writeHead(reply.status, { "content-type": reply.contentType, ...reply.headers });
        if (reply.chunked) {
            for (let offset = 0; offset < reply.body.length; offset += CHUNK_BYTES) {
                res.write(reply.body.slice(offset, offset + CHUNK_BYTES));
            }
            res.end();
        } else {
            res.end(reply.body);
        }
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const address = stub.address();
    assert.ok(address && typeof address === "object");
    baseUri = `http://127.0.0.1:${address.port}/penpot/`;
});

afterEach(async () => {
    stub.closeAllConnections();
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
});

const client = () => new PenpotBackendClient(baseUri);

test("callCommand posts JSON with the token, client header and command path", async () => {
    reply.body = JSON.stringify([{ id: "team-1", name: "Design" }]);
    const result = await client().callCommand("alice", "get-teams", {});
    assert.deepEqual(result, [{ id: "team-1", name: "Design" }]);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].url, "/penpot/api/main/methods/get-teams");
    assert.equal(received[0].headers.authorization, "Token alice");
    assert.equal(received[0].headers["x-client"], "penpot-mcp");
    assert.equal(received[0].headers.accept, "application/json");
    assert.equal(received[0].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(received[0].body), {});
});

test("callCommand sends the parameters as the JSON body", async () => {
    await client().callCommand("alice", "get-projects", { teamId: "team-1" });
    assert.deepEqual(JSON.parse(received[0].body), { teamId: "team-1" });
});

test("callCommand returns undefined for an empty success body", async () => {
    reply.body = "";
    assert.equal(await client().callCommand("alice", "delete-file", { id: "f" }), undefined);
});

for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    test(`callCommand maps a JSON error body on status ${status} to BackendRpcError`, async () => {
        reply.status = status;
        reply.body = JSON.stringify({
            type: "validation",
            code: "params-validation",
            hint: "missing team id",
            explain: "field :team-id is required",
        });
        await assert.rejects(client().callCommand("alice", "get-projects", {}), (error: unknown) => {
            assert.ok(error instanceof BackendRpcError);
            assert.equal(error.status, status);
            assert.equal(error.code, "params-validation");
            assert.equal(error.type, "validation");
            assert.equal(error.hint, "missing team id");
            assert.deepEqual(error.body, JSON.parse(reply.body));
            assert.match(error.message, /Backend error params-validation: missing team id/);
            assert.match(error.message, /field :team-id is required/);
            return true;
        });
    });
}

const RATE_LIMIT_BODY = JSON.stringify({ type: "rate-limit", code: "request-blocked", hint: "rate limit reached" });

test("callCommand maps the backend rate limit to an error with the retry time from retry-after, rounded up", async () => {
    reply.status = 429;
    reply.body = RATE_LIMIT_BODY;
    reply.headers = { "retry-after": "3.2" };
    await assert.rejects(client().callCommand("alice", "get-mcp-subtree", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRateLimitError);
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.retryAfterSeconds, 4);
        assert.match(error.message, /^backend rate limit reached, retry after 4 s\./);
        assert.match(error.message, /cursor/);
        return true;
    });
});

test("callCommand states at most 10 s when retry-after gives the time to a full bucket", async () => {
    reply.status = 429;
    reply.body = RATE_LIMIT_BODY;
    reply.headers = { "retry-after": "120" };
    await assert.rejects(client().callCommand("alice", "get-mcp-subtree", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRateLimitError);
        assert.equal(error.retryAfterSeconds, 10);
        assert.match(error.message, /^backend rate limit reached, retry after 10 s\./);
        return true;
    });
});

test("callCommand gives a fixed wait for the backend rate limit when the refusal has no retry-after", async () => {
    reply.status = 429;
    reply.body = RATE_LIMIT_BODY;
    await assert.rejects(client().callCommand("alice", "get-mcp-subtree", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRateLimitError);
        assert.equal(error.retryAfterSeconds, undefined);
        assert.match(error.message, /^backend rate limit reached, wait about 10 s and retry\./);
        assert.match(error.message, /cursor/);
        return true;
    });
});

test("callCommand ignores a retry-after that is not a number of seconds", async () => {
    reply.status = 429;
    reply.body = RATE_LIMIT_BODY;
    reply.headers = { "retry-after": "soon" };
    await assert.rejects(client().callCommand("alice", "get-mcp-subtree", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRateLimitError);
        assert.equal(error.retryAfterSeconds, undefined);
        return true;
    });
});

test("callCommand reports the status only when the error body is not JSON", async () => {
    reply.status = 502;
    reply.contentType = "text/html";
    reply.body = "<html>gateway secret-detail</html>";
    await assert.rejects(client().callCommand("alice", "get-teams", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRpcError);
        assert.equal(error.status, 502);
        assert.equal(error.body, undefined);
        assert.equal(error.code, undefined);
        assert.match(error.message, /HTTP 502/);
        assert.doesNotMatch(error.message, /secret-detail/);
        return true;
    });
});

test("callCommand renders a context field, truncated, in the error message", async () => {
    reply.status = 400;
    reply.body = JSON.stringify({ code: "mcp-batch-too-large", hint: "too many changes", context: "x".repeat(2000) });
    await assert.rejects(client().callCommand("alice", "mcp-apply-changes", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRpcError);
        assert.ok(error.message.length < 700);
        return true;
    });
});

test("callCommand fails with a no-response message when the timeout elapses", async () => {
    reply.delayMs = 500;
    await assert.rejects(
        client().callCommand("alice", "get-teams", {}, { timeoutMs: 50 }),
        /got no response .*may or may not have been applied/
    );
});

test("callCommand never puts the token in an error message", async () => {
    reply.status = 401;
    reply.body = JSON.stringify({ code: "authentication", hint: "bad token" });
    await assert.rejects(client().callCommand("secret-token-value", "get-teams", {}), (error: unknown) => {
        assert.doesNotMatch(String(error), /secret-token-value/);
        return true;
    });
});

test("callMultipart sends the fields and the file as form data without a fixed content type", async () => {
    reply.body = JSON.stringify({ id: "media-1" });
    const result = await client().callMultipart(
        "alice",
        "upload-file-media-object",
        { "file-id": "f1", name: "a.png" },
        [
            {
                fieldName: "content",
                fileName: "a.png",
                mimeType: "image/png",
                content: new Uint8Array([137, 80, 78, 71]),
            },
        ]
    );
    assert.deepEqual(result, { id: "media-1" });
    const request = received[0];
    assert.equal(request.url, "/penpot/api/main/methods/upload-file-media-object");
    assert.equal(request.headers.authorization, "Token alice");
    assert.match(String(request.headers["content-type"]), /^multipart\/form-data; boundary=/);
    assert.match(request.body, /name="file-id"\r\n\r\nf1/);
    assert.match(request.body, /name="name"\r\n\r\na\.png/);
    assert.match(request.body, /name="content"; filename="a\.png"/);
    assert.match(request.body, /Content-Type: image\/png/);
});

test("callMultipart resolves a server-sent event response to the transit data of its end event", async () => {
    reply.contentType = "text/event-stream";
    reply.body =
        'event: progress\ndata: ["^ ","~:progress",1]\n\nevent: end\ndata: ["^ ","~:progress",2,"~:done",true]\n\n';
    const result = await client().callMultipart("alice", "import-binfile", { "project-id": "p1" }, []);
    assert.deepEqual(result, { progress: 2, done: true });
});

test("callCommand decodes the data of the end event as transit data", async () => {
    reply.contentType = "text/event-stream";
    reply.body = 'event: progress\ndata: ["^ ","~:done",1]\n\nevent: end\ndata: ["^ ","~:name","~:frame"]\n\n';
    assert.deepEqual(await client().callCommand("alice", "get-teams", {}), { name: "frame" });
});

test("callCommand returns undefined for an end event with no data", async () => {
    reply.contentType = "text/event-stream";
    reply.body = "event: end\ndata:\n\n";
    assert.equal(await client().callCommand("alice", "get-teams", {}), undefined);
});

test("callCommand fails when the event stream ends without an end event", async () => {
    reply.contentType = "text/event-stream";
    reply.body = 'event: progress\ndata: ["^ ","~:done",1]\n\n';
    await assert.rejects(client().callCommand("alice", "get-teams", {}), /did not finish; check the state/);
});

test("import-binfile fails with the list_files hint when its stream has no end event", async () => {
    reply.contentType = "text/event-stream";
    reply.body = ": keep-alive\n\n";
    await assert.rejects(
        client().callMultipart("alice", "import-binfile", {}, []),
        /import did not finish; check list_files before retrying/
    );
});

test("callCommand throws a BackendRpcError for an error event, with its decoded body", async () => {
    reply.contentType = "text/event-stream";
    reply.body =
        'event: progress\ndata: ["^ ","~:done",1]\n\n' +
        'event: error\ndata: ["^ ","~:type","~:server-error","~:code","~:unexpected","~:hint","import failed"]\n\n';
    await assert.rejects(client().callCommand("alice", "import-binfile", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRpcError);
        assert.equal(error.status, 200);
        assert.equal(error.commandName, "import-binfile");
        assert.equal(error.type, "server-error");
        assert.equal(error.code, "unexpected");
        assert.equal(error.hint, "import failed");
        assert.match(error.message, /Backend error unexpected: import failed/);
        return true;
    });
});

test("callCommand keeps the status-only message when an error event is not a transit object", async () => {
    reply.contentType = "text/event-stream";
    reply.body = "event: error\ndata: not-transit\n\n";
    await assert.rejects(client().callCommand("alice", "import-binfile", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRpcError);
        assert.equal(error.body, undefined);
        assert.match(error.message, /HTTP 200/);
        return true;
    });
});

test("callCommand fails on a data event that is not decodable transit", async () => {
    reply.contentType = "text/event-stream";
    reply.body = "event: end\ndata: [unclosed\n\n";
    await assert.rejects(
        client().callCommand("alice", "import-binfile", {}),
        /returned an event that is not decodable transit JSON/
    );
});

test("a body over the cap is refused from its Content-Length before it is read", async () => {
    const capped = new PenpotBackendClient(baseUri, 120, 2);
    reply.body = JSON.stringify("a".repeat(2 * 1024 * 1024));
    await assert.rejects(
        capped.callCommand("alice", "get-teams", {}),
        /^Error: Backend response exceeds 2 MB \(PENPOT_MCP_BACKEND_MAX_RESPONSE_MB\)$/
    );
});

test("a streamed body over the cap is aborted while it is read", async () => {
    const capped = new PenpotBackendClient(baseUri, 120, 2);
    reply.chunked = true;
    reply.body = JSON.stringify("a".repeat(3 * 1024 * 1024));
    await assert.rejects(
        capped.callCommand("alice", "get-teams", {}),
        /^Error: Backend response exceeds 2 MB \(PENPOT_MCP_BACKEND_MAX_RESPONSE_MB\)$/
    );
});

test("a streamed body under the cap is read in full and parsed", async () => {
    const capped = new PenpotBackendClient(baseUri, 120, 2);
    reply.chunked = true;
    const value = "b".repeat(1024 * 1024);
    reply.body = JSON.stringify(value);
    assert.equal(await capped.callCommand("alice", "get-teams", {}), value);
});

test("a small body under the default cap parses", async () => {
    reply.body = JSON.stringify([{ id: "team-1" }]);
    assert.deepEqual(await client().callCommand("alice", "get-teams", {}), [{ id: "team-1" }]);
});

test("the constructor rejects a cap that is not a positive number", () => {
    assert.throws(() => new PenpotBackendClient(baseUri, 120, 0), /positive number of megabytes/);
    assert.throws(() => new PenpotBackendClient(baseUri, 120, Number.NaN), /positive number of megabytes/);
});

test("callCommand refuses redirects instead of following them", async () => {
    reply.status = 307;
    reply.body = "";
    await assert.rejects(client().callCommand("alice", "get-teams", {}), (error: unknown) => {
        assert.ok(error instanceof BackendRpcError);
        assert.equal(error.status, 307);
        return true;
    });
});

test("rejects a base URI with credentials, a query or a fragment", () => {
    for (const uri of ["https://user:secret@example.com/", "https://example.com/?token=1", "file:///tmp/x"]) {
        assert.throws(() => new PenpotBackendClient(uri), /PENPOT_MCP_BACKEND_URI/);
    }
});

test("callCommand gives up when the caller signal fires, before the timeout", async () => {
    reply.delayMs = 500;
    const controller = new AbortController();
    const call = client().callCommand("alice", "get-teams", {}, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(call, /got no response \(AbortError\)/);
});

test("callCommand takes the signal of the current call when none is given", async () => {
    reply.delayMs = 500;
    const controller = new AbortController();
    const call = CallContext.run({ signal: controller.signal }, () => client().callCommand("alice", "get-teams", {}));
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(call, /got no response/);
});

test("callCommand sends the request id of the current call as X-Request-Id", async () => {
    await CallContext.run({ requestId: "req-42" }, () => client().callCommand("alice", "get-teams", {}));
    assert.equal(received[0].headers["x-request-id"], "req-42");
});

test("callCommand sends no X-Request-Id outside a tool call", async () => {
    await client().callCommand("alice", "get-teams", {});
    assert.equal(received[0].headers["x-request-id"], undefined);
});

test("callCommand passes the connection pool to fetch", async (t) => {
    const pool = { pool: true };
    const seen: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await new PenpotBackendClient(baseUri, 120, 8, pool as never).callCommand("alice", "get-teams", {});
    assert.equal((seen[0] as { dispatcher?: unknown }).dispatcher, pool);
});

test("a body over the cap is refused when the client was built with the cap from settings", async () => {
    reply.chunked = true;
    reply.body = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
    await assert.rejects(
        new PenpotBackendClient(baseUri, 120, 1).callCommand("alice", "get-teams", {}),
        /exceeds 1 MB/
    );
});

test("a write command is not aborted by the caller's signal, even while it is in flight", async () => {
    reply.delayMs = 200;
    const controller = new AbortController();
    const call = client().callCommand("alice", "delete-project", {}, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 20);
    assert.deepEqual(await call, {});
});

test("a call marked abortable false is not aborted, even when it is a read", async () => {
    reply.delayMs = 200;
    const controller = new AbortController();
    const call = client().callCommand(
        "alice",
        "get-teams",
        {},
        { signal: controller.signal, abortable: false, timeoutMs: 5_000 }
    );
    setTimeout(() => controller.abort(), 20);
    assert.deepEqual(await call, {});
});

test("isWriteCommand names the commands that change state and no read", () => {
    for (const name of ["create-file", "delete-project", "move-files", "import-binfile", "mcp-apply-operations"]) {
        assert.equal(isWriteCommand(name), true, name);
    }
    for (const name of ["get-teams", "mcp-whoami", "get-mcp-shapes"]) {
        assert.equal(isWriteCommand(name), false, name);
    }
});
