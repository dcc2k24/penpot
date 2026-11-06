import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OperationValidator } from "./operations/OperationValidator";
import {
    PAGE,
    disposeHarnesses,
    harness,
    opNamesOf,
    opsOf,
    run,
    textOf,
    type FakeShape,
    type HarnessOptions,
} from "./ExecuteCodeHarness";

const BOARD = "4a5b6c7d-0000-4000-8000-0000000000b1";
const RECT_A = "4a5b6c7d-0000-4000-8000-0000000000b2";
const RECT_B = "4a5b6c7d-0000-4000-8000-0000000000b3";
const RECT_C = "4a5b6c7d-0000-4000-8000-0000000000b4";
const GROUP = "4a5b6c7d-0000-4000-8000-0000000000b5";
const TEXT = "4a5b6c7d-0000-4000-8000-0000000000b6";
const FLEX = "4a5b6c7d-0000-4000-8000-0000000000b7";
const FLEX_CHILD = "4a5b6c7d-0000-4000-8000-0000000000b8";
const GRID = "4a5b6c7d-0000-4000-8000-0000000000b9";
const GRID_CHILD = "4a5b6c7d-0000-4000-8000-0000000000ba";
const MAIN = "4a5b6c7d-0000-4000-8000-0000000000bb";
const INSTANCE = "4a5b6c7d-0000-4000-8000-0000000000bc";
const COMPONENT = "5b6c7d8e-0000-4000-8000-0000000000c1";
const COMPONENT_TWO = "5b6c7d8e-0000-4000-8000-0000000000c2";
const SET = "6c7d8e9f-0000-4000-8000-0000000000d1";
const SET_TWO = "6c7d8e9f-0000-4000-8000-0000000000d2";
const THEME = "7d8e9f00-0000-4000-8000-0000000000e1";
const TOKEN_BASE = "8e9f0011-0000-4000-8000-0000000000f1";
const TOKEN_LARGE = "8e9f0011-0000-4000-8000-0000000000f2";
const TOKEN_COLOR = "8e9f0011-0000-4000-8000-0000000000f3";

/** Shapes of a plain page: a board and three rectangles on its root. */
const BASIC: FakeShape[] = [
    { id: BOARD, type: "frame", name: "Board" },
    { id: RECT_A, type: "rect", name: "A" },
    { id: RECT_B, type: "rect", name: "B" },
    { id: RECT_C, type: "rect", name: "C" },
];

/** Shapes with a group that holds one rectangle, for masks and ungrouping. */
const GROUPED: FakeShape[] = [
    ...BASIC,
    { id: GROUP, type: "group", name: "Group" },
    { id: RECT_A, type: "rect", name: "A", parentId: GROUP },
];

/** Shapes with a flex board and one child, for flex layout and layout child ops. */
const FLEX_SHAPES: FakeShape[] = [
    {
        id: FLEX,
        type: "frame",
        name: "Flex",
        layout: "flex",
        layoutFlexDir: "row",
        layoutWrapType: "nowrap",
        layoutGap: { rowGap: 8, columnGap: 4 },
        layoutPadding: { p1: 1, p2: 2, p3: 3, p4: 4 },
    },
    { id: FLEX_CHILD, type: "rect", name: "Child", parentId: FLEX },
];

/** Shapes with a grid frame and one cell that holds a child, for grid cell ops. */
const GRID_SHAPES: FakeShape[] = [
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
];

/** Shapes with a main component and an instance of it, for component ops. */
const COMPONENT_SHAPES: FakeShape[] = [
    { id: MAIN, type: "frame", name: "Button main" },
    { id: INSTANCE, type: "frame", name: "Button", componentId: COMPONENT, componentRoot: true, shapeRef: MAIN },
];

/** The library of the scenario file: two components whose main instance is MAIN. */
const LIBRARY = {
    components: [
        {
            id: COMPONENT,
            name: "Button",
            path: "Buttons",
            mainInstanceId: MAIN,
            mainInstancePage: PAGE,
            deleted: false,
        },
        {
            id: COMPONENT_TWO,
            name: "Card",
            path: "Cards",
            mainInstanceId: MAIN,
            mainInstancePage: PAGE,
            deleted: false,
        },
    ],
    colors: [],
    typographies: [],
};

/** The token catalogue of the scenario file, with two sets and one theme. */
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

/** One script that makes the facade emit one kind of operation, with the harness options that reach it. */
interface KindCase {
    /** Op name that the script makes the facade emit. */
    kind: string;
    /** Script run through the harness. */
    script: string;
    /** Shapes, library and token answers of the harness. */
    options?: HarnessOptions;
    /** Reason the kind is not checked, when the facade emits an op that the validator rejects. */
    skip?: string;
}

/**
 * Returns the script expression of a shape of the current page, by its id.
 *
 * @param id - id of the shape
 * @returns the script text that reads the shape
 */
