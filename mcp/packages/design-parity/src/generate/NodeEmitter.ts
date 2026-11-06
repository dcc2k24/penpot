import { toCssRgba } from "../Colour.js";
import type {
    LayoutModel,
    NodeModel,
    NodeType,
    StrokeModel,
    TextModel,
    TokensModel,
    TypographyModel,
} from "../DesignModel.js";
import { cssFontFamily } from "../FontMap.js";
import { toSlug } from "../Targets.js";
import { colourTokenVariable } from "./TokenCss.js";

/** A generated component that a copy node instantiates. */
export interface ResolvedInstance {
    /** React name of the component, for example "ButtonPrimaryMD". */
    readonly componentName: string;
    /** Path of the component module relative to app/src, for example "components/ButtonPrimaryMD.tsx". */
    readonly modulePath: string;
    /** Main board of the component on the Components page. */
    readonly main: NodeModel;
}

/** Overrides of one instance, keyed by index path relative to the instance root. */
export interface Overrides {
    /** Node id of each element. */
    readonly ids: Record<string, string>;
    /** Characters of each text element. */
    readonly texts: Record<string, string>;
    /** Paint of each element that has one in the copy: a background for a shape, a colour for a text. */
    readonly fills: Record<string, { readonly paint: string }>;
}

/** Options of a node emitter. */
export interface EmitOptions {
    /** Token sets, themes and tokens of the design. */
    readonly tokens: TokensModel;
    /** Text styles of the design library. */
    readonly typographies: readonly TypographyModel[];
    /** True for a component module, which reads props. False for a screen, which is static. */
    readonly dynamic: boolean;
    /** Name of the module, put at the start of each warning. */
    readonly where: string;
    /** Receives each warning. */
    readonly warn: (message: string) => void;
    /** Finds the generated component of a copy node, or undefined when the model does not know the component. */
    readonly resolve: (node: NodeModel) => ResolvedInstance | undefined;
}

/** Where a node sits. A flow node is a child of a flex container, an absolute node is placed by its left and top. */
export type Placement =
    | { readonly kind: "root" }
    | { readonly kind: "flow" }
    | { readonly kind: "absolute"; readonly left: number; readonly top: number };

/** One React style entry: the key and the JavaScript expression of its value. */
type StyleEntry = [string, string];

/** Node types that render as a plain element and get a warning, because the current file has none of them. */
const PLAIN_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["group", "bool", "path", "svg-raw", "other", "image"]);

/** Line height that Penpot gives a paragraph with none: the line height of its default typography. */
const DEFAULT_LINE_HEIGHT = 1.2;

/** JavaScript literal of a no-break space, which Penpot writes for a text run with no characters. */
const NO_BREAK_SPACE_LITERAL = '"\\u00a0"';

/**
 * Collects the overrides of a copy by walking it together with its main board. Children are paired by position, and
 * the copy values (ids, characters and paints) become the overrides. Structure differences add a warning.
 *
 * @param copy - copy node in a design board
 * @param main - main board of the component that the copy instantiates
 * @param tokens - token sets of the design, used to name colours
 * @param warn - receives each warning
 */
export function collectOverrides(
    copy: NodeModel,
    main: NodeModel,
    tokens: TokensModel,
    warn: (message: string) => void
): Overrides {
    const ids: Record<string, string> = {};
    const texts: Record<string, string> = {};
    const fills: Record<string, { readonly paint: string }> = {};
    collectInto(copy, main, "", { ids, texts, fills }, tokens, warn);
    return { ids, texts, fills };
}

/**
 * Fills the overrides of one copy node and, recursively, of its paired children.
 *
 * @param copy - copy node
 * @param main - main node that the copy pairs with
 * @param path - index path of the copy relative to the instance root
 * @param out - overrides being filled
 * @param tokens - token sets of the design
 * @param warn - receives each warning
 */
