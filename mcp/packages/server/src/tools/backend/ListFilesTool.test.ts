import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakePenpotBackend, type RecordedCall } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { ListFilesTool } from "./ListFilesTool";

const TOKEN = "alice-token";
const TEAM = "1b2c3d4e-0000-4000-8000-000000000001";

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
        contractVersion: 1,
        profileId: "profile-1",
        scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
    });
}

/** Builds a list_files tool on a fake backend. */
function toolFor(backend: FakePenpotBackend): ListFilesTool {
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    return new ListFilesTool(sessionServer(), services);
}

/** Returns the text of a text response. */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/** Returns the one call made to the named command, after checking it was made once. */
function onlyCall(backend: FakePenpotBackend, name: string): RecordedCall {
    const calls = backend.callsTo(name);
    assert.equal(calls.length, 1, `${name} is called once`);
    return calls[0];
}

/** Builds file search results numbered from one. */
function matches(count: number): { id: string; name: string }[] {
    return Array.from({ length: count }, (_, index) => ({ id: `f${index + 1}`, name: `File ${index + 1}` }));
}

test("list_files with a teamId and no query lists the recent files", async () => {
    const backend = acceptingBackend().respond("get-team-recent-files", [{ id: "f1" }]);

    await toolFor(backend).execute({ teamId: TEAM });

    assert.deepEqual(onlyCall(backend, "get-team-recent-files").params, { teamId: TEAM });
    assert.equal(backend.callsTo("search-files").length, 0);
});

test("list_files with a teamId and query searches the team", async () => {
    const backend = acceptingBackend().respond("search-files", []);

    await toolFor(backend).execute({ teamId: TEAM, query: "logo" });

    assert.deepEqual(onlyCall(backend, "search-files").params, { teamId: TEAM, searchTerm: "logo" });
    assert.equal(backend.callsTo("get-team-recent-files").length, 0);
});

test("list_files with deleted true lists the team trash", async () => {
    const backend = acceptingBackend().respond("get-team-deleted-files", []);

    await toolFor(backend).execute({ teamId: TEAM, deleted: true });

    assert.deepEqual(onlyCall(backend, "get-team-deleted-files").params, { teamId: TEAM });
});

test("list_files with a limit cuts the search matches and reports files, shown, total and note", async () => {
    const backend = acceptingBackend().respond("search-files", matches(5));

    const parsed = JSON.parse(textOf(await toolFor(backend).execute({ teamId: TEAM, query: "file", limit: 2 })));

    assert.deepEqual(parsed, {
        files: matches(5).slice(0, 2),
        shown: 2,
        total: 5,
        note: "Showing 2 of 5 files. Repeat the call with a larger limit, or narrow the request, to see the rest.",
    });
});

test("list_files without a limit keeps the first 100 files of a project listing and says how many exist", async () => {
    const backend = acceptingBackend().respond("get-project-files", matches(150));

    const parsed = JSON.parse(textOf(await toolFor(backend).execute({ projectId: TEAM })));

    assert.equal(parsed.files.length, 100);
    assert.equal(parsed.shown, 100);
    assert.equal(parsed.total, 150);
    assert.match(parsed.note, /Showing 100 of 150 files/);
});

test("list_files with a limit on a recent-files listing cuts it and says so", async () => {
    const backend = acceptingBackend().respond("get-team-recent-files", matches(3));

    const parsed = JSON.parse(textOf(await toolFor(backend).execute({ teamId: TEAM, limit: 1 })));

    assert.deepEqual(parsed.files, matches(1));
    assert.equal(parsed.total, 3);
});

test("list_files with a limit at or above the match count returns every match with an empty note", async () => {
    const backend = acceptingBackend().respond("search-files", matches(2));

    const parsed = JSON.parse(textOf(await toolFor(backend).execute({ teamId: TEAM, query: "file", limit: 2 })));

    assert.deepEqual(parsed, { files: matches(2), shown: 2, total: 2, note: "" });
});
