/** The part of a text shape that the estimate reads. This is the shape of an `export_subtree` entry. */
export interface TextShapeLike {
    /** Shape id. */
    id: string;
    /** Left edge of the box in page space. */
    x: number;
    /** Top edge of the box in page space. */
    y: number;
    /** Width of the box. */
    width: number;
    /** Height of the box. */
    height: number;
    /** Content tree: root, paragraph set, paragraphs, runs. */
    content?: unknown;
    /** Laid-out runs, when the browser or an earlier step stored them. */
    positionData?: unknown;
}

/** One laid-out run, with the keys of the stored form. */
export type PositionRun = Record<string, unknown>;

/** One leaf of the content tree: a run of text with its style. */
interface ContentLeaf {
    text?: string;
    fontSize?: string;
    fontWeight?: string;
    fontStyle?: string;
    fontFamily?: string;
    textTransform?: string;
    textDecoration?: string;
    fills?: { fillColor?: string; fillOpacity?: number }[];
    children?: ContentLeaf[];
}

/**
 * Collects the leaves that hold text.
 *
 * @param node - a node of the content tree
 * @param out - receives the leaves
 */
function collectLeaves(node: ContentLeaf, out: ContentLeaf[]): void {
    if (typeof node.text === "string") {
        out.push(node);
        return;
    }
    for (const child of node.children ?? []) {
        collectLeaves(child, out);
    }
}

/**
 * Tells whether a text shape still needs its laid-out runs.
 *
 * @param shape - text shape
 */
export function needsPositionData(shape: TextShapeLike): boolean {
    return !Array.isArray(shape.positionData) || shape.positionData.length === 0;
}

/**
 * Estimates the laid-out runs of a text, the way the server estimates its size: 0.55 em a character and 1.2 em a
 * line, left aligned, one run for each leaf. The runs are not what a browser would measure. They give the shape the
 * stored fields and the weight of a laid-out text.
 *
 * @param shape - text shape as `export_subtree` returns it
 * @returns one run for each non-empty leaf, with kebab-case keys as the backend stores them
 */
export function estimateRuns(shape: TextShapeLike): PositionRun[] {
    const found: ContentLeaf[] = [];
    collectLeaves((shape.content ?? {}) as ContentLeaf, found);
    const runs: PositionRun[] = [];
    let line = 0;
    for (const leaf of found) {
        const text = leaf.text ?? "";
        if (text === "") {
            continue;
        }
        const size = Number(leaf.fontSize ?? "14") || 14;
        const lineHeight = Math.round(size * 1.2 * 100) / 100;
        const width = Math.min(shape.width, Math.round(text.length * size * 0.55 * 100) / 100);
        const fill = leaf.fills?.[0];
        runs.push({
            x: shape.x,
            y: Math.round((shape.y + lineHeight * (line + 1)) * 100) / 100,
            width,
            height: lineHeight,
            x1: 0,
            y1: -3,
            x2: width,
            y2: Math.round((lineHeight - 3) * 100) / 100,
            "font-style": leaf.fontStyle ?? "normal",
            "text-transform": leaf.textTransform ?? "none",
            "font-size": `${size}px`,
            "font-weight": leaf.fontWeight ?? "400",
            "text-decoration": leaf.textDecoration ?? "none",
            "letter-spacing": "normal",
            fills: [{ "fill-color": fill?.fillColor ?? "#000000", "fill-opacity": fill?.fillOpacity ?? 1 }],
            direction: "ltr",
            "font-family": leaf.fontFamily ?? "sourcesanspro",
            text,
        });
        line++;
    }
    return runs;
}

/**
 * Builds the raw change that stores estimated runs in a text shape.
 *
 * @param shapeId - id of the text shape
 * @param pageId - id of its page
 * @param runs - runs from {@link estimateRuns}
 * @returns a `mod-obj` change for `apply_raw_changes`
 */
export function positionDataChange(shapeId: string, pageId: string, runs: PositionRun[]): Record<string, unknown> {
    return {
        type: "mod-obj",
        id: shapeId,
        pageId,
        operations: [{ type: "assign", value: { "position-data": runs } }],
    };
}
