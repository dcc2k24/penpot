import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { GetInteractionsArgs, GetInteractionsTool } from "./GetInteractionsTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000010";
const FRAME = "1b2c3d4e-0000-4000-8000-000000000011";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of get-mcp-interactions
 */
function harness(reply: unknown = { revn: 1, pageId: PAGE, flows: [], shapes: [], totalInteractions: 0 }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-interactions", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new GetInteractionsTool(server, services) };
}

test("get_interactions sends the command with its arguments, and limit only when given", async () => {
    const minimal = harness();
    await minimal.tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(
        minimal.backend.callsTo("get-mcp-interactions").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE }]
    );

    const full = harness();
    await full.tool.execute({ fileId: FILE, pageId: PAGE, limit: 25 });
    assert.deepEqual(
        full.backend.callsTo("get-mcp-interactions").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, limit: 25 }]
    );
});

test("get_interactions passes the reply through unchanged", async () => {
    const reply = {
        revn: 4,
        pageId: PAGE,
        flows: [{ id: SHAPE, name: "Start", startingFrame: FRAME, startingFrameName: "Home" }],
        shapes: [
            {
                id: SHAPE,
                name: "Button",
                type: "rect",
                frameId: FRAME,
                path: "Home / Button",
                interactions: [{ action: { destination: FRAME, destinationName: "Home" } }],
            },
        ],
        totalInteractions: 1,
        totalShapes: 1,
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("the get_interactions schema refuses a limit outside 1 to 5000", () => {
    const schema = z.object(GetInteractionsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 1 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 5000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 0 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 5001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: "not-a-uuid" }).success, false);
});

test("get_interactions shows a circle shape as ellipse and keeps a frame as frame", async () => {
    const reply = {
        revn: 4,
        pageId: PAGE,
        flows: [],
        shapes: [
            { id: SHAPE, name: "Dot", type: "circle", frameId: FRAME, path: "Home / Dot", interactions: [] },
            { id: FRAME, name: "Home", type: "frame", frameId: FRAME, path: "Home", interactions: [] },
        ],
        totalInteractions: 0,
        totalShapes: 2,
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        shapes: Array<{ id: string; type: string }>;
    };
    assert.deepEqual(
        body.shapes.map((shape) => [shape.id, shape.type]),
        [
            [SHAPE, "ellipse"],
            [FRAME, "frame"],
        ]
    );
});
