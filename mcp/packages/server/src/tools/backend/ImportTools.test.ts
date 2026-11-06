import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendUpload } from "../../PenpotBackendClient";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakePenpotBackend, type RecordedCall } from "../../backend/testing/FakePenpotBackend";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { ImportArchiveBackendTool } from "./ImportArchiveBackendTool";
import { ImportImageBackendTool } from "./ImportImageBackendTool";
import { ImportSvgBackendTool } from "./ImportSvgBackendTool";

const TOKEN = "alice-token";
const PROJECT = "1b2c3d4e-0000-4000-8000-000000000002";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000005";
const OTHER_PAGE = "1b2c3d4e-0000-4000-8000-00000000000a";
const MEDIA = "1b2c3d4e-0000-4000-8000-0000000000b1";

/** A 1x1 PNG signature, enough for the type detection. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_BASE64 = PNG.toString("base64");

/** The media object that the backend returns for the upload. */
const MEDIA_ANSWER = { id: MEDIA, name: "logo.png", width: 200, height: 100, mtype: "image/png" };

/** A server stub with the session and the file system switch that the tools read. */
function serverStub(fileSystemAccess: boolean): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => fileSystemAccess,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
}

/** Builds a fake backend that answers every command the import tools use, and the services around it. */
function harness(fileSystemAccess = true) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", {
            profileId: "profile-1",
            scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
        })
        .respond("get-mcp-file-outline", {
            pages: [
                { id: PAGE, name: "Page 1" },
                { id: OTHER_PAGE, name: "Page 2" },
            ],
        })
        .respond("upload-file-media-object", MEDIA_ANSWER)
        .respond("create-file-media-object-from-url", MEDIA_ANSWER)
        .respond("mcp-apply-operations", { revn: 7, createdIds: { "$tmp:image": SHAPE } })
        .respond("mcp-import-svg", { revn: 4, rootId: SHAPE, shapeIds: [SHAPE], changeCount: 3 })
        .respond("import-binfile", { "file-ids": [FILE] });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    return { backend, services, server: serverStub(fileSystemAccess) };
}

/** Returns the text of a text response. */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/** Returns the last call to a command, failing the test when there is none. */
function lastCall(backend: FakePenpotBackend, name: string): RecordedCall {
    const calls = backend.callsTo(name);
    const call = calls[calls.length - 1];
    assert.ok(call, `a call to ${name}`);
    return call;
}

/** Returns the first file part of a multipart call, failing the test when there is none. */
function filePartOf(call: RecordedCall): BackendUpload {
    const part = call.uploads?.[0];
    assert.ok(part, "a file part");
    return part;
}

/** Returns the one operation of the last `mcp-apply-operations` call. */
function createdOperation(backend: FakePenpotBackend): Record<string, unknown> {
    const params = lastCall(backend, "mcp-apply-operations").params as { operations: Record<string, unknown>[] };
    return params.operations[0];
}

/** Returns the JSON object of a text response. */
function jsonOf(response: ToolResponse): Record<string, unknown> {
    return JSON.parse(textOf(response)) as Record<string, unknown>;
}

// ── import_image: sources and uploads ──

test("import_image uploads a base64 PNG and places it as an image shape", async () => {
    const { backend, services, server } = harness();
    const tool = new ImportImageBackendTool(server, services);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, base64: PNG_BASE64, name: "logo.png" });

    const uploads = backend.callsTo("upload-file-media-object");
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].fields, { "file-id": FILE, "is-local": "true", name: "logo.png" });
    const part = filePartOf(uploads[0]);
    assert.equal(part.fieldName, "content");
    assert.equal(part.mimeType, "image/png");
    assert.deepEqual(Buffer.from(part.content), PNG);

    assert.deepEqual(createdOperation(backend), {
        op: "create_image",
        id: "$tmp:image",
        pageId: PAGE,
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        mediaId: MEDIA,
        mediaWidth: 200,
        mediaHeight: 100,
        mediaMtype: "image/png",
        name: "logo.png",
    });
    assert.deepEqual(jsonOf(response), {
        mediaId: MEDIA,
        width: 200,
        height: 100,
        mtype: "image/png",
        shapeId: SHAPE,
        revn: 7,
    });
});

test("import_image accepts a data URL with the same bytes as plain base64", async () => {
    const { backend, services, server } = harness();
    const tool = new ImportImageBackendTool(server, services);
    await tool.execute({ fileId: FILE, pageId: PAGE, base64: `data:image/png;base64,${PNG_BASE64}` });
    assert.deepEqual(Buffer.from(filePartOf(lastCall(backend, "upload-file-media-object")).content), PNG);
});

test("import_image with a width only keeps the aspect ratio", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        base64: PNG_BASE64,
        width: 50,
    });
    const op = createdOperation(backend);
    assert.equal(op.width, 50);
    assert.equal(op.height, 25);
});

test("import_image with a height only keeps the aspect ratio", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        base64: PNG_BASE64,
        height: 40,
    });
    const op = createdOperation(backend);
    assert.equal(op.width, 80);
    assert.equal(op.height, 40);
});

