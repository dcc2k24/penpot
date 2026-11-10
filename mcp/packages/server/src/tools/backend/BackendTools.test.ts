import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { Tool } from "../../Tool";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { BackendRpcError } from "../../backend/BackendRpcError";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { BackendToolSet } from "./BackendToolSet";
import { BackendTool } from "./BackendTool";

const TOKEN = "alice-token";
const TEAM = "1b2c3d4e-0000-4000-8000-000000000001";
const PROJECT = "1b2c3d4e-0000-4000-8000-000000000002";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000005";
const SNAPSHOT = "1b2c3d4e-0000-4000-8000-000000000006";
const COMMENT = "1b2c3d4e-0000-4000-8000-000000000007";
const THREAD = "1b2c3d4e-0000-4000-8000-000000000008";
const LIBRARY = "1b2c3d4e-0000-4000-8000-000000000009";
const SET = "1b2c3d4e-0000-4000-8000-00000000000b";

/** Attributes that get_shapes returns when no fields are given. */
const DEFAULT_SHAPE_FIELDS = ["id", "name", "type", "parent-id", "x", "y", "width", "height", "hidden", "shapes"];

/** Shape of a v4 UUID, which the write commands send as requestId. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Checks that a write carries a requestId, and returns its parameters without it.
 *
 * @param params - the parameters of a write command as the fake backend received them
 */
function withoutRequestId(params: unknown): Record<string, unknown> {
    const { requestId, ...rest } = params as Record<string, unknown>;
    assert.match(String(requestId), UUID_PATTERN);
    return rest;
}

/** A request session, as the HTTP layer provides it. */
interface TestSession {
    userToken?: string;
}

