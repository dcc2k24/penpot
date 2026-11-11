import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendSettings } from "../backend/BackendSettings";
import { BackendRpcError } from "../backend/BackendRpcError";
import { BackendServices } from "../backend/BackendServices";
import { FakeExporterClient } from "../backend/testing/FakeExporterClient";
import { FakePenpotBackend } from "../backend/testing/FakePenpotBackend";
import { TokenDigest } from "../backend/TokenDigest";
import { CallSlots, SlotHolder } from "./CallSlots";
import { SandboxHost } from "./SandboxHost";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000005";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A valid operation that deletes one shape. */
const DELETE_OP = { op: "delete_shapes", pageId: PAGE, ids: [SHAPE] };

/**
 * Builds a host over a fake backend and exporter, with the services a real server uses.
 *
 * The rate limit burst is large, so that the rate limit does not refuse the calls of a test by chance.
 *
 * @param backend - fake backend that answers the commands
 * @param exporter - fake exporter that answers the renders and downloads
 * @param maxHostCalls - most primitive calls one script may make, or the default when omitted
 */
function harness(
    backend: FakePenpotBackend,
    exporter: FakeExporterClient = new FakeExporterClient(),
    maxHostCalls?: number
): SandboxHost {
    const services = new BackendServices(backend, new BackendSettings(10, 1000), exporter);
    return new SandboxHost(services, TOKEN, maxHostCalls);
}

/** Returns a `get-mcp-shapes` answer that echoes each requested id as a shape, except the missing ones. */
function shapesFor(revn: number, missing: string[] = []): (params: object) => unknown {
    return (params: object) => {
        const ids = (params as { ids: string[] }).ids;
        return {
            revn,
            shapes: ids.filter((id) => !missing.includes(id)).map((id) => ({ id, name: `shape ${id}` })),
            missing,
        };
    };
}

/** Returns a `get-mcp-page-tree` page for the given root. */
function treePage(revn: number, root: object, truncated = false, nextCursor?: string): object {
    return nextCursor === undefined
        ? { revn, pageId: PAGE, root, truncated }
        : { revn, pageId: PAGE, root, truncated, nextCursor };
}

/** Returns `count` copies of a valid operation, for flushes that only need well-formed operations. */
function deleteOps(count: number): object[] {
    return Array.from({ length: count }, () => ({ ...DELETE_OP }));
}

/** Returns a canned write result with the given revn. */
function writeResult(revn: number): object {
    return { revn, createdIds: {}, changeCount: 0, warnings: [], dryRun: false };
}

test("loadFileOutline returns the JSON of the canned outline", async () => {
    const outline = { id: FILE, name: "Design", pages: [{ id: PAGE, name: "Page 1" }] };
    const backend = new FakePenpotBackend().respond("get-mcp-file-outline", outline);
    const host = harness(backend);

    const text = await host.loadFileOutline(FILE);

    assert.deepEqual(JSON.parse(text), outline);
    assert.deepEqual(backend.callsTo("get-mcp-file-outline")[0]?.params, { fileId: FILE });
});

test("loadPage pages the tree with the cursor and fetches the shapes in tree order", async () => {
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return treePage(
                    7,
                    { id: "root", type: "frame", childCount: 2, children: [{ id: "a", type: "rect", childCount: 0 }] },
                    true,
                    "cursor-2"
                );
            }
            return treePage(7, { id: "b", type: "rect", childCount: 0 });
        })
        .respond("get-mcp-shapes", shapesFor(7));
    const host = harness(backend);

    const text = await host.loadPage(FILE, PAGE);

    const treeCalls = backend.callsTo("get-mcp-page-tree");
    assert.equal(treeCalls.length, 2);
    assert.deepEqual(treeCalls[0]?.params, {
        fileId: FILE,
        pageId: PAGE,
        depth: 20,
        limit: 5000,
        estimateSize: true,
    });
    assert.deepEqual(treeCalls[1]?.params, { fileId: FILE, pageId: PAGE, depth: 20, limit: 5000, cursor: "cursor-2" });
    const shapeCalls = backend.callsTo("get-mcp-shapes");
    assert.equal(shapeCalls.length, 1);
    assert.deepEqual(shapeCalls[0]?.params, {
        fileId: FILE,
        pageId: PAGE,
        ids: ["root", "a", "b"],
        includeChildren: false,
    });
    assert.deepEqual(JSON.parse(text), {
        revn: 7,
        pageId: PAGE,
        fileId: FILE,
        shapes: [
            { id: "root", name: "shape root" },
            { id: "a", name: "shape a" },
            { id: "b", name: "shape b" },
        ],
    });
});

test("loadPage fetches shapes in batches of 200 ids", async () => {
    const children = Array.from({ length: 249 }, (_, index) => ({ id: `c${index}`, type: "rect", childCount: 0 }));
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 249, children }))
        .respond("get-mcp-shapes", shapesFor(1));
    const host = harness(backend);

    const shape = JSON.parse(await host.loadPage(FILE, PAGE)).shapes;

    const shapeCalls = backend.callsTo("get-mcp-shapes");
    assert.deepEqual(
        shapeCalls.map((call) => (call.params as { ids: string[] }).ids.length),
        [200, 50]
    );
    assert.equal(shape.length, 250);
});

test("loadPage skips ids reported as missing", async () => {
    const backend = new FakePenpotBackend()
        .respond(
            "get-mcp-page-tree",
            treePage(3, { id: "root", type: "frame", childCount: 1, children: [{ id: "a" }] })
        )
        .respond("get-mcp-shapes", shapesFor(3, ["a"]));
    const host = harness(backend);

    const page = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(page.shapes, [{ id: "root", name: "shape root" }]);
});

test("loadPage fails when the file changed between two tree pages", async () => {
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return treePage(7, { id: "root", type: "frame", childCount: 0 }, true, "cursor-2");
            }
            return treePage(8, { id: "b", type: "rect", childCount: 0 });
        })
        .respond("get-mcp-shapes", shapesFor(8));
    const host = harness(backend);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message: "the file changed while the page was read; run the script again",
    });
});

test("the 21st distinct page load in one call throws", async () => {
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 0 }))
        .respond("get-mcp-shapes", shapesFor(1));
    const host = harness(backend);

    for (let load = 0; load < 20; load += 1) {
        await host.loadPage(FILE, `${PAGE}-${load}`);
    }
    await assert.rejects(host.loadPage(FILE, `${PAGE}-20`), {
        message: "execute_code loads at most 20 pages per script",
    });
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 20);
});

test("loading a page again does not count twice against the page cap", async () => {
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 0 }))
        .respond("get-mcp-shapes", shapesFor(1));
    const host = harness(backend);

    for (let load = 0; load < 30; load += 1) {
        await host.loadPage(FILE, PAGE);
    }
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 30);
});

test("loadPage fails when the pages held by one call exceed 16 MB", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 0 }))
        .respond("get-mcp-shapes", { revn: 1, shapes: [{ id: "root", name: big }], missing: [] });
    const host = harness(backend);

    await host.loadPage(FILE, `${PAGE}-a`);
    await assert.rejects(host.loadPage(FILE, `${PAGE}-b`), {
        message: /holds at most 16 MB of page data per script/,
    });
});

test("a page that is loaded again replaces its copy in the byte count", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 0 }))
        .respond("get-mcp-shapes", { revn: 1, shapes: [{ id: "root", name: big }], missing: [] });
    const host = harness(backend);

    for (let load = 0; load < 3; load += 1) {
        await host.loadPage(FILE, PAGE);
    }
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 3);
});

test("a page load reports the ids that the backend leaves out as a warning", async () => {
    const backend = new FakePenpotBackend()
        .respond(
            "get-mcp-page-tree",
            treePage(3, {
                id: "root",
                type: "frame",
                childCount: 1,
                children: [{ id: "gone", type: "rect", childCount: 0 }],
            })
        )
        .respond("get-mcp-shapes", shapesFor(3, ["gone"]));
    const host = harness(backend);

    const page = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(
        page.shapes.map((shape: { id: string }) => shape.id),
        ["root"]
    );
    const warnings = host.summary().warnings as Array<{ code: string; count: number }>;
    assert.deepEqual(
        warnings.map((warning) => [warning.code, warning.count]),
        [["shapes-missing", 1]]
    );
});

test("a page with shapes below the depth limit reports a warning", async () => {
    // a chain of 21 nodes: the node at depth 20 has a child that the model cannot hold.
    let node: Record<string, unknown> = { id: "leaf", type: "rect", childCount: 0 };
    for (let depth = 19; depth >= 0; depth -= 1) {
        node = { id: `n${depth}`, type: "group", childCount: 1, children: [node] };
    }
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(4, node))
        .respond("get-mcp-shapes", shapesFor(4));
    const host = harness(backend);

    await host.loadPage(FILE, PAGE);

    const warnings = host.summary().warnings as Array<{ code: string }>;
    assert.ok(warnings.some((warning) => warning.code === "shapes-below-depth-limit"));
});

