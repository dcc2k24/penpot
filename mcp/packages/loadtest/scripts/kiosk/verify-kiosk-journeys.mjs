#!/usr/bin/env node
/**
 * Checks a built kiosk journeys file against its truth file, through read tools only.
 *
 * Usage:
 *   node scripts/kiosk/verify-kiosk-journeys.mjs --url http://127.0.0.1:4405/mcp --token-file <file> \
 *     --truth <name>.truth.json [--samples 5]
 *
 * Checks: the shape count of the Journeys page (`get_file_outline`); the section frames, the screens (name, depth,
 * size) and the decision frames and arrows (`get_page_tree`); and, for screens picked by the seed, the shape count of
 * the subtree (`export_subtree`). Exits 1 and prints every difference when something does not match.
 */
import { readFile } from "node:fs/promises";
import { openClient } from "./kiosk-client.mjs";

/**
 * Reads `--name value` pairs.
 *
 * @param {string[]} argv - arguments after the script name
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["url", "token-file", "truth"]) {
    if (!args[key]) {
        console.error(`missing --${key}`);
        process.exit(2);
    }
}
const truth = JSON.parse(await readFile(args.truth, "utf8"));
const fileId = truth.file.id;
const pageId = truth.pageIds.journeys;
const { call, close } = await openClient(args.url, args["token-file"]);
const problems = [];
const note = (text) => problems.push(text);

/**
 * Small seeded generator for picking the sampled screens (mulberry32).
 *
 * @param {number} seed - seed
 */
function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Walks a tree from `get_page_tree`, calling `visit` with each node and its depth (the start shape is depth 1).
 *
 * @param {object} node - tree node
 * @param {number} depth - depth of the node
 * @param {(node: object, depth: number) => void} visit - callback
 */
function walk(node, depth, visit) {
    visit(node, depth);
    for (const child of node.children ?? []) {
        walk(child, depth + 1, visit);
    }
}

/**
 * Reads a tree and fails when the reply was cut.
 *
 * @param {Record<string, unknown>} treeArgs - arguments of `get_page_tree`
 */
async function readTree(treeArgs) {
    const reply = await call("get_page_tree", {
        fileId,
        pageId,
        fields: ["id", "name", "type", "width", "height"],
        limit: 5000,
        ...treeArgs,
    });
    if (reply.json?.truncated) {
        throw new Error(`get_page_tree was cut (${JSON.stringify(treeArgs)}); narrow the request`);
    }
    return reply.json.root;
}

// 1. page shape count
const outline = (await call("get_file_outline", { fileId })).json;
const page = outline.pages.find((p) => p.id === pageId);
if (!page) {
    note(`page ${pageId} is not in the file`);
} else if (page.shapeCount !== truth.totals.journeysShapes) {
    note(`Journeys shape count: file ${page.shapeCount}, manifest ${truth.totals.journeysShapes}`);
}
console.log(`shape count: file ${page?.shapeCount}, manifest ${truth.totals.journeysShapes}`);

// 2. sections and groups, then the screens group by group
const top = await readTree({ depth: 3 });
const sections = top.children ?? [];
const wantSections = truth.sections.map((s) => s.name).sort();
const gotSections = sections.map((s) => s.name).sort();
if (JSON.stringify(wantSections) !== JSON.stringify(gotSections)) {
    note(`section frames: file ${JSON.stringify(gotSections)}, manifest ${JSON.stringify(wantSections)}`);
}
for (const s of truth.sections) {
    if (!sections.some((n) => n.id === s.handle)) {
        note(`section ${s.name} (${s.handle}) is not a child of the page root`);
    }
}
console.log(`sections: ${sections.length}`);

const screens = new Map();
let decisions = 0;
let arrows = 0;
for (const section of sections) {
    for (const group of section.children ?? []) {
        // depth 4 reaches the Parent frames; a Single frame holds its Parent one level further down
        const tree = await readTree({ rootId: group.id, depth: 4 });
        const visit = (node, depth) => {
            if (node.name === "Parent" && node.type === "frame") {
                screens.set(node.id, { depth, width: node.width, height: node.height });
            } else if (node.name === "Decision" && node.type === "frame") {
                decisions++;
            } else if (node.name === "Navigation" && node.type === "path") {
                arrows++;
            }
        };
        const singles = [];
        walk(tree, 2, (node, depth) => {
            visit(node, depth);
            if (node.name === "Single" && node.type === "frame") {
                singles.push({ node, depth });
            }
        });
        for (const { node, depth } of singles) {
            const inner = await readTree({ rootId: node.id, depth: 2 });
            walk(inner, depth, (n, d) => n.id !== node.id && visit(n, d));
        }
    }
}
console.log(`screens: ${screens.size}, decision frames: ${decisions}, arrows: ${arrows}`);
if (screens.size !== truth.screens.length) {
    note(`screen count: file ${screens.size}, manifest ${truth.screens.length}`);
}
for (const s of truth.screens) {
    const found = screens.get(s.handle);
    if (!found) {
        note(`screen ${s.handle} (${s.humanName}) is missing`);
        continue;
    }
    if (found.depth !== s.depth) {
        note(`screen ${s.humanName} ${s.handle}: depth ${found.depth}, manifest ${s.depth}`);
    }
    if (found.width !== 800 || found.height !== 600) {
        note(`screen ${s.humanName} ${s.handle}: size ${found.width}x${found.height}, manifest 800x600`);
    }
}
if (decisions !== truth.decisionFrames.length) {
    note(`decision frames: file ${decisions}, manifest ${truth.decisionFrames.length}`);
}
if (arrows !== truth.connectors.length) {
    note(`arrows (paths named Navigation): file ${arrows}, manifest ${truth.connectors.length}`);
}

// 3. subtree shape counts of screens picked by the seed
const random = rng(truth.seed * 2654435761);
const pool = [...truth.screens];
const samples = Math.min(Number(args.samples ?? 5), pool.length);
const picked = [];
while (picked.length < samples) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
}
for (const s of picked) {
    const reply = await call("export_subtree", { fileId, pageId, rootId: s.handle, limit: 1 });
    const total = reply.json?.total;
    console.log(`subtree ${s.humanName} (${s.view}): file ${total}, manifest ${s.shapes}`);
    if (total !== s.shapes) {
        note(`subtree of ${s.humanName} ${s.handle}: file ${total} shapes, manifest ${s.shapes}`);
    }
}

await close();
if (problems.length > 0) {
    console.error(`\nFAILED: ${problems.length} difference(s)`);
    for (const p of problems.slice(0, 200)) {
        console.error(`  - ${p}`);
    }
    process.exit(1);
}
console.log("\nverify passed");
