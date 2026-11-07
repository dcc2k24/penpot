import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { ExecuteCodeBackendTool } from "./ExecuteCodeBackendTool";
import { applyToShapes, pageRecords, pageTree, type FakeShape, type Op } from "./ExecuteCodeHarness";

const TOKEN = "carol-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const ROOT = "00000000-0000-0000-0000-000000000000";

/** Every service set of this file, disposed after the last test so that the process exits. */
const allServices: BackendServices[] = [];

/** A server stub whose only job is to return the request session. */
function sessionServer(userToken: string): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
}

/**
 * Builds the tool on a fake backend that accepts every token and echoes the created ids of each write.
 *
 * @param settings - backend settings of the services
 * @returns the fake backend and the tool
 */
function harness(settings: BackendSettings = new BackendSettings()) {
    // the shapes of the fake page; a write adds to them, so a later page read sees what the write created.
    const shapes: FakeShape[] = [];
    // the revn of the fake file, advanced by every write so that page reads report the latest one.
    let revn = 1;
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", {
            contractVersion: 1,
            profileId: "profile-1",
            scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
        })
        .respond("get-mcp-page-tree", () => ({ revn, root: pageTree(shapes), truncated: false }))
        .respond("get-mcp-shapes", (params: object) => {
            const ids = (params as { ids: string[] }).ids;
            const records = pageRecords(shapes);
            return {
                revn,
                shapes: ids.filter((id) => records.has(id)).map((id) => records.get(id)),
                missing: ids.filter((id) => !records.has(id)),
            };
        })
        .respond("mcp-apply-operations", (params: object) => {
            revn += 1;
            const result = applyResult(params, revn) as { createdIds: Record<string, string> };
            applyToShapes(shapes, (params as { operations: Op[] }).operations, result.createdIds);
            return result;
        });
    const services = new BackendServices(backend, settings, new FakeExporterClient());
    allServices.push(services);
    return { backend, tool: new ExecuteCodeBackendTool(sessionServer(TOKEN), services) };
}

/**
 * Answers a write the way the backend does: every temporary handle maps to a fake uuid.
 *
 * @param params - the parameters of the write
 * @param revn - the revn the file has after the write
 * @returns the write result
 */
function applyResult(params: object, revn: number): unknown {
    const operations = (params as { operations: Array<Record<string, unknown>> }).operations;
    const createdIds: Record<string, string> = {};
    for (const operation of operations) {
        const id = operation.id;
        if (typeof id === "string" && id.startsWith("$tmp:")) {
            createdIds[id] = "uuid-" + id.slice("$tmp:".length);
        }
    }
    return { revn, createdIds, warnings: [], changeCount: operations.length };
}

/**
 * Runs a script on the test file.
 *
 * @param tool - the execute_code tool
 * @param code - the script
 * @returns the tool response
 */
function run(tool: ExecuteCodeBackendTool, code: string): Promise<ToolResponse> {
    return tool.execute({ code, fileId: FILE });
}

/**
 * Returns the text of a text response.
 *
 * @param response - the response
 */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/**
 * Returns the operation names of one write, in order.
 *
 * @param params - the parameters of the write
 */
function opNames(params: unknown): string[] {
    return (params as { operations: Array<{ op: string }> }).operations.map((operation) => operation.op);
}

test("a script returns its value and sends one batch with the created ids", async () => {
    const { backend, tool } = harness();
    const response = await run(
        tool,
        `const board = __core.enqueue({ op: "create_board", pageId: "${PAGE}", x: 0, y: 0, width: 100, height: 80 });
         __core.enqueue({ op: "create_rect", pageId: "${PAGE}", parentId: board, x: 0, y: 0, width: 10, height: 10 });
         return board;`
    );
    const body = JSON.parse(textOf(response));
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1);
    assert.deepEqual(opNames(writes[0].params), ["create_board", "create_rect"]);
    assert.equal((writes[0].params as { fileId: string }).fileId, FILE);
    assert.match(body.result, /^\$tmp:/);
    assert.equal(body.createdIds[body.result], "uuid-" + body.result.slice("$tmp:".length));
    assert.equal(body.opsApplied, 2);
    assert.equal(body.flushes, 1);
    assert.equal(body.revn, 2);
});

test("a read after a write in the same script sees the pending change", async () => {
    const { backend, tool } = harness();
    const response = await run(
        tool,
        `const id = __core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 0, y: 0, width: 10, height: 10 });
         __core.enqueue({ op: "update_shape", pageId: "${PAGE}", id: id, props: { x: 10 } });
         return __core.page(__core.fileId(), "${PAGE}").get(id).x;`
    );
    const body = JSON.parse(textOf(response));
    assert.equal(body.result, 10);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1);
    // the update folds into the create op, so the batch holds one op that carries the new x.
    assert.deepEqual(opNames(writes[0].params), ["create_rect"]);
    assert.equal((writes[0].params as { operations: Array<{ x: number }> }).operations[0].x, 10);
});

test("an explicit flush mid-script sends a second batch", async () => {
    const { backend, tool } = harness();
    const response = await run(
        tool,
        `__core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 0, y: 0, width: 10, height: 10 });
         __core.flush();
         __core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 20, y: 0, width: 10, height: 10 });
         return "done";`
    );
    const body = JSON.parse(textOf(response));
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 2);
    assert.deepEqual(
        writes.map((call) => opNames(call.params)),
        [["create_rect"], ["create_rect"]]
    );
    assert.equal(body.flushes, 2);
    assert.equal(body.opsApplied, 2);
});

