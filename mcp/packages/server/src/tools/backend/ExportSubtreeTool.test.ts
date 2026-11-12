import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendRateLimitError, BackendRpcError } from "../../backend/BackendRpcError";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend, type RecordedCall } from "../../backend/testing/FakePenpotBackend";
import { BackendTool } from "./BackendTool";
import { ExportSubtreeArgs, ExportSubtreeTool } from "./ExportSubtreeTool";

const TOKEN = "alice-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000003";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000004";
const ROOT = "1b2c3d4e-0000-4000-8000-000000000100";
const COMMAND = "get-mcp-subtree";
const EXPORT_DIR_VARIABLE = "PENPOT_MCP_EXPORT_DIR";
const SUBTREE_CAP_VARIABLE = "PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB";

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
    // a walk of many calls must not meet the rate limit, which is not what these tests are about
    const settings = new BackendSettings(undefined, 1_000_000, 1_000_000);
    const services = new BackendServices(backend, settings, new FakeExporterClient());
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

/** Largest byte budget that the first window of an inline call asks for under the default 100 kB cap. */
const FIRST_WINDOW_BYTES = Math.floor((100_000 - 1024) * 0.98);

test("an inline call sends only the given fields, and asks the first window for the room of the reply", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.deepEqual(paramsOf(backend.calls)[0], {
        fileId: FILE,
        pageId: PAGE,
        limit: 5000,
        maxJsonBytes: FIRST_WINDOW_BYTES,
    });
});

test("an inline call with every argument sends them all", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        rootId: ROOT,
        cursor: "cursor-2",
        limit: 50,
        compact: true,
    });
    assert.deepEqual(paramsOf(backend.calls)[0], {
        fileId: FILE,
        pageId: PAGE,
        rootId: ROOT,
        cursor: "cursor-2",
        compact: true,
        limit: 50,
        maxJsonBytes: FIRST_WINDOW_BYTES,
    });
});

test("an inline reply joins the windows that fit, maps circle to ellipse and ends without a cursor", async () => {
    const { backend, tool } = harness();
    answerWalk(backend);
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse(textOf(response)) as {
        revn: number;
        pageId: string;
        rootId: string;
        total: number;
        windows: number;
        truncated: boolean;
        nextCursor?: string;
        shapes: Array<{ id: string; type: string }>;
    };
    assert.equal(body.revn, 7);
    assert.equal(body.pageId, PAGE);
    assert.equal(body.rootId, ROOT);
    assert.equal(body.total, 7);
    assert.equal(body.windows, 3);
    assert.equal(body.truncated, false);
    assert.equal(body.nextCursor, undefined);
    assert.deepEqual(
        body.shapes.map((shape) => [shape.id, shape.type]),
        [0, 1, 2, 3, 4, 5, 6].map((n) => [idOf(n), n === 0 ? "ellipse" : "rect"])
    );
    assert.deepEqual(
        paramsOf(backend.calls).map((params) => (params as { cursor?: string }).cursor),
        [undefined, "cursor-2", "cursor-3"]
    );
});

test("limit caps the shapes of a reply and the window limit shrinks as shapes are read", async () => {
    const { backend, tool } = harness();
    servePage(
        backend,
        Array.from({ length: 10 }, (_, n) => sizedShape(n, 300)),
        { perWindow: 3 }
    );
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, limit: 4 });
    const body = JSON.parse(textOf(response)) as { shapes: unknown[]; nextCursor: string; windows: number };
    assert.equal(body.shapes.length, 4);
    assert.equal(body.windows, 2);
    assert.equal(body.nextCursor, "c4");
    assert.deepEqual(
        paramsOf(backend.calls).map((params) => (params as { limit: number }).limit),
        [4, 1]
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
            { fileId: FILE, pageId: PAGE, limit: 5000, maxJsonBytes: 4_000_000 },
            { fileId: FILE, pageId: PAGE, limit: 5000, maxJsonBytes: 4_000_000, cursor: "cursor-2" },
            { fileId: FILE, pageId: PAGE, limit: 5000, maxJsonBytes: 4_000_000, cursor: "cursor-3" },
        ]);
    });
});

test("filePath ignores the caller's limit: every window is the large file window of 4 MB", async () => {
    await withExportDir(async (dir) => {
        const { backend, tool } = harness();
        answerWalk(backend);
        await tool.execute({ fileId: FILE, pageId: PAGE, limit: 50, filePath: path.join(dir, "limited.json") });
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { limit: number }).limit),
            [5000, 5000, 5000]
        );
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { maxJsonBytes: number }).maxJsonBytes),
            [4_000_000, 4_000_000, 4_000_000]
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
 * Puts a value back into the environment, or removes the variable when there was none.
 *
 * @param name - the variable
 * @param previous - the value it had, or undefined
 */
function restore(name: string, previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = previous;
    }
}

/**
 * Runs a test with PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB set to the given value, restoring the previous value after.
 *
 * @param kilobytes - the cap to set, as the environment text
 * @param body - the test body
 */
async function withSubtreeCap(kilobytes: string, body: () => Promise<void>): Promise<void> {
    const previous = process.env[SUBTREE_CAP_VARIABLE];
    process.env[SUBTREE_CAP_VARIABLE] = kilobytes;
    try {
        await body();
    } finally {
        restore(SUBTREE_CAP_VARIABLE, previous);
    }
}

/** Defaults that the fake backend lists for a compact page, as the real one lists them. */
const FAKE_DEFAULTS = { hidden: false, blocked: false, opacity: 1 };

/**
 * Returns a deterministic filler text.
 *
 * @param seed - decides the text
 * @param length - number of characters
 * @param noisy - true for text that hardly compresses, false for a repeating text
 */
function filler(seed: number, length: number, noisy: boolean): string {
    if (!noisy) {
        return "abcdef".repeat(Math.ceil(length / 6)).slice(0, length);
    }
    let state = seed * 2654435761 + 12345;
    let text = "";
    while (text.length < length) {
        state = (state * 1103515245 + 12345) % 2147483648;
        text += (state % 36).toString(36);
    }
    return text;
}

/**
 * A shape of the fake page whose JSON text is about the given size.
 *
 * @param n - position of the shape, which also names it
 * @param bytes - the size of its JSON text, at least 200
 * @param noisy - whether its filler hardly compresses
 */
function sizedShape(n: number, bytes: number, noisy = false): Record<string, unknown> {
    const base: Record<string, unknown> = {
        id: idOf(n),
        type: n % 5 === 0 ? "circle" : "rect",
        name: `Shape ${n}`,
        parentId: ROOT,
        frameId: ROOT,
        hidden: false,
        blocked: false,
        opacity: 1,
        rotation: null,
        content: "",
    };
    const padding = Math.max(0, bytes - Buffer.byteLength(JSON.stringify(base), "utf8"));
    return { ...base, content: filler(n, padding, noisy) };
}

/**
 * A page of shapes whose sizes run from 200 bytes to 40 kB, in a fixed pseudo-random order.
 *
 * @param count - number of shapes
 * @param noisy - whether the fillers hardly compress
 */
function variedPage(count: number, noisy = false): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, n) => sizedShape(n, 200 + ((n * 7919) % 39_800), noisy));
}

/**
 * Drops the keys that a compact shape leaves out: the null values and the defaults.
 *
 * @param shape - the full shape
 */
