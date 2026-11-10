import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import type { ToolResponse } from "../../ToolResponse";
import { ExecuteCodeBackendArgs } from "./ExecuteCodeBackendTool";
import {
    FILE,
    PAGE,
    ROOT,
    disposeHarnesses,
    harness,
    opsOf,
    orderedPage,
    run,
    textOf,
    type FakeShape,
} from "./ExecuteCodeHarness";

const BOARD = "3d4e5f60-0000-4000-8000-0000000000c1";
const CHILD = "3d4e5f60-0000-4000-8000-0000000000c2";
const OTHER = "3d4e5f60-0000-4000-8000-0000000000c3";
const HIDDEN = "3d4e5f60-0000-4000-8000-0000000000c4";
const UNKNOWN = "3d4e5f60-0000-4000-8000-0000000000ff";

/** Shapes of the scenario page: two boards, each with one child. */
const SHAPES: FakeShape[] = [
    { id: BOARD, type: "frame", name: "Board A" },
    { id: CHILD, type: "rect", name: "Child", parentId: BOARD },
    { id: OTHER, type: "frame", name: "Board B" },
    { id: HIDDEN, type: "rect", name: "Hidden", parentId: OTHER },
];

after(() => disposeHarnesses());

/** Returns a fresh copy of the scenario shapes, since a write changes the shapes of the page it reaches. */
function shapesCopy(): FakeShape[] {
    return SHAPES.map((shape) => ({ ...shape }));
}

/**
 * Returns the result value of a successful script reply.
 *
 * @param response - the tool response
 * @returns the parsed `result` member
 */
function resultOf(response: ToolResponse): unknown {
    return (JSON.parse(textOf(response)) as { result: unknown }).result;
}

/**
 * Returns the parsed reply of a successful script.
 *
 * @param response - the tool response
 * @returns the parsed reply object
 */
function replyOf(response: ToolResponse): { warnings: unknown[] } {
    return JSON.parse(textOf(response)) as { warnings: unknown[] };
}

test("rootIds without pageId is refused before any page is read", async () => {
    const { backend, tool } = harness({ shapes: shapesCopy() });
    const response = await tool.execute({ code: "return 1;", fileId: FILE, rootIds: [BOARD] });

    assert.equal(response.isError, true);
    assert.match(textOf(response), /rootIds needs pageId/);
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
});

test("the schema takes one to twenty root ids and does not require pageId", () => {
    const schema = z.object(ExecuteCodeBackendArgs.schema);
    assert.equal(schema.safeParse({ code: "return 1;", fileId: FILE, rootIds: [] }).success, false);
    assert.equal(
        schema.safeParse({ code: "return 1;", fileId: FILE, pageId: PAGE, rootIds: Array(21).fill(BOARD) }).success,
        false
    );
    assert.equal(
        schema.safeParse({ code: "return 1;", fileId: FILE, pageId: PAGE, rootIds: Array(20).fill(BOARD) }).success,
        true
    );
    assert.equal(schema.safeParse({ code: "return 1;", fileId: FILE, rootIds: [BOARD] }).success, true);
});

test("findShapes sees only the shapes under the roots", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(tool, "return penpot.currentPage.findShapes().map((shape) => shape.name);", {
        pageId: PAGE,
        rootIds: [BOARD],
    });

    assert.notEqual(response.isError, true);
    assert.deepEqual(resultOf(response), ["Board A", "Child"]);
});

test("penpot.root.children lists only the loaded shapes", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(tool, "return penpot.root.children.map((shape) => shape.name);", {
        pageId: PAGE,
        rootIds: [BOARD],
    });

    assert.deepEqual(resultOf(response), ["Board A"]);
});

test("a script that changes a loaded shape under a root emits the update and succeeds", async () => {
    const { backend, tool } = harness({ shapes: shapesCopy() });
    const response = await run(
        tool,
        `const child = penpot.currentPage.getShapeById("${CHILD}");
         child.name = "Renamed";
         return child.name;`,
        { pageId: PAGE, rootIds: [BOARD] }
    );

    assert.notEqual(response.isError, true);
    assert.equal(resultOf(response), "Renamed");
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1);
    const updates = opsOf(writes[0]).filter((operation) => operation.op === "update_shape");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, CHILD);
    assert.deepEqual(updates[0].props, { name: "Renamed" });
});

