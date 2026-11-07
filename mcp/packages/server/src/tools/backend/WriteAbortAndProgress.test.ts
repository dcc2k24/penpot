import assert from "node:assert/strict";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { BackendUpload, RpcCallOptions } from "../../PenpotBackendClient";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { CallContext, type CallContextData, type ProgressReporter } from "../../backend/CallContext";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { ExportShapeBackendTool } from "./ExportShapeBackendTool";
import { ImportArchiveBackendTool } from "./ImportArchiveBackendTool";
import { ManageFilesTool } from "./ManageFilesTool";

const TOKEN = "grace-token";
const TEAM = "1b2c3d4e-0000-4000-8000-000000000001";
const PROJECT = "1b2c3d4e-0000-4000-8000-000000000002";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const ROOT_A = "1b2c3d4e-0000-4000-8000-000000000011";
const ROOT_B = "1b2c3d4e-0000-4000-8000-000000000012";

/** A fake backend that records the abort signal that each call carries in its call context. */
class SignalRecordingBackend extends FakePenpotBackend {
    /** Name and the signal of each call, in order. */
    public readonly seen: Array<{ name: string; signal: AbortSignal | undefined }> = [];

    public override async callCommand<T = unknown>(
        userToken: string,
        name: string,
        params: object,
        options?: RpcCallOptions
    ): Promise<T> {
        this.seen.push({ name, signal: CallContext.current()?.signal });
        return super.callCommand<T>(userToken, name, params, options);
    }

    public override async callMultipart<T = unknown>(
        userToken: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[],
        options?: RpcCallOptions
    ): Promise<T> {
        this.seen.push({ name, signal: CallContext.current()?.signal });
        return super.callMultipart<T>(userToken, name, fields, uploads, options);
    }

    /** Returns the signal that a named call carried. */
    public signalOf(name: string): AbortSignal | undefined {
        const found = this.seen.find((entry) => entry.name === name);
        assert.ok(found, `${name} was called`);
        return found.signal;
    }
}

/** A server stub that answers only the questions the tools ask. */
function serverStub(): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** A backend that accepts the token and answers the commands of these tests. */
function backendWithAnswers(): SignalRecordingBackend {
    return new SignalRecordingBackend()
        .respond("mcp-whoami", {
            contractVersion: 1,
            profileId: "profile-1",
            scopes: ["mcp:read", "mcp:write", "mcp:manage"],
        })
        .respond("import-binfile", { fileIds: [FILE] })
        .respond("create-team", { id: TEAM })
        .respond("rename-file", { id: FILE });
}

/** Services over a backend, with the default exporter. */
function servicesFor(backend: SignalRecordingBackend): BackendServices {
    return new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
}

/** A zip signature, which is all that an archive upload is checked for before it is sent. */
const ZIP_BASE64 = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64");

/**
 * Runs a tool body inside a call context that carries a progress callback, as the MCP layer does.
 *
 * @param progress - the callback the call context carries
 * @param body - the work to run
 */
function withProgress<T>(progress: ProgressReporter, body: () => Promise<T>): Promise<T> {
    // a variable, not a literal, so the context type may carry the progress field
    const context: CallContextData = { requestId: "request-1", progress };
    return CallContext.run(context, body);
}

test("import_archive sends the import without the abort signal of the call", async () => {
    const backend = backendWithAnswers();
    const controller = new AbortController();
    await new ImportArchiveBackendTool(serverStub(), servicesFor(backend)).execute(
        { projectId: PROJECT, base64: ZIP_BASE64 },
        controller.signal
    );
    assert.equal(backend.signalOf("import-binfile"), undefined);
});

test("a manage_files action without a file id sends the write without the abort signal", async () => {
    const backend = backendWithAnswers();
    const controller = new AbortController();
    await new ManageFilesTool(serverStub(), servicesFor(backend)).execute(
        { action: "create_team", name: "Design" },
        controller.signal
    );
    assert.equal(backend.signalOf("create-team"), undefined);
});

test("a queued manage_files write on a file runs without the abort signal once it starts", async () => {
    const backend = backendWithAnswers();
    const controller = new AbortController();
    await new ManageFilesTool(serverStub(), servicesFor(backend)).execute(
        { action: "rename_file", fileId: FILE, name: "Renamed" },
        controller.signal
    );
    assert.equal(backend.signalOf("rename-file"), undefined);
});

test("import_archive reports progress before the upload and after the backend answers", async () => {
    const backend = backendWithAnswers();
    const steps: Array<[number, number | undefined]> = [];
    const tool = new ImportArchiveBackendTool(serverStub(), servicesFor(backend));
    // the protected entry point runs inside the call context that the MCP layer sets up
    const run = (tool as unknown as { executeBackend(args: object, token: string): Promise<unknown> }).executeBackend;
    await withProgress(
        async (step, total) => {
            steps.push([step, total]);
        },
        () => run.call(tool, { projectId: PROJECT, base64: ZIP_BASE64 }, TOKEN)
    );
    assert.deepEqual(steps, [
        [1, 2],
        [2, 2],
    ]);
});

test("a page export reports progress after each rendered shape", async () => {
    const backend = backendWithAnswers().respond("create-mcp-render-session", {
        token: "rs-1",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    backend.respond("get-mcp-page-tree", {
        revn: 1,
        pageId: PAGE,
        root: {
            id: "00000000-0000-0000-0000-000000000000",
            type: "root",
            childCount: 2,
            children: [
                { id: ROOT_A, name: "A", type: "frame", childCount: 0, children: [] },
                { id: ROOT_B, name: "B", type: "frame", childCount: 0, children: [] },
            ],
        },
        truncated: false,
    });
    const tool = new ExportShapeBackendTool(serverStub(), servicesFor(backend));
    const steps: Array<[number, number | undefined]> = [];
    const run = (tool as unknown as { executeBackend(args: object, token: string): Promise<unknown> }).executeBackend;
    await withProgress(
        async (step, total) => {
            steps.push([step, total]);
        },
        () => run.call(tool, { fileId: FILE, pageId: PAGE, shapeId: "page" }, TOKEN)
    );
    assert.deepEqual(steps, [
        [1, 2],
        [2, 2],
    ]);
});

test("a call without a progress callback reports nothing and still succeeds", async () => {
    const backend = backendWithAnswers();
    const response = await new ImportArchiveBackendTool(serverStub(), servicesFor(backend)).execute({
        projectId: PROJECT,
        base64: ZIP_BASE64,
    });
    assert.equal(response.isError, undefined);
});
