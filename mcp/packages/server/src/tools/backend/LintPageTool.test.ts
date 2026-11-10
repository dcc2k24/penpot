import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { LintPageArgs, LintPageTool } from "./LintPageTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const BOARD = "1b2c3d4e-0000-4000-8000-000000000040";
const CONTROL = "1b2c3d4e-0000-4000-8000-000000000041";

/**
 * Builds the tool on a fake backend that accepts every token.
 *
 * @param reply - the answer of get-mcp-page-lint
 */
function harness(reply: unknown = { revn: 1, pageId: PAGE, boards: 0, findings: [], counts: {}, truncated: false }) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-page-lint", reply);
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new LintPageTool(server, services) };
}

test("lint_page sends only the file and page when nothing else is given", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE }]
    );
});

test("lint_page sends every argument that is given, under its camelCase name", async () => {
    const { backend, tool } = harness();
    await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        depth: 2,
        boardNameRegex: "^Screen",
        minShapes: 5,
        rules: ["empty-board", "off-board-control"],
        limit: 100,
    });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [
            {
                fileId: FILE,
                pageId: PAGE,
                depth: 2,
                boardNameRegex: "^Screen",
                minShapes: 5,
                rules: ["empty-board", "off-board-control"],
                limit: 100,
            },
        ]
    );
});

test("lint_page passes the findings through unchanged", async () => {
    const reply = {
        revn: 9,
        pageId: PAGE,
        boards: 1,
        findings: [
            {
                rule: "clipped-control",
                boardId: BOARD,
                boardName: "Login",
                shapeId: CONTROL,
                shapeName: "Submit",
                path: "Login / Submit",
                detail: { visibleFraction: 0.5, clippedBy: BOARD },
            },
        ],
        counts: { "clipped-control": 1 },
        truncated: false,
    };
    const { tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
});

test("the lint_page schema refuses values outside the bounds and unknown rules", () => {
    const schema = z.object(LintPageArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 5 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 6 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 0 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 0 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 1001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, boardNameRegex: "a".repeat(201) }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: [] }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["no-such-rule"] }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["empty-board"] }).success, true);
});

test("lint_page says instance-only-board looks at the only visible child", () => {
    const { tool } = harness();
    assert.match(tool.getToolDescription(), /the board's only visible child is one component instance/);
});

test("lint_page passes the scroll-hidden-control rule through and returns its detail", async () => {
    const reply = {
        revn: 10,
        pageId: PAGE,
        boards: 1,
        findings: [
            {
                rule: "scroll-hidden-control",
                boardId: BOARD,
                boardName: "List",
                shapeId: CONTROL,
                shapeName: "Row 9",
                path: "List / Row 9",
                detail: { scrolledBy: BOARD, visibleFraction: 1 },
            },
        ],
        counts: { "scroll-hidden-control": 1 },
        truncated: false,
    };
    const { backend, tool } = harness(reply);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, rules: ["scroll-hidden-control"] });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, rules: ["scroll-hidden-control"] }]
    );
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
    const schema = z.object(LintPageArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["scroll-hidden-control"] }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["scroll-hidden"] }).success, false);
    assert.match(
        tool.getToolDescription(),
        /scroll-hidden-control \(a control out of view inside a board that scrolls/
    );
});

test("lint_page describes the totals in counts and the single report of a control", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /counts totals the findings per rule over all of them, even when limit cuts the list/);
    assert.match(description, /A control is reported once, under its innermost board/);
});