test("the reply carries the partial-page warning with the roots and the loaded shape count", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(tool, "return penpot.currentPage.findShapes().length;", {
        pageId: PAGE,
        rootIds: [BOARD],
    });

    assert.deepEqual(replyOf(response).warnings, [
        { code: "partial-page", pageId: PAGE, rootIds: [BOARD], shapes: 2, ancestors: [] },
    ]);
});

test("a shape the script creates and flushes under the page root is loaded again with the roots", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(
        tool,
        `const rect = penpot.createRectangle();
         rect.name = "Fresh";
         penpot.waitForLayoutUpdate();
         return penpot.currentPage.findShapes().map((shape) => shape.name);`,
        { pageId: PAGE, rootIds: [BOARD] }
    );

    assert.notEqual(response.isError, true);
    assert.deepEqual(resultOf(response), ["Board A", "Child", "Fresh"]);
});

test("without rootIds the whole page loads and no partial-page warning is given", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(tool, "return penpot.currentPage.findShapes().map((shape) => shape.name);", {
        pageId: PAGE,
    });

    assert.deepEqual(resultOf(response), ["Board A", "Child", "Board B", "Hidden"]);
    assert.deepEqual(replyOf(response).warnings, []);
});

test("an unknown root fails the call and names the id", async () => {
    const { tool } = harness({ shapes: shapesCopy() });
    const response = await run(tool, "return penpot.currentPage.findShapes().length;", {
        pageId: PAGE,
        rootIds: [UNKNOWN],
    });

    assert.equal(response.isError, true);
    assert.match(textOf(response), new RegExp(`root shape ${UNKNOWN} is not a shape of page`));
});

/**
 * Builds the id of a shape of the order-keeping page from a number.
 *
 * @param n - the number of the shape
 * @returns a uuid
 */
function uid(n: number): string {
    return "3d4e5f60-0000-4000-8000-" + n.toString(16).padStart(12, "0");
}

const X = uid(0xe1);
const A = uid(0xe2);
const A1 = uid(0xe3);
const A2 = uid(0xe4);
const Y = uid(0xe5);
const B = uid(0xe6);
const B1 = uid(0xe7);
const G = uid(0xe8);
const G1 = uid(0xe9);
const G2 = uid(0xea);
const G3 = uid(0xeb);
/** Page (bottom to top): X, A[a1, a2], Y, B[b1], G[g1[g2], g3]. */
const ORDERED: FakeShape[] = [
    { id: X, type: "frame", name: "X" },
    { id: A, type: "frame", name: "A" },
    { id: A1, type: "rect", name: "a1", parentId: A },
    { id: A2, type: "rect", name: "a2", parentId: A },
    { id: Y, type: "frame", name: "Y" },
    { id: B, type: "frame", name: "B" },
    { id: B1, type: "rect", name: "b1", parentId: B },
    { id: G, type: "frame", name: "G" },
    { id: G1, type: "frame", name: "g1", parentId: G },
    { id: G2, type: "rect", name: "g2", parentId: G1 },
    { id: G3, type: "rect", name: "g3", parentId: G },
];

/** The refusal text of an operation under a partial parent, for the given operation and parent name. */
function refusal(operation: string, parent: string): RegExp {
    return new RegExp(
        `${operation} needs every child of ${parent}, and rootIds did not load them all\\. ` +
            "Add that shape's id to rootIds, or run without rootIds\\."
    );
}

