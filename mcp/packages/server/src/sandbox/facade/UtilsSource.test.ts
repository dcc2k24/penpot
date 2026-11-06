import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { Prelude } from "../Prelude";

/** Root frame id of every page. */
const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Result envelope of `__runScript`. */
interface Envelope {
    ok: boolean;
    result?: unknown;
    undefinedResult?: boolean;
    error?: { name: string; message: string; stack: string | null };
    log: string;
}

/** One `__host.flush` call as the fake host received it. */
interface FlushCall {
    fileId: string;
    operations: Array<Record<string, unknown>>;
    dryRun: boolean;
}

/** Calls received by the fake host, in order. */
interface HostCalls {
    loadFileOutline: string[];
    loadPage: Array<{ fileId: string; pageId: string }>;
    flush: FlushCall[];
    importSvg: Array<Record<string, unknown>>;
    rpc: Array<{ name: string; params: unknown }>;
}

/** Synchronous stand-in for the host primitives of the sandbox. */
interface FakeHost {
    /** Calls received so far. */
    readonly calls: HostCalls;
    loadFileOutline(fileId: string): string;
    loadPage(fileId: string, pageId: string): string;
    flush(fileId: string, operationsJson: string, dryRun: boolean): string;
    importSvg(paramsJson: string): string;
    rpc(name: string, paramsJson: string): string;
}

/** A sandbox context with the prelude loaded, and the fake host it uses. */
interface Sandbox {
    host: FakeHost;
    context: vm.Context;
}

/**
 * Builds the page the fake host returns for every page id.
 *
 * The board B1 sits at (100, 100) and is 200 by 200. Its children are the rectangle R1 and the group G1, and G1 holds
 * the ellipse E1. Coordinates are absolute, as the backend and the bridge use them.
 *
 * @returns the page as the backend describes it, before JSON encoding
 */
