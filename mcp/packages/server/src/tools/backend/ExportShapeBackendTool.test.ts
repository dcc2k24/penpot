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
import {
    BATCH_REFUSAL_MS,
    BatchRefusals,
    ExportBatchError,
    ExporterError,
    ExportTooLargeError,
} from "../../backend/ExporterClient";
import { BusyError } from "../../utils/PermitGate";
import { CallContext } from "../../backend/CallContext";
import { ExporterUnreachableError } from "../../backend/ExporterClient";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import {
    ExportShapeBackendTool,
    needsSvgTextHint,
    renderFailureText,
    type ExportShapeOptions,
} from "./ExportShapeBackendTool";

/** The exporter message of an svg render that times out on a text no browser has laid out. */
const TIMEOUT_MESSAGE = "The exporter failed to render the shape: locator.screenshot: Timeout 30000ms exceeded.";

/** The hint that an svg timeout gets, as the caller reads it. */
const HINT =
    "An svg export fails this way when the shape holds a text that no browser has laid out yet: a text created or " +
    "changed through the MCP has no positionData until the file is opened in the workspace. Export png instead, or " +
    "open the file in the workspace once and retry.";

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
function harness(fsEnabled = false, extra: { settings?: BackendSettings; tool?: ExportShapeOptions } = {}) {
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", { contractVersion: 1, profileId: "profile-1", scopes: ["mcp:read"] })
        .respond("create-mcp-render-session", {
            token: "rs-1",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
        .respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect" }], missing: [] });
    const exporter = new FakeExporterClient();
    // the clock is moved by the tests; the retry waits no time and the font check is short
    const clock = { now: 0 };
    const services = new BackendServices(backend, extra.settings ?? new BackendSettings(), exporter, () => clock.now);
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => fsEnabled,
    } as unknown as PenpotMcpServer;
    const tool = new ExportShapeBackendTool(server, services, {
        now: () => clock.now,
        retryDelayMs: 0,
        fontCheckMs: 1_000,
        ...extra.tool,
    });
    return { backend, exporter, tool, clock, services };
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
            renderer: "browser",
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
    assert.equal(exporter.exports.length, 0, "two root shapes go in one batch request");
    assert.deepEqual(
        exporter.batches[0].requests.map((request) => request.objectId),
        [rootId(1), rootId(2)]
    );
    assert.equal(exporter.batches[0].requests[0].pageId, PAGE);
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
    assert.equal(exporter.batches.length, 1, "the first ten root shapes go in one batch request");
    assert.equal(exporter.batches[0].requests.length, 10);
    assert.equal(exporter.batches[0].requests[9].objectId, rootId(10));
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
    assert.equal(exporter.batches[0].requests.length, 2);
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

test("filePath stays in the schema, so that multi-user mode refuses it and does not strip it", async () => {
    assert.ok("filePath" in harness(false).tool.getInputSchema());
    assert.ok("filePath" in harness(true).tool.getInputSchema());
    const { exporter, tool } = harness(false);
    const response = await tool.execute({ ...shapeArgs, filePath: path.join(os.tmpdir(), "out.png") });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /File paths are off in multi-user mode/);
    assert.equal(exporter.exports.length, 0, "nothing is exported before the refusal");
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
        exportShapes: async () => {
            throw new Error("not used");
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

/** Id of the n-th shape of the batch tests; distinct from the page root ids and from SHAPE. */
function shapeOf(n: number): string {
    return `2c3d4e5f-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Returns the ids of several shapes of the batch tests, in order.
 *
 * @param count - how many ids
 * @param first - the number of the first shape
 */
function shapeIdsOf(count: number, first = 1): string[] {
    return Array.from({ length: count }, (_, index) => shapeOf(first + index));
}

/**
 * Makes the shape read of a batch answer every requested id, in the order asked, at a file revision.
 *
 * @param backend - the fake backend
 * @param revn - the revision of the file that the answer carries
 * @param missing - ids that the page does not hold, which the answer leaves out
 */
function answerShapes(backend: FakePenpotBackend, revn: number, missing: string[] = []): void {
    backend.respond("get-mcp-shapes", (params: object) => {
        const ids = (params as { ids: string[] }).ids;
        return {
            revn,
            shapes: ids
                .filter((id) => !missing.includes(id))
                .map((id) => ({ id, type: "rect", name: `Rect ${id.slice(-3)}` })),
            missing,
        };
    });
}

/**
 * Returns the text of every text item of a tool response, joined with newlines.
 *
 * @param response - the tool response
 */
function allTextOf(response: ToolResponse): string {
    return response.content.map((item) => (item as ContentItem).text ?? "").join("\n");
}

test("shapeId and shapeIds together are refused, and so is giving neither", async () => {
    const { exporter, tool } = harness();
    const both = await tool.execute({ fileId: FILE, pageId: PAGE, shapeId: SHAPE, shapeIds: [shapeOf(1)] });
    assert.equal(both.isError, true);
    assert.match(textOf(both), /Give shapeId or shapeIds, not both/);
    const neither = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.equal(neither.isError, true);
    assert.match(textOf(neither), /Give shapeId, or shapeIds/);
    assert.equal(exporter.requestCount, 0);
});

test("25 ids with the default batch size of 10 make three exporter requests of 10, 10 and 5", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(25);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.isError, undefined);
    assert.deepEqual(
        exporter.batches.map((batch) => batch.requests.length),
        [10, 10, 5]
    );
    assert.equal(exporter.exports.length, 0);
    assert.deepEqual(
        exporter.batches.flatMap((batch) => batch.requests.map((request) => request.name)),
        ids
    );
});

test("a 500 on the first batch renders its shapes one by one, and the later chunks go one by one at once", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(500, "Cannot write ServerResponse"), 1);
    const ids = shapeIdsOf(25);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.isError, undefined);
    assert.equal(exporter.batches.length, 1, "only the first chunk was sent as a batch");
    assert.deepEqual(
        exporter.exports.map((call) => call.request.objectId),
        ids
    );
});

test("a refused exporter gets batches again once ten minutes have passed", async () => {
    const { backend, exporter, tool, clock } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(500, "busy"), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(exporter.batches.length, 1);
    assert.equal(exporter.exports.length, 2);
    clock.now += BATCH_REFUSAL_MS - 1;
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2, 3) });
    assert.equal(exporter.batches.length, 1, "still refused just before ten minutes");
    clock.now += 1;
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2, 5) });
    assert.equal(exporter.batches.length, 2, "batches are tried again after ten minutes");
});

test("a batch answer that misses a shape is refused as a batch, and the shapes render one by one", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondBatch((requests) => new Map([[requests[0].name, { bytes: PNG, mimeType: "image/png" }]]));
    const ids = shapeIdsOf(2);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.isError, undefined);
    assert.equal(exporter.batches.length, 1);
    assert.deepEqual(
        exporter.exports.map((call) => call.request.objectId),
        ids
    );
});

test("a single shape that keeps failing with 500 is retried once and reported as failed, the others succeed", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    const [first, broken, third] = shapeIdsOf(3);
    exporter.respondExport((request) => {
        if (request.objectId === broken) {
            throw new ExporterError(500, "render crashed");
        }
        return { bytes: PNG, mimeType: "image/png" };
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-retry-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: [first, broken, third],
                outputDir: out,
            });
            const summary = JSON.parse(textOf(response));
            assert.equal(summary.rendered, 2);
            assert.equal(summary.cached, 0);
            assert.deepEqual(
                summary.failed.map((failure: { shapeId: string }) => failure.shapeId),
                [broken]
            );
            assert.match(summary.failed[0].error, /render crashed/);
            assert.deepEqual(
                summary.files.map((file: { shapeId: string }) => file.shapeId),
                [first, third]
            );
            assert.equal(exporter.exports.filter((call) => call.request.objectId === broken).length, 2);
            assert.ok(fs.existsSync(path.join(out, `${first}.png`)));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a single shape that fails once with 500 is rendered by the retry", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, "render crashed"), 1);
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, undefined);
    assert.equal(contentOf(response).type, "image");
    assert.equal(exporter.exports.length, 2);
});

test("a 404 from the exporter is not retried", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(404, "could not find the shape"));
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.equal(exporter.exports.length, 1);
});

test("a second call for the same shapes and revision makes no exporter request and reports them as cached", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 7);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-cache-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const ids = shapeIdsOf(3);
            await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out });
            const requestsAfterFirst = exporter.requestCount;
            const second = JSON.parse(
                textOf(
                    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out, overwrite: true })
                )
            );
            assert.equal(exporter.requestCount, requestsAfterFirst, "no exporter request for cached shapes");
            assert.equal(second.rendered, 0);
            assert.equal(second.cached, 3);
            assert.equal(second.files.length, 3);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a single shape is answered from the cache on a second call with the same revision", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    await tool.execute(shapeArgs);
    await tool.execute(shapeArgs);
    assert.equal(exporter.requestCount, 1);
});

test("a new revision of the file renders the shapes again", async () => {
    const { backend, exporter, tool } = harness();
    const ids = shapeIdsOf(2);
    answerShapes(backend, 7);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    answerShapes(backend, 8);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.isError, undefined);
    assert.equal(exporter.batches.length, 2);
    assert.equal(exporter.batches[1].requests.length, 2);
});

test("renderer wasm reaches the exporter request, and a render of another renderer is not a cache hit", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    const ids = shapeIdsOf(2);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, renderer: "wasm" });
    assert.equal(exporter.batches[0].renderer, "wasm");
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(exporter.batches.length, 2, "the browser renderer renders the same shapes again");
    assert.equal(exporter.batches[1].renderer, "browser");
    await tool.execute({ ...shapeArgs, shapeId: ids[0], renderer: "wasm" });
    assert.equal(exporter.requestCount, 2, "the wasm render of a shape is still in the cache");
});

test("outputDir writes each image as <shapeId>.png and the reply lists the files", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    exporter.respondExport({ bytes: PNG, mimeType: "image/png" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-dir-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const ids = shapeIdsOf(2);
            const summary = JSON.parse(
                textOf(await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out }))
            );
            assert.equal(summary.rendered, 2);
            assert.deepEqual(
                summary.files.map((file: { shapeId: string }) => file.shapeId),
                ids
            );
            assert.deepEqual(summary.files[0], {
                shapeId: ids[0],
                path: path.join(out, `${ids[0]}.png`),
                bytes: PNG.length,
            });
            assert.deepEqual(fs.readFileSync(path.join(out, `${ids[1]}.png`)), Buffer.from(PNG));
            assert.equal(exporter.batches.length, 1);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("outputDir outside the export directory is refused before any render", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "export-outside-"));
    try {
        await withExportDir(exportDir, async () => {
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: shapeIdsOf(2),
                outputDir: outside,
            });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /inside the export directory/);
            assert.equal(exporter.requestCount, 0);
        });
    } finally {
        fs.rmSync(exportDir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("an existing file in outputDir is refused unless overwrite is true", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    exporter.respondExport({ bytes: PNG, mimeType: "image/png" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-existing-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const ids = shapeIdsOf(2);
            fs.mkdirSync(out);
            fs.writeFileSync(path.join(out, `${ids[0]}.png`), "keep me");
            const refused = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out });
            assert.equal(refused.isError, true);
            assert.match(
                textOf(refused),
                /1 of the 2 output files already exist in .* Pass overwrite: true to replace them/
            );
            assert.equal(exporter.requestCount, 0);
            assert.equal(fs.readFileSync(path.join(out, `${ids[0]}.png`), "utf8"), "keep me");
            await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out, overwrite: true });
            assert.deepEqual(fs.readFileSync(path.join(out, `${ids[0]}.png`)), Buffer.from(PNG));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("outputDir with a single shapeId is refused, and so is filePath with shapeIds", async () => {
    const { exporter, tool } = harness(true);
    const single = await tool.execute({ ...shapeArgs, outputDir: os.tmpdir() });
    assert.equal(single.isError, true);
    assert.match(textOf(single), /outputDir saves several shapes/);
    const withFile = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        shapeIds: shapeIdsOf(2),
        filePath: path.join(os.tmpdir(), "x.png"),
    });
    assert.equal(withFile.isError, true);
    assert.match(textOf(withFile), /filePath saves one shape/);
    assert.equal(exporter.requestCount, 0);
});

test("inline mode stops at 8 MB and lists the shapes it left out", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondExport({ bytes: new Uint8Array(5 * 1024 * 1024), mimeType: "image/png" });
    const ids = shapeIdsOf(3);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.content.filter((item) => item.type === "image").length, 1);
    assert.match(textOf(response), /Returned 1 of 3 shapes/);
    assert.match(textOf(response), /not returned/);
    assert.ok(textOf(response).includes(ids[1]) && textOf(response).includes(ids[2]));
    assert.match(textOf(response), /Pass outputDir/);
});

test("inline images come back in the order asked, each after a text line that names it", async () => {
    const { backend, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(2);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.deepEqual(
        response.content.map((item) => item.type),
        ["text", "text", "image", "text", "image"]
    );
    assert.match(contentOf(response, 1).text ?? "", new RegExp(`Shape ${ids[0]} "Rect`));
    assert.match(contentOf(response, 3).text ?? "", new RegExp(`Shape ${ids[1]} "Rect`));
});

test("progress is reported once per shape", async () => {
    const { backend, tool } = harness();
    answerShapes(backend, 1);
    const steps: Array<{ done: number; total: number | undefined }> = [];
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(3) }, undefined, async (done, total) => {
        steps.push({ done, total });
    });
    assert.deepEqual(
        steps.map((step) => step.done),
        [1, 2, 3]
    );
    assert.deepEqual(
        steps.map((step) => step.total),
        [3, 3, 3]
    );
});

test("ids that the page does not hold are listed as failed, and the others render", async () => {
    const { backend, tool } = harness(true);
    const ids = shapeIdsOf(3);
    answerShapes(backend, 1, [ids[1]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-missing-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const summary = JSON.parse(
                textOf(await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out }))
            );
            assert.equal(summary.rendered, 2);
            assert.equal(summary.failed.length, 1);
            assert.equal(summary.failed[0].shapeId, ids[1]);
            assert.match(summary.failed[0].error, /is not on page/);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an unresolved font is a warning in the reply, and the fonts command gets the exported ids", async () => {
    const { backend, tool } = harness(true);
    answerShapes(backend, 1);
    backend.respond("get-mcp-fonts", {
        revn: 1,
        fonts: [
            {
                fontId: "gfont-missing",
                family: "Missing Sans",
                source: "google",
                resolved: false,
                reason: "not-in-google-catalog",
                runs: 2,
            },
            { fontId: "sourcesanspro", family: "Source Sans Pro", source: "builtin", resolved: true, runs: 5 },
        ],
    });
    const ids = shapeIdsOf(2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-fonts-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const summary = JSON.parse(
                textOf(await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out }))
            );
            assert.deepEqual(summary.warnings, [
                {
                    kind: "font-unresolved",
                    fontId: "gfont-missing",
                    family: "Missing Sans",
                    reason: "not-in-google-catalog",
                    runs: 2,
                },
            ]);
        });
        assert.deepEqual(backend.callsTo("get-mcp-fonts")[0].params, { fileId: FILE, pageId: PAGE, rootIds: ids });
        const inline = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
        assert.match(
            allTextOf(inline),
            /Font warning.*Missing Sans \(font gfont-missing, reason not-in-google-catalog\)/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the font warning is absent when the fonts command fails", async () => {
    const { backend, tool } = harness();
    answerShapes(backend, 1);
    backend.fail("get-mcp-fonts", new Error("unknown command"));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(response.isError, undefined);
    assert.doesNotMatch(allTextOf(response), /Font warning/);
});

