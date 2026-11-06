/**
 * Tolerance rules that compare one node of the design with the browser measurement of its element.
 *
 * A check that fails on a real difference adds a mismatch. A value that the rules cannot judge adds an info. A check that
 * passes adds nothing. This module is pure: it does no I/O.
 */
import { parseCssColour, sameColour, type Colour } from "../Colour.js";
import type { NodeModel, TextModel } from "../DesignModel.js";
import { cssFontFamily, FONT_FAMILY_CSS, primaryFamilyOf } from "../FontMap.js";

/** Values that the browser reports for the element of one node. */
export interface MeasuredNode {
    /** Id of the node. */
    id: string;
    /** Name of the node. */
    name: string;
    /** Left edge of the element, relative to the board. */
    relLeft: number;
    /** Top edge of the element, relative to the board. */
    relTop: number;
    /** Width of the element. */
    width: number;
    /** Height of the element. */
    height: number;
    /** Computed background colour. */
    backgroundColor: string;
    /** Computed box shadow, for example "none" or a list of shadows. The stroke of the node is drawn with shadows. */
    boxShadow: string;
    /** Computed top left corner radius. */
    radiusTl: string;
    /** Computed top right corner radius. */
    radiusTr: string;
    /** Computed bottom right corner radius. */
    radiusBr: string;
    /** Computed bottom left corner radius. */
    radiusBl: string;
    /** Computed opacity. */
    opacity: string;
    /** Text content of the element. */
    text: string;
    /** Computed font size. */
    fontSize: string;
    /** Computed font family. */
    fontFamily: string;
    /** Computed font weight. */
    fontWeight: string;
    /** Computed line height. */
    lineHeight: string;
    /** Computed letter spacing. */
    letterSpacing: string;
    /** Computed text alignment. */
    textAlign: string;
    /** Computed text colour. */
    color: string;
}

/** One finding of the comparison: a real mismatch, or a value the rules cannot judge. */
export interface Finding {
    /** Name of the compared attribute, for example "x" or "background-color". */
    attribute: string;
    /** Value of the design, as text. */
    design: string;
    /** Value of the implementation, as text. */
    implemented: string;
    /** "mismatch" for a real difference, "info" for a value the rules cannot judge. */
    kind: "mismatch" | "info";
    /** Tolerance that applied to the attribute, as text. */
    tolerance: string;
}

/** One shadow of a computed box-shadow value. */
export interface ShadowLayer {
    /** Colour of the shadow as the browser states it, for example "rgb(255, 0, 0)". */
    readonly colour: string;
    /** True for an inset shadow. */
    readonly inset: boolean;
    /** Spread of the shadow in pixels, which is its fourth length. */
    readonly spread: number;
}

/** Matches the colour function of a shadow part, for example "rgb(255, 0, 0)" or "rgba(0, 0, 0, 0.5)". */
const COLOUR_PATTERN = /rgba?\([^)]*\)/;

/** Matches a length that the browser states, for example "0px", "-1px" or "0.5px". */
const LENGTH_PATTERN = /^-?\d*\.?\d+(px)?$/;

/** Tolerance text of a colour comparison. */
const COLOUR_TOLERANCE = "exact colour, alpha +-0.001";

/** Tolerance text of a text colour comparison. */
const TEXT_COLOUR_TOLERANCE = "exact colour";

/** Text that the page shows for an empty text leaf: a no-break space. */
const EMPTY_LEAF_TEXT = " ";

/**
 * Compares one design node with the browser measurement of its element and returns the findings.
 *
 * The findings come in the order of the attributes: position, size, fill, border, radius, opacity, text and colour.
 *
 * @param node - node of the design, with absolute page coordinates
 * @param measured - values that the browser reports for the element of the node
 * @param boardOrigin - absolute position of the board that holds the node
 */
