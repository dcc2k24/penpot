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
    exportShape: Array<Record<string, unknown>>;
    uploadMediaUrl: Array<Record<string, unknown>>;
    uploadMediaData: Array<Record<string, unknown>>;
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
    exportShape(paramsJson: string): string;
    uploadMediaUrl(paramsJson: string): string;
    uploadMediaData(paramsJson: string): string;
}

/** A sandbox context with the prelude loaded, and the fake host it uses. */
interface Sandbox {
    host: FakeHost;
    context: vm.Context;
}

/**
 * Builds the page the fake host returns for every page id.
 *
 * The board B1 sits at x 100. Its children R1 and R2 are at absolute x 110 and 120, so R1 is at 10 relative to the
 * board. The backend and the bridge both use absolute coordinates for x, so the facade writes x as it is given.
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
                shapes: ["R1", "R2"],
                x: 100,
                y: 0,
                width: 200,
                height: 200,
                selrect: { x: 100, y: 0, width: 200, height: 200 },
            },
            {
                id: "R1",
                type: "rect",
                name: "Rectangle",
                parentId: "B1",
                frameId: "B1",
                shapes: [],
                x: 110,
                y: 10,
                width: 50,
                height: 50,
                fills: [],
            },
            {
                id: "R2",
                type: "rect",
                name: "Rectangle 2",
                parentId: "B1",
                frameId: "B1",
                shapes: [],
                x: 120,
                y: 20,
                width: 40,
                height: 40,
                fills: [],
                layoutItemMargin: { m1: 1, m2: 2, m3: 3, m4: 4 },
                pluginData: { "plugin/mcp": { owner: "ui" }, "shared/acme": { tag: "blue" } },
            },
        ],
    };
}

/**
 * Creates a fake host. Each `$tmp:` handle of a flush gets the next `uuid-N`, in order of appearance.
 *
 * @param tokenCatalogue - the catalogue that `get-mcp-tokens` returns
 * @returns the fake host with its call log
 */
function createFakeHost(tokenCatalogue: object): FakeHost {
    const calls: HostCalls = {
        loadFileOutline: [],
        loadPage: [],
        flush: [],
        importSvg: [],
        rpc: [],
        exportShape: [],
        uploadMediaUrl: [],
        uploadMediaData: [],
    };
    const uuids = new Map<string, string>();
    let revn = 1;
    const host: FakeHost = {
        calls,
        loadFileOutline(fileId: string): string {
            calls.loadFileOutline.push(fileId);
            return JSON.stringify({ id: fileId, name: "File", revn, pages: [{ id: "P1", name: "Page 1", index: 0 }] });
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
        exportShape(paramsJson: string): string {
            calls.exportShape.push(JSON.parse(paramsJson) as Record<string, unknown>);
            return JSON.stringify({ mimeType: "image/png", base64: "AQID" });
        },
        uploadMediaUrl(paramsJson: string): string {
            calls.uploadMediaUrl.push(JSON.parse(paramsJson) as Record<string, unknown>);
            return JSON.stringify({ id: "media-1", name: "pic", width: 4, height: 2, mtype: "image/png" });
        },
        uploadMediaData(paramsJson: string): string {
            calls.uploadMediaData.push(JSON.parse(paramsJson) as Record<string, unknown>);
            return JSON.stringify({ id: "media-2", name: "pic", width: 4, height: 2, mtype: "image/png" });
        },
        rpc(name: string, paramsJson: string): string {
            calls.rpc.push({ name, params: JSON.parse(paramsJson) });
            if (name === "get-mcp-tokens") {
                return JSON.stringify(tokenCatalogue);
            }
            return JSON.stringify({});
        },
    };
    return host;
}

/**
 * Creates a sandbox context with the prelude loaded.
 *
 * @param tokenCatalogue - the catalogue that `get-mcp-tokens` returns
 * @returns the fake host and the context
 */
function setup(tokenCatalogue: object = {}): Sandbox {
    const host = createFakeHost(tokenCatalogue);
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

test("createBoard then a name write sends one create_board that carries the new name", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.createBoard();
        board.name = "Hero";
        return board.name;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "Hero");
    assert.equal(host.calls.flush.length, 1);
    assert.deepEqual(host.calls.flush[0].operations, [
        {
            op: "create_board",
            pageId: "P1",
            id: "$tmp:s1",
            parentId: ROOT_ID,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            name: "Hero",
        },
    ]);
});

