import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { McpAuthentication } from "./McpAuthentication";

/**
 * Serves one authentication handler for the test and runs the callback with its base URL.
 *
 * @param allowQueryToken - the PENPOT_MCP_ALLOW_QUERY_TOKEN policy under test
 * @param run - the requests to make against the endpoint
 */
async function withEndpoint(allowQueryToken: boolean, run: (base: string) => Promise<void>) {
    const auth = new McpAuthentication(undefined, false, allowQueryToken);
    const app = express();
    app.all("/mcp", (req, res) => {
        const result = auth.authenticate(req, res);
        if (!result.isRejected) res.json({ token: result.userToken ?? null });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        await run(`http://127.0.0.1:${address.port}/mcp`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

test("a userToken query parameter is rejected with a JSON 401 when the policy disables it", async () => {
    await withEndpoint(false, async (base) => {
        const response = await fetch(base + "?userToken=alice");
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = (await response.json()) as { error: string; error_description: string };
        assert.equal(body.error, "query_token_disabled");
        assert.match(body.error_description, /Authorization header/);
    });
});

test("the Authorization header still works when the query policy is disabled", async () => {
    await withEndpoint(false, async (base) => {
        const response = await fetch(base, { headers: { Authorization: "Bearer alice" } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { token: "alice" });
    });
});

test("a query parameter next to a header is rejected when the policy disables it", async () => {
    await withEndpoint(false, async (base) => {
        const response = await fetch(base + "?userToken=query", { headers: { Authorization: "Bearer header" } });
        assert.equal(response.status, 401);
    });
});

test("the userToken query parameter is accepted by default", async () => {
    await withEndpoint(true, async (base) => {
        const response = await fetch(base + "?userToken=alice");
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { token: "alice" });
    });
});