function compactOf(shape: Record<string, unknown>): Record<string, unknown> {
    const defaults = FAKE_DEFAULTS as Record<string, unknown>;
    return Object.fromEntries(
        Object.entries(shape).filter(([key, value]) => value !== null && !(key in defaults && defaults[key] === value))
    );
}

/** What the fake page does that the real backend does not, to reach cases that need it. */
interface PageFaults {
    /** Most shapes of one window, whatever the limit says. */
    perWindow?: number;
    /** Make windows as large as the limit allows, ignoring the byte budget (a backend that counts wrongly). */
    ignoreBytes?: boolean;
    /** Answer stale for this shape index as a cursor. */
    staleAt?: number;
    /** Answer this revision for the windows after the first. */
    laterRevn?: number;
}

/**
 * Makes the backend serve a page from an array of shapes, with windows sized as the real backend sizes them: the
 * JSON array of the window stays within maxJsonBytes, and a window always holds a shape. Cursors are `c<index>`.
 *
 * @param backend - the fake backend to answer on
 * @param shapes - the shapes of the page, in walk order
 * @param faults - the ways in which the fake page misbehaves
 */
function servePage(backend: FakePenpotBackend, shapes: Array<Record<string, unknown>>, faults: PageFaults = {}): void {
    backend.respond(COMMAND, (params: object) => {
        const asked = params as { cursor?: string; limit: number; maxJsonBytes: number; compact?: boolean };
        const start = asked.cursor === undefined ? 0 : Number(asked.cursor.slice(1));
        if (faults.staleAt === start && start > 0) {
            throw staleError();
        }
        const source = asked.compact === true ? shapes.map(compactOf) : shapes;
        const most = Math.min(asked.limit, faults.perWindow ?? Number.POSITIVE_INFINITY);
        let end = start;
        let size = 1;
        while (end < source.length && end - start < most) {
            const bytes = Buffer.byteLength(JSON.stringify(source[end]), "utf8") + 1;
            if (faults.ignoreBytes !== true && end > start && size + bytes > asked.maxJsonBytes) {
                break;
            }
            size += bytes;
            end += 1;
        }
        const more = end < source.length;
        return {
            revn: start > 0 && faults.laterRevn !== undefined ? faults.laterRevn : 7,
            pageId: PAGE,
            rootId: ROOT,
            total: source.length,
            ...(asked.compact === true ? { compact: true, defaults: FAKE_DEFAULTS } : {}),
            shapes: source.slice(start, end),
            truncated: more,
            ...(more ? { nextCursor: `c${end}` } : {}),
        };
    });
}

/** What one reply of a walk holds, as the tests read it. */
interface Reply {
    revn: number;
    total: number;
    windows: number;
    compact?: boolean;
    defaults?: Record<string, unknown>;
    shapes: Array<Record<string, unknown>> | { encoding: string; bytes: number; count: number; data: string };
    truncated: boolean;
    nextCursor?: string;
}

/** The result of a whole walk with tool calls. */
interface Walk {
    /** Every reply, parsed. */
    replies: Reply[];
    /** The size of every reply as sent, in bytes. */
    sizes: number[];
    /** Every shape, in order, with the gzip form decoded. */
    shapes: Array<Record<string, unknown>>;
}

/**
 * Decodes the shapes of a reply, plain or gzip-base64.
 *
 * @param shapes - the shapes field of a reply
 */
function decodedShapes(shapes: Reply["shapes"]): Array<Record<string, unknown>> {
    if (Array.isArray(shapes)) {
        return shapes;
    }
    return JSON.parse(gunzipSync(Buffer.from(shapes.data, "base64")).toString("utf8")) as Array<
        Record<string, unknown>
    >;
}

/**
 * Walks a page with tool calls, the way a client does: call, then call again with nextCursor until there is none.
 *
 * @param tool - the tool
 * @param args - the arguments of the first call
 * @param maxCalls - the walk fails when it takes more calls
 */
async function walkPage(tool: ExportSubtreeTool, args: Record<string, unknown> = {}, maxCalls = 2000): Promise<Walk> {
    const walk: Walk = { replies: [], sizes: [], shapes: [] };
    let cursor: string | undefined;
    do {
        assert.ok(walk.replies.length < maxCalls, "the walk does not end");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, ...args, cursor });
        assert.notEqual(response.isError, true, textOf(response));
        const text = textOf(response);
        const reply = JSON.parse(text) as Reply;
        assert.equal("partial" in reply, false, "a reply is never cut");
        walk.replies.push(reply);
        walk.sizes.push(Buffer.byteLength(text, "utf8"));
        walk.shapes.push(...decodedShapes(reply.shapes));
        // a reply never lacks a cursor while shapes remain
        assert.equal(reply.truncated, reply.nextCursor !== undefined);
        assert.equal(reply.truncated || walk.shapes.length === reply.total, true);
        cursor = reply.nextCursor;
    } while (cursor !== undefined);
    return walk;
}

/**
 * What a plain walk must return for a page: the shapes as the tools show them.
 *
 * @param shapes - the stored shapes
 */
function shownShapes(shapes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return shapes.map((shape) => ({ ...shape, type: shape.type === "circle" ? "ellipse" : shape.type }));
}

test("a walk of shapes from 200 bytes to 40 kB under the default cap visits each shape once and never dead-ends", async (t) => {
    const page = variedPage(300);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool);
    assert.deepEqual(walk.shapes, shownShapes(page));
    assert.equal(
        walk.sizes.every((size) => size <= 100_000),
        true
    );
    // a reply is filled: all but the last hold more than half the cap
    assert.equal(
        walk.sizes.slice(0, -1).every((size) => size > 50_000),
        true
    );
    t.diagnostic(`${page.length} shapes in ${walk.replies.length} calls under 100 kB`);
});

test("the same walk under a 1 MB cap takes far fewer calls", async (t) => {
    const page = variedPage(300);
    const small = harness();
    servePage(small.backend, page);
    const smallWalk = await walkPage(small.tool);
    await withSubtreeCap("1000", async () => {
        const { backend, tool } = harness();
        servePage(backend, page);
        const walk = await walkPage(tool);
        assert.deepEqual(walk.shapes, shownShapes(page));
        assert.equal(
            walk.sizes.every((size) => size <= 1_000_000),
            true
        );
        assert.equal(walk.replies.length * 8 <= smallWalk.replies.length, true);
        t.diagnostic(`${smallWalk.replies.length} calls under 100 kB, ${walk.replies.length} calls under 1 MB`);
    });
});

test("a call reads several backend windows and says how many", async () => {
    const page = Array.from({ length: 10 }, (_, n) => sizedShape(n, 300));
    const { backend, tool } = harness();
    servePage(backend, page, { perWindow: 3 });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse(textOf(response)) as Reply;
    assert.equal(body.windows, 4);
    assert.equal(body.truncated, false);
    assert.deepEqual(
        (body.shapes as Array<{ id: string }>).map((shape) => shape.id),
        page.map((shape) => shape.id)
    );
    assert.deepEqual(
        paramsOf(backend.calls).map((params) => (params as { cursor?: string }).cursor),
        [undefined, "c3", "c6", "c9"]
    );
});

