import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchTreeExpander, type BatchNode } from "./BatchTreeExpander";

const PAGE = "3f2c1a9e-0b7d-4c1e-9a55-2d6f0e8b7c10";
const PARENT = "7a1d4e2b-5c6f-4d8a-8b9c-0e1f2a3b4c5d";
const expander = new BatchTreeExpander();

test("expands a nested tree into create operations with handles numbered depth-first", () => {
    const tree: BatchNode[] = [
        {
            type: "board",
            name: "Card",
            x: 0,
            y: 0,
            width: 320,
            height: 200,
            children: [
                { type: "rect", x: 16, y: 16, width: 288, height: 168 },
                { type: "text", name: "Title", x: 32, y: 32, width: 200, height: 24, characters: "Hello" },
            ],
        },
        { type: "ellipse", x: 400, y: 0, width: 40, height: 40 },
    ];
    const result = expander.expand(PAGE, undefined, tree);
    assert.deepEqual(
        result.nodes.map((node) => node.handle),
        ["$tmp:n0", "$tmp:n1", "$tmp:n2", "$tmp:n3"]
    );
    assert.deepEqual(result.operations, [
        { op: "create_board", pageId: PAGE, id: "$tmp:n0", x: 0, y: 0, width: 320, height: 200, name: "Card" },
        { op: "create_rect", pageId: PAGE, id: "$tmp:n1", parentId: "$tmp:n0", x: 16, y: 16, width: 288, height: 168 },
        {
            op: "create_text",
            pageId: PAGE,
            id: "$tmp:n2",
            parentId: "$tmp:n0",
            x: 32,
            y: 32,
            width: 200,
            height: 24,
            name: "Title",
            characters: "Hello",
        },
        { op: "create_ellipse", pageId: PAGE, id: "$tmp:n3", x: 400, y: 0, width: 40, height: 40 },
    ]);
});

test("root nodes take the given parent, and the handles of their children point to them", () => {
    const result = expander.expand(PAGE, PARENT, [
        {
            type: "rect",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            children: [{ type: "circle", x: 0, y: 0, width: 1, height: 1 }],
        },
    ]);
    assert.equal(result.operations[0].parentId, PARENT);
    assert.equal(result.operations[1].parentId, "$tmp:n0");
    assert.equal(result.operations[1].op, "create_ellipse");
});

for (const [alias, operation] of [
    ["board", "create_board"],
    ["rect", "create_rect"],
    ["rectangle", "create_rect"],
    ["ellipse", "create_ellipse"],
    ["circle", "create_ellipse"],
    ["text", "create_text"],
    ["path", "create_path"],
    ["image", "create_image"],
    ["svg_raw", "create_svg_raw"],
] as const) {
    test(`type ${alias} creates ${operation}`, () => {
        const result = expander.expand(PAGE, undefined, [{ type: alias, x: 0, y: 0, width: 1, height: 1 }]);
        assert.equal(result.operations[0].op, operation);
    });
}

test("image media fields in props move to the top level of the operation", () => {
    const result = expander.expand(PAGE, undefined, [
        {
            type: "image",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            props: { mediaId: "m1", mediaWidth: 200, mediaHeight: 100, mediaMtype: "image/png", opacity: 0.8 },
        },
    ]);
    assert.deepEqual(result.operations[0], {
        op: "create_image",
        pageId: PAGE,
        id: "$tmp:n0",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        mediaId: "m1",
        mediaWidth: 200,
        mediaHeight: 100,
        mediaMtype: "image/png",
        props: { opacity: 0.8 },
    });
});

test("text style fields in props move to the top level", () => {
    const result = expander.expand(PAGE, undefined, [
        {
            type: "text",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            characters: "Hi",
            props: { fontSize: "14", growType: "auto-width" },
        },
    ]);
    assert.equal(result.operations[0].fontSize, "14");
    assert.equal(result.operations[0].growType, "auto-width");
    assert.equal(result.operations[0].props, undefined);
});

