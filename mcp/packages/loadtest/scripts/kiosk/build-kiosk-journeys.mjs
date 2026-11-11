#!/usr/bin/env node
/**
 * Builds a synthetic kiosk journeys file through the adapter and writes the manifest of what it drew.
 *
 * Usage:
 *   node scripts/kiosk/build-kiosk-journeys.mjs --url http://127.0.0.1:4405/mcp --token-file <file> \
 *     --project-id <uuid> --size 12|207|xl|cliff --seed 1 --out <dir> [--name <file name>] [--layout [browser|synthetic]] [--stop-seconds n]
 *
 * Needs `npx tsc --build` first, because it imports the compiled plan from dist/.
 * The token is read from the file and never printed. A write that answers `mcp-file-busy` or `mcp-lock-timeout`
 * is sent again with the same `requestId`. The script keeps to 9 requests a second (the limit is 10, burst 20).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openClient } from "./kiosk-client.mjs";
import {
    KIOSK_SIZES,
    PAGE_COMPONENTS,
    PAGE_JOURNEYS,
    buildKioskPlan,
    flipChange,
    resolveHandles,
} from "../../dist/KioskJourneys.js";

/**
 * Reads `--name value` pairs and the `--layout` flag.
 *
 * @param {string[]} argv - arguments after the script name
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--layout") {
            // `--layout` alone is the browser; `--layout synthetic` stores estimated runs through raw changes
            args.layout = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "browser";
        } else if (a.startsWith("--")) {
            args[a.slice(2)] = argv[++i];
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["url", "token-file", "project-id", "size", "out"]) {
    if (!args[key]) {
        console.error(`missing --${key}`);
        process.exit(2);
    }
}
if (!(args.size in KIOSK_SIZES)) {
    console.error(`--size must be one of ${Object.keys(KIOSK_SIZES).join(", ")}`);
    process.exit(2);
}
const seed = Number(args.seed ?? 1);
const name = args.name ?? `kiosk-journeys-${args.size}`;
if (!name.startsWith("kiosk-journeys-")) {
    console.error("the file name must start with kiosk-journeys-");
    process.exit(2);
}

const { call, close } = await openClient(args.url, args["token-file"]);

/** Slowest call and totals, for build.json. */
const stats = { writeCalls: 0, slowestMs: 0, slowestLabel: "", callMs: [] };

/**
 * Applies one call of the plan, with handles resolved, and records the ids that the reply maps.
 *
 * @param {string} fileId - file id
 * @param {{label: string, operations: unknown[]}} planned - call of the plan
 * @param {Map<string, string>} ids - table from handle to id, extended with `createdIds`
 */
async function applyCall(fileId, planned, ids) {
    const operations = resolveHandles(planned.operations, ids);
    const result = await call("apply_operations", {
        fileId,
        operations,
        snapshot: false,
        requestId: randomUUID(),
    });
    stats.writeCalls++;
    stats.callMs.push(result.durationMs);
    if (result.durationMs > stats.slowestMs) {
        stats.slowestMs = result.durationMs;
        stats.slowestLabel = planned.label;
    }
    const json = result.json ?? {};
    for (const [handle, id] of Object.entries(json.createdIds ?? {})) {
        ids.set(handle, id);
    }
    return json;
}

const started = performance.now();
const plan = buildKioskPlan(args.size, seed);
console.log(
    `plan ${args.size} seed ${seed}: ${plan.calls.length} calls, ${plan.manifest.totals.journeysShapes} shapes`
);

await mkdir(args.out, { recursive: true });

// the file and its two pages
const created = await call("manage_files", { action: "create_file", projectId: args["project-id"], name });
const fileId = created.json.id;
console.log(`file ${name} ${fileId}`);
const outline = await call("get_file_outline", { fileId });
const firstPage = outline.json.pages[0].id;
const ids = new Map();
const pagesCall = await applyCall(
    fileId,
    {
        label: "pages",
        operations: [
            { op: "update_page", id: firstPage, name: "Components" },
            { op: "create_page", id: "$tmp:journeys", name: "Journeys" },
        ],
    },
    ids
);
const componentsPage = firstPage;
const journeysPage = pagesCall.createdIds["$tmp:journeys"];
ids.set(PAGE_COMPONENTS, componentsPage);
ids.set(PAGE_JOURNEYS, journeysPage);

let revn = pagesCall.revn;
// time of each call against the shapes already on the page, kept for the partial report
const callLog = [];
const stopSeconds = args["stop-seconds"] === undefined ? Infinity : Number(args["stop-seconds"]);
let pageShapes = 0;
let stopped;
for (let i = 0; i < plan.calls.length && stopped === undefined; i++) {
    const planned = plan.calls[i];
    const t0 = performance.now();
    try {
        const json = await applyCall(fileId, planned, ids);
        revn = json.revn ?? revn;
    } catch (error) {
        stopped = {
            reason: "call failed",
            call: i + 1,
            label: planned.label,
            error: String(error.message).slice(0, 600),
        };
        callLog.push({
            call: i + 1,
            label: planned.label,
            shapes: planned.shapes,
            pageShapesBefore: pageShapes,
            ms: Math.round(performance.now() - t0),
            failed: true,
        });
        break;
    }
    const ms = Math.round(performance.now() - t0);
    callLog.push({ call: i + 1, label: planned.label, shapes: planned.shapes, pageShapesBefore: pageShapes, ms });
    pageShapes += planned.shapes;
    console.log(
        `call ${i + 1}/${plan.calls.length} ${planned.label}: ${planned.shapes} shapes, revn ${revn}, ${(ms / 1000).toFixed(1)} s`
    );
    if (ms / 1000 > stopSeconds) {
        stopped = { reason: `a call took longer than ${stopSeconds} s`, call: i + 1, label: planned.label, ms };
    }
}
if (stopped !== undefined) {
    // keep what was learnt: the partial file stays in the project, the report says how far the build got
    const partial = {
        name,
        fileId,
        size: args.size,
        seed,
        stopped,
        shapesWritten: pageShapes,
        callsDone: callLog.length,
        callsPlanned: plan.calls.length,
        callLog,
    };
    await writeFile(path.join(args.out, `${name}.partial.json`), JSON.stringify(partial, null, 2));
    console.log(`STOPPED: ${JSON.stringify(stopped)}; ${pageShapes} shapes written; report in ${name}.partial.json`);
    await close();
    process.exit(3);
}

