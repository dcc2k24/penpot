import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NodeModel, StrokeModel, TextModel } from "../DesignModel.js";
import { collectText, compareNodeStyles, expectedDomText, parseBoxShadow, type MeasuredNode } from "./Tolerance.js";

const ORIGIN = { x: 100, y: 200 };

/**
 * Builds a red rectangle at (110, 220) with every field present.
 *
 * @param overrides - fields to replace
 */
function rectNode(overrides: Partial<NodeModel> = {}): NodeModel {
    return {
        id: "n1",
        name: "Box",
        type: "rect",
        parentId: null,
        x: 110,
        y: 220,
        width: 100,
        height: 60,
        rotation: 0,
        hidden: false,
        opacity: 1,
        fills: [{ hex: "#FF0000", opacity: 1 }],
        strokes: [],
        radius: null,
        layout: null,
        layoutItem: null,
        text: null,
        component: null,
        children: [],
        ...overrides,
    };
}

/**
 * Builds the browser measurement of the red rectangle, which matches rectNode.
 *
 * @param overrides - fields to replace
 */
function measuredRect(overrides: Partial<MeasuredNode> = {}): MeasuredNode {
    return {
        id: "n1",
        name: "Box",
        relLeft: 10,
        relTop: 20,
        width: 100,
        height: 60,
        backgroundColor: "rgb(255, 0, 0)",
        boxShadow: "none",
        radiusTl: "0px",
        radiusTr: "0px",
        radiusBr: "0px",
        radiusBl: "0px",
        opacity: "1",
        text: "",
        fontSize: "",
        fontFamily: "",
        fontWeight: "",
        lineHeight: "",
        letterSpacing: "",
        textAlign: "",
        color: "rgb(0, 0, 0)",
        ...overrides,
    };
}

/**
 * Builds a text node "Hello" in Source Sans Pro, 16 px, which matches textMeasured.
 *
 * @param overrides - fields to replace
 */
function textNode(overrides: Partial<NodeModel> = {}): NodeModel {
    return rectNode({
        type: "text",
        fills: [],
        text: {
            characters: "Hello",
            fontFamily: "Source Sans Pro",
            fontSize: 16,
            fontWeight: "400",
            lineHeight: 1.5,
            paragraphLineHeight: 1.5,
            letterSpacing: 0,
            textAlign: "left",
            verticalAlign: null,
            fill: "#000000",
        },
        ...overrides,
    });
}

/**
 * Builds the text node of textNode with some of the text fields replaced.
 *
 * @param fields - text fields to replace
 */
function textNodeWith(fields: Partial<TextModel>): NodeModel {
    const base = textNode().text;
    return textNode({ text: base === null ? null : { ...base, ...fields } });
}

/**
 * Builds a red rectangle with a stroke of the given width and alignment, in the colour #FF0000.
 *
 * @param width - width of the stroke in pixels
 * @param alignment - alignment of the stroke, or null when the design gives none
 */
function strokedRect(width: number, alignment: StrokeModel["alignment"]): NodeModel {
    return rectNode({ strokes: [{ hex: "#FF0000", opacity: 1, width, alignment }] });
}

/**
 * Lists the box shadow that the browser reports for a red stroke of the given spreads, inset or outer.
 *
 * @param layers - shadows as [inset, spread] pairs
 */
function shadowText(layers: [boolean, number][]): string {
    return layers.map(([inset, spread]) => `rgb(255, 0, 0) 0px 0px 0px ${spread}px${inset ? " inset" : ""}`).join(", ");
}

/**
 * Builds the browser measurement of the text node, which matches textNode.
 *
 * @param overrides - fields to replace
 */
function textMeasured(overrides: Partial<MeasuredNode> = {}): MeasuredNode {
    return measuredRect({
        backgroundColor: "rgba(0, 0, 0, 0)",
        text: "Hello",
        fontSize: "16px",
        fontFamily: '"sourcesanspro"',
        fontWeight: "400",
        lineHeight: "24px",
        letterSpacing: "normal",
        textAlign: "left",
        color: "rgb(0, 0, 0)",
        ...overrides,
    });
}