test("flush sends one mcp-apply-operations call with the operations and a request id", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", {
        revn: 9,
        createdIds: { "$tmp:a": "00000000-0000-4000-8000-0000000000aa" },
        changeCount: 2,
        warnings: [{ kind: "revn-lag" }],
        dryRun: false,
    });
    const host = harness(backend);
    const operations = [
        { op: "create_page", id: "$tmp:a", name: "Page" },
        { op: "delete_shapes", pageId: PAGE, ids: [SHAPE] },
    ];

    const text = await host.flush(FILE, JSON.stringify(operations), false);

    const calls = backend.callsTo("mcp-apply-operations");
    assert.equal(calls.length, 1);
    const params = calls[0]?.params as Record<string, unknown>;
    assert.equal(params.fileId, FILE);
    assert.deepEqual(params.operations, operations);
    assert.match(params.requestId as string, UUID_PATTERN);
    assert.equal("dryRun" in params, false);
    assert.equal(JSON.parse(text).changeCount, 2);
    assert.deepEqual(host.summary(), {
        opsApplied: 2,
        flushes: 1,
        chunks: 1,
        revn: 9,
        warnings: [{ kind: "revn-lag" }],
        createdIds: { "$tmp:a": "00000000-0000-4000-8000-0000000000aa" },
    });
});

test("a dry-run flush sends dryRun and does not count its operations", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", {
        revn: 9,
        createdIds: { "$tmp:a": "00000000-0000-4000-8000-0000000000aa" },
        warnings: [{ kind: "revn-lag" }],
        dryRun: true,
    });
    const host = harness(backend);

    await host.flush(FILE, JSON.stringify([DELETE_OP]), true);

    const params = backend.callsTo("mcp-apply-operations")[0]?.params as Record<string, unknown>;
    assert.equal(params.dryRun, true);
    assert.deepEqual(host.summary(), {
        opsApplied: 0,
        flushes: 0,
        chunks: 0,
        revn: null,
        warnings: [],
        createdIds: {},
    });
});

test("a backend error from a flush propagates with its message", async () => {
    const backend = new FakePenpotBackend().fail("mcp-apply-operations", new Error("Backend error validation: bad"));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify([DELETE_OP]), false), {
        message: "Backend error validation: bad",
    });
    assert.equal(host.summary().opsApplied, 0);
});

test("a flush beyond 5000 operations per call throws before the backend is called", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const operations = Array.from({ length: 5001 }, (_, index) => ({ op: "set", index }));

    await assert.rejects(host.flush(FILE, JSON.stringify(operations), false), {
        message: "execute_code allows at most 5000 operations per script",
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("the operation cap counts over all flushes of one call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const batch = JSON.stringify(deleteOps(3000));

    await host.flush(FILE, batch, false);
    await assert.rejects(host.flush(FILE, batch, false), {
        message: "execute_code allows at most 5000 operations per script",
    });
    // the first flush of 3000 operations goes in two calls of 1500.
    assert.equal(backend.callsTo("mcp-apply-operations").length, 2);
});

test("flush rejects text that is not valid JSON or not a JSON array", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, "[1,", false), SyntaxError);
    await assert.rejects(host.flush(FILE, '{"op":"set"}', false), {
        message: "operations must be a JSON array",
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("a flush with a malformed operation names its index and op, and sends nothing", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const operations = [DELETE_OP, { op: "create_color" }];

    await assert.rejects(host.flush(FILE, JSON.stringify(operations), false), {
        message: /^execute_code: operation 1 \(create_color\) is invalid: color: /,
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
    assert.deepEqual(host.summary(), {
        opsApplied: 0,
        flushes: 0,
        chunks: 0,
        revn: null,
        warnings: [],
        createdIds: {},
    });
});

test("a dry-run flush with a malformed operation is rejected before the backend is called", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify([{ op: "create_color" }]), true), {
        message: /^execute_code: operation 0 \(create_color\) is invalid: /,
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("a flush names an unknown op by its position", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify([DELETE_OP, { op: "set" }]), false), {
        message: /^execute_code: operation 1 has unknown op "set"\. Valid ops: /,
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("a flush of more than 2000 operations reports the index of the invalid one within the whole flush", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const operations = [...deleteOps(2050), { op: "create_color" }];

    await assert.rejects(host.flush(FILE, JSON.stringify(operations), false), {
        message: /^execute_code: operation 2050 \(create_color\) is invalid: /,
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("a valid flush of several operation kinds is sent unchanged", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const operations = [
        { op: "create_color", color: { id: "$tmp:color1", name: "Brand", color: "#ff8800" } },
        { op: "delete_shapes", pageId: PAGE, ids: [SHAPE] },
    ];

    await host.flush(FILE, JSON.stringify(operations), false);

    const params = backend.callsTo("mcp-apply-operations")[0]?.params as { operations: unknown };
    assert.deepEqual(params.operations, operations);
    assert.equal(host.summary().opsApplied, 2);
});

test("rpc rejects commands outside the allow-list", async () => {
    const backend = new FakePenpotBackend();
    const host = harness(backend);

    await assert.rejects(host.rpc("delete-file", "{}"), {
        message: "rpc: delete-file is not available in execute_code",
    });
    await assert.rejects(host.rpc("get-profile", "{}"), {
        message: "rpc: get-profile is not available in execute_code",
    });
    assert.equal(backend.calls.length, 0);
});

test("rpc answers an allowed read command", async () => {
    const backend = new FakePenpotBackend().respond("get-teams", [{ id: "t1" }]);
    const host = harness(backend);

    const text = await host.rpc("get-teams", "{}");

    assert.equal(text, JSON.stringify([{ id: "t1" }]));
});

test("rpc sends an allowed write command through the write queue", async () => {
    const backend = new FakePenpotBackend().respond("create-comment", { id: "c1" });
    const host = harness(backend);
    const params = { fileId: FILE, content: "hello" };

    const text = await host.rpc("create-comment", JSON.stringify(params));

    assert.equal(text, JSON.stringify({ id: "c1" }));
    const calls = backend.callsTo("create-comment");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.params, params);
});

test("rpc rejects parameters that are not a JSON object", async () => {
    const host = harness(new FakePenpotBackend().respond("get-teams", []));

    await assert.rejects(host.rpc("get-teams", "[1]"), {
        message: "rpc parameters must be a JSON object",
    });
});

test("importSvg sends mcp-import-svg with the parameters and counts the flush", async () => {
    const backend = new FakePenpotBackend().respond("mcp-import-svg", {
        revn: 3,
        rootId: "r",
        shapeIds: ["r"],
        changeCount: 1,
    });
    const host = harness(backend);
    const params = { fileId: FILE, pageId: PAGE, svg: "<svg/>", x: 0, y: 0 };

    const text = await host.importSvg(JSON.stringify(params));

    const calls = backend.callsTo("mcp-import-svg");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.params, params);
    assert.deepEqual(JSON.parse(text), { revn: 3, rootId: "r", shapeIds: ["r"], changeCount: 1 });
    assert.equal(host.summary().flushes, 1);
});

test("beginCall resets the counters and the operation cap", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const batch = JSON.stringify(deleteOps(3000));
    await host.flush(FILE, batch, false);

    host.beginCall();

    assert.deepEqual(host.summary(), {
        opsApplied: 0,
        flushes: 0,
        chunks: 0,
        revn: null,
        warnings: [],
        createdIds: {},
    });
    await host.flush(FILE, batch, false);
    // each flush of 3000 operations goes in two calls of 1500.
    assert.equal(backend.callsTo("mcp-apply-operations").length, 4);
});

test("the host call cap refuses the call after the limit", async () => {
    const backend = new FakePenpotBackend().respond("get-mcp-file-outline", { id: FILE });
    const host = harness(backend, new FakeExporterClient(), 2);

    await host.loadFileOutline(FILE);
    await host.loadFileOutline(FILE);
    await assert.rejects(host.loadFileOutline(FILE), {
        message: "execute_code allows at most 2 host calls per script",
    });
    assert.equal(backend.callsTo("get-mcp-file-outline").length, 2);
});

test("the export cap refuses the 21st export or media upload of one call", async () => {
    const exporter = new FakeExporterClient().respondDownload({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
    });
    const backend = new FakePenpotBackend()
        .respond("create-mcp-render-session", {
            token: "render-token",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .respond("create-file-media-object-from-url", { id: "m1" });
    const host = harness(backend, exporter);
    const exportParams = JSON.stringify({ fileId: FILE, mediaId: "m1" });
    const uploadParams = JSON.stringify({ fileId: FILE, url: "https://example.com/a.png" });
    const capMessage = "execute_code allows at most 20 exports and media uploads per script";

    for (let index = 0; index < 10; index += 1) {
        await host.exportShape(exportParams);
        await host.uploadMediaUrl(uploadParams);
    }
    await assert.rejects(host.exportShape(exportParams), { message: capMessage });
    await assert.rejects(host.uploadMediaUrl(uploadParams), { message: capMessage });
    await assert.rejects(
        host.uploadMediaData(JSON.stringify({ fileId: FILE, name: "a.png", mimeType: "image/png", base64: "AQID" })),
        { message: capMessage }
    );
    assert.equal(exporter.downloads.length, 10);
    assert.equal(backend.callsTo("create-file-media-object-from-url").length, 10);
});

test("every primitive that reaches the backend or the exporter charges the rate limit once", async () => {
    const exporter = new FakeExporterClient().respondDownload({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    const backend = new FakePenpotBackend()
        .respond("get-mcp-file-outline", { id: FILE })
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 0 }))
        .respond("get-mcp-shapes", shapesFor(1))
        .respond("mcp-apply-operations", writeResult(1))
        .respond("mcp-import-svg", { revn: 1, rootId: "r", shapeIds: ["r"], changeCount: 1 })
        .respond("get-teams", [])
        .respond("create-mcp-render-session", {
            token: "render-token",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .respond("create-file-media-object-from-url", { id: "m1" })
        .respond("upload-file-media-object", { id: "m2" });
    const services = new BackendServices(backend, new BackendSettings(10, 1000), exporter);
    const charges: string[] = [];
    Object.assign(services, {
        rateLimiter: {
            acquire: (token: string) => {
                charges.push(token);
            },
        },
    });
    const host = new SandboxHost(services, TOKEN);

    await host.loadFileOutline(FILE);
    await host.loadPage(FILE, PAGE);
    await host.flush(FILE, JSON.stringify([DELETE_OP]), false);
    await host.importSvg(JSON.stringify({ fileId: FILE, pageId: PAGE, svg: "<svg/>" }));
    await host.rpc("get-teams", "{}");
    await host.exportShape(JSON.stringify({ fileId: FILE, mediaId: "m1" }));
    await host.uploadMediaUrl(JSON.stringify({ fileId: FILE, url: "https://example.com/a.png" }));
    await host.uploadMediaData(JSON.stringify({ fileId: FILE, name: "a.png", mimeType: "image/png", base64: "AQID" }));
    assert.deepEqual(
        charges,
        Array.from({ length: 8 }, () => TOKEN)
    );

    await assert.rejects(host.rpc("delete-file", "{}"), {
        message: "rpc: delete-file is not available in execute_code",
    });
    assert.equal(charges.length, 8);
});

test("a call whose wall-clock deadline has passed is refused before the backend is called", async () => {
    const backend = new FakePenpotBackend().respond("get-mcp-file-outline", { id: FILE });
    const host = harness(backend);

    host.beginCall(Date.now() - 1);
    await assert.rejects(host.loadFileOutline(FILE), {
        message: "The script exceeded the wall-clock time limit",
    });
    assert.equal(backend.calls.length, 0);

    host.beginCall(Date.now() + 60_000);
    assert.equal(JSON.parse(await host.loadFileOutline(FILE)).id, FILE);
});

test("loadPage stops at the first shape batch that takes the call over 16 MB", async () => {
    const children = Array.from({ length: 201 }, (_, index) => ({ id: `c${index}`, type: "rect", childCount: 0 }));
    const big = "x".repeat(17 * 1024 * 1024);
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(1, { id: "root", type: "frame", childCount: 201, children }))
        .respond("get-mcp-shapes", (params: object) => ({
            revn: 1,
            shapes: [{ id: (params as { ids: string[] }).ids[0], name: big }],
            missing: [],
        }));
    const host = harness(backend);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message: /^page .* has 202 shapes \(about [0-9.]+ MB\)/,
    });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
});

/**
 * Returns a fake `mcp-apply-operations` answer that maps every handle of the call to an id and counts up the revn.
 *
 * @param firstRevn - revn of the first answer
 * @returns the canned answer
 */
function countingWrites(firstRevn: number): (params: object) => unknown {
    let revn = firstRevn - 1;
    return (params: object) => {
        revn += 1;
        const createdIds: Record<string, string> = {};
        for (const operation of (params as { operations: Array<Record<string, unknown>> }).operations) {
            if (typeof operation.id === "string" && operation.id.startsWith("$tmp:")) {
                createdIds[operation.id] = `id-${operation.id.slice(5)}`;
            }
        }
        return { revn, createdIds, warnings: [], dryRun: false };
    };
}

/** Returns the operations of one recorded `mcp-apply-operations` call. */
function operationsOf(call: { params?: unknown } | undefined): Array<Record<string, unknown>> {
    return (call?.params as { operations: Array<Record<string, unknown>> }).operations;
}

test("a flush over 1500 operations goes in calls of 1500, and later calls name earlier handles by id", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    const operations = [
        { op: "create_page", id: "$tmp:p", name: "Page" },
        ...deleteOps(3100),
        { op: "update_page", id: "$tmp:p", name: "Renamed" },
    ];

    const answer = JSON.parse(await host.flush(FILE, JSON.stringify(operations), false));

    const calls = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(
        calls.map((call) => operationsOf(call).length),
        [1500, 1500, 102]
    );
    assert.equal(operationsOf(calls[0])[0].id, "$tmp:p");
    assert.deepEqual(operationsOf(calls[2])[101], { op: "update_page", id: "id-p", name: "Renamed" });
    assert.equal(answer.revn, 4);
    assert.deepEqual(answer.createdIds, { "$tmp:p": "id-p" });
    assert.deepEqual(host.summary(), {
        opsApplied: 3102,
        flushes: 1,
        chunks: 3,
        revn: 4,
        warnings: [],
        createdIds: { "$tmp:p": "id-p" },
    });
});

test("a flush holds the write queue of the file across all of its calls", async () => {
    const order: string[] = [];
    let otherWrite: Promise<void> | undefined;
    const backend = new FakePenpotBackend();
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    const writes = countingWrites(2);
    backend.respond("mcp-apply-operations", (params: object) => {
        order.push(`call of ${operationsOf({ params }).length}`);
        if (otherWrite === undefined) {
            // another write of the same token to the same file arrives while the first call runs.
            otherWrite = services.writeQueue.run(TokenDigest.sha256Hex(TOKEN), FILE, async () => {
                order.push("other write");
            });
        }
        return writes(params);
    });
    const host = new SandboxHost(services, TOKEN);

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    await otherWrite;

    assert.deepEqual(order, ["call of 1500", "call of 600", "other write"]);
});

test("a failed later call names its chunk and the committed operations, and the summary keeps the earlier call", async () => {
    let calls = 0;
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", () => {
        calls += 1;
        if (calls === 2) {
            throw new Error("Backend error validation: second call refused");
        }
        return writeResult(5);
    });
    const host = harness(backend);

    // a later call that fails comes back as data: the guest adopts the ids and throws the message.
    const failure = JSON.parse(await host.flush(FILE, JSON.stringify(deleteOps(2100)), false)).failure;
    assert.deepEqual(failure, {
        message:
            "execute_code: chunk 2 of 2 of a flush failed. 1500 of 2100 operations of this flush were committed by " +
            "the earlier chunks, and those chunks stay applied. Chunk 2 and the later chunks were not applied. " +
            "Backend error validation: second call refused",
        committed: 1500,
        createdIds: {},
    });
    assert.deepEqual(host.summary(), {
        opsApplied: 1500,
        flushes: 0,
        chunks: 1,
        revn: 5,
        warnings: [],
        createdIds: {},
    });
});

test("a failed single call keeps the backend message as it is", async () => {
    const backend = new FakePenpotBackend().fail("mcp-apply-operations", new Error("Backend error validation: bad"));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify(deleteOps(1500)), false), {
        message: "Backend error validation: bad",
    });
});

