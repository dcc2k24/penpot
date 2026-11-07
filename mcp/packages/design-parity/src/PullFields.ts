/**
 * Attributes that the puller asks get_shapes for. The backend returns a short default set unless the request names
 * fields, so every attribute the Normaliser reads must be listed here. The names are camelCase, as the answers are.
 */
export const SHAPE_FIELDS: readonly string[] = [
    "id",
    "name",
    "type",
    "parentId",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "hidden",
    "opacity",
    "shapes",
    "fills",
    "strokes",
    "r1",
    "r2",
    "r3",
    "r4",
    "layout",
    "layoutGap",
    "layoutFlexDir",
    "layoutPadding",
    "layoutAlignItems",
    "layoutJustifyContent",
    "layoutWrapType",
    "layoutItemHSizing",
    "layoutItemVSizing",
    "growType",
    "content",
    "componentId",
    "componentFile",
    "componentRoot",
    "mainInstance",
    "shapeRef",
];

/**
 * Attributes that the puller asks get_page_tree for on every node. The tree leaves out the heavy attributes, such as
 * content, unless they are named.
 */
export const TREE_FIELDS: readonly string[] = [
    "id",
    "name",
    "type",
    "x",
    "y",
    "width",
    "height",
    "parentId",
    "hidden",
    "componentId",
    "componentFile",
    "componentRoot",
    "mainInstance",
    "shapeRef",
];

/**
 * Fields that the Normaliser reads but that are not shape attributes, so they must not be requested. The backend adds
 * them to the answer itself: `characters` is the text of a text shape.
 */
export const SERVER_ADDED_FIELDS: readonly string[] = ["characters"];

/**
 * Tracks which requested fields an answer has carried. A field is covered when at least one entry has it. An entry
 * may leave a field out when the shape has no value for it, so one entry is not enough to call a field absent.
 */
export class FieldCoverage {
    private readonly seen = new Set<string>();
    private entries = 0;

    /**
     * @param requested - fields the request named
     */
    constructor(private readonly requested: readonly string[]) {}

    /**
     * Records the requested fields that one entry carries.
     *
     * @param entry - one shape or tree node of an answer
     */
    observe(entry: Record<string, unknown>): void {
        this.entries++;
        for (const field of this.requested) {
            if (field in entry) {
                this.seen.add(field);
            }
        }
    }

    /**
     * Requested fields that no entry carried. Empty when no entry was seen, because there is nothing to check.
     */
    missing(): string[] {
        if (this.entries === 0) {
            return [];
        }
        return this.requested.filter((field) => !this.seen.has(field));
    }
}

/**
 * Records every node below a tree node, depth first, in a coverage tracker.
 *
 * @param node - tree node whose children are observed
 * @param coverage - tracker that receives each child
 */
export function observeTree(node: Record<string, unknown>, coverage: FieldCoverage): void {
    if (!Array.isArray(node.children)) {
        return;
    }
    for (const child of node.children) {
        if (typeof child === "object" && child !== null && !Array.isArray(child)) {
            const record = child as Record<string, unknown>;
            coverage.observe(record);
            observeTree(record, coverage);
        }
    }
}

/**
 * Throws when a requested field was not returned by any entry of an answer.
 *
 * @param call - name of the tool call, for the message
 * @param coverage - tracker of the answer
 * @throws Error that names the missing fields
 */
export function assertCovered(call: string, coverage: FieldCoverage): void {
    const missing = coverage.missing();
    if (missing.length > 0) {
        throw new Error(
            `${call} returned none of the requested fields ${missing.join(", ")}: the answer does not match the request`
        );
    }
}