describe("compareNodeStyles", () => {
    it("gives no findings for an exact match", () => {
        assert.deepEqual(compareNodeStyles(rectNode(), measuredRect(), ORIGIN), []);
    });

    it("gives one x mismatch when x is off by 0.6", () => {
        const findings = compareNodeStyles(rectNode(), measuredRect({ relLeft: 10.6 }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "x");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("gives no findings when x is off by 0.4", () => {
        assert.deepEqual(compareNodeStyles(rectNode(), measuredRect({ relLeft: 10.4 }), ORIGIN), []);
    });

    it("gives a background-color mismatch when one channel is off", () => {
        const findings = compareNodeStyles(rectNode(), measuredRect({ backgroundColor: "rgb(254, 0, 0)" }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "background-color");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("passes an ellipse whose corners are all 50%", () => {
        const node = rectNode({ type: "ellipse", radius: null });
        const measured = measuredRect({ radiusTl: "50%", radiusTr: "50%", radiusBr: "50%", radiusBl: "50%" });
        assert.deepEqual(compareNodeStyles(node, measured, ORIGIN), []);
    });

    it("passes an ellipse of 100x60 with 50px on tl and 30px on the other corners", () => {
        const node = rectNode({ type: "ellipse", radius: null });
        const measured = measuredRect({ radiusTl: "50px", radiusTr: "30px", radiusBr: "30px", radiusBl: "30px" });
        assert.deepEqual(compareNodeStyles(node, measured, ORIGIN), []);
    });

    it("gives an info, not a mismatch, for a text width difference", () => {
        const findings = compareNodeStyles(textNode(), textMeasured({ width: 105 }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "width");
        assert.equal(findings[0]?.kind, "info");
    });

    it("gives a text mismatch when the content differs", () => {
        const findings = compareNodeStyles(textNode(), textMeasured({ text: "Hi" }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "text");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("gives a font-family mismatch when the family is not in FONT_FAMILY_CSS", () => {
        const node = textNode();
        const text = node.text;
        assert.notEqual(text, null);
        const comic = textNode({ text: text === null ? null : { ...text, fontFamily: "Comic Sans" } });
        const findings = compareNodeStyles(comic, textMeasured(), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "font-family");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("passes a font family that the browser reports without quotes", () => {
        const measured = textMeasured({ fontFamily: "sourcesanspro" });
        assert.deepEqual(compareNodeStyles(textNode(), measured, ORIGIN), []);
    });

    it("passes a 12 px text whose span is 16.8px, from a paragraph line height of 1.4", () => {
        const node = textNodeWith({ fontSize: 12, paragraphLineHeight: 1.4, lineHeight: 1.5 });
        const measured = textMeasured({ fontSize: "12px", lineHeight: "16.8px" });
        assert.deepEqual(compareNodeStyles(node, measured, ORIGIN), []);
    });

    it("gives a line-height mismatch when the span is 24px and the design expects 16.8px", () => {
        const node = textNodeWith({ fontSize: 12, paragraphLineHeight: 1.4, lineHeight: 1.5 });
        const measured = textMeasured({ fontSize: "12px", lineHeight: "24px" });
        const findings = compareNodeStyles(node, measured, ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "line-height");
        assert.equal(findings[0]?.kind, "mismatch");
        assert.equal(findings[0]?.design, "16.8px");
    });

    it("falls back to the text line height when the paragraph line height is null", () => {
        const node = textNodeWith({ paragraphLineHeight: null, lineHeight: 1.5 });
        assert.deepEqual(compareNodeStyles(node, textMeasured({ lineHeight: "24px" }), ORIGIN), []);
    });

    it("accepts a line height 0.04 px away and rejects one 0.06 px away", () => {
        const node = textNodeWith({ fontSize: 12, paragraphLineHeight: 1.4, lineHeight: 1.5 });
        const near = compareNodeStyles(node, textMeasured({ fontSize: "12px", lineHeight: "16.84px" }), ORIGIN);
        assert.deepEqual(near, []);
        const far = compareNodeStyles(node, textMeasured({ fontSize: "12px", lineHeight: "16.86px" }), ORIGIN);
        assert.equal(far.length, 1);
        assert.equal(far[0]?.attribute, "line-height");
    });

    it("gives a line-height mismatch when the span reports normal", () => {
        const findings = compareNodeStyles(textNode(), textMeasured({ lineHeight: "normal" }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "line-height");
    });

    it("passes an empty text node whose leaf shows a no-break space", () => {
        const node = textNodeWith({ characters: "" });
        assert.deepEqual(compareNodeStyles(node, textMeasured({ text: " " }), ORIGIN), []);
    });

    it("gives no stroke finding for a centred 1px stroke drawn as two half-width shadows", () => {
        const measured = measuredRect({
            boxShadow: shadowText([
                [true, 0.5],
                [false, 0.5],
            ]),
        });
        assert.deepEqual(compareNodeStyles(strokedRect(1, "center"), measured, ORIGIN), []);
    });

    it("gives no stroke finding for an inner 2px stroke drawn as one inset shadow", () => {
        const measured = measuredRect({ boxShadow: shadowText([[true, 2]]) });
        assert.deepEqual(compareNodeStyles(strokedRect(2, "inner"), measured, ORIGIN), []);
    });

    it("gives a stroke-width mismatch when the outer shadow is 2px and the design says 1px", () => {
        const measured = measuredRect({ boxShadow: shadowText([[false, 2]]) });
        const findings = compareNodeStyles(strokedRect(1, "outer"), measured, ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "stroke-width");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("gives a stroke-colour mismatch when the shadow colour differs", () => {
        const measured = measuredRect({ boxShadow: "rgb(0, 0, 255) 0px 0px 0px 1px" });
        const findings = compareNodeStyles(strokedRect(1, "outer"), measured, ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "stroke-colour");
        assert.equal(findings[0]?.kind, "mismatch");
    });

    it("gives a stroke-width mismatch when a node without a stroke has a shadow", () => {
        const findings = compareNodeStyles(rectNode(), measuredRect({ boxShadow: shadowText([[false, 1]]) }), ORIGIN);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.attribute, "stroke-width");
    });
});

describe("collectText", () => {
    it("gives the text of one leaf", () => {
        assert.equal(collectText(["Hello"], ""), "Hello");
    });

    it("joins the leaves in document order", () => {
        assert.equal(collectText(["Hel", "lo"], ""), "Hello");
    });

    it("keeps the own text when the element has no leaves", () => {
        assert.equal(collectText([], "Plain"), "Plain");
    });

    it("keeps a no-break space leaf as it is", () => {
        assert.equal(collectText([" "], ""), " ");
    });
});

describe("expectedDomText", () => {
    it("gives the characters as they are", () => {
        assert.equal(expectedDomText("Hi"), "Hi");
    });

    it("gives a no-break space for empty characters", () => {
        assert.equal(expectedDomText(""), " ");
    });
});

describe("parseBoxShadow", () => {
    it("reads none as an empty list", () => {
        assert.deepEqual(parseBoxShadow("none"), []);
    });

    it("reads a centred stroke as an inset and an outer shadow, with commas inside rgb()", () => {
        const layers = parseBoxShadow("rgb(255, 0, 0) 0px 0px 0px 0.5px inset, rgb(255, 0, 0) 0px 0px 0px 0.5px");
        assert.deepEqual(layers, [
            { colour: "rgb(255, 0, 0)", inset: true, spread: 0.5 },
            { colour: "rgb(255, 0, 0)", inset: false, spread: 0.5 },
        ]);
    });

    it("reads an rgba colour and a negative spread", () => {
        const layers = parseBoxShadow("rgba(0, 0, 0, 0.5) 0px 0px 0px -1px");
        assert.deepEqual(layers, [{ colour: "rgba(0, 0, 0, 0.5)", inset: false, spread: -1 }]);
    });

    it("returns null for a value that is not a box shadow", () => {
        assert.equal(parseBoxShadow("solid"), null);
        assert.equal(parseBoxShadow(""), null);
        assert.equal(parseBoxShadow("rgb(255, 0, 0) 0px 0px 1px"), null);
    });
});