function collectInto(
    copy: NodeModel,
    main: NodeModel,
    path: string,
    out: { ids: Record<string, string>; texts: Record<string, string>; fills: Record<string, { paint: string }> },
    tokens: TokensModel,
    warn: (message: string) => void
): void {
    out.ids[path] = copy.id;
    if (copy.type === "text" && copy.text !== null) {
        out.texts[path] = copy.text.characters;
    }
    const copyPaint = paintOf(copy, tokens);
    if (copyPaint !== undefined) {
        out.fills[path] = { paint: copyPaint };
    }
    if (copyPaint === undefined && paintOf(main, tokens) !== undefined) {
        warn(`copy ${copy.id} has no paint at path "${path}", so the paint of its main ${main.id} is shown`);
    }
    if (copyPaint !== undefined && paintOf(main, tokens) === undefined) {
        warn(`copy ${copy.id} paints path "${path}" but its main ${main.id} does not, so the paint is not applied`);
    }
    if (copy.children.length !== main.children.length) {
        warn(
            `copy ${copy.id} has ${copy.children.length} children but its main ${main.id} has ${main.children.length}`
        );
    }
    const count = Math.min(copy.children.length, main.children.length);
    for (let index = 0; index < count; index++) {
        const copyChild = copy.children[index];
        const mainChild = main.children[index];
        if (copyChild.name !== mainChild.name) {
            warn(`child ${index} of copy ${copy.id} is "${copyChild.name}" but its main child is "${mainChild.name}"`);
        }
        if (copyComponentId(copyChild) !== copyComponentId(mainChild)) {
            warn(`child ${index} of copy ${copy.id} is a different component from its main child ${mainChild.id}`);
        }
        const childPath = path === "" ? String(index) : `${path}/${index}`;
        collectInto(copyChild, mainChild, childPath, out, tokens, warn);
    }
}

/**
 * Returns the paint of a node in CSS: the text colour of a text, or the first fill of a shape.
 *
 * @param node - node to read
 * @param tokens - token sets of the design
 */
function paintOf(node: NodeModel, tokens: TokensModel): string | undefined {
    if (node.type === "text") {
        return node.text?.fill ?? undefined;
    }
    const first = node.fills[0];
    return first === undefined ? undefined : paintCss(first.hex, first.opacity, tokens);
}

/**
 * Formats the colour of a fill or stroke as CSS. An opaque colour uses its token when there is one, and a translucent
 * colour is an rgba value.
 *
 * @param hex - colour as upper case `#RRGGBB`
 * @param opacity - opacity of the paint, or null when the design gives none
 * @param tokens - token sets of the design
 */
export function paintCss(hex: string, opacity: number | null, tokens: TokensModel): string {
    const alpha = opacity ?? 1;
    const colour = { hex, alpha };
    if (alpha === 1) {
        return colourTokenVariable(colour, tokens) ?? hex;
    }
    return toCssRgba(colour);
}

/**
 * Renders the React tree of design nodes. A component module passes its props down to nested instances, and a screen
 * is static.
 */
export class NodeEmitter {
    /** Generated components that the emitted tree instantiates, by component name. */
    public readonly nested = new Map<string, ResolvedInstance>();

    /**
     * Creates an emitter.
     *
     * @param options - options of the emitter
     */
    public constructor(private readonly options: EmitOptions) {}

    /**
     * Renders a root board as JSX lines, indented for the body of a function that returns it.
     *
     * @param board - main board of a component, or board of a screen
     */
    public renderRoot(board: NodeModel): string[] {
        return this.element(board, "", null, { kind: "root" }, 2);
    }

    /**
     * Renders one node and, through its children, the whole subtree.
     *
     * @param node - node to render
     * @param path - index path of the node relative to the root
     * @param parent - parent node, or null for the root
     * @param placement - where the node sits
     * @param depth - indentation level of the element
     */
    private element(
        node: NodeModel,
        path: string,
        parent: NodeModel | null,
        placement: Placement,
        depth: number
    ): string[] {
        if (parent !== null && isCopy(node)) {
            const resolved = this.options.resolve(node);
            if (resolved !== undefined) {
                return this.instance(node, path, placement, depth, resolved);
            }
            this.warn(`copy ${node.id} of an unknown component is rendered as a plain element`);
        }
        if (node.type === "text" && node.text !== null) {
            return this.text(node, path, placement, depth);
        }
        if (node.type === "text") {
            this.warn(`text ${node.id} has no text record and is rendered as a plain element`);
        } else if (PLAIN_TYPES.has(node.type)) {
            this.warn(`${node.type} ${node.id} is rendered as a plain element`);
        }
        return this.shape(node, path, placement, depth);
    }

