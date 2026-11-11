/**
 * Stores estimated `positionData` in every text of the Journeys page that has none, through `apply_raw_changes`.
 * It is the fallback when a browser cannot lay out a page of this size in reasonable time. The runs are estimates
 * (see src/KioskTextLayout.ts), not measurements.
 */
import { randomUUID } from "node:crypto";
import { estimateRuns, needsPositionData, positionDataChange } from "../../dist/KioskTextLayout.js";

/** Changes in one `apply_raw_changes` call. */
const BATCH = 400;

/**
 * Reads the whole page with `export_subtree`, then writes estimated runs into the texts that have none.
 *
 * @param {object} options - settings
 * @param {(tool: string, toolArgs: Record<string, unknown>) => Promise<{json?: any}>} options.call - tool caller
 * @param {string} options.fileId - file id
 * @param {string} options.pageId - id of the Journeys page
 * @param {(line: string) => void} [options.log] - progress lines
 * @returns {Promise<{mode: string, texts: number, written: number, readCalls: number, writeCalls: number, seconds: number}>}
 */
export async function syntheticLayout({ call, fileId, pageId, log = () => {} }) {
    const started = performance.now();
    const pending = [];
    let texts = 0;
    let readCalls = 0;
    let cursor;
    do {
        const reply = await call("export_subtree", { fileId, pageId, ...(cursor ? { cursor } : {}) });
        readCalls++;
        for (const shape of reply.json?.shapes ?? []) {
            if (shape.type === "text") {
                texts++;
                if (needsPositionData(shape)) {
                    const runs = estimateRuns(shape);
                    if (runs.length > 0) {
                        pending.push(positionDataChange(shape.id, pageId, runs));
                    }
                }
            }
        }
        cursor = reply.json?.truncated ? reply.json.nextCursor : undefined;
        if (readCalls % 50 === 0) {
            log(`  synthetic layout: read ${readCalls} windows, ${texts} texts`);
        }
    } while (cursor);
    log(`  synthetic layout: ${texts} texts read, ${pending.length} to write`);
    let writeCalls = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
        await call("apply_raw_changes", {
            fileId,
            changes: pending.slice(i, i + BATCH),
            snapshot: false,
            requestId: randomUUID(),
        });
        writeCalls++;
    }
    return {
        mode: "synthetic",
        texts,
        written: pending.length,
        readCalls,
        writeCalls,
        seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    };
}
