import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonNestingDepth } from "./JsonDepth";

test("a scalar has depth 0, and each level of object or array adds one", () => {
    assert.equal(jsonNestingDepth(5, 64), 0);
    assert.equal(jsonNestingDepth({ a: 1 }, 64), 1);
    assert.equal(jsonNestingDepth([[[]]], 64), 3);
    assert.equal(jsonNestingDepth({ a: [{ b: { c: 1 } }] }, 64), 4);
});

test("a value nested beyond the limit reports the limit plus one, and the walk stops early", () => {
    let value: unknown = 1;
    for (let i = 0; i < 10_000; i++) {
        value = { child: value };
    }
    assert.equal(jsonNestingDepth(value, 64), 65);
});

test("a value at exactly the limit is not beyond it", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 64; i++) {
        value = [value];
    }
    assert.equal(jsonNestingDepth(value, 64), 64);
});