// flips that apply_operations cannot write
const FLIP_BATCH = 100;
for (let i = 0; i < plan.flips.length; i += FLIP_BATCH) {
    const slice = plan.flips.slice(i, i + FLIP_BATCH);
    const changes = slice.map((spec) => flipChange(spec, ids.get(spec.shape), journeysPage));
    const result = await call("apply_raw_changes", { fileId, changes, snapshot: false, requestId: randomUUID() });
    stats.writeCalls++;
    stats.callMs.push(result.durationMs);
    revn = result.json?.revn ?? revn;
    console.log(`flips ${i + slice.length}/${plan.flips.length}: revn ${revn}`);
}

// does the stored group hold the fault? read the first flipped group back
const manifest = plan.manifest;
let faultReproduced = false;
let faultNote = "no flipped group in this plan";
const groupSpec = plan.flips.find((f) => f.kind === "group");
if (groupSpec !== undefined) {
    const read = await call("export_subtree", { fileId, pageId: journeysPage, rootId: ids.get(groupSpec.shape) });
    const g = (read.json?.shapes ?? []).find((s) => s.id === ids.get(groupSpec.shape));
    const identity =
        g && g.transform && g.transform.a === 1 && g.transform.d === 1 && g.transform.b === 0 && g.transform.c === 0;
    const first = g?.points?.[0];
    faultReproduced = Boolean(g && g.flipX === true && identity && first && first.x > g.points[1].x);
    faultNote = g
        ? `flipX ${g.flipX}, transform identity ${identity}, first point ${JSON.stringify(first)}`
        : "group not found";
}
for (const group of manifest.flips.groups) {
    group.faultReproduced = faultReproduced;
}
console.log(`fault reproduced: ${faultReproduced} (${faultNote})`);

const finalOutline = await call("get_file_outline", { fileId });
const pageList = finalOutline.json.pages;
const journeysEntry = pageList.find((p) => p.id === journeysPage);
const seconds = (performance.now() - started) / 1000;

const truth = resolveHandles(manifest, ids);
truth.file = { id: fileId, name, projectId: args["project-id"] };
truth.pageIds = { components: componentsPage, journeys: journeysPage };
truth.textLayout = null;
await writeFile(path.join(args.out, `${name}.truth.json`), JSON.stringify(truth, null, 2));
const build = {
    name,
    fileId,
    projectId: args["project-id"],
    size: args.size,
    seed,
    pageIds: { components: componentsPage, journeys: journeysPage },
    revn: finalOutline.json.revn,
    counts: {
        screens: manifest.totals.screens,
        plannedJourneysShapes: manifest.totals.journeysShapes,
        journeysShapesInFile: journeysEntry?.shapeCount,
        componentsShapesInFile: pageList.find((p) => p.id === componentsPage)?.shapeCount,
        components: finalOutline.json.components,
    },
    faultReproduced,
    writeCalls: stats.writeCalls,
    slowestCallMs: Math.round(stats.slowestMs),
    slowestCall: stats.slowestLabel,
    secondsTotal: Number(seconds.toFixed(1)),
    callMs: stats.callMs.map((m) => Math.round(m)),
    callLog,
};
const truthPath = path.join(args.out, `${name}.truth.json`);
const buildPath = path.join(args.out, `${name}.build.json`);
await writeFile(buildPath, JSON.stringify(build, null, 2));
console.log(
    `built: ${build.counts.journeysShapesInFile} shapes on Journeys (planned ${build.counts.plannedJourneysShapes}), ` +
        `${build.writeCalls} writes, slowest ${build.slowestCallMs} ms, ${build.secondsTotal} s`
);

// optional text layout through a browser, so that the texts carry positionData as in a real file. The files above
// are already on disk, so a failed layout loses nothing
if (args.layout) {
    let layout;
    if (args.layout === "synthetic") {
        const { syntheticLayout } = await import("./synthetic-layout.mjs");
        layout = await syntheticLayout({ call, fileId, pageId: journeysPage, log: console.log });
    } else {
        const { layoutKiosk } = await import("./layout-file.mjs");
        layout = await layoutKiosk({
            call,
            fileId,
            projectId: args["project-id"],
            journeysPage,
            screenIds: manifest.screens.map((s) => ids.get(s.handle)),
            log: console.log,
        });
    }
    console.log(`layout: ${JSON.stringify(layout)}`);
    truth.textLayout = layout;
    build.layout = layout;
    build.revn = (await call("get_file_outline", { fileId })).json.revn;
    await writeFile(truthPath, JSON.stringify(truth, null, 2));
    await writeFile(buildPath, JSON.stringify(build, null, 2));
}
await close();
console.log("done: build finished");
