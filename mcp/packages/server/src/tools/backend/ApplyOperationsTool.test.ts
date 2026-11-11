import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import type { PenpotBackend, RpcCallOptions } from "../../PenpotBackendClient";
import { ApplyOperationsTool } from "./ApplyOperationsTool";
import { TokenCatalogueCache } from "./TokenCatalogueCache";

/** A fake backend whose first apply write waits until the test releases it, so that calls can queue behind it. */
class HeldWriteBackend extends FakePenpotBackend implements PenpotBackend {
    /** Lets the held write run. */
    public release: () => void = () => undefined;

    /** Resolves when the held write has reached the backend, so that later calls queue behind it. */
    public readonly arrived: Promise<void>;

    private arriveNow: () => void = () => undefined;

    private held = true;

    private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve;
    });

    public constructor() {
        super();
        this.arrived = new Promise<void>((resolve) => {
            this.arriveNow = resolve;
        });
    }

    public override async callCommand<T = unknown>(
        userToken: string,
        name: string,
        params: object,
        options?: RpcCallOptions
    ): Promise<T> {
        if (name === "mcp-apply-operations" && this.held) {
            this.held = false;
            this.arriveNow();
            await this.gate;
        }
        return super.callCommand<T>(userToken, name, params, options);
    }
}

const TOKEN = "frank-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000031";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000032";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000033";

/** The token catalogue of the test file, as `get-mcp-tokens` answers it. */
const CATALOGUE = {
    sets: [{ id: "set-base", name: "Base", active: true }],
    themes: [],
    tokens: [
        { setId: "set-base", name: "color.brand", type: "color", value: "#ff8800" },
        { setId: "set-base", name: "spacing.base", type: "spacing", value: "8px" },
        { setId: "set-base", name: "spacing.large", type: "spacing", value: "{spacing.base} * 3" },
    ],
    activeThemes: [],
    activeSets: ["set-base"],
};

/** A server stub whose only job is to return the request session. */
function sessionServer(): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** Builds the tool on a fake backend that accepts the token, answers the catalogue and echoes each write. */
function harness() {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read", "mcp:write"] })
        .respond("get-mcp-tokens", CATALOGUE)
        .respond("mcp-apply-operations", { revn: 3, createdIds: {}, warnings: [{ kind: "revn-lag" }] });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    return { backend, tool: new ApplyOperationsTool(sessionServer(), services) };
}

/** Builds an `apply_token` operation for the test shape. */
function applyToken(tokenName: string, attributes: string[], resolvedValue?: unknown): Record<string, unknown> {
    const operation: Record<string, unknown> = {
        op: "apply_token",
        pageId: PAGE,
        shapeIds: [SHAPE],
        tokenName,
        attributes,
    };
    if (resolvedValue !== undefined) {
        operation.resolvedValue = resolvedValue;
    }
    return operation;
}

/** Returns the text of a text response. */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/** Returns the operations of the only write the backend received. */
function sentOperations(backend: FakePenpotBackend): Array<Record<string, unknown>> {
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1);
    return (writes[0].params as { operations: Array<Record<string, unknown>> }).operations;
}

test("apply_token without resolvedValue sends the value of a plain token", async () => {
    const { backend, tool } = harness();

    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])] });

    assert.equal(sentOperations(backend)[0].resolvedValue, "#ff8800");
    assert.deepEqual(backend.callsTo("get-mcp-tokens")[0]?.params, { fileId: FILE });
});

test("apply_token without resolvedValue sends the value of a token that references another", async () => {
    const { backend, tool } = harness();

    await tool.execute({
        fileId: FILE,
        operations: [applyToken("spacing.base", ["width"]), applyToken("spacing.large", ["height"])],
    });

    assert.deepEqual(
        sentOperations(backend).map((operation) => operation.resolvedValue),
        [8, 24]
    );
    assert.equal(backend.callsTo("get-mcp-tokens").length, 1, "the catalogue is read once per call");
});