test("a fill write on a new rectangle goes into its create op", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.createRectangle();
        rect.fills = [{ fillColor: "#ff0000", fillOpacity: 1 }];
        `
    );
    assert.equal(envelope.ok, true);
    const operations = lastOperations(host);
    assert.deepEqual(
        operations.map((op) => op.op),
        ["create_rect"]
    );
    assert.deepEqual((operations[0].props as Record<string, unknown>).fills, [
        { fillColor: "#ff0000", fillOpacity: 1 },
    ]);
});

test("a fill write on an existing rectangle sends one update_shape with the fills", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `penpot.currentPage.getShapeById("R1").fills = [{ fillColor: "#ff0000", fillOpacity: 1 }];`
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "update_shape", pageId: "P1", id: "R1", props: { fills: [{ fillColor: "#ff0000", fillOpacity: 1 }] } },
    ]);
});

test("a border radius write sets all four corners in one op", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.createRectangle();
        rect.borderRadius = 8;
        return rect.borderRadius;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, 8);
    const updates = lastOperations(host).filter((op) => op.op === "update_shape");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].props, { r1: 8, r2: 8, r3: 8, r4: 8 });
});

test("x is absolute: the board is at 100 and R1 is at 110, so parentX is 10 and a write of x 10 stays 10", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.currentPage.getShapeById("R1");
        const before = rect.parentX;
        rect.x = 10;
        return { before: before, boardX: rect.boardX, x: rect.x };
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, { before: 10, boardX: -90, x: 10 });
    assert.deepEqual(lastOperations(host), [{ op: "update_shape", pageId: "P1", id: "R1", props: { x: 10 } }]);
});

test("appendChild of a new shape gives its create the board handle as parent", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.createBoard();
        const rect = penpot.createRectangle();
        board.appendChild(rect);
        `
    );
    assert.equal(envelope.ok, true);
    const operations = lastOperations(host);
    assert.deepEqual(
        operations.map((op) => op.op),
        ["create_board", "create_rect"]
    );
    assert.equal(operations[1].id, "$tmp:s2");
    assert.equal(operations[1].parentId, "$tmp:s1");
});

test("appendChild of a shape created before its new parent stays a move", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.createRectangle();
        const board = penpot.createBoard();
        board.appendChild(rect);
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host)[2], {
        op: "move_shapes",
        pageId: "P1",
        ids: ["$tmp:s1"],
        parentId: "$tmp:s2",
    });
});

test("the operation cap counts the queued ops after folding", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.createRectangle();
        for (let i = 0; i < 6000; i += 1) {
            rect.x = i;
        }
        return __core.summary().opCount;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, 1);
    const operations = lastOperations(host);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].x, 5999);
});

test("a fold leaves the props object of the create it extends unshared", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const props = { fills: [] };
        __core.enqueue({ op: "create_rect", pageId: "P1", id: "$tmp:a", x: 0, y: 0, width: 1, height: 1, props: props });
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "$tmp:a", props: { opacity: 0.5 } });
        return Object.keys(props);
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["fills"]);
    assert.deepEqual(lastOperations(host)[0].props, { fills: [], opacity: 0.5 });
});

test("bringToFront writes the new child order of the parent", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'penpot.currentPage.getShapeById("R1").bringToFront();');
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [{ op: "reorder", pageId: "P1", parentId: "B1", ids: ["R2", "R1"] }]);
});

test("findShapes with a type returns the rectangles as proxies", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const found = penpot.currentPage.findShapes({ type: "rectangle" });
        return found.map(function (shape) { return [shape.id, shape.type]; });
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [
        ["R1", "rectangle"],
        ["R2", "rectangle"],
    ]);
});

test("the Plugin type names map rect to rectangle and frame to board", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        return [penpot.currentPage.getShapeById("R1").type, penpot.currentPage.getShapeById("B1").type];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["rectangle", "board"]);
});