test("storage keeps its data between calls of the same token", async () => {
    const { tool } = harness();
    await run(tool, "storage.n = 1; return null;");
    const body = JSON.parse(textOf(await run(tool, "return storage.n + 1;")));
    assert.equal(body.result, 2);
});

test("a memory bomb fails, its sandbox is dropped, and the next script runs", async () => {
    const { tool } = harness();
    const services = allServices[allServices.length - 1];
    const text = textOf(await run(tool, "const hoard = []; while (true) { hoard.push(new Array(1000000).fill(7)); }"));
    assert.match(text, /out of memory/);
    assert.equal(services.sandboxes.size, 0);
    const body = JSON.parse(textOf(await run(tool, "return 1 + 1;")));
    assert.equal(body.result, 2);
    assert.equal(services.sandboxes.size, 1);
});

test("console output comes back in the console array", async () => {
    const { tool } = harness();
    const body = JSON.parse(textOf(await run(tool, 'console.log("hi"); return 1;')));
    assert.deepEqual(body.console, ["[LOG] hi"]);
    assert.equal(body.result, 1);
});

test("a backend error reaches the caller with its text", async () => {
    const { backend, tool } = harness();
    backend.fail("mcp-apply-operations", new Error("Backend error validation: bad"));
    const response = await run(
        tool,
        `__core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 0, y: 0, width: 10, height: 10 });
         return "unreachable";`
    );
    assert.match(textOf(response), /Backend error validation: bad/);
});

test("a thrown guest error carries its message and the console output", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'console.log("before"); throw new TypeError("boom");'));
    assert.match(text, /TypeError: boom/);
    assert.match(text, /Console output:/);
    assert.match(text, /\[LOG\] before/);
});

test("more than 5000 operations fail before any backend call", async () => {
    const { backend, tool } = harness();
    const text = textOf(
        await run(
            tool,
            `for (let i = 0; i < 5001; i++) {
                __core.enqueue({ op: "update_shape", pageId: "${PAGE}", id: "R1", props: { x: i } });
             }`
        )
    );
    assert.match(text, /5000 operations/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("an endless script fails with the CPU limit", async () => {
    const saved = process.env.PENPOT_MCP_SANDBOX_TIMEOUT_S;
    process.env.PENPOT_MCP_SANDBOX_TIMEOUT_S = "1";
    let tool: ExecuteCodeBackendTool;
    try {
        tool = harness().tool;
    } finally {
        if (saved === undefined) {
            delete process.env.PENPOT_MCP_SANDBOX_TIMEOUT_S;
        } else {
            process.env.PENPOT_MCP_SANDBOX_TIMEOUT_S = saved;
        }
    }
    const text = textOf(await run(tool, "while (true) {}"));
    assert.match(text, /CPU limit/);
});

/**
 * Sets environment variables while a function runs, and restores their previous values afterwards.
 *
 * @param values - variables to set
 * @param build - function that runs while the variables are set
 * @returns the result of the function
 */
function withEnvironment<T>(values: Record<string, string>, build: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(values)) {
        saved.set(name, process.env[name]);
        process.env[name] = value;
    }
    try {
        return build();
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
}

test("a successful script reports the totals of its write", async () => {
    const { tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `__core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 0, y: 0, width: 10, height: 10 });
                 return "ok";`
            )
        )
    );
    assert.equal(body.result, "ok");
    assert.equal(body.opsApplied, 1);
    assert.equal(body.flushes, 1);
    assert.equal(body.revn, 2);
    assert.equal(Object.keys(body.createdIds).length, 1);
});

test("a failure after a flush reports what was applied before it", async () => {
    const { tool } = harness();
    const text = textOf(
        await run(
            tool,
            `__core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: 0, y: 0, width: 10, height: 10 });
             __core.flush();
             throw new Error("late failure");`
        )
    );
    assert.match(text, /late failure/);
    assert.match(
        text,
        /\n\nApplied before the failure: opsApplied=1, flushes=1, chunks=1, revn=2, createdIds=\{"\$tmp:[^"]+":"uuid-[^"]+"\}$/
    );
});

test("a failure before any write reports no applied writes", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'throw new Error("early failure");'));
    assert.match(text, /early failure/);
    assert.doesNotMatch(text, /Applied before the failure/);
});

test("an endless script fails with the wall-clock limit", async () => {
    const { tool } = withEnvironment({ PENPOT_MCP_SANDBOX_WALL_S: "0.3", PENPOT_MCP_SANDBOX_TIMEOUT_S: "60" }, () =>
        harness()
    );
    const text = textOf(await run(tool, "while (true) {}"));
    assert.match(text, /wall-clock/);
});

test("a script fails when it makes more host calls than allowed", async () => {
    const { tool } = withEnvironment({ PENPOT_MCP_SANDBOX_MAX_HOST_CALLS: "3" }, () => harness());
    // each flush is one host call, so the fourth flush must be refused.
    const text = textOf(
        await run(
            tool,
            `for (let i = 0; i < 5; i++) {
                __core.enqueue({ op: "create_rect", pageId: "${PAGE}", x: i, y: 0, width: 10, height: 10 });
                __core.flush();
             }
             return "unreachable";`
        )
    );
    assert.match(text, /at most 3 host calls/);
});

after(() => {
    for (const services of allServices) {
        services.sandboxes.dispose();
    }
});
