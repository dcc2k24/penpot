import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
    FILE,
    PAGE,
    PAGE_TWO,
    ROOT,
    TEAM,
    disposeHarnesses,
    harness,
    opNamesOf,
    opsOf,
    run,
    textOf,
} from "./ExecuteCodeHarness";

const BOARD = "2c3d4e5f-0000-4000-8000-0000000000c1";
const CHILD_A = "2c3d4e5f-0000-4000-8000-0000000000c2";
const CHILD_B = "2c3d4e5f-0000-4000-8000-0000000000c3";
const SECOND_BOARD = "2c3d4e5f-0000-4000-8000-0000000000c4";
const GRID = "2c3d4e5f-0000-4000-8000-0000000000c5";
const GRID_CHILD = "2c3d4e5f-0000-4000-8000-0000000000c6";
const RECT = "2c3d4e5f-0000-4000-8000-0000000000c7";
const MAIN = "2c3d4e5f-0000-4000-8000-0000000000d2";
const INSTANCE = "2c3d4e5f-0000-4000-8000-0000000000d3";
const COMPONENT = "3e4f5a6b-0000-4000-8000-0000000000e1";
const SET = "4f5a6b7c-0000-4000-8000-0000000000f1";
const SET_TWO = "4f5a6b7c-0000-4000-8000-0000000000f2";
const THEME = "5a6b7c8d-0000-4000-8000-0000000000a1";
const TOKEN_BASE = "6b7c8d9e-0000-4000-8000-0000000000b1";
const TOKEN_LARGE = "6b7c8d9e-0000-4000-8000-0000000000b2";
const TOKEN_COLOR = "6b7c8d9e-0000-4000-8000-0000000000b3";

/** The token catalogue of the scenario file, as get-mcp-tokens answers it. */
const TOKENS = {
    sets: [
        { id: SET, name: "Base", active: true, tokenCount: 3 },
        { id: SET_TWO, name: "Brand", active: false, tokenCount: 0 },
    ],
    themes: [{ id: THEME, group: "Mode", name: "Light", sets: ["Base"], active: true }],
    tokens: [
        { setId: SET, id: TOKEN_BASE, name: "spacing.base", type: "spacing", value: "8px" },
        { setId: SET, id: TOKEN_LARGE, name: "spacing.large", type: "spacing", value: "{spacing.base}" },
        { setId: SET, id: TOKEN_COLOR, name: "color.brand", type: "color", value: "#ff8800" },
    ],
    activeThemes: [THEME],
    activeSets: [SET],
};

/** Parses the JSON text of a successful script response. */
function resultOf(response: Parameters<typeof textOf>[0]): Record<string, unknown> {
    return JSON.parse(textOf(response)) as Record<string, unknown>;
}

test("tokens read the catalogue, and the helpers find a token by name", async () => {
    const { tool } = harness({ responses: { "get-mcp-tokens": TOKENS } });
    const body = resultOf(
        await run(
            tool,
            `const tokens = penpot.library.local.tokens;
             return [
               tokens.sets.map((set) => set.name),
               tokens.findByName("spacing.base").value,
               penpotUtils.findTokenByName("color.brand").type,
               tokens.activeThemes.length,
               penpotUtils.findTokensByName("spacing.large").length
             ];`
        )
    );
    assert.deepEqual(body.result, [["Base", "Brand"], "8px", "color", 1, 1]);
});

test("tokenOverview groups the token names by set and type", async () => {
    const { tool } = harness({ responses: { "get-mcp-tokens": TOKENS } });
    const body = resultOf(await run(tool, "return penpotUtils.tokenOverview();"));
    assert.deepEqual(body.result, {
        Base: { spacing: ["spacing.base", "spacing.large"], color: ["color.brand"] },
        Brand: {},
    });
});

test("addSet and addToken queue the set first and the token on that set", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        `const set = penpot.library.local.tokens.addSet({ name: "Mobile" });
         set.addToken({ type: "spacing", name: "gap", value: "4px" });
         return "ok";`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opNamesOf(writes[0]), ["create_token_set", "create_token"]);
    const [setOp, tokenOp] = opsOf(writes[0]);
    assert.equal(tokenOp.setId, setOp.id, "the token names the set created in the same call");
    assert.equal(tokenOp.name, "gap");
    assert.equal(tokenOp.value, "4px");
});

