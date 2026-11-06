import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { GetPageTreeTool } from "./GetPageTreeTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";

/** A server stub whose only job is to return the request session. */
function sessionServer(): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
}

/** A fake backend that accepts every token. */
function acceptingBackend(): FakePenpotBackend {
    return new FakePenpotBackend().respond("mcp-whoami", {
        profileId: "profile-1",
        scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
    });
}

/** Builds the backend services around a fake backend. */
function servicesFor(backend: FakePenpotBackend): BackendServices {
    return new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
}

test("get_page_tree shows circle nodes as ellipse at every depth and keeps other types", async () => {
    const backend = acceptingBackend().respond("get-mcp-page-tree", {
        revn: 1,
        pageId: PAGE,
        root: {
            id: "1b2c3d4e-0000-4000-8000-000000000010",
            type: "frame",
            children: [
                {
                    id: "1b2c3d4e-0000-4000-8000-000000000011",
                    type: "circle",
                    children: [
                        {
                            id: "1b2c3d4e-0000-4000-8000-000000000012",
                            type: "circle",
                            children: [],
                        },
                    ],
                },
                { id: "1b2c3d4e-0000-4000-8000-000000000013", type: "rect", children: [] },
            ],
        },
        truncated: false,
    });
    const tool = new GetPageTreeTool(sessionServer(), servicesFor(backend));

    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        root: {
            type: string;
            children: Array<{ type: string; children: Array<{ type: string }> }>;
        };
    };

    assert.equal(body.root.type, "frame");
    assert.equal(body.root.children[0].type, "ellipse");
    assert.equal(body.root.children[0].children[0].type, "ellipse");
    assert.equal(body.root.children[1].type, "rect");
});