/** Fonts of a file in which one font did not resolve. */
const UNRESOLVED_FONTS = {
    revn: 1,
    fonts: [
        {
            fontId: "gfont-missing",
            family: "Missing Sans",
            source: "google",
            resolved: false,
            reason: "not-in-google-catalog",
            runs: 2,
        },
        { fontId: "sourcesanspro", family: "Source Sans Pro", source: "builtin", resolved: true, runs: 5 },
    ],
};

/** Fonts of a file in which every font resolved. */
const RESOLVED_FONTS = {
    revn: 1,
    fonts: [{ fontId: "sourcesanspro", family: "Source Sans Pro", source: "builtin", resolved: true, runs: 5 }],
};

test("a single shape with a font that did not resolve gets one text item that names the font and points to list_fonts", async () => {
    const { backend, tool } = harness();
    answerShapes(backend, 1);
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    const response = await tool.execute(shapeArgs);
    assert.equal(response.content.length, 2);
    assert.equal(contentOf(response, 0).type, "image");
    assert.match(
        contentOf(response, 1).text ?? "",
        /Missing Sans \(font gfont-missing, reason not-in-google-catalog\)/
    );
    assert.match(contentOf(response, 1).text ?? "", /list_fonts/);
    assert.deepEqual(backend.callsTo("get-mcp-fonts")[0].params, { fileId: FILE, pageId: PAGE, rootIds: [SHAPE] });
});

