import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakePenpotBackend, type RecordedCall } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FindShapesArgs, FindShapesTool } from "./FindShapesTool";
import { GetPageTreeTool } from "./GetPageTreeTool";
import { GetShapesTool } from "./GetShapesTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000005";

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

/** Returns the parameters of the one command call with the given name. */
function onlyParams(backend: FakePenpotBackend, name: string): Record<string, unknown> {
    const calls: RecordedCall[] = backend.callsTo(name);
    assert.equal(calls.length, 1, `${name} is called once`);
    return calls[0].params as Record<string, unknown>;
}

const findSchema = z.object(FindShapesArgs.schema);

test("find_shapes sends hasToken as a boolean", async () => {
    const backend = acceptingBackend().respond("find-mcp-shapes", { matches: [] });
    const tool = new FindShapesTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, hasToken: true });
    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, hasToken: true });

    backend.calls.length = 0;
    await tool.execute({ fileId: FILE, hasToken: false });
    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, hasToken: false });
});

test("the find_shapes schema accepts hasToken only as a boolean", () => {
    assert.equal(findSchema.safeParse({ fileId: FILE, hasToken: true }).success, true);
    assert.equal(findSchema.safeParse({ fileId: FILE, hasToken: "some-token" }).success, false);
});

test("the find_shapes schema rejects a color of 33 characters and accepts one of 32", () => {
    assert.equal(findSchema.safeParse({ fileId: FILE, colors: [`#${"a".repeat(32)}`] }).success, false);
    assert.equal(findSchema.safeParse({ fileId: FILE, colors: ["a".repeat(32)] }).success, true);
});

test("the find_shapes schema rejects more than 50 colors", () => {
    const colors = Array.from({ length: 51 }, () => "#ff0000");
    assert.equal(findSchema.safeParse({ fileId: FILE, colors }).success, false);
});

test("get_page_tree sends camelCase fields in kebab-case", async () => {
    const backend = acceptingBackend().respond("get-mcp-page-tree", { nodes: [] });
    const tool = new GetPageTreeTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, pageId: PAGE, fields: ["id", "parentId", "component-root", "frameId"] });

    assert.deepEqual(onlyParams(backend, "get-mcp-page-tree").fields, [
        "id",
        "parent-id",
        "component-root",
        "frame-id",
    ]);
});

test("get_shapes sends camelCase fields in kebab-case", async () => {
    const backend = acceptingBackend().respond("get-mcp-shapes", { shapes: [], missing: [] });
    const tool = new GetShapesTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, pageId: PAGE, ids: [SHAPE], fields: ["parentId", "x", "shape-ref"] });

    assert.deepEqual(onlyParams(backend, "get-mcp-shapes").fields, ["parent-id", "x", "shape-ref"]);
});

test("get_shapes sends no fields when none are given", async () => {
    const backend = acceptingBackend().respond("get-mcp-shapes", { shapes: [], missing: [] });
    const tool = new GetShapesTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, pageId: PAGE, ids: [SHAPE] });

    assert.equal("fields" in onlyParams(backend, "get-mcp-shapes"), false);
});

test("get_shapes shows a backend circle as an ellipse and leaves other types alone", async () => {
    const backend = acceptingBackend().respond("get-mcp-shapes", {
        shapes: [
            { id: SHAPE, type: "circle", name: "Ellipse" },
            { id: "1b2c3d4e-0000-4000-8000-000000000006", type: "rect", name: "Rectangle" },
        ],
        missing: [],
    });
    const tool = new GetShapesTool(sessionServer(), servicesFor(backend));

    const response = await tool.execute({ fileId: FILE, pageId: PAGE, ids: [SHAPE] });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        shapes: Array<{ type: string }>;
        missing: string[];
    };

    assert.deepEqual(
        body.shapes.map((shape) => shape.type),
        ["ellipse", "rect"]
    );
    assert.deepEqual(body.missing, []);
});

test("find_shapes sends the ellipse type as circle and shows circle matches as ellipse", async () => {
    const backend = acceptingBackend().respond("find-mcp-shapes", {
        matches: [{ id: SHAPE, pageId: PAGE, name: "Ellipse", type: "circle", path: "Ellipse" }],
        truncated: false,
    });
    const tool = new FindShapesTool(sessionServer(), servicesFor(backend));

    const response = await tool.execute({ fileId: FILE, type: "ellipse" });

    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, type: "circle" });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        matches: Array<{ type: string }>;
    };
    assert.deepEqual(
        body.matches.map((match) => match.type),
        ["ellipse"]
    );
});

test("find_shapes type board sends frame to the backend and shows frame matches as frame", async () => {
    const backend = acceptingBackend().respond("find-mcp-shapes", {
        matches: [{ id: SHAPE, pageId: PAGE, name: "Board", type: "frame", path: "Board" }],
        truncated: false,
    });
    const tool = new FindShapesTool(sessionServer(), servicesFor(backend));

    const response = await tool.execute({ fileId: FILE, type: "board" });

    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, type: "frame" });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        matches: Array<{ type: string }>;
    };
    assert.deepEqual(
        body.matches.map((match) => match.type),
        ["frame"]
    );
});

test("find_shapes passes the frame type through unchanged", async () => {
    const backend = acceptingBackend().respond("find-mcp-shapes", { matches: [], truncated: false });
    const tool = new FindShapesTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, type: "frame" });

    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, type: "frame" });
});

test("find_shapes passes the circle type through unchanged", async () => {
    const backend = acceptingBackend().respond("find-mcp-shapes", { matches: [], truncated: false });
    const tool = new FindShapesTool(sessionServer(), servicesFor(backend));

    await tool.execute({ fileId: FILE, type: "circle" });

    assert.deepEqual(onlyParams(backend, "find-mcp-shapes"), { fileId: FILE, type: "circle" });
});