test("a rate limit on a later window returns the windows held, with the cursor and a note", async () => {
    const { backend, tool } = harness();
    backend.respond(COMMAND, (params: object) => {
        if ((params as { cursor?: string }).cursor === "cursor-2") {
            throw new BackendRateLimitError(7);
        }
        return WINDOW_1;
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    const body = JSON.parse(textOf(response)) as {
        windows: number;
        truncated: boolean;
        nextCursor?: string;
        note?: string;
        shapes: Array<{ id: string }>;
    };
    assert.equal(body.windows, 1);
    assert.equal(body.truncated, true);
    assert.equal(body.nextCursor, "cursor-2");
    assert.deepEqual(
        body.shapes.map((shape) => shape.id),
        [0, 1, 2].map(idOf)
    );
    assert.match(body.note ?? "", /rate limit stopped this call after 1 backend window/);
    assert.match(body.note ?? "", /Wait about 7 s, then pass nextCursor as cursor/);
});

test("a rate limit on the first window fails the call with the rate-limit error", async () => {
    const { backend, tool } = harness();
    backend.respond(COMMAND, () => {
        throw new BackendRateLimitError(undefined);
    });
    const response = await tool.execute({ fileId: FILE, pageId: PAGE });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /backend rate limit reached, wait about 10 s and retry\. A cursor/);
});

test("a window above the cap is asked again with fewer shapes, and no reply is cut", async () => {
    await withSubtreeCap("20", async () => {
        const page = Array.from({ length: 40 }, (_, n) => sizedShape(n, 3000));
        const { backend, tool } = harness();
        servePage(backend, page, { ignoreBytes: true });
        const first = await tool.execute({ fileId: FILE, pageId: PAGE });
        const body = JSON.parse(textOf(first)) as Reply;
        const ids = (body.shapes as Array<{ id: string }>).map((shape) => shape.id);
        const limits = paramsOf(backend.calls).map((params) => (params as { limit: number }).limit);
        assert.equal(limits[0], 5000);
        assert.equal(limits[1] < 40, true);
        assert.equal(limits[1], ids.length);
        assert.equal(ids.length > 1, true);
        assert.equal(Buffer.byteLength(textOf(first), "utf8") <= 20_000, true);
        assert.equal(body.truncated, true);
        assert.equal(body.nextCursor, `c${ids.length}`);
        assert.deepEqual(
            ids,
            page.slice(0, ids.length).map((shape) => shape.id)
        );
        // the next call resumes at the right shape
        const walk = await walkPage(tool);
        assert.deepEqual(walk.shapes, shownShapes(page));
        assert.equal(
            walk.sizes.every((size) => size <= 20_000),
            true
        );
    });
});

test("the adapter stops before a window that does not fit, with the cursor that resumes there", async () => {
    await withSubtreeCap("20", async () => {
        const page = [...Array.from({ length: 6 }, (_, n) => sizedShape(n, 1000)), sizedShape(6, 15_000)];
        const { backend, tool } = harness();
        servePage(backend, page, { perWindow: 3 });
        const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply;
        // the two windows of six shapes fit; the window that starts at the big shape would overflow the reply
        assert.equal((body.shapes as unknown[]).length, 6);
        assert.equal(body.nextCursor, "c6");
        assert.equal(body.truncated, true);
        const rest = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE, cursor: "c6" }))) as Reply;
        assert.deepEqual(
            (rest.shapes as Array<{ id: string }>).map((shape) => shape.id),
            [idOf(6)]
        );
        assert.equal(rest.truncated, false);
    });
});

/** Random text of printable characters that hardly compresses: about 6.5 bits of each 8. */
function noiseText(length: number): string {
    const alphabet = "!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~";
    return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
}

/** A page of small shapes with one of 300 kB at an index. */
function pageWithBigShape(count: number, bigIndex: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, n) => sizedShape(n, n === bigIndex ? 300_000 : 500));
}

/**
 * Checks a finished walk of a page that holds one shape above the cap: every other shape comes whole and once, in
 * order; the big one comes once, cut, listed in `oversize`; and no reply is above the cap.
 *
 * @param walk - the walk
 * @param expected - the shapes of the page as a plain walk shows them, compact or not
 * @param bigIndex - position of the big shape
 * @param cap - the cap of a reply, in bytes
 */
function assertBigShapeWalk(walk: Walk, expected: Array<Record<string, unknown>>, bigIndex: number, cap: number): void {
    assert.equal(walk.shapes.length, expected.length, "every shape once");
    walk.shapes.forEach((shape, n) => {
        if (n === bigIndex) {
            assert.equal(shape.id, expected[n].id);
            assert.deepEqual(shape.content, { omitted: true, bytes: JSON.stringify(expected[n].content).length });
        } else {
            assert.deepEqual(shape, expected[n]);
        }
    });
    assert.equal(
        walk.sizes.every((size) => size <= cap),
        true
    );
    const cut = walk.replies.filter((reply) => "oversize" in reply);
    assert.equal(cut.length, 1, "one reply carries the cut shape");
    const reply = cut[0] as Reply & { oversize: Array<{ id: string; bytes: number; omitted: string[] }>; note: string };
    assert.equal(reply.oversize.length, 1);
    assert.equal(reply.oversize[0].id, idOf(bigIndex));
    assert.equal(reply.oversize[0].bytes, Buffer.byteLength(JSON.stringify(expected[bigIndex]), "utf8"));
    assert.deepEqual(reply.oversize[0].omitted, ["content"]);
    assert.match(reply.note, /PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB/);
    assert.match(reply.note, /filePath/);
    assert.equal(reply.nextCursor, `c${bigIndex + 1}`, "the cursor is right after the big shape");
    assert.equal(decodedShapes(reply.shapes).length > 0, true);
    assert.equal(walk.replies[walk.replies.length - 1].truncated, false, "the walk ends");
}

test("a walk across a shape above the cap visits every other shape once, and returns that one cut", async () => {
    const page = pageWithBigShape(40, 20);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool);
    assertBigShapeWalk(walk, shownShapes(page), 20, 100_000);
});

test("a shape above the cap is cut the same way in a compact walk", async () => {
    const page = pageWithBigShape(40, 20);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { compact: true });
    assertBigShapeWalk(walk, shownShapes(page.map(compactOf)), 20, 100_000);
});

test("a shape above the cap is cut the same way in a gzip-base64 walk, with the notice left plain", async () => {
    const page = pageWithBigShape(40, 20);
    const { backend, tool } = harness();
    servePage(backend, page);
    // random filler does not compress, so the shape is above the cap as sent, too
    page[20] = { ...sizedShape(20, 500), content: randomBytes(150_000).toString("hex") };
    const walk = await walkPage(tool, { encoding: "gzip-base64" });
    assertBigShapeWalk(walk, shownShapes(page), 20, 100_000);
    const cut = walk.replies.find((reply) => "oversize" in reply) as Reply;
    assert.equal((cut.shapes as { encoding: string }).encoding, "gzip-base64", "the cut shape is inside the encoding");
});

test("a cut shape whose rest does not compress still fits the cap in gzip mode, and the walk ends", async () => {
    const page = pageWithBigShape(40, 20);
    // after content is cut, 95 kB of incompressible text is left: it fits as plain text, but its base64 gzip is above the 100 kB cap
    page[20] = {
        ...sizedShape(20, 500),
        content: randomBytes(150_000).toString("hex"),
        blob: noiseText(95_000),
    };
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64" });
    assert.equal(walk.shapes.length, 40);
    assert.equal(
        walk.sizes.every((size) => size <= 100_000),
        true
    );
    const cut = walk.replies.filter((reply) => "oversize" in reply) as Array<
        Reply & { oversize: Array<{ id: string; omitted: string[] }> }
    >;
    assert.equal(cut.length, 1);
    assert.equal(cut[0].oversize[0].id, idOf(20));
    assert.equal(cut[0].oversize[0].omitted.includes("blob"), true);
    assert.equal(cut[0].nextCursor, "c21");
    assert.equal(walk.replies[walk.replies.length - 1].truncated, false);
});