/** A server stub whose only job is to return the request session. */
function sessionServer(session: TestSession): PenpotMcpServer {
    return {
        getSessionContext: () => session,
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** Builds the tool set on a fake backend that accepts every token. */
function harness(settings: BackendSettings = new BackendSettings(), session: TestSession = { userToken: TOKEN }) {
    const backend = new FakePenpotBackend().respond("mcp-whoami", {
        contractVersion: 1,
        profileId: "profile-1",
        scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
    });
    const services = new BackendServices(backend, settings, new FakeExporterClient());
    const tools = BackendToolSet.create(sessionServer(session), services);
    const tool = (name: string): Tool<any> => {
        const found = tools.find((candidate) => candidate.getToolName() === name);
        assert.ok(found, `tool ${name} is registered`);
        return found;
    };
    return { backend, tool, tools };
}

/** Returns the text of a text response. */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

const createRect = { op: "create_rect", pageId: PAGE, id: "$tmp:bg", x: 0, y: 0, width: 100, height: 40 };

// ── Happy paths: tool arguments map to the backend command and its parameters ──

const cases: [string, string, Record<string, unknown>, string, Record<string, unknown>][] = [
    ["whoami", "whoami", {}, "mcp-whoami", {}],
    ["list_teams", "list_teams", {}, "get-teams", {}],
    ["list_projects by team", "list_projects", { teamId: TEAM }, "get-projects", { teamId: TEAM }],
    ["list_files by project", "list_files", { projectId: PROJECT }, "get-project-files", { projectId: PROJECT }],
    [
        "list_files search",
        "list_files",
        { teamId: TEAM, query: "logo" },
        "search-files",
        { teamId: TEAM, searchTerm: "logo" },
    ],
    ["list_files trash", "list_files", { teamId: TEAM, deleted: true }, "get-team-deleted-files", { teamId: TEAM }],
    ["get_file_outline", "get_file_outline", { fileId: FILE }, "get-mcp-file-outline", { fileId: FILE }],
    [
        "get_page_tree",
        "get_page_tree",
        { fileId: FILE, pageId: PAGE, depth: 2, fields: ["id", "type"] },
        "get-mcp-page-tree",
        { fileId: FILE, pageId: PAGE, depth: 2, fields: ["id", "type"], limit: 100 },
    ],
    [
        "get_page_tree with the nil root",
        "get_page_tree",
        { fileId: FILE, pageId: PAGE, rootId: "00000000-0000-0000-0000-000000000000" },
        "get-mcp-page-tree",
        { fileId: FILE, pageId: PAGE, rootId: "00000000-0000-0000-0000-000000000000", limit: 100 },
    ],
    [
        "get_shapes",
        "get_shapes",
        { fileId: FILE, pageId: PAGE, ids: [SHAPE], includeChildren: true },
        "get-mcp-shapes",
        { fileId: FILE, pageId: PAGE, ids: [SHAPE], includeChildren: true, fields: DEFAULT_SHAPE_FIELDS },
    ],
    [
        "find_shapes",
        "find_shapes",
        { fileId: FILE, type: "text", limit: 5 },
        "find-mcp-shapes",
        { fileId: FILE, type: "text", limit: 5 },
    ],
    [
        "get_library",
        "get_library",
        { fileId: FILE, kinds: ["colors"] },
        "get-mcp-library",
        { fileId: FILE, kinds: ["colors"] },
    ],
    ["get_tokens", "get_tokens", { fileId: FILE }, "get-mcp-tokens", { fileId: FILE, format: "tokens" }],
    [
        "get_tokens of one set as dtcg",
        "get_tokens",
        { fileId: FILE, setId: SET, format: "dtcg" },
        "get-mcp-tokens",
        { fileId: FILE, setId: SET, format: "dtcg" },
    ],
    [
        "export_subtree",
        "export_subtree",
        { fileId: FILE, pageId: PAGE, rootId: SHAPE, limit: 50 },
        "get-mcp-subtree",
        { fileId: FILE, pageId: PAGE, rootId: SHAPE, limit: 50, maxBytes: 80_000 },
    ],
    [
        "get_interactions",
        "get_interactions",
        { fileId: FILE, pageId: PAGE, limit: 25 },
        "get-mcp-interactions",
        { fileId: FILE, pageId: PAGE, limit: 25 },
    ],
    [
        "find_connectors",
        "find_connectors",
        { fileId: FILE, pageId: PAGE, maxDistance: 120, limit: 40 },
        "find-mcp-connectors",
        { fileId: FILE, pageId: PAGE, maxDistance: 120, limit: 40 },
    ],
    [
        "list_fonts",
        "list_fonts",
        { fileId: FILE, pageId: PAGE, rootIds: [SHAPE] },
        "get-mcp-fonts",
        { fileId: FILE, pageId: PAGE, rootIds: [SHAPE] },
    ],
    [
        "lint_page",
        "lint_page",
        {
            fileId: FILE,
            pageId: PAGE,
            depth: 2,
            boardNameRegex: "^Screen",
            minShapes: 5,
            rules: ["empty-board", "off-board-control"],
            limit: 100,
        },
        "get-mcp-page-lint",
        {
            fileId: FILE,
            pageId: PAGE,
            depth: 2,
            boardNameRegex: "^Screen",
            minShapes: 5,
            rules: ["empty-board", "off-board-control"],
            limit: 100,
        },
    ],
    [
        "find_similar_boards",
        "find_similar_boards",
        { fileId: FILE, pageId: PAGE, depth: 3, boardNameRegex: "^Card", threshold: 0.75, minShapes: 4, limit: 20 },
        "find-mcp-similar-boards",
        { fileId: FILE, pageId: PAGE, depth: 3, boardNameRegex: "^Card", threshold: 0.75, minShapes: 4, limit: 20 },
    ],
    [
        "apply_operations",
        "apply_operations",
        { fileId: FILE, operations: [createRect], dryRun: true, baseRevn: 7 },
        "mcp-apply-operations",
        { fileId: FILE, operations: [createRect], dryRun: true, baseRevn: 7 },
    ],
    [
        "apply_raw_changes",
        "apply_raw_changes",
        { fileId: FILE, changes: [{ type: "del-obj", id: SHAPE }], failOnConflict: true },
        "mcp-apply-changes",
        { fileId: FILE, changes: [{ type: "del-obj", id: SHAPE }], failOnConflict: true },
    ],
    [
        "manage_files create_team",
        "manage_files",
        { action: "create_team", name: "Design" },
        "create-team",
        { name: "Design" },
    ],
    [
        "manage_files rename_team",
        "manage_files",
        { action: "rename_team", teamId: TEAM, name: "Studio" },
        "update-team",
        { id: TEAM, name: "Studio" },
    ],
    [
        "manage_files pin_project",
        "manage_files",
        { action: "pin_project", projectId: PROJECT, teamId: TEAM, isPinned: true },
        "update-project-pin",
        { id: PROJECT, teamId: TEAM, isPinned: true },
    ],
    [
        "manage_files create_file",
        "manage_files",
        { action: "create_file", projectId: PROJECT, name: "Icons", isShared: false },
        "create-file",
        { projectId: PROJECT, name: "Icons", isShared: false },
    ],
    [
        "manage_files rename_file",
        "manage_files",
        { action: "rename_file", fileId: FILE, name: "Icons v2" },
        "rename-file",
        { id: FILE, name: "Icons v2" },
    ],
    [
        "manage_files move_files",
        "manage_files",
        { action: "move_files", fileIds: [FILE], projectId: PROJECT },
        "move-files",
        { ids: [FILE], projectId: PROJECT },
    ],
    ["manage_files delete_file", "manage_files", { action: "delete_file", fileId: FILE }, "delete-file", { id: FILE }],
    [
        "manage_files restore_files",
        "manage_files",
        { action: "restore_files", teamId: TEAM, fileIds: [FILE] },
        "restore-deleted-team-files",
        { teamId: TEAM, ids: [FILE] },
    ],
    [
        "manage_files set_shared",
        "manage_files",
        { action: "set_shared", fileId: FILE, isShared: true },
        "set-file-shared",
        { id: FILE, isShared: true },
    ],
    [
        "manage_files link_library",
        "manage_files",
        { action: "link_library", fileId: FILE, libraryId: LIBRARY },
        "link-file-to-library",
        { fileId: FILE, libraryId: LIBRARY },
    ],
    [
        "manage_files unlink_library",
        "manage_files",
        { action: "unlink_library", fileId: FILE, libraryId: LIBRARY },
        "unlink-file-from-library",
        { fileId: FILE, libraryId: LIBRARY },
    ],
    [
        "manage_versions list",
        "manage_versions",
        { fileId: FILE, action: "list" },
        "get-file-snapshots",
        { fileId: FILE },
    ],
    [
        "manage_versions create",
        "manage_versions",
        { fileId: FILE, action: "create", label: "before refactor" },
        "create-file-snapshot",
        { fileId: FILE, label: "before refactor" },
    ],
    [
        "manage_versions restore",
        "manage_versions",
        { fileId: FILE, action: "restore", snapshotId: SNAPSHOT },
        "restore-file-snapshot",
        { fileId: FILE, id: SNAPSHOT },
    ],
    [
        "manage_versions pin",
        "manage_versions",
        { fileId: FILE, action: "pin", snapshotId: SNAPSHOT },
        "lock-file-snapshot",
        { id: SNAPSHOT },
    ],
    [
        "manage_versions unpin",
        "manage_versions",
        { fileId: FILE, action: "unpin", snapshotId: SNAPSHOT },
        "unlock-file-snapshot",
        { id: SNAPSHOT },
    ],
    [
        "manage_versions rename",
        "manage_versions",
        { fileId: FILE, action: "rename", snapshotId: SNAPSHOT, label: "v2" },
        "update-file-snapshot",
        { id: SNAPSHOT, label: "v2" },
    ],
    [
        "manage_versions delete",
        "manage_versions",
        { fileId: FILE, action: "delete", snapshotId: SNAPSHOT },
        "delete-file-snapshot",
        { id: SNAPSHOT },
    ],
    ["comments list", "comments", { fileId: FILE, action: "list" }, "get-comment-threads", { fileId: FILE }],
    [
        "comments get",
        "comments",
        { fileId: FILE, action: "get", threadId: THREAD },
        "get-comments",
        { threadId: THREAD },
    ],
    [
        "comments create_thread",
        "comments",
        {
            fileId: FILE,
            action: "create_thread",
            pageId: PAGE,
            frameId: SHAPE,
            position: { x: 1, y: 2 },
            content: "Check",
        },
        "create-comment-thread",
        { fileId: FILE, pageId: PAGE, frameId: SHAPE, position: { x: 1, y: 2 }, content: "Check" },
    ],
    [
        "comments reply",
        "comments",
        { fileId: FILE, action: "reply", threadId: THREAD, content: "Done" },
        "create-comment",
        { threadId: THREAD, content: "Done" },
    ],
    [
        "comments resolve",
        "comments",
        { fileId: FILE, action: "resolve", threadId: THREAD },
        "update-comment-thread",
        { id: THREAD, isResolved: true },
    ],
    [
        "comments reopen",
        "comments",
        { fileId: FILE, action: "reopen", threadId: THREAD },
        "update-comment-thread",
        { id: THREAD, isResolved: false },
    ],
    [
        "comments move",
        "comments",
        { fileId: FILE, action: "move", threadId: THREAD, position: { x: 5, y: 6 }, frameId: SHAPE },
        "update-comment-thread-position",
        { id: THREAD, position: { x: 5, y: 6 }, frameId: SHAPE },
    ],
    [
        "comments delete_thread",
        "comments",
        { fileId: FILE, action: "delete_thread", threadId: THREAD },
        "delete-comment-thread",
        { id: THREAD },
    ],
    [
        "comments delete",
        "comments",
        { fileId: FILE, action: "delete", commentId: COMMENT },
        "delete-comment",
        { id: COMMENT },
    ],
];

for (const [label, toolName, args, command, params] of cases) {
    test(`${label} calls ${command} with the expected parameters`, async () => {
        const { backend, tool } = harness();
        await tool(toolName).execute(args);
        // the token validator also calls mcp-whoami, so the tool's own call is the last one
        const calls = backend.callsTo(command);
        assert.ok(calls.length >= 1, `a call to ${command}`);
        const last = calls[calls.length - 1];
        const actual: Record<string, unknown> = { ...(last.params as Record<string, unknown>) };
        if (command === "mcp-apply-operations" || command === "mcp-apply-changes") {
            // every write names itself; the id is checked here and left out of the comparison
            assert.match(String(actual.requestId), UUID_PATTERN);
            delete actual.requestId;
        }
        assert.deepEqual(actual, params);
        assert.equal(last.userToken, TOKEN);
    });
}

test("apply_operations returns the backend answer as compact JSON after validating the token", async () => {
    const { backend, tool } = harness();
    backend.respond("mcp-apply-operations", { revn: 9, createdIds: { "$tmp:bg": SHAPE } });
    const response = await tool("apply_operations").execute({ fileId: FILE, operations: [createRect] });
    assert.equal(textOf(response), JSON.stringify({ revn: 9, createdIds: { "$tmp:bg": SHAPE } }));
    assert.deepEqual(
        backend.calls.map((call) => call.name),
        ["mcp-whoami", "mcp-apply-operations"]
    );
});

test("apply_operations with an unknown op never reaches the backend", async () => {
    const { backend, tool } = harness();
    const response = await tool("apply_operations").execute({
        fileId: FILE,
        operations: [{ op: "create_squircle", pageId: PAGE }],
    });
    assert.match(textOf(response), /unknown op "create_squircle"/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("manage_files reports the fields an action still needs", async () => {
    const { backend, tool } = harness();
    const response = await tool("manage_files").execute({ action: "rename_file", fileId: FILE });
    assert.match(textOf(response), /manage_files action "rename_file" needs name/);
    assert.equal(backend.callsTo("rename-file").length, 0);
});

test("list_files without a project or team explains what it needs", async () => {
    const { tool } = harness();
    assert.match(textOf(await tool("list_files").execute({})), /needs a projectId, or a teamId/);
});

test("comments create_thread without a page names the missing field", async () => {
    const { tool } = harness();
    const response = await tool("comments").execute({
        fileId: FILE,
        action: "create_thread",
        position: { x: 0, y: 0 },
        content: "x",
    });
    assert.match(textOf(response), /comments action "create_thread" needs pageId/);
});

test("manage_versions restore without a snapshot id names the missing field", async () => {
    const { tool } = harness();
    assert.match(
        textOf(await tool("manage_versions").execute({ fileId: FILE, action: "restore" })),
        /needs a snapshotId/
    );
});

// ── Admission: token, validation and rate limit run before every call ──

test("a request without an MCP token is refused before any backend call", async () => {
    const { backend, tool } = harness(undefined, {});
    const response = await tool("list_teams").execute({});
    assert.match(textOf(response), /No MCP token was given/);
    assert.equal(backend.calls.length, 0);
});

test("a token the backend rejects is refused with a rejection message and no command call", async () => {
    const backend = new FakePenpotBackend().fail(
        "mcp-whoami",
        new BackendRpcError(401, "mcp-whoami", { code: "authentication", hint: "expired" })
    );
    const tools = BackendToolSet.create(
        sessionServer({ userToken: TOKEN }),
        new BackendServices(backend, new BackendSettings(), new FakeExporterClient())
    );
    const listTeams = tools.find((tool) => tool.getToolName() === "list_teams")!;
    const response = await listTeams.execute({});
    assert.match(textOf(response), /The MCP token was rejected by the backend/);
    assert.equal(backend.callsTo("get-teams").length, 0);
});

test("the rate limit refuses requests beyond the bucket with the retry delay", async () => {
    const { backend, tool } = harness(new BackendSettings(10, 1, 1));
    await tool("list_teams").execute({});
    const refused = textOf(await tool("list_teams").execute({}));
    assert.match(refused, /rate limited, retry after 1 s/);
    assert.equal(backend.callsTo("get-teams").length, 1);
});

test("a backend error is shown as a tool failure, without the raw body", async () => {
    const { backend, tool } = harness();
    backend.fail("get-teams", new BackendRpcError(500, "get-teams", { code: "internal", hint: "try later" }));
    const response = textOf(await tool("list_teams").execute({}));
    assert.match(response, /Backend error internal: try later/);
});

// ── batch_create_shapes end to end through the fake backend ──

test("batch_create_shapes sends the expanded operations and returns the handle map", async () => {
    const { backend, tool } = harness();
    backend.respond("mcp-apply-operations", { revn: 3, createdIds: { "$tmp:n0": SHAPE, "$tmp:n1": COMMENT } });
    const response = await tool("batch_create_shapes").execute({
        fileId: FILE,
        pageId: PAGE,
        tree: [
            {
                type: "board",
                name: "Card",
                x: 0,
                y: 0,
                width: 320,
                height: 200,
                children: [{ type: "rect", x: 16, y: 16, width: 288, height: 168 }],
            },
        ],
    });
    const call = backend.callsTo("mcp-apply-operations")[0];
    assert.deepEqual(withoutRequestId(call.params), {
        fileId: FILE,
        operations: [
            { op: "create_board", pageId: PAGE, id: "$tmp:n0", x: 0, y: 0, width: 320, height: 200, name: "Card" },
            {
                op: "create_rect",
                pageId: PAGE,
                id: "$tmp:n1",
                parentId: "$tmp:n0",
                x: 16,
                y: 16,
                width: 288,
                height: 168,
            },
        ],
    });
    const body = JSON.parse(textOf(response)) as {
        nodes: { handle: string; type: string }[];
        result: { createdIds: Record<string, string> };
    };
    assert.deepEqual(
        body.nodes.map((node) => node.handle),
        ["$tmp:n0", "$tmp:n1"]
    );
    assert.equal(body.result.createdIds["$tmp:n0"], SHAPE);
});

test("batch_create_shapes applies the parent id to the top-level nodes", async () => {
    const { backend, tool } = harness();
    await tool("batch_create_shapes").execute({
        fileId: FILE,
        pageId: PAGE,
        parentId: SHAPE,
        tree: [{ type: "rect", x: 0, y: 0, width: 1, height: 1 }],
    });
    const params = backend.callsTo("mcp-apply-operations")[0].params as { operations: { parentId: string }[] };
    assert.equal(params.operations[0].parentId, SHAPE);
});

// ── Responses ──

test("formatJson prints a value as compact JSON", () => {
    assert.equal(BackendTool.formatJson({ a: 1 }), '{"a":1}');
});

test("formatJson cuts a response above 100 kB and says so", () => {
    const text = BackendTool.formatJson("a".repeat(1_200_000));
    assert.ok(Buffer.byteLength(text, "utf8") <= BackendTool.MAX_RESPONSE_BYTES);
    assert.match(text, /truncated: the response exceeded 100 kB/);
});

test("read tools are marked read-only, and the file and version managers are marked destructive", () => {
    const { tools } = harness();
    const readOnly = [
        "whoami",
        "list_teams",
        "list_projects",
        "list_files",
        "get_file_outline",
        "get_page_tree",
        "get_shapes",
        "find_shapes",
        "get_library",
        "get_tokens",
        "get_interactions",
        "find_connectors",
        "list_fonts",
        "lint_page",
        "find_similar_boards",
        "describe_operations",
    ];
    for (const name of readOnly) {
        const found = tools.find((candidate) => candidate.getToolName() === name);
        assert.ok(found, `${name} is registered`);
        assert.deepEqual(found.annotations(), { readOnlyHint: true, destructiveHint: false }, name);
    }
    const writesOnly = ["export_subtree"];
    for (const name of writesOnly) {
        const found = tools.find((candidate) => candidate.getToolName() === name);
        assert.ok(found, `${name} is registered`);
        assert.deepEqual(found.annotations(), { readOnlyHint: false, destructiveHint: false }, name);
    }
    for (const name of ["manage_files", "manage_versions"]) {
        const found = tools.find((candidate) => candidate.getToolName() === name);
        assert.ok(found, `${name} is registered`);
        assert.equal(found.annotations().destructiveHint, true, name);
    }
});

test("the tool set holds twenty-eight backend tools with unique names", () => {
    const { tools } = harness();
    const names = tools.map((tool) => tool.getToolName());
    assert.equal(names.length, 28);
    assert.equal(new Set(names).size, 28);
    assert.ok(names.includes("describe_operations"));
    assert.ok(names.includes("execute_code"));
    assert.ok(names.includes("apply_operations"));
    assert.ok(names.includes("batch_create_shapes"));
    assert.ok(names.includes("import_image"));
    assert.ok(names.includes("import_svg"));
    assert.ok(names.includes("import_archive"));
    assert.ok(names.includes("export_shape"));
});

test("every tool schema describes each of its fields", () => {
    const { tools } = harness();
    const undocumented: string[] = [];
    for (const tool of tools) {
        for (const [field, schema] of Object.entries(tool.getInputSchema())) {
            if (!(schema as { description?: string }).description && !hasDescribedInner(schema)) {
                undocumented.push(`${tool.getToolName()}.${field}`);
            }
        }
    }
    assert.deepEqual(undocumented, []);
});

/**
 * Reports whether a zod schema, or the element of an optional or array wrapper, carries a description.
 *
 * @param schema - the field schema
 */
function hasDescribedInner(schema: unknown): boolean {
    const inner = schema as { description?: string; unwrap?: () => unknown; element?: unknown };
    if (inner.description) {
        return true;
    }
    if (inner.unwrap) {
        return hasDescribedInner(inner.unwrap());
    }
    return false;
}
