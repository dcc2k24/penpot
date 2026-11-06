import assert from "node:assert/strict";
import { test } from "node:test";
import { ExportConcurrency } from "./ExportConcurrency";

test("the backend export gate allows four concurrent exports by default", () => {
    assert.equal(ExportConcurrency.readBackendMaximum({}), 4);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: " " }), 4);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "junk" }), 4);
});

test("PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS sets the backend export gate, and zero means no limit", () => {
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "7" }), 7);
    assert.equal(ExportConcurrency.readBackendMaximum({ PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS: "0" }), 0);
});

test("the backend gate runs the task and returns its value", async () => {
    assert.equal(await ExportConcurrency.withBackendPermit(async () => 42), 42);
});