test("applyToken queues the token name and the attributes, and the host resolves the reference", async () => {
    const { backend, tool } = harness({
        responses: { "get-mcp-tokens": TOKENS },
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
    });
    const body = resultOf(
        await run(
            tool,
            `const large = penpot.library.local.tokens.findByName("spacing.large");
             penpot.currentPage.getShapeById("${RECT}").applyToken(large, ["width", "strokeColor"]);
             return "ok";`
        )
    );
    assert.equal(body.result, "ok");
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opNamesOf(writes[0]), ["apply_token"]);
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "apply_token",
        pageId: PAGE,
        shapeIds: [RECT],
        tokenName: "spacing.large",
        attributes: ["width", "stroke-color"],
        resolvedValue: 8,
    });
});

test("a token reference cycle fails the script and names the token", async () => {
    const cycle = {
        sets: [{ id: SET, name: "Base", active: true }],
        themes: [],
        tokens: [
            { setId: SET, id: TOKEN_BASE, name: "a", type: "spacing", value: "{b}" },
            { setId: SET, id: TOKEN_LARGE, name: "b", type: "spacing", value: "{a}" },
        ],
        activeThemes: [],
        activeSets: [SET],
    };
    const { backend, tool } = harness({
        responses: { "get-mcp-tokens": cycle },
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
    });
    const text = textOf(
        await run(
            tool,
            `penpot.currentPage.getShapeById("${RECT}").applyToken(penpot.library.local.tokens.findByName("a"), ["width"]);
             return "ok";`
        )
    );
    assert.match(text, /reference cycle/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0, "nothing is written when the value cannot resolve");
});

test("toggleActive on a set queues set_tokens_status with the new active sets", async () => {
    const { backend, tool } = harness({ responses: { "get-mcp-tokens": TOKENS } });
    await run(tool, "penpot.library.local.tokens.sets[1].toggleActive(); return 1;");
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "set_tokens_status",
        themeIds: [THEME],
        setIds: [SET, SET_TWO],
    });
});

test("a token removed through its object queues delete_token", async () => {
    const { backend, tool } = harness({ responses: { "get-mcp-tokens": TOKENS } });
    await run(tool, 'penpot.library.local.tokens.findByName("color.brand").remove(); return 1;');
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], { op: "delete_token", setId: SET, id: TOKEN_COLOR });
});

test("a flex layout reads its fields, and the grid of a flex board is null", async () => {
    const { tool } = harness({
        shapes: [
            {
                id: BOARD,
                type: "frame",
                name: "Board",
                layout: "flex",
                layoutFlexDir: "row",
                layoutWrapType: "nowrap",
                layoutGap: { rowGap: 8, columnGap: 4 },
                layoutPadding: { p1: 1, p2: 2, p3: 3, p4: 4 },
            },
        ],
    });
    const body = resultOf(
        await run(
            tool,
            `const board = penpot.currentPage.getShapeById("${BOARD}");
             const f = board.flex;
             return [f.dir, f.rowGap, f.verticalPadding, f.horizontalPadding, f.rightPadding, board.grid];`
        )
    );
    assert.deepEqual(body.result, ["row", 8, 1, 4, 2, null]);
});

test("setting one flex field queues the whole flex layout", async () => {
    const { backend, tool } = harness({
        shapes: [
            {
                id: BOARD,
                type: "frame",
                name: "Board",
                layout: "flex",
                layoutFlexDir: "row",
                layoutWrapType: "nowrap",
                layoutGap: { rowGap: 8, columnGap: 4 },
                layoutPadding: { p1: 1, p2: 2, p3: 3, p4: 4 },
            },
        ],
    });
    await run(tool, `penpot.currentPage.getShapeById("${BOARD}").flex.dir = "column"; return 1;`);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "set_flex_layout",
        pageId: PAGE,
        id: BOARD,
        layoutFlexDir: "column",
        layoutWrapType: "nowrap",
        layoutGap: { rowGap: 8, columnGap: 4 },
        layoutPadding: { p1: 1, p2: 2, p3: 3, p4: 4 },
    });
});

test("a vertical padding write sets the top and bottom sides, and remove queues remove_layout", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: BOARD, type: "frame", name: "Board", layout: "flex", layoutFlexDir: "row" }],
    });
    await run(
        tool,
        `const board = penpot.currentPage.getShapeById("${BOARD}");
         board.flex.verticalPadding = 6;
         board.flex.remove();
         return 1;`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opNamesOf(writes[0]), ["set_flex_layout", "remove_layout"]);
    assert.deepEqual(opsOf(writes[0])[0].layoutPadding, { p1: 6, p2: 0, p3: 6, p4: 0 });
});