test("a caller value that differs from the token's value is kept and reported in the warnings", async () => {
    const { backend, tool } = harness();

    const response = await tool.execute({
        fileId: FILE,
        operations: [applyToken("spacing.base", ["width"], 10)],
    });

    assert.equal(sentOperations(backend)[0].resolvedValue, 10);
    const body = JSON.parse(textOf(response));
    assert.equal(body.revn, 3);
    assert.equal(body.warnings.length, 2);
    assert.deepEqual(body.warnings[0], { kind: "revn-lag" });
    assert.equal(body.warnings[1].kind, "token-value-differs");
    assert.equal(body.warnings[1].operationIndex, 0);
    assert.equal(body.warnings[1].suppliedValue, 10);
    assert.equal(body.warnings[1].resolvedValue, 8);
});

test("a caller value equal to the token's value leaves the result as the backend sent it", async () => {
    const { tool } = harness();

    const response = await tool.execute({ fileId: FILE, operations: [applyToken("spacing.base", ["width"], 8)] });

    assert.deepEqual(JSON.parse(textOf(response)), { revn: 3, createdIds: {}, warnings: [{ kind: "revn-lag" }] });
});

test("an unknown token fails the call before any write", async () => {
    const { backend, tool } = harness();

    const response = await tool.execute({ fileId: FILE, operations: [applyToken("spacing.huge", ["width"])] });

    assert.equal(response.isError, true);
    assert.match(
        textOf(response),
        /apply_operations: operation 0 \(apply_token\) cannot resolve token "spacing\.huge": token "spacing\.huge" was not found in the file\. Fix the token, or pass resolvedValue/
    );
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("a call without apply_token reads no token catalogue", async () => {
    const { backend, tool } = harness();

    await tool.execute({
        fileId: FILE,
        operations: [{ op: "create_rect", pageId: PAGE, id: "$tmp:r", x: 0, y: 0, width: 10, height: 10 }],
    });

    assert.deepEqual(
        backend.calls.map((call) => call.name),
        ["mcp-whoami", "mcp-apply-operations"]
    );
});

// ── Write queue, catalogue cache, requestId and cancellation ──

/** A request id of the kind a client keeps for a retry. */
const RETRY_ID = "5f0c4f7e-7a3b-4c1d-9e2f-0a1b2c3d4e5f";

/** A plain rectangle operation that needs no token. */
const RECT_OPERATION = { op: "create_rect", pageId: PAGE, id: "$tmp:r", x: 0, y: 0, width: 10, height: 10 };

/** A UUID version 4 pattern, which the write ids follow. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Waits long enough for calls that are queued to reach the point where they wait. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

/** The token catalogue of the test file with a different value for color.brand. */
function catalogueWithBrand(value: string) {
    return { ...CATALOGUE, tokens: [{ ...CATALOGUE.tokens[0], value }, ...CATALOGUE.tokens.slice(1)] };
}

/** Builds the tool on a held-write backend that answers like the harness. */
function heldHarness(brand: () => string) {
    const backend = new HeldWriteBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read", "mcp:write"] })
        .respond("get-mcp-tokens", () => catalogueWithBrand(brand()))
        .respond("mcp-apply-operations", { revn: 4, createdIds: {} });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    return { backend, tool: new ApplyOperationsTool(sessionServer(), services) };
}

test("an apply_token call queued behind a token write reads the catalogue after that write", async () => {
    let brand = "#ff8800";
    const { backend, tool } = heldHarness(() => brand);
    const tokenWrite = tool.execute({
        fileId: FILE,
        operations: [{ op: "update_token", setId: "set-base", id: "token-brand", value: "#00ff00" }],
    });
    // the token write must reach the queue first, so wait until it holds the file
    await backend.arrived;
    const shapeWrite = tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])] });
    await settle();
    assert.equal(backend.callsTo("get-mcp-tokens").length, 0, "the apply waits behind the token write");
    brand = "#00ff00";
    backend.release();
    await Promise.all([tokenWrite, shapeWrite]);
    const applies = backend.callsTo("mcp-apply-operations");
    assert.equal(applies.length, 2);
    const sent = (applies[1].params as { operations: Array<{ resolvedValue?: unknown }> }).operations;
    assert.equal(sent[0].resolvedValue, "#00ff00");
});

test("the token catalogue is read once for dry runs, which leave the file as it is", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])], dryRun: true });
    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])], dryRun: true });
    assert.equal(backend.callsTo("get-mcp-tokens").length, 1);
});

