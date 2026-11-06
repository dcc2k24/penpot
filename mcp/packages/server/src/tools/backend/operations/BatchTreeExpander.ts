import { z } from "zod";

/** One node of a `batch_create_shapes` tree, before expansion. */
export interface BatchNode {
    type: string;
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    props?: Record<string, unknown>;
    characters?: string;
    children?: BatchNode[];
}

/** A shape created by the expansion: its handle and the node it came from. */
export interface ExpandedNode {
    handle: string;
    type: string;
    name?: string;
}

/** Result of expanding a tree into operations. */
export interface ExpandedTree {
    operations: Record<string, unknown>[];
    nodes: ExpandedNode[];
}

/**
 * Expands a nested tree of shape nodes into `create_*` operations.
 *
 * Each node gets a `$tmp:n<i>` handle, numbered in depth-first order, and every child refers to its
 * parent by handle. Image, path and SVG content fields that sit in `props` move to the top level of the
 * operation, where the operation vocabulary expects them.
 */
export class BatchTreeExpander {
    /** Largest number of nodes in one tree. */
    public static readonly MAX_NODES = 2000;

    /** Node types and the operation each one creates. */
    private static readonly OPERATION_BY_TYPE: Readonly<Record<string, string>> = {
        board: "create_board",
        rect: "create_rect",
        rectangle: "create_rect",
        ellipse: "create_ellipse",
        circle: "create_ellipse",
        text: "create_text",
        path: "create_path",
        image: "create_image",
        svg_raw: "create_svg_raw",
    };

    /** Props that the operation vocabulary takes at the top level, per operation. */
    private static readonly TOP_LEVEL_PROPS: Readonly<Record<string, readonly string[]>> = {
        create_text: ["growType", "fontSize", "fontFamily", "fontWeight", "fills"],
        create_path: ["content", "d"],
        create_image: ["mediaId", "mediaWidth", "mediaHeight", "mediaMtype"],
        create_svg_raw: ["content"],
    };

    /** Zod schema of one node, recursive through `children`. */
    public static readonly NODE_SCHEMA: z.ZodType<BatchNode> = z.lazy(() =>
        z.object({
            type: z
                .enum(Object.keys(BatchTreeExpander.OPERATION_BY_TYPE) as [string, ...string[]])
                .describe("Shape type: board, rect (or rectangle), ellipse (or circle), text, path, image or svg_raw."),
            name: z.string().max(250).optional().describe("Layer name of the shape."),
            x: z.number().describe("Absolute x coordinate of the top-left corner."),
            y: z.number().describe("Absolute y coordinate of the top-left corner."),
            width: z.number().describe("Width in pixels."),
            height: z.number().describe("Height in pixels."),
            props: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    "Other shape attributes in camelCase, such as fills, strokes, radius, or mediaId for images."
                ),
            characters: z.string().optional().describe("Text content of a text node."),
            children: z
                .array(BatchTreeExpander.NODE_SCHEMA)
                .optional()
                .describe("Child nodes, created inside this shape."),
        })
    );

    /**
     * Expands a forest of nodes.
     *
     * @param pageId - page that receives every shape
     * @param parentId - existing parent for the root nodes, or `undefined` for the page root
     * @param roots - the root nodes
     * @throws Error when the tree has more than {@link MAX_NODES} nodes or an unknown type
     */
    public expand(pageId: string, parentId: string | undefined, roots: BatchNode[]): ExpandedTree {
        const expanded: ExpandedTree = { operations: [], nodes: [] };
        const pending: PendingNode[] = [];
        this.schedule(pending, parentId, roots);
        let next = pending.pop();
        while (next !== undefined) {
            this.expandNode(expanded, pageId, pending, next);
            next = pending.pop();
        }
        return expanded;
    }

    /**
     * Pushes sibling nodes onto the pending stack so that the first one is expanded first.
     *
     * @param pending - the stack of nodes waiting for expansion
     * @param parentId - handle or id of the parent of the nodes, or `undefined` for the page root
     * @param nodes - the sibling nodes, in document order
     */
    private schedule(pending: PendingNode[], parentId: string | undefined, nodes: BatchNode[]): void {
        for (let index = nodes.length - 1; index >= 0; index--) {
            pending.push({ node: nodes[index], parentId });
        }
    }

    /**
     * Appends the operation of one node and schedules its children, without recursion.
     *
     * The node cap is checked as each node is produced, so an oversized tree fails before its remaining nodes
     * are expanded.
     *
     * @param expanded - the result being built
     * @param pageId - page that receives the shape
     * @param pending - the stack of nodes waiting for expansion, which receives the children
     * @param entry - the node to expand and the handle or id of its parent
     * @throws Error when the node would exceed {@link MAX_NODES} nodes, or has an unknown type
     */
    private expandNode(expanded: ExpandedTree, pageId: string, pending: PendingNode[], entry: PendingNode): void {
        const { node, parentId } = entry;
        if (expanded.nodes.length >= BatchTreeExpander.MAX_NODES) {
            throw new Error(`batch_create_shapes accepts at most ${BatchTreeExpander.MAX_NODES} nodes per tree.`);
        }
        const opName = BatchTreeExpander.OPERATION_BY_TYPE[node.type];
        if (!opName) {
            throw new Error(`Unknown node type "${node.type}".`);
        }
        const handle = `$tmp:n${expanded.nodes.length}`;
        expanded.nodes.push({ handle, type: node.type, ...(node.name !== undefined ? { name: node.name } : {}) });

        const props: Record<string, unknown> = { ...(node.props ?? {}) };
        const operation: Record<string, unknown> = {
            op: opName,
            pageId,
            id: handle,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
        };
        for (const key of BatchTreeExpander.TOP_LEVEL_PROPS[opName] ?? []) {
            if (props[key] !== undefined) {
                operation[key] = props[key];
                delete props[key];
            }
        }
        if (node.characters !== undefined) {
            operation.characters = node.characters;
        }
        if (parentId !== undefined) {
            operation.parentId = parentId;
        }
        if (node.name !== undefined) {
            operation.name = node.name;
        }
        if (Object.keys(props).length > 0) {
            operation.props = props;
        }
        expanded.operations.push(operation);

        this.schedule(pending, handle, node.children ?? []);
    }
}

/** A node waiting for expansion, with the handle or id of its parent. */
interface PendingNode {
    node: BatchNode;
    parentId: string | undefined;
}
