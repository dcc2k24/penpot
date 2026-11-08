// Unit tests for the pure helpers of mixed-version-smoke.mjs. No network is used.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CONTRACT_MISMATCH,
    CONTRACT_MISMATCH_TEXT,
    FAILURE,
    buildOps,
    classifyFailure,
    parseArgs,
    rectName,
    summarizeSteps,
} from "./mixed-version-smoke.mjs";

describe("classifyFailure", () => {
    it("labels the contract refusal as a contract mismatch", () => {
        const text = `Tool execution failed: ${CONTRACT_MISMATCH_TEXT}, it reports contract version none`;
        assert.equal(classifyFailure(text), CONTRACT_MISMATCH);
    });

    it("labels other failures as failure", () => {
        assert.equal(classifyFailure("The MCP token was rejected by the backend."), FAILURE);
        assert.equal(classifyFailure(""), FAILURE);
    });

    it("does not throw on a missing text", () => {
        assert.equal(classifyFailure(undefined), FAILURE);
    });
});

describe("summarizeSteps", () => {
    it("counts passes and failures", () => {
        const summary = summarizeSteps([
            { adapter: "old", step: "whoami", ok: true, durationMs: 5 },
            { adapter: "old", step: "find_shapes", ok: false, durationMs: 7, errorText: "expected 1 match" },
        ]);
        assert.deepEqual(summary, {
            total: 2,
            pass: 1,
            fail: 1,
            contractMismatchCount: 0,
            contractMismatch: false,
        });
    });

    it("flags a contract mismatch on a failed step", () => {
        const summary = summarizeSteps([
            { adapter: "old", step: "whoami", ok: false, durationMs: 3, errorText: CONTRACT_MISMATCH_TEXT },
            { adapter: "new", step: "whoami", ok: true, durationMs: 4 },
        ]);
        assert.equal(summary.contractMismatch, true);
        assert.equal(summary.contractMismatchCount, 1);
        assert.equal(summary.fail, 1);
    });

    it("reports zero for an empty list", () => {
        assert.deepEqual(summarizeSteps([]), {
            total: 0,
            pass: 0,
            fail: 0,
            contractMismatchCount: 0,
            contractMismatch: false,
        });
    });
});

describe("buildOps", () => {
    it("builds one create_rect on the page with the adapter name", () => {
        const ops = buildOps("old", "1700000000000", "page-1");
        assert.equal(ops.length, 1);
        assert.deepEqual(ops[0], {
            op: "create_rect",
            pageId: "page-1",
            name: "mixed-smoke-old-1700000000000",
            x: 100,
            y: 100,
            width: 10,
            height: 10,
        });
    });

    it("uses the same name as rectName", () => {
        assert.equal(buildOps("new", "42", "p")[0].name, rectName("new", "42"));
    });
});

describe("parseArgs", () => {
    it("reads all required options", () => {
        const opts = parseArgs([
            "--old-url",
            "http://localhost:4401/mcp",
            "--new-url",
            "http://localhost:4402/mcp",
            "--token-file",
            "token.txt",
            "--vars",
            "vars.json",
            "--dry-run",
        ]);
        assert.equal(opts.oldUrl, "http://localhost:4401/mcp");
        assert.equal(opts.newUrl, "http://localhost:4402/mcp");
        assert.equal(opts.tokenFile, "token.txt");
        assert.equal(opts.varsFile, "vars.json");
        assert.equal(opts.dryRun, true);
    });

    it("rejects a missing required option", () => {
        assert.throws(() => parseArgs(["--old-url", "http://a/mcp"]), /missing required option/);
    });

    it("rejects an unknown argument", () => {
        assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
    });
});