test("a write to the file makes the next apply_token call read the catalogue again", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])] });
    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])] });
    assert.equal(backend.callsTo("get-mcp-tokens").length, 2);
});

test("every write names itself with a requestId, and a caller's requestId is sent as given", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, operations: [RECT_OPERATION] });
    await tool.execute({ fileId: FILE, operations: [RECT_OPERATION], requestId: RETRY_ID });
    const [first, second] = backend
        .callsTo("mcp-apply-operations")
        .map((call) => (call.params as { requestId: string }).requestId);
    assert.match(first, UUID_PATTERN);
    assert.equal(second, RETRY_ID);
});

test("a write that an earlier call with the same requestId applied says so, and changed nothing", async () => {
    const { backend, tool } = harness();
    backend.respond("mcp-apply-operations", { revn: 3, createdIds: {}, alreadyApplied: true });
    const response = await tool.execute({ fileId: FILE, operations: [RECT_OPERATION], requestId: RETRY_ID });
    const body = JSON.parse(textOf(response)) as { alreadyApplied: boolean; note: string };
    assert.equal(body.alreadyApplied, true);
    assert.match(body.note, /already applied by an earlier call with the same requestId/);
});

test("a replay returns the createdIds and opResults of the first answer, with a note", async () => {
    const { backend, tool } = harness();
    const createdIds = { "$tmp:a": "6f1c9a0e-5b0f-4a52-9d3f-0c5a3d2e8b11" };
    const opResults = [null, { op: "replace_font", textsChanged: 2 }];
    backend.respond("mcp-apply-operations", { revn: 3, createdIds, opResults, alreadyApplied: true });
    const response = await tool.execute({ fileId: FILE, operations: [RECT_OPERATION], requestId: RETRY_ID });
    const body = JSON.parse(textOf(response)) as { createdIds: unknown; opResults: unknown; note: string };
    assert.deepEqual(body.createdIds, createdIds);
    assert.deepEqual(body.opResults, opResults);
    assert.match(body.note, /those of the first answer/);
});

test("the per-operation results of the backend reach the caller as they are", async () => {
    const { backend, tool } = harness();
    const opResults = [
        null,
        {
            op: "replace_font",
            textsChanged: 2,
            layoutDropped: 2,
            variantsUsed: [{ from: { weight: "700", style: "normal" }, to: { variantId: "normal-700" }, exact: true }],
            skipped: { total: 0, byReason: [], items: [], itemsTruncated: false },
        },
    ];
    backend.respond("mcp-apply-operations", { revn: 4, createdIds: {}, opResults });
    const response = await tool.execute({
        fileId: FILE,
        operations: [
            RECT_OPERATION,
            { op: "replace_font", pageId: PAGE, fromFontId: "gfont-access-sans", toFontId: "custom-1" },
        ],
    });
    const body = JSON.parse(textOf(response)) as { opResults: unknown };
    assert.deepEqual(body.opResults, opResults);
});

test("a write whose request is cancelled before its turn in the queue is not sent", async () => {
    const { backend, tool } = heldHarness(() => "#ff8800");
    const first = tool.execute({ fileId: FILE, operations: [RECT_OPERATION] });
    await backend.arrived;
    const controller = new AbortController();
    const second = tool.execute({ fileId: FILE, operations: [RECT_OPERATION] }, controller.signal);
    await settle();
    controller.abort();
    backend.release();
    await first;
    const response = await second;
    assert.equal(response.isError, true);
    assert.match(textOf(response), /The write was abandoned before it started/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1);
});

test("the token cache keeps one token set per file, never the MCP token, and stays within its capacity", async () => {
    const { tool } = harness();
    await tool.execute({ fileId: FILE, operations: [applyToken("color.brand", ["fill"])], dryRun: true });
    const cache = (tool as unknown as { tokenSets: TokenCatalogueCache }).tokenSets;
    assert.equal(cache.size, 1);
    const kept = (cache as unknown as { entries: Map<string, unknown> }).entries;
    assert.equal(JSON.stringify([...kept.entries()]).includes(TOKEN), false, "no MCP token in the cache");
    assert.ok(cache.size <= TokenCatalogueCache.DEFAULT_CAPACITY);
});
