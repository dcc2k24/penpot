import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyLimit } from "./BodyLimit";

test("the request body limit defaults to 32 MB", () => {
    assert.equal(BodyLimit.megabytesOf({}), 32);
    assert.equal(BodyLimit.megabytesOf({ PENPOT_MCP_MAX_BODY_MB: "   " }), 32);
    assert.equal(BodyLimit.bytesOf({}), 32 * 1024 * 1024);
});

test("PENPOT_MCP_MAX_BODY_MB sets the request body limit", () => {
    assert.equal(BodyLimit.megabytesOf({ PENPOT_MCP_MAX_BODY_MB: "8" }), 8);
    assert.equal(BodyLimit.bytesOf({ PENPOT_MCP_MAX_BODY_MB: "0.5" }), 512 * 1024);
});

test("a malformed or non-positive PENPOT_MCP_MAX_BODY_MB is a startup error that names the variable", () => {
    for (const value of ["0", "-4", "many"]) {
        assert.throws(() => BodyLimit.megabytesOf({ PENPOT_MCP_MAX_BODY_MB: value }), /PENPOT_MCP_MAX_BODY_MB/);
    }
});
