import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { BackendTool } from "./BackendTool";
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
        mode: "depth",
        boardNameRegex: "^Screen",
        minShapes: 5,
        rules: ["empty-board", "off-board-control"],
        tolerance: 2,
        minOverflow: 12,
        limit: 100,
    });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [
            {
                fileId: FILE,
                pageId: PAGE,
                depth: 2,
                mode: "depth",
                boardNameRegex: "^Screen",
                minShapes: 5,
                rules: ["empty-board", "off-board-control"],
                tolerance: 2,
                minOverflow: 12,
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
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 12 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 13 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, depth: 0 }).success, false);
    for (const mode of ["depth", "auto"]) {
        assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, mode }).success, true);
    }
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, mode: "size" }).success, false);
    for (const minOverflow of [0, 7.9, 1000]) {
        assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minOverflow }).success, true);
    }
    for (const minOverflow of [-1, 1001]) {
        assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minOverflow }).success, false);
    }
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["scroll-candidate"] }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["sibling-overlay"] }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: Array(9).fill("empty-board") }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: Array(10).fill("empty-board") }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 0 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, minShapes: 1001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, boardNameRegex: "a".repeat(201) }).success, false);
    for (const tolerance of [0, 0.5, 100]) {
        assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, tolerance }).success, true);
    }
    for (const tolerance of [-1, 101]) {
        assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, tolerance }).success, false);
    }
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: [] }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["no-such-rule"] }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rules: ["empty-board"] }).success, true);
});

test("lint_page says instance-only-board judges the content against the chrome components", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /instance-only-board \(the board holds an instance of a chrome component/);
    assert.match(description, /detail chromeComponentIds and contentShapes 0/);
    assert.match(
        description,
        /Chrome components are the components that repeat in the same place across the screens and touch a screen edge or sit on most screens, such as a header, a footer or a side rail/
    );
    assert.match(description, /chromeComponents lists up to 10 as id, name and boards \(and variants/);
    assert.match(
        description,
        /within 4 px of a board edge or the component is in at least 70 % of the selected boards/
    );
    assert.match(description, /The variants of one component count as one/);
    assert.match(description, /Content is an image of any size/);
    assert.match(description, /backdrop covering 90 % of the board or more/);
    assert.match(description, /whose box is under 50 % of the board/);
    assert.doesNotMatch(description, /headerComponent/);
    assert.doesNotMatch(description, /only visible child is one component instance/);
});

test("lint_page describes rawVisibleFraction and the tolerance of the scroll reach", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /visibleFraction is 0, and rawVisibleFraction gives the share of the whole box/);
    assert.match(description, /still counts as reachable/);
    assert.match(description, /has visible children that reach past its right or bottom edge/);
    assert.match(description, /A background that covers the frame on both axes does not count/);
});

test("lint_page explains the automatic board selection and what it reports", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /mode auto first looks for frames of a standard screen size/);
    assert.match(description, /at least three times/);
    assert.match(description, /falls back to the frames at depth 1/);
    assert.match(description, /Frames under 200 px on a side are never boards/);
    assert.match(description, /If there are none, it uses the nesting of repeated frame sizes/);
    assert.match(description, /basis \(standard-size, structure or depth-fallback\)/);
    assert.match(description, /depth or boardNameRegex alone chooses boards by hand/);
    assert.match(description, /selection says what was selected: mode, depth, fallback/);
    assert.match(description, /sizesOmitted \(sizes left out of the list of 20\)/);
    assert.match(description, /otherSizes: up to 5 sizes that repeat on the page but were not selected/);
    assert.match(
        description,
        /relation \(inside when they lie inside the selected boards, outside otherwise, wrapper when the frames only wrap the screens\)/
    );
    assert.match(description, /In mode depth, deeperBoards is the number of frames below the selected boards/);
    assert.match(description, /call again without depth to let the selection find them, or with a larger depth/);
    assert.match(description, /Mode auto has no deeperBoards/);
});

test("lint_page describes scroll-candidate and the one-call fix", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /scroll-candidate \(a frame that clips its content, has no overflowScroll/);
    assert.match(description, /minOverflow pixels/);
    assert.match(description, /suggested \(vertical, horizontal or both\) and inComponentCopy/);
    assert.match(description, /set overflowScroll on the main component/);
    assert.match(description, /one apply_operations call with an update_shape operation per frame/);
    assert.match(description, /sibling-overlay \(mode auto only/);
    assert.match(description, /detail coveredFraction and overlayBox/);
});

test("lint_page passes the selection, the chrome components and scroll-candidate findings through", async () => {
    const reply = {
        revn: 11,
        pageId: PAGE,
        boards: 3,
        selection: {
            mode: "auto",
            fallback: false,
            sizes: [{ width: 800, height: 600, boards: 3 }],
            sizesOmitted: 0,
            boards: 3,
            minDepth: 5,
            maxDepth: 5,
        },
        deeperBoards: 12,
        chromeComponents: [{ id: CONTROL, name: "Header", boards: 3, variants: 4 }],
        findings: [
            {
                rule: "scroll-candidate",
                boardId: BOARD,
                boardName: "Settings",
                shapeId: CONTROL,
                shapeName: "List",
                path: "Settings / List",
                detail: { overflow: { right: 0, bottom: 120 }, suggested: "vertical", inComponentCopy: false },
            },
        ],
        counts: { "scroll-candidate": 1 },
        truncated: false,
    };
    const { backend, tool } = harness(reply);
    const response = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        mode: "auto",
        boardNameRegex: "^Settings",
        rules: ["scroll-candidate"],
        minOverflow: 8,
    });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [
            {
                fileId: FILE,
                pageId: PAGE,
                mode: "auto",
                boardNameRegex: "^Settings",
                rules: ["scroll-candidate"],
                minOverflow: 8,
            },
        ]
    );
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), reply);
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

