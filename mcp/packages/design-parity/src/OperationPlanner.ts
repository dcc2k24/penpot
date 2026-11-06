import {
    DESIGN_SPEC,
    LAYOUT,
    PALETTE,
    TYPOGRAPHIES,
    fontVariantIdOf,
    nodeName,
    normalizeName,
    screenBoard,
    type BoardNode,
    type ColorName,
    type ComponentSpec,
    type FlexSpec,
    type NodeSpec,
    type ScreenSpec,
    type StrokeSpec,
    type TextNode,
} from "./DesignSpec.js";

/**
 * Whether the children of a flex board are created in spec order. `true` matches the compiler's natural child
 * ordering (KNOWN_GAPS.md, gap 4, closed). The children are created first and `set_flex_layout` comes after them.
 * The compiler reverses the stored children once when the layout is set, so the creation order is the visual order.
 * `false` is the old workaround: the children are created in reverse. Use it only with a compiler that lacks the
 * natural order.
 */
export const NATURAL_CHILD_ORDER: boolean = true;

/**
 * Absolute page position, in page units.
 */
export interface Point {
    readonly x: number;
    readonly y: number;
}

/**
 * One operation of the apply_operations vocabulary, with camelCase keys and an `op` name.
 */
export type Operation = Record<string, unknown> & { readonly op: string };

/**
 * One step of the path from the top of a page to a node. The ordinal counts earlier siblings with the same name.
 */
export interface PathStep {
    readonly name: string;
    readonly ordinal: number;
}

/**
 * Text overrides of one instance, found after the write by walking the page tree along `path`.
 */
export interface OverrideJob {
    readonly pageId: string;
    readonly path: readonly PathStep[];
    readonly overrides: Readonly<Record<string, string>>;
}

/**
 * Operations of one top-level shape, built as one unit so it never splits across batches.
 */
export interface PlannedGroup {
    /** Normalised name the top-level shape has once the write is applied. */
    readonly topName: string;
    readonly ops: Operation[];
    readonly overrides: OverrideJob[];
}

/**
 * Mutable state of one group while its operations are emitted.
 */
interface EmitContext {
    readonly pageId: string;
    readonly ops: Operation[];
    readonly postOps: Operation[];
    readonly overrides: OverrideJob[];
}

/**
 * Turns the spec into operations for `apply_operations`. Handles are unique for the whole build, so groups can share
 * one call without clashing.
 */
export class OperationPlanner {
    private readonly typographyIds: ReadonlyMap<string, string>;
    private readonly componentIds: ReadonlyMap<string, string>;
    private handleCounter = 0;

    /**
     * Creates the planner. The maps are read at planning time, so they may be filled after construction.
     *
     * @param typographyIds - typography id by name, from the library
     * @param componentIds - component id by normalised full name, from the library
     */
    constructor(typographyIds: ReadonlyMap<string, string>, componentIds: ReadonlyMap<string, string>) {
        this.typographyIds = typographyIds;
        this.componentIds = componentIds;
    }

    /**
     * Plans one main component: its shapes, flex layouts and the `create_component` operation last.
     *
     * @param pageId - id of the Components page
     * @param spec - the component
     * @param origin - absolute page position of the component root
     */
    planComponent(pageId: string, spec: ComponentSpec, origin: Point): PlannedGroup {
        const ctx = this.newContext(pageId);
        const rootHandle = this.emitNode(ctx, spec.root, undefined, origin, [], 0);
        ctx.ops.push(...ctx.postOps);
        const segments = normalizeName(spec.name).split("/");
        const leaf = segments[segments.length - 1] ?? spec.name;
        const branch = segments.slice(0, -1).join("/");
        // Penpot joins path and name, so the leaf goes in `name` and the branch in `path`. A full name in `name` would
        // repeat the branch in the library path.
        ctx.ops.push({ op: "create_component", pageId, shapeIds: [rootHandle], name: leaf, path: branch });
        return { topName: normalizeName(spec.name), ops: ctx.ops, overrides: ctx.overrides };
    }

    /**
     * Plans one section title on the Components page.
     *
     * @param pageId - id of the Components page
     * @param title - title text, also the top-level name
     * @param origin - absolute page position of the title
     */
    planTitle(pageId: string, title: string, origin: Point): PlannedGroup {
        const ctx = this.newContext(pageId);
        const node: TextNode = {
            kind: "text",
            name: title,
            x: 0,
            y: 0,
            width: LAYOUT.titleWidth,
            height: LAYOUT.titleHeight,
            characters: title,
            typography: "h2",
            color: "neutral.900",
        };
        this.emitNode(ctx, node, undefined, origin, [], 0);
        return { topName: normalizeName(title), ops: ctx.ops, overrides: ctx.overrides };
    }

