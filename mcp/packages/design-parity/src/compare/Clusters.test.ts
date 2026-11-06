import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterMask } from "./Clusters.js";

/**
 * Builds a mask from rows of text, where "#" is a different pixel and "." is not.
 * @param rows - rows of the same length
 * @returns the mask, its width and its height
 */
function maskOf(rows: string[]): { mask: Uint8Array; width: number; height: number } {
    const width = rows[0].length;
    const mask = new Uint8Array(width * rows.length);
    rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) {
            mask[y * width + x] = row[x] === "#" ? 1 : 0;
        }
    });
    return { mask, width, height: rows.length };
}

test("clusterMask gives no cluster for an empty mask", () => {
    const { mask, width, height } = maskOf(["...", "...", "..."]);
    assert.deepEqual(clusterMask(mask, width, height), { largest: 0, count: 0 });
});

test("clusterMask counts one isolated pixel as one cluster of size 1", () => {
    const { mask, width, height } = maskOf(["...", ".#.", "..."]);
    assert.deepEqual(clusterMask(mask, width, height), { largest: 1, count: 1 });
});

test("clusterMask joins two diagonal pixels into one cluster (8-neighbour)", () => {
    const { mask, width, height } = maskOf(["#..", ".#.", "..."]);
    assert.deepEqual(clusterMask(mask, width, height), { largest: 2, count: 1 });
});

test("clusterMask keeps a 3x3 block with one pixel removed as one cluster", () => {
    const { mask, width, height } = maskOf(["###", "#.#", "###"]);
    assert.deepEqual(clusterMask(mask, width, height), { largest: 8, count: 1 });
});

test("clusterMask gives the size of the largest and the number of clusters", () => {
    const { mask, width, height } = maskOf(["##..###", "....##."]);
    assert.deepEqual(clusterMask(mask, width, height), { largest: 5, count: 2 });
});

test("clusterMask rejects a mask whose length does not match the size", () => {
    assert.throws(() => clusterMask(new Uint8Array(5), 2, 2), RangeError);
});