export function compareNodeStyles(
    node: NodeModel,
    measured: MeasuredNode,
    boardOrigin: { x: number; y: number }
): Finding[] {
    const findings: Finding[] = [];
    checkPosition(findings, "x", node.x - boardOrigin.x, measured.relLeft);
    checkPosition(findings, "y", node.y - boardOrigin.y, measured.relTop);
    checkSize(findings, "width", node.width, measured.width, node.type === "text");
    checkSize(findings, "height", node.height, measured.height, node.type === "text");
    checkBackground(findings, node, measured);
    checkStroke(findings, node, measured);
    checkRadius(findings, node, measured);
    checkOpacity(findings, node, measured);
    if (node.type === "text" && node.text !== null) {
        checkText(findings, node.text, measured);
    }
    return findings;
}

/**
 * Joins the names of the path of a node, for example the names of its ancestors, with a slash.
 *
 * @param names - names from the outermost to the innermost
 */
export function pathOf(names: string[]): string {
    return names.join(" / ");
}

/**
 * Joins the text of the text leaves of an element, in document order. An element without leaves keeps its own text.
 * An empty leaf holds a no-break space, and it is kept as it is.
 *
 * @param leafTexts - textContent of each descendant with a data-text-leaf attribute, in document order
 * @param ownText - text of the element itself, used when it has no leaves
 */
export function collectText(leafTexts: string[], ownText: string): string {
    return leafTexts.length > 0 ? leafTexts.join("") : ownText;
}

/**
 * Gives the text that the page shows for the characters of a text node. A text node without characters has one empty
 * leaf, and the page shows it as a no-break space.
 *
 * @param characters - characters of the text node in the design
 */
export function expectedDomText(characters: string): string {
    return characters === "" ? EMPTY_LEAF_TEXT : characters;
}

/**
 * Adds a mismatch for a real difference.
 *
 * @param attribute - name of the compared attribute
 * @param design - value of the design, as text
 * @param implemented - value of the implementation, as text
 * @param tolerance - tolerance that applied, as text
 */
function mismatch(attribute: string, design: string, implemented: string, tolerance: string): Finding {
    return { attribute, design, implemented, kind: "mismatch", tolerance };
}

/**
 * Builds an info for a value that the backend did not return, so that the rules cannot judge it.
 *
 * @param attribute - name of the compared attribute
 * @param implemented - value that the browser reports, as text
 */
function notReturned(attribute: string, implemented: string): Finding {
    return { attribute, design: "null", implemented, kind: "info", tolerance: "not returned by the backend" };
}

/**
 * Tells whether a number is within a tolerance of an expected value. A NaN value is never within tolerance.
 *
 * @param actual - measured value
 * @param expected - design value
 * @param tolerance - largest allowed difference
 */
function isWithin(actual: number, expected: number, tolerance: number): boolean {
    return Math.abs(actual - expected) <= tolerance;
}

/**
 * Formats a colour for the report. A colour with alpha 0 prints as "transparent".
 *
 * @param colour - colour to format
 */
function formatColour(colour: Colour): string {
    return colour.alpha === 0 ? "transparent" : `${colour.hex}/${colour.alpha}`;
}

/**
 * Tells whether two colours match. Two colours with alpha 0 match, whatever their hex.
 *
 * @param expected - colour of the design
 * @param actual - colour that the browser reports
 */
function coloursMatch(expected: Colour, actual: Colour): boolean {
    if (expected.alpha === 0 && actual.alpha === 0) {
        return true;
    }
    return sameColour(expected, actual);
}

/**
 * Parses a colour that the browser reports, or returns null when the text is not a colour.
 *
 * @param raw - computed colour text
 */
function parseMeasuredColour(raw: string): Colour | null {
    try {
        return parseCssColour(raw);
    } catch {
        return null;
    }
}

/**
 * Adds a mismatch when a colour of the browser does not match the colour of the design.
 *
 * @param findings - list that receives the finding
 * @param attribute - name of the compared attribute
 * @param expected - colour of the design
 * @param raw - computed colour text of the browser
 * @param tolerance - tolerance text of the comparison
 */
function checkColour(findings: Finding[], attribute: string, expected: Colour, raw: string, tolerance: string): void {
    const actual = parseMeasuredColour(raw);
    if (actual === null) {
        findings.push(mismatch(attribute, formatColour(expected), raw, tolerance));
        return;
    }
    if (!coloursMatch(expected, actual)) {
        findings.push(mismatch(attribute, formatColour(expected), formatColour(actual), tolerance));
    }
}

