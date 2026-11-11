import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { ListFontsArgs, ListFontsTool } from "./ListFontsTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000030";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of get-mcp-fonts
 */
function harness(reply: unknown = { revn: 1, fonts: [], unresolved: 0, truncated: false }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-fonts", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new ListFontsTool(server, services) };
}

test("list_fonts with no page sends only the file id", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE });
    assert.deepEqual(
        backend.callsTo("get-mcp-fonts").map((call) => call.params),
        [{ fileId: FILE }]
    );
});

test("list_fonts with a page and root ids sends both", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE, rootIds: [SHAPE] });
    assert.deepEqual(
        backend.callsTo("get-mcp-fonts").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, rootIds: [SHAPE] }]
    );
});

test("list_fonts with a page alone sends the page", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(
        backend.callsTo("get-mcp-fonts").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE }]
    );
});

test("list_fonts refuses rootIds without pageId, and calls no command", async () => {
    const { backend, tool } = harness();
    const response = await tool.execute({ fileId: FILE, rootIds: [SHAPE] });
    assert.equal(response.isError, true);
    assert.match((response.content[0] as { text: string }).text, /rootIds needs pageId/);
    assert.deepEqual(backend.callsTo("get-mcp-fonts"), []);
});

test("list_fonts passes the reply through unchanged", async () => {
    const reply = {
        revn: 3,
        fonts: [
            {
                fontId: "gfont-missing",
                family: "Missing",
                source: "google",
                resolved: false,
                reason: "not-in-google-catalog",
                runs: 2,
                shapes: 1,
                pages: [{ pageId: PAGE, runs: 2 }],
                variants: [],
            },
        ],
        unresolved: 1,
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("the list_fonts schema refuses malformed ids and too many root ids", () => {
    const schema = z.object(ListFontsArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rootIds: [SHAPE] }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, rootIds: [] }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, rootIds: Array(201).fill(SHAPE) }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, rootIds: Array(200).fill(SHAPE) }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: "page-1" }).success, false);
});

test("list_fonts describes the variant fields, including variantId and reason", () => {
    const { tool } = harness();
    assert.match(tool.getToolDescription(), /Each variant has variantId, weight, style, runs, resolved, reason/);
});

test("list_fonts describes the 500-font cap, the merged runs and what truncated covers", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /At most 500 fonts come back/);
    assert.match(description, /Runs of one face are merged into one variant, under the font's own variantId/);
    assert.match(description, /the reply holds more than 500 fonts, or the reply reached the response size/);
});

test("list_fonts passes the suggestion and page count fields through", async () => {
    const reply = {
        revn: 3,
        fonts: [
            {
                fontId: "gfont-access-sans",
                family: "Access Sans",
                source: "google",
                resolved: false,
                reason: "not-in-google-catalog",
                runs: 2,
                shapes: 1,
                pages: [{ pageId: PAGE, runs: 2 }],
                variants: [],
                suggestedFontId: "custom-1b2c3d4e",
                suggestedFamily: "Access Sans Bold",
                suggestedSource: "custom",
                suggestedMatch: "stem",
                suggestedVariantsMissing: [{ weight: "400", style: "normal" }],
            },
        ],
        unresolved: 1,
        pagesRead: 3,
        pagesTotal: 3,
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("list_fonts adds a note that says what to do when it read only some of the pages", async () => {
    const reply = { revn: 3, fonts: [], unresolved: 0, pagesRead: 1, pagesTotal: 2, truncated: true };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE });
    const body = JSON.parse((response.content[0] as { text: string }).text);
    assert.deepEqual({ ...body, note: undefined }, { ...reply, note: undefined });
    assert.match(body.note, /Read 1 of 2 pages in the time limit: the list is not complete/);
    assert.match(body.note, /Call list_fonts again with the same arguments/);
    assert.match(body.note, /process that read a page keeps it for up to 10 minutes/);
    assert.match(body.note, /pagesRead need not grow on every call/);
});

test("list_fonts adds no note when every page was read", async () => {
    const reply = { revn: 3, fonts: [], unresolved: 0, pagesRead: 2, pagesTotal: 2, truncated: false };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("list_fonts says in its description that a partial read goes on when called again", () => {
    assert.match(harness().tool.getToolDescription(), /a note says what to do: call list_fonts again/);
});

test("list_fonts describes the suggestion fields and the page counts", () => {
    const description = harness().tool.getToolDescription();
    for (const name of [
        "suggestedFontId",
        "suggestedFamily",
        "suggestedSource",
        "suggestedMatch",
        "suggestedVariantsMissing",
        "pagesRead",
        "pagesTotal",
    ]) {
        assert.ok(description.includes(name), name);
    }
    assert.match(description, /Use suggestedFontId; penpot_api_info/);
    assert.match(description, /whole file that is not truncated is the complete font report/);
});