/** Builds a long list of findings, each with a detail of `size` bytes. */
function manyFindings(count: number, size: number): Array<{ rule: string; shapeId: string; detail: string }> {
    return Array.from({ length: count }, (_, n) => ({
        rule: "invisible-control",
        shapeId: `s${n}`,
        detail: "x".repeat(size),
    }));
}

/** Builds the tool on a backend that answers each call with the findings from its offset on. */
function pagingTool(all: Array<{ shapeId: string }>) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-page-lint", (params: object) => {
            const offset = (params as { offset?: number }).offset ?? 0;
            return {
                revn: 4,
                pageId: PAGE,
                boards: 9,
                findings: all.slice(offset),
                counts: { "invisible-control": all.length },
                total: all.length,
                truncated: false,
            };
        });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new LintPageTool(server, services) };
}

test("lint_page passes offset to the backend and describes the paging and the wrapper rule", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, pageId: PAGE, offset: 40 });
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, offset: 40 }]
    );
    const schema = z.object(LintPageArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, offset: 0 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, offset: -1 }).success, false);
    const description = tool.getToolDescription();
    assert.match(description, /call again with offset set to nextOffset until no nextOffset comes back/);
    assert.match(description, /is a wrapper, not a board, when most such frames hold exactly one frame/);
});

test("lint_page returns whole findings with nextOffset when the reply is above the cap", async () => {
    const all = manyFindings(402, 400);
    const { tool } = pagingTool(all);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, rules: ["invisible-control"] });
    const text = (response.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text, "utf8") <= BackendTool.MAX_RESPONSE_BYTES);
    const body = JSON.parse(text) as {
        findings: unknown[];
        counts: Record<string, number>;
        truncated: boolean;
        nextOffset: number;
        total: number;
        partial?: unknown;
    };
    assert.equal(body.partial, undefined, "never the generic cut wrapper");
    assert.equal(body.truncated, true);
    assert.equal(body.total, 402);
    assert.deepEqual(body.counts, { "invisible-control": 402 });
    assert.ok(body.findings.length > 0 && body.findings.length < 402);
    assert.equal(body.nextOffset, body.findings.length);
    assert.deepEqual(body.findings, all.slice(0, body.findings.length));
});

test("lint_page: a walk with nextOffset reads every finding once, in order", async () => {
    const all = manyFindings(402, 400);
    const { backend, tool } = pagingTool(all);
    const seen: Array<{ shapeId: string }> = [];
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
            findings: Array<{ shapeId: string }>;
            nextOffset?: number;
        };
        seen.push(...body.findings);
        offset = body.nextOffset;
    } while (offset !== undefined && offsets.length < 20);
    assert.ok(offsets.length > 1);
    assert.deepEqual(seen, all);
    assert.deepEqual(
        backend.callsTo("get-mcp-page-lint").map((call) => (call.params as { offset?: number }).offset),
        offsets
    );
});

test("lint_page cuts a timed-out reply above the cap at whole findings, with no nextOffset", async () => {
    const findings = manyFindings(402, 400);
    const { tool } = harness({
        revn: 4,
        pageId: PAGE,
        boards: 9,
        findings,
        counts: { "invisible-control": 402 },
        total: 402,
        truncated: true,
        timedOut: true,
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse((response.content[0] as { text: string }).text) as {
        findings: unknown[];
        nextOffset?: number;
        timedOut: boolean;
        note: string;
        partial?: unknown;
    };
    assert.equal(body.partial, undefined);
    assert.equal(body.timedOut, true);
    assert.equal(body.nextOffset, undefined);
    assert.ok(body.findings.length > 0 && body.findings.length < 402);
    assert.match(body.note, /cannot be continued/);
    assert.match(body.note, /fewer rules, or boardNameRegex/);
});

test("lint_page adds the time-out note to a small timed-out reply, and none to a normal one", async () => {
    const timed = harness({
        revn: 4,
        pageId: PAGE,
        boards: 0,
        findings: [],
        counts: {},
        total: 0,
        truncated: true,
        timedOut: true,
    });
    const body = JSON.parse(
        ((await timed.tool.execute({ fileId: FILE, pageId: PAGE })).content[0] as { text: string }).text
    ) as { note?: string; nextOffset?: number };
    assert.equal(body.nextOffset, undefined);
    assert.match(body.note ?? "", /ran out of time/);
    assert.match(body.note ?? "", /fewer rules, or boardNameRegex/);
    const normal = harness();
    const plain = JSON.parse(
        ((await normal.tool.execute({ fileId: FILE, pageId: PAGE })).content[0] as { text: string }).text
    ) as { note?: string };
    assert.equal(plain.note, undefined);
});
