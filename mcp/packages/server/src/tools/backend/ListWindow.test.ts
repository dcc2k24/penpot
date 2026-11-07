import assert from "node:assert/strict";
import { test } from "node:test";
import { ListWindow } from "./ListWindow";

test("a list within the default limit is returned whole with an empty note", () => {
    const window = ListWindow.cut([1, 2, 3], undefined, "items");
    assert.deepEqual(window, { items: [1, 2, 3], shown: 3, total: 3, note: "" });
});

test("a list above the default limit keeps the first 100 items and says how many exist", () => {
    const list = Array.from({ length: 250 }, (_, index) => index);
    const window = ListWindow.cut(list, undefined, "comment threads");
    assert.equal(window.shown, 100);
    assert.equal(window.total, 250);
    assert.deepEqual(window.items, list.slice(0, 100));
    assert.match(window.note, /Showing 100 of 250 comment threads/);
});

test("an explicit limit cuts the list to that many items", () => {
    const window = ListWindow.cut(["a", "b", "c"], 2, "files");
    assert.deepEqual(window.items, ["a", "b"]);
    assert.equal(window.shown, 2);
    assert.match(window.note, /Showing 2 of 3 files/);
});
