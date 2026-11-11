import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OperationValidator } from "./OperationValidator";
import { OPERATION_NAMES } from "./OperationSchemas";

const PAGE = "3f2c1a9e-0b7d-4c1e-9a55-2d6f0e8b7c10";
const SHAPE = "6c9f3e2a-4d5b-4f7c-8a81-2b3c4d5e6f70";
const SHAPE_2 = "8e1a5c2d-6f7b-4a9e-8b03-4c5d6e7f8092";
const BOARD = "5b8e2d1f-3c4a-4e6b-9f70-1a2b3c4d5e6f";
const GRID = "9f2b6d3e-7a8c-4b0f-9c14-5d6e7f8091a3";
const COMPONENT = "b14d8f50-9c0e-4d2b-9e36-7f8091a2b3c5";
const validator = new OperationValidator();

/** Fixture with one valid example per op; the Clojure compiler tests build their own cases. */
const SAMPLES_PATH = fileURLToPath(new URL("./sample-operations.json", import.meta.url));
const samples = JSON.parse(readFileSync(SAMPLES_PATH, "utf8")) as Record<string, unknown>[];

test("a valid operation passes and comes back unchanged", () => {
    const operation = { op: "create_rect", pageId: PAGE, id: "$tmp:bg", x: 0, y: 0, width: 10, height: 10 };
    const result = validator.validate([operation]);
    assert.equal(result[0], operation);
});

test("extra parameters pass through to the backend", () => {
    const operation = {
        op: "update_shape",
        pageId: PAGE,
        id: SHAPE,
        props: { opacity: 0.5 },
        futureParameter: true,
    };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("every sample operation is accepted", () => {
    assert.ok(samples.length > 0);
    assert.deepEqual(validator.validate(samples), samples);
});

test("every known op has a sample in the fixture", () => {
    const sampled = new Set(samples.map((operation) => operation.op));
    const missing = OPERATION_NAMES.filter((name) => !sampled.has(name));
    assert.deepEqual(missing, []);
});

test("every sample names a known op", () => {
    const unknown = samples.filter((operation) => !OPERATION_NAMES.includes(String(operation.op)));
    assert.deepEqual(unknown, []);
});

test("an unknown op is rejected with the list of valid ops", () => {
    assert.throws(
        () => validator.validate([{ op: "create_squircle", pageId: PAGE }]),
        (error: Error) => {
            assert.match(error.message, /Operation 0 has unknown op "create_squircle"/);
            assert.match(error.message, /create_rect/);
            assert.match(error.message, /apply_token/);
            return true;
        }
    );
});

test("an operation without an op field is rejected", () => {
    assert.throws(() => validator.validate([{ pageId: PAGE }]), /Operation 0 must be an object with an "op" field/);
});

test("a non-object operation is rejected", () => {
    assert.throws(() => validator.validate(["create_rect"]), /Operation 0 must be an object/);
});

test("the index of the first invalid operation is reported", () => {
    const valid = { op: "delete_shapes", pageId: PAGE, ids: [SHAPE] };
    assert.throws(
        () => validator.validate([valid, valid, { op: "delete_shapes", pageId: PAGE }]),
        /Operation 2 \(delete_shapes\)/
    );
});

for (const [label, operation, field] of [
    ["create_rect without width", { op: "create_rect", pageId: PAGE, x: 0, y: 0, height: 10 }, "width"],
    [
        "create_text without characters",
        { op: "create_text", pageId: PAGE, x: 0, y: 0, width: 1, height: 1 },
        "characters",
    ],
    [
        "create_image without mediaId",
        { op: "create_image", pageId: PAGE, x: 0, y: 0, width: 1, height: 1, mediaWidth: 1, mediaHeight: 1 },
        "mediaId",
    ],
    ["move_shapes with an empty id list", { op: "move_shapes", pageId: PAGE, ids: [], parentId: PAGE }, "ids"],
    [
        "apply_token without resolvedValue",
        { op: "apply_token", pageId: PAGE, shapeIds: [SHAPE], tokenName: "t", attributes: ["fill"] },
        "resolvedValue",
    ],
    [
        "set_grid_cell with a missing column",
        { op: "set_grid_cell", pageId: PAGE, gridId: GRID, childId: SHAPE, row: 1 },
        "column",
    ],
] as const) {
    test(`${label} fails and names the field`, () => {
        assert.throws(
            () => validator.validate([operation]),
            (error: Error) => {
                assert.match(error.message, new RegExp(`${field}`));
                assert.match(error.message, /is invalid/);
                return true;
            }
        );
    });
}

test("a create operation with a wrong type for a field names the field", () => {
    assert.throws(
        () => validator.validate([{ op: "create_rect", pageId: PAGE, x: "left", y: 0, width: 1, height: 1 }]),
        /Operation 0 \(create_rect\) is invalid: x:/
    );
});

test("more than the operation limit is rejected before validation", () => {
    const operations = Array.from({ length: OperationValidator.MAX_OPERATIONS + 1 }, () => ({
        op: "delete_page",
        id: PAGE,
    }));
    assert.throws(() => validator.validate(operations), /at most 2000 operations/);
});

// Alignment with the Clojure compiler: fixes made against operations.cljc.

test("clone_shape takes newId for the clone handle", () => {
    const operation = { op: "clone_shape", pageId: PAGE, id: SHAPE, newId: "$tmp:clone1" };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("clone_shape with cloneId and no newId is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "clone_shape", pageId: PAGE, id: SHAPE, cloneId: "$tmp:clone1" }]),
        (error: Error) => {
            assert.match(error.message, /Operation 0 \(clone_shape\) is invalid: cloneId:/);
            assert.match(error.message, /newId/);
            return true;
        }
    );
});

test("create_svg_raw with a string content is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "create_svg_raw",
                    pageId: PAGE,
                    x: 0,
                    y: 0,
                    width: 24,
                    height: 24,
                    content: "<svg></svg>",
                },
            ]),
        /Operation 0 \(create_svg_raw\) is invalid: content:/
    );
});