test("the delete-empty-boards cleanup neither sees nor deletes an ancestor of a root", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpot.currentPage.getShapeById("${G2}").remove();
         const removed = [];
         for (const b of penpot.currentPage.findShapes({ type: "board" })) {
             if (b.children.length === 0) { removed.push(b.name); b.remove(); }
         }
         penpot.waitForLayoutUpdate();
         return removed;`,
        { pageId: PAGE, rootIds: [G2] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), []);
    assert.ok(page.records.has(G) && page.records.has(G1), "an ancestor was deleted");
});

test("insertChild with an index under a partial parent is refused, and nothing is sent", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpot.root.insertChild(0, penpot.currentPage.getShapeById("${A}")); return "ok";`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.equal(response.isError, true);
    assert.match(textOf(response), refusal("insertChild", "Root"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("bringToFront under a partial parent is refused, and nothing is sent", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(tool, `penpot.currentPage.getShapeById("${A}").bringToFront(); return "ok";`, {
        pageId: PAGE,
        rootIds: [A],
    });

    assert.equal(response.isError, true);
    assert.match(textOf(response), refusal("bringToFront", "Root"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("the same operations under a fully loaded parent inside a root work and send the right operation", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const moved = await run(
        tool,
        `penpot.currentPage.getShapeById("${G}").insertChild(0, penpot.currentPage.getShapeById("${G3}"));
         penpot.waitForLayoutUpdate();
         return penpot.currentPage.getShapeById("${G}").children.map((s) => s.name);`,
        { pageId: PAGE, rootIds: [G] }
    );
    assert.notEqual(moved.isError, true, textOf(moved));
    assert.deepEqual(resultOf(moved), ["g3", "g1"]);
    const moves = opsOf(backend.callsTo("mcp-apply-operations")[0]).filter((op) => op.op === "move_shapes");
    assert.deepEqual(
        moves.map((op) => [op.parentId, op.index, op.ids]),
        [[G, 0, [G3]]]
    );

    const front = await run(tool, `penpot.currentPage.getShapeById("${G1}").bringToFront(); return "ok";`, {
        pageId: PAGE,
        rootIds: [G],
    });
    assert.notEqual(front.isError, true, textOf(front));
    const reorders = backend
        .callsTo("mcp-apply-operations")
        .flatMap((call) => opsOf(call))
        .filter((op) => op.op === "reorder");
    assert.deepEqual(
        reorders.map((op) => [op.parentId, op.ids]),
        [[G, [G3, G1]]]
    );
});

test("appendChild into a partial parent works and sends no index", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpot.root.appendChild(penpot.currentPage.getShapeById("${A1}")); return "ok";`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    const moves = opsOf(backend.callsTo("mcp-apply-operations")[0]).filter((op) => op.op === "move_shapes");
    assert.equal(moves.length, 1);
    assert.equal(moves[0].parentId, ROOT);
    assert.equal("index" in moves[0], false);
});

test("removing a root and then reading works", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpot.currentPage.getShapeById("${A}").remove();
         penpot.waitForLayoutUpdate();
         return penpot.currentPage.findShapes().map((s) => s.name);`,
        { pageId: PAGE, rootIds: [A, B] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), ["B", "b1"]);
});

test("a pageId that the file does not hold fails the call before anything loads", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(tool, "return 1;", { pageId: uid(0x999), rootIds: [A] });

    assert.equal(response.isError, true);
    assert.match(textOf(response), new RegExp(`pageId ${uid(0x999)} is not a page of file`));
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
});

test("createShapeFromSvg under rootIds returns the imported shape", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `const s = penpot.createShapeFromSvg("<svg/>"); return s === null ? "NULL" : s.name;`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.equal(resultOf(response), "Svg");
});

test("a shape moved out of its root keeps its name after the flush", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `const c = penpot.currentPage.getShapeById("${A1}");
         penpot.root.appendChild(c);
         penpot.waitForLayoutUpdate();
         return penpot.currentPage.getShapeById("${A1}").name;`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.equal(resultOf(response), "a1");
});

test("a truncated shapes reply still loads both roots", async () => {
    const page = orderedPage(ORDERED, { shapeReplyLimit: 2 });
    const { tool } = harness({ responses: page.responses });
    const response = await run(tool, "return penpot.currentPage.findShapes().map((s) => s.name);", {
        pageId: PAGE,
        rootIds: [A, B],
    });

    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), ["A", "a1", "a2", "B", "b1"]);
});

test("21 roots are refused by the host, and the call says the limit", async () => {
    const { tool, backend } = harness({ responses: orderedPage(ORDERED).responses });
    const rootIds = Array.from({ length: 21 }, (_, index) => uid(0x100 + index));
    const response = await run(tool, "return 1;", { pageId: PAGE, rootIds });

    assert.equal(response.isError, true);
    assert.match(textOf(response), /1 to 20 rootIds/);
    assert.equal(backend.callsTo("get-mcp-page-tree").length, 0);
});

test("a direct __host.loadPage from script code cannot change the roots of the call", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `const t = __host.loadPage(${JSON.stringify(FILE)}, ${JSON.stringify(PAGE)}, ${JSON.stringify(
            JSON.stringify([B, G])
        )});
         return JSON.parse(t).shapes.map((s) => s.name);`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), ["Root", "A", "a1", "a2"]);
});