test("when every font resolves, or the fonts call fails, the reply is byte for byte the same", async () => {
    const plain = harness();
    answerShapes(plain.backend, 1);
    plain.backend.respond("get-mcp-fonts", RESOLVED_FONTS);
    const resolved = JSON.stringify(await plain.tool.execute(shapeArgs));

    const failing = harness();
    answerShapes(failing.backend, 1);
    failing.backend.fail("get-mcp-fonts", new Error("unknown command"));
    const failed = JSON.stringify(await failing.tool.execute(shapeArgs));

    const absent = harness();
    answerShapes(absent.backend, 1);
    const none = JSON.stringify(await absent.tool.execute(shapeArgs));

    assert.equal(resolved, failed);
    assert.equal(resolved, none);
    assert.equal(JSON.parse(resolved).content.length, 1);
});

test("a page whose font did not resolve gets the notice after its images, and the fonts call names the rendered shapes", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
        ])
    );
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    exporter.respondExport((request) => {
        if (request.objectId === rootId(2)) {
            throw new ExporterError(404, "could not find the shape");
        }
        return { bytes: PNG, mimeType: "image/png" };
    });
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, true);
    assert.deepEqual(backend.callsTo("get-mcp-fonts")[0].params, {
        fileId: FILE,
        pageId: PAGE,
        rootIds: [rootId(1)],
    });
    const last = contentOf(response, response.content.length - 1);
    assert.match(last.text ?? "", /Missing Sans/);
    assert.match(last.text ?? "", /list_fonts/);
});

test("a filePath export puts the font notice after the text that reports the saved file", async () => {
    const { backend, tool } = harness(true);
    answerShapes(backend, 1);
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-font-file-"));
    try {
        await withExportDir(dir, async () => {
            const file = path.join(dir, "shape.png");
            const response = await tool.execute({ ...shapeArgs, filePath: file });
            assert.equal(response.content.length, 2);
            assert.deepEqual(JSON.parse(textOf(response)), { savedTo: file, bytes: 4, format: "png" });
            assert.match(contentOf(response, 1).text ?? "", /Missing Sans/);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("fill mode makes no fonts call", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", {
        shapes: [{ id: SHAPE, type: "rect", fills: [{ fillImage: { id: MEDIA } }] }],
        missing: [],
    });
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    exporter.respondDownload({ bytes: PNG, mimeType: "image/png" });
    const response = await tool.execute(fillArgs);
    assert.equal(response.content.length, 1);
    assert.equal(backend.callsTo("get-mcp-fonts").length, 0);
});

test("a render refused before it starts makes no fonts call", async () => {
    const { backend, tool } = harness();
    backend.respond("get-mcp-shapes", { shapes: [{ id: SHAPE, type: "rect", width: 2000, height: 2000 }] });
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    const response = await tool.execute({ ...shapeArgs, scale: 5 });
    assert.equal(response.isError, true);
    assert.equal(backend.callsTo("get-mcp-fonts").length, 0);
});

test("a render that failed makes no fonts call", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-fonts", UNRESOLVED_FONTS);
    exporter.failExport(new ExporterError(404, "could not find the shape"));
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.equal(backend.callsTo("get-mcp-fonts").length, 0);
});

/** Image bytes of one size, for the memory and cap tests. */
function imageOf(size: number, fill = 1) {
    return { bytes: new Uint8Array(size).fill(fill), mimeType: "image/png" };
}

/** Reads the text of an image answer: the bytes it carries, as text. */
function imageText(response: ToolResponse, index = 0): string {
    return Buffer.from(contentOf(response, index).data ?? "", "base64").toString();
}

test("the same shape id on two pages at one revision is rendered once per page, not answered from the other page", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    exporter.respondExport((request) => ({
        bytes: new TextEncoder().encode(`image-of-${request.pageId.slice(-1)}`),
        mimeType: "image/png",
    }));
    const pageA = "1b2c3d4e-0000-4000-8000-00000000000a";
    const pageB = "1b2c3d4e-0000-4000-8000-00000000000b";
    const a = await tool.execute({ fileId: FILE, pageId: pageA, shapeId: SHAPE });
    const b = await tool.execute({ fileId: FILE, pageId: pageB, shapeId: SHAPE });
    assert.equal(imageText(a), "image-of-a");
    assert.equal(imageText(b), "image-of-b");
    assert.equal(exporter.requestCount, 2);
});