test("create_svg_raw with an object content is accepted", () => {
    const operation = {
        op: "create_svg_raw",
        pageId: PAGE,
        x: 0,
        y: 0,
        width: 24,
        height: 24,
        content: { tag: "svg", attrs: {}, content: [] },
    };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("set_grid_cell with row 0 is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                { op: "set_grid_cell", pageId: PAGE, gridId: GRID, childId: SHAPE, row: 0, column: 1 },
            ]),
        /Operation 0 \(set_grid_cell\) is invalid: row:/
    );
});

test("set_grid_cell with column 0 is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                { op: "set_grid_cell", pageId: PAGE, gridId: GRID, childId: SHAPE, row: 1, column: 0 },
            ]),
        /Operation 0 \(set_grid_cell\) is invalid: column:/
    );
});

test("set_grid_cell with a row span of 0 is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                { op: "set_grid_cell", pageId: PAGE, gridId: GRID, childId: SHAPE, row: 1, column: 1, rowSpan: 0 },
            ]),
        /Operation 0 \(set_grid_cell\) is invalid: rowSpan:/
    );
});

test("unapply_token without tokenName is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "unapply_token", pageId: PAGE, shapeIds: [SHAPE], attributes: ["fill"] }]),
        /Operation 0 \(unapply_token\) is invalid: tokenName:/
    );
});

test("unapply_token takes an empty attributes list", () => {
    const operation = { op: "unapply_token", pageId: PAGE, shapeIds: [SHAPE], tokenName: "t", attributes: [] };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("create_color without a color object is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "create_color", name: "Brand" }]),
        /Operation 0 \(create_color\) is invalid: color:/
    );
});

test("create_color with a color object is accepted", () => {
    const operation = { op: "create_color", color: { name: "Brand", color: "#ff0000", opacity: 1 } };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("update_color needs the id inside the color object", () => {
    assert.throws(
        () => validator.validate([{ op: "update_color", color: { name: "Brand" } }]),
        /Operation 0 \(update_color\) is invalid: color\.id:/
    );
});

test("create_typography without a typography object is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "create_typography", name: "Heading" }]),
        /Operation 0 \(create_typography\) is invalid: typography:/
    );
});

test("update_typography needs the id inside the typography object", () => {
    assert.throws(
        () => validator.validate([{ op: "update_typography", typography: { name: "Heading" } }]),
        /Operation 0 \(update_typography\) is invalid: typography\.id:/
    );
});

test("create_text without width and height is accepted", () => {
    const operation = { op: "create_text", pageId: PAGE, x: 0, y: 0, characters: "Hello" };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("create_text with a numeric font weight is accepted", () => {
    const operation = { op: "create_text", pageId: PAGE, x: 0, y: 0, characters: "Hi", fontWeight: 700 };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("a negative width is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "create_rect", pageId: PAGE, x: 0, y: 0, width: -1, height: 1 }]),
        /Operation 0 \(create_rect\) is invalid: width:/
    );
});

test("an id shorter than six characters is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "delete_shapes", pageId: PAGE, ids: ["S1"] }]),
        /Operation 0 \(delete_shapes\) is invalid: ids\.0:/
    );
});

test("a create_image with a media id that is not a uuid is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "create_image",
                    pageId: PAGE,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    mediaId: "not-a-uuid",
                    mediaWidth: 1,
                    mediaHeight: 1,
                },
            ]),
        /Operation 0 \(create_image\) is invalid: mediaId:/
    );
});

test("create_token without a value is rejected", () => {
    assert.throws(
        () =>
            validator.validate([{ op: "create_token", setId: SHAPE, type: "color", name: "brand", value: undefined }]),
        /Operation 0 \(create_token\) is invalid: value:/
    );
});