test("grid addRow queues the grid with the new track after the existing ones", async () => {
    const { backend, tool } = harness({
        shapes: [
            {
                id: GRID,
                type: "frame",
                name: "Grid",
                layout: "grid",
                layoutGridDir: "row",
                layoutGridRows: [{ type: "flex", value: 1 }],
                layoutGridColumns: [{ type: "flex", value: 1 }],
            },
        ],
    });
    await run(tool, `penpot.currentPage.getShapeById("${GRID}").grid.addRow("fixed", 100); return 1;`);
    const writes = backend.callsTo("mcp-apply-operations");
    const op = opsOf(writes[0])[0];
    assert.equal(op.op, "set_grid_layout");
    assert.deepEqual(op.layoutGridRows, [
        { type: "flex", value: 1 },
        { type: "fixed", value: 100 },
    ]);
    assert.deepEqual(op.layoutGridColumns, [{ type: "flex", value: 1 }]);
});

test("addGridLayout takes the rows as tracks and leaves the other options to the compiler", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: BOARD, type: "frame", name: "Board" }],
    });
    await run(
        tool,
        `penpot.currentPage.getShapeById("${BOARD}").addGridLayout({ dir: "column", rows: [{ type: "auto" }] });
         return 1;`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "set_grid_layout",
        pageId: PAGE,
        id: BOARD,
        layoutGridDir: "column",
        layoutGridRows: [{ type: "auto", value: null }],
    });
});

test("layoutChild writes set_layout_child, and reads null when the parent has no layout", async () => {
    const { backend, tool } = harness({
        shapes: [
            { id: BOARD, type: "frame", name: "Board", layout: "flex", layoutFlexDir: "row" },
            { id: CHILD_A, type: "rect", name: "A", parentId: BOARD },
            { id: SECOND_BOARD, type: "frame", name: "Plain" },
            { id: CHILD_B, type: "rect", name: "B", parentId: SECOND_BOARD },
        ],
    });
    const body = resultOf(
        await run(
            tool,
            `const child = penpot.currentPage.getShapeById("${CHILD_A}");
             child.layoutChild.horizontalSizing = "fill";
             child.layoutChild.topMargin = 4;
             return [child.layoutChild.absolute, penpot.currentPage.getShapeById("${CHILD_B}").layoutChild];`
        )
    );
    assert.deepEqual(body.result, [false, null]);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0]), [
        { op: "set_layout_child", pageId: PAGE, id: CHILD_A, layoutItemHSizing: "fill" },
        {
            op: "set_layout_child",
            pageId: PAGE,
            id: CHILD_A,
            layoutItemMargin: { m1: 4, m2: 0, m3: 0, m4: 0 },
        },
    ]);
});

test("layoutCell writes set_grid_cell, keeping the row and the spans of the cell", async () => {
    const { backend, tool } = harness({
        shapes: [
            {
                id: GRID,
                type: "frame",
                name: "Grid",
                layout: "grid",
                layoutGridRows: [{ type: "flex", value: 1 }],
                layoutGridColumns: [{ type: "flex", value: 1 }],
                layoutGridCells: {
                    cell1: { id: "cell1", row: 1, column: 1, rowSpan: 1, columnSpan: 1, shapes: [GRID_CHILD] },
                },
            },
            { id: GRID_CHILD, type: "rect", name: "Child", parentId: GRID },
        ],
    });
    const body = resultOf(
        await run(
            tool,
            `const child = penpot.currentPage.getShapeById("${GRID_CHILD}");
             child.layoutCell.column = 2;
             return [child.layoutCell.row, child.layoutCell.column];`
        )
    );
    assert.deepEqual(body.result, [1, 1]);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "set_grid_cell",
        pageId: PAGE,
        gridId: GRID,
        childId: GRID_CHILD,
        row: 1,
        column: 2,
        rowSpan: 1,
        columnSpan: 1,
    });
});

test("interactions are read under the Plugin API names", async () => {
    const { tool } = harness({
        shapes: [
            {
                id: BOARD,
                type: "frame",
                name: "Board",
                interactions: [
                    {
                        eventType: "click",
                        actionType: "navigate",
                        destination: SECOND_BOARD,
                        preserveScroll: true,
                    },
                ],
            },
            { id: SECOND_BOARD, type: "frame", name: "Second" },
        ],
    });
    const body = resultOf(
        await run(
            tool,
            `const i = penpot.currentPage.getShapeById("${BOARD}").interactions[0];
             return [i.trigger, i.action.type, i.action.destination.id, i.action.preserveScrollPosition];`
        )
    );
    assert.deepEqual(body.result, ["click", "navigate-to", SECOND_BOARD, true]);
});

