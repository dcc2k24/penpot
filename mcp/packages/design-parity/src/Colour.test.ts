import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseHex, parseCssColour, sameColour, toCssRgba } from "./Colour.js";

describe("normaliseHex", () => {
    it("expands a 3 digit colour", () => {
        assert.deepEqual(normaliseHex("#abc"), { hex: "#AABBCC", alpha: 1 });
    });

    it("reads a 6 digit colour in upper case", () => {
        assert.deepEqual(normaliseHex("#11aa33"), { hex: "#11AA33", alpha: 1 });
    });

    it("reads the alpha of an 8 digit colour, rounded to three decimals", () => {
        assert.deepEqual(normaliseHex("#11223380"), { hex: "#112233", alpha: 0.502 });
    });
});

describe("parseCssColour", () => {
    it("parses an rgb() colour", () => {
        assert.deepEqual(parseCssColour("rgb(255, 0, 16)"), { hex: "#FF0010", alpha: 1 });
    });

    it("parses an rgba() colour with its alpha", () => {
        assert.deepEqual(parseCssColour("rgba(0, 0, 0, 0.5)"), { hex: "#000000", alpha: 0.5 });
    });

    it("parses a hex colour", () => {
        assert.deepEqual(parseCssColour("#abcdef"), { hex: "#ABCDEF", alpha: 1 });
    });

    it("parses transparent as alpha 0", () => {
        assert.deepEqual(parseCssColour("transparent"), { hex: "#000000", alpha: 0 });
    });
});

describe("sameColour", () => {
    it("treats alphas 0.0004 apart as the same", () => {
        assert.equal(sameColour({ hex: "#FFFFFF", alpha: 0.5 }, { hex: "#FFFFFF", alpha: 0.5004 }), true);
    });

    it("treats alphas 0.1 apart as different", () => {
        assert.equal(sameColour({ hex: "#FFFFFF", alpha: 0.5 }, { hex: "#FFFFFF", alpha: 0.6 }), false);
    });

    it("treats different hex values as different", () => {
        assert.equal(sameColour({ hex: "#FFFFFF", alpha: 1 }, { hex: "#FFFFFE", alpha: 1 }), false);
    });
});

describe("toCssRgba", () => {
    it("formats a colour as an rgba() value", () => {
        assert.equal(toCssRgba({ hex: "#FF8000", alpha: 0.5 }), "rgba(255, 128, 0, 0.5)");
    });
});
