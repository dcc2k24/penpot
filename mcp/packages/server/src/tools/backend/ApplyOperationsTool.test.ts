import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { ApplyOperationsTool } from "./ApplyOperationsTool";

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
        .respond("mcp-whoami", { profileId: "profile-1", scopes: ["mcp:read", "mcp:write"] })
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
