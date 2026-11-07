import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { GetTokensArgs, GetTokensTool } from "./GetTokensTool";

const TOKEN = "heidi-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const SET = "1b2c3d4e-0000-4000-8000-00000000000b";

/** A server stub that returns the request session. */
function sessionServer(): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** Builds the tool on a fake backend that accepts the token. */
function toolAndBackend() {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("get-mcp-tokens", { sets: [], themes: [], tokens: [] });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    return { backend, tool: new GetTokensTool(sessionServer(), services) };
}

test("get_tokens asks for the tokens format when none is named, and for every set", async () => {
    const { backend, tool } = toolAndBackend();
    await tool.execute({ fileId: FILE });
    assert.deepEqual(backend.callsTo("get-mcp-tokens")[0].params, { fileId: FILE, format: "tokens" });
});

test("get_tokens passes a set id and the dtcg format through", async () => {
    const { backend, tool } = toolAndBackend();
    await tool.execute({ fileId: FILE, setId: SET, format: "dtcg" });
    assert.deepEqual(backend.callsTo("get-mcp-tokens")[0].params, { fileId: FILE, setId: SET, format: "dtcg" });
});

test("the schema accepts only tokens or dtcg as the format, and a UUID as the set id", () => {
    const schema = z.object(GetTokensArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, format: "both" }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, setId: "not-a-uuid" }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, setId: SET, format: "dtcg" }).success, true);
});