    /**
     * Plans one journey screen: the screen board, its NavBar instance, its Body and the body content.
     *
     * @param pageId - id of the journey page
     * @param screen - the screen spec
     * @param origin - absolute page position of the screen root
     */
    planScreen(pageId: string, screen: ScreenSpec, origin: Point): PlannedGroup {
        const ctx = this.newContext(pageId);
        const root = screenBoard(screen);
        this.emitNode(ctx, root, undefined, origin, [], 0);
        ctx.ops.push(...ctx.postOps);
        return { topName: normalizeName(root.name), ops: ctx.ops, overrides: ctx.overrides };
    }

    /**
     * Creates an empty emit context for one group.
     *
     * @param pageId - page the group belongs to
     */
    private newContext(pageId: string): EmitContext {
        return { pageId, ops: [], postOps: [], overrides: [] };
    }

    /**
     * Returns a new `$tmp:` handle, unique for this planner.
     */
    private nextHandle(): string {
        this.handleCounter += 1;
        return `$tmp:n${this.handleCounter}`;
    }

    /**
     * Emits the operations of one node and of its children. Flex layouts go to `postOps`, so they run after every
     * child exists. A child of a board takes its position relative to that board, unless the board uses frame
     * coordinates.
     *
     * @param ctx - emit context of the group
     * @param node - the node to emit
     * @param parentHandle - handle of the parent shape, or undefined for a top-level shape
     * @param base - absolute position that the node's x and y are relative to
     * @param parentPath - override path of the parent
     * @param ordinal - index of this node among earlier siblings with the same name
     * @returns the handle of the node
     */
    private emitNode(
        ctx: EmitContext,
        node: NodeSpec,
        parentHandle: string | undefined,
        base: Point,
        parentPath: readonly PathStep[],
        ordinal: number
    ): string {
        const absolute: Point = { x: base.x + node.x, y: base.y + node.y };
        const handle = this.nextHandle();
        const path: PathStep[] = [...parentPath, { name: normalizeName(nodeName(node)), ordinal }];
        const parentField: Record<string, unknown> = parentHandle === undefined ? {} : { parentId: parentHandle };
        switch (node.kind) {
            case "board": {
                ctx.ops.push({
                    op: "create_board",
                    pageId: ctx.pageId,
                    id: handle,
                    ...parentField,
                    name: node.name,
                    x: absolute.x,
                    y: absolute.y,
                    width: node.width,
                    height: node.height,
                    props: shapeProps(node.fill, node.stroke, node.radius),
                });
                const childBase = node.coordinates === "frame" ? base : absolute;
                // The creation order also sets the sibling numbers, which keeps override paths in line with the tree.
                this.emitChildren(ctx, emissionOrder(node), handle, childBase, path);
                if (node.flex !== undefined) {
                    ctx.postOps.push(flexOperation(ctx.pageId, handle, node.flex));
                }
                return handle;
            }
            case "rect": {
                ctx.ops.push({
                    op: "create_rect",
                    pageId: ctx.pageId,
                    id: handle,
                    ...parentField,
                    name: node.name,
                    x: absolute.x,
                    y: absolute.y,
                    width: node.width,
                    height: node.height,
                    props: shapeProps(node.fill, node.stroke, node.radius),
                });
                return handle;
            }
            case "ellipse": {
                ctx.ops.push({
                    op: "create_ellipse",
                    pageId: ctx.pageId,
                    id: handle,
                    ...parentField,
                    name: node.name,
                    x: absolute.x,
                    y: absolute.y,
                    width: node.width,
                    height: node.height,
                    props: shapeProps(node.fill, undefined, undefined),
                });
                return handle;
            }
            case "text": {
                this.emitText(ctx, node, handle, parentField, absolute);
                return handle;
            }
            case "instance": {
                const componentId = this.componentIds.get(normalizeName(node.component));
                if (componentId === undefined) {
                    throw new Error(`component "${node.component}" has no id yet, so it cannot be instantiated`);
                }
                ctx.ops.push({
                    op: "instantiate_component",
                    pageId: ctx.pageId,
                    componentId,
                    ...parentField,
                    x: absolute.x,
                    y: absolute.y,
                    id: handle,
                });
                if (node.overrides !== undefined && Object.keys(node.overrides).length > 0) {
                    ctx.overrides.push({ pageId: ctx.pageId, path, overrides: node.overrides });
                }
                return handle;
            }
        }
    }