test("addInteraction queues the backend map, and remove queues remove_interaction", async () => {
    const { backend, tool } = harness({
        shapes: [
            { id: BOARD, type: "frame", name: "Board" },
            { id: SECOND_BOARD, type: "frame", name: "Second" },
        ],
    });
    const body = resultOf(
        await run(
            tool,
            `const board = penpot.currentPage.getShapeById("${BOARD}");
             const target = penpot.currentPage.getShapeById("${SECOND_BOARD}");
             const it = board.addInteraction("after-delay", { type: "open-overlay", destination: target, position: "center" }, 300);
             it.remove();
             return it.index;`
        )
    );
    assert.equal(body.result, 0);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0]), [
        {
            op: "add_interaction",
            pageId: PAGE,
            id: BOARD,
            interaction: {
                eventType: "after-delay",
                actionType: "open-overlay",
                delay: 300,
                destination: SECOND_BOARD,
                overlayPosType: "center",
            },
        },
        { op: "remove_interaction", pageId: PAGE, id: BOARD, index: 0 },
    ]);
});

test("ruler guides and flows queue their ops; guides and flows are not read", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: BOARD, type: "frame", name: "Board" }],
    });
    await run(
        tool,
        `const page = penpot.currentPage;
         const board = page.getShapeById("${BOARD}");
         page.addRulerGuide("horizontal", 10);
         board.addRulerGuide("vertical", 5);
         const flow = page.createFlow("Main", board);
         page.removeFlow(flow);
         return 1;`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opNamesOf(writes[0]), ["add_ruler_guide", "add_ruler_guide", "create_flow", "remove_flow"]);
    const guides = opsOf(writes[0]);
    assert.equal(guides[1].frameId, BOARD);
    assert.equal(guides[1].axis, "vertical");
    assert.equal(guides[2].startingFrame, BOARD);
    const text = textOf(await run(tool, "return penpot.currentPage.rulerGuides;"));
    assert.match(text, /page\.rulerGuides is not available in backend mode/);
});

test("align and distribute queue one op each, with the backend axis", async () => {
    const { backend, tool } = harness({
        shapes: [
            { id: CHILD_A, type: "rect", name: "A" },
            { id: CHILD_B, type: "rect", name: "B" },
            { id: SECOND_BOARD, type: "rect", name: "C" },
        ],
    });
    await run(
        tool,
        `const shapes = ["${CHILD_A}", "${CHILD_B}", "${SECOND_BOARD}"].map((id) => penpot.currentPage.getShapeById(id));
         penpot.alignHorizontal(shapes.slice(0, 2), "left");
         penpot.distributeVertical(shapes);
         return 1;`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0]), [
        { op: "align", pageId: PAGE, ids: [CHILD_A, CHILD_B], axis: "hleft" },
        { op: "distribute", pageId: PAGE, ids: [CHILD_A, CHILD_B, SECOND_BOARD], axis: "vertical" },
    ]);
});

test("shapesColors groups the colours, and replaceColor queues the new fill", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: RECT, type: "rect", name: "Rect", fills: [{ fillColor: "#ff0000", fillOpacity: 1 }] }],
    });
    const body = resultOf(
        await run(
            tool,
            `const rect = penpot.currentPage.getShapeById("${RECT}");
             const before = penpot.shapesColors([rect]);
             penpot.replaceColor([rect], { color: "#FF0000" }, { color: "#00ff00" });
             return before;`
        )
    );
    assert.deepEqual(body.result, [
        { color: "#ff0000", opacity: 1, shapesInfo: [{ property: "fill", shapeId: RECT }] },
    ]);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0]), [
        {
            op: "update_shape",
            pageId: PAGE,
            id: RECT,
            props: { fills: [{ fillColor: "#00ff00", fillOpacity: 1 }] },
        },
    ]);
});

