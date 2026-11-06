import assert from "node:assert/strict";
import { test } from "node:test";
import { PenpotMcpServer } from "./PenpotMcpServer";

test("a mode implied as both by PENPOT_MCP_BACKEND_URI alone gets a warning that names the cause", () => {
    const warning = PenpotMcpServer.impliedModeWarning({ PENPOT_MCP_BACKEND_URI: "https://penpot.example" });
    assert.ok(warning !== undefined);
    assert.match(warning, /PENPOT_MCP_MODE is not set/);
    assert.match(warning, /PENPOT_MCP_BACKEND_URI/);
});

test("an explicit PENPOT_MCP_MODE gets no warning", () => {
    assert.equal(
        PenpotMcpServer.impliedModeWarning({
            PENPOT_MCP_MODE: "both",
            PENPOT_MCP_BACKEND_URI: "https://penpot.example",
        }),
        undefined
    );
    assert.equal(
        PenpotMcpServer.impliedModeWarning({
            PENPOT_MCP_MODE: "bridge",
            PENPOT_MCP_BACKEND_URI: "https://penpot.example",
        }),
        undefined
    );
});

test("a bridge-only setup, with no backend URI, gets no warning", () => {
    assert.equal(PenpotMcpServer.impliedModeWarning({}), undefined);
    assert.equal(PenpotMcpServer.impliedModeWarning({ PENPOT_MCP_BACKEND_URI: "   " }), undefined);
});
