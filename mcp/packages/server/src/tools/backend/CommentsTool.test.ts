import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { CommentsTool } from "./CommentsTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const FRAME = "1b2c3d4e-0000-4000-8000-000000000005";
const THREAD = "1b2c3d4e-0000-4000-8000-000000000006";
const ROOT = "00000000-0000-0000-0000-000000000000";
const POSITION = { x: 10, y: 20 };

/**
 * Builds the tool on a fake backend.
 *
 * @returns the tool and the fake backend that records its calls
 */
function harness() {
    const backend = new FakePenpotBackend().respond("mcp-whoami", {
        profileId: "profile-1",
        scopes: ["mcp:read"],
    });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
    return { backend, tool: new CommentsTool(server, services) };
}

test("create_thread without a frame pins the thread to the page background", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, action: "create_thread", pageId: PAGE, position: POSITION, content: "hi" });
    const calls = backend.callsTo("create-comment-thread");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, {
        fileId: FILE,
        pageId: PAGE,
        frameId: ROOT,
        position: POSITION,
        content: "hi",
    });
});

test("move without a frame sends the page background id", async () => {
    const { backend, tool } = harness();
    await tool.execute({ fileId: FILE, action: "move", threadId: THREAD, position: POSITION });
    const calls = backend.callsTo("update-comment-thread-position");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { id: THREAD, position: POSITION, frameId: ROOT });
});

test("an explicit frame is sent unchanged by create_thread and move", async () => {
    const { backend, tool } = harness();
    await tool.execute({
        fileId: FILE,
        action: "create_thread",
        pageId: PAGE,
        frameId: FRAME,
        position: POSITION,
        content: "hi",
    });
    await tool.execute({ fileId: FILE, action: "move", threadId: THREAD, frameId: FRAME, position: POSITION });
    const created = backend.callsTo("create-comment-thread")[0].params as { frameId: string };
    assert.equal(created.frameId, FRAME);
    const moved = backend.callsTo("update-comment-thread-position")[0].params as { frameId: string };
    assert.equal(moved.frameId, FRAME);
});
