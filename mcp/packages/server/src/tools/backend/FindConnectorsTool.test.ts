import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { FindConnectorsArgs, FindConnectorsTool } from "./FindConnectorsTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const ARROW = "1b2c3d4e-0000-4000-8000-000000000020";
const BOARD_A = "1b2c3d4e-0000-4000-8000-000000000021";
const BOARD_B = "1b2c3d4e-0000-4000-8000-000000000022";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of find-mcp-connectors
 */
function harness(reply: unknown = { revn: 1, pageId: PAGE, scanned: 0, connectors: [], truncated: false }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("find-mcp-connectors", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new FindConnectorsTool(server, services) };
}

test("find_connectors sends maxDistance and limit when given, and nothing else", async () => {
    const minimal = harness();
    await minimal.tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(
        minimal.backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE }]
    );

    const full = harness();
    await full.tool.execute({ fileId: FILE, pageId: PAGE, maxDistance: 120, limit: 40 });
    assert.deepEqual(
        full.backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, maxDistance: 120, limit: 40 }]
    );
});

test("find_connectors passes the reply through unchanged", async () => {
    const reply = {
        revn: 2,
        pageId: PAGE,
        scanned: 5,
        connectors: [
            {
                id: ARROW,
                name: "Arrow",
                type: "path",
                direction: "cap",
                length: 180,
                from: { boardId: BOARD_A, boardName: "Home", distance: 0, x: 100, y: 50 },
                to: { boardId: BOARD_B, boardName: "Settings", distance: 2.5, x: 280, y: 50 },
            },
        ],
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("the find_connectors schema refuses values outside the bounds", () => {
    const schema = z.object(FindConnectorsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, maxDistance: 0 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, maxDistance: 2000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, maxDistance: -1 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, maxDistance: 2001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 0 }).success, false);
});

test("find_connectors says the ends lie within maxDistance and that to is the head end", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /lie within maxDistance of a different board/);
    assert.match(description, /When direction is cap or shape, to is the head end/);
});

test("find_connectors sends withinId to limit the scan, and describes the section scan", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE, withinId: BOARD_A });
    assert.deepEqual(
        backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, withinId: BOARD_A }]
    );
    const schema = z.object(FindConnectorsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, withinId: BOARD_A }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, withinId: "not-an-id" }).success, false);
    const description = tool.getToolDescription();
    assert.match(description, /withinId \(a shape id\) limits the scan to the shapes under that shape/);
    assert.match(description, /boolean children and hidden shapes are skipped/);
    assert.match(description, /an arrow cap decides the direction only on an open path/);
});