test("outputDir writes each file as soon as its shape is rendered, so a finished shape is on disk before the next render", async () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_BATCH_SIZE: "1" });
    const { backend, exporter, tool } = harness(true, { settings });
    answerShapes(backend, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-streamed-"));
    try {
        await withExportDir(dir, async () => {
            const out = path.join(dir, "shots");
            const ids = shapeIdsOf(3);
            const seenBefore: boolean[] = [];
            exporter.respondExport((request) => {
                const index = ids.indexOf(request.objectId);
                seenBefore.push(index === 0 || fs.existsSync(path.join(out, `${ids[index - 1]}.png`)));
                return imageOf(4);
            });
            await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out });
            assert.deepEqual(seenBefore, [true, true, true], "each earlier file was written before the next render");
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("inline mode sends no further chunk once the total is full, and lists the rest as not rendered", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondExport(() => imageOf(1024 * 1024));
    const ids = shapeIdsOf(40);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(exporter.batches.length, 1, "only the first chunk was sent");
    assert.equal(response.content.filter((item) => item.type === "image").length, 8);
    assert.match(textOf(response), /30 not rendered/);
    assert.match(textOf(response), /Pass outputDir/);
    assert.match(textOf(response), /ask for fewer shapes/);
});

test("a 60-shape inline call of 7.9 MB images holds at most the cap plus one chunk", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondExport(() => imageOf(Math.floor(7.9 * 1024 * 1024)));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(60) });
    assert.equal(exporter.batches.length, 1);
    assert.equal(response.content.filter((item) => item.type === "image").length, 1);
});

test("a batch ZIP of ten 1 MB boards passes its own cap, and renders in one request", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondBatch((requests) => {
        const files = new Map();
        for (const request of requests) {
            files.set(request.name, imageOf(1024 * 1024, 2));
        }
        return files;
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(10), outputDir: undefined });
    assert.equal(exporter.batches.length, 1);
    assert.equal(response.isError, undefined);
});

test("an answer over the batch cap falls back to singles for the chunk and for the rest of the call", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExportTooLargeError("The exporter batch is too large: the archive is over the cap."), 1);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(25) });
    assert.equal(exporter.batches.length, 1, "no later chunk tried a batch");
    assert.equal(exporter.exports.length, 25);
    assert.equal(response.isError, undefined);
});

test("a 5xx batch whose singles all render records the refusal of batches", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(502, "bad gateway"), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), true);
});

test("a 5xx batch with one bad shape records nothing: the bad shape, not the batch, is the cause", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(3);
    exporter.failBatch(new ExporterError(500, "render crashed"), 1);
    exporter.respondExport((request) => {
        if (request.objectId === ids[1]) {
            throw new ExporterError(500, "render crashed");
        }
        return imageOf(4);
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(response.isError, undefined);
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), false);
});

test("a 503 from the asset download of a batch records nothing", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(503, "backend failed to return the asset", "asset"), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), false);
});

test("a batch ZIP that cannot be mapped falls back to singles and records nothing", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExportBatchError("The exporter batch has no entry for shape x."), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(exporter.exports.length, 2);
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), false);
});

test("a size error of a batch records nothing", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExportTooLargeError("too large"), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), false);
});

test("a busy exporter stops the call: every shape of the chunk and of the rest is failed, and nothing else is sent", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(429, "busy"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-busy-"));
    try {
        await withExportDir(dir, async () => {
            const summary = JSON.parse(
                textOf(
                    await tool.execute({
                        fileId: FILE,
                        pageId: PAGE,
                        shapeIds: shapeIdsOf(25),
                        outputDir: path.join(dir, "shots"),
                    })
                )
            );
            assert.equal(exporter.batches.length, 1);
            assert.equal(exporter.exports.length, 0);
            assert.equal(summary.failed.length, 25);
            assert.match(summary.failed[0].error, /export is busy, retry later/);
            assert.match(summary.failed[0].error, /the shapes already rendered come from the cache/);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a BusyError from a permit stops the call the same way as a 429", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new BusyError("export", 30_000));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(3) });
    assert.equal(exporter.batches.length, 1);
    assert.equal(exporter.exports.length, 0);
    assert.equal(response.isError, true);
    assert.match(allTextOf(response), /export is busy, retry later/);
});

test("a cancelled call takes no fallback: the rest of its shapes are failed as cancelled", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const controller = new AbortController();
    exporter.respondBatch(() => {
        controller.abort();
        throw new Error("aborted");
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(3) }, controller.signal);
    assert.equal(exporter.exports.length, 0);
    assert.match(allTextOf(response), /the call was cancelled/);
});

test("a chunk that passes its deadline renders alone, and the rest of the call goes one shape at a time", async () => {
    const { backend, exporter, tool } = harness(false, { tool: { renderDeadlineMs: 20 } });
    answerShapes(backend, 1);
    let attempts = 0;
    exporter.exportShapes = (async () => {
        attempts++;
        return new Promise(() => undefined);
    }) as FakeExporterClient["exportShapes"];
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(20) });
    assert.equal(attempts, 1, "only the first chunk tried a batch");
    assert.equal(exporter.exports.length, 20);
    assert.equal(response.isError, undefined);
});

test("a 400 from a batch falls back to singles and records nothing, and a 403 on a single is not retried", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.failBatch(new ExporterError(400, "rejected"), 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2) });
    assert.equal(exporter.exports.length, 2);
    assert.equal(BatchRefusals.refusesBatches(exporter, 0), false);
    const single = harness();
    single.exporter.failExport(new ExporterError(403, "forbidden"));
    await single.tool.execute(shapeArgs);
    assert.equal(single.exporter.exports.length, 1);
});

