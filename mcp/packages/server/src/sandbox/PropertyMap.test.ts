import assert from "node:assert/strict";
import { test } from "node:test";
import { PropertyMap, type PropertyEntry } from "./PropertyMap";

const BACKEND_TYPES: Record<string, string> = {
    frame: "board",
    rect: "rectangle",
    circle: "ellipse",
    text: "text",
    path: "path",
    bool: "boolean",
    group: "group",
    image: "image",
    "svg-raw": "svg-raw",
};

test("every backend type maps to a plugin type and back", () => {
    for (const [backendType, pluginType] of Object.entries(BACKEND_TYPES)) {
        assert.equal(PropertyMap.pluginTypeOf(backendType), pluginType);
        assert.equal(PropertyMap.backendTypeOf(pluginType), backendType);
        assert.equal(PropertyMap.backendTypeOf(PropertyMap.pluginTypeOf(backendType)), backendType);
    }
});

test("unknown backend type throws an error that names it", () => {
    assert.throws(
        () => PropertyMap.pluginTypeOf("nonexistent-type"),
        (error: unknown) => error instanceof Error && error.message.includes("nonexistent-type")
    );
});

test("unknown plugin type throws an error that names it", () => {
    assert.throws(
        () => PropertyMap.backendTypeOf("hexagon"),
        (error: unknown) => error instanceof Error && error.message.includes("hexagon")
    );
});

test("every property entry has a valid attr, access and kind", () => {
    const accessValues = new Set(["read", "write", "read-write"]);
    const kindValues = new Set(["attr", "geometry", "derived", "content", "unsupported"]);

    for (const [name, entry] of Object.entries(PropertyMap.PROPERTIES)) {
        assert.ok(entry.attr.length > 0, `${name} has an empty attr`);
        assert.ok(accessValues.has(entry.access), `${name} has access ${entry.access}`);
        assert.ok(kindValues.has(entry.kind), `${name} has kind ${entry.kind}`);
    }
});

test("invert is only set on attr entries", () => {
    for (const [name, entry] of Object.entries(PropertyMap.PROPERTIES)) {
        if (entry.invert !== undefined) {
            assert.equal(entry.kind, "attr", `${name} sets invert but has kind ${entry.kind}`);
        }
    }
});

test("inverted entries name the backend attribute exactly", () => {
    assert.deepEqual(PropertyMap.PROPERTIES.visible, {
        attr: "hidden",
        access: "read-write",
        kind: "attr",
        invert: true,
    });
    assert.deepEqual(PropertyMap.PROPERTIES.showInViewMode, {
        attr: "hideInViewer",
        access: "read-write",
        kind: "attr",
        invert: true,
    });
    assert.deepEqual(PropertyMap.PROPERTIES.clipContent, {
        attr: "showContent",
        access: "read-write",
        kind: "attr",
        invert: true,
    });
});

test("toJsonTable returns equal JSON on repeated calls", () => {
    const first = JSON.stringify(PropertyMap.toJsonTable());
    const second = JSON.stringify(PropertyMap.toJsonTable());
    assert.equal(first, second);
});

test("mutating toJsonTable output does not change the static tables", () => {
    const before = JSON.stringify(PropertyMap.PROPERTIES);
    const beforeTypes = JSON.stringify(PropertyMap.TYPES);

    const table = PropertyMap.toJsonTable();
    table.properties.x.attr = "changed";
    table.properties.visible.invert = false;
    table.properties.newProperty = { attr: "x", access: "read", kind: "attr" } as PropertyEntry;
    table.types.frame = "changed";

    assert.equal(JSON.stringify(PropertyMap.PROPERTIES), before);
    assert.equal(JSON.stringify(PropertyMap.TYPES), beforeTypes);
    assert.equal(PropertyMap.pluginTypeOf("frame"), "board");
});

test("sample of properties maps to verified backend attributes", () => {
    const expected: Record<string, string> = {
        x: "x",
        y: "y",
        rotation: "rotation",
        fills: "fills",
        strokes: "strokes",
        shadows: "shadow",
        borderRadiusTopLeft: "r1",
        borderRadiusTopRight: "r2",
        borderRadiusBottomRight: "r3",
        borderRadiusBottomLeft: "r4",
        constraintsHorizontal: "constraintsH",
        constraintsVertical: "constraintsV",
        fixedWhenScrolling: "fixedScroll",
        proportionLock: "proportionLock",
        blendMode: "blendMode",
        opacity: "opacity",
        hidden: "hidden",
        blocked: "blocked",
        exports: "exports",
        growType: "growType",
        horizontalSizing: "layoutItemHSizing",
        alignSelf: "layoutItemAlignSelf",
        guides: "grids",
        characters: "characters",
        fontSize: "fontSize",
    };

    for (const [name, attr] of Object.entries(expected)) {
        assert.equal(PropertyMap.PROPERTIES[name]?.attr, attr, `attr of ${name}`);
    }
});

test("shadows maps to the backend shadow attribute", () => {
    assert.equal(PropertyMap.PROPERTIES.shadows.attr, "shadow");
    assert.equal(PropertyMap.PROPERTIES.shadows.kind, "attr");
});

test("geometry properties use the geometry kind", () => {
    for (const name of ["x", "y", "width", "height", "rotation"]) {
        assert.equal(PropertyMap.PROPERTIES[name].kind, "geometry", name);
    }
});

test("text typography properties use the content kind", () => {
    for (const name of ["characters", "fontSize", "fontFamily", "lineHeight"]) {
        assert.equal(PropertyMap.PROPERTIES[name].kind, "content", name);
    }
});
