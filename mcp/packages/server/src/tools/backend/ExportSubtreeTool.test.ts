import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendRpcError } from "../../backend/BackendRpcError";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend, type RecordedCall } from "../../backend/testing/FakePenpotBackend";
import { ExportSubtreeArgs, ExportSubtreeTool } from "./ExportSubtreeTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const ROOT = "1b2c3d4e-0000-4000-8000-000000000100";
const COMMAND = "get-mcp-subtree";
const EXPORT_DIR_VARIABLE = "PENPOT_MCP_EXPORT_DIR";
const CAP_VARIABLE = "PENPOT_MCP_MAX_TOOL_RESPONSE_KB";

/** Window byte limit that the tool asks for under the default response cap: 80 % of 100 kB. */
const DEFAULT_WINDOW_BYTES = 80_000;

/** Shape id of the n-th shape of the test walk. */
function idOf(n: number): string {
    return `1b2c3d4e-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * A stored shape of the test walk, in the backend's form.
 *
 * @param n - position of the shape, which also names it
 * @param type - the backend type, circle for an ellipse
 */
function shapeOf(n: number, type = "rect") {
    return { id: idOf(n), type, name: `Shape ${n}`, parentId: ROOT, frameId: ROOT, shapes: [] };
}

/** First window of the three-window walk: shapes 0 to 2, the first a circle. */
const WINDOW_1 = {
    revn: 7,
    pageId: PAGE,
    rootId: ROOT,
    total: 7,
    shapes: [shapeOf(0, "circle"), shapeOf(1), shapeOf(2)],
    truncated: true,
    nextCursor: "cursor-2",
};

/** Second window: shapes 3 and 4. */
const WINDOW_2 = {
    revn: 7,
    pageId: PAGE,
    rootId: ROOT,
    total: 7,
    shapes: [shapeOf(3), shapeOf(4)],
    truncated: true,
    nextCursor: "cursor-3",
};

/** Last window: shapes 5 and 6, with no cursor. */
const WINDOW_3 = {
    revn: 7,
    pageId: PAGE,
    rootId: ROOT,
    total: 7,
    shapes: [shapeOf(5), shapeOf(6)],
    truncated: false,
};

/**
 * Builds the tool on a fake backend.
 *
 * @param fsEnabled - whether the server offers file system access
 */
function harness(fsEnabled = true) {
    const backend = new FakePenpotBackend().respond("mcp-whoami", {
        contractVersion: 1,
        profileId: "profile-1",
        scopes: ["mcp:read"],
    });
    const services = new BackendServices(backend, new BackendSettings(), new FakeExporterClient());
    const server = {
        getSessionContext: () => ({ userToken: TOKEN }),
        isFileSystemAccessEnabled: () => fsEnabled,
    } as unknown as PenpotMcpServer;
    const tool = new ExportSubtreeTool(server, services);
    return { backend, tool };
}

/**
 * Returns the text of the first content item of a tool response.
 *
 * @param response - the tool response
 */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/**
 * Returns the parameters of every call of one command, in order.
 *
 * @param calls - the recorded calls
 */
function paramsOf(calls: RecordedCall[]): unknown[] {
    return calls.filter((call) => call.name === COMMAND).map((call) => call.params);
}

/**
 * Builds the error of a stale cursor, as the backend sends it.
 */
function staleError(): BackendRpcError {
    return new BackendRpcError(409, COMMAND, { code: "mcp-stale-cursor" });
}

/**
 * Makes the backend answer the three-window walk.
 *
 * @param backend - the fake backend to answer on
 * @param staleSecondWindow - how many times the second window answers stale before it answers normally
 * @param failSecondWindow - when set, the second window fails with this error instead
 */
function answerWalk(backend: FakePenpotBackend, staleSecondWindow = 0, failSecondWindow?: Error): void {
    let stale = 0;
    backend.respond(COMMAND, (params: object) => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor === undefined) {
            return WINDOW_1;
        }
        if (cursor === "cursor-2") {
            if (failSecondWindow !== undefined) {
                throw failSecondWindow;
            }
            if (stale < staleSecondWindow) {
                stale += 1;
                throw staleError();
            }
            return WINDOW_2;
        }
        return WINDOW_3;
    });
}

/**
 * Runs a test inside a fresh export directory, with PENPOT_MCP_EXPORT_DIR set to it. The directory is removed after.
 *
 * @param body - the test body, which receives the directory
 */
async function withExportDir(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-subtree-"));
    const previous = process.env[EXPORT_DIR_VARIABLE];
    process.env[EXPORT_DIR_VARIABLE] = dir;
    try {
        await body(dir);
    } finally {
        if (previous === undefined) {
            delete process.env[EXPORT_DIR_VARIABLE];
        } else {
            process.env[EXPORT_DIR_VARIABLE] = previous;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("the export_subtree schema accepts the bounds and refuses values outside them", () => {
    const schema = z.object(ExportSubtreeArgs.schema);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 1 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 5000 }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 0 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 5001 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, limit: 2.5 }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, cursor: "c".repeat(4096) }).success, true);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, cursor: "c".repeat(4097) }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, rootId: "not-a-uuid" }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, filePath: "" }).success, false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE, overwrite: "yes" }).success, false);
});

test("an inline call sends only the given fields, with the window byte limit of 80 % of the cap", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(paramsOf(backend.calls), [{ fileId: FILE, pageId: PAGE, limit: 100, maxBytes: 80_000 }]);
});

test("an inline call with every argument sends them all", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    await tool.execute({ fileId: FILE, pageId: PAGE, rootId: ROOT, cursor: "cursor-2", limit: 50 });
    assert.deepEqual(paramsOf(backend.calls), [
        { fileId: FILE, pageId: PAGE, rootId: ROOT, cursor: "cursor-2", limit: 50, maxBytes: DEFAULT_WINDOW_BYTES },
    ]);
});

test("the inline window limit follows PENPOT_MCP_MAX_TOOL_RESPONSE_KB and stays inside the backend range", async () => {
    const previous = process.env[CAP_VARIABLE];
    try {
        process.env[CAP_VARIABLE] = "50";
        const small = harness();
        answerWalk(small.backend);
        await small.tool.execute({ fileId: FILE, pageId: PAGE });
        assert.equal((paramsOf(small.backend.calls)[0] as { maxBytes: number }).maxBytes, 40_000);

        process.env[CAP_VARIABLE] = "1";
        const tiny = harness();
        answerWalk(tiny.backend);
        await tiny.tool.execute({ fileId: FILE, pageId: PAGE });
        assert.equal((paramsOf(tiny.backend.calls)[0] as { maxBytes: number }).maxBytes, 1000);
    } finally {
        if (previous === undefined) {
            delete process.env[CAP_VARIABLE];
        } else {
            process.env[CAP_VARIABLE] = previous;
        }
    }
});

test("an inline reply passes the window through and maps circle to ellipse", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse(textOf(response)) as {
        revn: number;
        pageId: string;
        rootId: string;
        total: number;
        truncated: boolean;
        nextCursor: string;
        shapes: Array<{ id: string; type: string }>;
    };
    assert.equal(body.revn, 7);
    assert.equal(body.pageId, PAGE);
    assert.equal(body.rootId, ROOT);
    assert.equal(body.total, 7);
    assert.equal(body.truncated, true);
    assert.equal(body.nextCursor, "cursor-2");
    assert.deepEqual(
        body.shapes.map((shape) => [shape.id, shape.type]),
        [
            [idOf(0), "ellipse"],
            [idOf(1), "rect"],
            [idOf(2), "rect"],
        ]
    );
});

test("filePath writes one JSON document from three windows, with every shape once in order", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        const file = path.join(dir, "subtree.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.notEqual(response.isError, true, textOf(response));

        const reply = JSON.parse(textOf(response)) as { path: string; shapes: number; bytes: number };
        assert.equal(reply.path, file);
        assert.equal(reply.shapes, 7);
        assert.equal(reply.bytes, fs.statSync(file).size);

        const document = JSON.parse(fs.readFileSync(file, "utf8")) as {
            fileId: string;
            pageId: string;
            rootId: string;
            revn: number;
            total: number;
            shapes: Array<{ id: string; type: string }>;
        };
        assert.equal(document.fileId, FILE);
        assert.equal(document.pageId, PAGE);
        assert.equal(document.rootId, ROOT);
        assert.equal(document.revn, 7);
        assert.equal(document.total, 7);
        assert.deepEqual(
            document.shapes.map((shape) => shape.id),
            [0, 1, 2, 3, 4, 5, 6].map(idOf)
        );
        assert.equal(document.shapes[0].type, "ellipse");
        assert.equal(document.shapes[1].type, "rect");

        assert.equal(reply.bytes > 0, true);
        assert.deepEqual(fs.readdirSync(dir), ["subtree.json"]);
    });
});

test("filePath walks the cursor from the start, with the large file window", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "walk.json") });
        assert.deepEqual(paramsOf(backend.calls), [
            { fileId: FILE, pageId: PAGE, limit: 5000, maxBytes: 1_000_000 },
            { fileId: FILE, pageId: PAGE, limit: 5000, maxBytes: 1_000_000, cursor: "cursor-2" },
            { fileId: FILE, pageId: PAGE, limit: 5000, maxBytes: 1_000_000, cursor: "cursor-3" },
        ]);
    });
});

test("filePath ignores the caller's limit: every window is the large file window", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        await tool.execute({ fileId: FILE, pageId: PAGE, limit: 50, filePath: path.join(dir, "limited.json") });
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { limit: number; maxBytes: number }).limit),
            [5000, 5000, 5000]
        );
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { maxBytes: number }).maxBytes),
            [1_000_000, 1_000_000, 1_000_000]
        );
    });
});

test("filePath over an empty page writes a document with no shapes", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, { revn: 3, pageId: PAGE, rootId: PAGE, total: 0, shapes: [], truncated: false });
        const file = path.join(dir, "empty.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.notEqual(response.isError, true, textOf(response));
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as { shapes: unknown[]; total: number };
        assert.deepEqual(document.shapes, []);
        assert.equal(document.total, 0);
    });
});

test("a stale cursor in the second window restarts the walk once and still writes a correct file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend, 1);
        const file = path.join(dir, "restarted.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.notEqual(response.isError, true, textOf(response));
        const reply = JSON.parse(textOf(response)) as { shapes: number; windows: number; revn: number };
        assert.equal(reply.shapes, 7);
        assert.equal(reply.windows, 3);
        assert.equal(reply.revn, 7);
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as { shapes: Array<{ id: string }> };
        assert.deepEqual(
            document.shapes.map((shape) => shape.id),
            [0, 1, 2, 3, 4, 5, 6].map(idOf)
        );
        assert.equal(paramsOf(backend.calls).length, 5);
        assert.deepEqual(fs.readdirSync(dir), ["restarted.json"]);
    });
});

test("a second stale cursor fails, says the page keeps changing, and leaves no file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend, 2);
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "never.json") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /keeps changing/);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a backend error in a later window fails and leaves no file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend, 0, new BackendRpcError(500, COMMAND, { code: "internal-error" }));
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "broken.json") });
        assert.equal(response.isError, true);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("an abort before the walk starts writes nothing and calls no window", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        const controller = new AbortController();
        controller.abort();
        const response = await tool.execute(
            { fileId: FILE, pageId: PAGE, filePath: path.join(dir, "aborted.json") },
            controller.signal
        );
        assert.equal(response.isError, true);
        assert.deepEqual(paramsOf(backend.calls), []);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a path outside the export directory is refused before any window is read", async () => {
    await withExportDir(async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "export-subtree-outside-"));
        try {
            const { backend, tool } = harness();
            answerWalk(backend);
            const response = await tool.execute({
                fileId: FILE,
                pageId: PAGE,
                filePath: path.join(outside, "escape.json"),
            });
            assert.equal(response.isError, true);
            assert.match(textOf(response), /must be inside the export directory/);
            assert.deepEqual(paramsOf(backend.calls), []);
            assert.equal(fs.existsSync(path.join(outside, "escape.json")), false);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test("a path that does not end in .json is refused", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "out.txt") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /must end in \.json/);
        assert.deepEqual(paramsOf(backend.calls), []);
    });
});

test("an existing file is refused without overwrite, and replaced with overwrite", async () => {
    await withExportDir(async (dir) => {
        const file = path.join(dir, "kept.json");
        fs.writeFileSync(file, "previous");
        const { backend, tool } = harness();
        answerWalk(backend);

        const refused = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /already exists/);
        assert.equal(fs.readFileSync(file, "utf8"), "previous");
        assert.deepEqual(paramsOf(backend.calls), []);

        const replaced = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file, overwrite: true });
        assert.notEqual(replaced.isError, true, textOf(replaced));
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as { shapes: unknown[] };
        assert.equal(document.shapes.length, 7);
        assert.deepEqual(fs.readdirSync(dir), ["kept.json"]);
    });
});

test("filePath is refused when file system access is off", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness(false);
        answerWalk(backend);
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "off.json") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /File paths are off/);
        assert.deepEqual(paramsOf(backend.calls), []);
    });
});

test("a cursor is refused together with filePath", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        const response = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            cursor: "cursor-2",
            filePath: path.join(dir, "cursor.json"),
        });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /cursor cannot be used with filePath/);
        assert.deepEqual(paramsOf(backend.calls), []);
    });
});

/**
 * Runs a test with PENPOT_MCP_MAX_TOOL_RESPONSE_KB set to the given value, restoring the previous value afterwards.
 *
 * @param kilobytes - the response cap to set, as the environment text
 * @param body - the test body
 */
async function withCap(kilobytes: string, body: () => Promise<void>): Promise<void> {
    const previous = process.env[CAP_VARIABLE];
    process.env[CAP_VARIABLE] = kilobytes;
    try {
        await body();
    } finally {
        if (previous === undefined) {
            delete process.env[CAP_VARIABLE];
        } else {
            process.env[CAP_VARIABLE] = previous;
        }
    }
}

/**
 * A shape with a 3000-character content, which is larger than a 2 kB response cap by itself.
 *
 * @param n - position of the shape, which also names it
 */
function bigShapeOf(n: number) {
    return { ...shapeOf(n, "path"), content: "x".repeat(3000) };
}

test("an inline window too large for the cap is cut to the shapes that fit, and keeps nextCursor", async () => {
    await withCap("2", async () => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, (params: object) => {
            if ((params as { limit: number }).limit === 2) {
                return {
                    revn: 7,
                    pageId: PAGE,
                    rootId: ROOT,
                    total: 7,
                    shapes: [shapeOf(0), shapeOf(1)],
                    truncated: true,
                    nextCursor: "cursor-2",
                };
            }
            return {
                revn: 7,
                pageId: PAGE,
                rootId: ROOT,
                total: 7,
                shapes: [shapeOf(0), shapeOf(1), bigShapeOf(2)],
                truncated: true,
                nextCursor: "cursor-3",
            };
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE });
        assert.notEqual(response.isError, true, textOf(response));
        const body = JSON.parse(textOf(response)) as { shapes: Array<{ id: string }>; nextCursor: string };
        assert.deepEqual(
            body.shapes.map((shape) => shape.id),
            [idOf(0), idOf(1)]
        );
        assert.equal(body.nextCursor, "cursor-2");
        assert.deepEqual(paramsOf(backend.calls), [
            { fileId: FILE, pageId: PAGE, limit: 100, maxBytes: 1600 },
            { fileId: FILE, pageId: PAGE, limit: 2, maxBytes: 1600 },
        ]);
    });
});

test("a single shape too large for the cap comes back with its large attributes omitted", async () => {
    await withCap("2", async () => {
        const { backend, tool } = harness();
        const big = { ...bigShapeOf(0), points: [1, 2] };
        backend.respond(COMMAND, {
            revn: 7,
            pageId: PAGE,
            rootId: ROOT,
            total: 7,
            shapes: [big],
            truncated: true,
            nextCursor: "cursor-1",
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE });
        assert.notEqual(response.isError, true, textOf(response));
        const body = JSON.parse(textOf(response)) as {
            shapes: Array<{ id: string; content: unknown; points: unknown }>;
            oversize: Array<{ id: string; bytes: number; omitted: string[] }>;
            note: string;
            nextCursor: string;
        };
        assert.deepEqual(body.shapes[0].content, { omitted: true, bytes: 3002 });
        assert.deepEqual(body.shapes[0].points, [1, 2]);
        assert.deepEqual(body.oversize, [
            { id: idOf(0), bytes: Buffer.byteLength(JSON.stringify(big)), omitted: ["content"] },
        ]);
        assert.match(body.note, /filePath/);
        assert.match(body.note, /get_shapes/);
        assert.equal(body.nextCursor, "cursor-1");
        assert.equal(paramsOf(backend.calls).length, 1);
    });
});

test("when shapes are too large together, the first one comes back alone from a window of one", async () => {
    await withCap("2", async () => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, (params: object) => {
            if ((params as { limit: number }).limit === 1) {
                return {
                    revn: 7,
                    pageId: PAGE,
                    rootId: ROOT,
                    total: 7,
                    shapes: [bigShapeOf(0)],
                    truncated: true,
                    nextCursor: "cursor-1",
                };
            }
            return {
                revn: 7,
                pageId: PAGE,
                rootId: ROOT,
                total: 7,
                shapes: [bigShapeOf(0), bigShapeOf(1)],
                truncated: true,
                nextCursor: "cursor-2",
            };
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE });
        assert.notEqual(response.isError, true, textOf(response));
        const body = JSON.parse(textOf(response)) as { shapes: Array<{ id: string }>; nextCursor: string };
        assert.deepEqual(
            body.shapes.map((shape) => shape.id),
            [idOf(0)]
        );
        assert.equal(body.nextCursor, "cursor-1");
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { limit: number }).limit),
            [100, 1]
        );
    });
});

test("trimming stops as soon as the reply fits, so a small large attribute is kept", async () => {
    await withCap("2", async () => {
        const { backend, tool } = harness();
        const shape = { ...shapeOf(0, "path"), content: "x".repeat(1500), positionData: "p".repeat(600) };
        backend.respond(COMMAND, {
            revn: 7,
            pageId: PAGE,
            rootId: ROOT,
            total: 7,
            shapes: [shape],
            truncated: true,
            nextCursor: "cursor-1",
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE });
        const body = JSON.parse(textOf(response)) as {
            shapes: Array<{ positionData: unknown }>;
            oversize: Array<{ omitted: string[] }>;
        };
        assert.equal(body.shapes[0].positionData, "p".repeat(600));
        assert.deepEqual(body.oversize[0].omitted, ["content"]);
    });
});

test("a file name with a colon after the drive letter, or a character Windows refuses, is refused", async () => {
    await withExportDir(async (dir) => {
        for (const name of [
            "host.txt:stream.json",
            "bad<name>.json",
            "bad|name.json",
            "q?.json",
            "a*.json",
            'b".json',
        ]) {
            const { backend, tool } = harness();
            answerWalk(backend);
            const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, name) });
            assert.equal(response.isError, true, name);
            assert.match(textOf(response), /may not contain/, name);
            assert.deepEqual(paramsOf(backend.calls), [], name);
        }
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a long but valid file name still writes the file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        const name = `${"n".repeat(150)}.json`;
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, name) });
        assert.notEqual(response.isError, true, textOf(response));
        assert.deepEqual(fs.readdirSync(dir), [name]);
    });
});

test("a walk with a different shape count than its first window counted fails, and leaves no file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        backend.respond(COMMAND, (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return { ...WINDOW_1, total: 6 };
            }
            return cursor === "cursor-2" ? WINDOW_2 : WINDOW_3;
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "count.json") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /changed during the walk/);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("progress never goes backwards: a restarted walk reports only counts above the highest reported", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend, 1);
        const seen: number[] = [];
        const response = await tool.execute(
            { fileId: FILE, pageId: PAGE, filePath: path.join(dir, "progress.json") },
            undefined,
            async (progress: number) => {
                seen.push(progress);
            }
        );
        assert.notEqual(response.isError, true, textOf(response));
        assert.deepEqual(seen, [3, 5, 7]);
    });
});

test("a failed export removes the parent folders it created", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend, 0, new BackendRpcError(500, COMMAND, { code: "internal-error" }));
        const response = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            filePath: path.join(dir, "made", "deeper", "out.json"),
        });
        assert.equal(response.isError, true);
        assert.equal(fs.existsSync(path.join(dir, "made")), false);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a failed export keeps a parent folder that already existed", async () => {
    await withExportDir(async (dir) => {
        fs.mkdirSync(path.join(dir, "keep"));
        const { backend, tool } = harness();
        answerWalk(backend, 0, new BackendRpcError(500, COMMAND, { code: "internal-error" }));
        const response = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            filePath: path.join(dir, "keep", "out.json"),
        });
        assert.equal(response.isError, true);
        assert.equal(fs.existsSync(path.join(dir, "keep")), true);
        assert.deepEqual(fs.readdirSync(path.join(dir, "keep")), []);
    });
});

test("an abort in the middle of the walk leaves no file and reads no further window", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        const controller = new AbortController();
        backend.respond(COMMAND, (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return WINDOW_1;
            }
            if (cursor === "cursor-2") {
                controller.abort();
                return WINDOW_2;
            }
            return WINDOW_3;
        });
        const response = await tool.execute(
            { fileId: FILE, pageId: PAGE, filePath: path.join(dir, "midway.json") },
            controller.signal
        );
        assert.equal(response.isError, true);
        assert.equal(paramsOf(backend.calls).length, 2);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a repeated cursor fails the walk and leaves no file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return WINDOW_1;
            }
            return { ...WINDOW_2, nextCursor: "cursor-2" };
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "loop.json") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /repeated a cursor/);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a window cut without a cursor fails the walk and leaves no file", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, { ...WINDOW_1, nextCursor: undefined });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "cut.json") });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /without a cursor/);
        assert.deepEqual(fs.readdirSync(dir), []);
    });
});

test("a failing final rename removes the temporary file and keeps the target", async () => {
    await withExportDir(async (dir) => {
        const target = path.join(dir, "out.json");
        fs.mkdirSync(target);
        const { backend, tool } = harness();
        answerWalk(backend);
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: target, overwrite: true });
        assert.equal(response.isError, true);
        assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
        assert.equal(fs.statSync(target).isDirectory(), true);
        assert.deepEqual(fs.readdirSync(target), []);
    });
});

test("a target that appears during the walk is kept, and the export is refused", async () => {
    await withExportDir(async (dir) => {
        const target = path.join(dir, "late.json");
        const { backend, tool } = harness();
        backend.respond(COMMAND, (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return WINDOW_1;
            }
            if (cursor === "cursor-2") {
                fs.writeFileSync(target, "mine");
                return WINDOW_2;
            }
            return WINDOW_3;
        });
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: target });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /already exists/);
        assert.equal(fs.readFileSync(target, "utf8"), "mine");
        assert.deepEqual(fs.readdirSync(dir), ["late.json"]);
    });
});

test("an empty window in the middle of a walk still yields valid JSON with every shape once", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        backend.respond(COMMAND, (params: object) => {
            const cursor = (params as { cursor?: string }).cursor;
            if (cursor === undefined) {
                return WINDOW_1;
            }
            if (cursor === "cursor-2") {
                return {
                    revn: 7,
                    pageId: PAGE,
                    rootId: ROOT,
                    total: 7,
                    shapes: [],
                    truncated: true,
                    nextCursor: "cursor-3",
                };
            }
            return { ...WINDOW_3, shapes: [shapeOf(3), shapeOf(4), shapeOf(5), shapeOf(6)] };
        });
        const file = path.join(dir, "gap.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.notEqual(response.isError, true, textOf(response));
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as { shapes: Array<{ id: string }> };
        assert.deepEqual(
            document.shapes.map((shape) => shape.id),
            [0, 1, 2, 3, 4, 5, 6].map(idOf)
        );
    });
});

test("export_subtree reads and writes as a tool that may write a file, and destroys nothing", () => {
    const { tool } = harness();
    assert.deepEqual(tool.annotations(), { readOnlyHint: false, destructiveHint: false });
});

test("export_subtree describes what the content of a path and of a text is", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /A path's or boolean's content is an SVG path string in page space/);
    assert.match(description, /a text's content is its tree of paragraphs/);
});