    /**
     * Renders a shape as a div.
     *
     * @param node - shape node
     * @param path - index path of the node
     * @param placement - where the node sits
     * @param depth - indentation level of the element
     */
    private shape(node: NodeModel, path: string, placement: Placement, depth: number): string[] {
        const entries: StyleEntry[] = [["boxSizing", '"border-box"'], ...this.placementEntries(placement, node)];
        if (node.layout !== null) {
            entries.push(...this.flexEntries(node, node.layout));
        }
        if (node.type === "ellipse") {
            entries.push(["borderRadius", '"50%"']);
        } else {
            entries.push(["borderRadius", quote(radiusCss(node.radius))]);
        }
        const first = node.fills[0];
        if (first !== undefined) {
            if (node.fills.length > 1) {
                this.warn(`node ${node.id} has ${node.fills.length} fills, only the first is used`);
            }
            entries.push([
                "backgroundColor",
                this.paintExpr(path, paintCss(first.hex, first.opacity, this.options.tokens)),
            ]);
        }
        const stroke = node.strokes[0];
        if (stroke !== undefined) {
            entries.push(...this.strokeEntries(stroke));
        }
        if (node.opacity !== null && node.opacity !== 1) {
            entries.push(["opacity", num(node.opacity)]);
        }
        const attributes = [this.idAttribute(node, path), nameAttribute(node)];
        const children = this.children(node, path, depth);
        return renderTag("div", attributes, entries, children, depth);
    }

    /**
     * Lists the box-shadow entry that draws the first stroke of a node. A box shadow does not change the box of the
     * node, so the stroke needs no border. Each shadow lies inside or outside the edge, as the alignment says.
     *
     * @param stroke - first stroke of the node
     */
    private strokeEntries(stroke: StrokeModel): StyleEntry[] {
        const colour = paintCss(stroke.hex, stroke.opacity, this.options.tokens);
        const shadows = strokeShadowOf(stroke).map(
            (shadow) => `${shadow.inset ? "inset " : ""}0 0 0 ${shadow.spread}px ${colour}`
        );
        return [["boxShadow", quote(shadows.join(", "))]];
    }

    /**
     * Renders a text node as Penpot's foreignObject text renderer does. The root is a flex box that holds a
     * paragraph-set, which holds one paragraph and one span for the text. The root aligns the paragraph-set at the
     * vertical alignment of the box. The paragraph-set grows to the width of the box unless the text auto-widths.
     *
     * @param node - text node with a text record
     * @param path - index path of the node
     * @param placement - where the node sits
     * @param depth - indentation level of the element
     */
    private text(node: NodeModel, path: string, placement: Placement, depth: number): string[] {
        const text = node.text as TextModel;
        const autoWidth = text.growType === "auto-width";
        const rootEntries: StyleEntry[] = [
            ["display", '"flex"'],
            ["whiteSpace", '"break-spaces"'],
            ...this.placementEntries(placement, node),
            ["alignItems", quote(this.verticalAlignItemsOf(node, text.verticalAlign))],
        ];
        const setEntries: StyleEntry[] = [
            ["display", '"inline-flex"'],
            ["flexDirection", '"column"'],
            ["justifyContent", '"inherit"'],
        ];
        if (!autoWidth) {
            setEntries.push(["minWidth", '"100%"']);
        }
        setEntries.push(["marginRight", '"1px"'], ["verticalAlign", '"top"']);
        const paragraphEntries: StyleEntry[] = [
            ["fontSize", "0"],
            ["lineHeight", num(text.paragraphLineHeight ?? DEFAULT_LINE_HEIGHT)],
            ["margin", "0"],
            ["textAlign", quote(text.textAlign ?? "start")],
        ];
        const spanAttributes = ['data-text-leaf=""'];
        const leafEntries = this.leafEntries(node, path, text, autoWidth);
        const child = `${indent(depth + 4)}${this.textExpression(path, text.characters)}`;
        const span = renderTag("span", spanAttributes, leafEntries, [child], depth + 3);
        const paragraph = renderTag("p", ['dir="auto"'], paragraphEntries, span, depth + 2);
        const paragraphSet = renderTag("div", [], setEntries, paragraph, depth + 1);
        const attributes = [this.idAttribute(node, path), nameAttribute(node)];
        return renderTag("div", attributes, rootEntries, paragraphSet, depth);
    }

