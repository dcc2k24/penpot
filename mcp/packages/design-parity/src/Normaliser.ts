import type {
    ComponentModel,
    ComponentRefModel,
    DesignModel,
    FillModel,
    LayoutItemModel,
    LayoutModel,
    NodeModel,
    NodeType,
    PageModel,
    StrokeModel,
    TextModel,
    TokenModel,
    TokenSetModel,
    TokenThemeModel,
    TokensModel,
    TypographyModel,
} from "./DesignModel.js";
import { normalizeName } from "./DesignSpec.js";

/** Id of the root of every page tree. The root is never a node of the model. */
const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Raw JSON object as the backend returns it. */
type RawRecord = Record<string, unknown>;

/**
 * Maps a raw shape type to the node type of the model. Types that are not listed become "other". The backend
 * returns an ellipse as "ellipse" now. It returned "circle" before, so that name maps to the same node type.
 */
const NODE_TYPES: ReadonlyMap<string, NodeType> = new Map<string, NodeType>([
    ["frame", "board"],
    ["ellipse", "ellipse"],
    ["circle", "ellipse"],
    ["rect", "rect"],
    ["text", "text"],
    ["group", "group"],
    ["bool", "bool"],
    ["path", "path"],
    ["image", "image"],
    ["svg-raw", "svg-raw"],
]);

/** Matches a colour with six hex digits, with or without a leading hash. */
const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

/**
 * Raw responses of the backend for one pull, as the normaliser reads them.
 */
export interface NormaliserInput {
    /** Result of get_file_outline. */
    readonly outline: Record<string, unknown>;
    /** Page id to the result of get_page_tree of that page. Each result holds the `root` of the page. */
    readonly trees: ReadonlyMap<string, Record<string, unknown>>;
    /** Shape id to the raw shape object from get_shapes. */
    readonly shapes: ReadonlyMap<string, Record<string, unknown>>;
    /** Result of get_library. */
    readonly library: Record<string, unknown>;
    /** Result of get_tokens. */
    readonly tokens: Record<string, unknown>;
    /** Time of the pull, as an ISO 8601 string. The normaliser does not read the clock itself. */
    readonly pulledAt: string;
}

/**
 * Turns the raw responses of one pull into a DesignModel. It does no I/O and reads no clock.
 */
export class DesignNormaliser {
    /**
     * Normalises one pull.
     *
     * @param input - raw responses of the backend and the pull time
     * @throws Error when a page of the outline has no tree in the input
     */
    normalise(input: NormaliserInput): DesignModel {
        return {
            formatVersion: 1,
            file: this.normaliseFile(input.outline),
            pulledAt: input.pulledAt,
            pages: this.normalisePages(input),
            components: this.normaliseComponents(input.library),
            typographies: this.normaliseTypographies(input.library),
            tokens: this.normaliseTokens(input.tokens),
        };
    }

    /**
     * Reads the file header from the outline.
     *
     * @param outline - result of get_file_outline
     */
    private normaliseFile(outline: RawRecord): DesignModel["file"] {
        return {
            id: this.asString(outline.id) ?? "",
            name: this.asString(outline.name) ?? "",
            revn: this.asNumber(outline.revn),
            projectId: this.asString(outline.projectId) ?? null,
        };
    }

    /**
     * Normalises every page of the outline, in outline order.
     *
     * @param input - raw responses of the pull
     * @throws Error when a page has no tree in the input
     */
    private normalisePages(input: NormaliserInput): PageModel[] {
        return this.asArray(input.outline.pages).map((entry, position) => {
            const page: RawRecord = this.asRecord(entry) ?? {};
            const id = this.asString(page.id) ?? "";
            const name = this.asString(page.name) ?? "";
            const tree = input.trees.get(id);
            if (tree === undefined) {
                throw new Error(`No page tree for page "${name}".`);
            }
            const root: RawRecord = this.asRecord(tree.root) ?? {};
            return {
                id,
                name,
                index: this.asNumber(page.index) ?? position,
                boards: this.normaliseChildren(root, input.shapes),
            };
        });
    }