test("a shape that the raised cap fits comes whole, with no notice", async () => {
    await withSubtreeCap("1000", async () => {
        const page = pageWithBigShape(40, 20);
        const { backend, tool } = harness();
        servePage(backend, page);
        const walk = await walkPage(tool);
        assert.deepEqual(walk.shapes, shownShapes(page));
        assert.equal(
            walk.replies.some((reply) => "oversize" in reply),
            false
        );
    });
});

test("a shape above the cap that starts the walk comes back cut with the cursor after it", async () => {
    await withSubtreeCap("20", async () => {
        const { backend, tool } = harness();
        servePage(backend, [sizedShape(0, 30_000), sizedShape(1, 500)]);
        const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply & {
            oversize: Array<{ id: string }>;
        };
        assert.equal(body.oversize[0].id, idOf(0));
        assert.equal((body.shapes as Array<{ id: string }>).length, 1);
        assert.equal(body.nextCursor, "c1");
        assert.equal(body.truncated, true);
        assert.equal(paramsOf(backend.calls).length, 1);
    });
});

test("a shape above the cap that is in a window of several is asked for alone, so the cursor is right after it", async () => {
    await withSubtreeCap("20", async () => {
        const { backend, tool } = harness();
        servePage(backend, [sizedShape(0, 30_000), sizedShape(1, 500)], { ignoreBytes: true });
        const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply;
        assert.equal(body.nextCursor, "c1");
        assert.deepEqual(
            paramsOf(backend.calls).map((params) => (params as { limit: number }).limit),
            [5000, 1]
        );
    });
});

test("a first window that is asked for again and comes from a newer revision gives its own head, never a mix", async () => {
    await withSubtreeCap("20", async () => {
        const { backend, tool } = harness();
        let calls = 0;
        backend.respond(COMMAND, (params: object) => {
            calls += 1;
            const limit = (params as { limit: number }).limit;
            const newer = calls > 1;
            const shapes = Array.from({ length: Math.min(limit, 8) }, (_, n) => sizedShape(n, 3000));
            return {
                revn: newer ? 8 : 7,
                pageId: PAGE,
                rootId: ROOT,
                total: newer ? 9 : 8,
                shapes,
                truncated: true,
                nextCursor: `c${shapes.length}`,
            };
        });
        const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE, limit: 8 }))) as Reply;
        assert.equal(body.revn, 8);
        assert.equal(body.total, 9);
    });
});

test("a stale cursor after some windows returns what was read, and the next call is told it is stale", async () => {
    const page = Array.from({ length: 9 }, (_, n) => sizedShape(n, 300));
    const { backend, tool } = harness();
    servePage(backend, page, { perWindow: 3, staleAt: 6 });
    const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply;
    assert.equal((body.shapes as unknown[]).length, 6);
    assert.equal(body.nextCursor, "c6");
    const next = await tool.execute({ fileId: FILE, pageId: PAGE, cursor: "c6" });
    assert.equal(next.isError, true);
});

test("a stale cursor after some windows adds a note: the page changed, the cursor is stale, start again", async () => {
    const page = Array.from({ length: 9 }, (_, n) => sizedShape(n, 300));
    const { backend, tool } = harness();
    servePage(backend, page, { perWindow: 3, staleAt: 6 });
    const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply & { note?: string };
    assert.equal(body.nextCursor, "c6");
    assert.match(body.note ?? "", /page changed \(its revn moved\) while this call read it/);
    assert.match(body.note ?? "", /from before the change/);
    assert.match(body.note ?? "", /refuse nextCursor as stale\. Start the walk again without a cursor\./);
});

test("a one-window reply at an exact fit plus a note is returned, with the note only when it fits", async () => {
    const { tool } = harness();
    const inner = tool as unknown as {
        capBytes: number;
        finishReply: (
            head: unknown,
            windows: unknown[],
            gzip: boolean,
            note?: string
        ) => Promise<{ content: Array<{ text: string }> }>;
    };
    const head = { revn: 7, pageId: PAGE, rootId: ROOT, total: 1, compact: false, defaults: undefined };
    const windowOf = (pad: number): unknown => ({
        raw: {},
        shapes: [{ id: "a", content: "x".repeat(pad) }],
        cost: 0,
        plainBytes: 0,
        nextCursor: "c1",
    });
    const note = "The rate limit stopped this call after 1 backend window. Wait about 10 s, then pass nextCursor.";
    // pad the one shape until the reply without a note is exactly the cap
    const bare = await inner.finishReply(head, [windowOf(0)], false);
    const pad = inner.capBytes - Buffer.byteLength(bare.content[0].text, "utf8");
    const exact = await inner.finishReply(head, [windowOf(pad)], false, note);
    const exactBody = JSON.parse(exact.content[0].text) as { shapes: unknown[]; note?: string };
    assert.equal(exactBody.shapes.length, 1);
    assert.equal(exactBody.note, undefined, "no room for the note: the window is sent without it");
    assert.equal(Buffer.byteLength(exact.content[0].text, "utf8"), inner.capBytes);
    const roomy = await inner.finishReply(head, [windowOf(pad - 500)], false, note);
    assert.equal((JSON.parse(roomy.content[0].text) as { note?: string }).note, note);
});

test("a window of another revision is not mixed into the reply", async () => {
    const page = Array.from({ length: 9 }, (_, n) => sizedShape(n, 300));
    const { backend, tool } = harness();
    servePage(backend, page, { perWindow: 3, laterRevn: 8 });
    const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply;
    assert.equal(body.revn, 7);
    assert.equal((body.shapes as unknown[]).length, 3);
    assert.equal(body.nextCursor, "c3");
});

test("a backend that repeats a cursor fails the call", async () => {
    const { backend, tool } = harness();
    backend.respond(COMMAND, (params: object) => ({
        ...WINDOW_1,
        nextCursor: (params as { cursor?: string }).cursor ?? "same",
    }));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, cursor: "same" });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /repeated a cursor/);
});

test("the cap of export_subtree is its own variable, which defaults to the shared cap", () => {
    assert.equal(ExportSubtreeTool.readCapBytes({}), 100_000);
    assert.equal(ExportSubtreeTool.readCapBytes({ PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "" }), 100_000);
    assert.equal(ExportSubtreeTool.readCapBytes({ PENPOT_MCP_MAX_TOOL_RESPONSE_KB: "250" }), 250_000);
    assert.equal(ExportSubtreeTool.readCapBytes({ PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "1000" }), 1_000_000);
    assert.equal(ExportSubtreeTool.readCapBytes({ PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "10000" }), 10_000_000);
    assert.equal(
        ExportSubtreeTool.readCapBytes({
            PENPOT_MCP_MAX_TOOL_RESPONSE_KB: "250",
            PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "1000",
        }),
        1_000_000
    );
    // the shared cap of the other tools does not follow it
    assert.equal(
        BackendTool.readMaxResponseBytes({ PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "1000" }),
        BackendTool.MAX_RESPONSE_BYTES
    );
});