test("import_image uses width and height as given when both are set", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        base64: PNG_BASE64,
        width: 50,
        height: 10,
    });
    const op = createdOperation(backend);
    assert.equal(op.width, 50);
    assert.equal(op.height, 10);
});

test("import_image uses the media size when neither width nor height is set", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({ fileId: FILE, pageId: PAGE, base64: PNG_BASE64 });
    const op = createdOperation(backend);
    assert.equal(op.width, 200);
    assert.equal(op.height, 100);
});

test("import_image with a url asks the backend to download it and uploads nothing", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        url: "https://example.com/logo.png",
    });
    assert.deepEqual(lastCall(backend, "create-file-media-object-from-url").params, {
        fileId: FILE,
        isLocal: true,
        url: "https://example.com/logo.png",
    });
    assert.equal(backend.callsTo("upload-file-media-object").length, 0);
    assert.equal(jsonOf(response).shapeId, SHAPE);
});

test("import_image refuses a url that is not http or https", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        url: "ftp://example.com/logo.png",
    });
    assert.match(textOf(response), /must start with http:\/\/ or https:\/\//);
    assert.equal(backend.callsTo("create-file-media-object-from-url").length, 0);
});

test("import_image with createShape false uploads the image and creates no shape", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        base64: PNG_BASE64,
        createShape: false,
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
    const body = jsonOf(response);
    assert.equal(body.mediaId, MEDIA);
    assert.equal("shapeId" in body, false);
    assert.equal("revn" in body, false);
});

test("import_image without a pageId places the shape on the first page of the file", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({ fileId: FILE, base64: PNG_BASE64 });
    assert.equal(backend.callsTo("get-mcp-file-outline").length, 1);
    assert.equal(createdOperation(backend).pageId, PAGE);
});

test("import_image rejects bytes of an unknown type when no mimeType is given", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        base64: Buffer.from("hello").toString("base64"),
    });
    assert.match(textOf(response), /Unsupported image format/);
    assert.equal(backend.callsTo("upload-file-media-object").length, 0);
});

test("import_image uses the mimeType argument when the bytes do not show their type", async () => {
    const { backend, services, server } = harness();
    await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        base64: Buffer.from("hello").toString("base64"),
        mimeType: "image/gif",
    });
    const part = filePartOf(lastCall(backend, "upload-file-media-object"));
    assert.equal(part.mimeType, "image/gif");
    assert.equal(part.fileName, "image.gif");
});

test("import_image refuses a request with two sources", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        base64: PNG_BASE64,
        url: "https://example.com/logo.png",
    });
    assert.match(textOf(response), /Give exactly one of base64, url or filePath/);
    assert.equal(backend.callsTo("upload-file-media-object").length, 0);
    assert.equal(backend.callsTo("create-file-media-object-from-url").length, 0);
});

test("import_image refuses a request with no source", async () => {
    const { services, server } = harness();
    const response = await new ImportImageBackendTool(server, services).execute({ fileId: FILE });
    assert.match(textOf(response), /Give exactly one of base64, url or filePath/);
});

// ── import_image: local file paths ──

test("import_image reads a file path and names the upload after the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-image-"));
    try {
        const filePath = path.join(dir, "photo.png");
        fs.writeFileSync(filePath, PNG);
        const { backend, services, server } = harness(true);
        await new ImportImageBackendTool(server, services).execute({ fileId: FILE, pageId: PAGE, filePath });
        const upload = lastCall(backend, "upload-file-media-object");
        assert.deepEqual(upload.fields, { "file-id": FILE, "is-local": "true", name: "photo.png" });
        assert.equal(filePartOf(upload).fileName, "photo.png");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("import_image refuses a relative file path", async () => {
    const { backend, services, server } = harness(true);
    const response = await new ImportImageBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        filePath: "logo.png",
    });
    assert.match(textOf(response), /must be absolute/);
    assert.equal(backend.callsTo("upload-file-media-object").length, 0);
});