    /**
     * Normalises the children that a tree node lists, in list order. Entries without an id are skipped.
     *
     * @param parent - tree node or tree root whose `children` are read
     * @param shapes - raw shapes by id
     */
    private normaliseChildren(parent: RawRecord, shapes: ReadonlyMap<string, RawRecord>): NodeModel[] {
        const nodes: NodeModel[] = [];
        for (const child of this.asRecords(parent.children)) {
            const id = this.asString(child.id);
            if (id !== undefined) {
                nodes.push(this.normaliseNode(id, child, shapes));
            }
        }
        return nodes;
    }

    /**
     * Normalises one node. The raw shape wins. The tree node fills the name, type, geometry and component id when
     * the shape lacks them.
     *
     * @param id - id of the node
     * @param treeNode - the node as the page tree lists it
     * @param shapes - raw shapes by id
     */
    private normaliseNode(id: string, treeNode: RawRecord, shapes: ReadonlyMap<string, RawRecord>): NodeModel {
        const shape: RawRecord = shapes.get(id) ?? {};
        const type = this.mapType(this.asString(shape.type) ?? this.asString(treeNode.type));
        return {
            id,
            name: this.asString(shape.name) ?? this.asString(treeNode.name) ?? "",
            type,
            parentId: this.parentIdOf(shape, treeNode),
            x: this.asNumber(shape.x) ?? this.asNumber(treeNode.x) ?? 0,
            y: this.asNumber(shape.y) ?? this.asNumber(treeNode.y) ?? 0,
            width: this.asNumber(shape.width) ?? this.asNumber(treeNode.width) ?? 0,
            height: this.asNumber(shape.height) ?? this.asNumber(treeNode.height) ?? 0,
            rotation: this.asNumber(shape.rotation),
            hidden: this.asBoolean(shape.hidden),
            opacity: this.asNumber(shape.opacity),
            fills: this.normaliseFills(shape.fills),
            strokes: this.normaliseStrokes(shape.strokes),
            radius: this.fourNumbers([shape.r1, shape.r2, shape.r3, shape.r4]),
            layout: this.normaliseLayout(shape),
            layoutItem: this.normaliseLayoutItem(shape),
            text: type === "text" ? this.normaliseText(shape) : null,
            component: this.normaliseComponentRef(shape, treeNode),
            children: this.normaliseChildren(treeNode, shapes),
        };
    }

    /**
     * Returns the parent id of a node, or null for a top-level node or when the parent is the page root.
     *
     * @param shape - raw shape of the node
     * @param treeNode - the node as the page tree lists it
     */
    private parentIdOf(shape: RawRecord, treeNode: RawRecord): string | null {
        const parentId = this.asString(shape.parentId) ?? this.asString(treeNode.parentId);
        return parentId === undefined || parentId === ROOT_ID ? null : parentId;
    }

    /**
     * Maps a raw shape type to a node type.
     *
     * @param raw - raw type string, or undefined when missing
     */
    private mapType(raw: string | undefined): NodeType {
        return NODE_TYPES.get(raw ?? "") ?? "other";
    }

    /**
     * Normalises the fills of a shape. Entries without a colour are skipped.
     *
     * @param value - raw `fills` value
     */
    private normaliseFills(value: unknown): FillModel[] {
        const fills: FillModel[] = [];
        for (const fill of this.asRecords(value)) {
            const hex = this.asHex(fill.fillColor);
            if (hex !== null) {
                fills.push({ hex, opacity: this.asNumber(fill.fillOpacity) });
            }
        }
        return fills;
    }

    /**
     * Normalises the strokes of a shape. Entries without a colour are skipped.
     *
     * @param value - raw `strokes` value
     */
    private normaliseStrokes(value: unknown): StrokeModel[] {
        const strokes: StrokeModel[] = [];
        for (const stroke of this.asRecords(value)) {
            const hex = this.asHex(stroke.strokeColor);
            if (hex !== null) {
                const alignment = this.asString(stroke.strokeAlignment);
                strokes.push({
                    hex,
                    opacity: this.asNumber(stroke.strokeOpacity),
                    width: this.asNumber(stroke.strokeWidth),
                    alignment:
                        alignment === "inner" || alignment === "center" || alignment === "outer" ? alignment : null,
                });
            }
        }
        return strokes;
    }