function pageFixture(): object {
    return {
        revn: 1,
        shapes: [
            {
                id: ROOT_ID,
                type: "frame",
                name: "Root",
                parentId: null,
                frameId: null,
                shapes: ["B1"],
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            {
                id: "B1",
                type: "frame",
                name: "Hero board",
                parentId: ROOT_ID,
                frameId: ROOT_ID,
                shapes: ["R1", "G1"],
                x: 100,
                y: 100,
                width: 200,
                height: 200,
                selrect: { x: 100, y: 100, width: 200, height: 200 },
            },
            {
                id: "R1",
                type: "rect",
                name: "Rectangle",
                parentId: "B1",
                frameId: "B1",
                shapes: [],
                x: 110,
                y: 110,
                width: 50,
                height: 50,
                fills: [],
            },
            {
                id: "G1",
                type: "group",
                name: "Group",
                parentId: "B1",
                frameId: "B1",
                shapes: ["E1"],
                x: 150,
                y: 150,
                width: 40,
                height: 40,
            },
            {
                id: "E1",
                type: "circle",
                name: "Ellipse",
                parentId: "G1",
                frameId: "B1",
                shapes: [],
                x: 160,
                y: 160,
                width: 20,
                height: 20,
                fills: [],
            },
        ],
    };
}

/**
 * Creates a fake host. Each `$tmp:` handle of a flush gets the next `uuid-N`, in order of appearance.
 *
 * @param pageIds - ids of the pages of the file, in order; every page returns the same fixture
 * @returns the fake host with its call log
 */
function createFakeHost(pageIds: string[] = ["P1"]): FakeHost {
    const calls: HostCalls = { loadFileOutline: [], loadPage: [], flush: [], importSvg: [], rpc: [] };
    const uuids = new Map<string, string>();
    let revn = 1;
    const host: FakeHost = {
        calls,
        loadFileOutline(fileId: string): string {
            calls.loadFileOutline.push(fileId);
            const pages = pageIds.map((id, index) => ({ id, name: "Page " + String(index + 1), index }));
            return JSON.stringify({ id: fileId, name: "File", revn, pages });
        },
        loadPage(fileId: string, pageId: string): string {
            calls.loadPage.push({ fileId, pageId });
            return JSON.stringify({ ...pageFixture(), revn, pageId, fileId });
        },
        flush(fileId: string, operationsJson: string, dryRun: boolean): string {
            const operations = JSON.parse(operationsJson) as Array<Record<string, unknown>>;
            calls.flush.push({ fileId, operations, dryRun });
            const createdIds: Record<string, string> = {};
            for (const op of operations) {
                for (const value of Object.values(op)) {
                    const items: unknown[] = Array.isArray(value) ? value : [value];
                    for (const item of items) {
                        if (typeof item === "string" && item.startsWith("$tmp:")) {
                            let uuid = uuids.get(item);
                            if (uuid === undefined) {
                                uuid = "uuid-" + String(uuids.size + 1);
                                uuids.set(item, uuid);
                            }
                            createdIds[item] = uuid;
                        }
                    }
                }
            }
            if (!dryRun) {
                revn += 1;
            }
            return JSON.stringify({
                revn,
                createdIds,
                changeCount: operations.length,
                warnings: [],
                validation: { ok: true },
                dryRun,
            });
        },
        importSvg(paramsJson: string): string {
            calls.importSvg.push(JSON.parse(paramsJson) as Record<string, unknown>);
            return JSON.stringify({ revn, rootId: "uuid-svg", shapeIds: [] });
        },
        rpc(name: string, paramsJson: string): string {
            calls.rpc.push({ name, params: JSON.parse(paramsJson) });
            return JSON.stringify({});
        },
    };
    return host;
}

/**
 * Creates a sandbox context with the prelude loaded.
 *
 * @param pageIds - ids of the pages of the file, in order
 * @returns the fake host and the context
 */
function setup(pageIds: string[] = ["P1"]): Sandbox {
    const host = createFakeHost(pageIds);
    const context = vm.createContext({ __host: host });
    vm.runInContext(Prelude.build(), context);
    return { host, context };
}

/**
 * Runs one script through `__runScript`. The code and ids reach the guest as context variables.
 *
 * @param context - sandbox context
 * @param code - user code of the script
 * @param fileId - current file
 * @param pageId - current page
 * @returns the parsed envelope
 */
function runScript(context: vm.Context, code: string, fileId = "F1", pageId = "P1"): Envelope {
    Object.assign(context, { __code: code, __fileId: fileId, __pageId: pageId });
    const text = vm.runInContext("__runScript(__code, __fileId, __pageId)", context) as string;
    return JSON.parse(text) as Envelope;
}

/**
 * Returns the operations of the end-of-script flush, which holds every queued op of a script that does not flush.
 *
 * @param host - fake host with its call log
 * @returns the operations of the last flush
 */
function lastOperations(host: FakeHost): Array<Record<string, unknown>> {
    return host.calls.flush[host.calls.flush.length - 1].operations;
}

test("findShapes with a type predicate returns the rectangle and the ellipse in tree order", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        return penpotUtils.findShapes(function (shape) {
            return shape.type === "rectangle" || shape.type === "ellipse";
        }).map(function (shape) { return shape.id; });
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["R1", "E1"]);
});

test("findShape returns the first shape of the type in tree order", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        return penpotUtils.findShape(function (shape) { return shape.type === "group"; }).id;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "G1");
});

test("findShapes without a root searches the current page only, and an explicit root searches under that shape", () => {
    // both pages return the same fixture, so a search of every page would return R1 and E1 twice
    const { context } = setup(["P1", "P2"]);
    const envelope = runScript(
        context,
        `
        const isShape = function (shape) {
            return shape.type === "rectangle" || shape.type === "ellipse";
        };
        const ids = function (shapes) { return shapes.map(function (shape) { return shape.id; }); };
        return [
            ids(penpotUtils.findShapes(isShape)),
            ids(penpotUtils.findShapes(isShape, null)),
            ids(penpotUtils.findShapes(function () { return true; }, penpot.currentPage.getShapeById("B1")))
        ];
        `,
        "F1",
        "P1"
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [
        ["R1", "E1"],
        ["R1", "E1"],
        ["R1", "G1", "E1"],
    ]);
});