    /**
     * Lists the style entries of the span of a text run: its size, colour, wrapping and font. The run carries no
     * decoration or transform in the model, so both are none.
     *
     * @param node - text node, for the warnings
     * @param path - index path of the node
     * @param text - text record of the node
     * @param autoWidth - true when the text grows to fit its characters
     */
    private leafEntries(node: NodeModel, path: string, text: TextModel, autoWidth: boolean): StyleEntry[] {
        const entries: StyleEntry[] = [];
        if (text.fontSize !== null) {
            entries.push(["fontSize", quote(`${roundPx(text.fontSize)}px`)]);
        }
        if (text.letterSpacing !== null) {
            entries.push(["letterSpacing", quote(`${roundPx(text.letterSpacing)}px`)]);
        }
        entries.push(["textDecoration", '"none"'], ["textTransform", '"none"']);
        if (text.fill !== null) {
            entries.push(["color", this.paintExpr(path, text.fill)]);
        }
        entries.push(
            ["overflowWrap", '"initial"'],
            ["lineBreak", '"auto"'],
            ["whiteSpace", autoWidth ? '"pre"' : '"break-spaces"'],
            ["textRendering", '"geometricPrecision"']
        );
        if (text.fontFamily !== null) {
            entries.push(["fontFamily", quote(cssFontFamily(text.fontFamily))]);
        } else {
            this.warn(`text ${node.id} has no font family`);
        }
        entries.push(["fontStyle", quote(text.fontStyle ?? "normal")]);
        if (text.fontWeight !== null) {
            const weight = Number(text.fontWeight);
            if (text.fontWeight.trim() !== "" && Number.isFinite(weight)) {
                entries.push(["fontWeight", num(weight)]);
            } else {
                this.warn(`text ${node.id} has font weight ${text.fontWeight}, which is not a number, so none is set`);
            }
        }
        return entries;
    }

    /**
     * Maps the vertical alignment of a text box to the alignment of its paragraph-set across the root box. Penpot puts
     * the lines at the top unless the alignment says otherwise, so a missing alignment is top.
     *
     * @param node - text node, for the warning
     * @param value - vertical alignment of the text box, or null when the design gives none
     */
    private verticalAlignItemsOf(node: NodeModel, value: string | null): string {
        switch (value) {
            case null:
            case "top":
                return "flex-start";
            case "center":
                return "center";
            case "bottom":
                return "flex-end";
            default:
                this.warn(`text ${node.id} has vertical-align ${value}, rendered as flex-start`);
                return "flex-start";
        }
    }

    /**
     * Renders a copy as a call of its generated component, with the overrides of the copy.
     *
     * @param node - copy node
     * @param path - index path of the copy
     * @param placement - where the copy sits
     * @param depth - indentation level of the element
     * @param resolved - generated component of the copy
     */
    private instance(
        node: NodeModel,
        path: string,
        placement: Placement,
        depth: number,
        resolved: ResolvedInstance
    ): string[] {
        this.nested.set(resolved.componentName, resolved);
        const overrides = collectOverrides(node, resolved.main, this.options.tokens, (message) => this.warn(message));
        const attributes: string[] = [];
        if (this.options.dynamic) {
            attributes.push(`{...nestedProps(props, ${quote(path)}, ${defaultsLiteral(overrides)})}`);
        } else {
            attributes.push(`ids={${recordLiteral(overrides.ids)}}`);
            attributes.push(`texts={${recordLiteral(overrides.texts)}}`);
            attributes.push(`fills={${fillsLiteral(overrides.fills)}}`);
        }
        attributes.push(...this.placementAttributes(placement));
        attributes.push(`width={${num(node.width)}}`, `height={${num(node.height)}}`);
        return renderTag(resolved.componentName, attributes, undefined, [], depth);
    }

