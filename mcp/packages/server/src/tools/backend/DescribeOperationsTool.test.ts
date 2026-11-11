import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { DescribeOperationsTool } from "./DescribeOperationsTool";
import { OPERATION_NAMES, OPERATION_RULES, OPERATION_SCHEMA_BY_NAME } from "./operations/OperationSchemas";

const TOKEN = "dana-token";

/** A server stub whose only job is to return the request session. */
function sessionServer(): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** Builds the tool on a fake backend that accepts the token. */
function toolFor(): DescribeOperationsTool {
    const backend = new FakePenpotBackend().respond("mcp-whoami", {
        contractVersion: 1,
        profileId: "profile-1",
        scopes: ["mcp:read"],
    });
    return new DescribeOperationsTool(
        sessionServer(),
        new BackendServices(backend, new BackendSettings(), new FakeExporterClient())
    );
}

/** Returns the parsed JSON text of a response. */
function bodyOf(response: ToolResponse): { operations: Record<string, unknown>; rules: Record<string, string> } {
    return JSON.parse((response.content[0] as { text: string }).text) as {
        operations: Record<string, unknown>;
        rules: Record<string, string>;
    };
}

test("describe_operations returns the JSON Schema of each named op", async () => {
    const body = bodyOf(await toolFor().execute({ ops: ["create_text", "set_text_style"] }));
    assert.deepEqual(Object.keys(body.operations), ["create_text", "set_text_style"]);
    const createText = body.operations.create_text as { properties: Record<string, unknown>; required: string[] };
    assert.ok("characters" in createText.properties, "create_text names its characters parameter");
    assert.ok(createText.required.includes("op"));
});

test("describe_operations describes replace_font with its limits", async () => {
    const body = bodyOf(await toolFor().execute({ ops: ["replace_font"] }));
    const schema = body.operations.replace_font as {
        properties: Record<string, { maximum?: number; minimum?: number; enum?: string[] }>;
        required: string[];
    };
    assert.deepEqual([...schema.required].sort(), ["fromFontId", "op", "pageId", "toFontId"]);
    assert.deepEqual(schema.properties.variantMatch.enum, ["exact", "nearest"]);
    assert.equal(schema.properties.maxTexts.minimum, 1);
    assert.equal(schema.properties.maxTexts.maximum, 2000);
});

test("describe_operations sends the rules that span ops, with the font, token, override and index texts", async () => {
    const body = bodyOf(await toolFor().execute({ ops: ["set_text"] }));
    assert.deepEqual(Object.keys(body.rules).sort(), [
        "childIndex",
        "fontStyle",
        "fontVariantId",
        "fontWeight",
        "overrides",
        "tokenType",
    ]);
    assert.match(body.rules.fontVariantId, /sourcesanspro/);
    assert.match(body.rules.childIndex, /visual/);
});

test("describe_operations names every unknown op and the valid ones", async () => {
    const response = await toolFor().execute({ ops: ["create_rect", "make_coffee"] });
    assert.equal(response.isError, true);
    const text = (response.content[0] as { text: string }).text;
    assert.match(text, /unknown op "make_coffee"/);
    assert.match(text, /Valid ops: .*create_rect/);
});

test("every op has a parameter schema that converts to JSON Schema", () => {
    for (const name of OPERATION_NAMES) {
        const converted = z.toJSONSchema(OPERATION_SCHEMA_BY_NAME[name], { io: "input" });
        assert.equal(typeof converted, "object", `${name} converts`);
    }
    assert.ok(Object.keys(OPERATION_RULES).length >= 6);
});