/**
 * Adds a finding when the x or y position of the element is off by more than half a pixel.
 *
 * @param findings - list that receives the finding
 * @param attribute - "x" or "y"
 * @param expected - position of the design, relative to the board
 * @param actual - position that the browser reports, relative to the board
 */
function checkPosition(findings: Finding[], attribute: string, expected: number, actual: number): void {
    if (!isWithin(actual, expected, 0.5)) {
        findings.push(mismatch(attribute, String(expected), String(actual), "+-0.5 px"));
    }
}

/**
 * Adds a finding when the width or height of the element is off by more than half a pixel. A text node gives an info
 * instead of a mismatch, because the browser sizes text by its own rules.
 *
 * @param findings - list that receives the finding
 * @param attribute - "width" or "height"
 * @param expected - size of the design
 * @param actual - size that the browser reports
 * @param isText - true when the node is a text
 */
function checkSize(findings: Finding[], attribute: string, expected: number, actual: number, isText: boolean): void {
    if (isWithin(actual, expected, 0.5)) {
        return;
    }
    if (isText) {
        findings.push({
            attribute,
            design: String(expected),
            implemented: String(actual),
            kind: "info",
            tolerance: "text sizes approximate (gap 7)",
        });
    } else {
        findings.push(mismatch(attribute, String(expected), String(actual), "+-0.5 px"));
    }
}

/**
 * Compares the background colour with the first fill of the node. A node without fills expects a transparent colour.
 *
 * @param findings - list that receives the findings
 * @param node - node of the design
 * @param measured - values that the browser reports
 */
function checkBackground(findings: Finding[], node: NodeModel, measured: MeasuredNode): void {
    const fill = node.fills[0];
    const expected: Colour =
        fill === undefined ? { hex: "#000000", alpha: 0 } : { hex: fill.hex, alpha: fill.opacity ?? 1 };
    checkColour(findings, "background-color", expected, measured.backgroundColor, COLOUR_TOLERANCE);
}

/**
 * Parses a computed box-shadow value into its shadows. The value "none" gives an empty list. Each shadow has a colour,
 * then four lengths (offset x, offset y, blur and spread) and an optional `inset` keyword. The parts are split on
 * commas that are outside parentheses. Returns null when a part is not a shadow.
 *
 * @param value - computed box-shadow text
 * @returns the shadows in order, or null when the text is not a box shadow
 */
export function parseBoxShadow(value: string): ShadowLayer[] | null {
    const text = value.trim();
    if (text === "none") {
        return [];
    }
    const layers: ShadowLayer[] = [];
    for (const part of splitTopLevel(text)) {
        const layer = parseShadowPart(part);
        if (layer === null) {
            return null;
        }
        layers.push(layer);
    }
    return layers;
}

/**
 * Splits a text on the commas that are not inside parentheses, and trims each part.
 *
 * @param text - text to split
 */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of text) {
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth -= 1;
        }
        if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    parts.push(current.trim());
    return parts;
}

/**
 * Parses one shadow of a computed box-shadow value, or returns null when the part does not hold a colour and four
 * lengths.
 *
 * @param part - one shadow, without its comma
 */
function parseShadowPart(part: string): ShadowLayer | null {
    const colourMatch = COLOUR_PATTERN.exec(part);
    if (colourMatch === null) {
        return null;
    }
    const colour = colourMatch[0];
    const tokens = part.replace(colour, " ").trim().split(/\s+/);
    const inset = tokens.includes("inset");
    const lengths = tokens.filter((token) => token !== "inset" && token !== "");
    if (lengths.length !== 4 || !lengths.every((token) => LENGTH_PATTERN.test(token))) {
        return null;
    }
    const spread = Number.parseFloat(lengths[3] ?? "");
    if (!Number.isFinite(spread)) {
        return null;
    }
    return { colour, inset, spread };
}

/**
 * Compares the stroke of the node with the box shadows that the browser reports. The measured width is the sum of the
 * spreads of the shadows, and the measured colour is the colour of the first shadow. A node without a stroke expects no
 * shadow and a width of 0.
 *
 * @param findings - list that receives the findings
 * @param node - node of the design
 * @param measured - values that the browser reports
 */