test("import_image reports a missing file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-image-"));
    try {
        const { services, server } = harness(true);
        const missing = path.join(dir, "missing.png");
        const response = await new ImportImageBackendTool(server, services).execute({
            fileId: FILE,
            filePath: missing,
        });
        assert.match(textOf(response), /File not found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("import_image has no filePath in its schema when file system access is off", () => {
    const { services } = harness();
    const enabled = new ImportImageBackendTool(serverStub(true), services);
    const disabled = new ImportImageBackendTool(serverStub(false), services);
    assert.equal("filePath" in enabled.getInputSchema(), true);
    assert.equal("filePath" in disabled.getInputSchema(), false);
});

// ── import_svg ──

test("import_svg sends only the set fields and returns the backend answer", async () => {
    const { backend, services, server } = harness();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    const response = await new ImportSvgBackendTool(server, services).execute({
        fileId: FILE,
        pageId: PAGE,
        svg,
        x: 10,
        name: "icon",
    });
    assert.deepEqual(lastCall(backend, "mcp-import-svg").params, {
        fileId: FILE,
        pageId: PAGE,
        svg,
        x: 10,
        name: "icon",
    });
    assert.equal(
        textOf(response),
        JSON.stringify({ revn: 4, rootId: SHAPE, shapeIds: [SHAPE], changeCount: 3 }, null, 2)
    );
});

// ── import_archive ──

test("import_archive uploads a base64 archive and returns the new file ids", async () => {
    const { backend, services, server } = harness();
    // a .penpot archive is a zip file, so the bytes start with the zip signature
    const archive = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("penpot-archive-bytes")]);
    const response = await new ImportArchiveBackendTool(server, services).execute({
        projectId: PROJECT,
        base64: archive.toString("base64"),
        name: "Team kit",
    });
    const call = lastCall(backend, "import-binfile");
    assert.deepEqual(call.fields, { name: "Team kit", "project-id": PROJECT, version: "3" });
    const part = filePartOf(call);
    assert.equal(part.fieldName, "file");
    assert.equal(part.fileName, "archive.penpot");
    assert.deepEqual(Buffer.from(part.content), archive);
    assert.deepEqual(jsonOf(response), { fileIds: [FILE] });
});

test("import_archive refuses a url that resolves to loopback, without any request to it", async () => {
    const { backend, services, server } = harness();
    let served = false;
    const archiveServer = http.createServer((_request, response) => {
        served = true;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.alloc(16, 7));
    });
    await new Promise<void>((resolve) => archiveServer.listen(0, "127.0.0.1", resolve));
    try {
        const port = (archiveServer.address() as AddressInfo).port;
        const response = await new ImportArchiveBackendTool(server, services).execute({
            projectId: PROJECT,
            url: `http://127.0.0.1:${port}/archive.penpot`,
        });
        assert.match(textOf(response), /private, loopback or link-local address/);
        assert.equal(served, false);
        assert.equal(backend.callsTo("import-binfile").length, 0);
    } finally {
        archiveServer.closeAllConnections();
        await new Promise<void>((resolve) => archiveServer.close(() => resolve()));
    }
});

test("import_archive refuses bytes that are not a zip archive before any upload", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportArchiveBackendTool(server, services).execute({
        projectId: PROJECT,
        base64: Buffer.from("not a zip file").toString("base64"),
    });
    assert.match(textOf(response), /not a \.penpot archive/);
    assert.equal(backend.callsTo("import-binfile").length, 0);
});

test("import_archive has no url in its schema in remote mode", () => {
    const { services } = harness();
    const remote = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => true,
    } as unknown as PenpotMcpServer;
    const schema = new ImportArchiveBackendTool(remote, services).getInputSchema();
    assert.equal("url" in schema, false);
    assert.equal("base64" in schema, true);
});

test("import_archive refuses a url that is not http or https", async () => {
    const { backend, services, server } = harness();
    const response = await new ImportArchiveBackendTool(server, services).execute({
        projectId: PROJECT,
        url: "ftp://example.com/archive.penpot",
    });
    assert.match(textOf(response), /must start with http:\/\/ or https:\/\//);
    assert.equal(backend.callsTo("import-binfile").length, 0);
});

test("import_archive has no filePath in its schema when file system access is off", () => {
    const { services } = harness();
    const enabled = new ImportArchiveBackendTool(serverStub(true), services);
    const disabled = new ImportArchiveBackendTool(serverStub(false), services);
    assert.equal("filePath" in enabled.getInputSchema(), true);
    assert.equal("filePath" in disabled.getInputSchema(), false);
});

// ── names and schema documentation ──

test("the import tools are named import_image, import_svg and import_archive", () => {
    const { services, server } = harness();
    assert.equal(new ImportImageBackendTool(server, services).getToolName(), "import_image");
    assert.equal(new ImportSvgBackendTool(server, services).getToolName(), "import_svg");
    assert.equal(new ImportArchiveBackendTool(server, services).getToolName(), "import_archive");
});

test("every field of the import tools has a description", () => {
    const { services, server } = harness();
    const tools = [
        new ImportImageBackendTool(server, services),
        new ImportSvgBackendTool(server, services),
        new ImportArchiveBackendTool(server, services),
    ];
    for (const tool of tools) {
        for (const [field, schema] of Object.entries(tool.getInputSchema())) {
            assert.ok(
                (schema as { description?: string }).description,
                `${tool.getToolName()}.${field} has a description`
            );
        }
    }
});

test("import_image refuses a file that is not an image before any upload", async () => {
    const { backend, services, server } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-image-"));
    try {
        const file = path.join(dir, "notes.txt");
        fs.writeFileSync(file, "plain text, not an image");
        const response = await new ImportImageBackendTool(server, services).execute({ fileId: FILE, filePath: file });
        assert.match(textOf(response), /not a PNG, JPEG, GIF or WEBP image/);
        assert.equal(backend.callsTo("upload-file-media-object").length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
