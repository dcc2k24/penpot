import { chromium, type Browser, type Page } from "playwright";
import type { DesignModel, NodeModel } from "../DesignModel.js";
import { parseCssColour, sameColour, type Colour } from "../Colour.js";
import { strokeShadowOf, type StrokeShadow } from "../generate/NodeEmitter.js";
import { NODE_ID_ATTRIBUTE, VIEWPORT, type DesignTarget } from "../Targets.js";
import {
    collectText,
    compareNodeStyles,
    parseBoxShadow,
    pathOf,
    type MeasuredNode,
    type ShadowLayer,
} from "./Tolerance.js";

// These two declarations type the browser globals that the evaluate callbacks use. tsconfig has no DOM library, so the
// type checker does not know these names. They are typed as any and are used only inside code that runs in the page.
declare const document: any;
declare const getComputedStyle: any;

/** One mismatch between the design and the rendered page, with the target and node that it belongs to. */
export interface DomMismatch {
    /** Id of the target that holds the node. */
    targetId: string;
    /** Name of the target. */
    targetName: string;
    /** Id of the model node. */
    nodeId: string;
    /** Name of the model node. */
    nodeName: string;
    /** Names from the board down to the node, joined with " / ". */
    path: string;
    /** Attribute that differs, or "element" when the element is missing. */
    attribute: string;
    /** Value in the design model. */
    design: string;
    /** Value in the rendered page. */
    implemented: string;
    /** Tolerance that the value was checked against. */
    tolerance: string;
    /** Where the cause of the mismatch lies. Set by a later step, not by the DOM check. */
    classification?: "generator" | "model" | "mcp" | "renderer" | "unclassified";
}

/** Result of the DOM check of one target. */
export interface TargetDomResult {
    /** Id of the target. */
    id: string;
    /** Name of the target. */
    name: string;
    /** Number of model nodes in the target, the board included. */
    nodes: number;
    /** Number of nodes that were found in the page and compared. */
    checked: number;
    /** Number of mismatches of the target, missing elements included. */
    mismatches: number;
    /** Info lines for the target, one per info finding. */
    info: string[];
    /** Ids that occur on more than one element of the page. */
    duplicates: string[];
}

/** Result of the DOM check of every target. */
export interface DomResult {
    /** Result of each target, in the order of the targets. */
    targets: TargetDomResult[];
    /** Every mismatch of every target, in order. */
    mismatches: DomMismatch[];
    /** Total number of nodes that were compared. */
    checked: number;
    /** Total number of info lines. */
    info: number;
}

/** One element of the rendered page, measured in the browser. Plain data, so it can cross from the page to Node. */
export interface RawElement {
    /** Value of the data-node-id attribute. */
    id: string;
    /** Value of the data-node-name attribute, or an empty string. */
    name: string;
    /** Left edge relative to the left edge of the board, in CSS pixels. */
    relLeft: number;
    /** Top edge relative to the top edge of the board, in CSS pixels. */
    relTop: number;
    /** Width of the bounding box, in CSS pixels. */
    width: number;
    /** Height of the bounding box, in CSS pixels. */
    height: number;
    /**
     * Computed styles, keyed by CSS property name. The box styles come from the element. The text styles come from the
     * first text leaf when the element has one, else from the element.
     */
    styles: Record<string, string>;
    /** Text of the element when it has no child elements, or an empty string. Replaced by the leaf text after collecting. */
    text: string;
    /** Text of each descendant with a data-text-leaf attribute, in document order. Empty when there is none. */
    leafTexts: string[];
}

/** Result of measuring one board and everything that carries a node id on the page. */
export interface CollectResult {
    /** Every element with a data-node-id attribute, in document order. Each text is the collected text. */
    elements: RawElement[];
    /** True when the board element was found. */
    boardFound: boolean;
    /** Ids that occur on more than one element, in order of first appearance. */
    duplicates: string[];
}

/** Result of checking one target, with its mismatches kept apart for the overall list. */
interface TargetOutcome {
    /** Summary of the target. */
    summary: TargetDomResult;
    /** Mismatches of the target, in order. */
    mismatches: DomMismatch[];
}

/** One model node with the names from the board down to it. */
interface FlatNode {
    /** The model node. */
    node: NodeModel;
    /** Names from the board down to the node, the board name first. */
    names: string[];
}

/**
 * Compares the rendered page of every target with the design model. Each run starts one headless chromium browser and
 * one page per target. It measures each element that has a node id and checks it with compareNodeStyles.
 */