    /**
     * Emits the children of one board, numbering siblings that share a name.
     *
     * @param ctx - emit context of the group
     * @param children - child nodes in stacking order
     * @param parentHandle - handle of the parent board
     * @param base - absolute position that the children's x and y are relative to
     * @param parentPath - override path of the parent board
     */
    private emitChildren(
        ctx: EmitContext,
        children: readonly NodeSpec[],
        parentHandle: string,
        base: Point,
        parentPath: readonly PathStep[]
    ): void {
        const counts = new Map<string, number>();
        for (const child of children) {
            const key = normalizeName(nodeName(child));
            const ordinal = counts.get(key) ?? 0;
            counts.set(key, ordinal + 1);
            this.emitNode(ctx, child, parentHandle, base, parentPath, ordinal);
        }
    }

    /**
     * Emits one text box: the content, the typography link and the style overrides. A centred text also centres
     * vertically, so that the text sits in the middle of its box.
     *
     * @param ctx - emit context of the group
     * @param node - the text spec
     * @param handle - handle of the new text shape
     * @param parentField - parent key to spread, empty for a top-level shape
     * @param absolute - absolute page position of the text box
     */
    private emitText(
        ctx: EmitContext,
        node: TextNode,
        handle: string,
        parentField: Record<string, unknown>,
        absolute: Point
    ): void {
        const style = TYPOGRAPHIES[node.typography];
        ctx.ops.push({
            op: "create_text",
            pageId: ctx.pageId,
            id: handle,
            ...parentField,
            name: node.name,
            x: absolute.x,
            y: absolute.y,
            width: node.width,
            height: node.height,
            characters: node.characters,
            growType: "fixed",
            fontFamily: DESIGN_SPEC.font.fontId,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontVariantId: fontVariantIdOf(style.fontWeight),
            fills: [solidFill(node.color)],
        });
        const typographyId = this.typographyIds.get(node.typography);
        if (typographyId === undefined) {
            throw new Error(`typography "${node.typography}" has no id yet`);
        }
        ctx.ops.push({ op: "apply_typography", pageId: ctx.pageId, id: handle, typographyId });
        const attrs: Record<string, string> = {};
        if (node.fontSize !== undefined) {
            attrs.fontSize = String(node.fontSize);
        }
        if (node.fontWeight !== undefined) {
            attrs.fontWeight = node.fontWeight;
            attrs.fontVariantId = fontVariantIdOf(node.fontWeight);
        }
        if (node.align === "center") {
            attrs.textAlign = "center";
            attrs.verticalAlign = "center";
        }
        if (Object.keys(attrs).length > 0) {
            ctx.ops.push({ op: "set_text_style", pageId: ctx.pageId, id: handle, attrs });
        }
    }
}

/**
 * Returns the children of a board in the order they are emitted. With NATURAL_CHILD_ORDER set, every board keeps spec
 * order, and the compiler makes that the visual order of a flex board. Without the flag, a flex board gets its children
 * in reverse, so that the spec order shows on screen with the old compiler.
 *
 * @param board - the board whose children are emitted
 */
function emissionOrder(board: BoardNode): readonly NodeSpec[] {
    const children = board.children ?? [];
    if (board.flex === undefined || NATURAL_CHILD_ORDER) {
        return children;
    }
    return [...children].reverse();
}

/**
 * Builds the solid fill of one palette entry.
 *
 * @param color - palette entry
 */
function solidFill(color: ColorName): { fillColor: string; fillOpacity: number } {
    return { fillColor: PALETTE[color], fillOpacity: 1 };
}

/**
 * Builds the shape props of a board, rectangle or ellipse. A shape without fill gets an empty fill list.
 *
 * @param fill - palette entry of the fill, or undefined for no fill
 * @param stroke - stroke, or undefined for none
 * @param radius - corner radius, or undefined or zero for square corners
 */
function shapeProps(
    fill: ColorName | undefined,
    stroke: StrokeSpec | undefined,
    radius: number | undefined
): Record<string, unknown> {
    const props: Record<string, unknown> = { fills: fill === undefined ? [] : [solidFill(fill)] };
    if (stroke !== undefined) {
        props.strokes = [{ strokeColor: PALETTE[stroke.color], strokeOpacity: 1, strokeWidth: stroke.width }];
    }
    if (radius !== undefined && radius > 0) {
        props.r1 = radius;
        props.r2 = radius;
        props.r3 = radius;
        props.r4 = radius;
    }
    return props;
}

/**
 * Builds the `set_flex_layout` operation of a board.
 *
 * @param pageId - page of the board
 * @param id - handle of the board
 * @param flex - the layout spec
 */
function flexOperation(pageId: string, id: string, flex: FlexSpec): Operation {
    return {
        op: "set_flex_layout",
        pageId,
        id,
        layoutFlexDir: flex.direction,
        layoutGap: { rowGap: flex.gap, columnGap: flex.gap },
        layoutPadding: { p1: flex.padding, p2: flex.padding, p3: flex.padding, p4: flex.padding },
        layoutAlignItems: flex.align,
        layoutJustifyContent: flex.justify ?? "start",
    };
}