function checkStroke(findings: Finding[], node: NodeModel, measured: MeasuredNode): void {
    const stroke = node.strokes[0];
    const expectedWidth = stroke === undefined ? 0 : (stroke.width ?? 1);
    const layers = parseBoxShadow(measured.boxShadow);
    if (layers === null) {
        const tolerance = "box-shadow must be none or a list of shadows";
        findings.push(mismatch("stroke-width", String(expectedWidth), measured.boxShadow, tolerance));
        return;
    }
    const measuredWidth = layers.reduce((sum, layer) => sum + layer.spread, 0);
    if (!isWithin(measuredWidth, expectedWidth, 0.01)) {
        findings.push(mismatch("stroke-width", String(expectedWidth), `${measuredWidth}px`, "+-0.01 px"));
    }
    const first = layers[0];
    if (stroke !== undefined && first !== undefined) {
        const expected: Colour = { hex: stroke.hex, alpha: stroke.opacity ?? 1 };
        checkColour(findings, "stroke-colour", expected, first.colour, COLOUR_TOLERANCE);
    }
}

/**
 * Compares the four corner radii. A node with a radius of null expects 0 on every corner. An ellipse ignores the
 * radius of the design and accepts half of its width or half of its height.
 *
 * @param findings - list that receives the findings
 * @param node - node of the design
 * @param measured - values that the browser reports
 */
function checkRadius(findings: Finding[], node: NodeModel, measured: MeasuredNode): void {
    const radius: [number, number, number, number] = node.radius ?? [0, 0, 0, 0];
    const corners = [
        { attribute: "border-radius-tl", raw: measured.radiusTl, expected: radius[0] },
        { attribute: "border-radius-tr", raw: measured.radiusTr, expected: radius[1] },
        { attribute: "border-radius-br", raw: measured.radiusBr, expected: radius[2] },
        { attribute: "border-radius-bl", raw: measured.radiusBl, expected: radius[3] },
    ];
    for (const corner of corners) {
        if (node.type === "ellipse") {
            checkEllipseCorner(findings, node, corner.attribute, corner.raw);
        } else if (!isWithin(parseFloat(corner.raw), corner.expected, 0.5)) {
            findings.push(mismatch(corner.attribute, String(corner.expected), corner.raw, "+-0.5 px"));
        }
    }
}

/**
 * Compares one corner of an ellipse. The corner passes at "50%", or when its pixel value is half the width or half
 * the height of the node.
 *
 * @param findings - list that receives the finding
 * @param node - ellipse of the design
 * @param attribute - name of the corner attribute
 * @param raw - computed corner radius of the browser
 */
function checkEllipseCorner(findings: Finding[], node: NodeModel, attribute: string, raw: string): void {
    if (raw === "50%") {
        return;
    }
    const px = parseFloat(raw);
    if (isWithin(px, node.width / 2, 0.5) || isWithin(px, node.height / 2, 0.5)) {
        return;
    }
    findings.push(mismatch(attribute, `${node.width / 2}px or ${node.height / 2}px or 50%`, raw, "+-0.5 px"));
}

/**
 * Compares the opacity of the node. A node without an opacity gives an info.
 *
 * @param findings - list that receives the finding
 * @param node - node of the design
 * @param measured - values that the browser reports
 */
function checkOpacity(findings: Finding[], node: NodeModel, measured: MeasuredNode): void {
    if (node.opacity === null) {
        findings.push(notReturned("opacity", measured.opacity));
        return;
    }
    if (!isWithin(Number(measured.opacity), node.opacity, 0.001)) {
        findings.push(mismatch("opacity", String(node.opacity), measured.opacity, "+-0.001"));
    }
}

