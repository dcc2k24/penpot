import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildTargetsJson,
    defaultAppBrowser,
    dockerArgs,
    newRunId,
    parseAppBrowser,
    workerPaths,
    workerSource,
    type ShotRequest,
} from "./Screenshots.js";

/**
 * Builds a request with the given index and the other fields set to typical values.
 *
 * @param index - position of the request in the run
 */
function request(index: number): ShotRequest {
    return { index, route: "/onboarding/welcome", nodeId: "board-1", scale: 2, expand: 1 };
}

describe("parseAppBrowser", () => {
    it("accepts local and a docker container name", () => {
        assert.deepEqual(parseAppBrowser("local"), { mode: "local" });
        assert.deepEqual(parseAppBrowser("docker:penpot-mcp-exporter"), {
            mode: "docker",
            container: "penpot-mcp-exporter",
        });
    });

    it("rejects an empty container name and an unknown mode, and names the value", () => {
        assert.throws(() => parseAppBrowser("docker:"), /docker:/);
        assert.throws(() => parseAppBrowser("remote:x"), /remote:x/);
        assert.throws(() => parseAppBrowser("docker:my container"), /docker:my container/);
    });
});

describe("defaultAppBrowser", () => {
    it("uses the exporter container when it runs, else the local browser", () => {
        assert.deepEqual(defaultAppBrowser(true), { mode: "docker", container: "penpot-mcp-exporter" });
        assert.deepEqual(defaultAppBrowser(false), { mode: "local" });
    });
});

describe("buildTargetsJson", () => {
    it("writes valid JSON with the base URL and the requests", () => {
        const parsed = JSON.parse(buildTargetsJson("http://host.docker.internal:5173", [request(0), request(1)]));
        assert.equal(parsed.baseUrl, "http://host.docker.internal:5173");
        assert.equal(parsed.requests.length, 2);
        assert.deepEqual(parsed.requests[1], request(1));
    });

    it("rejects a scale of 4", () => {
        assert.throws(() => buildTargetsJson("http://h", [{ ...request(0), scale: 4 }]), /scale/);
    });

    it("rejects a duplicate index", () => {
        assert.throws(() => buildTargetsJson("http://h", [request(3), request(3)]), /duplicate request index 3/);
    });

    it("rejects a negative expand", () => {
        assert.throws(() => buildTargetsJson("http://h", [{ ...request(0), expand: -1 }]), /expand/);
    });
});

describe("workerPaths", () => {
    it("builds the paths of the run folder inside the container", () => {
        assert.deepEqual(workerPaths("r1"), {
            dir: "/tmp/design-parity/r1",
            script: "/tmp/design-parity/r1/worker.mjs",
            targets: "/tmp/design-parity/r1/targets.json",
            out: "/tmp/design-parity/r1/out",
        });
    });
});

describe("dockerArgs", () => {
    it("returns the exact docker argument arrays", () => {
        const paths = workerPaths("r1");
        const commands = dockerArgs("c1", paths, "C:/local/worker.mjs", "C:/local/targets.json", "C:/local");
        assert.deepEqual(commands.mkdir, ["exec", "c1", "mkdir", "-p", "/tmp/design-parity/r1"]);
        assert.deepEqual(commands.copyScript, ["cp", "C:/local/worker.mjs", "c1:/tmp/design-parity/r1/worker.mjs"]);
        assert.deepEqual(commands.copyTargets, [
            "cp",
            "C:/local/targets.json",
            "c1:/tmp/design-parity/r1/targets.json",
        ]);
        assert.deepEqual(commands.exec, [
            "exec",
            "c1",
            "node",
            "/tmp/design-parity/r1/worker.mjs",
            "/tmp/design-parity/r1/targets.json",
            "/tmp/design-parity/r1/out",
        ]);
        assert.deepEqual(commands.copyOut, ["cp", "c1:/tmp/design-parity/r1/out", "C:/local"]);
        assert.deepEqual(commands.cleanup, ["exec", "c1", "rm", "-rf", "/tmp/design-parity/r1"]);
    });
});

describe("workerSource", () => {
    it("contains the browser flags, the scale, the fonts wait, the Playwright path and the result file", () => {
        const source = workerSource();
        assert.ok(source.includes("--disable-lcd-text"));
        assert.ok(source.includes("deviceScaleFactor"));
        assert.ok(source.includes("document.fonts.ready"));
        assert.ok(source.includes("/opt/penpot/exporter/node_modules/playwright/index.mjs"));
        assert.ok(source.includes("result.json"));
    });

    it("uses the pixel viewport of the compare", () => {
        assert.ok(workerSource().includes("width: 1456, height: 916"));
    });
});

describe("newRunId", () => {
    it("gives a different id on each call", () => {
        assert.notEqual(newRunId(), newRunId());
    });
});
