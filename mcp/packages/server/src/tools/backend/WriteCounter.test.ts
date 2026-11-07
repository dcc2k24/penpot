import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteCounter } from "./WriteCounter";

test("a write moves a file's count up, and files count separately", () => {
    const counter = new WriteCounter(10);
    const before = counter.countOf("a");
    counter.recordWrite("a");
    const afterA = counter.countOf("a");
    counter.recordWrite("b");
    assert.ok(afterA > before);
    assert.notEqual(counter.countOf("b"), afterA);
    assert.equal(counter.countOf("a"), afterA, "a write to b leaves a alone");
});

test("the table never holds more files than its limit", () => {
    const counter = new WriteCounter(3);
    for (let index = 0; index < 50; index++) {
        counter.recordWrite(`file-${index}`);
    }
    // the newest files are still known; the oldest read as the floor, which is above their old counts
    assert.ok(counter.countOf("file-49") > counter.countOf("file-0"));
    assert.equal((counter as unknown as { counts: Map<string, number> }).counts.size, 3);
});

test("an evicted file does not read as the count it had before it was evicted", () => {
    const counter = new WriteCounter(2);
    counter.recordWrite("a");
    const oldCountOfA = counter.countOf("a");
    counter.recordWrite("b");
    counter.recordWrite("c");
    assert.notEqual(counter.countOf("a"), oldCountOfA);
});

test("a file that was never written reads as zero until the first eviction", () => {
    const counter = new WriteCounter(5);
    assert.equal(counter.countOf("unknown"), 0);
});