test("a 400 on a single is not retried", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(400, "rejected"));
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 1);
});

test("a 502 and a 503 from a batch fall back to singles", async () => {
    for (const status of [502, 503]) {
        const { backend, exporter, tool } = harness();
        answerShapes(backend, 1);
        exporter.failBatch(new ExporterError(status, "down"), 1);
        await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(3) });
        assert.equal(exporter.exports.length, 3, `status ${status} rendered each shape alone`);
    }
});

test("the retry pause of a single ends at once when the call is cancelled", async () => {
    const { exporter, tool } = harness(false, { tool: { retryDelayMs: 60_000 } });
    exporter.failExport(new ExporterError(500, "render crashed"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const response = await tool.execute(shapeArgs, controller.signal);
    assert.equal(response.isError, true);
    assert.ok(Date.now() - started < 2_000, "the pause ended with the cancellation");
});

test("a call that has run out of time renders nothing more, and lists the rest as not rendered", async () => {
    const { backend, exporter, tool, clock } = harness(true);
    answerShapes(backend, 1);
    exporter.respondExport(() => {
        clock.now += 11 * 60_000;
        return imageOf(4);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-budget-"));
    try {
        await withExportDir(dir, async () => {
            const summary = JSON.parse(
                textOf(
                    await tool.execute({
                        fileId: FILE,
                        pageId: PAGE,
                        shapeIds: shapeIdsOf(40),
                        outputDir: path.join(dir, "shots"),
                    })
                )
            );
            assert.equal(exporter.batches.length, 1);
            assert.equal(summary.notRendered.length, 30);
            assert.match(
                summary.notRendered[0].reason,
                /the call ran out of time; call again with overwrite: true; the shapes already rendered come from the cache/
            );
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a render older than fifteen minutes is rendered again", async () => {
    const { backend, exporter, tool, clock } = harness();
    answerShapes(backend, 7);
    await tool.execute(shapeArgs);
    clock.now += 15 * 60_000 - 1;
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 1, "still fresh just before fifteen minutes");
    clock.now += 1;
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 2);
});

test("refresh renders again and replaces the cached render", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    let fill = 1;
    exporter.respondExport(() => imageOf(4, fill));
    await tool.execute(shapeArgs);
    fill = 2;
    const refreshed = await tool.execute({ ...shapeArgs, refresh: true });
    assert.equal(exporter.exports.length, 2);
    assert.equal(contentOf(refreshed).data, Buffer.from([2, 2, 2, 2]).toString("base64"));
    const later = await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 2, "the refreshed render is now the cached one");
    assert.equal(contentOf(later).data, Buffer.from([2, 2, 2, 2]).toString("base64"));
});

test("progress is reported once for each shape of a chunk that is rendered one by one", async () => {
    const { exporter, tool } = harness();
    exporter.failBatch(new ExporterError(500, "busy"), 1);
    const steps: number[] = [];
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(3) }, undefined, async (done) => {
        steps.push(done);
    });
    assert.deepEqual(steps, [1, 2, 3]);
});

test("outputDir with an existing file in its place is refused before any render", async () => {
    const { exporter, tool } = harness(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-notdir-"));
    try {
        await withExportDir(dir, async () => {
            const asFile = path.join(dir, "not-a-folder");
            fs.writeFileSync(asFile, "x");
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: shapeIdsOf(2),
                outputDir: asFile,
            });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /exists and is not a folder/);
            assert.equal(exporter.requestCount, 0);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the refusal of existing outputDir files names how many exist and asks for overwrite", async () => {
    const { exporter, tool } = harness(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-count-"));
    try {
        await withExportDir(dir, async () => {
            const out = path.join(dir, "shots");
            fs.mkdirSync(out);
            const ids = shapeIdsOf(3);
            fs.writeFileSync(path.join(out, `${ids[0]}.png`), "a");
            fs.writeFileSync(path.join(out, `${ids[2]}.png`), "b");
            const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /2 of the 3 output files already exist/);
            assert.match(textOf(response), /Pass overwrite: true to replace them/);
            assert.equal(exporter.requestCount, 0);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("outputDir through a folder link is refused, even with overwrite true", async () => {
    const { exporter, tool } = harness(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-jlink-root-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "export-jlink-out-"));
    try {
        await withExportDir(root, async () => {
            fs.symlinkSync(elsewhere, path.join(root, "link"), "junction");
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: shapeIdsOf(2),
                outputDir: path.join(root, "link", "shots"),
                overwrite: true,
            });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /must not pass through a symbolic link/);
            assert.equal(exporter.requestCount, 0);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
    }
});

test("a file link at a target name is refused with overwrite true, and the file it points to is kept", async (t) => {
    const { exporter, tool } = harness(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-flink-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "export-flink-out-"));
    try {
        await withExportDir(root, async () => {
            const out = path.join(root, "shots");
            fs.mkdirSync(out);
            const id = shapeOf(1);
            const victim = path.join(outside, "victim.txt");
            fs.writeFileSync(victim, "precious");
            try {
                fs.symlinkSync(victim, path.join(out, `${id}.png`), "file");
            } catch (error) {
                t.skip(`cannot create a file symlink here: ${(error as Error).message}`);
                return;
            }
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: [id],
                outputDir: out,
                overwrite: true,
            });
            assert.equal(response.isError, true);
            assert.equal(fs.readFileSync(victim, "utf8"), "precious");
            assert.equal(exporter.requestCount, 0);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("a write failure in outputDir lands in failed, and the other shapes are still written", async () => {
    const { backend, tool } = harness(true);
    answerShapes(backend, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-writefail-"));
    try {
        await withExportDir(dir, async () => {
            const out = path.join(dir, "shots");
            fs.mkdirSync(out);
            const ids = shapeIdsOf(3);
            fs.mkdirSync(path.join(out, `${ids[1]}.png`));
            const summary = JSON.parse(
                textOf(
                    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: out, overwrite: true })
                )
            );
            assert.deepEqual(
                summary.failed.map((failure: { shapeId: string }) => failure.shapeId),
                [ids[1]]
            );
            assert.equal(summary.files.length, 2);
            assert.ok(fs.existsSync(path.join(out, `${ids[2]}.png`)));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("isError is set only when every shape fails", async () => {
    const { backend, tool } = harness();
    const ids = shapeIdsOf(2);
    answerShapes(backend, 1, [ids[1]]);
    const partial = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(partial.isError, undefined);
    const none = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2, 5) });
    assert.equal(none.isError, undefined, "shapes that render are not a failed call");
    answerShapes(backend, 2, shapeIdsOf(2, 9));
    const all = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2, 9) });
    assert.equal(all.isError, true);
});

test("an svg batch comes back inline as text, one line per shape in the order asked", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondExport((request) => ({
        bytes: new TextEncoder().encode(`<svg id="${request.objectId}"/>`),
        mimeType: "image/svg+xml",
    }));
    const ids = shapeIdsOf(2);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids, format: "svg" });
    assert.deepEqual(
        response.content.map((item) => item.type),
        ["text", "text", "text", "text", "text"]
    );
    assert.match(contentOf(response, 2).text ?? "", /<svg id=/);
});

test("an svg over 256 kB is left out with its own reason, not the 8 MB one", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    exporter.respondExport(() => ({ bytes: new Uint8Array(300_000).fill(60), mimeType: "image/svg+xml" }));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(2), format: "svg" });
    assert.match(textOf(response), /each svg or pdf is above the 256 kB limit/);
    assert.doesNotMatch(textOf(response), /would pass the 8 MB limit/);
});