test("path content and svg raw content move to the top level", () => {
    const path = expander.expand(PAGE, undefined, [
        { type: "path", x: 0, y: 0, width: 1, height: 1, props: { d: "M0 0 L1 1" } },
    ]);
    assert.equal(path.operations[0].d, "M0 0 L1 1");
    const svg = expander.expand(PAGE, undefined, [
        { type: "svg_raw", x: 0, y: 0, width: 1, height: 1, props: { content: "<svg/>" } },
    ]);
    assert.equal(svg.operations[0].content, "<svg/>");
});

test("an unknown node type is rejected by the expander", () => {
    assert.throws(
        () =>
            expander.expand(PAGE, undefined, [
                { type: "frame", x: 0, y: 0, width: 1, height: 1 } as unknown as BatchNode,
            ]),
        /Unknown node type "frame"/
    );
});

test("a tree of more than 2000 nodes is rejected", () => {
    const roots: BatchNode[] = Array.from({ length: 2001 }, () => ({ type: "rect", x: 0, y: 0, width: 1, height: 1 }));
    assert.throws(() => expander.expand(PAGE, undefined, roots), /at most 2000 nodes/);
});

test("the node schema accepts nested children and rejects an unknown type", () => {
    const valid = BatchTreeExpander.NODE_SCHEMA.safeParse({
        type: "board",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        children: [{ type: "rect", x: 0, y: 0, width: 1, height: 1 }],
    });
    assert.equal(valid.success, true);
    const invalid = BatchTreeExpander.NODE_SCHEMA.safeParse({ type: "frame", x: 0, y: 0, width: 1, height: 1 });
    assert.equal(invalid.success, false);
});

test("the node schema names a missing geometry field", () => {
    const invalid = BatchTreeExpander.NODE_SCHEMA.safeParse({ type: "rect", x: 0, y: 0, height: 1 });
    assert.equal(invalid.success, false);
    assert.match(JSON.stringify(invalid.error?.issues), /"width"/);
});

test("a wide tree of 3000 nodes throws the cap error", () => {
    const roots: BatchNode[] = Array.from({ length: 3000 }, () => ({ type: "rect", x: 0, y: 0, width: 1, height: 1 }));
    assert.throws(() => expander.expand(PAGE, undefined, roots), /at most 2000 nodes/);
});

test("a chain 500 nodes deep expands without overflowing the stack", () => {
    let chain: BatchNode = { type: "rect", x: 0, y: 0, width: 1, height: 1 };
    for (let depth = 1; depth < 500; depth++) {
        chain = { type: "rect", x: 0, y: 0, width: 1, height: 1, children: [chain] };
    }
    const result = expander.expand(PAGE, undefined, [chain]);
    assert.equal(result.nodes.length, 500);
    assert.equal(result.operations[0].parentId, undefined);
    assert.equal(result.operations[499].parentId, "$tmp:n498");
});

test("a chain 3000 nodes deep throws the cap error without overflowing the stack", () => {
    let chain: BatchNode = { type: "rect", x: 0, y: 0, width: 1, height: 1 };
    for (let depth = 1; depth < 3000; depth++) {
        chain = { type: "rect", x: 0, y: 0, width: 1, height: 1, children: [chain] };
    }
    assert.throws(() => expander.expand(PAGE, undefined, [chain]), /at most 2000 nodes/);
});

test("a tree of exactly 2000 nodes is accepted, the cap being inclusive", () => {
    const roots: BatchNode[] = Array.from({ length: 2000 }, () => ({ type: "rect", x: 0, y: 0, width: 1, height: 1 }));
    const result = expander.expand(PAGE, undefined, roots);
    assert.equal(result.nodes.length, 2000);
    assert.equal(result.nodes[1999].handle, "$tmp:n1999");
});

test("the cap is enforced during expansion, before a later invalid node is reached", () => {
    const roots: BatchNode[] = Array.from({ length: 2500 }, () => ({ type: "rect", x: 0, y: 0, width: 1, height: 1 }));
    roots.push({ type: "frame", x: 0, y: 0, width: 1, height: 1 } as unknown as BatchNode);
    assert.throws(() => expander.expand(PAGE, undefined, roots), /at most 2000 nodes/);
});
