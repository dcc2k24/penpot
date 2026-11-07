import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxWorkerRuntime } from "./SandboxWorkerRuntime";

/** The build output directory of the server package. */
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

test("a build that emits the server bundle also emits the sandbox worker next to it", (t) => {
    if (!existsSync(`${DIST}index.js`)) {
        t.skip("no bundle in dist/; run the build first");
        return;
    }
    assert.equal(
        existsSync(`${DIST}${SandboxWorkerRuntime.ENTRY_NAME}.js`),
        true,
        `dist/${SandboxWorkerRuntime.ENTRY_NAME}.js is missing, so a bundled server would run guests on the main thread`
    );
});