test("an upper-case id given twice renders once, and an upper-case id is found on the page", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond("get-mcp-shapes", (params: object) => {
        const ids = (params as { ids: string[] }).ids;
        return { revn: 7, shapes: ids.map((id) => ({ id: id.toLowerCase(), type: "rect", name: "R" })), missing: [] };
    });
    const lower = shapeOf(1);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: [lower, lower.toUpperCase()] });
    assert.equal(exporter.requestCount, 1);
    assert.match(textOf(response), /Returned 1 of 1 shapes/);
});

test("a truncated shape read is asked again for the ids it did not return", async () => {
    const { backend, exporter, tool } = harness();
    const ids = shapeIdsOf(2);
    let round = 0;
    backend.respond("get-mcp-shapes", (params: object) => {
        const asked = (params as { ids: string[] }).ids;
        round++;
        const first = asked.slice(0, 1);
        return {
            revn: 7,
            shapes: (round === 1 ? first : asked).map((id) => ({ id, type: "rect", name: "R" })),
            missing: [],
            truncated: round === 1,
        };
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 2);
    assert.deepEqual(backend.callsTo("get-mcp-shapes")[1].params, {
        fileId: FILE,
        pageId: PAGE,
        ids: [ids[1]],
        fields: ["id", "type", "name", "width", "height"],
    });
    assert.equal(exporter.requestCount, 1);
    assert.equal(response.isError, undefined);
});

test("the batch size comes from the settings, through the services", async () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_BATCH_SIZE: "3" });
    const { backend, exporter, tool } = harness(false, { settings });
    answerShapes(backend, 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(10) });
    assert.deepEqual(
        exporter.batches.map((batch) => batch.requests.length),
        [3, 3, 3]
    );
    assert.equal(exporter.exports.length, 1);
});

test("one shape goes as a single request, and 200 shapes go in twenty batches of ten", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(1) });
    assert.equal(exporter.batches.length, 0);
    assert.equal(exporter.exports.length, 1);
    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(200, 100) });
    assert.equal(exporter.batches.length, 20);
    assert.ok(exporter.batches.every((batch) => batch.requests.length === 10));
});

test("eleven shapes with batch size ten: one batch of ten, and the trailing shape goes as a plain file", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(11);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.deepEqual(
        exporter.batches.map((batch) => batch.requests.length),
        [10]
    );
    assert.equal(exporter.exports.length, 1);
    assert.equal(exporter.exports[0].request.objectId, ids[10]);
    assert.equal(exporter.exports[0].request.name, "export");
    assert.equal(response.isError, undefined);
});

test("the cache off at the tool level renders the same shape again", async () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_CACHE_MB: "0" });
    const { backend, exporter, tool } = harness(false, { settings });
    answerShapes(backend, 7);
    await tool.execute(shapeArgs);
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 2);
});

test("format and scale are parts of the cache key", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    await tool.execute(shapeArgs);
    await tool.execute({ ...shapeArgs, format: "svg" });
    await tool.execute({ ...shapeArgs, scale: 2 });
    assert.equal(exporter.exports.length, 3);
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 3, "the first png is still cached");
});

test("the cache answers a second page call with the same revision without an exporter request", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
        ])
    );
    await tool.execute(pageArgs);
    const before = exporter.requestCount;
    const second = await tool.execute(pageArgs);
    assert.equal(exporter.requestCount, before);
    assert.equal(second.content.length, 5);
});

test("outputDir is refused when file system access is off", async () => {
    const { exporter, tool } = harness(false);
    const response = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        shapeIds: shapeIdsOf(2),
        outputDir: path.join(os.tmpdir(), "x"),
    });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /File paths are off in multi-user mode/);
    assert.equal(exporter.requestCount, 0);
});

test("a page with a fallback renders each root shape alone and returns all of them", async () => {
    const { backend, exporter, tool } = harness();
    backend.respond(
        "get-mcp-page-tree",
        pageTree([
            { id: rootId(1), name: "Board A" },
            { id: rootId(2), name: "Board B" },
            { id: rootId(3), name: "Board C" },
        ])
    );
    exporter.failBatch(new ExporterError(500, "render crashed"), 1);
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, undefined);
    assert.equal(exporter.exports.length, 3);
    assert.match(textOf(response), /exported 3 of 3 root shapes/);
});

test("a cached shape is checked for fonts once per call, so a font added since then is still shown", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    await tool.execute(shapeArgs);
    await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 1);
    assert.equal(backend.callsTo("get-mcp-fonts").length, 2);
});

/** Image bytes of one size, for the cache, cap and breaker tests. */
function sized(size: number, fill = 1) {
    return { bytes: new Uint8Array(size).fill(fill), mimeType: "image/png" };
}

/** The text items of a reply, joined. */
function allText(response: ToolResponse): string {
    return response.content.map((item) => (item as ContentItem).text ?? "").join("\n");
}

/** The number of image items of a reply. */
function imagesOf(response: ToolResponse): number {
    return response.content.filter((item) => item.type === "image").length;
}

const UNRESOLVED_BRAND = {
    fonts: [{ fontId: "custom-1", family: "Brand", resolved: false, reason: "custom-font-not-in-team", runs: 2 }],
};

test("a render with an unresolved font is cached: a second identical call is served from the cache and still shows the notice", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 7);
    backend.respond("get-mcp-fonts", () => UNRESOLVED_BRAND);
    exporter.respondExport(() => sized(4));
    await tool.execute(shapeArgs);
    const second = await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 1, "the second call rendered nothing");
    assert.equal(imagesOf(second), 1);
    assert.match(contentOf(second, 1).text ?? "", /Brand \(font custom-1, reason custom-font-not-in-team\)/);
    assert.match(
        contentOf(second, 1).text ?? "",
        /These renders are kept for up to 15 minutes; after the font is fixed, pass refresh: true to render again\./
    );
    assert.equal(backend.callsTo("get-mcp-fonts").length, 2, "one font check per call");
});

