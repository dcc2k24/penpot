import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { RATE_LIMIT_RETRIES } from "../McpSession.js";
import { callWithRetry } from "./McpExport.js";

/**
 * Builds a tool result with one text block.
 *
 * @param text - text of the block
 * @param isError - whether the tool reported an error
 */
function resultOf(text: string, isError = false): CallToolResult {
    return { content: [{ type: "text", text }], isError } as CallToolResult;
}

const RATE_TEXT = "Tool execution failed: RateLimitError: rate limited, retry after 1 s";

describe("callWithRetry for export_shape", () => {
    it("repeats a rate-limited export after the wait it names", async () => {
        const waits: number[] = [];
        let calls = 0;
        const result = await callWithRetry(
            async () => {
                calls++;
                return calls <= 2 ? resultOf(RATE_TEXT, true) : resultOf("ok");
            },
            async (ms) => {
                waits.push(ms);
            }
        );
        assert.equal(calls, 3);
        assert.deepEqual(waits, [1000, 1000]);
        assert.equal(result.isError, false);
    });

    it("stops repeating after the rate-limit retries and returns the last result", async () => {
        let calls = 0;
        const result = await callWithRetry(
            async () => {
                calls++;
                return resultOf(RATE_TEXT, true);
            },
            async () => {}
        );
        assert.equal(calls, RATE_LIMIT_RETRIES + 1);
        assert.equal(result.isError, true);
    });

    it("retries a rejected call on the backoff schedule", async () => {
        const waits: number[] = [];
        let calls = 0;
        const result = await callWithRetry(
            async () => {
                calls++;
                if (calls === 1) {
                    throw new Error("socket closed");
                }
                return resultOf("ok");
            },
            async (ms) => {
                waits.push(ms);
            }
        );
        assert.equal(calls, 2);
        assert.deepEqual(waits, [2000]);
        assert.equal(result.isError, false);
    });
});