test("the write options go to every call, and a later call takes the revn of the earlier one as its base", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(7));
    const host = harness(backend);
    host.beginCall(Number.POSITIVE_INFINITY, {
        snapshot: false,
        baseRevn: 4,
        failOnConflict: true,
        allowSplit: true,
    });

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    await host.flush(FILE, JSON.stringify(deleteOps(1)), true);
    await host.flush(FILE, JSON.stringify(deleteOps(1)), false);

    const calls = backend.callsTo("mcp-apply-operations").map((call) => call.params as Record<string, unknown>);
    // the dry run answers revn 9 too, but a dry run does not move the base.
    assert.deepEqual(
        calls.map((params) => params.baseRevn),
        [4, 7, 8, 8]
    );
    for (const params of calls) {
        assert.equal(params.failOnConflict, true);
        assert.equal(params.allowSplit, true);
    }
    // the script's options say no snapshot, so no call takes one.
    for (const params of calls.filter((params) => params.dryRun !== true)) {
        assert.equal(params.snapshot, false);
    }
    assert.equal(calls[2].dryRun, true);
});

test("an unset snapshot leaves the choice to the backend, on every call of the script", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    host.beginCall(Number.POSITIVE_INFINITY, {});

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    await host.flush(FILE, JSON.stringify(deleteOps(10)), false);

    for (const call of backend.callsTo("mcp-apply-operations")) {
        assert.equal("snapshot" in (call.params as object), false);
    }
});

test("an explicit snapshot false sends false on every call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    host.beginCall(Number.POSITIVE_INFINITY, { snapshot: false });

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);

    assert.deepEqual(
        backend.callsTo("mcp-apply-operations").map((call) => (call.params as { snapshot: boolean }).snapshot),
        [false, false]
    );
});

test("a call without write options sends no conflict or split options", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);

    for (const call of backend.callsTo("mcp-apply-operations")) {
        assert.deepEqual(Object.keys(call.params as object).sort(), ["fileId", "operations", "requestId"]);
    }
});