    /**
     * Normalises the auto layout of a shape. Only a shape with layout "flex" has one.
     *
     * @param shape - raw shape
     */
    private normaliseLayout(shape: RawRecord): LayoutModel | null {
        if (shape.layout !== "flex") {
            return null;
        }
        const gap: RawRecord = this.asRecord(shape.layoutGap) ?? {};
        return {
            dir: this.asString(shape.layoutFlexDir) ?? null,
            gap: { row: this.asNumber(gap.rowGap), column: this.asNumber(gap.columnGap) },
            padding: this.normalisePadding(shape.layoutPadding),
            alignItems: this.asString(shape.layoutAlignItems) ?? null,
            justifyContent: this.asString(shape.layoutJustifyContent) ?? null,
            wrap: this.asString(shape.layoutWrapType) ?? null,
        };
    }

    /**
     * Normalises the padding of an auto layout.
     *
     * @param value - raw `layoutPadding` value
     */
    private normalisePadding(value: unknown): [number, number, number, number] | null {
        const padding = this.asRecord(value);
        if (padding === undefined) {
            return null;
        }
        return this.fourNumbers([padding.p1, padding.p2, padding.p3, padding.p4]);
    }

    /**
     * Normalises the sizing of a shape inside an auto layout. Null when the shape has neither sizing field.
     *
     * @param shape - raw shape
     */
    private normaliseLayoutItem(shape: RawRecord): LayoutItemModel | null {
        // The backend names the layout item sizing attributes with the layout-item prefix.
        const hSizing = this.asString(shape.layoutItemHSizing);
        const vSizing = this.asString(shape.layoutItemVSizing);
        if (hSizing === undefined && vSizing === undefined) {
            return null;
        }
        return { hSizing: hSizing ?? null, vSizing: vSizing ?? null };
    }

    /**
     * Normalises the text of a text shape, read from its first text run.
     *
     * @param shape - raw text shape
     */
    private normaliseText(shape: RawRecord): TextModel {
        const run = this.findTextRun(shape.content);
        const firstFill = this.asRecord(this.asArray(run?.fills)[0]);
        const paragraphLineHeight = this.findParagraphValue(shape.content, (p) => {
            return this.asNumber(p.lineHeight) ?? undefined;
        });
        const paragraphAlign = this.findParagraphValue(shape.content, (p) => this.asString(p.textAlign));
        return {
            characters: this.asString(shape.characters) ?? this.asString(run?.text) ?? "",
            fontFamily: this.asString(run?.fontFamily) ?? null,
            fontSize: this.asNumber(run?.fontSize),
            fontWeight: this.asWeight(run?.fontWeight),
            fontStyle: this.asString(run?.fontStyle) ?? null,
            lineHeight: this.asNumber(run?.lineHeight),
            paragraphLineHeight: paragraphLineHeight ?? null,
            letterSpacing: this.asNumber(run?.letterSpacing),
            textAlign: paragraphAlign ?? this.asString(run?.textAlign) ?? null,
            verticalAlign: this.asString(this.asRecord(shape.content)?.verticalAlign) ?? null,
            fill: this.asHex(firstFill?.fillColor),
            growType: this.asString(shape.growType) ?? null,
        };
    }

