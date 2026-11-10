import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { FindSimilarBoardsArgs, FindSimilarBoardsTool } from "./FindSimilarBoardsTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const BOARD_A = "1b2c3d4e-0000-4000-8000-000000000050";
const BOARD_B = "1b2c3d4e-0000-4000-8000-000000000051";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of find-mcp-similar-boards
 */
function harness(reply: unknown = { revn: 1, pageId: PAGE, boards: 0, groups: [], truncated: false }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("find-mcp-similar-boards", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new FindSimilarBoardsTool(server, services) };
}

test("find_similar_boards sends only the file and page when nothing else is given", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(
        backend.callsTo("find-mcp-similar-boards").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE }]
    );
});

test("find_similar_boards sends every argument that is given, under its camelCase name", async () => {
    const { backend, tool } = harness();
    await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        depth: 3,
        boardNameRegex: "^Card",
        threshold: 0.75,
        minShapes: 4,
        limit: 20,
    });
    assert.deepEqual(
        backend.callsTo("find-mcp-similar-boards").map((call) => call.params),
        [
            {
                fileId: FILE,
                pageId: PAGE,
                depth: 3,
                boardNameRegex: "^Card",
                threshold: 0.75,
                minShapes: 4,
                limit: 20,
            },
        ]
    );
});

test("find_similar_boards passes the groups through unchanged", async () => {
    const reply = {
        revn: 5,
        pageId: PAGE,
        boards: 2,
        groups: [
            {
                similarity: 1,
                exact: true,
                boards: [
                    { id: BOARD_A, name: "Card 1", path: "Cards / Card 1", shapeCount: 6 },
                    { id: BOARD_B, name: "Card 2", path: "Cards / Card 2", shapeCount: 6 },
                ],
            },
        ],
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("the find_similar_boards schema refuses values outside the bounds", () => {
    const schema = z.object(FindSimilarBoardsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, threshold: 0.5 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, threshold: 1 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, threshold: 0.49 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, threshold: 1.01 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 0 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 1000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 1001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 6 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 500 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 501 }).success, false);
});

test("find_similar_boards says truncated also covers more groups than limit", () => {
    const { tool } = harness();
    assert.match(tool.getToolDescription(), /more groups than limit/);
});

test("find_similar_boards passes compared through and names it with truncated in the description", async () => {
    const reply = { revn: 6, pageId: PAGE, boards: 3, compared: 3, groups: [], truncated: true };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
    assert.match(tool.getToolDescription(), /compared the number of pairs whose similarity was computed/);
    assert.match(tool.getToolDescription(), /truncated true means more than 1000 boards/);
});
