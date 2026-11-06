import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendFieldNames } from "./BackendFieldNames";

const fieldNames = new BackendFieldNames();

test("camelCase field names become kebab-case", () => {
    assert.deepEqual(fieldNames.toBackendFields(["parentId", "componentRoot", "shapeRefId"]), [
        "parent-id",
        "component-root",
        "shape-ref-id",
    ]);
});

test("every capital starts a new word, including runs of capitals", () => {
    assert.deepEqual(fieldNames.toBackendFields(["layoutItemHSizing", "rowGapXY", "URL"]), [
        "layout-item-h-sizing",
        "row-gap-x-y",
        "u-r-l",
    ]);
});

test("kebab-case field names pass through unchanged", () => {
    assert.deepEqual(fieldNames.toBackendFields(["parent-id", "x", "frame-id", "component-root"]), [
        "parent-id",
        "x",
        "frame-id",
        "component-root",
    ]);
});

test("mixed field names keep their order", () => {
    assert.deepEqual(fieldNames.toBackendFields(["id", "frameId", "width", "main-instance"]), [
        "id",
        "frame-id",
        "width",
        "main-instance",
    ]);
});

test("an empty list of field names stays empty", () => {
    assert.deepEqual(fieldNames.toBackendFields([]), []);
});
