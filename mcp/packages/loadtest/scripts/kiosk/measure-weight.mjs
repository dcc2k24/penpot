#!/usr/bin/env node
/**
 * Measures the bytes per shape of the Journeys page: the bytes of a full `export_subtree` walk divided by the shapes
 * it returned. With `--sample <n>` it walks n screens picked by the seed instead, which is quicker on a large page
 * and is reported as an estimate.
 *
 * Usage:
 *   node scripts/kiosk/measure-weight.mjs --url <mcp url> --token-file <file> --truth <name>.truth.json [--sample n]
 *
 * Prints one JSON line.
 */
import { readFile } from "node:fs/promises";
import { openClient } from "./kiosk-client.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
for (const key of ["url", "token-file", "truth"]) {
    if (!args[key]) {
        console.error(`missing --${key}`);
        process.exit(2);
    }
}
const truth = JSON.parse(await readFile(args.truth, "utf8"));
const { call, close } = await openClient(args.url, args["token-file"]);
const fileId = truth.file.id;
const pageId = truth.pageIds.journeys;

/**
 * Walks every window of one subtree.
 *
 * @param {string | undefined} rootId - root of the subtree, or undefined for the whole page
 */
async function walkAll(rootId) {
    let cursor;
    const total = { bytes: 0, shapes: 0, calls: 0, texts: 0, textsWithPositionData: 0 };
    do {
        const reply = await call("export_subtree", {
            fileId,
            pageId,
            ...(rootId ? { rootId } : {}),
            ...(cursor ? { cursor } : {}),
        });
        total.bytes += reply.bytes;
        total.calls++;
        const shapes = reply.json?.shapes ?? [];
        total.shapes += shapes.length;
        for (const shape of shapes) {
            if (shape.type === "text") {
                total.texts++;
                if (Array.isArray(shape.positionData) && shape.positionData.length > 0) {
                    total.textsWithPositionData++;
                }
            }
        }
        cursor = reply.json?.truncated ? reply.json.nextCursor : undefined;
    } while (cursor);
    return total;
}

const started = performance.now();
let result;
if (args.sample) {
    const step = Math.max(1, Math.floor(truth.screens.length / Number(args.sample)));
    const picked = truth.screens.filter((_s, i) => i % step === 0).slice(0, Number(args.sample));
    const sum = { bytes: 0, shapes: 0, calls: 0, texts: 0, textsWithPositionData: 0 };
    for (const s of picked) {
        const t = await walkAll(s.handle);
        for (const k of Object.keys(sum)) {
            sum[k] += t[k];
        }
    }
    result = { mode: `sample of ${picked.length} screens`, ...sum };
} else {
    result = { mode: "full walk", ...(await walkAll(undefined)) };
}
result.bytesPerShape = Math.round(result.bytes / result.shapes);
result.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
console.log(JSON.stringify(result));
await close();