export class DomComparator {
    /**
     * Checks every target in order and collects the mismatches. The browser is started once per run.
     *
     * @param model - pulled design model; the DOM check does not use it, and it is kept for the shared contract
     * @param targets - targets to render and compare, in the order to check them
     * @param baseUrl - origin of the running app, without a trailing slash, for example "http://localhost:3000"
     * @param log - receives one line per target when it is done, and a notice when the network does not go idle
     * @returns the result of each target, all mismatches, and the totals
     */
    async run(
        model: DesignModel,
        targets: DesignTarget[],
        baseUrl: string,
        log: (line: string) => void
    ): Promise<DomResult> {
        const browser = await chromium.launch({ headless: true });
        try {
            const outcomes: TargetOutcome[] = [];
            for (const target of targets) {
                const outcome = await checkTarget(browser, target, baseUrl, log);
                log(`[dom] ${target.id} ${outcome.summary.nodes} nodes ${outcome.summary.mismatches} mismatches`);
                outcomes.push(outcome);
            }
            const targetResults = outcomes.map((outcome) => outcome.summary);
            const mismatches = outcomes.flatMap((outcome) => outcome.mismatches);
            let checked = 0;
            let info = 0;
            for (const result of targetResults) {
                checked += result.checked;
                info += result.info.length;
            }
            return { targets: targetResults, mismatches, checked, info };
        } finally {
            await browser.close();
        }
    }
}

/**
 * Measures the board and its descendants on the page. This runs one page.evaluate call, and the function it runs must
 * stay free of helpers, because it is sent to the page as text. The text of a text node is the joined text of its
 * leaves, which the collectText helper joins after the page call.
 *
 * @param page - page that has the app loaded
 * @param boardId - value of the data-node-id attribute of the board
 * @returns the measured elements, whether the board was found, and the duplicate ids
 */
export async function collectMeasurements(page: Page, boardId: string): Promise<CollectResult> {
    const raw: CollectResult = await page.evaluate((id: string): CollectResult => {
        const boardEl = document.querySelector(`[data-node-id="${id}"]`);
        if (boardEl === null) {
            return { elements: [], boardFound: false, duplicates: [] };
        }
        const boardRect = boardEl.getBoundingClientRect();
        const elements: RawElement[] = [];
        const counts = new Map<string, number>();
        const all = document.querySelectorAll("[data-node-id]");
        for (const el of all) {
            const elementId: string = el.getAttribute("data-node-id") ?? "";
            const name: string = el.getAttribute("data-node-name") ?? "";
            const rect = el.getBoundingClientRect();
            const leaves = el.querySelectorAll("[data-text-leaf]");
            const leafTexts: string[] = [];
            for (const leaf of leaves) {
                leafTexts.push(leaf.textContent ?? "");
            }
            const textSource = leaves.length > 0 ? leaves[0] : el;
            const computed = getComputedStyle(el);
            const textComputed = getComputedStyle(textSource);
            const styles: Record<string, string> = {};
            for (const key of [
                "background-color",
                "box-shadow",
                "border-top-left-radius",
                "border-top-right-radius",
                "border-bottom-right-radius",
                "border-bottom-left-radius",
                "opacity",
            ]) {
                styles[key] = computed.getPropertyValue(key);
            }
            for (const key of [
                "color",
                "font-size",
                "font-family",
                "font-weight",
                "line-height",
                "letter-spacing",
                "text-align",
            ]) {
                styles[key] = textComputed.getPropertyValue(key);
            }
            elements.push({
                id: elementId,
                name,
                relLeft: rect.left - boardRect.left,
                relTop: rect.top - boardRect.top,
                width: rect.width,
                height: rect.height,
                styles,
                text: el.children.length === 0 ? (el.textContent ?? "") : "",
                leafTexts,
            });
            counts.set(elementId, (counts.get(elementId) ?? 0) + 1);
        }
        const duplicates: string[] = [];
        for (const [elementId, count] of counts) {
            if (count > 1) {
                duplicates.push(elementId);
            }
        }
        return { elements, boardFound: true, duplicates };
    }, boardId);
    const elements = raw.elements.map((element) => ({
        ...element,
        text: collectText(element.leafTexts, element.text),
    }));
    return { elements, boardFound: raw.boardFound, duplicates: raw.duplicates };
}

/**
 * Opens a route and waits for the network to go idle. When the wait times out, it falls back to the load event. Any
 * other error is passed on.
 *
 * @param page - page to navigate
 * @param url - full url to open
 * @param targetId - id of the target, used in the log line
 * @param log - receives the notice when the fallback is used
 */
