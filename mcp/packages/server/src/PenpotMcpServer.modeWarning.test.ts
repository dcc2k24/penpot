import assert from "node:assert/strict";
import type { ServerContext } from "@modelcontextprotocol/server";
import { test } from "node:test";
import { PenpotMcpServer, isLoopbackAddress, readPortVariable } from "./PenpotMcpServer";

const BACKEND = { PENPOT_MCP_BACKEND_URI: "https://penpot.example" };

test("a backend URI alone keeps the mode at bridge", () => {
    assert.equal(PenpotMcpServer.resolveMode(BACKEND), "bridge");
    assert.equal(PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "  ", ...BACKEND }), "bridge");
});

test("an explicit PENPOT_MCP_MODE selects the mode", () => {
    assert.equal(PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "both", ...BACKEND }), "both");
    assert.equal(PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "BACKEND", ...BACKEND }), "backend");
    assert.equal(PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "bridge", ...BACKEND }), "bridge");
});

test("backend and both mode need a backend URI", () => {
    assert.throws(() => PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "both" }), /PENPOT_MCP_BACKEND_URI/);
    assert.throws(() => PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "backend" }), /PENPOT_MCP_BACKEND_URI/);
});

test("an unknown PENPOT_MCP_MODE is a startup error that names the variable", () => {
    assert.throws(() => PenpotMcpServer.resolveMode({ PENPOT_MCP_MODE: "fast" }), /PENPOT_MCP_MODE must be one of/);
});

test("a backend URI without PENPOT_MCP_MODE gets a warning that says the backend tools are off", () => {
    const warning = PenpotMcpServer.unusedBackendWarning(BACKEND);
    assert.ok(warning !== undefined);
    assert.match(warning, /PENPOT_MCP_MODE is not, so the mode is bridge/);
    assert.match(warning, /PENPOT_MCP_MODE=both/);
});

test("an explicit PENPOT_MCP_MODE or no backend URI gets no warning", () => {
    assert.equal(PenpotMcpServer.unusedBackendWarning({ PENPOT_MCP_MODE: "both", ...BACKEND }), undefined);
    assert.equal(PenpotMcpServer.unusedBackendWarning({}), undefined);
    assert.equal(PenpotMcpServer.unusedBackendWarning({ PENPOT_MCP_BACKEND_URI: "   " }), undefined);
});

test("the mode reason names the variable that chose the mode", () => {
    assert.equal(PenpotMcpServer.modeReason({ PENPOT_MCP_MODE: "both" }), "set by PENPOT_MCP_MODE=both");
    assert.match(PenpotMcpServer.modeReason({}), /not set/);
});

test("ports default when unset and reject values that are not port numbers", () => {
    assert.equal(readPortVariable({}, "PENPOT_MCP_SERVER_PORT", 4401), 4401);
    assert.equal(readPortVariable({ PENPOT_MCP_SERVER_PORT: " 0 " }, "PENPOT_MCP_SERVER_PORT", 4401), 0);
    assert.equal(readPortVariable({ PENPOT_MCP_SERVER_PORT: "65535" }, "PENPOT_MCP_SERVER_PORT", 4401), 65535);
    for (const value of ["abc", "70000", "-1", "12.5", "4401x"]) {
        assert.throws(
            () => readPortVariable({ PENPOT_MCP_SERVER_PORT: value }, "PENPOT_MCP_SERVER_PORT", 4401),
            /PENPOT_MCP_SERVER_PORT must be a port number/
        );
    }
});

test("a relative PENPOT_MCP_EXPORT_DIR stops the start, naming the variable", async () => {
    const previous = { ...process.env };
    process.env.PENPOT_MCP_EXPORT_DIR = "relative/exports";
    process.env.PENPOT_MCP_WEBSOCKET_PORT = "0";
    process.env.PENPOT_MCP_SERVER_PORT = "0";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_BACKEND_URI;
    delete process.env.PENPOT_MCP_MODE;
    delete process.env.PENPOT_MCP_AUTH_URI;
    const server = new PenpotMcpServer(false);
    try {
        await assert.rejects(server.start(), /PENPOT_MCP_EXPORT_DIR must be an absolute path/);
    } finally {
        await server.stop();
        process.env = previous;
    }
});

test("progress is reported to a request only when it carries a progress token", async () => {
    const sent: unknown[] = [];
    const notify = async (notification: unknown) => {
        sent.push(notification);
    };
    const withToken = {
        mcpReq: { _meta: { progressToken: "tok-1" }, notify },
    } as unknown as ServerContext;
    const reporter = PenpotMcpServer.progressReporterOf(withToken);
    assert.ok(reporter !== undefined);
    await reporter(1, 2, "half");
    assert.deepEqual(sent, [
        {
            method: "notifications/progress",
            params: { progressToken: "tok-1", progress: 1, total: 2, message: "half" },
        },
    ]);
    const withoutToken = { mcpReq: { notify } } as unknown as ServerContext;
    assert.equal(PenpotMcpServer.progressReporterOf(withoutToken), undefined);
    assert.equal(sent.length, 1);
});

test("a progress notification that is not above the last one of its request is not sent", async () => {
    const sent: Array<{ params: { progress: number } }> = [];
    const notify = async (notification: unknown) => {
        sent.push(notification as { params: { progress: number } });
    };
    const request = { mcpReq: { _meta: { progressToken: "tok-1" }, notify } } as unknown as ServerContext;
    const reporter = PenpotMcpServer.progressReporterOf(request);
    assert.ok(reporter !== undefined);
    for (const progress of [0.5, 0.5, 0.25, 0.75, 1, 1, 2, 1.5, 3]) {
        await reporter(progress, 3);
    }
    assert.deepEqual(
        sent.map((notification) => notification.params.progress),
        [0.5, 0.75, 1, 2, 3]
    );
    // 200 heartbeats of one shape, then the real report of the next: every one is sent
    const beats = Array.from({ length: 200 }, (_, index) => 5 + (index + 1) / (index + 2));
    const heart = PenpotMcpServer.progressReporterOf(request);
    assert.ok(heart !== undefined);
    const before = sent.length;
    for (const progress of [...beats, 6]) {
        await heart(progress, 9);
    }
    assert.equal(sent.length - before, 201);
    // another request starts from nothing
    const other = PenpotMcpServer.progressReporterOf(request);
    assert.ok(other !== undefined);
    await other(0.1);
    assert.equal(sent.length, 207);
});

test("only loopback socket addresses count as local, including the IPv4 form of IPv6", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
        assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of ["10.0.0.5", "203.0.113.9", "::ffff:10.0.0.5", "fe80::1", undefined]) {
        assert.equal(isLoopbackAddress(address), false, String(address));
    }
});