for (const mode of ["throws", "late", "missing"] as const) {
    test(`a font check that ${mode === "late" ? "takes longer than 3 s" : mode === "throws" ? "throws" : "does not exist"} leaves the cache working`, async () => {
        const { backend, exporter, tool } = harness(false, { tool: { fontCheckMs: 20 } });
        answerShapes(backend, 7);
        if (mode === "throws") {
            backend.fail("get-mcp-fonts", new Error("boom"));
        } else if (mode === "missing") {
            backend.fail("get-mcp-fonts", new Error("unknown command get-mcp-fonts"));
        } else {
            backend.respond("get-mcp-fonts", () => new Promise(() => undefined));
        }
        const first = await tool.execute(shapeArgs);
        const second = await tool.execute(shapeArgs);
        assert.equal(first.content.length, 1, `${mode}: no notice when the check was not made`);
        assert.equal(second.content.length, 1, `${mode}: no notice`);
        assert.equal(exporter.exports.length, 1, `${mode}: the second call is served from the cache`);
    });
}

test("a cancelled call keeps the renders it made in the cache, and skips its font check", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 7);
    backend.respond("get-mcp-fonts", () => {
        if (CallContext.current()?.signal?.aborted === true) {
            throw new DOMException("This operation was aborted", "AbortError");
        }
        return { fonts: [] };
    });
    const controller = new AbortController();
    let batches = 0;
    exporter.respondBatch((requests) => {
        batches++;
        if (batches === 2) {
            controller.abort();
            throw new Error("aborted");
        }
        return new Map(requests.map((request) => [request.name, sized(4)]));
    });
    const ids = shapeIdsOf(25);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-cancel-keep-"));
    try {
        await withExportDir(dir, async () => {
            await tool.execute(
                { fileId: FILE, pageId: PAGE, shapeIds: ids, outputDir: path.join(dir, "shots") },
                controller.signal
            );
            assert.equal(backend.callsTo("get-mcp-fonts").length, 0, "no font check for a cancelled call");
            const before = exporter.requestCount;
            const again = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids.slice(0, 10) });
            assert.equal(exporter.requestCount, before, "the first chunk's renders were cached before the cancel");
            assert.match(allText(again), /Returned 10 of 10 shapes: 0 rendered, 10 from the cache/);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a shape too large for the inline reply is cached before the size error, and the filePath retry makes no exporter request", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 7);
    exporter.respondExport(() => sized(9 * 1024 * 1024));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-big-cache-"));
    try {
        await withExportDir(dir, async () => {
            const first = await tool.execute(shapeArgs);
            assert.equal(first.isError, true);
            const retry = await tool.execute({ ...shapeArgs, filePath: path.join(dir, "big.png") });
            assert.equal(retry.isError, undefined);
            assert.equal(exporter.exports.length, 1, "the retry was served from the cache");
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("one 9 MB image among small ones does not hide them: the small ones are returned and the big one is named", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(25);
    exporter.respondExport((request) => sized(request.objectId === ids[0] ? 9 * 1024 * 1024 : 1024));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(imagesOf(response), 24);
    assert.match(textOf(response), /Returned 24 of 25 shapes/);
    assert.match(allText(response), /too large for an inline reply on their own.*Pass outputDir or filePath/);
    assert.match(allText(response), new RegExp(ids[0]));
});

test("a 401 that keeps coming back stops the call after the breaker: two batches and one single per attempt, not one per shape", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const refused = new ExporterError(401, "The exporter rejected the render session.");
    exporter.failBatch(refused).failExport(refused);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(30) });
    assert.equal(response.isError, true);
    // each batch request is retried once with a fresh render session, so two requests per chunk: the second chunk's
    // first request tripped the breaker, and nothing after it was sent
    assert.equal(exporter.batches.length, 4, "two batch requests for the first chunk, two for the second");
    assert.equal(exporter.exports.length, 20, "the first chunk's singles, each with its one session retry");
    assert.ok(backend.callsTo("create-mcp-render-session").length <= 25, "render sessions stayed bounded");
    assert.match(allText(response), /The exporter rejected the render session/);
});

for (const error of [
    new ExporterError(403, "forbidden"),
    new ExporterUnreachableError("The exporter did not respond (TypeError). Check PENPOT_MCP_EXPORTER_URI."),
    new ExporterError(503, "down"),
]) {
    test(`a ${error.message.slice(0, 30)} on every request stops the call after the breaker`, async () => {
        const { backend, exporter, tool } = harness();
        answerShapes(backend, 1);
        exporter.failBatch(error).failExport(error);
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: shapeIdsOf(30) });
        assert.equal(response.isError, true);
        assert.equal(exporter.batches.length, 2);
        assert.ok(exporter.exports.length <= 20, `singles: ${exporter.exports.length}`);
    });
}