async function openRoute(page: Page, url: string, targetId: string, log: (line: string) => void): Promise<void> {
    try {
        await page.goto(url, { waitUntil: "networkidle" });
    } catch (error: unknown) {
        if (!isTimeoutError(error)) {
            throw error;
        }
        log(`[dom] ${targetId} networkidle timed out, using load`);
        await page.goto(url, { waitUntil: "load" });
    }
}

/**
 * Tells whether an error is the timeout error of Playwright.
 *
 * @param error - error that was thrown
 */
function isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Opens one target in a new page, measures it and compares it with the model. The page is closed at the end.
 *
 * @param browser - running browser
 * @param target - target to check
 * @param baseUrl - origin of the running app
 * @param log - receives the network notice
 * @throws Error when the board is not in the page
 */
async function checkTarget(
    browser: Browser,
    target: DesignTarget,
    baseUrl: string,
    log: (line: string) => void
): Promise<TargetOutcome> {
    const page = await browser.newPage({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        deviceScaleFactor: 1,
    });
    try {
        await openRoute(page, baseUrl + target.route, target.id, log);
        await page.waitForSelector(`[${NODE_ID_ATTRIBUTE}="${target.board.id}"]`, { timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        const collected = await collectMeasurements(page, target.board.id);
        if (!collected.boardFound) {
            throw new Error(`board ${target.board.id} of target ${target.id} was not found on the page`);
        }
        return compareTarget(target, collected);
    } finally {
        await page.close();
    }
}

/**
 * Compares the measured elements of one target with the nodes of its board.
 *
 * @param target - target that was measured
 * @param collected - measurements of the page
 */
function compareTarget(target: DesignTarget, collected: CollectResult): TargetOutcome {
    const elements = new Map<string, RawElement>();
    for (const element of collected.elements) {
        if (!elements.has(element.id)) {
            elements.set(element.id, element);
        }
    }
    const origin = { x: target.board.x, y: target.board.y };
    const info: string[] = [];
    const mismatches: DomMismatch[] = [];
    let nodes = 0;
    let checked = 0;
    for (const flat of flattenBoard(target.board)) {
        nodes += 1;
        const { node, names } = flat;
        const path = pathOf(names);
        const element = elements.get(node.id);
        if (element === undefined) {
            mismatches.push({
                targetId: target.id,
                targetName: target.name,
                nodeId: node.id,
                nodeName: node.name,
                path,
                attribute: "element",
                design: "present",
                implemented: "missing",
                tolerance: "one element per model node",
            });
            continue;
        }
        checked += 1;
        const measured = toMeasuredNode(element);
        for (const finding of compareNodeStyles(node, measured, origin)) {
            if (finding.kind === "mismatch") {
                mismatches.push({
                    targetId: target.id,
                    targetName: target.name,
                    nodeId: node.id,
                    nodeName: node.name,
                    path,
                    attribute: finding.attribute,
                    design: finding.design,
                    implemented: finding.implemented,
                    tolerance: finding.tolerance,
                });
            } else if (finding.kind === "info") {
                const detail = `design ${finding.design}, implemented ${finding.implemented} (${finding.tolerance})`;
                info.push(`${path}: ${finding.attribute} ${detail}`);
            }
        }
        const shadow = checkBoxShadow(node, element);
        if (shadow !== undefined) {
            mismatches.push({
                targetId: target.id,
                targetName: target.name,
                nodeId: node.id,
                nodeName: node.name,
                path,
                ...shadow,
            });
        }
    }
    return {
        summary: {
            id: target.id,
            name: target.name,
            nodes,
            checked,
            mismatches: mismatches.length,
            info,
            duplicates: collected.duplicates,
        },
        mismatches,
    };
}

/**
 * Lists the board and every descendant in pre-order: each node comes first, then its children in list order.
 *
 * @param board - top-level node of the target
 */
function flattenBoard(board: NodeModel): FlatNode[] {
    const flat: FlatNode[] = [];
    appendNode(board, [], flat);
    return flat;
}

/**
 * Adds a node and then its children to a flat list. The names are the names of the parents plus the name of the node.
 *
 * @param node - node to add
 * @param parentNames - names from the board down to the parent of the node
 * @param flat - list to add to
 */
function appendNode(node: NodeModel, parentNames: string[], flat: FlatNode[]): void {
    const names = [...parentNames, node.name];
    flat.push({ node, names });
    for (const child of node.children) {
        appendNode(child, names, flat);
    }
}

/**
 * Checks the box shadow of a node against the shadows that its first stroke implies. A node without a stroke expects
 * "none". Each shadow must match the expected one in its inset flag, its spread within 0.01 px and its colour. The
 * returned fields complete a mismatch, so the caller adds the target and the node.
 *
 * @param node - model node
 * @param element - element measured in the page
 * @returns the attribute, design value, implemented value and tolerance, or undefined when the shadows match
 */
function checkBoxShadow(
    node: NodeModel,
    element: RawElement
): Pick<DomMismatch, "attribute" | "design" | "implemented" | "tolerance"> | undefined {
    const stroke = node.strokes[0];
    const implemented = styleOf(element, "box-shadow");
    const layers = parseBoxShadow(implemented);
    if (stroke === undefined) {
        if (layers !== null && layers.length === 0) {
            return undefined;
        }
        return { attribute: "box-shadow", design: "none", implemented, tolerance: "none without a stroke" };
    }
    const shadows = strokeShadowOf(stroke);
    if (layers !== null && shadowsMatch(shadows, stroke.hex, stroke.opacity ?? 1, layers)) {
        return undefined;
    }
    return {
        attribute: "box-shadow",
        design: describeShadows(shadows, stroke.hex),
        implemented,
        tolerance: "same count, inset flag, spread +-0.01 px, colour exact",
    };
}

/**
 * Tells whether the shadows of the browser match the expected shadows of a stroke, in order.
 *
 * @param expected - shadows that the stroke implies
 * @param hex - colour of the stroke as upper case `#RRGGBB`
 * @param alpha - opacity of the stroke
 * @param layers - shadows that the browser reports
 */
function shadowsMatch(expected: StrokeShadow[], hex: string, alpha: number, layers: ShadowLayer[]): boolean {
    if (layers.length !== expected.length) {
        return false;
    }
    const colour: Colour = { hex, alpha };
    return expected.every((shadow, index) => {
        const layer = layers[index];
        return (
            layer !== undefined &&
            layer.inset === shadow.inset &&
            Math.abs(layer.spread - shadow.spread) <= 0.01 &&
            sameLayerColour(layer.colour, colour)
        );
    });
}

/**
 * Tells whether the colour of a browser shadow equals an expected colour. A colour that the parser does not know
 * never matches.
 *
 * @param raw - colour text of the browser
 * @param expected - expected colour
 */
function sameLayerColour(raw: string, expected: Colour): boolean {
    try {
        return sameColour(parseCssColour(raw), expected);
    } catch {
        return false;
    }
}

/**
 * Describes the expected shadows of a stroke for a report, for example "inset 0.5px #FF0000, outer 0.5px #FF0000".
 *
 * @param shadows - shadows that the stroke implies
 * @param hex - colour of the stroke
 */
function describeShadows(shadows: StrokeShadow[], hex: string): string {
    return shadows.map((shadow) => `${shadow.inset ? "inset" : "outer"} ${shadow.spread}px ${hex}`).join(", ");
}

/**
 * Builds the measured node that compareNodeStyles checks. A style that the page did not report is an empty string.
 * The stroke is drawn with box shadows, so the box shadow fills the stroke field of the measured node.
 *
 * @param element - element measured in the page
 */
function toMeasuredNode(element: RawElement): MeasuredNode {
    return {
        id: element.id,
        name: element.name,
        relLeft: element.relLeft,
        relTop: element.relTop,
        width: element.width,
        height: element.height,
        backgroundColor: styleOf(element, "background-color"),
        boxShadow: styleOf(element, "box-shadow"),
        radiusTl: styleOf(element, "border-top-left-radius"),
        radiusTr: styleOf(element, "border-top-right-radius"),
        radiusBr: styleOf(element, "border-bottom-right-radius"),
        radiusBl: styleOf(element, "border-bottom-left-radius"),
        opacity: styleOf(element, "opacity"),
        text: element.text,
        fontSize: styleOf(element, "font-size"),
        fontFamily: styleOf(element, "font-family"),
        fontWeight: styleOf(element, "font-weight"),
        lineHeight: styleOf(element, "line-height"),
        letterSpacing: styleOf(element, "letter-spacing"),
        textAlign: styleOf(element, "text-align"),
        color: styleOf(element, "color"),
    };
}

/**
 * Reads one computed style of an element.
 *
 * @param element - element measured in the page
 * @param key - CSS property name
 */
function styleOf(element: RawElement, key: string): string {
    return element.styles[key] ?? "";
}