test("uploadMediaUrl stores the image at once and returns the Plugin API image data", async () => {
    const { backend, tool } = harness();
    const body = resultOf(await run(tool, 'return penpot.uploadMediaUrl("pic", "https://example.com/p.png");'));
    assert.deepEqual(body.result, {
        id: "media-url-1",
        name: "pic",
        width: 4,
        height: 2,
        mtype: "image/png",
        keepAspectRatio: true,
    });
    const calls = backend.callsTo("create-file-media-object-from-url");
    assert.deepEqual(calls[0].params, {
        fileId: FILE,
        isLocal: true,
        url: "https://example.com/p.png",
        name: "pic",
    });
});

test("uploadMediaUrl refuses an address that is not http or https", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'return penpot.uploadMediaUrl("pic", "file:///etc/passwd");'));
    assert.match(text, /must start with http/);
});

test("uploadMediaData sends the bytes as a multipart part", async () => {
    const { backend, tool } = harness();
    const body = resultOf(
        await run(tool, 'return penpot.uploadMediaData("pic", new Uint8Array([1, 2, 3]), "image/png").id;')
    );
    assert.equal(body.result, "media-upload-1");
    const calls = backend.callsTo("upload-file-media-object");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "multipart");
    assert.deepEqual(calls[0].fields, { "file-id": FILE, "is-local": "true", name: "pic" });
    assert.deepEqual(Array.from(calls[0].uploads?.[0].content ?? []), [1, 2, 3]);
});

test("a fill with fillImage queues the image in the shape", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
    });
    await run(
        tool,
        `const image = penpot.uploadMediaUrl("pic", "https://example.com/p.png");
         const rect = penpot.createRectangle();
         rect.fills = [{ fillImage: image, fillOpacity: 1 }];
         return 1;`
    );
    const writes = backend.callsTo("mcp-apply-operations");
    // the fill folds into the create op, as its props.
    assert.deepEqual(opNamesOf(writes[0]), ["create_rect"]);
    const create = opsOf(writes[0])[0];
    assert.equal(
        (create.props as { fills: Array<{ fillImage: { id: string } }> }).fills[0].fillImage.id,
        "media-url-1"
    );
});

test("shape.export flushes the pending writes and returns the rendered bytes", async () => {
    const { backend, exporter, tool } = harness({
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
    });
    const body = resultOf(
        await run(
            tool,
            `const rect = penpot.createRectangle();
             const bytes = rect.export({ type: "svg", scale: 2 });
             return bytes.length;`
        )
    );
    assert.equal(body.result, 4);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1, "the rectangle is written before the export");
    assert.equal(exporter.exports.length, 1);
    assert.deepEqual(exporter.exports[0].request, {
        fileId: FILE,
        pageId: PAGE,
        objectId: "uuid-s1",
        format: "svg",
        scale: 2,
        profileId: "profile-1",
        name: "export",
    });
});

test("shape.export refuses a rendered file over 8 MB", async () => {
    const { exporter, tool } = harness({
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
    });
    exporter.respondExport({ bytes: new Uint8Array(9 * 1024 * 1024), mimeType: "image/png" });
    const text = textOf(await run(tool, `penpot.currentPage.getShapeById("${RECT}").export(); return 1;`));
    assert.match(text, /larger than 8 MB/);
});

test("penpotUtils.exportImage downloads the stored image of a fill", async () => {
    const { exporter, tool } = harness({
        shapes: [
            {
                id: RECT,
                type: "rect",
                name: "Rect",
                fills: [
                    {
                        fillOpacity: 1,
                        fillImage: { id: "img-9", name: "pic", width: 4, height: 2, mtype: "image/png" },
                    },
                ],
            },
        ],
    });
    exporter.respondDownload({ bytes: new Uint8Array([7, 8]), mimeType: "image/png" });
    const body = resultOf(
        await run(
            tool,
            `return Array.from(penpotUtils.exportImage(penpot.currentPage.getShapeById("${RECT}"), "fill", false));`
        )
    );
    assert.deepEqual(body.result, [7, 8]);
    assert.equal(exporter.downloads[0].assetId, "img-9");
});

test("penpotUtils.importImage stores the decoded bytes and places a filled rectangle", async () => {
    const { backend, tool } = harness();
    await run(tool, 'penpotUtils.importImage("AQID", "image/png", "logo", 10, 20, undefined, undefined); return 1;');
    const uploads = backend.callsTo("upload-file-media-object");
    assert.deepEqual(Array.from(uploads[0].uploads?.[0].content ?? []), [1, 2, 3]);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opNamesOf(writes[0]).slice(0, 1), ["create_rect"]);
    // the fill folds into the create op, so the create carries it in its props.
    const fillOp = opsOf(writes[0]).find((op) => "fills" in ((op.props as object | undefined) ?? {}));
    assert.ok(fillOp, "the rectangle gets its image fill");
});