test("a cap that is not a whole number of kilobytes from 1 to 10000 fails the tool at start", () => {
    for (const raw of ["0", "-1", "10001", "1.5", "abc"]) {
        assert.throws(
            () => ExportSubtreeTool.readCapBytes({ PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: raw }),
            /PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB must be a whole number of kilobytes from 1 to 10000/,
            raw
        );
    }
    const previous = process.env[SUBTREE_CAP_VARIABLE];
    process.env[SUBTREE_CAP_VARIABLE] = "10001";
    try {
        assert.throws(() => harness(), /PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB/);
    } finally {
        restore(SUBTREE_CAP_VARIABLE, previous);
    }
});

test("a raised cap is the cap of the reply: a 1 MB reply holds what 100 kB cannot", async () => {
    await withSubtreeCap("1000", async () => {
        const page = Array.from({ length: 30 }, (_, n) => sizedShape(n, 20_000));
        const { backend, tool } = harness();
        servePage(backend, page);
        const body = JSON.parse(textOf(await tool.execute({ fileId: FILE, pageId: PAGE }))) as Reply;
        assert.equal((body.shapes as unknown[]).length, 30);
        assert.equal(body.truncated, false);
    });
});

test("compact forwards the option, lists the defaults once, and restores to the full shapes", async () => {
    const page = variedPage(40);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { compact: true });
    assert.equal(
        walk.replies.every((reply) => reply.compact === true),
        true
    );
    assert.equal(
        walk.replies.every((reply) => JSON.stringify(reply.defaults) === JSON.stringify(FAKE_DEFAULTS)),
        true
    );
    assert.equal(
        paramsOf(backend.calls).every((params) => (params as { compact?: boolean }).compact === true),
        true
    );
    // no null and no default is left in a compact shape
    for (const shape of walk.shapes) {
        assert.equal("rotation" in shape, false);
        assert.equal("hidden" in shape, false);
        assert.equal("opacity" in shape, false);
        assert.equal(typeof shape.type, "string");
    }
    // restoring with the listed defaults gives the full shape, but for its null keys
    const restored = walk.shapes.map((shape) => ({ ...(walk.replies[0].defaults ?? {}), ...shape }));
    const full = shownShapes(page).map((shape) =>
        Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== null))
    );
    assert.deepEqual(restored, full);
    // a compact walk sends fewer bytes than a full one
    const plain = harness();
    servePage(plain.backend, page);
    const sum = (sizes: number[]): number => sizes.reduce((total, size) => total + size, 0);
    assert.equal(sum(walk.sizes) < sum((await walkPage(plain.tool)).sizes), true);
    // a plain reply says nothing of compact
    const plainReply = JSON.parse(textOf(await plain.tool.execute({ fileId: FILE, pageId: PAGE, limit: 1 }))) as Reply;
    assert.equal("compact" in plainReply, false);
    assert.equal("defaults" in plainReply, false);
});

test("gzip-base64 decodes to the same shapes as the plain reply, and says bytes and count", async () => {
    const page = variedPage(20);
    const plain = harness();
    servePage(plain.backend, page);
    const plainWalk = await walkPage(plain.tool);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64" });
    assert.deepEqual(walk.shapes, plainWalk.shapes);
    for (const reply of walk.replies) {
        const packed = reply.shapes as { encoding: string; bytes: number; count: number; data: string };
        assert.equal(packed.encoding, "gzip-base64");
        const text = gunzipSync(Buffer.from(packed.data, "base64")).toString("utf8");
        assert.equal(packed.bytes, Buffer.byteLength(text, "utf8"));
        assert.equal(packed.count, (JSON.parse(text) as unknown[]).length);
        // the head fields stay plain
        assert.equal(reply.total, 20);
        assert.equal(reply.revn, 7);
    }
    assert.equal(walk.replies.length < plainWalk.replies.length, true);
});

test("the cap applies to a gzip-base64 reply as sent, and a walk of it never dead-ends", async () => {
    await withSubtreeCap("20", async () => {
        const page = Array.from({ length: 60 }, (_, n) => sizedShape(n, 200 + ((n * 7919) % 6_000), true));
        const { backend, tool } = harness();
        servePage(backend, page);
        const walk = await walkPage(tool, { encoding: "gzip-base64" });
        assert.deepEqual(walk.shapes, shownShapes(page));
        assert.equal(
            walk.sizes.every((size) => size <= 20_000),
            true
        );
        assert.equal(walk.replies.length > 1, true);
        // replies are filled: a call reads several windows until the compressed text fills the cap
        assert.equal(
            walk.sizes.slice(0, -1).every((size) => size > 10_000),
            true
        );
    });
});

test("a call gathers at most 16 MB of plain data under a raised cap with gzip, and the walk still ends", async () => {
    await withSubtreeCap("10000", async () => {
        // 40 MB of shapes that compress to almost nothing: the cap would let one call hold all of it
        const page = Array.from({ length: 8000 }, (_, n) => sizedShape(n, 5000));
        const { backend, tool } = harness();
        servePage(backend, page);
        const walk = await walkPage(tool, { encoding: "gzip-base64" });
        assert.equal(walk.shapes.length, page.length);
        assert.equal(walk.shapes[7999].id, idOf(7999));
        const sizes = walk.replies.map((reply) => (reply.shapes as { bytes: number }).bytes);
        assert.equal(
            sizes.every((bytes) => bytes <= 16 * 1024 * 1024),
            true,
            `plain bytes per call ${sizes.join(", ")}`
        );
        assert.equal(walk.replies.length >= 3, true);
    });
});

test("a gzip call compresses each window at most twice, and the reply round-trips", async (t) => {
    await withSubtreeCap("20", async () => {
        const page = Array.from({ length: 60 }, (_, n) => sizedShape(n, 200 + ((n * 7919) % 6_000), true));
        const { backend, tool } = harness();
        servePage(backend, page);
        const runs: number[] = [];
        const target = tool as unknown as { compress: (text: string) => Promise<Buffer> };
        const real = target.compress.bind(tool);
        target.compress = (text: string) => {
            runs.push(text.length);
            return real(text);
        };
        const walk = await walkPage(tool, { encoding: "gzip-base64" });
        assert.deepEqual(walk.shapes, shownShapes(page));
        const windowsRead = paramsOf(backend.calls).length;
        // one compression of the first window and one of the reply, for each call; never one per window, nor a
        // search of compressions to find what fits
        assert.equal(runs.length <= 2 * windowsRead, true, `${runs.length} compressions for ${windowsRead} windows`);
        t.diagnostic(`${runs.length} compressions, ${windowsRead} windows, ${walk.replies.length} calls`);
    });
});

test("windowBytesFor keeps a window within the backend response cap, with a floor", () => {
    assert.equal(ExportSubtreeTool.windowBytesFor(8), 4_000_000);
    assert.equal(ExportSubtreeTool.windowBytesFor(2), 1_048_576);
    assert.equal(ExportSubtreeTool.windowBytesFor(0.01), 64_000);
});

