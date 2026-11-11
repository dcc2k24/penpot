import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { GetFileOutlineTool } from "./GetFileOutlineTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of get-mcp-file-outline
 */
function harness(reply: unknown = { id: FILE, revn: 1, pages: [], warnings: [] }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-file-outline", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new GetFileOutlineTool(server, services) };
}

test("get_file_outline passes the font warning fields through", async () => {
    const reply = {
        id: FILE,
        revn: 4,
        pages: [],
        warnings: [
            {
                kind: "font-unresolved",
                fontId: "gfont-access-sans",
                family: "Access Sans",
                reason: "not-in-google-catalog",
                pageId: PAGE,
                runs: 3,
                suggestedFontId: "custom-1b2c3d4e",
                suggestedFamily: "Access Sans Bold",
            },
        ],
        warningsTruncated: false,
        warningsComplete: false,
        warningsPendingPages: [{ pageId: PAGE, shapeCount: 9000, reason: "page-too-large" }],
        warningsPendingTruncated: false,
        warningsCompleteWith: "list_fonts",
    };
    const { backend, tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
    assert.deepEqual(
        backend.callsTo("get-mcp-file-outline").map((call) => call.params),
        [{ fileId: FILE }]
    );
});

test("get_file_outline describes the pending pages, the completing tool and the suggestions", () => {
    const description = harness().tool.getToolDescription();
    assert.match(description, /warningsPendingPages/);
    assert.match(description, /warningsPendingTruncated/);
    assert.match(description, /warningsCompleteWith/);
    assert.match(description, /call list_fonts for the file/);
    assert.match(description, /list_fonts reply that is not truncated is the complete font report/);
    assert.match(description, /do not call the outline again/);
    assert.match(description, /fast first look/);
    assert.match(description, /several backend processes they may stay incomplete after list_fonts/);
    assert.match(description, /suggestedFontId and suggestedFamily/);
});