test("toJSON gives a plain object and JSON.stringify works on a proxy", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.currentPage.getShapeById("B1");
        return JSON.stringify([board, board.toJSON()]);
        `
    );
    assert.equal(envelope.ok, true);
    const [viaStringify, plain] = JSON.parse(envelope.result as string) as Array<Record<string, unknown>>;
    assert.deepEqual(viaStringify, plain);
    assert.equal(plain.id, "B1");
    assert.equal(plain.type, "board");
    assert.deepEqual(plain.children, ["R1", "R2"]);
});

test("an unknown id gives null from getShapeById", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpot.currentPage.getShapeById("missing") === null;');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, true);
});

test("selection cannot be set in backend mode", () => {
    const { context } = setup();
    const envelope = runScript(context, "penpot.selection = [];");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.message, "selection is not available in backend mode; pass explicit shape ids");
});

test("penpot.ui.open throws the typed-tools hint", () => {
    const { context } = setup();
    const envelope = runScript(context, 'penpot.ui.open("Plugin", "url");');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.message, "ui.open is not available in backend mode; use the typed tools");
});

test("shape.export asks the host for the rendered bytes of the shape", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        'const bytes = penpot.currentPage.getShapeById("R1").export({ type: "png", scale: 2 }); return [bytes.length, bytes[2]];'
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [3, 3]);
    assert.equal(host.calls.exportShape.length, 1);
    assert.deepEqual(host.calls.exportShape[0], {
        fileId: host.calls.exportShape[0].fileId,
        pageId: "P1",
        objectId: "R1",
        format: "png",
        scale: 2,
    });
});

test("a read-only shape property throws a TypeError that names the property", () => {
    const { context } = setup();
    const envelope = runScript(context, 'penpot.currentPage.getShapeById("R1").id = "other";');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.name, "TypeError");
    assert.match(envelope.error?.message ?? "", /^id is read-only/);
});

test("an unsupported property throws with its alternative", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpot.currentPage.getShapeById("B1").verticalMargin;');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.message, "verticalMargin is not available in backend mode; use shape.layoutChild");
});

test("flex of a shape without a flex layout is null", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpot.currentPage.getShapeById("B1").flex;');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, null);
});

test("the font list finds Roboto with its id", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpot.fonts.findByName("Roboto").id;');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "gfont-roboto");
});

test("utils.types.isBoard is true for a board and isRectangle for a rect", () => {
    const { context } = setup();
    const envelope = runScript(
        context,
        `
        const board = penpot.currentPage.getShapeById("B1");
        return [penpot.utils.types.isBoard(board), penpot.utils.types.isRectangle(board),
            penpot.utils.types.isRectangle(penpot.currentPage.getShapeById("R1"))];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [true, false, true]);
});

test("waitForLayoutUpdate flushes once in the middle of the script", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        penpot.createRectangle();
        const before = __host.calls.flush.length;
        penpot.waitForLayoutUpdate();
        return [before, __host.calls.flush.length];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [0, 1]);
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.flush[0].operations.length, 1);
});

test("penpotMgmt.listTeams calls the get-teams rpc with no parameters", () => {
    const { host, context } = setup();
    const envelope = runScript(context, "return penpotMgmt.listTeams();");
    assert.equal(envelope.ok, true);
    assert.deepEqual(host.calls.rpc, [{ name: "get-teams", params: {} }]);
});

test("a dotted layout margin write keeps the sibling margins of the stored object", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const shape = penpot.currentPage.getShapeById("R2");
        shape.topMargin = 9;
        return shape.topMargin;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, 9);
    assert.deepEqual(lastOperations(host), [
        { op: "update_shape", pageId: "P1", id: "R2", props: { layoutItemMargin: { m1: 9, m2: 2, m3: 3, m4: 4 } } },
    ]);
});

test("rotate adds the angle to the current rotation", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const rect = penpot.currentPage.getShapeById("R1");
        rect.rotate(15);
        return rect.rotation;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, 15);
    assert.deepEqual(lastOperations(host), [{ op: "update_shape", pageId: "P1", id: "R1", props: { rotation: 15 } }]);
});

test("clone queues clone_shape with a handle and returns its proxy", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'return penpot.currentPage.getShapeById("R1").clone().id;');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "$tmp:clone1");
    assert.deepEqual(lastOperations(host), [{ op: "clone_shape", pageId: "P1", id: "R1", newId: "$tmp:clone1" }]);
});

test("addFlexLayout writes the layout options at the top level of set_flex_layout", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        penpot.currentPage.getShapeById("B1").addFlexLayout({ dir: "column", rowGap: 8, verticalPadding: 4 });
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        {
            op: "set_flex_layout",
            pageId: "P1",
            id: "B1",
            layoutFlexDir: "column",
            layoutGap: { rowGap: 8 },
            layoutPadding: { p1: 4, p2: 0, p3: 4, p4: 0 },
        },
    ]);
});

