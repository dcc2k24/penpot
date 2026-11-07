import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
    assertCovered,
    FieldCoverage,
    observeTree,
    SERVER_ADDED_FIELDS,
    SHAPE_FIELDS,
    TREE_FIELDS,
} from "./PullFields.js";

/**
 * Names of the attributes that the Normaliser reads from a variable, for example `shape.fills` gives fills.
 *
 * @param source - source text of the Normaliser
 * @param variable - name of the variable the reads go through
 */
function attributesRead(source: string, variable: string): Set<string> {
    const pattern = new RegExp("(?:^|[^A-Za-z0-9_])" + variable + "[.]([A-Za-z][A-Za-z0-9]*)", "g");
    return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Attribute keys written as `[:name` in a schema source: a map key of a malli form. The name is lowercase, with
 * dashes, and ends at a space or a closing bracket.
 *
 * @param source - Clojure source text of a schema file
 */
function schemaKeys(source: string): Set<string> {
    const keys = new Set<string>();
    let index = source.indexOf("[:");
    while (index >= 0) {
        let end = index + 2;
        while (end < source.length && /[a-z0-9-]/.test(source[end])) {
            end++;
        }
        const name = source.slice(index + 2, end);
        const after = source[end];
        if (name !== "" && /[a-z]/.test(name[0]) && (after === " " || after === "]")) {
            keys.add(name);
        }
        index = source.indexOf("[:", end);
    }
    return keys;
}

/**
 * Converts a camelCase field name to the kebab-case name that the backend takes, as the adapter does.
 *
 * @param name - field name in camelCase
 */
function toKebab(name: string): string {
    return name.replace(/[A-Z]/g, (letter, offset: number) =>
        offset === 0 ? letter.toLowerCase() : "-" + letter.toLowerCase()
    );
}

const NORMALISER = readFileSync(new URL("./Normaliser.ts", import.meta.url), "utf8");
const PULLER = readFileSync(new URL("./Puller.ts", import.meta.url), "utf8");
const COMMON_TYPES = new URL("../../../../common/src/app/common/types/", import.meta.url);

/** Attribute keys of the shape schemas: shape.cljc and every file of shape/. */
function shapeSchemaKeys(): Set<string> {
    const keys = schemaKeys(readFileSync(new URL("shape.cljc", COMMON_TYPES), "utf8"));
    for (const file of readdirSync(new URL("shape/", COMMON_TYPES))) {
        if (file.endsWith(".cljc")) {
            for (const key of schemaKeys(readFileSync(new URL("shape/" + file, COMMON_TYPES), "utf8"))) {
                keys.add(key);
            }
        }
    }
    return keys;
}

/** Attributes the backend accepts by name: the schema keys, plus content and position-data. */
function acceptedByBackend(): Set<string> {
    return new Set([...shapeSchemaKeys(), "content", "position-data"]);
}

describe("requested fields exist in the shape schema", () => {
    it("the scan finds attributes the schema declares, including a layout item attribute", () => {
        const keys = shapeSchemaKeys();
        assert.ok(keys.has("fills") && keys.has("layout-item-h-sizing"), "the schema scan finds known attributes");
    });

    it("every shape field, kebab-cased, is a shape attribute, content or position-data", () => {
        const accepted = acceptedByBackend();
        const unknown = SHAPE_FIELDS.filter((field) => !accepted.has(toKebab(field)));
        assert.deepEqual(unknown, [], "the backend would refuse these names");
    });

    it("every tree field, kebab-cased, is a shape attribute, content or position-data", () => {
        const accepted = acceptedByBackend();
        const unknown = TREE_FIELDS.filter((field) => !accepted.has(toKebab(field)));
        assert.deepEqual(unknown, [], "the backend would refuse these names");
    });

    it("the layout item sizing is requested under its real names, not the derived ones", () => {
        assert.ok(SHAPE_FIELDS.includes("layoutItemHSizing") && SHAPE_FIELDS.includes("layoutItemVSizing"));
        assert.ok(!SHAPE_FIELDS.includes("hSizing") && !SHAPE_FIELDS.includes("vSizing"));
    });

    it("the server-added fields are not requested", () => {
        for (const field of SERVER_ADDED_FIELDS) {
            assert.equal(SHAPE_FIELDS.includes(field), false, field);
            assert.equal(TREE_FIELDS.includes(field), false, field);
        }
    });
});

describe("field lists of the puller", () => {
    it("ask get_shapes for every shape attribute the Normaliser reads", () => {
        const read = attributesRead(NORMALISER, "shape");
        assert.ok(read.has("fills") && read.has("content"), "the scan finds the attributes");
        const missing = [...read].filter((name) => !SHAPE_FIELDS.includes(name) && !SERVER_ADDED_FIELDS.includes(name));
        assert.deepEqual(missing, [], "every attribute the Normaliser reads must be in SHAPE_FIELDS");
    });

    it("ask get_page_tree for every tree attribute the Normaliser reads", () => {
        const read = attributesRead(NORMALISER, "treeNode");
        assert.ok(read.has("componentId"), "the scan finds the tree attributes");
        const missing = [...read].filter((name) => !TREE_FIELDS.includes(name));
        assert.deepEqual(missing, [], "every attribute the Normaliser reads must be in TREE_FIELDS");
    });

    it("name id and type in both lists, each once", () => {
        for (const list of [SHAPE_FIELDS, TREE_FIELDS]) {
            assert.ok(list.includes("id") && list.includes("type"));
            assert.equal(new Set(list).size, list.length, "no duplicates");
        }
    });

    it("send the lists with the requests", () => {
        assert.ok(PULLER.includes("fields: [...TREE_FIELDS]"));
        assert.ok(PULLER.includes("fields: [...SHAPE_FIELDS]"));
    });
});

describe("FieldCoverage", () => {
    it("reports a field that no entry carried, and not one that some entry carried", () => {
        const coverage = new FieldCoverage(["fills", "strokes"]);
        coverage.observe({ id: "a", fills: [] });
        coverage.observe({ id: "b" });
        assert.deepEqual(coverage.missing(), ["strokes"]);
    });

    it("reports nothing when no entry was seen", () => {
        assert.deepEqual(new FieldCoverage(["fills"]).missing(), []);
    });

    it("assertCovered throws and names the missing fields", () => {
        const coverage = new FieldCoverage(["fills", "fontSize"]);
        coverage.observe({ id: "a" });
        assert.throws(() => assertCovered("get_shapes", coverage), /get_shapes.*fills, fontSize/);
    });

    it("assertCovered passes when every field was carried", () => {
        const coverage = new FieldCoverage(["fills"]);
        coverage.observe({ id: "a", fills: [] });
        assert.doesNotThrow(() => assertCovered("get_shapes", coverage));
    });
});

describe("observeTree", () => {
    it("observes every node below the root, not only the first level", () => {
        const coverage = new FieldCoverage(["componentId"]);
        observeTree({ children: [{ id: "a", children: [{ id: "b", componentId: "c" }] }] }, coverage);
        assert.deepEqual(coverage.missing(), []);
    });
});