    /**
     * Finds the first value that a reader takes from a paragraph of a text content tree, depth first. Penpot stores the
     * paragraph properties on the paragraph, not on the text run.
     *
     * @param node - raw content node
     * @param read - reads a value from a paragraph, or returns undefined when the paragraph has none
     */
    private findParagraphValue<T>(node: unknown, read: (paragraph: RawRecord) => T | undefined): T | undefined {
        const record = this.asRecord(node);
        if (record === undefined) {
            return undefined;
        }
        if (record.type === "paragraph") {
            const found = read(record);
            if (found !== undefined) {
                return found;
            }
        }
        for (const child of this.asArray(record.children)) {
            const found = this.findParagraphValue(child, read);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Finds the first node of a text content tree that has a string `text` property, depth first.
     *
     * @param node - raw content node
     */
    private findTextRun(node: unknown): RawRecord | undefined {
        const record = this.asRecord(node);
        if (record === undefined) {
            return undefined;
        }
        if (typeof record.text === "string") {
            return record;
        }
        for (const child of this.asArray(record.children)) {
            const found = this.findTextRun(child);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Normalises the component reference of a shape. Null when neither the shape nor the tree node has a component.
     *
     * @param shape - raw shape
     * @param treeNode - the node as the page tree lists it
     */
    private normaliseComponentRef(shape: RawRecord, treeNode: RawRecord): ComponentRefModel | null {
        const componentId = this.asString(shape.componentId) ?? this.asString(treeNode.componentId);
        if (componentId === undefined) {
            return null;
        }
        return {
            componentId,
            mainInstance: shape.mainInstance === true,
            componentRoot: (shape.componentRoot ?? treeNode.componentRoot) === true,
        };
    }

    /**
     * Normalises the components of the library. Deleted components are left out.
     *
     * @param library - result of get_library
     */
    private normaliseComponents(library: RawRecord): ComponentModel[] {
        const components: ComponentModel[] = [];
        for (const component of this.asRecords(library.components)) {
            if (component.deleted === true) {
                continue;
            }
            const path = this.asString(component.path) ?? "";
            const name = this.asString(component.name) ?? "";
            components.push({
                id: this.asString(component.id) ?? "",
                name,
                path,
                fullName: normalizeName(path === "" ? name : `${path} / ${name}`),
                mainInstanceId: this.asString(component.mainInstanceId) ?? "",
                mainInstancePageId: this.asString(component.mainInstancePage) ?? "",
            });
        }
        return components;
    }

    /**
     * Normalises the text styles of the library.
     *
     * @param library - result of get_library
     */
    private normaliseTypographies(library: RawRecord): TypographyModel[] {
        return this.asRecords(library.typographies).map((typography) => ({
            id: this.asString(typography.id) ?? "",
            name: this.asString(typography.name) ?? "",
            fontFamily: this.asString(typography.fontFamily) ?? null,
            fontSize: this.asNumber(typography.fontSize),
            fontWeight: this.asWeight(typography.fontWeight),
            lineHeight: this.asNumber(typography.lineHeight),
            letterSpacing: this.asNumber(typography.letterSpacing),
            textTransform: this.asString(typography.textTransform) ?? null,
        }));
    }

    /**
     * Normalises the token sets, themes and tokens, and maps the active ids to names.
     *
     * @param tokens - result of get_tokens
     */
    private normaliseTokens(tokens: RawRecord): TokensModel {
        const sets: TokenSetModel[] = this.asRecords(tokens.sets).map((set) => ({
            id: this.asString(set.id) ?? "",
            name: this.asString(set.name) ?? "",
            active: set.active === true,
        }));
        const themes: TokenThemeModel[] = this.asRecords(tokens.themes).map((theme) => ({
            id: this.asString(theme.id) ?? "",
            group: this.asString(theme.group) ?? "",
            name: this.asString(theme.name) ?? "",
            sets: this.themeSetNames(theme.sets),
            active: theme.active === true,
        }));
        const setNames = this.nameIndex(sets);
        const tokenList: TokenModel[] = this.asRecords(tokens.tokens).map((token) => {
            const setId = this.asString(token.setId) ?? "";
            return {
                setName: setNames.get(setId) ?? setId,
                name: this.asString(token.name) ?? "",
                type: this.asString(token.type) ?? "",
                value: this.tokenValue(token.value),
            };
        });
        return {
            sets,
            themes,
            tokens: tokenList,
            activeThemes: this.mapIds(tokens.activeThemes, this.nameIndex(themes)),
            activeSets: this.mapIds(tokens.activeSets, setNames),
        };
    }

    /**
     * Lists the names of the sets of a theme. An entry is either a name or an object with a name.
     *
     * @param value - raw `sets` value of a theme
     */
    private themeSetNames(value: unknown): string[] {
        return this.asArray(value).flatMap((entry) => {
            const name = typeof entry === "string" ? entry : this.asString(this.asRecord(entry)?.name);
            return name === undefined ? [] : [name];
        });
    }

    /**
     * Maps each id of a list to the name it has in an index. An id that the index does not know is kept as it is.
     *
     * @param value - raw list of ids
     * @param index - names by id
     */
    private mapIds(value: unknown, index: ReadonlyMap<string, string>): string[] {
        return this.asArray(value).flatMap((entry) => {
            const id = this.asString(entry);
            return id === undefined ? [] : [index.get(id) ?? id];
        });
    }

    /**
     * Builds a map from id to name.
     *
     * @param items - items with an id and a name
     */
    private nameIndex(items: readonly { readonly id: string; readonly name: string }[]): Map<string, string> {
        return new Map(items.map((item) => [item.id, item.name] as [string, string]));
    }

    /**
     * Reads the value of a token as a string. A number becomes its string form.
     *
     * @param value - raw token value
     */
    private tokenValue(value: unknown): string {
        if (typeof value === "number") {
            return String(value);
        }
        return this.asString(value) ?? "";
    }

    /**
     * Normalises a colour to "#RRGGBB" in upper case. A string with six hex digits keeps its digits. Any other string
     * is returned in upper case with a leading hash.
     *
     * @param value - colour string
     */
    private normaliseHex(value: string): string {
        if (HEX_PATTERN.test(value)) {
            const digits = value.startsWith("#") ? value.slice(1) : value;
            return `#${digits.toUpperCase()}`;
        }
        const upper = value.toUpperCase();
        return upper.startsWith("#") ? upper : `#${upper}`;
    }

    /**
     * Reads a colour. Returns null when the value is missing or is not a non-empty string.
     *
     * @param value - raw colour value
     */
    private asHex(value: unknown): string | null {
        if (typeof value !== "string" || value.trim() === "") {
            return null;
        }
        return this.normaliseHex(value);
    }

    /**
     * Reads four corner or padding values in order. A missing value becomes 0 when another value is present. Null when
     * none is present.
     *
     * @param values - the four raw values
     */
    private fourNumbers(values: readonly unknown[]): [number, number, number, number] | null {
        const numbers = values.map((value) => this.asNumber(value));
        if (numbers.every((value) => value === null)) {
            return null;
        }
        return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
    }

    /**
     * Reads a font weight as a string. A number becomes its string form.
     *
     * @param value - raw font weight
     */
    private asWeight(value: unknown): string | null {
        if (typeof value === "string") {
            return value;
        }
        const weight = this.asNumber(value);
        return weight === null ? null : String(weight);
    }

    /**
     * Reads a number. A number stays a number, and a non-empty numeric string is parsed. Anything else is null.
     *
     * @param value - raw value
     */
    private asNumber(value: unknown): number | null {
        if (typeof value === "number") {
            return Number.isFinite(value) ? value : null;
        }
        if (typeof value === "string" && value.trim() !== "") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    /**
     * Reads a boolean. Anything that is not a boolean is null.
     *
     * @param value - raw value
     */
    private asBoolean(value: unknown): boolean | null {
        return typeof value === "boolean" ? value : null;
    }

    /**
     * Reads a string. Anything that is not a string is undefined.
     *
     * @param value - raw value
     */
    private asString(value: unknown): string | undefined {
        return typeof value === "string" ? value : undefined;
    }

    /**
     * Reads a JSON object. Arrays and other values are undefined.
     *
     * @param value - raw value
     */
    private asRecord(value: unknown): RawRecord | undefined {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return undefined;
        }
        return value as RawRecord;
    }

    /**
     * Reads an array. Anything that is not an array is an empty list.
     *
     * @param value - raw value
     */
    private asArray(value: unknown): unknown[] {
        return Array.isArray(value) ? value : [];
    }

    /**
     * Reads the JSON objects of an array, in order. Other entries are left out.
     *
     * @param value - raw value
     */
    private asRecords(value: unknown): RawRecord[] {
        return this.asArray(value).flatMap((entry) => {
            const record = this.asRecord(entry);
            return record === undefined ? [] : [record];
        });
    }
}
