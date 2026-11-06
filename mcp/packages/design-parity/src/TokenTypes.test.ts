import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESIGN_SPEC } from "./DesignSpec.js";
import { backendTokenType } from "./TokenTypes.js";

describe("backendTokenType", () => {
    it("maps the camel case spec types to the backend names", () => {
        assert.equal(backendTokenType("borderRadius"), "border-radius");
        assert.equal(backendTokenType("fontSizes"), "font-size");
        assert.equal(backendTokenType("lineHeights"), "number");
    });

    it("keeps the color, spacing and number types as they are", () => {
        assert.equal(backendTokenType("color"), "color");
        assert.equal(backendTokenType("spacing"), "spacing");
        assert.equal(backendTokenType("number"), "number");
    });

    it("throws on a type that is not in the table", () => {
        assert.throws(() => backendTokenType("fontFamilies"), /fontFamilies/);
        assert.throws(() => backendTokenType(""), Error);
    });

    it("throws on a backend name, because the spec uses camel case only", () => {
        assert.throws(() => backendTokenType("border-radius"), Error);
    });

    it("maps every token type of the design spec", () => {
        for (const token of DESIGN_SPEC.tokens) {
            assert.doesNotThrow(() => backendTokenType(token.type), `token ${token.name}`);
        }
    });
});
