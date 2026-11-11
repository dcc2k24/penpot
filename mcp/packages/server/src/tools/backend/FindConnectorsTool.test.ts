import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { BackendTool } from "./BackendTool";
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
    assert.match(description, /lie within maxDistance of a different frame/);
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

test("find_connectors sends the screen selection and includeSameScreen when given", async () => {
    const { backend, tool } = harness();
    await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        depth: 3,
        mode: "depth",
        boardNameRegex: "^Screen",
        includeSameScreen: true,
    });
    assert.deepEqual(
        backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, depth: 3, mode: "depth", boardNameRegex: "^Screen", includeSameScreen: true }]
    );
    const auto = harness();
    await auto.tool.execute({ fileId: FILE, pageId: PAGE, mode: "auto", includeSameScreen: false });
    assert.deepEqual(
        auto.backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, mode: "auto", includeSameScreen: false }]
    );
});

test("the find_connectors schema has the ranges and refusals of lint_page", () => {
    const schema = z.object(FindConnectorsArgs.schema);
    const base = { fileId: FILE, pageId: PAGE };
    assert.equal(schema.safeParse({ ...base, depth: 1 }).success, true);
    assert.equal(schema.safeParse({ ...base, depth: 12 }).success, true);
    assert.equal(schema.safeParse({ ...base, depth: 0 }).success, false);
    assert.equal(schema.safeParse({ ...base, depth: 13 }).success, false);
    assert.equal(schema.safeParse({ ...base, depth: 1.5 }).success, false);
    assert.equal(schema.safeParse({ ...base, mode: "auto" }).success, true);
    assert.equal(schema.safeParse({ ...base, mode: "depth" }).success, true);
    assert.equal(schema.safeParse({ ...base, mode: "size" }).success, false);
    assert.equal(schema.safeParse({ ...base, boardNameRegex: "a".repeat(200) }).success, true);
    assert.equal(schema.safeParse({ ...base, boardNameRegex: "a".repeat(201) }).success, false);
    assert.equal(schema.safeParse({ ...base, includeSameScreen: true }).success, true);
    assert.equal(schema.safeParse({ ...base, includeSameScreen: "yes" }).success, false);
});

test("find_connectors passes the screen keys and the new counts through unchanged", async () => {
    const reply = {
        revn: 3,
        pageId: PAGE,
        scanned: 2,
        selection: { mode: "auto", basis: "standard-size", boards: 3 },
        connectors: [
            {
                id: ARROW,
                name: "Arrow Group",
                type: "group",
                direction: "shape",
                confidence: "high",
                composed: true,
                length: 210,
                from: {
                    boardId: BOARD_A,
                    boardName: "Body",
                    screenId: BOARD_A,
                    screenName: "Home",
                    distance: 0,
                    x: 1,
                    y: 2,
                },
                to: { boardId: BOARD_B, boardName: "Decision", nonScreen: true, distance: 0, x: 3, y: 4 },
            },
        ],
        sameScreenSkipped: 4,
        nonScreenEnds: 1,
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("find_connectors describes screens, dropped same-screen connectors, direction, confidence and groups", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /A screen is a board that is one whole screen of the app/);
    assert.match(description, /nonScreen true and no screen keys/);
    assert.match(description, /A frame that holds screens, such as a section, is never that target/);
    assert.match(description, /names both screens/);
    assert.match(description, /dropped by default, and sameScreenSkipped counts them/);
    assert.match(description, /includeSameScreen true returns them, each with sameScreen true/);
    assert.match(description, /cap \(an arrow cap on one end of an open path; confidence high\)/);
    assert.match(description, /both \(a head at each end; confidence medium\)/);
    assert.match(description, /none \(no head: from is the end further left; confidence none\)/);
    assert.match(description, /A group drawn as an arrow is a candidate too/);
    assert.match(description, /composed true/);
    assert.match(description, /anatomy of one arrow/);
    assert.match(description, /a row of arrows, is no arrow/);
    assert.match(description, /An arrow drawn inside a screen is found/);
    assert.match(
        description,
        /A rounded or blunt tip, and a 90 degree head on a long shaft, are read too, with confidence medium/
    );
    assert.match(description, /a short arrow with a wide head has one head/);
});

/** Builds a long list of items, each with a name of `size` bytes. */
function manyItems(count: number, size: number): Array<{ id: string; name: string }> {
    return Array.from({ length: count }, (_, n) => ({ id: `c${n}`, name: "x".repeat(size) }));
}

/** Builds the tool on a backend that answers each call with the items from its offset on. */
function pagingTool(all: Array<{ id: string }>) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("find-mcp-connectors", (params: object) => {
            const offset = (params as { offset?: number }).offset ?? 0;
            return { revn: 4, pageId: PAGE, total: all.length, connectors: all.slice(offset), truncated: false };
        });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new FindConnectorsTool(server, services) };
}

