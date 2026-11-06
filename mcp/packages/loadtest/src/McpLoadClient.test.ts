import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { McpLoadClient } from "./McpLoadClient.js";
import { StubMcpServer } from "./testing/StubMcpServer.js";

const stub = new StubMcpServer();
let url = "";

before(async () => {
    url = await stub.start();
});

after(async () => {
    await stub.stop();
});

test("a tool result with isError is reported as an error", async () => {
    const client = new McpLoadClient();
    await client.connect(url, "agent-token");
    try {
        const outcome = await client.callTool("fail_tool", { reason: "stub" });
        assert.equal(outcome.isError, true);
        assert.equal(outcome.ok, false);
        assert.match(outcome.text, /^Tool execution failed: stub/);
    } finally {
        await client.close();
    }
});

test("a successful tool result is not an error", async () => {
    const client = new McpLoadClient();
    await client.connect(url, "agent-token");
    try {
        const outcome = await client.callTool("whoami", {});
        assert.equal(outcome.isError, false);
        assert.equal(outcome.ok, true);
        assert.deepEqual(outcome.json, { profileId: "stub-profile" });
    } finally {
        await client.close();
    }
});