test("a file walk asks for windows that fit PENPOT_MCP_BACKEND_MAX_RESPONSE_MB", async () => {
    const previous = process.env.PENPOT_MCP_BACKEND_MAX_RESPONSE_MB;
    process.env.PENPOT_MCP_BACKEND_MAX_RESPONSE_MB = "2";
    try {
        await withExportDir(async (dir) => {
            const { backend, tool } = harness();
            answerWalk(backend);
            await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "out.json") });
            const asked = paramsOf(backend.calls).map((params) => (params as { maxJsonBytes: number }).maxJsonBytes);
            assert.deepEqual(asked, [1_048_576, 1_048_576, 1_048_576]);
        });
    } finally {
        restore("PENPOT_MCP_BACKEND_MAX_RESPONSE_MB", previous);
    }
});

test("compact and gzip-base64 work together", async () => {
    const page = variedPage(40);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { compact: true, encoding: "gzip-base64" });
    assert.equal(
        walk.replies.every((reply) => reply.compact === true),
        true
    );
    const compactWalk = await walkPage(tool, { compact: true });
    assert.deepEqual(walk.shapes, compactWalk.shapes);
    assert.equal(
        walk.shapes.every((shape) => !("rotation" in shape) && !("hidden" in shape)),
        true
    );
});

test("compact keeps the type and key names of the plain form", async () => {
    const page = variedPage(10);
    const plain = harness();
    servePage(plain.backend, page);
    const compact = harness();
    servePage(compact.backend, page);
    const plainShapes = (await walkPage(plain.tool)).shapes;
    const compactShapes = (await walkPage(compact.tool, { compact: true })).shapes;
    for (let n = 0; n < page.length; n++) {
        assert.equal(compactShapes[n].type, plainShapes[n].type);
        assert.equal(
            Object.keys(compactShapes[n]).every((key) => key in plainShapes[n]),
            true
        );
    }
    assert.equal(compactShapes[0].type, "ellipse");
});

test("filePath writes every shape once with the large windows, and a walk of it takes fewer windows", async (t) => {
    await withExportDir(async (dir) => {
        const page = variedPage(300);
        const { backend, tool } = harness();
        servePage(backend, page);
        const file = path.join(dir, "page.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file });
        assert.notEqual(response.isError, true, textOf(response));
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as { shapes: unknown[]; total: number };
        assert.deepEqual(document.shapes, shownShapes(page));
        assert.equal(document.total, 300);
        const params = paramsOf(backend.calls) as Array<{ limit: number; maxJsonBytes: number }>;
        assert.equal(
            params.every((p) => p.limit === 5000 && p.maxJsonBytes === 4_000_000),
            true
        );
        const reply = JSON.parse(textOf(response)) as { windows: number };
        assert.equal(reply.windows, params.length);
        t.diagnostic(`${page.length} shapes written in ${reply.windows} windows of up to 4 MB`);
        assert.equal(reply.windows <= 2, true);
    });
});

test("filePath with compact writes compact shapes and the defaults, and refuses an encoding", async () => {
    await withExportDir(async (dir) => {
        const page = variedPage(20);
        const { backend, tool } = harness();
        servePage(backend, page);
        const file = path.join(dir, "compact.json");
        const response = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: file, compact: true });
        assert.notEqual(response.isError, true, textOf(response));
        const document = JSON.parse(fs.readFileSync(file, "utf8")) as {
            compact: boolean;
            defaults: unknown;
            shapes: Array<Record<string, unknown>>;
        };
        assert.equal(document.compact, true);
        assert.deepEqual(document.defaults, FAKE_DEFAULTS);
        assert.deepEqual(document.shapes, shownShapes(page.map(compactOf)));

        const refused = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            filePath: path.join(dir, "gzip.json"),
            encoding: "gzip-base64",
        });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /encoding cannot be used with filePath/);
        assert.equal(fs.existsSync(path.join(dir, "gzip.json")), false);
    });
});

test("in multi-user mode filePath is refused and compact and gzip-base64 still work", async () => {
    await withExportDir(async (dir) => {
        const page = variedPage(10);
        const { backend, tool } = harness(false);
        servePage(backend, page);
        const refused = await tool.execute({ fileId: FILE, pageId: PAGE, filePath: path.join(dir, "no.json") });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /File paths are off/);
        const walk = await walkPage(tool, { compact: true, encoding: "gzip-base64" });
        assert.equal(walk.shapes.length, 10);
    });
});

test("the tool description says what compact and encoding are for", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /compact: true/);
    assert.match(description, /a model should not ask for it/);
    assert.match(description, /nextCursor whenever shapes remain/);
});

test("the description of compact says what is left out, and does not call strokes a default of a missing key", () => {
    const description = (ExportSubtreeArgs.schema.compact.description ?? "") as string;
    assert.match(description, /top-level keys/);
    assert.match(description, /strokeAlignment is left out when it is center/);
    assert.doesNotMatch(description, /a key that is absent has that default/);
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

const REQUEST_MAX_VARIABLE = "PENPOT_MCP_SUBTREE_MAX_REQUEST_KB";

/**
 * Runs a test with PENPOT_MCP_SUBTREE_MAX_REQUEST_KB set, restoring the previous value after.
 *
 * @param kilobytes - the server maximum to set, as the environment text
 * @param body - the test body
 */
async function withRequestMax(kilobytes: string, body: () => Promise<void>): Promise<void> {
    const previous = process.env[REQUEST_MAX_VARIABLE];
    process.env[REQUEST_MAX_VARIABLE] = kilobytes;
    try {
        await body();
    } finally {
        restore(REQUEST_MAX_VARIABLE, previous);
    }
}

/**
 * A page of noisy shapes of 20 kB each, which compress to about two thirds: the default 100 kB cap cannot hold
 * it in one reply and 1 MB can.
 *
 * @param count - number of shapes
 */
function noisyPage(count = 40): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, n) => ({
        ...sizedShape(n, 300),
        content: randomBytes(10_000).toString("hex"),
    }));
}

test("the schema accepts maxResponseKb from 1 to 10000 and refuses values outside them", () => {
    const schema = z.object(ExportSubtreeArgs.schema);
    const parse = (maxResponseKb: unknown) => schema.safeParse({ fileId: FILE, pageId: PAGE, maxResponseKb }).success;
    assert.equal(parse(1), true);
    assert.equal(parse(1000), true);
    assert.equal(parse(10000), true);
    assert.equal(parse(0), false);
    assert.equal(parse(10001), false);
    assert.equal(parse(1.5), false);
    assert.equal(parse("1000"), false);
    assert.equal(schema.safeParse({ fileId: FILE, pageId: PAGE }).success, true);
});

test("maxResponseKb with gzip-base64 is the cap of the reply: fewer calls, each within it, every shape once", async (t) => {
    const page = noisyPage();
    const small = harness();
    servePage(small.backend, page);
    const defaultWalk = await walkPage(small.tool, { encoding: "gzip-base64" });
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 1000 });
    assert.deepEqual(walk.shapes, shownShapes(page));
    assert.equal(
        walk.sizes.every((size) => size <= 1_000_000),
        true
    );
    assert.equal(
        walk.sizes.some((size) => size > 100_000),
        true,
        "a reply is larger than the default cap"
    );
    assert.equal(walk.replies.length * 4 <= defaultWalk.replies.length, true);
    t.diagnostic(`${defaultWalk.replies.length} calls at the default cap, ${walk.replies.length} at 1000 kB`);
});

test("maxResponseKb can also ask for less than the default cap", async () => {
    const page = noisyPage(20);
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 30 });
    assert.deepEqual(walk.shapes, shownShapes(page));
    assert.equal(
        walk.sizes.every((size) => size <= 30_000),
        true
    );
    assert.equal(walk.replies.length > 1, true);
});