test("set_plugin_data without a value is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "set_plugin_data", target: "shape", id: SHAPE, namespace: "ns", key: "k" }]),
        /Operation 0 \(set_plugin_data\) is invalid: value:/
    );
});

test("set_flex_layout checks the padding sides", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "set_flex_layout",
                    pageId: PAGE,
                    id: BOARD,
                    layoutPadding: { p1: 1, p2: 1, p3: 1 },
                },
            ]),
        /Operation 0 \(set_flex_layout\) is invalid: layoutPadding\.p4:/
    );
});

test("set_flex_layout rejects an unknown flex direction", () => {
    assert.throws(
        () => validator.validate([{ op: "set_flex_layout", pageId: PAGE, id: BOARD, layoutFlexDir: "diagonal" }]),
        /Operation 0 \(set_flex_layout\) is invalid: layoutFlexDir:/
    );
});

test("set_grid_layout accepts track types and rejects an unknown one", () => {
    const valid = {
        op: "set_grid_layout",
        pageId: PAGE,
        id: BOARD,
        layoutGridRows: [{ type: "fixed", value: 100 }, { type: "auto" }],
    };
    assert.deepEqual(validator.validate([valid]), [valid]);
    assert.throws(
        () =>
            validator.validate([
                { op: "set_grid_layout", pageId: PAGE, id: BOARD, layoutGridRows: [{ type: "huge" }] },
            ]),
        /Operation 0 \(set_grid_layout\) is invalid: layoutGridRows\.0\.type:/
    );
});

test("set_text_style rejects a font size that is neither a string nor a number", () => {
    assert.throws(
        () => validator.validate([{ op: "set_text_style", pageId: PAGE, id: SHAPE, attrs: { fontSize: true } }]),
        /Operation 0 \(set_text_style\) is invalid: attrs\.fontSize:/
    );
});

test("update_page accepts a null background token", () => {
    const operation = { op: "update_page", id: PAGE, backgroundToken: null };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("rename_component accepts an empty name, as the compiler does", () => {
    const operation = { op: "rename_component", componentId: SHAPE, name: "" };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("align rejects an axis outside the six alignment values", () => {
    assert.throws(
        () => validator.validate([{ op: "align", pageId: PAGE, ids: [SHAPE, SHAPE_2], axis: "middle" }]),
        /Operation 0 \(align\) is invalid: axis:/
    );
});

test("instantiate_component accepts overrides by name and by path", () => {
    const operation = {
        op: "instantiate_component",
        pageId: PAGE,
        componentId: COMPONENT,
        x: 0,
        y: 0,
        overrides: [
            { name: "Label", characters: "Save" },
            { path: "Button / Icon", props: { opacity: 0.5 } },
        ],
    };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("an override name that is not a string is rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "instantiate_component",
                    pageId: PAGE,
                    componentId: COMPONENT,
                    x: 0,
                    y: 0,
                    overrides: [{ name: 5 }],
                },
            ]),
        /Operation 0 \(instantiate_component\) is invalid: overrides\.0\.name:/
    );
});

test("override props that are not an object are rejected", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "instantiate_component",
                    pageId: PAGE,
                    componentId: COMPONENT,
                    x: 0,
                    y: 0,
                    overrides: [{ name: "Label", props: "opacity" }],
                },
            ]),
        /Operation 0 \(instantiate_component\) is invalid: overrides\.0\.props:/
    );
});

test("create_token takes a DTCG type name", () => {
    const operation = { op: "create_token", setId: SHAPE, type: "borderRadius", name: "radius.card", value: 8 };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

test("create_token with a type that is not a string is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "create_token", setId: SHAPE, type: 5, name: "brand", value: "#fff" }]),
        /Operation 0 \(create_token\) is invalid: type:/
    );
});

test("a negative index on a create operation is rejected", () => {
    assert.throws(
        () => validator.validate([{ op: "create_rect", pageId: PAGE, index: -1, x: 0, y: 0, width: 1, height: 1 }]),
        /Operation 0 \(create_rect\) is invalid: index:/
    );
});

test("reorder takes the full list of child ids in visual order", () => {
    const operation = { op: "reorder", pageId: PAGE, parentId: BOARD, ids: [SHAPE_2, SHAPE] };
    assert.deepEqual(validator.validate([operation]), [operation]);
});

const REPLACE_FONT = { op: "replace_font", pageId: PAGE, fromFontId: "gfont-access-sans", toFontId: "custom-1" };

test("replace_font accepts the required parameters alone and with every option", () => {
    assert.deepEqual(validator.validate([REPLACE_FONT]), [REPLACE_FONT]);
    const full = { ...REPLACE_FONT, rootIds: [SHAPE, "$tmp:board"], variantMatch: "nearest", maxTexts: 2000 };
    assert.deepEqual(validator.validate([full]), [full]);
});