test("shapeStructure returns the nested board with the names and the plugin types", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpotUtils.shapeStructure(penpot.currentPage.getShapeById("B1"));');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, {
        id: "B1",
        name: "Hero board",
        type: "board",
        children: [
            { id: "R1", name: "Rectangle", type: "rectangle", children: [] },
            {
                id: "G1",
                name: "Group",
                type: "group",
                children: [{ id: "E1", name: "Ellipse", type: "ellipse", children: [] }],
            },
        ],
    });
});

test("shapeStructure with a depth of 1 gives the children of the board without their children, as JSON", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpotUtils.shapeStructure(penpot.currentPage.getShapeById("B1"), 1);');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, {
        id: "B1",
        name: "Hero board",
        type: "board",
        children: [
            { id: "R1", name: "Rectangle", type: "rectangle" },
            { id: "G1", name: "Group", type: "group" },
        ],
    });
});

test("getBounds of the board returns its x, y, width and height", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpotUtils.getBounds(penpot.currentPage.getShapeById("B1"));');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, { x: 100, y: 100, width: 200, height: 200 });
});

test("findShapeById returns a proxy whose name is the ellipse name, and null for a missing id", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const found = penpotUtils.findShapeById("E1");
        return [found.name, penpotUtils.findShapeById("missing")];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["Ellipse", null]);
});

test("getPages lists the pages, and the page lookups match by id and by case-insensitive name", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        return [
            penpotUtils.getPages(),
            penpotUtils.getPageByName("PAGE 1").id,
            penpotUtils.getPageById("missing")
        ];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [[{ id: "P1", name: "Page 1" }], "P1", null]);
});

test("isContainedIn is true for the rectangle inside the board and false the other way round", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.currentPage.getShapeById("B1");
        const rect = penpot.currentPage.getShapeById("R1");
        return [penpotUtils.isContainedIn(rect, board), penpotUtils.isContainedIn(board, rect)];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [true, false]);
});

test("setParentXY writes the absolute x and y from the parent position and the given offsets", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'penpotUtils.setParentXY(penpot.currentPage.getShapeById("R1"), 5, 7);');
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "update_shape", pageId: "P1", id: "R1", props: { x: 105 } },
        { op: "update_shape", pageId: "P1", id: "R1", props: { y: 107 } },
    ]);
});

test("addFlexLayout adds the layout with the direction and moves the children in visual order", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'penpotUtils.addFlexLayout(penpot.currentPage.getShapeById("B1"), "row");');
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "set_flex_layout", pageId: "P1", id: "B1", layoutFlexDir: "row" },
        { op: "move_shapes", pageId: "P1", ids: ["R1"], parentId: "B1", index: 0 },
        { op: "move_shapes", pageId: "P1", ids: ["G1"], parentId: "B1", index: 0 },
    ]);
});

test("analyzeDescendants keeps the non-null results of the descendants, and a depth of 1 stops at the children", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.currentPage.getShapeById("B1");
        const evaluate = function (root, shape) { return shape.type === "ellipse" ? shape.name : null; };
        const all = penpotUtils.analyzeDescendants(board, evaluate).map(function (entry) {
            return [entry.shape.id, entry.result];
        });
        const shallow = penpotUtils.analyzeDescendants(board, evaluate, 1);
        return [all, shallow.length];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [[["E1", "Ellipse"]], 0]);
});

test("generateCss and createVariantContainer throw with the backend-mode message", () => {
    const { context } = setup();
    const api = vm.runInContext("penpotUtils", context) as Record<string, (...args: unknown[]) => unknown>;
    assert.throws(() => api.exportImage(null, "bogus"), {
        name: "Error",
        message: "Unsupported export mode: bogus",
    });
    for (const name of ["generateCss", "createVariantContainer"]) {
        assert.throws(() => api[name](), {
            name: "Error",
            message: new RegExp("^penpotUtils\\." + name + " is not available in backend mode; "),
        });
    }
});