test("a flush of up to 2000 operations is one call, and 2001 operations are split", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);

    await host.flush(FILE, JSON.stringify(deleteOps(2000)), false);
    assert.deepEqual(
        backend.callsTo("mcp-apply-operations").map((call) => operationsOf(call).length),
        [2000]
    );

    await host.flush(FILE, JSON.stringify(deleteOps(2001)), false);
    assert.deepEqual(
        backend
            .callsTo("mcp-apply-operations")
            .slice(1)
            .map((call) => operationsOf(call).length),
        [1500, 501]
    );
});

test("the first write of a script takes the snapshot, and the request ids of one script are derived from one id", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    host.beginCall(Number.POSITIVE_INFINITY, { snapshot: true });

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    await host.flush(FILE, JSON.stringify(deleteOps(10)), false);

    const calls = backend.callsTo("mcp-apply-operations").map((call) => call.params as Record<string, unknown>);
    assert.deepEqual(
        calls.map((params) => params.snapshot),
        [true, false, false]
    );
    const ids = calls.map((params) => params.requestId as string);
    assert.equal(new Set(ids).size, 3, "every call has its own request id");
    for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }

    // a second script gets other ids.
    host.beginCall(Number.POSITIVE_INFINITY, { snapshot: true });
    await host.flush(FILE, JSON.stringify(deleteOps(10)), false);
    const again = backend.callsTo("mcp-apply-operations").at(-1)?.params as Record<string, unknown>;
    assert.equal(again.snapshot, true);
    assert.equal(ids.includes(again.requestId as string), false);
});

test("a flush waits for rate-limit tokens for all its calls, and the wait ends at the deadline", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    let refusals = 3;
    (services as unknown as { rateLimiter: { acquire(token: string): void } }).rateLimiter = {
        acquire() {
            if (refusals > 0) {
                refusals -= 1;
                throw new Error("rate limited, retry after 1 s");
            }
        },
    };
    const host = new SandboxHost(services, TOKEN);
    host.beginCall(Date.now() + 5_000, {});

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 2, "both calls went through after the waits");

    refusals = Number.POSITIVE_INFINITY;
    host.beginCall(Date.now() + 250, {});
    await assert.rejects(host.flush(FILE, JSON.stringify(deleteOps(10)), false), {
        message: "The script exceeded the wall-clock time limit",
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 2, "no call is sent without a token");
});

test("a write in flight at the deadline finishes, and its answer is in the summary", async () => {
    const backend = new FakePenpotBackend().respond(
        "mcp-apply-operations",
        () => new Promise((resolve) => setTimeout(() => resolve(writeResult(6)), 200))
    );
    const host = harness(backend);
    host.beginCall(Date.now() + 50, {});

    const answer = JSON.parse(await host.flush(FILE, JSON.stringify(deleteOps(3)), false));

    assert.equal(answer.revn, 6);
    assert.equal(host.summary().opsApplied, 3);
    assert.equal(host.summary().chunks, 1);
});

test("a dry run of up to 2000 operations goes in one call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", { revn: 1, dryRun: true });
    const host = harness(backend);

    await host.flush(FILE, JSON.stringify(deleteOps(2000)), true);

    const calls = backend.callsTo("mcp-apply-operations");
    assert.equal(calls.length, 1);
    assert.equal(operationsOf(calls[0]).length, 2000);
    assert.equal(host.summary().chunks, 0);
});

test("a dry run of more than 2000 operations is refused before the backend is called", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", { revn: 1, dryRun: true });
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify(deleteOps(2001)), true), {
        message:
            "execute_code: a dry run checks its flush in one call, which takes at most 2000 operations; " +
            "this flush has 2001. Dry run a smaller part of the script.",
    });
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("an apply_token without a value gets it from the catalogue, read once per file and call", async () => {
    const backend = new FakePenpotBackend()
        .respond("get-mcp-tokens", {
            sets: [{ id: "set-1", active: true }],
            tokens: [
                { setId: "set-1", name: "spacing.base", type: "spacing", value: "8px" },
                { setId: "set-1", name: "spacing.large", type: "spacing", value: "{spacing.base} * 2" },
            ],
            activeSets: ["set-1"],
        })
        .respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const apply = (tokenName: string) => ({
        op: "apply_token",
        pageId: PAGE,
        shapeIds: [SHAPE],
        tokenName,
        attributes: ["width"],
    });

    await host.flush(FILE, JSON.stringify([apply("spacing.base")]), false);
    await host.flush(FILE, JSON.stringify([apply("spacing.large")]), false);

    const values = backend.callsTo("mcp-apply-operations").map((call) => operationsOf(call)[0].resolvedValue);
    assert.deepEqual(values, [8, 16]);
    assert.equal(backend.callsTo("get-mcp-tokens").length, 1);
});

test("a failed later call returns the ids of the saved calls, and only those", async () => {
    let calls = 0;
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", () => {
        calls += 1;
        if (calls === 2) {
            throw new Error("Backend error validation: second call refused");
        }
        return { revn: 5, createdIds: { "$tmp:first": "id-first" }, warnings: [], dryRun: false };
    });
    const host = harness(backend);
    const operations = [...deleteOps(2099), { op: "delete_shapes", id: "$tmp:first", pageId: PAGE, ids: [SHAPE] }];

    const failure = JSON.parse(await host.flush(FILE, JSON.stringify(operations), false)).failure;

    assert.equal(failure.committed, 1500);
    assert.deepEqual(failure.createdIds, { "$tmp:first": "id-first" });
    assert.equal(host.summary().chunks, 1);
});

test("a single call that fails still throws, and a dry run that fails still throws", async () => {
    const backend = new FakePenpotBackend().fail("mcp-apply-operations", new Error("Backend error validation: bad"));
    const host = harness(backend);

    await assert.rejects(host.flush(FILE, JSON.stringify(deleteOps(10)), false), {
        message: "Backend error validation: bad",
    });
    await assert.rejects(host.flush(FILE, JSON.stringify(deleteOps(10)), true), {
        message: "Backend error validation: bad",
    });
});

test("a later call replaces only the handles in id fields, not the same text elsewhere", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    const operations = [
        { op: "create_rect", id: "$tmp:a", pageId: PAGE, x: 0, y: 0, width: 1, height: 1, name: "$tmp:a" },
        ...deleteOps(2099),
        { op: "update_shape", pageId: PAGE, id: "$tmp:a", props: { name: "$tmp:a" } },
    ];

    await host.flush(FILE, JSON.stringify(operations), false);

    const second = operationsOf(backend.callsTo("mcp-apply-operations")[1]);
    assert.equal(second[second.length - 1].id, "id-a");
    assert.equal((second[second.length - 1].props as { name: string }).name, "$tmp:a");
});

test("without failOnConflict the base revision stays the caller's for every call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(7));
    const host = harness(backend);
    host.beginCall(Number.POSITIVE_INFINITY, { baseRevn: 4 });

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);
    await host.flush(FILE, JSON.stringify(deleteOps(1)), false);

    assert.deepEqual(
        backend.callsTo("mcp-apply-operations").map((call) => (call.params as { baseRevn?: number }).baseRevn),
        [4, 4, 4]
    );
});

test("a flush reports progress after each of its chunks", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const host = harness(backend);
    const lines: string[] = [];
    host.setProgress((_done, _total, line) => lines.push(line));

    await host.flush(FILE, JSON.stringify(deleteOps(2100)), false);

    assert.deepEqual(lines, [
        "1500 of 2100 operations of the flush are applied",
        "2100 of 2100 operations of the flush are applied",
    ]);
});

/** Backend whose first `mcp-apply-operations` call waits until the test releases it, so a flush is in flight. */
class GatedBackend extends FakePenpotBackend {
    private releaseGate: () => void = () => undefined;
    private readonly gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
    });

    /** Number of `mcp-apply-operations` calls started, including the gated one. */
    public started = 0;

    /** Lets the gated call go on. */
    public release(): void {
        this.releaseGate();
    }

    public override async callCommand<T = unknown>(userToken: string, name: string, params: object): Promise<T> {
        if (name === "mcp-apply-operations") {
            this.started += 1;
        }
        if (name === "mcp-apply-operations" && this.started === 1) {
            await this.gate;
        }
        return super.callCommand<T>(userToken, name, params);
    }
}

/**
 * Waits until a condition holds, checking after each event-loop turn.
 *
 * @param condition - the condition to wait for
 */
async function waitUntil(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !condition(); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(condition(), "the condition did not hold");
}

test("an abandoned flush sends no call after the one in flight, and reports what the earlier calls applied", async () => {
    const backend = new GatedBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const flushing = host.flush(FILE, JSON.stringify(deleteOps(4000)), false);
    await waitUntil(() => backend.started === 1);
    host.abandon();
    backend.release();
    const answer = JSON.parse(await flushing) as { failure?: { committed: number } };
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1, "the chunks after the first were not sent");
    assert.equal(answer.failure?.committed, 1500);
});

test("settled waits for the call in flight, so the totals of an abandoned script are final", async () => {
    const backend = new GatedBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const flushing = host.flush(FILE, JSON.stringify(deleteOps(4000)), false);
    await waitUntil(() => backend.started === 1);
    host.abandon();
    const settling = host.settled(5000);
    backend.release();
    await settling;
    await flushing;
    assert.equal(host.summary().chunks, 1);
    assert.equal(host.summary().opsApplied, 1500);
});