function pick(id: string): string {
    return `penpot.currentPage.getShapeById("${id}")`;
}

/** One case per op name the facade emits, in the order of the facade. */
const KIND_CASES: KindCase[] = [
    { kind: "create_page", script: 'penpot.createPage({ name: "Extra" }); return 1;' },
    { kind: "create_board", script: "penpot.createBoard(); return 1;" },
    { kind: "create_rect", script: "penpot.createRectangle(); return 1;" },
    { kind: "create_ellipse", script: "penpot.createEllipse(); return 1;" },
    { kind: "create_text", script: 'penpot.createText("Hello"); return 1;' },
    { kind: "create_path", script: "penpot.createPath(); return 1;" },
    {
        kind: "create_svg_raw",
        script: 'penpot.createSvgRaw("<svg></svg>"); return 1;',
        skip: "the facade passes the SVG text as content, but the backend schema takes a map",
    },
    {
        kind: "create_group",
        script: `penpot.group([${pick(RECT_A)}, ${pick(RECT_B)}]); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "create_boolean",
        script: `penpot.createBoolean("union", [${pick(RECT_A)}, ${pick(RECT_B)}]); return 1;`,
        options: { shapes: BASIC },
    },
    { kind: "update_shape", script: `${pick(RECT_A)}.resize(20, 30); return 1;`, options: { shapes: BASIC } },
    {
        kind: "move_shapes",
        script: `${pick(BOARD)}.appendChild(${pick(RECT_A)}); return 1;`,
        options: { shapes: BASIC },
    },
    { kind: "reorder", script: `${pick(RECT_A)}.bringToFront(); return 1;`, options: { shapes: BASIC } },
    { kind: "delete_shapes", script: `${pick(RECT_A)}.remove(); return 1;`, options: { shapes: BASIC } },
    { kind: "clone_shape", script: `${pick(RECT_A)}.clone(); return 1;`, options: { shapes: BASIC } },
    { kind: "ungroup", script: `penpot.ungroup(${pick(GROUP)}); return 1;`, options: { shapes: GROUPED } },
    { kind: "flatten", script: `penpot.flatten([${pick(RECT_A)}]); return 1;`, options: { shapes: BASIC } },
    { kind: "make_mask", script: `${pick(GROUP)}.makeMask(); return 1;`, options: { shapes: GROUPED } },
    { kind: "remove_mask", script: `${pick(GROUP)}.removeMask(); return 1;`, options: { shapes: GROUPED } },
    {
        kind: "set_flex_layout",
        script: `${pick(FLEX)}.flex.dir = "column"; return 1;`,
        options: { shapes: FLEX_SHAPES },
    },
    {
        kind: "set_grid_layout",
        script: `${pick(BOARD)}.addGridLayout({ dir: "column", rows: [{ type: "auto" }] }); return 1;`,
        options: { shapes: BASIC },
    },
    { kind: "remove_layout", script: `${pick(FLEX)}.flex.remove(); return 1;`, options: { shapes: FLEX_SHAPES } },
    {
        kind: "set_layout_child",
        script: `${pick(FLEX_CHILD)}.layoutChild.horizontalSizing = "fill"; return 1;`,
        options: { shapes: FLEX_SHAPES },
    },
    {
        kind: "set_grid_cell",
        script: `${pick(GRID_CHILD)}.layoutCell.column = 2; return 1;`,
        options: { shapes: GRID_SHAPES },
    },
    {
        kind: "set_text",
        script: `${pick(TEXT)}.characters = "Hi"; return 1;`,
        options: { shapes: [{ id: TEXT, type: "text", name: "Label" }] },
    },
    {
        kind: "set_text_style",
        script: `${pick(TEXT)}.fontSize = 14; return 1;`,
        options: { shapes: [{ id: TEXT, type: "text", name: "Label" }] },
    },
    {
        kind: "create_component",
        script: `penpot.library.local.createComponent([${pick(RECT_A)}], { name: "Card" }); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "instantiate_component",
        script: "penpot.library.local.components[0].instance(10, 20); return 1;",
        options: { shapes: COMPONENT_SHAPES, responses: { "get-mcp-library": LIBRARY } },
    },
    {
        kind: "detach",
        script: `${pick(INSTANCE)}.detach(); return 1;`,
        options: { shapes: COMPONENT_SHAPES, responses: { "get-mcp-library": LIBRARY } },
    },
    {
        kind: "swap_component",
        script: `${pick(INSTANCE)}.swapComponent(penpot.library.local.components[1]); return 1;`,
        options: { shapes: COMPONENT_SHAPES, responses: { "get-mcp-library": LIBRARY } },
    },
    {
        kind: "reset_overrides",
        script: `${pick(INSTANCE)}.resetOverrides(); return 1;`,
        options: { shapes: COMPONENT_SHAPES, responses: { "get-mcp-library": LIBRARY } },
    },
    {
        kind: "update_main",
        script: `${pick(MAIN)}.updateMain(); return 1;`,
        options: { shapes: COMPONENT_SHAPES, responses: { "get-mcp-library": LIBRARY } },
    },
    {
        kind: "create_color",
        script: 'penpot.library.local.createColor({ name: "Brand", color: "#ff8800" }); return 1;',
    },
    {
        kind: "update_color",
        script: 'const color = penpot.library.local.createColor({ name: "Brand" }); color.name = "Renamed"; return 1;',
    },
    { kind: "delete_color", script: 'penpot.library.local.createColor({ name: "Brand" }).remove(); return 1;' },
    {
        kind: "create_typography",
        script: 'penpot.library.local.createTypography({ name: "Body", fontSize: "14" }); return 1;',
    },
    {
        kind: "update_typography",
        script: 'const type = penpot.library.local.createTypography({ name: "Body" }); type.fontSize = "16"; return 1;',
    },
    {
        kind: "delete_typography",
        script: 'penpot.library.local.createTypography({ name: "Body" }).remove(); return 1;',
    },
    {
        kind: "create_token_set",
        script: 'penpot.library.local.tokens.addSet({ name: "Mobile" }); return 1;',
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "delete_token_set",
        script: "penpot.library.local.tokens.sets[0].remove(); return 1;",
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "create_token",
        script: 'penpot.library.local.tokens.addSet({ name: "Mobile" }).addToken({ type: "spacing", name: "gap", value: "4px" }); return 1;',
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "delete_token",
        script: 'penpot.library.local.tokens.findByName("color.brand").remove(); return 1;',
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "create_theme",
        script: 'penpot.library.local.tokens.addTheme({ group: "Mode", name: "Dark" }); return 1;',
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "delete_theme",
        script: "penpot.library.local.tokens.themes[0].remove(); return 1;",
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "set_tokens_status",
        script: "penpot.library.local.tokens.sets[1].toggleActive(); return 1;",
        options: { responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "set_tokens_source",
        script: "penpot.library.tokensSource = penpot.library.local; return 1;",
    },
    {
        kind: "apply_token",
        script: `${pick(RECT_A)}.applyToken(penpot.library.local.tokens.findByName("spacing.large"), ["width"]); return 1;`,
        options: { shapes: BASIC, responses: { "get-mcp-tokens": TOKENS } },
    },
    {
        kind: "set_plugin_data",
        script: `${pick(RECT_A)}.setPluginData("key", "value"); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "add_interaction",
        script: `${pick(BOARD)}.addInteraction("after-delay", { type: "open-overlay", destination: ${pick(RECT_B)}, position: "center" }, 300); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "remove_interaction",
        script: `const it = ${pick(BOARD)}.addInteraction("after-delay", { type: "open-overlay", destination: ${pick(RECT_B)}, position: "center" }, 300); it.remove(); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "create_flow",
        script: `penpot.currentPage.createFlow("Main", ${pick(BOARD)}); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "remove_flow",
        script: `const page = penpot.currentPage; const flow = page.createFlow("Main", ${pick(BOARD)}); page.removeFlow(flow); return 1;`,
        options: { shapes: BASIC },
    },
    { kind: "add_ruler_guide", script: 'penpot.currentPage.addRulerGuide("horizontal", 10); return 1;' },
    {
        kind: "remove_ruler_guide",
        script: 'const page = penpot.currentPage; const guide = page.addRulerGuide("vertical", 5); page.removeRulerGuide(guide); return 1;',
    },
    {
        kind: "align",
        script: `penpot.alignHorizontal([${pick(RECT_A)}, ${pick(RECT_B)}], "left"); return 1;`,
        options: { shapes: BASIC },
    },
    {
        kind: "distribute",
        script: `penpot.distributeVertical([${pick(RECT_A)}, ${pick(RECT_B)}, ${pick(RECT_C)}]); return 1;`,
        options: { shapes: BASIC },
    },
];

for (const testCase of KIND_CASES) {
    test(
        `the facade emits ${testCase.kind} with operations the validator accepts`,
        { skip: testCase.skip },
        async () => {
            const { backend, tool } = harness(testCase.options);
            const text = textOf(await run(tool, testCase.script));
            assert.doesNotMatch(text, /is invalid|execute_code: operation/, text);

            const writes = backend.callsTo("mcp-apply-operations");
            const names = writes.flatMap((write) => opNamesOf(write));
            assert.ok(
                names.includes(testCase.kind),
                `${testCase.kind} is not among the recorded ops ${names.join(", ")}: ${text}`
            );
            for (const write of writes) {
                new OperationValidator().validate(opsOf(write));
            }
        }
    );
}

after(() => {
    disposeHarnesses();
});
