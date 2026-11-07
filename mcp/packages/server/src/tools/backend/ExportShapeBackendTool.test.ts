import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { ExporterError } from "../../backend/ExporterClient";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { ExportShapeBackendTool } from "./ExportShapeBackendTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000005";
const MEDIA = "1b2c3d4e-0000-4000-8000-000000000010";
const NIL = "00000000-0000-0000-0000-000000000000";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = new Uint8Array([255, 216, 255, 224]);
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';

/** One content item of a tool response, read loosely for the assertions. */
interface ContentItem {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
}

/**
 * Builds the tool on a fake backend and a fake exporter.
 *
 * @param fsEnabled - whether the server offers file system access
 */
function harness(fsEnabled = false) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("create-mcp-render-session", {
            token: "rs-1",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
        .respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect" }], missing: [] });
    const exporter = new FakeExporterClient();
    const services = new BackendServices(backend, new BackendSettings(), exporter);
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => fsEnabled,
    } as unknown as PenpotMcpServer;
    const tool = new ExportShapeBackendTool(server, services);
    return { backend, exporter, tool };
}

/**
 * Returns one content item of a tool response.
 *
 * @param response - the tool response
 * @param index - position of the item
 */
function contentOf(response: ToolResponse, index = 0): ContentItem {
    return response.content[index] as ContentItem;
}

/**
 * Returns the text of the first content item of a tool response.
 *
 * @param response - the tool response
 */
function textOf(response: ToolResponse): string {
    return contentOf(response).text ?? "";
}

/** Arguments of a shape export of the test shape, in png. */
const shapeArgs = { fileId: FILE, pageId: PAGE, shapeId: SHAPE };

/** Arguments of a fill export of the test shape. */
const fillArgs = { fileId: FILE, pageId: PAGE, shapeId: SHAPE, mode: "fill" };

test("a png shape returns one image block with the exporter bytes", async () => {
    const { exporter, tool } = harness();
    exporter.respondExport({ bytes: PNG, mimeType: "image/png" });
    const response = await tool.execute(shapeArgs);
    assert.equal(response.content.length, 1);
    assert.equal(contentOf(response).type, "image");
    assert.equal(contentOf(response).mimeType, "image/png");
    assert.equal(contentOf(response).data, Buffer.from(PNG).toString("base64"));
    assert.deepEqual(exporter.exports, [
        {
            renderToken: "rs-1",
            request: {
                fileId: FILE,
                pageId: PAGE,
                objectId: SHAPE,
                format: "png",
                scale: 1,
                profileId: "profile-1",
                name: "export",
            },
        },
    ]);
});

