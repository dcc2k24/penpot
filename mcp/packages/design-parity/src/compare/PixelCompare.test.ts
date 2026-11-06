import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { differenceMask, flattenOverWhite, outsideExtent, padToCanvas } from "./PixelCompare.js";
import type { NodeModel, StrokeModel } from "../DesignModel.js";

/**
 * Builds a board node with the given strokes and the rest of its fields empty.
 *
 * @param strokes - strokes of the board, in list order
 */
function boardWithStrokes(strokes: StrokeModel[]): NodeModel {
    return {
        id: "board-1",
        name: "Board",
        type: "board",
        parentId: null,
        x: 0,
        y: 0,
        width: 144,
        height: 40,
        rotation: null,
        hidden: null,
        opacity: null,
        fills: [],
        strokes,
        radius: null,
        layout: null,
        layoutItem: null,
        text: null,
        component: null,
        children: [],
    };
}

/**
 * Builds an 8-bit RGBA image from rows of [r, g, b, a] pixels.
 *
 * @param rows - pixel rows, all of the same length
 */
function makePng(rows: number[][][]): PNG {
    const height = rows.length;
    const width = rows[0].length;
    const png = new PNG({ width, height });
    rows.forEach((row, y) => {
        row.forEach((pixel, x) => {
            png.data.set(pixel, (y * width + x) * 4);
        });
    });
    return png;
}

/**
 * Returns the [r, g, b, a] values of one pixel.
 *
 * @param png - image to read
 * @param x - column
 * @param y - row
 */
function pixelAt(png: PNG, x: number, y: number): number[] {
    const offset = (y * png.width + x) * 4;
    return Array.from(png.data.subarray(offset, offset + 4));
}

describe("flattenOverWhite", () => {
    it("turns a fully transparent pixel into opaque white", () => {
        const flat = flattenOverWhite(makePng([[[10, 20, 30, 0]]]));
        assert.deepEqual(pixelAt(flat, 0, 0), [255, 255, 255, 255]);
    });

    it("composites a half-alpha red pixel over white", () => {
        const flat = flattenOverWhite(makePng([[[255, 0, 0, 128]]]));
        assert.deepEqual(pixelAt(flat, 0, 0), [255, 127, 127, 255]);
    });

    it("keeps an opaque pixel as it is", () => {
        const flat = flattenOverWhite(makePng([[[12, 34, 56, 255]]]));
        assert.deepEqual(pixelAt(flat, 0, 0), [12, 34, 56, 255]);
    });

    it("keeps the size of the image and does not change the input", () => {
        const input = makePng([
            [
                [255, 0, 0, 128],
                [0, 0, 0, 0],
            ],
        ]);
        const flat = flattenOverWhite(input);
        assert.equal(flat.width, 2);
        assert.equal(flat.height, 1);
        assert.deepEqual(pixelAt(input, 1, 0), [0, 0, 0, 0]);
    });
});

describe("padToCanvas", () => {
    it("keeps the original pixels at the top-left and fills the rest with opaque white", () => {
        const input = makePng([
            [
                [1, 2, 3, 255],
                [4, 5, 6, 255],
            ],
            [
                [7, 8, 9, 255],
                [10, 11, 12, 255],
            ],
        ]);
        const padded = padToCanvas(input, 3, 3);
        assert.equal(padded.width, 3);
        assert.equal(padded.height, 3);
        assert.deepEqual(pixelAt(padded, 0, 0), [1, 2, 3, 255]);
        assert.deepEqual(pixelAt(padded, 1, 0), [4, 5, 6, 255]);
        assert.deepEqual(pixelAt(padded, 0, 1), [7, 8, 9, 255]);
        assert.deepEqual(pixelAt(padded, 1, 1), [10, 11, 12, 255]);
        assert.deepEqual(pixelAt(padded, 2, 0), [255, 255, 255, 255]);
        assert.deepEqual(pixelAt(padded, 0, 2), [255, 255, 255, 255]);
        assert.deepEqual(pixelAt(padded, 2, 2), [255, 255, 255, 255]);
    });

    it("throws when the canvas is smaller than the image", () => {
        const input = makePng([
            [
                [1, 2, 3, 255],
                [4, 5, 6, 255],
            ],
        ]);
        assert.throws(() => padToCanvas(input, 1, 1), RangeError);
    });
});

describe("differenceMask", () => {
    it("marks only the pure red pixels", () => {
        const diff = makePng([
            [
                [255, 0, 0, 255],
                [255, 255, 0, 255],
                [128, 128, 128, 255],
                [255, 0, 0, 255],
            ],
        ]);
        assert.deepEqual(Array.from(differenceMask(diff)), [1, 0, 0, 1]);
    });

    it("gives an all-zero mask when no pixel is red", () => {
        const diff = makePng([
            [
                [255, 255, 0, 255],
                [0, 0, 0, 255],
            ],
        ]);
        assert.deepEqual(Array.from(differenceMask(diff)), [0, 0]);
    });
});

describe("outsideExtent", () => {
    it("is 0 when the board has no stroke", () => {
        assert.equal(outsideExtent(boardWithStrokes([])), 0);
    });

    it("is 1 for a centred 1 px stroke", () => {
        const stroke = { hex: "#000000", opacity: 1, width: 1, alignment: "center" as const };
        assert.equal(outsideExtent(boardWithStrokes([stroke])), 1);
    });

    it("is 1 for a centred 2 px stroke", () => {
        const stroke = { hex: "#000000", opacity: 1, width: 2, alignment: "center" as const };
        assert.equal(outsideExtent(boardWithStrokes([stroke])), 1);
    });

    it("is 2 for an outer 2 px stroke", () => {
        const stroke = { hex: "#000000", opacity: 1, width: 2, alignment: "outer" as const };
        assert.equal(outsideExtent(boardWithStrokes([stroke])), 2);
    });

    it("is 0 for an inner 3 px stroke", () => {
        const stroke = { hex: "#000000", opacity: 1, width: 3, alignment: "inner" as const };
        assert.equal(outsideExtent(boardWithStrokes([stroke])), 0);
    });

    it("is 1 for a 1 px stroke with no alignment, which counts as centred", () => {
        const stroke = { hex: "#000000", opacity: 1, width: 1, alignment: null };
        assert.equal(outsideExtent(boardWithStrokes([stroke])), 1);
    });
});