test("settled gives up after its time when the call in flight never answers", async () => {
    const backend = new GatedBackend().respond("mcp-apply-operations", writeResult(1));
    const host = harness(backend);
    const flushing = host.flush(FILE, JSON.stringify(deleteOps(4000)), false);
    await waitUntil(() => backend.started === 1);
    const started = Date.now();
    await host.settled(100);
    assert.ok(Date.now() - started < 2000, "settled returned after its own limit");
    backend.release();
    await flushing;
});

test("a page above the setting fails with its id, shape count and size, and the way out", async () => {
    const big = "x".repeat(4096);
    const children = Array.from({ length: 300 }, (_, index) => ({ id: `s${index}`, type: "rect", childCount: 0 }));
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(3, { id: "root", type: "frame", childCount: 300, children }))
        .respond("get-mcp-shapes", (params: object) => ({
            revn: 3,
            shapes: (params as { ids: string[] }).ids.map((id) => ({ id, name: big })),
            missing: [],
        }));
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    const host = new SandboxHost(services, TOKEN, undefined, 512 * 1024);

    await assert.rejects(host.loadPage(FILE, PAGE), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`^page ${PAGE} has 301 shapes \\(about [0-9.]+ MB\\); `));
        assert.match(
            error.message,
            /; the limit is 0\.5 MB \(PENPOT_MCP_SANDBOX_PAGE_MB\)\. Pass rootIds to load only the boards the script needs/
        );
        assert.match(error.message, /or use export_subtree, get_shapes and find_shapes for reads\.$/);
        return true;
    });
});

test("a page far above the setting stops after its first batch, before the rest is fetched or serialised", async () => {
    const big = "x".repeat(5000);
    const children = Array.from({ length: 2000 }, (_, index) => ({ id: `c${index}`, type: "rect", childCount: 0 }));
    const backend = new FakePenpotBackend()
        .respond("get-mcp-page-tree", treePage(4, { id: "root", type: "frame", childCount: 2000, children }))
        .respond("get-mcp-shapes", (params: object) => ({
            revn: 4,
            shapes: (params as { ids: string[] }).ids.map((id) => ({ id, name: big })),
            missing: [],
        }));
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    const host = new SandboxHost(services, TOKEN, undefined, 1024 * 1024);

    await assert.rejects(host.loadPage(FILE, PAGE), { message: /^page .* has 2001 shapes \(about [0-9.]+ MB\)/ });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
});

test("a rate-limit wait gives the script's global slot back, and the script takes it again after the wait", async () => {
    const backend = new FakePenpotBackend().respond("mcp-apply-operations", countingWrites(2));
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    let refusals = 2;
    (services as unknown as { rateLimiter: { acquire(token: string): void } }).rateLimiter = {
        acquire() {
            if (refusals > 0) {
                refusals -= 1;
                throw new Error("rate limited, retry after 1 s");
            }
        },
    };
    const slots = new CallSlots(1, 1000);
    const holder = new SlotHolder(slots);
    await holder.take();
    const host = new SandboxHost(services, TOKEN);
    host.beginCall(Date.now() + 5_000, {});
    host.setWaitHook(() => holder.yieldForWait());

    const flush = host.flush(FILE, JSON.stringify(deleteOps(10)), false);
    // while the flush waits for its rate-limit token, another token's script takes the only slot
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = await slots.acquire();
    other();
    await flush;

    assert.equal(backend.callsTo("mcp-apply-operations").length, 1);
    assert.equal(slots.running, 1, "the script holds its slot again after the wait");
    holder.free();
});

/** A shape of a page for the partial loads: its id, its parent id, and a name that may be long. */
interface PageEntry {
    id: string;
    parentId: string;
    name?: string;
    /** Makes the entry a board with this layout: its children are stored in the reverse of their visual order. */
    layout?: "flex" | "grid";
}

/** The id of the page root, which the backend names with the nil uuid. */
const PAGE_ROOT = "00000000-0000-0000-0000-000000000000";

/**
 * The shapes of the partial-load page: board `board` with children `c1` and `c2` (which holds `c2a`), a second board
 * `other` with child `o1`, and a top-level shape `far`.
 */
const PARTIAL_ENTRIES: PageEntry[] = [
    { id: "board", parentId: PAGE_ROOT },
    { id: "c1", parentId: "board" },
    { id: "c2", parentId: "board" },
    { id: "c2a", parentId: "c2" },
    { id: "other", parentId: PAGE_ROOT },
    { id: "o1", parentId: "other" },
    { id: "far", parentId: PAGE_ROOT },
];

/** The revn of the fake partial page. */
const PAGE_REVN = 9;

/**
 * Answers the page commands for a flat list of shapes, as the backend does. The tree starts at the root that the call
 * names, or at the page root, and stops at `depth` levels: a node below the last level lists no children and reports
 * its `childCount`. The children of a board with a layout come in the reverse of their stored order, as the tree
 * command of the backend does (`shape-children` in `backend/src/app/rpc/commands/mcp.clj`). A root the page does not
 * hold fails with `shape-not-found`. A shape reply carries the stored child list of each shape, and can be cut short
 * with `shapeReplyLimit`. The list `entries` is read at each call, so a test can change the page between two loads.
 *
 * The shape reply mirrors `get-mcp-shapes` of the backend, whose order the backend test
 * `shapes-with-children-come-in-stored-order-children-first` pins: with `includeChildren` the descendants of each requested shape
 * follow it, in stored child order, all the children of a shape before the descendants of its first child
 * (`get-children-ids` in `common/src/app/common/files/helpers.cljc`); with `includeAncestors` the ancestors of the
 * requested shapes up to the page root come first, top down, each once (`get-ancestor-ids` in `mcp.clj`).
 *
 * @param entries - the shapes of the page, in stored order
 * @param options - the limit of a shape reply, and the size estimate that the first tree window reports
 * @returns the answers of the commands
 */
function partialPage(
    entries: PageEntry[],
    options: { shapeReplyLimit?: number; estimate?: { totalShapes: number; estimatedBytes: number } } = {}
): { tree: (params: object) => unknown; shapes: (params: object) => unknown; importSvg: () => unknown } {
    const childrenOf = (id: string): string[] =>
        entries.filter((entry) => entry.parentId === id).map((entry) => entry.id);
    const visualChildrenOf = (id: string): string[] => {
        const children = childrenOf(id);
        return entries.find((entry) => entry.id === id)?.layout === undefined ? children : children.reverse();
    };
    const recordsOf = (): Map<string, Record<string, unknown>> => {
        const records = new Map<string, Record<string, unknown>>();
        records.set(PAGE_ROOT, { id: PAGE_ROOT, name: "Root", shapes: childrenOf(PAGE_ROOT), x: 0, y: 0 });
        for (const entry of entries) {
            records.set(entry.id, {
                id: entry.id,
                type: entry.layout === undefined ? "rect" : "frame",
                ...(entry.layout === undefined ? {} : { layout: entry.layout }),
                name: entry.name ?? entry.id,
                parentId: entry.parentId,
                shapes: childrenOf(entry.id),
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            });
        }
        return records;
    };
    return {
        tree: (params: object) => {
            const {
                rootId = PAGE_ROOT,
                depth = 20,
                estimateSize = false,
            } = params as {
                rootId?: string;
                depth?: number;
                estimateSize?: boolean;
            };
            if (!recordsOf().has(rootId)) {
                throw new BackendRpcError(400, "get-mcp-page-tree", {
                    type: "not-found",
                    code: "shape-not-found",
                    hint: "root shape not found in page",
                });
            }
            const build = (id: string, level: number): { id: string; childCount: number; children: unknown[] } => ({
                id,
                childCount: childrenOf(id).length,
                children: level < depth ? visualChildrenOf(id).map((child) => build(child, level + 1)) : [],
            });
            return {
                revn: PAGE_REVN,
                pageId: PAGE,
                root: build(rootId, 1),
                truncated: false,
                ...(estimateSize ? (options.estimate ?? {}) : {}),
            };
        },
        shapes: (params: object) => {
            const {
                ids,
                includeChildren = false,
                includeAncestors = false,
            } = params as {
                ids: string[];
                includeChildren?: boolean;
                includeAncestors?: boolean;
            };
            const records = recordsOf();
            const found = [...new Set(ids)].filter((id) => records.has(id));
            const below = (id: string): string[] => {
                const kids = childrenOf(id);
                return [...kids, ...kids.flatMap(below)];
            };
            const chosen = includeChildren ? [...new Set(found.flatMap((id) => [id, ...below(id)]))] : found;
            const seen = new Set(chosen);
            const ancestors: string[] = [];
            if (includeAncestors) {
                for (const id of found) {
                    const chain: string[] = [];
                    let parent = records.get(id)?.parentId as string | undefined;
                    while (parent !== undefined && records.has(parent) && !seen.has(parent)) {
                        chain.unshift(parent);
                        parent = records.get(parent)?.parentId as string | undefined;
                    }
                    for (const link of chain) {
                        seen.add(link);
                        ancestors.push(link);
                    }
                }
            }
            const present = [...ancestors, ...chosen];
            const kept = options.shapeReplyLimit === undefined ? present : present.slice(0, options.shapeReplyLimit);
            return {
                revn: PAGE_REVN,
                shapes: kept.map((id) => records.get(id)),
                missing: ids.filter((id) => !records.has(id)),
                truncated: kept.length < present.length,
            };
        },
        importSvg: () => {
            entries.push({ id: "imp1", parentId: PAGE_ROOT, name: "Svg" });
            return { revn: PAGE_REVN, rootId: "imp1", shapeIds: ["imp1"] };
        },
    };
}