test("group queues create_group over the child ids", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        penpot.group([penpot.currentPage.getShapeById("R1"), penpot.currentPage.getShapeById("R2")]);
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "create_group", pageId: "P1", id: "$tmp:s1", name: "Group", childIds: ["R1", "R2"] },
    ]);
});

test("createShapeFromSvg imports at the origin and returns null when the root is not on the page", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'return penpot.createShapeFromSvg("<svg/>");');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, null);
    assert.equal(host.calls.importSvg.length, 1);
    assert.deepEqual(host.calls.importSvg[0], { fileId: "F1", pageId: "P1", svg: "<svg/>", x: 0, y: 0 });
});

test("the current file lists its pages and validate gives an empty list for a valid file", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        penpot.createRectangle();
        return [penpot.currentFile.id, penpot.currentFile.pages.map(function (page) { return page.id; }),
            penpot.currentFile.validate()];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["F1", ["P1"], []]);
    assert.deepEqual(
        host.calls.flush.map((call) => call.dryRun),
        [true, false]
    );
});

test("the local library reads its colors through get-mcp-library, once per script", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const first = penpot.library.local.colors;
        const second = penpot.library.local.colors;
        return [first.length, second.length];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [0, 0]);
    assert.deepEqual(host.calls.rpc, [
        { name: "get-mcp-library", params: { fileId: "F1", kinds: ["colors", "typographies", "components"] } },
    ]);
});

/** A token catalogue with one set S1 and three tokens: a border radius, a spacing and a stroke width. */
const TOKEN_CATALOGUE = {
    sets: [{ id: "S1", name: "Core", active: true }],
    themes: [],
    tokens: [
        { id: "T1", setId: "S1", name: "radius.sm", type: "border-radius", value: 4 },
        { id: "T2", setId: "S1", name: "space.md", type: "spacing", value: 8 },
        { id: "T3", setId: "S1", name: "stroke.thin", type: "stroke-width", value: 1 },
    ],
    activeThemes: [],
    activeSets: ["S1"],
};

test("createColor queues create_color with a handle, then a setter queues update_color and remove queues delete_color", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const brand = penpot.library.local.createColor({ name: "Brand", color: "#ff8800", opacity: 1 });
        brand.name = "Brand 2";
        brand.remove();
        return brand.id;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "$tmp:color1");
    assert.deepEqual(lastOperations(host), [
        { op: "create_color", color: { id: "$tmp:color1", name: "Brand", color: "#ff8800", opacity: 1 } },
        { op: "update_color", color: { id: "$tmp:color1", name: "Brand 2" } },
        { op: "delete_color", id: "$tmp:color1" },
    ]);
});

test("createColor without options uses the name Color and the black paint that the schema needs", () => {
    const { host, context } = setup();
    const envelope = runScript(context, "penpot.library.local.createColor();");
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "create_color", color: { id: "$tmp:color1", name: "Color", color: "#000000" } },
    ]);
});

test("createTypography queues create_typography with the given fields, then a setter queues update_typography", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const body = penpot.library.local.createTypography({ name: "Body", fontFamily: "Inter", fontSize: "14" });
        body.fontWeight = "700";
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        {
            op: "create_typography",
            typography: { id: "$tmp:typography1", name: "Body", fontFamily: "Inter", fontSize: "14" },
        },
        { op: "update_typography", typography: { id: "$tmp:typography1", fontWeight: "700" } },
    ]);
});

test("applyToShapes sends the canonical name of borderRadiusTopLeft, which is r1", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        const radius = penpot.library.local.tokens.findByName("radius.sm");
        radius.applyToShapes([penpot.currentPage.getShapeById("R1")], ["borderRadiusTopLeft"]);
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host), [
        { op: "apply_token", pageId: "P1", shapeIds: ["R1"], tokenName: "radius.sm", attributes: ["r1"] },
    ]);
});