test("a library component gives its main instance, and an instance is queued", async () => {
    const { backend, tool } = harness({
        shapes: [
            { id: MAIN, type: "frame", name: "Button main" },
            {
                id: INSTANCE,
                type: "frame",
                name: "Button",
                componentId: COMPONENT,
                componentRoot: true,
                shapeRef: MAIN,
                pluginData: { "plugin/mcp": { alpha: "1" }, "shared/brand": { color: "red" } },
            },
        ],
        responses: {
            "get-mcp-library": {
                components: [
                    {
                        id: COMPONENT,
                        name: "Button",
                        path: "Buttons",
                        mainInstanceId: MAIN,
                        mainInstancePage: PAGE,
                        deleted: false,
                    },
                ],
                colors: [],
                typographies: [],
            },
        },
    });
    const body = resultOf(
        await run(
            tool,
            `const comp = penpot.library.local.components[0];
             const shape = penpot.currentPage.getShapeById("${INSTANCE}");
             comp.instance(10, 20);
             return [
               comp.name,
               comp.path,
               comp.mainInstance().id,
               shape.component().name,
               shape.componentRefShape().id,
               shape.componentRoot().id,
               shape.isComponentHead(),
               shape.getPluginDataKeys(),
               shape.getSharedPluginDataKeys("brand")
             ];`
        )
    );
    assert.deepEqual(body.result, ["Button", "Buttons", MAIN, "Button", MAIN, INSTANCE, true, ["alpha"], ["color"]]);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0])[0], {
        op: "instantiate_component",
        pageId: PAGE,
        componentId: COMPONENT,
        x: 10,
        y: 20,
        id: "$tmp:instance1",
    });
});

test("team, library and token source members reach their commands", async () => {
    const { backend, tool } = harness({
        responses: {
            "create-team": { id: "team-new", name: "Studio" },
            "get-team-deleted-files": [{ id: "file-old", name: "Old" }],
            "get-team-shared-files": [{ id: "lib-1", name: "Shared lib" }],
            "link-file-to-library": [],
        },
    });
    const body = resultOf(
        await run(
            tool,
            `const team = penpotMgmt.createTeam({ name: "Studio" });
             const deleted = penpotMgmt.listDeletedFiles();
             const available = penpot.library.availableLibraries();
             const linked = penpot.library.connectLibrary("lib-1");
             penpot.library.tokensSource = penpot.library.local;
             return [team.id, deleted.length, available[0].name, linked.name];`
        )
    );
    assert.deepEqual(body.result, ["team-new", 1, "Shared lib", "Shared lib"]);
    assert.deepEqual(backend.callsTo("create-team")[0].params, { name: "Studio" });
    assert.deepEqual(backend.callsTo("get-team-deleted-files")[0].params, { teamId: TEAM });
    assert.deepEqual(backend.callsTo("link-file-to-library")[0].params, { fileId: FILE, libraryId: "lib-1" });
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(opsOf(writes[0]), [{ op: "set_tokens_source", libraryId: FILE }]);
});

test("the token source cannot be read", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, "return penpot.library.tokensSource;"));
    assert.match(text, /library\.tokensSource is not available in backend mode/);
});

test("an awaited facade call runs the same as the plain call", async () => {
    const { backend, tool } = harness({
        shapes: [{ id: RECT, type: "rect", name: "Rect" }],
        responses: { "get-teams": [] },
    });
    const body = resultOf(
        await run(
            tool,
            `const rect = await penpot.createRectangle();
             rect.x = 3;
             const x = rect.x;
             const bytes = await penpot.currentPage.getShapeById("${RECT}").export();
             const teams = await penpotMgmt.listTeams();
             return [x, bytes.length, teams.length];`
        )
    );
    assert.deepEqual(body.result, [3, 4, 0]);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1);
});

test("an await that is not in front of a facade call still fails with the hint", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, "const v = await Promise.resolve(2); return v;"));
    assert.match(text, /remove await/);
});

test("the page objects of the second page are reachable by id", async () => {
    const { tool } = harness();
    const body = resultOf(await run(tool, `return penpot.getPage("${PAGE_TWO}").name;`));
    assert.equal(body.result, "Page 2");
    const root = resultOf(await run(tool, `return penpot.currentPage.root.id;`));
    assert.equal(root.result, ROOT);
});

after(() => {
    disposeHarnesses();
});
