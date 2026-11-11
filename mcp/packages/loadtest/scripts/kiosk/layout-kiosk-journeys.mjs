#!/usr/bin/env node
/**
 * Lays out the texts of an already built kiosk file: opens it in a headless browser, which computes each text's
 * runs, and waits until Penpot has saved them (`positionData`). Writes the outcome into the truth and build files.
 *
 * Usage:
 *   PENPOT_HUMAN_PASSWORD_FILE=<file> node scripts/kiosk/layout-kiosk-journeys.mjs --url <mcp url> \
 *     --token-file <file> --truth <name>.truth.json [--mode browser|synthetic] [--timeout-min 30]
 *
 * The password of the test account comes from the environment and is never printed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { openClient } from "./kiosk-client.mjs";
import { layoutKiosk } from "./layout-file.mjs";
import { syntheticLayout } from "./synthetic-layout.mjs";

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
let layout;
if (args.mode === "synthetic") {
    layout = await syntheticLayout({ call, fileId: truth.file.id, pageId: truth.pageIds.journeys, log: console.log });
} else {
    layout = await layoutKiosk({
        call,
        fileId: truth.file.id,
        projectId: truth.file.projectId,
        journeysPage: truth.pageIds.journeys,
        screenIds: truth.screens.map((s) => s.handle),
        timeoutMs: Number(args["timeout-min"] ?? 30) * 60 * 1000,
        log: console.log,
    });
}
console.log(`layout: ${JSON.stringify(layout)}`);
truth.textLayout = layout;
await writeFile(args.truth, JSON.stringify(truth, null, 2));
const buildPath = args.truth.replace(/\.truth\.json$/, ".build.json");
try {
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.layout = layout;
    build.revn = (await call("get_file_outline", { fileId: truth.file.id })).json.revn;
    await writeFile(buildPath, JSON.stringify(build, null, 2));
} catch (error) {
    console.log(`build file not updated: ${error.message}`);
}
await close();
process.exit(layout.done === false ? 1 : 0);