/**
 * Builds a host whose call has the given roots on {@link PAGE}, and counts the rate-limit tokens that it takes.
 *
 * @param backend - fake backend that answers the commands
 * @param rootIds - roots of the call
 * @param maxPageBytes - cap of the page data, or the default when omitted
 * @returns the host and the count of tokens taken so far
 */
function scopedHost(
    backend: FakePenpotBackend,
    rootIds: string[],
    maxPageBytes?: number
): { host: SandboxHost; tokens: () => number } {
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    let tokens = 0;
    const limiter = services.rateLimiter as unknown as { acquire: (token: string) => Promise<void> };
    const acquire = limiter.acquire.bind(limiter);
    limiter.acquire = async (token: string) => {
        tokens += 1;
        return acquire(token);
    };
    const scope = SandboxHost.partialScope(FILE, PAGE, rootIds);
    return { host: new SandboxHost(services, TOKEN, undefined, maxPageBytes, scope), tokens: () => tokens };
}

/**
 * Builds a fake backend that answers the page commands of a {@link partialPage}.
 *
 * @param page - the answers of the page
 * @returns the fake backend
 */
function backendOf(page: ReturnType<typeof partialPage>): FakePenpotBackend {
    return new FakePenpotBackend()
        .respond("get-mcp-page-tree", page.tree)
        .respond("get-mcp-shapes", page.shapes)
        .respond("mcp-import-svg", page.importSvg);
}

/**
 * Returns the ids of the shapes of a loaded page, in order.
 *
 * @param loaded - the parsed text of a page load
 * @returns the ids
 */
function idsOf(loaded: { shapes: Array<{ id: string }> }): string[] {
    return loaded.shapes.map((shape) => shape.id);
}

test("a partial load of one root reads its subtree and its ancestors, and marks what is cut", async () => {
    const page = partialPage(PARTIAL_ENTRIES);
    const backend = backendOf(page);
    const { host } = scopedHost(backend, ["c2"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(loaded.partial, true);
    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "board", "c2", "c2a"]);
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0, "a partial load makes no tree call");
    assert.deepEqual(
        backend.callsTo("get-mcp-shapes").map((call) => call.params),
        [{ fileId: FILE, pageId: PAGE, ids: ["c2"], includeChildren: true, includeAncestors: true }]
    );
    const requested = backend.callsTo("get-mcp-shapes").flatMap((call) => (call.params as { ids: string[] }).ids);
    for (const id of requested) {
        assert.ok([PAGE_ROOT, "board", "c2", "c2a"].includes(id), `shape ${id} is not part of the load`);
    }
    const byId = new Map<string, Record<string, unknown>>(
        loaded.shapes.map((shape: Record<string, unknown>) => [shape.id as string, shape])
    );
    assert.deepEqual(byId.get(PAGE_ROOT)?.shapes, ["board"]);
    assert.equal(byId.get(PAGE_ROOT)?.partialChildren, true);
    assert.equal(byId.get(PAGE_ROOT)?.childCount, 3);
    assert.deepEqual(byId.get("board")?.shapes, ["c2"]);
    assert.equal(byId.get("board")?.partialChildren, true);
    assert.equal(byId.get("board")?.childCount, 2);
    assert.equal(byId.get("board")?.ancestorOnly, true);
    assert.equal(byId.get("c2")?.ancestorOnly, undefined);
    assert.equal(byId.get("c2")?.partialChildren, undefined, "a child list that is whole is not marked");
    assert.deepEqual(host.summary().warnings, [
        { code: "partial-page", pageId: PAGE, rootIds: ["c2"], shapes: 2, ancestors: ["board"] },
    ]);
});

test("two roots, one inside the other, load each shape once, with the roots in the order given", async () => {
    const page = partialPage(PARTIAL_ENTRIES);
    const backend = backendOf(page);
    const { host } = scopedHost(backend, ["board", "c2"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0, "a partial load makes no tree call");
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "board", "c1", "c2", "c2a"]);
    const requested = backend.callsTo("get-mcp-shapes").flatMap((call) => (call.params as { ids: string[] }).ids);
    assert.equal(new Set(requested).size, requested.length, "a shape was asked for twice");
});

test("an unknown root fails the first load and names the id", async () => {
    const page = partialPage(PARTIAL_ENTRIES);
    const { host } = scopedHost(backendOf(page), ["nope"]);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message: /root shape nope is not a shape of page/,
    });
});

test("a partial load of a small root fits although the rest of the page is far above the cap", async () => {
    const big = "x".repeat(10_000);
    const entries: PageEntry[] = [
        { id: "small", parentId: PAGE_ROOT },
        { id: "s1", parentId: "small" },
    ];
    for (let index = 0; index < 4000; index += 1) {
        entries.push({ id: `big${index}`, parentId: PAGE_ROOT, name: big });
    }
    const page = partialPage(entries);
    const backend = backendOf(page);
    const { host } = scopedHost(backend, ["small"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "small", "s1"]);
    assert.ok(backend.callsTo("get-mcp-page-tree").every((call) => (call.params as { rootId?: string }).rootId));
});

test("a root that is itself above the cap fails with the limit and the way out", async () => {
    const entries: PageEntry[] = [{ id: "big", parentId: PAGE_ROOT }];
    for (let index = 0; index < 300; index += 1) {
        entries.push({ id: `k${index}`, parentId: "big", name: "x".repeat(4096) });
    }
    const { host } = scopedHost(backendOf(partialPage(entries)), ["big"], 512 * 1024);

    // the count is of the shapes received: the 301 under the root and the page root, which came as its ancestor
    await assert.rejects(host.loadPage(FILE, PAGE), {
        message:
            /^page .* has 302 shapes \(about [0-9.]+ MB\); the limit is 0\.5 MB \(PENPOT_MCP_SANDBOX_PAGE_MB\)\. Pass fewer or smaller rootIds, or use export_subtree, get_shapes and find_shapes for reads\.$/,
    });
});

test("the roots of a call are checked: 1 to 20 after repeats are removed, and the page root is refused", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `r${index}`);
    assert.deepEqual(SandboxHost.partialScope(FILE, PAGE, ["a", "a", "b"]).rootIds, ["a", "b"]);
    assert.equal(SandboxHost.partialScope(FILE, PAGE, ids).rootIds.length, 20);
    assert.throws(() => SandboxHost.partialScope(FILE, PAGE, [...ids, "r20"]), /1 to 20 rootIds/);
    assert.throws(() => SandboxHost.partialScope(FILE, PAGE, []), /1 to 20 rootIds/);
    assert.throws(() => SandboxHost.partialScope(FILE, PAGE, [PAGE_ROOT]), {
        message: /leave rootIds out to load the whole page/,
    });
});

test("a first partial load takes one rate-limit token per root, and a refresh takes one", async () => {
    const page = partialPage(PARTIAL_ENTRIES);
    const { host, tokens } = scopedHost(backendOf(page), ["board", "c2", "c1"]);

    await host.loadPage(FILE, PAGE);
    assert.equal(tokens(), 3);
    await host.loadPage(FILE, PAGE);
    assert.equal(tokens(), 4);
});

test("a shape reply that is cut short is asked again, so both roots load", async () => {
    const page = partialPage(PARTIAL_ENTRIES, { shapeReplyLimit: 1 });
    const { host } = scopedHost(backendOf(page), ["board", "c2"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "board", "c1", "c2", "c2a"]);
});

test("a chain 25 deep below a root loads completely, in one shape call and no tree call", async () => {
    const entries: PageEntry[] = [{ id: "top", parentId: PAGE_ROOT }];
    let parent = "top";
    for (let level = 0; level < 24; level += 1) {
        entries.push({ id: `d${level}`, parentId: parent });
        parent = `d${level}`;
    }
    const backend = backendOf(partialPage(entries));
    const { host } = scopedHost(backend, ["top"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(loaded.shapes.length, 26);
    assert.equal(loaded.shapes[loaded.shapes.length - 1].id, "d23");
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0, "a partial load makes no tree call");
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
    assert.deepEqual(
        (host.summary().warnings as Array<{ code: string }>).map((warning) => warning.code),
        ["partial-page"]
    );
});

/**
 * Builds a page of one root with many sections, each with one large leaf, and a first reply that is cut short.
 *
 * @param sections - number of sections under the root `R`
 * @returns the answers of the shape command, with the first call cut to 50 shapes, and the shapes
 */
function wideSections(sections: number): { shapes: (params: object) => unknown; count: number } {
    const entries: PageEntry[] = [{ id: "R", parentId: PAGE_ROOT }];
    for (let index = 0; index < sections; index += 1) {
        entries.push({ id: `g${index}`, parentId: "R" });
        entries.push({ id: `l${index}`, parentId: `g${index}`, name: "x".repeat(8192) });
    }
    const page = partialPage(entries);
    return {
        count: entries.length,
        shapes: (params: object) => {
            const reply = page.shapes(params) as { shapes: unknown[]; truncated: boolean };
            const first = (params as { includeAncestors?: boolean }).includeAncestors === true;
            return first ? { ...reply, shapes: reply.shapes.slice(0, 50), truncated: true } : reply;
        },
    };
}

test("a partial load stops at the reply that passes the cap, and starts no further call", async () => {
    const wide = wideSections(1200);
    const backend = new FakePenpotBackend().respond("get-mcp-shapes", wide.shapes);
    const { host } = scopedHost(backend, ["R"], 2 * 1024 * 1024);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message:
            /^page .* shapes \(about [0-9.]+ MB\); the limit is 2 MB \(PENPOT_MCP_SANDBOX_PAGE_MB\)\. Pass fewer or smaller rootIds/,
    });

    // the round after the first would make 6 calls of 200 ids; a reply of 1.6 MB twice passes the cap
    assert.ok(backend.callsTo("get-mcp-shapes").length <= 4, `calls ${backend.callsTo("get-mcp-shapes").length}`);
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
});