test("one bad shape among good ones never trips the breaker", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(25);
    exporter.failBatch(new ExporterError(500, "render crashed"), 1);
    exporter.respondExport((request) => {
        if (request.objectId === ids[2]) {
            throw new ExporterError(500, "render crashed");
        }
        return sized(4);
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(exporter.batches.length, 3, "the later chunks were still sent as batches");
    assert.equal(imagesOf(response), 24);
    assert.match(textOf(response), /Returned 24 of 25 shapes/);
});

test("an unmappable batch switches the rest of the call to singles, so no later chunk is rendered twice", async () => {
    const { backend, exporter, tool } = harness();
    answerShapes(backend, 1);
    const ids = shapeIdsOf(25);
    exporter.respondBatch((requests) => {
        const files = new Map(requests.map((request) => [request.name, sized(4)]));
        files.delete(ids[3]);
        return files;
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: ids });
    assert.equal(exporter.batches.length, 1, "only the first chunk tried a batch");
    assert.equal(exporter.exports.length, 25);
    assert.equal(response.isError, undefined);
});

test("a call that stops on the budget with outputDir says to call again with overwrite true", async () => {
    const { backend, exporter, tool, clock } = harness(true);
    exporter.respondExport(() => {
        clock.now += 11 * 60_000;
        return sized(4);
    });
    answerShapes(backend, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-budget-note-"));
    try {
        await withExportDir(dir, async () => {
            const summary = JSON.parse(
                textOf(
                    await tool.execute({
                        fileId: FILE,
                        pageId: PAGE,
                        shapeIds: shapeIdsOf(12),
                        outputDir: path.join(dir, "shots"),
                    })
                )
            );
            assert.match(
                summary.notRendered[0].reason,
                /call again with overwrite: true; the shapes already rendered come from the cache/
            );
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a page export stopped by the budget reports what it returned, and is not an error when it returned images", async () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_BATCH_SIZE: "3" });
    const { backend, exporter, tool, clock } = harness(false, { settings });
    backend.respond(
        "get-mcp-page-tree",
        pageTree(Array.from({ length: 8 }, (_, index) => ({ id: rootId(index + 1), name: `Board ${index}` })))
    );
    exporter.respondBatch((requests) => {
        clock.now += 11 * 60_000;
        return new Map(requests.map((request) => [request.name, sized(4)]));
    });
    const response = await tool.execute(pageArgs);
    assert.equal(response.isError, undefined);
    assert.equal(imagesOf(response), 3);
    const header = textOf(response);
    assert.match(header, /exported 3 of 8 root shapes/);
    assert.match(
        header,
        /Stopped: the call ran out of time; call again; the shapes already rendered come from the cache\. Export the rest by id\./
    );
    assert.doesNotMatch(header, /could not be exported/);
    assert.doesNotMatch(header, /\.\./);
});

test("an outputDir write goes through a temporary file: a hard link at the target keeps its old content", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    exporter.respondExport(() => sized(4, 9));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-temp-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "export-temp-out-"));
    try {
        await withExportDir(root, async () => {
            const out = path.join(root, "shots");
            fs.mkdirSync(out);
            const id = shapeOf(1);
            const victim = path.join(outside, "victim.txt");
            fs.writeFileSync(victim, "precious");
            fs.linkSync(victim, path.join(out, `${id}.png`));
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: [id],
                outputDir: out,
                overwrite: true,
            });
            assert.equal(response.isError, undefined);
            assert.equal(fs.readFileSync(victim, "utf8"), "precious", "the file outside was not written through");
            assert.deepEqual(fs.readFileSync(path.join(out, `${id}.png`)), Buffer.from([9, 9, 9, 9]));
            assert.deepEqual(
                fs.readdirSync(out).filter((name) => name.endsWith(".tmp")),
                []
            );
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("a failed replacing write leaves no temporary file behind", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    exporter.respondExport(() => sized(4));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-temp-fail-"));
    try {
        await withExportDir(root, async () => {
            const out = path.join(root, "shots");
            fs.mkdirSync(out);
            const id = shapeOf(1);
            fs.mkdirSync(path.join(out, `${id}.png`));
            const summary = JSON.parse(
                textOf(
                    await tool.execute({ fileId: FILE, pageId: PAGE, shapeIds: [id], outputDir: out, overwrite: true })
                )
            );
            assert.equal(summary.failed.length, 1);
            assert.deepEqual(
                fs.readdirSync(out).filter((name) => name.endsWith(".tmp")),
                []
            );
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("an svg single export that times out on a text gets the svg text hint after the exporter message", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, TIMEOUT_MESSAGE));
    const response = await tool.execute({ ...shapeArgs, format: "svg" });
    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.ok(text.includes(TIMEOUT_MESSAGE), "the original message is kept");
    assert.ok(text.includes(`${TIMEOUT_MESSAGE} ${HINT}`), "the hint follows the message after one space");
    assert.equal(text.split(HINT).length - 1, 1, "the hint appears once");
});

test("an svg single export that times out on a text is tried once, not retried, and keeps the hint", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, TIMEOUT_MESSAGE));
    const response = await tool.execute({ ...shapeArgs, format: "svg" });
    assert.equal(exporter.exports.length, 1, "the svg text timeout is not retried");
    assert.equal(response.isError, true);
    assert.ok(textOf(response).includes(`${TIMEOUT_MESSAGE} ${HINT}`));
});

test("a png single export with the same timeout is still retried once, and gets no hint", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, TIMEOUT_MESSAGE));
    const response = await tool.execute(shapeArgs);
    assert.equal(exporter.exports.length, 2, "png keeps the retry of a server error");
    assert.equal(response.isError, true);
    assert.ok(!textOf(response).includes(HINT));
});

test("a png single export with the same timeout gets no svg text hint", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, TIMEOUT_MESSAGE));
    const response = await tool.execute(shapeArgs);
    assert.equal(response.isError, true);
    assert.ok(textOf(response).includes(TIMEOUT_MESSAGE));
    assert.ok(!textOf(response).includes(HINT));
});

test("an svg single export with another exporter error gets no svg text hint", async () => {
    const { exporter, tool } = harness();
    exporter.failExport(new ExporterError(500, "boom"));
    const response = await tool.execute({ ...shapeArgs, format: "svg" });
    assert.equal(response.isError, true);
    assert.ok(textOf(response).includes("boom"));
    assert.ok(!textOf(response).includes(HINT));
});

test("a failed svg shape of a batch carries the svg text hint, and the other shapes render", async () => {
    const { backend, exporter, tool } = harness(true);
    answerShapes(backend, 1);
    const [first, broken, third] = shapeIdsOf(3);
    exporter.respondExport((request) => {
        if (request.objectId === broken) {
            throw new ExporterError(500, TIMEOUT_MESSAGE);
        }
        return { bytes: new TextEncoder().encode(SVG_TEXT), mimeType: "image/svg+xml" };
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-svg-hint-"));
    const out = path.join(dir, "shots");
    try {
        await withExportDir(dir, async () => {
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                shapeIds: [first, broken, third],
                outputDir: out,
                format: "svg",
            });
            const summary = JSON.parse(textOf(response));
            assert.equal(summary.rendered, 2);
            assert.deepEqual(
                summary.failed.map((failure: { shapeId: string }) => failure.shapeId),
                [broken]
            );
            assert.equal(summary.failed[0].error, `${TIMEOUT_MESSAGE} ${HINT}`);
            assert.equal(
                exporter.exports.filter((call) => call.request.objectId === broken).length,
                1,
                "the failing svg shape is tried once"
            );
            assert.ok(fs.existsSync(path.join(out, `${first}.svg`)));
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("renderFailureText and needsSvgTextHint give the hint only for an svg timeout of an exporter error", () => {
    const timeout = new ExporterError(500, TIMEOUT_MESSAGE);
    assert.equal(needsSvgTextHint("svg", timeout), true);
    assert.equal(needsSvgTextHint("png", timeout), false);
    assert.equal(needsSvgTextHint("jpeg", timeout), false);
    assert.equal(needsSvgTextHint("webp", timeout), false);
    assert.equal(needsSvgTextHint("pdf", timeout), false);
    assert.equal(needsSvgTextHint("svg", new ExporterError(500, "boom")), false);
    assert.equal(needsSvgTextHint("svg", new Error(TIMEOUT_MESSAGE)), false, "only an ExporterError gets the hint");

    assert.equal(renderFailureText("png", timeout), TIMEOUT_MESSAGE);
    assert.equal(renderFailureText("svg", new ExporterError(500, "boom")), "boom");
    assert.equal(renderFailureText("svg", timeout), `${TIMEOUT_MESSAGE} ${HINT}`);
});