/**
 * Compares the text attributes and the text colour of a text node. The text and the text styles are read from the text
 * leaves of the element. A text field that is null gives an info.
 *
 * @param findings - list that receives the findings
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkText(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (measured.text !== expectedDomText(text.characters)) {
        findings.push(mismatch("text", text.characters, measured.text, "exact"));
    }
    checkFontSize(findings, text, measured);
    checkFontFamily(findings, text, measured);
    checkFontWeight(findings, text, measured);
    checkLineHeight(findings, text, measured);
    checkLetterSpacing(findings, text, measured);
    checkTextAlign(findings, text, measured);
    if (text.fill === null) {
        findings.push(notReturned("color", measured.color));
    } else {
        checkColour(findings, "color", { hex: text.fill, alpha: 1 }, measured.color, TEXT_COLOUR_TOLERANCE);
    }
}

/**
 * Compares the font size of a text node.
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkFontSize(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (text.fontSize === null) {
        findings.push(notReturned("font-size", measured.fontSize));
    } else if (!isWithin(parseFloat(measured.fontSize), text.fontSize, 0.01)) {
        findings.push(mismatch("font-size", String(text.fontSize), measured.fontSize, "+-0.01 px"));
    }
}

/**
 * Compares the font family of a text node. The family must be in the table of font families. The expected name is the
 * first family of its CSS value, and the browser name is the first family without quotes.
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkFontFamily(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (text.fontFamily === null) {
        findings.push(notReturned("font-family", measured.fontFamily));
        return;
    }
    const implemented = primaryFamilyOf(measured.fontFamily);
    if (!Object.prototype.hasOwnProperty.call(FONT_FAMILY_CSS, text.fontFamily)) {
        findings.push(mismatch("font-family", text.fontFamily, implemented, "family must be in FONT_FAMILY_CSS"));
        return;
    }
    const expected = primaryFamilyOf(cssFontFamily(text.fontFamily));
    if (implemented !== expected) {
        findings.push(mismatch("font-family", expected, implemented, "exact family"));
    }
}

/**
 * Compares the font weight of a text node as strings.
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkFontWeight(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (text.fontWeight === null) {
        findings.push(notReturned("font-weight", measured.fontWeight));
    } else if (measured.fontWeight !== text.fontWeight) {
        findings.push(mismatch("font-weight", text.fontWeight, measured.fontWeight, "exact"));
    }
}

/**
 * Compares the line height of a text node. The design gives a unitless multiple of the font size: the paragraph line
 * height, or the line height of the text when the paragraph has none. The browser reports the line height of the text
 * leaf in pixels, so it must be within 0.05 px of the product. A "normal" line height is a mismatch.
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkLineHeight(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    const unitless = text.paragraphLineHeight ?? text.lineHeight;
    if (unitless === null || text.fontSize === null) {
        findings.push(notReturned("line-height", measured.lineHeight));
        return;
    }
    const expectedPx = Number((unitless * text.fontSize).toFixed(3));
    const passes = measured.lineHeight.endsWith("px") && isWithin(parseFloat(measured.lineHeight), expectedPx, 0.05);
    if (!passes) {
        const tolerance = `+-0.05 px, ${unitless} times the font size of ${text.fontSize} px`;
        findings.push(mismatch("line-height", `${expectedPx}px`, measured.lineHeight, tolerance));
    }
}

/**
 * Compares the letter spacing of a text node. The browser value "normal" counts as 0.
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkLetterSpacing(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (text.letterSpacing === null) {
        findings.push(notReturned("letter-spacing", measured.letterSpacing));
        return;
    }
    const actual = measured.letterSpacing === "normal" ? 0 : parseFloat(measured.letterSpacing);
    if (!isWithin(actual, text.letterSpacing, 0.01)) {
        findings.push(mismatch("letter-spacing", String(text.letterSpacing), measured.letterSpacing, "+-0.01 px"));
    }
}

/**
 * Compares the text alignment of a text node. The browser value "start" counts as "left".
 *
 * @param findings - list that receives the finding
 * @param text - text of the design
 * @param measured - values that the browser reports
 */
function checkTextAlign(findings: Finding[], text: TextModel, measured: MeasuredNode): void {
    if (text.textAlign === null) {
        findings.push(notReturned("text-align", measured.textAlign));
        return;
    }
    const actual = measured.textAlign === "start" ? "left" : measured.textAlign;
    if (actual !== text.textAlign) {
        findings.push(mismatch("text-align", text.textAlign, measured.textAlign, "exact, start counts as left"));
    }
}