    /**
     * Renders the children of a node at the depth below it. A flex container lists its children in the order of their
     * position, and any other node keeps the list order and places each child by its offset.
     *
     * @param node - parent node
     * @param path - index path of the parent
     * @param depth - indentation level of the parent
     */
    private children(node: NodeModel, path: string, depth: number): string[] {
        const lines: string[] = [];
        const ordered = node.children.map((child, index) => ({ child, index }));
        if (node.layout !== null) {
            const horizontal = node.layout.dir !== "column";
            ordered.sort((a, b) => {
                const delta = horizontal ? a.child.x - b.child.x : a.child.y - b.child.y;
                return delta !== 0 ? delta : a.index - b.index;
            });
        }
        for (const { child, index } of ordered) {
            const childPath = path === "" ? String(index) : `${path}/${index}`;
            let placement: Placement;
            if (node.layout !== null) {
                placement = { kind: "flow" };
            } else {
                placement = {
                    kind: "absolute",
                    left: roundPx(child.x - node.x),
                    top: roundPx(child.y - node.y),
                };
            }
            lines.push(...this.element(child, childPath, node, placement, depth + 1));
        }
        return lines;
    }

    /**
     * Lists the style entries that place a node: its position, its size and, for a root, the props.
     *
     * @param placement - where the node sits
     * @param node - node to place
     */
    private placementEntries(placement: Placement, node: NodeModel): StyleEntry[] {
        const entries: StyleEntry[] = [];
        if (placement.kind === "root") {
            if (this.options.dynamic) {
                entries.push(
                    ["position", 'props.position ?? "relative"'],
                    ["left", "props.left"],
                    ["top", "props.top"],
                    ["width", `props.width ?? ${num(node.width)}`],
                    ["height", `props.height ?? ${num(node.height)}`]
                );
                return entries;
            }
            entries.push(["position", '"relative"']);
        } else if (placement.kind === "flow") {
            entries.push(["position", '"relative"'], ["flex", '"none"']);
        } else {
            entries.push(["position", '"absolute"'], ["left", num(placement.left)], ["top", num(placement.top)]);
        }
        entries.push(["width", num(node.width)], ["height", num(node.height)]);
        return entries;
    }

    /**
     * Lists the attributes that place a nested instance.
     *
     * @param placement - where the instance sits
     */
    private placementAttributes(placement: Placement): string[] {
        if (placement.kind === "absolute") {
            return [`position="absolute"`, `left={${num(placement.left)}}`, `top={${num(placement.top)}}`];
        }
        return [`position="relative"`];
    }

    /**
     * Lists the flex style entries of a flex container. The padding is the design padding. A stroke does not change it.
     *
     * @param node - flex container
     * @param layout - auto layout of the container
     */
    private flexEntries(node: NodeModel, layout: LayoutModel): StyleEntry[] {
        const direction = layout.dir === "column" ? "column" : "row";
        if (layout.dir !== "row" && layout.dir !== "column") {
            this.warn(`node ${node.id} has layout direction ${layout.dir ?? "null"}, laid out as row`);
        }
        const padding = layout.padding ?? [0, 0, 0, 0];
        if (layout.wrap !== null && layout.wrap !== "nowrap") {
            this.warn(`node ${node.id} has wrap ${layout.wrap}, rendered as nowrap`);
        }
        const paddingCss = padding.map((value) => `${roundPx(value)}px`).join(" ");
        return [
            ["display", '"flex"'],
            ["flexDirection", quote(direction)],
            ["rowGap", quote(`${roundPx(layout.gap.row ?? 0)}px`)],
            ["columnGap", quote(`${roundPx(layout.gap.column ?? 0)}px`)],
            ["padding", quote(paddingCss)],
            ["flexWrap", '"nowrap"'],
            ["alignItems", quote(this.alignItemsOf(node, layout.alignItems))],
            ["justifyContent", quote(this.justifyOf(node, layout.justifyContent))],
        ];
    }