test("a backend error in the middle of a round fails the load with that error and starts no further call", async () => {
    const wide = wideSections(1200);
    let seen = 0;
    const backend = new FakePenpotBackend().respond("get-mcp-shapes", (params: object) => {
        seen += 1;
        if (seen === 3) {
            throw new Error("backend broke on the third call");
        }
        return wide.shapes(params);
    });
    const { host } = scopedHost(backend, ["R"]);

    await assert.rejects(host.loadPage(FILE, PAGE), { message: "backend broke on the third call" });

    assert.ok(backend.callsTo("get-mcp-shapes").length <= 4, `calls ${backend.callsTo("get-mcp-shapes").length}`);
});

test("a partial load that fits makes the same calls as before", async () => {
    const wide = wideSections(1200);
    const backend = new FakePenpotBackend().respond("get-mcp-shapes", wide.shapes);
    const { host } = scopedHost(backend, ["R"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(loaded.shapes.length, wide.count + 1, "every shape and the page root");
    assert.equal(backend.callsTo("get-mcp-shapes").length, 7, "1 call for the roots and 6 of 200 ids");
});

test("a refresh drops a root that the backend no longer holds, and goes on", async () => {
    const entries = PARTIAL_ENTRIES.map((entry) => ({ ...entry }));
    const { host } = scopedHost(backendOf(partialPage(entries)), ["board", "other"]);
    await host.loadPage(FILE, PAGE);

    // the script removed the board: the backend no longer holds it, nor its children
    for (const id of ["board", "c1", "c2", "c2a"]) {
        entries.splice(
            entries.findIndex((entry) => entry.id === id),
            1
        );
    }
    const refreshed = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(refreshed), [PAGE_ROOT, "other", "o1"]);
});

test("a shape moved out of its roots stays loaded, and a shape the backend deleted is dropped", async () => {
    const entries = PARTIAL_ENTRIES.map((entry) => ({ ...entry }));
    const { host } = scopedHost(backendOf(partialPage(entries)), ["c2"]);
    await host.loadPage(FILE, PAGE);

    entries.find((entry) => entry.id === "c2a")!.parentId = PAGE_ROOT;
    const moved = JSON.parse(await host.loadPage(FILE, PAGE));
    assert.ok(idsOf(moved).includes("c2a"), "the moved shape was dropped");

    entries.splice(
        entries.findIndex((entry) => entry.id === "c2a"),
        1
    );
    const deleted = JSON.parse(await host.loadPage(FILE, PAGE));
    assert.equal(idsOf(deleted).includes("c2a"), false);
});

test("a shape that an import answers as its root is loaded again with the roots", async () => {
    const entries = PARTIAL_ENTRIES.map((entry) => ({ ...entry }));
    const backend = backendOf(partialPage(entries));
    const { host } = scopedHost(backend, ["board"]);
    await host.loadPage(FILE, PAGE);
    await host.importSvg(JSON.stringify({ fileId: FILE, pageId: PAGE, svg: "<svg/>" }));

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.ok(idsOf(loaded).includes("imp1"), "the imported shape is not in the model");
});

test("a whole-page load warns when a node at the depth limit has children that it does not carry", async () => {
    const entries: PageEntry[] = [{ id: "top", parentId: PAGE_ROOT }];
    let parent = "top";
    for (let level = 0; level < 24; level += 1) {
        entries.push({ id: `d${level}`, parentId: parent });
        parent = `d${level}`;
    }
    const host = harness(backendOf(partialPage(entries)));

    await host.loadPage(FILE, PAGE);

    assert.ok(
        (host.summary().warnings as Array<{ code?: string }>).some(
            (warning) => warning.code === "shapes-below-depth-limit"
        ),
        "the depth cut is not reported"
    );
});

test("an ancestor whose only loaded child is another ancestor is still partial", async () => {
    // S[T[R, U]] with root R: T is loaded whole as an ancestor of R, so no child of S is cut, yet S is not whole
    const entries: PageEntry[] = [
        { id: "S", parentId: PAGE_ROOT },
        { id: "T", parentId: "S" },
        { id: "R", parentId: "T" },
        { id: "U", parentId: "T" },
    ];
    const { host } = scopedHost(backendOf(partialPage(entries)), ["R"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));
    const byId = new Map<string, Record<string, unknown>>(
        loaded.shapes.map((shape: Record<string, unknown>) => [shape.id as string, shape])
    );

    assert.equal(byId.get("S")?.ancestorOnly, true);
    assert.equal(byId.get("S")?.partialChildren, true, "a stub must always be partial");
    assert.equal(byId.get("T")?.partialChildren, true);
    assert.equal(byId.get(PAGE_ROOT)?.partialChildren, true, "the page root is partial under rootIds");
});

/** A fake backend that holds each call for a few milliseconds and records the most calls that ran at once. */
class TrackingBackend extends FakePenpotBackend {
    /** Calls that have started and not finished. */
    public inFlight = 0;
    /** Most calls that ran at the same time. */
    public maxInFlight = 0;

    public override async callCommand<T = unknown>(userToken: string, name: string, params: object): Promise<T> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await super.callCommand<T>(userToken, name, params);
        } finally {
            this.inFlight -= 1;
        }
    }
}

/** Returns the parameters of the `get-mcp-shapes` calls of a backend. */
function shapeCallsOf(backend: FakePenpotBackend): Array<{ ids: string[]; includeChildren?: boolean }> {
    return backend.callsTo("get-mcp-shapes").map((call) => call.params as { ids: string[] });
}

test("a load of 20 roots with about 2,600 shapes makes 2 backend calls and no tree call", async () => {
    // the real backend returns at most 2000 shapes per reply, so 2 calls is the least that 2,600 shapes can take
    const entries: PageEntry[] = [];
    for (let board = 0; board < 20; board += 1) {
        entries.push({ id: `b${board}`, parentId: PAGE_ROOT });
        for (let child = 0; child < 129; child += 1) {
            entries.push({ id: `b${board}c${child}`, parentId: `b${board}` });
        }
    }
    const backend = backendOf(partialPage(entries, { shapeReplyLimit: 2000 }));
    const roots = Array.from({ length: 20 }, (_, index) => `b${index}`);
    const { host, tokens } = scopedHost(backend, roots);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 2);
    const expected = [PAGE_ROOT];
    for (let board = 0; board < 20; board += 1) {
        expected.push(`b${board}`, ...Array.from({ length: 129 }, (_, child) => `b${board}c${child}`));
    }
    assert.deepEqual(idsOf(loaded), expected);
    assert.equal(tokens(), 20, "a first partial load still takes one rate-limit token per root");
});

test("a reply cut short is followed by further rounds for the ids that are absent, and the model is whole", async () => {
    const backend = backendOf(partialPage(PARTIAL_ENTRIES, { shapeReplyLimit: 3 }));
    const { host } = scopedHost(backend, ["board", "other"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "board", "c1", "c2", "c2a", "other", "o1"]);
    assert.deepEqual(
        shapeCallsOf(backend).map((call) => call.ids),
        [["board", "other"], ["c2", "other"], ["o1"]]
    );
});

test("a round that returns nothing new fails the load with a clear error", async () => {
    const backend = new FakePenpotBackend().respond("get-mcp-shapes", {
        revn: PAGE_REVN,
        shapes: [{ id: "board", shapes: ["c1"], parentId: PAGE_ROOT }],
        missing: [],
        truncated: true,
    });
    const { host } = scopedHost(backend, ["board"]);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message: "get-mcp-shapes answered none of the shapes asked for, so the load cannot finish",
    });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 2);
});

