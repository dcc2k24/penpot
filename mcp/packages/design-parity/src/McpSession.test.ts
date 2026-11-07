import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallOutcome } from "mcp-loadtest/dist/McpLoadClient.js";
import {
    DEFAULT_RATE_WAIT_MS,
    McpSession,
    McpToolError,
    RATE_LIMIT_RETRIES,
    rateLimitWaitOf,
    type ToolClient,
} from "./McpSession.js";

const RATE_TEXT = "Tool execution failed: RateLimitError: rate limited, retry after 1 s";

/**
 * Builds the outcome of one fake call.
 *
 * @param text - text of the result
 * @param isError - whether the tool reported an error
 * @param json - parsed value of a successful result
 */
function outcomeOf(text: string, isError: boolean, json?: unknown): ToolCallOutcome {
    return { durationMs: 1, ok: !isError, text, isError, bytes: text.length, json };
}

/**
 * A fake MCP client. The script decides the outcome of each call, from the number of the call (1 for the first).
 */
class FakeClient implements ToolClient {
    readonly names: string[] = [];

    constructor(private readonly script: (call: number) => ToolCallOutcome) {}

    async connect(): Promise<void> {}

    async callTool(name: string): Promise<ToolCallOutcome> {
        this.names.push(name);
        return this.script(this.names.length);
    }

    async close(): Promise<void> {}
}

/**
 * Creates a session on a fake client, and records every wait instead of sleeping.
 *
 * @param client - the fake client
 */
function sessionOn(client: FakeClient): { session: McpSession; waits: number[] } {
    const waits: number[] = [];
    const session = new McpSession("http://fake.test/mcp", "token", {
        createClient: () => client,
        wait: async (ms) => {
            waits.push(ms);
        },
    });
    return { session, waits };
}

describe("rateLimitWaitOf", () => {
    it("reads the seconds that the adapter names", () => {
        assert.equal(rateLimitWaitOf(RATE_TEXT), 1000);
        assert.equal(rateLimitWaitOf("RateLimitError: rate limited, retry after 2.5 s"), 2500);
    });

    it("reads a wait in milliseconds", () => {
        assert.equal(rateLimitWaitOf("rate limited, retry after 300 ms"), 300);
    });

    it("waits one second when the text names no time", () => {
        assert.equal(rateLimitWaitOf("RateLimitError: rate limited"), DEFAULT_RATE_WAIT_MS);
    });

    it("returns undefined for text that is not a rate-limit error", () => {
        assert.equal(rateLimitWaitOf("Tool execution failed: validation failed"), undefined);
    });
});

describe("McpSession rate limits", () => {
    it("retries a rate-limited call after the wait it names, even for a write that does not retry", async () => {
        const client = new FakeClient((call) =>
            call <= 2 ? outcomeOf(RATE_TEXT, true) : outcomeOf('{"revn":3}', false, { revn: 3 })
        );
        const { session, waits } = sessionOn(client);
        const result = await session.call("apply_operations", {}, { retryTransient: false });
        assert.deepEqual(result.json, { revn: 3 });
        assert.equal(client.names.filter((name) => name === "apply_operations").length, 3);
        assert.deepEqual(waits, [1000, 1000]);
    });

    it("gives up after the rate-limit retries", async () => {
        const client = new FakeClient(() => outcomeOf(RATE_TEXT, true));
        const { session, waits } = sessionOn(client);
        await assert.rejects(
            () => session.call("get_shapes", {}),
            (error: unknown) => error instanceof McpToolError && /rate limited/.test(error.message)
        );
        assert.equal(client.names.filter((name) => name === "get_shapes").length, RATE_LIMIT_RETRIES + 1);
        assert.equal(waits.length, RATE_LIMIT_RETRIES);
    });

    it("keeps the backoff of transient failures separate from the rate-limit wait", async () => {
        const client = new FakeClient((call) =>
            call === 1 ? outcomeOf("Tool execution failed: got no response", true) : outcomeOf("{}", false, {})
        );
        const { session, waits } = sessionOn(client);
        await session.call("get_shapes", {});
        assert.deepEqual(waits, [2000]);
    });

    it("does not retry a rejected request", async () => {
        const client = new FakeClient(() => outcomeOf("Tool execution failed: invalid argument", true));
        const { session, waits } = sessionOn(client);
        await assert.rejects(() => session.call("get_shapes", {}), /invalid argument/);
        assert.equal(client.names.length, 1);
        assert.deepEqual(waits, []);
    });
});