    /**
     * Maps a Penpot alignment across the layout to a CSS value.
     *
     * @param node - flex container, for the warning
     * @param value - Penpot alignment
     */
    private alignItemsOf(node: NodeModel, value: string | null): string {
        switch (value) {
            case "start":
                return "flex-start";
            case "center":
                return "center";
            case "end":
                return "flex-end";
            case "stretch":
                return "stretch";
            default:
                this.warn(`node ${node.id} has align-items ${value ?? "null"}, rendered as flex-start`);
                return "flex-start";
        }
    }

    /**
     * Maps a Penpot justification along the layout to a CSS value.
     *
     * @param node - flex container, for the warning
     * @param value - Penpot justification
     */
    private justifyOf(node: NodeModel, value: string | null): string {
        switch (value) {
            case "start":
                return "flex-start";
            case "center":
                return "center";
            case "end":
                return "flex-end";
            case "space-between":
            case "space-around":
            case "space-evenly":
                return value;
            default:
                this.warn(`node ${node.id} has justify-content ${value ?? "null"}, rendered as flex-start`);
                return "flex-start";
        }
    }

    /**
     * Returns the id attribute of an element: a prop lookup in a component, or the literal id in a screen.
     *
     * @param node - node the element stands for
     * @param path - index path of the node
     */
    private idAttribute(node: NodeModel, path: string): string {
        if (this.options.dynamic) {
            return `data-node-id={props.ids?.[${quote(path)}] ?? ${quote(node.id)}}`;
        }
        return `data-node-id={${quote(node.id)}}`;
    }

    /**
     * Returns the paint expression of an element: a prop lookup in a component, or the literal in a screen.
     *
     * @param path - index path of the element
     * @param fallback - CSS value that the element paints with when no prop overrides it
     */
    private paintExpr(path: string, fallback: string): string {
        if (this.options.dynamic) {
            return `props.fills?.[${quote(path)}]?.paint ?? ${quote(fallback)}`;
        }
        return quote(fallback);
    }

    /**
     * Returns the JSX child expression of a text: a prop lookup in a component, or the literal in a screen. A text
     * with no characters holds a no-break space, as Penpot writes it.
     *
     * @param path - index path of the text
     * @param characters - characters of the text in the design
     */
    private textExpression(path: string, characters: string): string {
        const literal = characters === "" ? NO_BREAK_SPACE_LITERAL : quote(characters);
        if (this.options.dynamic) {
            return `{props.texts?.[${quote(path)}] ?? ${literal}}`;
        }
        return `{${literal}}`;
    }

    /**
     * Sends a warning to the caller, with the module name in front.
     *
     * @param message - text of the warning
     */
    private warn(message: string): void {
        this.options.warn(`${this.options.where}: ${message}`);
    }
}

/**
 * Tells whether a node is a copy of a library component that is not its main instance.
 *
 * @param node - node to check
 */
function isCopy(node: NodeModel): boolean {
    return node.component !== null && node.component.mainInstance === false;
}

/**
 * Returns the component id that a copy refers to, or null for a node that is not a copy.
 *
 * @param node - node to read
 */
function copyComponentId(node: NodeModel): string | null {
    return isCopy(node) && node.component !== null ? node.component.componentId : null;
}

/** One box shadow that draws part of a stroke. */
export interface StrokeShadow {
    /** True for an inset shadow, which lies inside the edge. False for an outer shadow, which lies outside it. */
    readonly inset: boolean;
    /** Spread of the shadow in pixels, rounded as the generator rounds numbers. */
    readonly spread: number;
}