test("find_connectors passes offset to the backend and describes the paging and the wrapper rule", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE, offset: 40 });
    assert.deepEqual(
        backend.callsTo("find-mcp-connectors").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, offset: 40 }]
    );
    const schema = z.object(FindConnectorsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, offset: 0 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, offset: -1 }).success, false);
    const description = tool.getToolDescription();
    assert.match(description, /call again with offset set to nextOffset until no nextOffset comes back/);
    assert.match(description, /is a wrapper, not a board, when most such frames hold exactly one frame/);
});

test("find_connectors returns whole connectors with nextOffset when the reply is above the cap", async () => {
    const all = manyItems(300, 600);
    const { backend, tool } = pagingTool(all);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const text = (response.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text, "utf8") <= BackendTool.MAX_RESPONSE_BYTES);
    const body = JSON.parse(text) as {
        connectors: unknown[];
        truncated: boolean;
        nextOffset: number;
        total: number;
        revn: number;
        note: string;
        partial?: unknown;
    };
    assert.equal(body.partial, undefined, "never the generic cut wrapper");
    assert.equal(body.truncated, true);
    assert.equal(body.total, 300);
    assert.equal(body.revn, 4);
    assert.ok(body.connectors.length > 0 && body.connectors.length < 300);
    assert.equal(body.nextOffset, body.connectors.length);
    assert.deepEqual(body.connectors, all.slice(0, body.connectors.length));
    assert.match(body.note, /Call again with offset/);
    assert.equal(backend.callsTo("find-mcp-connectors").length, 1);
});

test("find_connectors: a walk with nextOffset reads every connector once, in order", async () => {
    const all = manyItems(300, 600);
    const { backend, tool } = pagingTool(all);
    const seen: Array<{ id: string }> = [];
    let offset: number | undefined = undefined;
    const offsets: Array<number | undefined> = [];
    do {
        offsets.push(offset);
        const response = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            ...(offset !== undefined ? { offset } : {}),
        });
        const body = JSON.parse((response.content[0] as { text: string }).text) as {
            connectors: Array<{ id: string }>;
            nextOffset?: number;
        };
        seen.push(...body.connectors);
        offset = body.nextOffset;
    } while (offset !== undefined && offsets.length < 20);
    assert.ok(offsets.length > 1);
    assert.deepEqual(seen, all);
    assert.deepEqual(
        backend.callsTo("find-mcp-connectors").map((call) => (call.params as { offset?: number }).offset),
        offsets
    );
});

test("find_connectors cuts a timed-out reply above the cap at whole items, with no nextOffset", async () => {
    const connectors = manyItems(300, 600);
    const { tool } = harness({
        revn: 4,
        pageId: PAGE,
        scanned: 90,
        total: 300,
        connectors,
        truncated: true,
        timedOut: true,
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        connectors: unknown[];
        nextOffset?: number;
        timedOut: boolean;
        note: string;
        partial?: unknown;
    };
    assert.equal(body.partial, undefined);
    assert.equal(body.timedOut, true);
    assert.equal(body.nextOffset, undefined);
    assert.ok(body.connectors.length > 0 && body.connectors.length < 300);
    assert.match(body.note, /cannot be continued/);
    assert.match(body.note, /withinId or boardNameRegex/);
});

test("find_connectors adds the time-out note to a small timed-out reply, and none to a normal one", async () => {
    const timed = harness({
        revn: 4,
        pageId: PAGE,
        scanned: 0,
        total: 0,
        connectors: [],
        truncated: true,
        timedOut: true,
    });
    const body = JSON.parse(
        ((await timed.tool.execute({ fileId: FILE, pageId: PAGE })).content[0] as { text: string }).text
    ) as { note?: string; nextOffset?: number };
    assert.equal(body.nextOffset, undefined);
    assert.match(body.note ?? "", /ran out of time/);
    assert.match(body.note ?? "", /withinId or boardNameRegex/);
    const normal = harness();
    const plain = JSON.parse(
        ((await normal.tool.execute({ fileId: FILE, pageId: PAGE })).content[0] as { text: string }).text
    ) as { note?: string };
    assert.equal(plain.note, undefined);
});