test("applyToken sends paddingLeft as p4, and all as the attributes of a spacing token", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        const space = penpot.library.local.tokens.findByName("space.md");
        const rect = penpot.currentPage.getShapeById("R1");
        rect.applyToken(space, ["paddingLeft"]);
        rect.applyToken(space, ["all"]);
        `
    );
    assert.equal(envelope.ok, true);
    // a token write flushes the ops queued before it, so the ops of this script are in more than one flush
    assert.deepEqual(
        host.calls.flush.flatMap((call) => call.operations),
        [
            { op: "apply_token", pageId: "P1", shapeIds: ["R1"], tokenName: "space.md", attributes: ["p4"] },
            {
                op: "apply_token",
                pageId: "P1",
                shapeIds: ["R1"],
                tokenName: "space.md",
                attributes: ["row-gap", "column-gap", "p1", "p2", "p3", "p4", "m1", "m2", "m3", "m4"],
            },
        ]
    );
});

test("applyToShapes expands strokeWidth to the four sides, as the Plugin frontend does", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        penpot.library.local.tokens.findByName("stroke.thin").applyToShapes(
            [penpot.currentPage.getShapeById("R1")], ["strokeWidth"]);
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(lastOperations(host)[0].attributes, [
        "stroke-width-top",
        "stroke-width-right",
        "stroke-width-bottom",
        "stroke-width-left",
    ]);
});

test("an unknown attribute name throws a TypeError that names it", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        penpot.currentPage.getShapeById("R1").applyToken(penpot.library.local.tokens.findByName("space.md"), ["notAnAttribute"]);
        `
    );
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.name, "TypeError");
    assert.equal(envelope.error?.message, "unknown token attribute notAnAttribute");
    assert.equal(host.calls.flush.length, 0);
});

test("addToken sends the internal type for a Plugin type name, and the token reads back the Plugin name", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        const token = penpot.library.local.tokens.sets[0].addToken({ type: "borderRadius", name: "radius.lg", value: 12 });
        return token.type;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "borderRadius");
    assert.deepEqual(lastOperations(host), [
        {
            op: "create_token",
            setId: "S1",
            id: "$tmp:token1",
            type: "border-radius",
            name: "radius.lg",
            value: 12,
        },
    ]);
});

test("a stored token reads back its Plugin type names, also when grouped by type", () => {
    const { context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        `
        const groups = penpot.library.local.tokens.sets[0].tokensByType;
        return [penpot.library.local.tokens.findByName("radius.sm").type, groups.map(function (group) { return group[0]; })];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["borderRadius", ["borderRadius", "spacing", "borderWidth"]]);
});

test("addToken with an unknown type throws a TypeError that lists the Plugin type names", () => {
    const { host, context } = setup(TOKEN_CATALOGUE);
    const envelope = runScript(
        context,
        'penpot.library.local.tokens.sets[0].addToken({ type: "widget", name: "x", value: 1 });'
    );
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.name, "TypeError");
    assert.match(envelope.error?.message ?? "", /^type must be one of boolean, borderRadius, .*, typography$/);
    assert.equal(host.calls.flush.length, 0);
});

test("setPluginData stores under plugin/mcp, and reads the same bucket back", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const shape = penpot.currentPage.getShapeById("R2");
        shape.setPluginData("note", "x");
        return [shape.getPluginData("owner"), shape.getPluginDataKeys()];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["ui", ["owner"]]);
    assert.deepEqual(lastOperations(host), [
        {
            op: "set_plugin_data",
            target: "shape",
            id: "R2",
            pageId: "P1",
            namespace: "plugin/mcp",
            key: "note",
            value: "x",
        },
    ]);
});

test("setSharedPluginData stores under shared/<namespace>, and reads the same bucket back", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const shape = penpot.currentPage.getShapeById("R2");
        shape.setSharedPluginData("acme", "size", "L");
        return [shape.getSharedPluginData("acme", "tag"), shape.getSharedPluginDataKeys("acme")];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["blue", ["tag"]]);
    assert.deepEqual(lastOperations(host), [
        {
            op: "set_plugin_data",
            target: "shape",
            id: "R2",
            pageId: "P1",
            namespace: "shared/acme",
            key: "size",
            value: "L",
        },
    ]);
});

test("setting flipX throws with the reason and the hint", () => {
    const { host, context } = setup();
    const envelope = runScript(context, 'penpot.currentPage.getShapeById("R1").flipX = true;');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.name, "TypeError");
    assert.equal(
        envelope.error?.message,
        "flipX is not supported in backend mode: no flip operation exists. The typed operations have no transform or " +
            "matrix op, so flipping needs a new operation; recreate the shape with the wanted geometry instead."
    );
    assert.equal(host.calls.flush.length, 0);
});

test("reading flipX does not throw", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return penpot.currentPage.getShapeById("R1").flipX;');
    assert.equal(envelope.ok, true);
});