/**
 * Lists the box shadows that draw a stroke. A stroke without a width is 1px wide. A stroke without an alignment is
 * centred, as Penpot draws it. An inner stroke is one inset shadow of its full width, an outer stroke is one outer
 * shadow of its full width, and a centred stroke is an inset and an outer shadow of half its width each.
 *
 * @param stroke - stroke to draw
 * @returns the shadows in the order that the generator writes them
 */
export function strokeShadowOf(stroke: StrokeModel): StrokeShadow[] {
    const width = stroke.width ?? 1;
    switch (stroke.alignment) {
        case "inner":
            return [{ inset: true, spread: roundPx(width) }];
        case "outer":
            return [{ inset: false, spread: roundPx(width) }];
        default: {
            const half = roundPx(width / 2);
            return [
                { inset: true, spread: half },
                { inset: false, spread: half },
            ];
        }
    }
}

/**
 * Returns the border-radius value of the four corners in CSS order.
 *
 * @param radius - corner radii r1 to r4, or null
 */
function radiusCss(radius: [number, number, number, number] | null): string {
    return (radius ?? [0, 0, 0, 0]).map((value) => `${roundPx(value)}px`).join(" ");
}

/**
 * Returns the data-node-name attribute of a node.
 *
 * @param node - node to name
 */
function nameAttribute(node: NodeModel): string {
    return `data-node-name={${quote(node.name)}}`;
}

/**
 * Renders a JSX element as lines. A style is written one entry per line, and an element without children is closed in
 * place.
 *
 * @param name - tag name or component name
 * @param attributes - attributes, each as one line of JSX
 * @param entries - style entries, or undefined for no style
 * @param children - child lines, already indented one level below the element
 * @param depth - indentation level of the element
 */
function renderTag(
    name: string,
    attributes: string[],
    entries: StyleEntry[] | undefined,
    children: string[],
    depth: number
): string[] {
    const open = indent(depth);
    const inner = indent(depth + 1);
    const lines = [`${open}<${name}`];
    for (const attribute of attributes) {
        lines.push(`${inner}${attribute}`);
    }
    if (entries !== undefined && entries.length > 0) {
        lines.push(`${inner}style={{`);
        for (const [key, value] of entries) {
            lines.push(`${inner}    ${key}: ${value},`);
        }
        lines.push(`${inner}}}`);
    }
    if (children.length === 0) {
        lines.push(`${open}/>`);
        return lines;
    }
    lines.push(`${open}>`, ...children, `${open}</${name}>`);
    return lines;
}

/**
 * Returns the indentation of a depth, four spaces per level.
 *
 * @param depth - indentation level
 */
function indent(depth: number): string {
    return "    ".repeat(depth);
}

/**
 * Returns a JavaScript string literal of a value.
 *
 * @param value - text to quote
 */
function quote(value: string): string {
    return JSON.stringify(value);
}

/**
 * Returns a JavaScript number literal of a value, rounded to three decimals.
 *
 * @param value - number to format
 */
function num(value: number): string {
    return String(roundPx(value));
}

/**
 * Rounds a number to three decimals, so that differences of floating point arithmetic do not reach the output.
 *
 * @param value - number to round
 */
function roundPx(value: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Formats a record of strings as an object literal on one line.
 *
 * @param record - keys and values
 */
function recordLiteral(record: Record<string, string>): string {
    const entries = Object.keys(record).map((key) => `${quote(key)}: ${quote(record[key])}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/**
 * Formats the fills of overrides as an object literal on one line.
 *
 * @param record - keys and paints
 */
function fillsLiteral(record: Record<string, { readonly paint: string }>): string {
    const entries = Object.keys(record).map((key) => `${quote(key)}: { "paint": ${quote(record[key].paint)} }`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/**
 * Formats the overrides of a nested instance as the defaults object of nestedProps.
 *
 * @param overrides - overrides of the copy
 */
function defaultsLiteral(overrides: Overrides): string {
    return `{ "ids": ${recordLiteral(overrides.ids)}, "texts": ${recordLiteral(overrides.texts)}, "fills": ${fillsLiteral(overrides.fills)} }`;
}
