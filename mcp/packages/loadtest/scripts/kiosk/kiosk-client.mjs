/**
 * Shared client of the kiosk scripts: an MCP session that keeps to the rate limit and sends a failed call again.
 * The token is read from a file and never printed.
 */
import { readFile } from "node:fs/promises";
import { McpLoadClient } from "../../dist/McpLoadClient.js";
import { isRateLimitError, isRetryableWriteError } from "../../dist/KioskJourneys.js";

/**
 * Waits for a number of milliseconds.
 *
 * @param {number} ms - time to wait
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a session. Calls go through a token bucket of 9 requests a second with a burst of 18, under the server
 * limit of 10 and 20.
 *
 * @param {string} url - MCP URL of the adapter
 * @param {string} tokenFile - path of a file that holds the MCP token
 * @param {(line: string) => void} [log] - receives retry notes
 */
export async function openClient(url, tokenFile, log = console.log) {
    const token = (await readFile(tokenFile, "utf8")).trim();
    const client = new McpLoadClient();
    await client.connect(url, token);
    const bucket = { tokens: 18, last: performance.now() };
    const takeToken = async () => {
        for (;;) {
            const now = performance.now();
            bucket.tokens = Math.min(18, bucket.tokens + ((now - bucket.last) / 1000) * 9);
            bucket.last = now;
            if (bucket.tokens >= 1) {
                bucket.tokens -= 1;
                return;
            }
            await sleep(Math.ceil(((1 - bucket.tokens) / 9) * 1000));
        }
    };
    return {
        /**
         * Calls a tool. A failure is retried, with the same arguments and so the same `requestId`, when the file was
         * busy, a lock timed out, the rate limit answered, or the connection dropped. Up to eight tries.
         *
         * @param {string} tool - tool name
         * @param {Record<string, unknown>} toolArgs - arguments
         */
        async call(tool, toolArgs) {
            let last;
            for (let attempt = 1; attempt <= 8; attempt++) {
                await takeToken();
                last = await client.callTool(tool, toolArgs, 20 * 60 * 1000);
                if (last.ok) {
                    return last;
                }
                const text = `${last.text} ${last.error ?? ""}`;
                const retry =
                    isRetryableWriteError(text) || isRateLimitError(text) || (last.error !== undefined && attempt < 3);
                if (!retry) {
                    break;
                }
                log(`  retry ${attempt} of ${tool}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
                await sleep(1500 * attempt);
            }
            throw new Error(`${tool} failed: ${(last.text || last.error || "").slice(0, 600)}`);
        },
        close: () => client.close(),
    };
}