test("a chain 25 deep below a root loads all 25 shapes", async () => {
    const chain: FakeShape[] = [{ id: uid(0x200), type: "frame", name: "top" }];
    for (let level = 0; level < 24; level += 1) {
        chain.push({ id: uid(0x201 + level), type: "rect", name: `c${level}`, parentId: uid(0x200 + level) });
    }
    const page = orderedPage(chain);
    const { tool } = harness({ responses: page.responses });
    const response = await run(tool, "return penpot.currentPage.findShapes().length;", {
        pageId: PAGE,
        rootIds: [uid(0x200)],
    });

    assert.notEqual(response.isError, true, textOf(response));
    assert.equal(resultOf(response), 25);
});

test("an interaction that points outside the roots reads as a placeholder with its id", async () => {
    const shapes = ORDERED.map((shape) =>
        shape.id === A1
            ? { ...shape, interactions: [{ eventType: "click", actionType: "navigate", destination: B }] }
            : shape
    );
    const page = orderedPage(shapes);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `const d = penpot.currentPage.getShapeById("${A1}").interactions[0].action.destination;
         return [d.id, d.loaded];`,
        { pageId: PAGE, rootIds: [A] }
    );

    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), [B, false]);

    const read = await run(
        tool,
        `return penpot.currentPage.getShapeById("${A1}").interactions[0].action.destination.name;`,
        { pageId: PAGE, rootIds: [A] }
    );
    assert.equal(read.isError, true);
    assert.match(textOf(read), /is not loaded: rootIds loads only the given subtrees/);
});

test("the partial-page warning carries the final count of loaded shapes and the ancestors", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(tool, "return penpot.currentPage.findShapes().length;", {
        pageId: PAGE,
        rootIds: [G2],
    });

    assert.deepEqual(replyOf(response).warnings, [
        { code: "partial-page", pageId: PAGE, rootIds: [G2], shapes: 1, ancestors: [G1, G] },
    ]);
});

test("a partly loaded parent refuses remove, and childrenPartial tells the two apart", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const removal = await run(tool, `penpot.currentPage.getShapeById("${G}").remove(); return "ok";`, {
        pageId: PAGE,
        rootIds: [G2],
    });
    assert.equal(removal.isError, true);
    assert.match(textOf(removal), refusal("remove", "G"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);

    const flags = await run(
        tool,
        `return [penpot.root.childrenPartial, penpot.currentPage.getShapeById("${A}").childrenPartial];`,
        { pageId: PAGE, rootIds: [A] }
    );
    assert.deepEqual(resultOf(flags), [true, false]);
});

test("the other operations that read or change the order of children refuse a partly loaded parent", async () => {
    const cases: Array<[string, string]> = [
        ["parentIndex", `return penpot.currentPage.getShapeById("${G1}").parentIndex;`],
        ["setParentIndex", `penpot.currentPage.getShapeById("${G1}").setParentIndex(0); return "ok";`],
        ["bringForward", `penpot.currentPage.getShapeById("${G1}").bringForward(); return "ok";`],
        ["sendBackward", `penpot.currentPage.getShapeById("${G1}").sendBackward(); return "ok";`],
        ["ungroup", `penpot.ungroup(penpot.currentPage.getShapeById("${G}")); return "ok";`],
        ["flatten", `penpot.flatten([penpot.currentPage.getShapeById("${G}")]); return "ok";`],
    ];
    for (const [operation, code] of cases) {
        const page = orderedPage(ORDERED);
        const { tool, backend } = harness({ responses: page.responses });
        const response = await run(tool, code, { pageId: PAGE, rootIds: [G2] });

        assert.equal(response.isError, true, operation);
        assert.match(textOf(response), refusal(operation, "G"), operation);
        assert.equal(backend.callsTo("mcp-apply-operations").length, 0, operation);
    }
});

const S = uid(0xf1);
const T = uid(0xf2);
const R = uid(0xf3);
const U = uid(0xf4);
/** Page with one top-level shape S, which holds T, which holds R and U. */
const CHAIN: FakeShape[] = [
    { id: S, type: "frame", name: "S" },
    { id: T, type: "group", name: "T", parentId: S },
    { id: R, type: "rect", name: "R", parentId: T },
    { id: U, type: "rect", name: "U", parentId: T },
];