test("maxResponseKb replaces PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB for that call only", async () => {
    await withSubtreeCap("20", async () => {
        const page = noisyPage(20);
        const { backend, tool } = harness();
        servePage(backend, page);
        const raised = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 1000 });
        assert.equal(raised.replies.length, 1);
        const plain = await walkPage(tool, { encoding: "gzip-base64" });
        assert.equal(
            plain.sizes.every((size) => size <= 20_000),
            true
        );
        assert.equal(plain.replies.length > 1, true);
    });
});

test("maxResponseKb without encoding is refused before any window is read, and says why", async () => {
    const { backend, tool } = harness();
    servePage(backend, noisyPage(3));
    const response = await tool.execute({ fileId: FILE, pageId: PAGE, maxResponseKb: 1000 });
    assert.equal(response.isError, true);
    assert.match(
        textOf(response),
        /maxResponseKb can only be used with encoding "gzip-base64": it is for scripts, and a model client keeps the default cap\./
    );
    assert.equal(paramsOf(backend.calls).length, 0);
});

test("maxResponseKb with filePath is refused before any window is read", async () => {
    const { backend, tool } = harness();
    servePage(backend, noisyPage(3));
    const response = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        filePath: path.join(os.tmpdir(), "never.json"),
        encoding: "gzip-base64",
        maxResponseKb: 1000,
    });
    assert.equal(response.isError, true);
    assert.match(textOf(response), /maxResponseKb cannot be used with filePath/);
    assert.equal(paramsOf(backend.calls).length, 0);
});

test("maxResponseKb above the server maximum is refused naming the limit, at the default and at a set maximum", async () => {
    const { backend, tool } = harness();
    servePage(backend, noisyPage(3));
    const response = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        encoding: "gzip-base64",
        maxResponseKb: 2001,
    });
    assert.equal(response.isError, true);
    assert.match(
        textOf(response),
        /maxResponseKb 2001 is above the server maximum of 2000 kB \(PENPOT_MCP_SUBTREE_MAX_REQUEST_KB\)\./
    );
    assert.equal(paramsOf(backend.calls).length, 0);
    // exactly the maximum is accepted
    const ok = await tool.execute({ fileId: FILE, pageId: PAGE, encoding: "gzip-base64", maxResponseKb: 2000 });
    assert.notEqual(ok.isError, true, textOf(ok));
    await withRequestMax("500", async () => {
        const low = harness();
        servePage(low.backend, noisyPage(3));
        const refused = await low.tool.execute({
            fileId: FILE,
            pageId: PAGE,
            encoding: "gzip-base64",
            maxResponseKb: 501,
        });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /above the server maximum of 500 kB/);
        const accepted = await low.tool.execute({
            fileId: FILE,
            pageId: PAGE,
            encoding: "gzip-base64",
            maxResponseKb: 500,
        });
        assert.notEqual(accepted.isError, true, textOf(accepted));
    });
});

test("without maxResponseKb the replies are what they were: the default cap, same as asking for 100", async () => {
    const page = noisyPage();
    const first = harness();
    servePage(first.backend, page);
    const second = harness();
    servePage(second.backend, page);
    const absent = await walkPage(first.tool, { encoding: "gzip-base64" });
    const explicit = await walkPage(second.tool, { encoding: "gzip-base64", maxResponseKb: 100 });
    assert.equal(
        absent.sizes.every((size) => size <= 100_000),
        true
    );
    assert.deepEqual(
        absent.replies.map((reply) => reply.nextCursor),
        explicit.replies.map((reply) => reply.nextCursor)
    );
    assert.deepEqual(absent.sizes, explicit.sizes);
});

test("a raised cap keeps the guarantees: the 16 MB gather limit, never cut, a cursor while shapes remain", async () => {
    await withRequestMax("10000", async () => {
        const page = Array.from({ length: 8000 }, (_, n) => sizedShape(n, 5000));
        const { backend, tool } = harness();
        servePage(backend, page);
        const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 10000 });
        assert.equal(walk.shapes.length, page.length);
        const sizes = walk.replies.map((reply) => (reply.shapes as { bytes: number }).bytes);
        assert.equal(
            sizes.every((bytes) => bytes <= 16 * 1024 * 1024),
            true,
            `plain bytes per call ${sizes.join(", ")}`
        );
        assert.equal(walk.replies.length >= 3, true);
    });
});

test("a raised cap keeps the rate-limit partial reply, with the cursor and a note", async () => {
    const { backend, tool } = harness();
    backend.respond(COMMAND, (params: object) => {
        if ((params as { cursor?: string }).cursor === "cursor-2") {
            throw new BackendRateLimitError(7);
        }
        return WINDOW_1;
    });
    const response = await tool.execute({
        fileId: FILE,
        pageId: PAGE,
        encoding: "gzip-base64",
        maxResponseKb: 1000,
    });
    const body = JSON.parse(textOf(response)) as Reply & { note?: string };
    assert.equal(body.windows, 1);
    assert.equal(body.truncated, true);
    assert.equal(body.nextCursor, "cursor-2");
    assert.deepEqual(
        decodedShapes(body.shapes).map((shape) => shape.id),
        [0, 1, 2].map(idOf)
    );
    assert.match(body.note ?? "", /rate limit stopped this call after 1 backend window/);
});

test("a shape above a raised cap is still cut and listed, and the walk goes on after it", async () => {
    const page = [
        sizedShape(0, 300),
        { ...sizedShape(1, 300), content: randomBytes(40_000).toString("hex") },
        sizedShape(2, 300),
    ];
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 20 });
    assert.deepEqual(
        walk.shapes.map((shape) => shape.id),
        [idOf(0), idOf(1), idOf(2)]
    );
    assert.match(JSON.stringify(walk.replies), /oversize/);
});

test("PENPOT_MCP_SUBTREE_MAX_REQUEST_KB defaults to 2000 and accepts whole kilobytes from 1 to 10000", () => {
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({}), 2_000_000);
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: "" }), 2_000_000);
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: "1" }), 1_000);
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: "10000" }), 10_000_000);
    // it does not follow the other caps
    assert.equal(
        ExportSubtreeTool.readRequestMaxBytes({
            PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB: "50",
            PENPOT_MCP_MAX_TOOL_RESPONSE_KB: "50",
        }),
        2_000_000
    );
});

test("a server maximum outside 1 to 10000 fails the tool at start, naming the variable", () => {
    for (const raw of ["0", "-1", "10001", "1.5", "abc"]) {
        assert.throws(
            () => ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: raw }),
            /PENPOT_MCP_SUBTREE_MAX_REQUEST_KB must be a whole number of kilobytes from 1 to 10000/,
            raw
        );
    }
    const previous = process.env[REQUEST_MAX_VARIABLE];
    process.env[REQUEST_MAX_VARIABLE] = "10001";
    try {
        assert.throws(() => harness(), /PENPOT_MCP_SUBTREE_MAX_REQUEST_KB/);
    } finally {
        restore(REQUEST_MAX_VARIABLE, previous);
    }
});