/** A shape id for the n-th root shape of a page in the tests. */
function rootId(n: number): string {
    return `1b2c3d4e-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Answers a page tree with the given root shapes, in page order.
 *
 * @param children - the root shapes, each with its id and name
 * @param childCount - the number of root shapes the page holds, when it is more than the children listed
 */
function pageTree(children: Array<{ id: string; name: string }>, childCount = children.length) {
    return {
        revn: 1,
        pageId: PAGE,
        root: {
            id: NIL,
            type: "root",
            childCount,
            children: children.map((child) => ({ ...child, type: "frame", childCount: 0, children: [] })),
        },
        truncated: false,
    };
}

/** Arguments of a page export in png. */
const pageArgs = { fileId: FILE, pageId: PAGE, shapeId: "page" };

test("a page exports each root shape in page order and returns one image per shape", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
        ])
    );
    exporter.respondExport({ bytes: PNG, mimeType: "image/png" });
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, undefined);
    assert.deepEqual(backend.callsTo("get-mcp-page-tree")[0].params, {
        fileId: FILE,
        pageId: PAGE,
        depth: 2,
        limit: 5000,
        fields: ["name", "width", "height"],
    });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 0);
    assert.deepEqual(
        exporter.exports.map((call) => call.request.objectId),
        [rootId(1), rootId(2)]
    );
    assert.equal(exporter.exports[0].request.pageId, PAGE);
    assert.deepEqual(
        response.content.map((item) => item.type),
        ["text", "text", "image", "text", "image"]
    );
    assert.match(contentOf(response, 0).text ?? "", /exported 2 of 2 root shapes, in page order/);
    assert.match(contentOf(response, 1).text ?? "", new RegExp(`Shape ${rootId(1)} \\(frame\\) "Board A"`));
    assert.equal(contentOf(response, 2).mimeType, "image/png");
});

test("a page with no root shapes is refused before any export", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-page-tree", pageTree([]));
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /has no shapes to export/);
    assert.equal(exporter.exports.length, 0);
});

test("a page with more than 10 root shapes renders the first 10 and says how many it left out", async () => {
    const { backend, exporter, tool } = harness();
    const children = Array.from({ length: 12 }, (_, index) => ({ id: rootId(index + 1), name: `Board ${index}` }));
    backend.respond("get-mcp-page-tree", pageTree(children));
    const response = await tool.execute(pageArgs);
    assert.equal(exporter.exports.length, 10);
    assert.equal(exporter.exports[9].request.objectId, rootId(10));
    assert.match(textOf(response), /exported 10 of 12 root shapes/);
    assert.match(textOf(response), /Export the rest by id/);
});

test("a page with more root shapes than the list holds counts them from childCount", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-page-tree", pageTree([{ id: rootId(1), name: "Board" }], 3));
    const response = await tool.execute(pageArgs);
    assert.equal(exporter.exports.length, 1);
    assert.match(textOf(response), /exported 1 of 3 root shapes/);
});

test("a page stops before its images pass 8 MB in total", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
        ])
    );
    exporter.respondExport({ bytes: new Uint8Array(5 * 1024 * 1024), mimeType: "image/png" });
    const response = await tool.execute(pageArgs);
    assert.equal(exporter.exports.length, 2);
    assert.equal(response.content.filter((item) => item.type === "image").length, 1);
    assert.match(textOf(response), /exported 1 of 2 root shapes/);
    assert.match(textOf(response), /Stopped before the total would pass the 8 MB limit/);
});

test("a page whose first root shape is above 8 MB is refused with a clear message", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-page-tree", pageTree([{ id: rootId(1), name: "Board" }]));
    exporter.respondExport({ bytes: new Uint8Array(9 * 1024 * 1024), mimeType: "image/png" });
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /above the 8 MB limit for page output/);
});

test("a page with filePath is refused before the page is read or exported", async () => {
    const { backend, exporter, tool } = harness(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-page-"));
    try {
        await withExportDir(dir, async () => {
            const response = await tool.execute({ ...pageArgs, filePath: path.join(dir, "page.png") });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /filePath is not supported with shapeId page/);
            assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
            assert.equal(exporter.exports.length, 0);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

for (const [format, mimeType] of [
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
] as const) {
    test(`a ${format} shape is passed on and returned as an ${mimeType} image`, async () => {
        const { exporter, tool } = harness();
        exporter.respondExport({ bytes: JPEG, mimeType });
        const response = await tool.execute({ ...shapeArgs, format });
        assert.equal(exporter.exports[0].request.format, format);
        assert.equal(contentOf(response).type, "image");
        assert.equal(contentOf(response).mimeType, mimeType);
    });
}

test("the scale is passed through to the exporter", async () => {
    const { exporter, tool } = harness();
    await tool.execute({ ...shapeArgs, scale: 2 });
    assert.equal(exporter.exports[0].request.scale, 2);
});

test("an svg shape returns the svg text", async () => {
    const { exporter, tool } = harness();
    exporter.respondExport({ bytes: new TextEncoder().encode(SVG_TEXT), mimeType: "image/svg+xml" });
    const response = await tool.execute({ ...shapeArgs, format: "svg" });
    assert.equal(textOf(response), SVG_TEXT);
});

/**
 * Runs a test with PENPOT_MCP_EXPORT_DIR set to the given directory, restoring the previous value afterwards.
 *
 * @param dir - the export directory for the duration of the test
 * @param body - the test body
 */
async function withExportDir(dir: string, body: () => Promise<void>): Promise<void> {
    const previous = process.env.PENPOT_MCP_EXPORT_DIR;
    process.env.PENPOT_MCP_EXPORT_DIR = dir;
    try {
        await body();
    } finally {
        if (previous === undefined) {
            delete process.env.PENPOT_MCP_EXPORT_DIR;
        } else {
            process.env.PENPOT_MCP_EXPORT_DIR = previous;
        }
    }
}

test("a pdf without filePath returns JSON with the base64 bytes", async () => {
    const { exporter, tool } = harness();
    exporter.respondExport({ bytes: PDF, mimeType: "application/pdf" });
    const parsed = JSON.parse(textOf(await tool.execute({ ...shapeArgs, format: "pdf" })));
    assert.deepEqual(parsed, { format: "pdf", bytes: PDF.length, base64: Buffer.from(PDF).toString("base64") });
});

test("a pdf with filePath saves the file and answers with savedTo, bytes and format", async () => {
    const { exporter, tool } = harness(true);
    exporter.respondExport({ bytes: PDF, mimeType: "application/pdf" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-shape-"));
    try {
        await withExportDir(dir, async () => {
            const file = path.join(dir, "nested", "out.pdf");
            const response = await tool.execute({ ...shapeArgs, format: "pdf", filePath: file });
            assert.deepEqual(JSON.parse(textOf(response)), { savedTo: file, bytes: PDF.length, format: "pdf" });
            assert.deepEqual(fs.readFileSync(file), Buffer.from(PDF));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a filePath outside the export directory is refused before any export", async () => {
    const { exporter, tool } = harness(true);
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "export-outside-"));
    try {
        await withExportDir(exportDir, async () => {
            const response = await tool.execute({ ...shapeArgs, filePath: path.join(outside, "out.png") });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /inside the export directory/);
            assert.equal(exporter.exports.length, 0);
        });
    } finally {
        fs.rmSync(exportDir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("an image above 8 MB is refused inline and asks for filePath", async () => {
    const { exporter, tool } = harness();
    exporter.respondExport({ bytes: new Uint8Array(9 * 1024 * 1024), mimeType: "image/png" });
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /8 MB limit .* filePath/);
});

test("a relative filePath is refused", async () => {
    const { exporter, tool } = harness(true);
    const response = await tool.execute({ ...shapeArgs, filePath: "relative/out.png" });
    assert.match(textOf(response), /must be absolute/);
    assert.equal(exporter.exports.length, 0);
});

test("the filePath argument is offered only when file system access is enabled", () => {
    assert.ok(!("filePath" in harness(false).tool.getInputSchema()));
    assert.ok("filePath" in harness(true).tool.getInputSchema());
});

test("a busy exporter is reported as busy", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(
        new ExporterError(429, "The exporter is busy: too many exports are queued. Retry in a few seconds.")
    );
    assert.match(textOf(await tool.execute(shapeArgs)), /busy/);
});

test("a render session the exporter refuses is dropped and the call is retried once with a new session", async () => {
    const { backend, exporter, tool } = harness();
    exporter.failExport(new ExporterError(401, "rejected"));
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /Tool execution failed/);
    assert.equal(backend.callsTo("create-mcp-render-session").length, 2);
});

test("a 401 that a fresh render session cures returns the image", async () => {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("create-mcp-render-session", {
            token: "rs-1",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
        .respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect" }], missing: [] });
    let attempts = 0;
    const exporter = {
        exportShape: async () => {
            attempts++;
            if (attempts === 1) {
                throw new ExporterError(401, "rejected");
            }
            return { bytes: PNG, mimeType: "image/png" };
        },
        downloadAsset: async () => {
            throw new Error("not used");
        },
    };
    const services = new BackendServices(backend, new BackendSettings(), exporter);
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => false,
        isRemoteMode: () => false,
    } as unknown as PenpotMcpServer;
    const response = await new ExportShapeBackendTool(server, services).execute(shapeArgs);
    assert.equal(attempts, 2);
    assert.equal(response.isError, undefined);
    assert.equal(contentOf(response).type, "image");
});

test("a fill exports the image of the fill as the raw png", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", {
        shapes: [{ id: SHAPE, type: "rect", fills: [{ fillImage: { id: MEDIA } }] }],
        missing: [],
    });
    exporter.respondDownload({ bytes: PNG, mimeType: "image/png" });
    const response = await tool.execute({ ...fillArgs, format: "png" });
    assert.deepEqual(backend.callsTo("get-mcp-shapes")[0].params, { fileId: FILE, pageId: PAGE, ids: [SHAPE] });
    assert.equal(exporter.downloads[0].assetId, MEDIA);
    assert.equal(exporter.downloads[0].renderToken, "rs-1");
    assert.equal(exporter.exports.length, 0);
    assert.equal(contentOf(response).type, "image");
    assert.equal(contentOf(response).mimeType, "image/png");
    assert.equal(contentOf(response).data, Buffer.from(PNG).toString("base64"));
});

test("a fill in jpeg is converted from the png it was downloaded as", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", {
        shapes: [{ id: SHAPE, type: "rect", fills: [{ "fill-image": { id: MEDIA } }] }],
        missing: [],
    });
    const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer();
    exporter.respondDownload({ bytes: new Uint8Array(red), mimeType: "image/png" });
    const response = await tool.execute({ ...fillArgs, format: "jpeg" });
    assert.equal(contentOf(response).type, "image");
    assert.equal(contentOf(response).mimeType, "image/jpeg");
    const bytes = Buffer.from(contentOf(response).data ?? "", "base64");
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
});

test("a fill of a page is refused before any backend call", async () => {
    const { backend, tool } = harness();
    assert.match(textOf(await tool.execute({ ...fillArgs, shapeId: "page" })), /Fill mode needs a shape id, not page/);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 0);
});

test("a fill of a shape without an image is refused", async () => {
    const { backend, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect", fills: [] }], missing: [] });
    assert.match(textOf(await tool.execute(fillArgs)), /no image fill/);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
});

test("a fill of a shape the page does not hold is refused", async () => {
    const { backend, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [], missing: [SHAPE] });
    assert.match(textOf(await tool.execute(fillArgs)), /is not on page/);
    assert.equal(backend.callsTo("create-mcp-render-session").length, 0);
});

test("a shape that is not on the page is refused before the exporter is called", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [], missing: [SHAPE] });
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), new RegExp(`shape ${SHAPE} is not on page ${PAGE} of file ${FILE}`));
    assert.match(textOf(response), /find_shapes or get_page_tree/);
    assert.deepEqual(backend.callsTo("get-mcp-shapes")[0].params, {
        fileId: FILE,
        pageId: PAGE,
        ids: [SHAPE],
        fields: ["id", "width", "height"],
    });
    assert.equal(exporter.exports.length, 0);
});

test("another backend error from the shape read passes through unchanged", async () => {
    const { backend, exporter, tool } = harness();
    backend.fail("get-mcp-shapes", new Error("file not found"));
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.equal(textOf(response), "Tool execution failed: Error: file not found");
    assert.equal(exporter.exports.length, 0);
});

test("an svg above 256 kB is refused inline and asks for filePath", async () => {
    const { exporter, tool } = harness();
    exporter.respondExport({ bytes: new Uint8Array(300_000), mimeType: "image/svg+xml" });
    const response = await tool.execute({ ...shapeArgs, format: "svg" });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /above the 256 kB limit for inline svg output.*filePath/);
});

test("a pdf above 256 kB is refused inline, and a file of that size is saved when filePath is given", async () => {
    const { exporter, tool } = harness(true);
    exporter.respondExport({ bytes: new Uint8Array(300_000), mimeType: "application/pdf" });
    const inline = await tool.execute({ ...shapeArgs, format: "pdf" });
    assert.equal(inline.isError, true);
    assert.match(textOf(inline), /above the 256 kB limit for inline pdf output/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-big-pdf-"));
    try {
        await withExportDir(dir, async () => {
            const file = path.join(dir, "big.pdf");
            const saved = await tool.execute({ ...shapeArgs, format: "pdf", filePath: file });
            assert.equal(saved.isError, undefined);
            assert.equal(fs.statSync(file).size, 300_000);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a raster whose box times the scale has more than 16 million pixels is refused before the render", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect", width: 2000, height: 2000 }] });
    const response = await tool.execute({ ...shapeArgs, scale: 5 });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /above the 16 million limit for png output/);
    assert.equal(exporter.exports.length, 0);
});

test("a raster within 16 million pixels is rendered", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect", width: 2000, height: 2000 }] });
    await tool.execute({ ...shapeArgs, scale: 2 });
    assert.equal(exporter.exports.length, 1);
});

test("a filePath with the wrong extension is refused before the export", async () => {
    const { exporter, tool } = harness(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-ext-"));
    try {
        await withExportDir(dir, async () => {
            const response = await tool.execute({ ...shapeArgs, format: "png", filePath: path.join(dir, "out.jpg") });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /must end in \.png for this format/);
            assert.equal(exporter.exports.length, 0);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an existing file is refused unless overwrite is true, and then it is replaced", async () => {
    const { exporter, tool } = harness(true);
    exporter.respondExport({ bytes: PNG, mimeType: "image/png" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-overwrite-"));
    try {
        await withExportDir(dir, async () => {
            const file = path.join(dir, "out.png");
            fs.writeFileSync(file, "keep me");
            const refused = await tool.execute({ ...shapeArgs, filePath: file });
            assert.equal(refused.isError, true);
            assert.match(textOf(refused), /already exists\. Pass overwrite true/);
            assert.equal(exporter.exports.length, 0);
            assert.equal(fs.readFileSync(file, "utf8"), "keep me");
            await tool.execute({ ...shapeArgs, filePath: file, overwrite: true });
            assert.deepEqual(fs.readFileSync(file), Buffer.from(PNG));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a filePath through a symbolic link below the export directory is refused before the export", async () => {
    const { exporter, tool } = harness(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-link-"));
    try {
        await withExportDir(dir, async () => {
            const elsewhere = path.join(dir, "elsewhere");
            fs.mkdirSync(elsewhere);
            // a junction to a folder needs no special rights on Windows, unlike a file symlink
            fs.symlinkSync(elsewhere, path.join(dir, "link"), "junction");
            const response = await tool.execute({ ...shapeArgs, filePath: path.join(dir, "link", "out.png") });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /must not pass through a symbolic link/);
            assert.equal(exporter.exports.length, 0);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a page keeps the shapes rendered before one that fails, and the response is an error", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
            { id: rootId(3), name: "Board C" },
        ])
    );
    exporter.respondExport((request) => {
        if (request.objectId === rootId(2)) {
            throw new ExporterError(500, "render crashed");
        }
        return { bytes: PNG, mimeType: "image/png" };
    });
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, true);
    assert.deepEqual(
        response.content.map((item) => item.type),
        ["text", "text", "image"]
    );
    assert.match(textOf(response), /exported 1 of 3 root shapes/);
    assert.match(textOf(response), new RegExp(`Shape ${rootId(2)} could not be exported`));
    assert.match(textOf(response), /shapes after it were not exported/);
});

test("a page whose first root shape fails is an error with no partial result", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-page-tree", pageTree([{ id: rootId(1), name: "Board A" }]));
    exporter.failExport(new ExporterError(500, "render crashed"));
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, true);
    assert.match(textOf(response), new RegExp(`Shape ${rootId(1)} could not be exported`));
});