test("an ancestor whose loaded children are all ancestors is partial, and its remove is refused", async () => {
    const page = orderedPage(CHAIN);
    const { tool, backend } = harness({ responses: page.responses });
    const flags = await run(
        tool,
        `const t = penpot.currentPage.getShapeById("${R}").parent;
         const s = t.parent;
         return [s.name, s.childrenPartial, t.name, t.childrenPartial];`,
        { pageId: PAGE, rootIds: [R] }
    );
    assert.notEqual(flags.isError, true, textOf(flags));
    assert.deepEqual(resultOf(flags), ["S", true, "T", true]);

    const removal = await run(tool, `penpot.currentPage.getShapeById("${T}").remove(); return "ok";`, {
        pageId: PAGE,
        rootIds: [R],
    });
    assert.equal(removal.isError, true);
    assert.match(textOf(removal), refusal("remove", "T"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("the root children and the walks reach a nested root through the ancestors", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `return {
            kids: penpot.root.children.map((s) => s.name),
            found: penpotUtils.findShapes(() => true, penpot.root).map((s) => s.name),
            byId: penpotUtils.findShapeById("${G2}") ? penpotUtils.findShapeById("${G2}").name : "NONE",
            rootPartial: penpot.root.childrenPartial,
        };`,
        { pageId: PAGE, rootIds: [G2] }
    );
    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), { kids: ["G"], found: ["g2"], byId: "g2", rootPartial: true });
});

test("shapeStructure of the page root shows the path to the root, marked childrenPartial", async () => {
    const page = orderedPage(ORDERED);
    const { tool } = harness({ responses: page.responses });
    const response = await run(tool, `return penpotUtils.shapeStructure(penpot.root, 5);`, {
        pageId: PAGE,
        rootIds: [G2],
    });
    assert.notEqual(response.isError, true, textOf(response));
    const structure = resultOf(response) as any;
    const g = structure.children[0];
    assert.equal(g.name, "G");
    assert.equal(g.childrenPartial, true);
    assert.equal(g.children[0].name, "g1");
    assert.equal(g.children[0].childrenPartial, true);
    assert.equal(g.children[0].children[0].name, "g2");
});

test("a placeholder that a result holds serialises as its id and loaded false", async () => {
    const shapes = ORDERED.map((shape) =>
        shape.id === A1
            ? { ...shape, interactions: [{ eventType: "click", actionType: "navigate", destination: B }] }
            : shape
    );
    const page = orderedPage(shapes);
    const { tool } = harness({ responses: page.responses });
    const direct = await run(
        tool,
        `return penpot.currentPage.getShapeById("${A1}").interactions[0].action.destination;`,
        { pageId: PAGE, rootIds: [A] }
    );
    assert.notEqual(direct.isError, true, textOf(direct));
    assert.deepEqual(resultOf(direct), { id: B, loaded: false });

    const list = await run(tool, `return penpot.currentPage.getShapeById("${A1}").interactions;`, {
        pageId: PAGE,
        rootIds: [A],
    });
    assert.notEqual(list.isError, true, textOf(list));
    assert.deepEqual((resultOf(list) as any[])[0].action.destination, { id: B, loaded: false });
});

test("relativeTo of an interaction outside the roots is a placeholder", async () => {
    const shapes = ORDERED.map((shape) =>
        shape.id === A1
            ? {
                  ...shape,
                  interactions: [
                      { eventType: "click", actionType: "open-overlay", destination: A2, positionRelativeTo: B },
                  ],
              }
            : shape
    );
    const page = orderedPage(shapes);
    const { tool } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `return penpot.currentPage.getShapeById("${A1}").interactions[0].action.relativeTo;`,
        { pageId: PAGE, rootIds: [A] }
    );
    assert.notEqual(response.isError, true, textOf(response));
    assert.deepEqual(resultOf(response), { id: B, loaded: false });
});

test("addFlexLayout on a partly loaded board sends nothing and throws the refusal", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpotUtils.addFlexLayout(penpot.currentPage.getShapeById("${G}"), "row"); return "ok";`,
        { pageId: PAGE, rootIds: [G3] }
    );
    assert.equal(response.isError, true);
    assert.match(textOf(response), refusal("addFlexLayout", "G"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("moving an ancestor stub is refused with the operation named, and nothing is sent", async () => {
    const page = orderedPage(ORDERED);
    const { tool, backend } = harness({ responses: page.responses });
    const response = await run(
        tool,
        `penpot.root.appendChild(penpot.currentPage.getShapeById("${G1}")); return "ok";`,
        { pageId: PAGE, rootIds: [G2] }
    );
    assert.equal(response.isError, true);
    assert.match(textOf(response), refusal("insertChild", "g1"));
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});