test("the description and the schema say maxResponseKb is for scripts, needs gzip-base64 and has a server maximum", () => {
    const { tool } = harness();
    const description = tool.getToolDescription();
    assert.match(description, /maxResponseKb/);
    assert.match(description, /PENPOT_MCP_SUBTREE_MAX_REQUEST_KB/);
    const text = ExportSubtreeArgs.schema.maxResponseKb.description ?? "";
    assert.match(text, /For scripts only/);
    assert.match(text, /gzip-base64/);
    assert.match(text, /PENPOT_MCP_SUBTREE_MAX_REQUEST_KB/);
});

test("a raised cap is filled when the shapes compress several times: a call reads more than one window", async (t) => {
    // 20 kB shapes of which 6 kB is hex noise: about 1 byte of reply for 5 of JSON
    const page: Array<Record<string, unknown>> = Array.from({ length: 1200 }, (_, n) => ({
        ...sizedShape(n, 300),
        content: randomBytes(3000).toString("hex") + filler(n, 14_000, false),
    }));
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 1000 });
    assert.equal(walk.shapes.length, page.length);
    assert.deepEqual(
        walk.shapes.map((shape) => shape.id),
        page.map((shape) => shape.id)
    );
    assert.equal(
        walk.sizes.every((size) => size <= 1_000_000),
        true
    );
    const first = walk.replies[0];
    assert.equal(first.windows > 1, true, `the first reply read ${first.windows} window`);
    const plainPerReply = (walk.replies[0].shapes as { bytes: number }).bytes;
    const ratio = plainPerReply / walk.sizes[0];
    assert.equal(ratio > 3.5, true, `test data compresses ${ratio} times`);
    // every reply but the last is more than three quarters full
    assert.equal(
        walk.sizes.slice(0, -1).every((size) => size > 750_000),
        true,
        `reply sizes ${walk.sizes.join(", ")}`
    );
    t.diagnostic(
        `windows ${walk.replies.map((r) => r.windows).join(",")} ratio ${ratio.toFixed(1)}; ${walk.replies.length} calls, replies of ${walk.sizes.slice(0, 3).join(", ")} bytes`
    );
});

test("plain default packing is pinned to the numbers it had before maxResponseKb: 72 calls, fixed sizes and cursors", async () => {
    // measured on the code before the parameter was added; plain mode asks for the room as it is (ratio 1)
    const { backend, tool } = harness();
    servePage(backend, variedPage(300));
    const walk = await walkPage(tool);
    assert.equal(walk.replies.length, 72);
    assert.equal(paramsOf(backend.calls).length, 145);
    assert.deepEqual(
        walk.sizes.slice(0, 12),
        [80421, 87475, 94780, 94579, 77711, 85016, 92320, 99624, 68361, 82556, 89860, 97164]
    );
    assert.equal(walk.sizes[walk.sizes.length - 1], 31804);
    assert.equal(
        walk.sizes.reduce((sum, size) => sum + size, 0),
        6_194_329
    );
    assert.equal(
        walk.replies.reduce((sum, reply) => sum + reply.windows, 0),
        83
    );
    assert.deepEqual(
        walk.replies.slice(0, 12).map((reply) => reply.nextCursor),
        ["c5", "c9", "c13", "c16", "c20", "c24", "c28", "c32", "c35", "c39", "c43", "c47"]
    );
    assert.equal(walk.replies[walk.replies.length - 2].nextCursor, "c298");
    assert.equal(walk.replies[walk.replies.length - 1].nextCursor, undefined);
});

test("gzip default packing (no maxResponseKb) is the improved packing: later windows are asked for what fits with the margin", async () => {
    const page = Array.from({ length: 300 }, (_, n) => ({
        ...sizedShape(n, 300),
        content: randomBytes(3000).toString("hex") + filler(n, 14_000, false),
    }));
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64" });
    assert.equal(walk.shapes.length, 300);
    assert.equal(
        walk.sizes.every((size) => size <= 100_000),
        true
    );
    assert.equal(walk.replies[0].windows > 1, true);
});

test("the advice to raise the cap names maxResponseKb and the server maximum when the call set it", async () => {
    const page = [sizedShape(0, 300), { ...sizedShape(1, 300), content: randomBytes(40_000).toString("hex") }];
    const { backend, tool } = harness();
    servePage(backend, page);
    const walk = await walkPage(tool, { encoding: "gzip-base64", maxResponseKb: 20 });
    const cut = walk.replies.find((reply) => "oversize" in reply) as unknown as Reply & { note: string };
    assert.match(
        cut.note,
        /Raise maxResponseKb \(up to the server maximum of 2000 kB, PENPOT_MCP_SUBTREE_MAX_REQUEST_KB\)/
    );
    assert.doesNotMatch(cut.note, /PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB/);
    // without the parameter the advice is the old one
    const plain = harness();
    servePage(plain.backend, page);
    let walkPlain: Walk | undefined;
    await withSubtreeCap("20", async () => {
        const again = harness();
        servePage(again.backend, page);
        walkPlain = await walkPage(again.tool, { encoding: "gzip-base64" });
    });
    const cutPlain = (walkPlain as Walk).replies.find((reply) => "oversize" in reply) as unknown as Reply & {
        note: string;
    };
    assert.match(cutPlain.note, /Raise PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB \(up to 10000\)/);
    assert.doesNotMatch(cutPlain.note, /maxResponseKb/);
});

test("the error of a shape that cannot fit even cut names maxResponseKb for a call that set it", async () => {
    const huge = { ...sizedShape(1, 300) };
    for (let n = 0; n < 4000; n++) {
        huge[`key${n}`] = randomBytes(6).toString("hex");
    }
    const { backend, tool } = harness();
    servePage(backend, [huge]);
    const asked = await tool.execute({ fileId: FILE, pageId: PAGE, encoding: "gzip-base64", maxResponseKb: 1 });
    assert.equal(asked.isError, true);
    assert.match(textOf(asked), /Raise maxResponseKb \(up to the server maximum of 2000 kB/);
    assert.doesNotMatch(textOf(asked), /PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB/);
});

test("maxResponseKb with filePath is refused with the filePath message, with or without encoding", async () => {
    const { backend, tool } = harness();
    servePage(backend, noisyPage(3));
    for (const encoding of [undefined, "gzip-base64"]) {
        const response = await tool.execute({
            fileId: FILE,
            pageId: PAGE,
            filePath: path.join(os.tmpdir(), "never.json"),
            maxResponseKb: 1000,
            ...(encoding === undefined ? {} : { encoding }),
        });
        assert.equal(response.isError, true);
        assert.match(textOf(response), /maxResponseKb cannot be used with filePath/, String(encoding));
    }
});

test("a server maximum below the default reply cap fails the tool at start; an unset one follows a raised default cap", async () => {
    // set below the default cap of 100 kB: refused
    assert.throws(
        () => ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: "50" }, 100_000),
        /PENPOT_MCP_SUBTREE_MAX_REQUEST_KB \(50 kB\) must not be below the default reply cap of 100 kB/
    );
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({ PENPOT_MCP_SUBTREE_MAX_REQUEST_KB: "100" }, 100_000), 100_000);
    // unset: 2000 kB, or the default cap when that is larger
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({}, 100_000), 2_000_000);
    assert.equal(ExportSubtreeTool.readRequestMaxBytes({}, 5_000_000), 5_000_000);
    // through the constructor and the environment
    await withSubtreeCap("300", async () => {
        await withRequestMax("200", async () => {
            assert.throws(() => harness(), /must not be below the default reply cap of 300 kB/);
        });
        await withRequestMax("300", async () => {
            assert.doesNotThrow(() => harness());
        });
    });
});