test("a root that the backend reports missing fails a first load after one call, and a refresh drops it", async () => {
    const entries = PARTIAL_ENTRIES.map((entry) => ({ ...entry }));
    const backend = backendOf(partialPage(entries));
    const first = scopedHost(backend, ["nope"]);
    await assert.rejects(first.host.loadPage(FILE, PAGE), { message: /root shape nope is not a shape of page/ });
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);

    const other = backendOf(partialPage(entries));
    const { host } = scopedHost(other, ["board", "other"]);
    await host.loadPage(FILE, PAGE);
    for (const id of ["board", "c1", "c2", "c2a"]) {
        entries.splice(
            entries.findIndex((entry) => entry.id === id),
            1
        );
    }
    const before = other.callsTo("get-mcp-shapes").length;
    const refreshed = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(refreshed), [PAGE_ROOT, "other", "o1"]);
    // the roots call, then one call for the shapes the last load held and the backend no longer has
    assert.equal(other.callsTo("get-mcp-shapes").length - before, 2);
});

test("the loaded order is the tree order: a flex or grid board lists its children in the reverse of its stored order", async () => {
    // B is a flex board that stores [a, g, b]; g is a flex board that stores [g1, g2]; P is plain
    const entries: PageEntry[] = [
        { id: "B", parentId: PAGE_ROOT, layout: "flex" },
        { id: "a", parentId: "B" },
        { id: "g", parentId: "B", layout: "flex" },
        { id: "g1", parentId: "g" },
        { id: "g2", parentId: "g" },
        { id: "b", parentId: "B" },
        { id: "P", parentId: PAGE_ROOT },
        { id: "p1", parentId: "P" },
        { id: "p2", parentId: "P" },
        { id: "G", parentId: PAGE_ROOT, layout: "grid" },
        { id: "k1", parentId: "G" },
        { id: "k2", parentId: "G" },
    ];
    const expected = [PAGE_ROOT, "P", "p1", "p2", "B", "b", "g", "g2", "g1", "a", "G", "k2", "k1"];
    const { host } = scopedHost(backendOf(partialPage(entries)), ["P", "B", "G"]);

    const partial = idsOf(JSON.parse(await host.loadPage(FILE, PAGE)));

    assert.deepEqual(partial, expected);
    // the whole-page load reads the tree itself: the partial order is the whole-page order restricted to the roots
    const whole = idsOf(JSON.parse(await harness(backendOf(partialPage(entries))).loadPage(FILE, PAGE)));
    assert.deepEqual(whole, [PAGE_ROOT, "B", "b", "g", "g2", "g1", "a", "P", "p1", "p2", "G", "k2", "k1"]);
    assert.deepEqual(
        partial.filter((id) => id !== PAGE_ROOT),
        [...["P", "p1", "p2"], ...whole.slice(1, 7), ...whole.slice(10)]
    );
});

test("the ancestors of a root come in one call, nearest first, and a first load takes no other call", async () => {
    const entries: PageEntry[] = [
        { id: "A1", parentId: PAGE_ROOT },
        { id: "A2", parentId: "A1" },
        { id: "A3", parentId: "A2" },
        { id: "R", parentId: "A3" },
        { id: "r1", parentId: "R" },
    ];
    const backend = backendOf(partialPage(entries));
    const { host } = scopedHost(backend, ["R"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "A3", "A2", "A1", "R", "r1"]);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
    assert.deepEqual(
        loaded.shapes
            .filter((shape: Record<string, unknown>) => shape.ancestorOnly === true)
            .map((s: { id: string }) => s.id),
        ["A3", "A2", "A1"]
    );
});

test("a refresh without a change takes one call, which brings the ancestors back", async () => {
    const entries: PageEntry[] = [
        { id: "A1", parentId: PAGE_ROOT },
        { id: "R", parentId: "A1" },
        { id: "r1", parentId: "R" },
    ];
    const backend = backendOf(partialPage(entries));
    const { host } = scopedHost(backend, ["R"]);
    const first = JSON.parse(await host.loadPage(FILE, PAGE));
    const before = backend.callsTo("get-mcp-shapes").length;

    const again = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(backend.callsTo("get-mcp-shapes").length - before, 1);
    assert.deepEqual(again, first);
});

test("at most 2 shape calls of a partial load run at the same time", async () => {
    // 1,000 leaves under one board, and a reply cap of 100 shapes: the board's absent children need many calls
    const entries: PageEntry[] = [{ id: "wide", parentId: PAGE_ROOT }];
    for (let index = 0; index < 1000; index += 1) {
        entries.push({ id: `w${index}`, parentId: "wide" });
    }
    const page = partialPage(entries, { shapeReplyLimit: 100 });
    const backend = new TrackingBackend().respond("get-mcp-shapes", page.shapes);
    const { host } = scopedHost(backend, ["wide"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(loaded.shapes.length, 1002);
    assert.equal(backend.maxInFlight, 2);
    assert.equal(backend.inFlight, 0);
});

test("a board of 130 groups of 129 leaves loads in at most 12 calls", async () => {
    // 16,900 shapes; the backend lists the 130 groups before the leaves of the first group, so a cut at 2000 shapes
    // leaves the leaves of most groups absent. Asking for each group once brings its leaves, instead of one id each.
    const entries: PageEntry[] = [{ id: "B", parentId: PAGE_ROOT }];
    for (let group = 0; group < 130; group += 1) {
        entries.push({ id: `g${group}`, parentId: "B" });
        for (let leaf = 0; leaf < 129; leaf += 1) {
            entries.push({ id: `g${group}l${leaf}`, parentId: `g${group}` });
        }
    }
    const backend = backendOf(partialPage(entries, { shapeReplyLimit: 2000 }));
    const { host } = scopedHost(backend, ["B"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    const calls = shapeCallsOf(backend);
    const asked = calls.reduce((total, call) => total + call.ids.length, 0);
    assert.equal(loaded.shapes.length, entries.length + 1, "every shape and the page root");
    assert.ok(calls.length <= 12, `calls ${calls.length}, ids asked ${asked}`);
    assert.ok(asked <= 1500, `ids asked ${asked}`);
    assert.ok(
        calls.every((call) => call.ids.length <= 200),
        "at most 200 ids per call"
    );
});

test("a load of a board that is not cut asks for nothing more", async () => {
    // a cut inside the children of one shape: the absent children are asked by id, as before
    const entries: PageEntry[] = [{ id: "wide", parentId: PAGE_ROOT }];
    for (let index = 0; index < 500; index += 1) {
        entries.push({ id: `w${index}`, parentId: "wide" });
    }
    const backend = backendOf(partialPage(entries, { shapeReplyLimit: 100 }));
    const { host } = scopedHost(backend, ["wide"]);

    const loaded = JSON.parse(await host.loadPage(FILE, PAGE));

    assert.equal(loaded.shapes.length, 502);
    const later = shapeCallsOf(backend).slice(1);
    assert.ok(
        later.every((call) => call.ids.every((id) => id.startsWith("w"))),
        "the absent children are asked by id, not the board again"
    );
});

test("a first-window estimate far above the cap refuses a whole-page load after one backend call", async () => {
    const entries: PageEntry[] = [{ id: "s", parentId: PAGE_ROOT }];
    const page = partialPage(entries, { estimate: { totalShapes: 28709, estimatedBytes: 21 * 1024 * 1024 } });
    const backend = backendOf(page);

    await assert.rejects(harness(backend).loadPage(FILE, PAGE), {
        message:
            /^page .* has 28709 shapes \(estimated at about 21\.0 MB\); the limit is 16 MB \(PENPOT_MCP_SANDBOX_PAGE_MB\)\. Pass rootIds to load only the boards the script needs, or use export_subtree, get_shapes and find_shapes for reads\.$/,
    });

    assert.equal(backend.calls.length, 1);
    assert.deepEqual(backend.callsTo("get-mcp-page-tree")[0]?.params, {
        fileId: FILE,
        pageId: PAGE,
        depth: 20,
        limit: 5000,
        estimateSize: true,
    });
});

test("an estimate under the margin does not refuse, and the load goes on as before", async () => {
    // 19 MB is above the 16 MB cap but under the 1.3 margin (20.8 MB): the precise guard decides
    const entries: PageEntry[] = [{ id: "s", parentId: PAGE_ROOT }];
    const page = partialPage(entries, { estimate: { totalShapes: 2, estimatedBytes: 19 * 1024 * 1024 } });
    const backend = backendOf(page);

    const loaded = JSON.parse(await harness(backend).loadPage(FILE, PAGE));

    assert.deepEqual(idsOf(loaded), [PAGE_ROOT, "s"]);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1);
});

test("an estimate that is too low is caught later by the check on the shapes fetched", async () => {
    const entries: PageEntry[] = [];
    for (let index = 0; index < 300; index += 1) {
        entries.push({ id: `k${index}`, parentId: PAGE_ROOT, name: "x".repeat(4096) });
    }
    const page = partialPage(entries, { estimate: { totalShapes: 301, estimatedBytes: 100 * 1024 } });
    const backend = backendOf(page);
    const services = new BackendServices(backend, new BackendSettings(10, 1000), new FakeExporterClient());
    const host = new SandboxHost(services, TOKEN, undefined, 512 * 1024);

    await assert.rejects(host.loadPage(FILE, PAGE), {
        message: /^page .* has 301 shapes \(about [0-9.]+ MB\); the limit is 0\.5 MB \(PENPOT_MCP_SANDBOX_PAGE_MB\)\./,
    });

    assert.equal(backend.callsTo("get-mcp-page-tree").length, 1);
    assert.equal(backend.callsTo("get-mcp-shapes").length, 1, "refused after the first batch of shapes");
});