test("replace_font rejects a missing target font", () => {
    assert.throws(
        () => validator.validate([{ op: "replace_font", pageId: PAGE, fromFontId: "gfont-access-sans" }]),
        /Operation 0 \(replace_font\) is invalid: toFontId:/
    );
});

test("replace_font rejects a variantMatch that is neither exact nor nearest", () => {
    assert.throws(
        () => validator.validate([{ ...REPLACE_FONT, variantMatch: "closest" }]),
        /Operation 0 \(replace_font\) is invalid: variantMatch:/
    );
});

test("replace_font keeps maxTexts between 1 and 2000", () => {
    for (const maxTexts of [0, 2001, 1.5]) {
        assert.throws(
            () => validator.validate([{ ...REPLACE_FONT, maxTexts }]),
            /Operation 0 \(replace_font\) is invalid: maxTexts:/
        );
    }
    assert.deepEqual(validator.validate([{ ...REPLACE_FONT, maxTexts: 1 }]), [{ ...REPLACE_FONT, maxTexts: 1 }]);
});

test("replace_font takes between 1 and 500 root ids", () => {
    const tooMany = Array.from({ length: 501 }, () => SHAPE);
    for (const rootIds of [[], tooMany]) {
        assert.throws(
            () => validator.validate([{ ...REPLACE_FONT, rootIds }]),
            /Operation 0 \(replace_font\) is invalid: rootIds:/
        );
    }
});

test("replace_font rejects an empty font id", () => {
    assert.throws(
        () => validator.validate([{ ...REPLACE_FONT, fromFontId: "" }]),
        /Operation 0 \(replace_font\) is invalid: fromFontId:/
    );
});

test("update_shape refuses a flip and names the key", () => {
    for (const key of ["flipX", "flipY", "flip-x"]) {
        assert.throws(
            () => validator.validate([{ op: "update_shape", pageId: PAGE, id: SHAPE, props: { [key]: true } }]),
            (error: Error) => {
                assert.match(error.message, /Operation 0 \(update_shape\) is invalid/);
                assert.ok(error.message.includes(`props.${key}: ${key} cannot be set`));
                assert.match(error.message, /a flip cannot be set through this operation/);
                return true;
            }
        );
    }
});

test("a create operation refuses a flip in its props, and accepts other props", () => {
    for (const op of ["create_rect", "create_ellipse", "create_board", "create_path"]) {
        const base = { op, pageId: PAGE, x: 0, y: 0, width: 10, height: 10, d: "M0 0 L10 10 Z" };
        assert.throws(
            () => validator.validate([{ ...base, props: { flipY: true } }]),
            /props\.flipY: flipY cannot be set: a flip cannot be set through this operation/
        );
        assert.deepEqual(validator.validate([{ ...base, props: { opacity: 0.5, strokes: [] } }]).length, 1);
    }
});

test("a create operation refuses rotation in its props, and update_shape accepts it", () => {
    for (const op of ["create_rect", "create_ellipse", "create_board", "create_path"]) {
        const base = { op, pageId: PAGE, x: 0, y: 0, width: 10, height: 10, d: "M0 0 L10 10 Z" };
        assert.throws(
            () => validator.validate([{ ...base, props: { rotation: 45 } }]),
            /props\.rotation: props cannot set rotation on a create operation/
        );
    }
    assert.equal(
        validator.validate([{ op: "update_shape", pageId: PAGE, id: SHAPE, props: { rotation: 45 } }]).length,
        1
    );
});

test("props refuse a page id in a create operation, update_shape and a component override", () => {
    for (const key of ["pageId", "page-id"]) {
        const message = new RegExp(`props\.${key}: props cannot set the structural key ${key}`);
        assert.throws(() => validator.validate([{ op: "create_rect", pageId: PAGE, props: { [key]: PAGE } }]), message);
        assert.throws(
            () => validator.validate([{ op: "update_shape", pageId: PAGE, id: SHAPE, props: { [key]: PAGE } }]),
            message
        );
        assert.throws(
            () =>
                validator.validate([
                    {
                        op: "instantiate_component",
                        pageId: PAGE,
                        componentId: COMPONENT,
                        x: 0,
                        y: 0,
                        overrides: [{ name: "Label", props: { [key]: PAGE } }],
                    },
                ]),
            message
        );
    }
});

test("a component override refuses a flip in its props", () => {
    assert.throws(
        () =>
            validator.validate([
                {
                    op: "instantiate_component",
                    pageId: PAGE,
                    componentId: COMPONENT,
                    x: 0,
                    y: 0,
                    overrides: [{ name: "Label", props: { flipX: true } }],
                },
            ]),
        /flipX cannot be set/
    );
});
