/**
 * Declarative design system of the parity harness: palette, tokens, typographies, components and journey screens.
 *
 * Node coordinates are relative to the parent node. The exception is a board with `coordinates: "frame"`, whose
 * children are relative to the origin of the screen that holds it. Screen body content therefore uses one frame.
 * Component roots sit at (0, 0) of their own origin.
 */

/** Palette of the design system, keyed `family.step`. Every value is a hex colour. */
export const PALETTE = {
    "primary.50": "#EEF4FF",
    "primary.100": "#D9E6FF",
    "primary.300": "#8FB3FF",
    "primary.500": "#3366FF",
    "primary.700": "#1F47CC",
    "primary.900": "#112A80",
    "secondary.50": "#F3EEFF",
    "secondary.100": "#E2D6FF",
    "secondary.300": "#B49BFF",
    "secondary.500": "#7A4DFF",
    "secondary.700": "#5A2BCC",
    "secondary.900": "#331880",
    "neutral.0": "#FFFFFF",
    "neutral.50": "#F7F8FA",
    "neutral.100": "#EEF0F4",
    "neutral.200": "#DDE1E8",
    "neutral.400": "#9AA3B2",
    "neutral.600": "#5C6578",
    "neutral.800": "#2E3445",
    "neutral.900": "#161A26",
    "neutral.1000": "#000000",
    "semantic.success": "#1E9E5A",
    "semantic.success-bg": "#E7F7EF",
    "semantic.warning": "#E0A21B",
    "semantic.warning-bg": "#FFF6E0",
    "semantic.danger": "#D64545",
    "semantic.danger-bg": "#FDEBEB",
    "semantic.info": "#2B8AE2",
    "semantic.info-bg": "#E7F2FD",
} as const;

/** Name of one palette entry, for example `primary.500`. */
export type ColorName = keyof typeof PALETTE;

/** Text styles of the design system. Sizes and weights are strings, as Penpot stores them. */
export const TYPOGRAPHIES = {
    display: { fontSize: "48", fontWeight: "700", lineHeight: "1.2" },
    h1: { fontSize: "32", fontWeight: "700", lineHeight: "1.2" },
    h2: { fontSize: "24", fontWeight: "600", lineHeight: "1.3" },
    h3: { fontSize: "18", fontWeight: "600", lineHeight: "1.3" },
    body: { fontSize: "16", fontWeight: "400", lineHeight: "1.5" },
    "body-sm": { fontSize: "14", fontWeight: "400", lineHeight: "1.4" },
    caption: { fontSize: "12", fontWeight: "400", lineHeight: "1.4" },
    button: { fontSize: "14", fontWeight: "600", lineHeight: "1.2" },
} as const;

/** Name of one text style, for example `body-sm`. */
export type TypographyName = keyof typeof TYPOGRAPHIES;

/** Font of every text style. `fontId` is the built-in font id, `fontFamily` the name shown in Penpot. */
export interface FontSpec {
    readonly fontId: string;
    readonly fontFamily: string;
}

/** Penpot variant ids of one weight: the upright face and the italic face. */
export interface FontVariantIds {
    readonly upright: string;
    readonly italic: string;
}

/**
 * Penpot variant ids of the built-in Source Sans Pro faces, keyed by weight as a digit string. The ids come from
 * common/src/app/common/fonts.cljs. Penpot has no 700 or 900 id; its bold and black faces are `bold` and `black`.
 */
export const FONT_VARIANT_IDS: Readonly<Record<string, FontVariantIds>> = {
    "200": { upright: "200", italic: "200italic" },
    "300": { upright: "300", italic: "300italic" },
    "400": { upright: "regular", italic: "italic" },
    "600": { upright: "600", italic: "600italic" },
    "700": { upright: "bold", italic: "bolditalic" },
    "900": { upright: "black", italic: "blackitalic" },
};

/**
 * Returns the Penpot font variant id of a weight and style, from FONT_VARIANT_IDS. For example weight 700 gives `bold`,
 * and weight 700 in italic gives `bolditalic`.
 *
 * @param fontWeight - weight as a digit string, for example `600`
 * @param italic - true for the italic face
 * @throws Error when the weight is not a digit string, or when Penpot has no face of that weight
 */
export function fontVariantIdOf(fontWeight: string, italic?: boolean): string {
    if (!/^\d+$/.test(fontWeight)) {
        throw new Error(`font weight "${fontWeight}" is not a digit string`);
    }
    const ids = FONT_VARIANT_IDS[fontWeight];
    if (ids === undefined) {
        throw new Error(
            `font weight ${fontWeight} has no Penpot font variant; supported weights: ${Object.keys(FONT_VARIANT_IDS).join(", ")}`
        );
    }
    return italic === true ? ids.italic : ids.upright;
}

/** One design token: its type string, its name in the set and its value. */
export interface TokenSpec {
    readonly type: string;
    readonly name: string;
    readonly value: string | number;
}

/** Fill and stroke colours, and the layout of a board with auto layout. */
export interface StrokeSpec {
    readonly color: ColorName;
    readonly width: number;
}

/** Auto layout of a board. Children of such a board take their final position from the layout. */
export interface FlexSpec {
    readonly direction: "row" | "column";
    readonly gap: number;
    readonly padding: number;
    readonly align: "start" | "center" | "end" | "stretch";
    readonly justify?: "start" | "center" | "end";
}

/** Geometry and name shared by every node with a box of its own. */
interface NodeBase {
    readonly name: string;
    readonly x: number;
    readonly y: number;
}

/** A frame that holds other nodes. */
export interface BoardNode extends NodeBase {
    readonly kind: "board";
    readonly width: number;
    readonly height: number;
    readonly fill?: ColorName;
    readonly stroke?: StrokeSpec;
    readonly radius?: number;
    readonly flex?: FlexSpec;
    readonly coordinates?: "parent" | "frame";
    readonly children?: readonly NodeSpec[];
}

/** A plain rectangle. */
export interface RectNode extends NodeBase {
    readonly kind: "rect";
    readonly width: number;
    readonly height: number;
    readonly fill?: ColorName;
    readonly stroke?: StrokeSpec;
    readonly radius?: number;
}

/** A plain ellipse with one fill. */
export interface EllipseNode extends NodeBase {
    readonly kind: "ellipse";
    readonly width: number;
    readonly height: number;
    readonly fill: ColorName;
}

/** A text box. Its style comes from the typography, with optional overrides. */
export interface TextNode extends NodeBase {
    readonly kind: "text";
    readonly width: number;
    readonly height: number;
    readonly characters: string;
    readonly typography: TypographyName;
    readonly color: ColorName;
    readonly fontSize?: number;
    readonly fontWeight?: string;
    readonly align?: "left" | "center";
}

/**
 * An instance of a main component. Its name and size come from the component. `overrides` maps the name of a
 * descendant text to the characters it shows.
 */
export interface InstanceNode {
    readonly kind: "instance";
    readonly component: string;
    readonly x: number;
    readonly y: number;
    readonly overrides?: Readonly<Record<string, string>>;
}

/** Any node of a component or of a screen. */
export type NodeSpec = BoardNode | RectNode | EllipseNode | TextNode | InstanceNode;

/** A main component. Its root sits at (0, 0) and its name uses `/` to separate the path. */
export interface ComponentSpec {
    readonly name: string;
    readonly root: BoardNode;
}

/** A titled group of components on the Components page. */
export interface FamilySpec {
    readonly title: string;
    readonly components: readonly ComponentSpec[];
}

/** A journey screen. Its name is the full name, for example `Onboarding / Welcome`. Body coordinates are frame based. */
export interface ScreenSpec {
    readonly name: string;
    readonly body: readonly NodeSpec[];
}

/** A journey. Its page is named `Journey: <name>`. */
export interface JourneySpec {
    readonly name: string;
    readonly screens: readonly ScreenSpec[];
}

/** Placement constants of the Components page and of the screens. */
export const LAYOUT = {
    originX: 0,
    originY: 0,
    titleHeight: 32,
    titleWidth: 640,
    titleGap: 24,
    familyGap: 48,
    columnGap: 32,
    rowGap: 32,
    maxRowWidth: 1600,
    screenWidth: 1440,
    screenHeight: 900,
    navBarHeight: 64,
    screenColumnGap: 160,
} as const;

/** Whole design system: names, palette, tokens, text styles, components and journeys. */
export interface DesignSpec {
    readonly fileName: string;
    readonly componentPageName: string;
    readonly journeyPagePrefix: string;
    readonly palette: typeof PALETTE;
    readonly font: FontSpec;
    readonly tokens: readonly TokenSpec[];
    readonly typographies: typeof TYPOGRAPHIES;
    readonly families: readonly FamilySpec[];
    readonly journeys: readonly JourneySpec[];
    readonly layout: typeof LAYOUT;
}

/** Placement of one component on the Components page. */
export interface PlacedComponent {
    readonly spec: ComponentSpec;
    readonly at: { readonly x: number; readonly y: number };
}

/** Placement of one family: its title and its components. */
export interface PlacedFamily {
    readonly title: string;
    readonly titleAt: { readonly x: number; readonly y: number };
    readonly components: readonly PlacedComponent[];
}

/**
 * Normalises a name by trimming the parts around each `/` and dropping empty parts.
 *
 * Penpot shows a component path as `A / B / C`, so both sides of a comparison go through this function.
 *
 * @param name - name as written in the spec or as read back from Penpot
 */
export function normalizeName(name: string): string {
    return name
        .split("/")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("/");
}

/**
 * Returns the name of a node. An instance is named after its component.
 *
 * @param node - any node of the spec
 */
export function nodeName(node: NodeSpec): string {
    return node.kind === "instance" ? node.component : node.name;
}

/**
 * Lists the normalised names of the components a node instantiates, at any depth.
 *
 * @param node - any node of the spec
 */
export function instanceReferences(node: NodeSpec): string[] {
    if (node.kind === "instance") {
        return [normalizeName(node.component)];
    }
    if (node.kind === "board") {
        return (node.children ?? []).flatMap((child) => instanceReferences(child));
    }
    return [];
}

/**
 * Places every family on the Components page. A family title sits above its block. Components flow left to right and
 * wrap at `maxRowWidth`. Families stack from top to bottom with `familyGap` between them.
 *
 * @param families - families in page order
 */
export function layoutComponentPage(families: readonly FamilySpec[]): PlacedFamily[] {
    const placed: PlacedFamily[] = [];
    let cursorY = LAYOUT.originY;
    for (const family of families) {
        const titleAt = { x: LAYOUT.originX, y: cursorY };
        let x = LAYOUT.originX;
        let y = cursorY + LAYOUT.titleHeight + LAYOUT.titleGap;
        let rowHeight = 0;
        const components: PlacedComponent[] = [];
        for (const spec of family.components) {
            const { width, height } = spec.root;
            if (x > LAYOUT.originX && x + width > LAYOUT.originX + LAYOUT.maxRowWidth) {
                y += rowHeight + LAYOUT.rowGap;
                x = LAYOUT.originX;
                rowHeight = 0;
            }
            components.push({ spec, at: { x, y } });
            x += width + LAYOUT.columnGap;
            rowHeight = Math.max(rowHeight, height);
        }
        cursorY = y + rowHeight + LAYOUT.familyGap;
        placed.push({ title: family.title, titleAt, components });
    }
    return placed;
}

/**
 * Returns the full name of a journey screen used on the page and in the output record.
 *
 * @param screen - the screen spec
 */
export function screenFullName(screen: ScreenSpec): string {
    return screen.name;
}

/**
 * Builds the root board of a journey screen: a column with the NavBar instance and a Body board.
 *
 * @param screen - the screen spec
 */
export function screenBoard(screen: ScreenSpec): BoardNode {
    const body = board("Body", 0, LAYOUT.navBarHeight, LAYOUT.screenWidth, LAYOUT.screenHeight - LAYOUT.navBarHeight, {
        coordinates: "frame",
        children: [...screen.body],
    });
    return board(screenFullName(screen), 0, 0, LAYOUT.screenWidth, LAYOUT.screenHeight, {
        fill: "neutral.0",
        flex: { direction: "column", gap: 0, padding: 0, align: "start" },
        children: [instance("NavBar", 0, 0), body],
    });
}

/** Options of a board that the helpers below accept besides its geometry. */
type BoardExtra = Partial<Omit<BoardNode, "kind" | "name" | "x" | "y" | "width" | "height">>;

/** Options of a rectangle that the helpers below accept besides its geometry. */
type RectExtra = Partial<Omit<RectNode, "kind" | "name" | "x" | "y" | "width" | "height">>;

/** Options of a text box that the helpers below accept besides its geometry and content. */
type TextExtra = Partial<
    Omit<TextNode, "kind" | "name" | "x" | "y" | "width" | "height" | "characters" | "typography" | "color">
>;

/**
 * Builds a board node.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param width - width in page units
 * @param height - height in page units
 * @param extra - fill, stroke, radius, layout and children
 */
function board(name: string, x: number, y: number, width: number, height: number, extra: BoardExtra = {}): BoardNode {
    return { kind: "board", name, x, y, width, height, ...extra };
}

/**
 * Builds a rectangle node.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param width - width in page units
 * @param height - height in page units
 * @param extra - fill, stroke and radius
 */
function rect(name: string, x: number, y: number, width: number, height: number, extra: RectExtra = {}): RectNode {
    return { kind: "rect", name, x, y, width, height, ...extra };
}

/**
 * Builds an ellipse node with one fill.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param width - width in page units
 * @param height - height in page units
 * @param fill - palette entry of the fill
 */
function ellipse(name: string, x: number, y: number, width: number, height: number, fill: ColorName): EllipseNode {
    return { kind: "ellipse", name, x, y, width, height, fill };
}

/**
 * Builds a text node.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param width - box width in page units
 * @param height - box height in page units
 * @param characters - text content
 * @param typography - text style
 * @param color - palette entry of the text colour
 * @param extra - optional size, weight and alignment overrides
 */
function text(
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    characters: string,
    typography: TypographyName,
    color: ColorName,
    extra: TextExtra = {}
): TextNode {
    return { kind: "text", name, x, y, width, height, characters, typography, color, ...extra };
}

/**
 * Builds an instance of a main component.
 *
 * @param component - full component name, for example `Button/Primary/MD`
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param overrides - text overrides keyed by the name of a descendant text
 */
function instance(component: string, x: number, y: number, overrides?: Record<string, string>): InstanceNode {
    return overrides === undefined
        ? { kind: "instance", component, x, y }
        : { kind: "instance", component, x, y, overrides };
}

/** Sizes of a button, with the label box that fits between the icon and the sides. */
const BUTTON_SIZES = {
    SM: { height: 32, width: 120, fontSize: 12, labelWidth: 72, labelHeight: 16 },
    MD: { height: 40, width: 144, fontSize: 14, labelWidth: 96, labelHeight: 20 },
    LG: { height: 48, width: 176, fontSize: 16, labelWidth: 112, labelHeight: 24 },
} as const;

/** Size of a button. */
type ButtonSize = keyof typeof BUTTON_SIZES;

/** Variant of a button. */
type ButtonVariant = "Primary" | "Secondary" | "Ghost" | "Danger";

/** Colours of one button variant. */
interface ButtonStyle {
    readonly fill: ColorName;
    readonly stroke?: StrokeSpec;
    readonly label: ColorName;
    readonly icon: ColorName;
}

/** Colours of every button variant. */
const BUTTON_STYLES: Readonly<Record<ButtonVariant, ButtonStyle>> = {
    Primary: { fill: "primary.500", label: "neutral.0", icon: "neutral.0" },
    Secondary: { fill: "secondary.50", label: "secondary.700", icon: "neutral.600" },
    Ghost: { fill: "neutral.0", stroke: { color: "primary.500", width: 1 }, label: "primary.500", icon: "neutral.600" },
    Danger: { fill: "semantic.danger", label: "neutral.0", icon: "neutral.0" },
};

/**
 * Builds one button component: an icon square and a fixed label in a centred row.
 *
 * @param variant - colour variant
 * @param size - size variant
 */
function buttonComponent(variant: ButtonVariant, size: ButtonSize): ComponentSpec {
    const dims = BUTTON_SIZES[size];
    const style = BUTTON_STYLES[variant];
    const name = `Button/${variant}/${size}`;
    const iconX = (dims.width - (16 + 8 + dims.labelWidth)) / 2;
    return {
        name,
        root: board(name, 0, 0, dims.width, dims.height, {
            fill: style.fill,
            stroke: style.stroke,
            radius: 8,
            flex: { direction: "row", gap: 8, padding: 0, align: "center", justify: "center" },
            children: [
                rect("Icon", iconX, (dims.height - 16) / 2, 16, 16, { fill: style.icon }),
                text(
                    "Label",
                    iconX + 24,
                    (dims.height - dims.labelHeight) / 2,
                    dims.labelWidth,
                    dims.labelHeight,
                    "Label",
                    "button",
                    style.label,
                    { fontSize: dims.fontSize }
                ),
            ],
        }),
    };
}

/** States of a text input. */
type InputState = "Default" | "Focused" | "Error";

/** Box stroke and helper text of each input state. */
const INPUT_STATES: Readonly<Record<InputState, { stroke: StrokeSpec; helper: string; helperColor: ColorName }>> = {
    Default: {
        stroke: { color: "neutral.400", width: 1 },
        helper: "We never share your email",
        helperColor: "neutral.600",
    },
    Focused: {
        stroke: { color: "primary.500", width: 2 },
        helper: "We never share your email",
        helperColor: "neutral.600",
    },
    Error: {
        stroke: { color: "semantic.danger", width: 2 },
        helper: "Enter a valid email",
        helperColor: "semantic.danger",
    },
};

/**
 * Builds one input component: a caption, a bordered box with a placeholder, and a helper line.
 *
 * @param state - input state
 */
function inputComponent(state: InputState): ComponentSpec {
    const style = INPUT_STATES[state];
    const name = `Input/${state}`;
    return {
        name,
        root: board(name, 0, 0, 320, 88, {
            flex: { direction: "column", gap: 4, padding: 0, align: "start" },
            children: [
                text("Label", 0, 0, 320, 16, "Email", "caption", "neutral.800"),
                board("Input Box", 0, 20, 320, 40, {
                    fill: "neutral.0",
                    stroke: style.stroke,
                    radius: 8,
                    children: [text("Placeholder", 12, 10, 296, 20, "you@example.com", "body-sm", "neutral.400")],
                }),
                text("Helper", 0, 64, 320, 16, style.helper, "caption", style.helperColor),
            ],
        }),
    };
}

/**
 * Builds one checkbox component with a box and a label in a row.
 *
 * @param checked - true for the checked state
 */
function checkboxComponent(checked: boolean): ComponentSpec {
    const name = checked ? "Checkbox/Checked" : "Checkbox/Unchecked";
    const box = checked
        ? board("Box", 0, 0, 20, 20, {
              fill: "primary.500",
              radius: 4,
              children: [rect("Check", 5, 7, 10, 6, { fill: "neutral.0" })],
          })
        : board("Box", 0, 0, 20, 20, { fill: "neutral.0", radius: 4, stroke: { color: "neutral.400", width: 1 } });
    return {
        name,
        root: board(name, 0, 0, 160, 24, {
            flex: { direction: "row", gap: 8, padding: 0, align: "center" },
            children: [box, text("Label", 28, 2, 132, 20, "Accept terms", "body-sm", "neutral.900")],
        }),
    };
}

/**
 * Builds one toggle component: a track with a knob at the right (on) or the left (off).
 *
 * @param on - true for the on state
 */
function toggleComponent(on: boolean): ComponentSpec {
    const name = on ? "Toggle/On" : "Toggle/Off";
    return {
        name,
        root: board(name, 0, 0, 40, 24, {
            fill: on ? "primary.500" : "neutral.200",
            radius: 999,
            children: [ellipse("Knob", on ? 18 : 2, 2, 20, 20, "neutral.0")],
        }),
    };
}

/** Background and text colour of each badge variant. */
const BADGE_STYLES: Readonly<
    Record<"Primary" | "Success" | "Warning" | "Danger", { fill: ColorName; text: ColorName }>
> = {
    Primary: { fill: "primary.50", text: "primary.700" },
    Success: { fill: "semantic.success-bg", text: "semantic.success" },
    Warning: { fill: "semantic.warning-bg", text: "semantic.warning" },
    Danger: { fill: "semantic.danger-bg", text: "semantic.danger" },
};

/**
 * Builds one badge component: a pill with a centred caption.
 *
 * @param variant - badge variant
 */
function badgeComponent(variant: keyof typeof BADGE_STYLES): ComponentSpec {
    const style = BADGE_STYLES[variant];
    const name = `Badge/${variant}`;
    return {
        name,
        root: board(name, 0, 0, 72, 24, {
            fill: style.fill,
            radius: 999,
            children: [text("Label", 8, 4, 56, 16, "Label", "caption", style.text, { align: "center" })],
        }),
    };
}

/** Diameter and initials size of each avatar size. */
const AVATAR_SIZES = {
    SM: { size: 24, fontSize: 10 },
    MD: { size: 40, fontSize: 16 },
    LG: { size: 56, fontSize: 22 },
} as const;

/**
 * Builds one avatar component: a circle with centred initials.
 *
 * @param sizeName - size variant
 */
function avatarComponent(sizeName: keyof typeof AVATAR_SIZES): ComponentSpec {
    const dims = AVATAR_SIZES[sizeName];
    const name = `Avatar/${sizeName}`;
    return {
        name,
        root: board(name, 0, 0, dims.size, dims.size, {
            fill: "secondary.100",
            radius: 999,
            children: [
                text("Initials", 0, 0, dims.size, dims.size, "AB", "caption", "secondary.700", {
                    fontSize: dims.fontSize,
                    align: "center",
                }),
            ],
        }),
    };
}

/** Table column x positions shared by the table rows. */
const TABLE_COLUMNS = [16, 256, 496, 736] as const;

/**
 * Builds the four header cells of a table row.
 *
 * @param labels - column titles, one per column
 */
function headerCells(labels: readonly string[]): TextNode[] {
    return labels.map((label, index) =>
        text(`Cell ${index + 1}`, TABLE_COLUMNS[index] ?? 0, 12, 224, 16, label, "caption", "neutral.600")
    );
}

/**
 * Builds the four cells and the bottom divider of a 48 page unit table row.
 *
 * @param values - cell values, one per column
 */
function rowCells(values: readonly string[]): (TextNode | RectNode)[] {
    const cells: (TextNode | RectNode)[] = values.map((value, index) =>
        text(`Cell ${index + 1}`, TABLE_COLUMNS[index] ?? 0, 14, 224, 20, value, "body-sm", "neutral.900")
    );
    cells.push(rect("Divider", 0, 47, 960, 1, { fill: "neutral.200" }));
    return cells;
}

/** Values of the body rows and the header row of the table components. */
const TABLE_HEADER_LABELS = ["Name", "Status", "Owner", "Updated"] as const;
const TABLE_ROW_VALUES = ["Row name", "Active", "Alice", "2 days ago"] as const;

/**
 * Builds one table row component.
 *
 * @param variant - row variant
 */
function tableRowComponent(variant: "Header" | "Default" | "Selected"): ComponentSpec {
    const name = `TableRow/${variant}`;
    if (variant === "Header") {
        return {
            name,
            root: board(name, 0, 0, 960, 40, { fill: "neutral.100", children: headerCells(TABLE_HEADER_LABELS) }),
        };
    }
    return {
        name,
        root: board(name, 0, 0, 960, 48, {
            fill: variant === "Selected" ? "primary.50" : "neutral.0",
            children: rowCells(TABLE_ROW_VALUES),
        }),
    };
}

/**
 * Builds the table component: a header row and three body rows as nested boards.
 */
function tableComponent(): ComponentSpec {
    const name = "Table";
    const row = (rowName: string, y: number): BoardNode =>
        board(rowName, 0, y, 960, 48, { fill: "neutral.0", children: rowCells(TABLE_ROW_VALUES) });
    return {
        name,
        root: board(name, 0, 0, 960, 184, {
            children: [
                board("Header", 0, 0, 960, 40, { fill: "neutral.100", children: headerCells(TABLE_HEADER_LABELS) }),
                row("Row 1", 40),
                row("Row 2", 88),
                row("Row 3", 136),
            ],
        }),
    };
}

/** Background and strong colour of each alert variant. */
const ALERT_STYLES: Readonly<Record<"Info" | "Success" | "Warning" | "Error", { bg: ColorName; strong: ColorName }>> = {
    Info: { bg: "semantic.info-bg", strong: "semantic.info" },
    Success: { bg: "semantic.success-bg", strong: "semantic.success" },
    Warning: { bg: "semantic.warning-bg", strong: "semantic.warning" },
    Error: { bg: "semantic.danger-bg", strong: "semantic.danger" },
};

/**
 * Builds one alert component: a tinted bar with an accent, an icon, a title and a message.
 *
 * @param variant - alert variant
 */
function alertComponent(variant: keyof typeof ALERT_STYLES): ComponentSpec {
    const style = ALERT_STYLES[variant];
    const name = `Alert/${variant}`;
    return {
        name,
        root: board(name, 0, 0, 480, 64, {
            fill: style.bg,
            radius: 8,
            children: [
                rect("Accent", 0, 0, 4, 64, { fill: style.strong }),
                rect("Icon", 20, 22, 20, 20, { fill: style.strong, radius: 4 }),
                text("Title", 52, 12, 400, 24, "Title", "body", "neutral.900", { fontWeight: "600" }),
                text("Message", 52, 36, 400, 20, "Message", "body-sm", "neutral.600"),
            ],
        }),
    };
}

/**
 * Builds a modal board: a title, a body and two buttons. Used as the Modal component and as plain shapes on a screen.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 */
function modalNode(name: string, x: number, y: number): BoardNode {
    return board(name, x, y, 480, 320, {
        fill: "neutral.0",
        radius: 12,
        children: [
            text("Header", 24, 24, 432, 32, "Confirm", "h2", "neutral.900"),
            text("Body", 24, 72, 432, 24, "Are you sure you want to continue?", "body", "neutral.600"),
            rect("Cancel Button", 280, 256, 88, 40, {
                fill: "neutral.0",
                stroke: { color: "primary.500", width: 1 },
                radius: 8,
            }),
            text("Cancel Label", 280, 266, 88, 20, "Cancel", "button", "primary.500", { align: "center" }),
            rect("Confirm Button", 376, 256, 80, 40, { fill: "primary.500", radius: 8 }),
            text("Confirm Label", 376, 266, 80, 20, "Confirm", "button", "neutral.0", { align: "center" }),
        ],
    });
}

/**
 * Builds an empty-state board: an illustration, a title, a body and an optional action.
 *
 * @param name - shape name
 * @param x - x relative to the parent
 * @param y - y relative to the parent
 * @param title - heading text
 * @param body - body text
 * @param action - label of the action button, or undefined for no button
 */
function emptyStateNode(name: string, x: number, y: number, title: string, body: string, action?: string): BoardNode {
    const children: NodeSpec[] = [
        ellipse("Illustration", 208, 56, 64, 64, "secondary.100"),
        text("Title", 80, 140, 320, 32, title, "h2", "neutral.900", { align: "center" }),
        text("Body", 80, 180, 320, 24, body, "body", "neutral.600", { align: "center" }),
    ];
    if (action !== undefined) {
        children.push(rect("Action Button", 160, 224, 160, 40, { fill: "primary.500", radius: 8 }));
        children.push(text("Action Label", 160, 234, 160, 20, action, "button", "neutral.0", { align: "center" }));
    }
    return board(name, x, y, 480, 320, { fill: "neutral.50", radius: 12, children });
}

/** Navigation items of the sidebar: the component and the label of each item. */
const SIDEBAR_ITEMS: readonly { readonly active: boolean; readonly label: string }[] = [
    { active: true, label: "Overview" },
    { active: false, label: "Projects" },
    { active: false, label: "Team" },
    { active: false, label: "Settings" },
    { active: false, label: "Billing" },
];

/**
 * Builds one navigation item component.
 *
 * @param active - true for the active item
 */
function navItemComponent(active: boolean): ComponentSpec {
    const name = active ? "NavItem/Active" : "NavItem/Inactive";
    const colour: ColorName = active ? "primary.700" : "neutral.600";
    return {
        name,
        root: board(name, 0, 0, 208, 40, {
            fill: active ? "primary.50" : undefined,
            radius: 8,
            children: [
                rect("Icon", 12, 12, 16, 16, { fill: colour, radius: 4 }),
                text("Label", 36, 10, 160, 20, "Label", "body-sm", colour),
            ],
        }),
    };
}

/**
 * Builds the sidebar component: five navigation item instances in a column.
 */
function sideBarComponent(): ComponentSpec {
    const name = "SideBar";
    return {
        name,
        root: board(name, 0, 0, 240, 836, {
            fill: "neutral.50",
            flex: { direction: "column", gap: 4, padding: 16, align: "start" },
            children: SIDEBAR_ITEMS.map((item, index) =>
                instance(item.active ? "NavItem/Active" : "NavItem/Inactive", 16, 16 + index * 44, {
                    Label: item.label,
                })
            ),
        }),
    };
}

/**
 * Builds the top navigation bar component.
 */
function navBarComponent(): ComponentSpec {
    const name = "NavBar";
    return {
        name,
        root: board(name, 0, 0, 1440, 64, {
            fill: "neutral.0",
            stroke: { color: "neutral.200", width: 1 },
            children: [
                rect("Logo", 24, 16, 32, 32, { fill: "primary.500", radius: 8 }),
                text("Title", 68, 20, 160, 24, "Design Lab", "h3", "neutral.900"),
                text("Link Dashboard", 260, 22, 90, 20, "Dashboard", "body-sm", "neutral.800"),
                text("Link Settings", 370, 22, 80, 20, "Settings", "body-sm", "neutral.800"),
                text("Link Billing", 470, 22, 80, 20, "Billing", "body-sm", "neutral.800"),
                ellipse("Avatar", 1376, 12, 40, 40, "secondary.100"),
            ],
        }),
    };
}

/**
 * Builds the tabs component: three labels and an underline under the first one.
 */
function tabsComponent(): ComponentSpec {
    const name = "Tabs";
    return {
        name,
        root: board(name, 0, 0, 480, 44, {
            children: [
                text("Tab Overview", 0, 12, 80, 20, "Overview", "body-sm", "primary.700"),
                text("Tab Activity", 96, 12, 80, 20, "Activity", "body-sm", "neutral.600"),
                text("Tab Files", 192, 12, 64, 20, "Files", "body-sm", "neutral.600"),
                rect("Underline", 0, 42, 80, 2, { fill: "primary.500" }),
            ],
        }),
    };
}

/**
 * Builds the breadcrumb component: three crumbs with separators.
 */
function breadcrumbComponent(): ComponentSpec {
    const name = "Breadcrumb";
    return {
        name,
        root: board(name, 0, 0, 480, 20, {
            children: [
                text("Crumb 1", 0, 0, 40, 20, "Home", "body-sm", "neutral.600"),
                text("Separator 1", 48, 0, 8, 20, "/", "body-sm", "neutral.400"),
                text("Crumb 2", 64, 0, 56, 20, "Projects", "body-sm", "neutral.600"),
                text("Separator 2", 128, 0, 8, 20, "/", "body-sm", "neutral.400"),
                text("Crumb 3", 144, 0, 80, 20, "Design Lab", "body-sm", "neutral.900"),
            ],
        }),
    };
}

/**
 * Builds the pagination component: previous and next squares and five page squares, the first one active.
 */
function paginationComponent(): ComponentSpec {
    const name = "Pagination";
    const pages = [1, 2, 3, 4, 5].map((page) => {
        const active = page === 1;
        return board(`Page ${page}`, 40 + (page - 1) * 40, 4, 32, 32, {
            fill: active ? "primary.500" : undefined,
            stroke: active ? undefined : { color: "neutral.200", width: 1 },
            radius: 8,
            children: [
                text("Number", 4, 6, 24, 20, String(page), "body-sm", active ? "neutral.0" : "neutral.600", {
                    align: "center",
                }),
            ],
        });
    });
    return {
        name,
        root: board(name, 0, 0, 280, 40, {
            children: [
                rect("Prev", 0, 4, 32, 32, {
                    fill: "neutral.0",
                    stroke: { color: "neutral.200", width: 1 },
                    radius: 8,
                }),
                ...pages,
                rect("Next", 248, 4, 32, 32, {
                    fill: "neutral.0",
                    stroke: { color: "neutral.200", width: 1 },
                    radius: 8,
                }),
            ],
        }),
    };
}

/**
 * Builds the tooltip component: a dark pill with a caption and a small arrow under the middle.
 */
function tooltipComponent(): ComponentSpec {
    const name = "Tooltip";
    return {
        name,
        root: board(name, 0, 0, 160, 32, {
            fill: "neutral.900",
            radius: 4,
            children: [
                text("Label", 12, 6, 136, 16, "Copy link", "caption", "neutral.0"),
                rect("Arrow", 76, 24, 8, 8, { fill: "neutral.900" }),
            ],
        }),
    };
}

/**
 * Builds the statistic card component: a caption, a large value and a delta line.
 */
function statComponent(): ComponentSpec {
    const name = "Stat";
    return {
        name,
        root: board(name, 0, 0, 240, 128, {
            fill: "neutral.0",
            stroke: { color: "neutral.200", width: 1 },
            radius: 12,
            children: [
                text("Label", 16, 16, 208, 16, "Active users", "caption", "neutral.600"),
                text("Value", 16, 40, 208, 40, "1,284", "h1", "neutral.900"),
                text("Delta", 16, 92, 208, 20, "+12%", "body-sm", "semantic.success"),
            ],
        }),
    };
}

/**
 * Builds the progress bar component: a track and a 60 percent fill.
 */
function progressBarComponent(): ComponentSpec {
    const name = "ProgressBar";
    return {
        name,
        root: board(name, 0, 0, 320, 8, {
            fill: "neutral.200",
            radius: 999,
            children: [rect("Fill", 0, 0, 192, 8, { fill: "primary.500", radius: 999 })],
        }),
    };
}

/**
 * Builds the card component: a header, a body and a footer, each a nested board.
 */
function cardComponent(): ComponentSpec {
    const name = "Card";
    return {
        name,
        root: board(name, 0, 0, 320, 240, {
            fill: "neutral.0",
            stroke: { color: "neutral.200", width: 1 },
            radius: 12,
            children: [
                board("Header", 0, 0, 320, 56, {
                    children: [text("Title", 16, 16, 288, 24, "Card title", "h3", "neutral.900")],
                }),
                board("Body", 0, 56, 320, 128, {
                    children: [text("Body text", 16, 16, 288, 24, "Card body text.", "body", "neutral.600")],
                }),
                board("Footer", 0, 184, 320, 56, {
                    children: [
                        rect("Action Button", 208, 12, 96, 32, {
                            fill: "neutral.0",
                            stroke: { color: "primary.500", width: 1 },
                            radius: 8,
                        }),
                        text("Action Label", 232, 18, 48, 20, "Open", "button", "primary.500"),
                    ],
                }),
            ],
        }),
    };
}

/**
 * Builds one journey screen body as frame coordinates.
 *
 * @param name - full screen name
 * @param body - body nodes in frame coordinates
 */
function screen(name: string, body: NodeSpec[]): ScreenSpec {
    return { name, body };
}

/** Every component of the design system, grouped by family in page order. */
const FAMILIES: readonly FamilySpec[] = [
    {
        title: "Buttons",
        components: (["Primary", "Secondary", "Ghost", "Danger"] as const).flatMap((variant) =>
            (["SM", "MD", "LG"] as const).map((size) => buttonComponent(variant, size))
        ),
    },
    {
        title: "Inputs",
        components: [inputComponent("Default"), inputComponent("Focused"), inputComponent("Error")],
    },
    {
        title: "Selection controls",
        components: [checkboxComponent(true), checkboxComponent(false), toggleComponent(true), toggleComponent(false)],
    },
    {
        title: "Badges and avatars",
        components: [
            badgeComponent("Primary"),
            badgeComponent("Success"),
            badgeComponent("Warning"),
            badgeComponent("Danger"),
            avatarComponent("SM"),
            avatarComponent("MD"),
            avatarComponent("LG"),
        ],
    },
    {
        title: "Cards and stats",
        components: [cardComponent(), statComponent(), progressBarComponent()],
    },
    {
        title: "Navigation",
        components: [
            navBarComponent(),
            navItemComponent(true),
            navItemComponent(false),
            sideBarComponent(),
            tabsComponent(),
            breadcrumbComponent(),
            paginationComponent(),
        ],
    },
    {
        title: "Tables",
        components: [
            tableRowComponent("Header"),
            tableRowComponent("Default"),
            tableRowComponent("Selected"),
            tableComponent(),
        ],
    },
    {
        title: "Feedback",
        components: [
            alertComponent("Info"),
            alertComponent("Success"),
            alertComponent("Warning"),
            alertComponent("Error"),
            tooltipComponent(),
            { name: "Modal", root: modalNode("Modal", 0, 0) },
            {
                name: "EmptyState",
                root: emptyStateNode(
                    "EmptyState",
                    0,
                    0,
                    "Nothing here yet",
                    "Create something to get started.",
                    "Create"
                ),
            },
        ],
    },
];

/** Journey screens. Coordinates are frame coordinates of the screen, where the Body starts at y 64. */
const JOURNEYS: readonly JourneySpec[] = [
    {
        name: "Onboarding",
        screens: [
            screen("Onboarding / Welcome", [
                text("Headline", 360, 240, 720, 58, "Welcome to Design Lab", "display", "neutral.900", {
                    align: "center",
                }),
                text("Intro", 360, 318, 720, 24, "Sketch, prototype and ship from one file.", "body", "neutral.600", {
                    align: "center",
                }),
                instance("Button/Primary/LG", 632, 380, { Label: "Get started" }),
            ]),
            screen("Onboarding / Sign up", [
                instance("Input/Default", 560, 200),
                instance("Input/Error", 560, 320, {
                    Label: "Password",
                    Placeholder: "Enter a password",
                    Helper: "Use at least 8 characters",
                }),
                instance("Button/Primary/MD", 648, 440, { Label: "Create account" }),
            ]),
            screen("Onboarding / Verify email", [
                emptyStateNode(
                    "Verify Email",
                    480,
                    160,
                    "Check your inbox",
                    "We sent a confirmation link to your email."
                ),
                instance("Button/Primary/MD", 648, 424, { Label: "Resend email" }),
                instance("Checkbox/Checked", 640, 500, { Label: "Keep me posted" }),
            ]),
            screen("Onboarding / Done", [
                instance("Alert/Success", 480, 300, { Title: "Account created", Message: "You can now sign in." }),
                instance("Button/Primary/MD", 648, 400, { Label: "Continue" }),
            ]),
        ],
    },
    {
        name: "Dashboard",
        screens: [
            screen("Dashboard / Overview", [
                instance("SideBar", 0, 64),
                text("Crumb 1", 288, 88, 40, 20, "Home", "body-sm", "neutral.600"),
                text("Separator 1", 336, 88, 8, 20, "/", "body-sm", "neutral.400"),
                text("Crumb 2", 352, 88, 72, 20, "Overview", "body-sm", "neutral.900"),
                instance("Stat", 320, 128),
                instance("Stat", 592, 128, { Label: "Revenue", Value: "$8,420", Delta: "+4%" }),
                instance("Stat", 864, 128, { Label: "Churn", Value: "2.1%", Delta: "-0.4%" }),
                instance("Stat", 1136, 128, { Label: "Tickets", Value: "38", Delta: "+3" }),
                instance("Tabs", 288, 296),
                instance("TableRow/Header", 288, 360, {
                    "Cell 1": "Name",
                    "Cell 2": "Status",
                    "Cell 3": "Owner",
                    "Cell 4": "Updated",
                }),
                instance("TableRow/Default", 288, 400, {
                    "Cell 1": "Design Lab",
                    "Cell 2": "Active",
                    "Cell 3": "Alice",
                    "Cell 4": "2 days ago",
                }),
                instance("TableRow/Default", 288, 448, {
                    "Cell 1": "Mobile kit",
                    "Cell 2": "Draft",
                    "Cell 3": "Bob",
                    "Cell 4": "5 days ago",
                }),
                instance("TableRow/Default", 288, 496, {
                    "Cell 1": "Icon set",
                    "Cell 2": "Review",
                    "Cell 3": "Chen",
                    "Cell 4": "1 week ago",
                }),
            ]),
            screen("Dashboard / Detail", [
                instance("SideBar", 0, 64),
                text("Crumb 1", 288, 88, 40, 20, "Home", "body-sm", "neutral.600"),
                text("Separator 1", 336, 88, 8, 20, "/", "body-sm", "neutral.400"),
                text("Crumb 2", 352, 88, 64, 20, "Projects", "body-sm", "neutral.600"),
                text("Separator 2", 424, 88, 8, 20, "/", "body-sm", "neutral.400"),
                text("Crumb 3", 440, 88, 80, 20, "Design Lab", "body-sm", "neutral.900"),
                instance("Card", 288, 128, {
                    Title: "Design Lab",
                    "Body text": "Last edited 2 hours ago.",
                    "Action Label": "Open",
                }),
                instance("Badge/Success", 640, 128, { Label: "Active" }),
                instance("Avatar/LG", 640, 176, { Initials: "DL" }),
                text("Progress Caption", 288, 392, 320, 16, "Import progress", "caption", "neutral.600"),
                instance("ProgressBar", 288, 420),
            ]),
        ],
    },
    {
        name: "Settings",
        screens: [
            screen("Settings / Profile", [
                instance("Input/Default", 288, 136, {
                    Label: "Full name",
                    Placeholder: "Ada Lovelace",
                    Helper: "As shown on your profile",
                }),
                instance("Input/Default", 288, 248, { Label: "Email" }),
                instance("Avatar/LG", 288, 368, { Initials: "DL" }),
                instance("Toggle/On", 288, 456),
                text("Toggle Label", 344, 458, 300, 20, "Email notifications", "body-sm", "neutral.900"),
                instance("Button/Primary/MD", 288, 536, { Label: "Save changes" }),
            ]),
            screen("Settings / Team", [
                instance("TableRow/Header", 288, 136, {
                    "Cell 1": "Member",
                    "Cell 2": "Role",
                    "Cell 3": "Joined",
                    "Cell 4": "Status",
                }),
                instance("TableRow/Default", 288, 176, {
                    "Cell 1": "Alice Chen",
                    "Cell 2": "Owner",
                    "Cell 3": "Jan 2026",
                    "Cell 4": "Active",
                }),
                instance("TableRow/Default", 288, 224, {
                    "Cell 1": "Bob Smith",
                    "Cell 2": "Editor",
                    "Cell 3": "Mar 2026",
                    "Cell 4": "Active",
                }),
                instance("TableRow/Default", 288, 272, {
                    "Cell 1": "Chen Wu",
                    "Cell 2": "Viewer",
                    "Cell 3": "Jun 2026",
                    "Cell 4": "Invited",
                }),
                instance("Badge/Primary", 288, 344, { Label: "Admin" }),
                instance("Button/Secondary/SM", 1248, 96, { Label: "Invite" }),
            ]),
            screen("Settings / Billing", [
                instance("Stat", 288, 136, { Label: "Current plan", Value: "Pro", Delta: "Billed yearly" }),
                instance("Stat", 560, 136, { Label: "Next invoice", Value: "$24", Delta: "Due 1 Dec" }),
                instance("Alert/Warning", 288, 300, {
                    Title: "Payment method expires soon",
                    Message: "Update your card before 31 Dec.",
                }),
                modalNode("Modal", 288, 400),
                instance("Pagination", 288, 760),
            ]),
        ],
    },
    {
        name: "Checkout",
        screens: [
            screen("Checkout / Cart", [
                instance("TableRow/Header", 96, 136, {
                    "Cell 1": "Item",
                    "Cell 2": "Seats",
                    "Cell 3": "Price",
                    "Cell 4": "Total",
                }),
                instance("TableRow/Default", 96, 176, {
                    "Cell 1": "Design Lab Pro",
                    "Cell 2": "5",
                    "Cell 3": "$12",
                    "Cell 4": "$60",
                }),
                instance("TableRow/Default", 96, 224, {
                    "Cell 1": "Icon set",
                    "Cell 2": "1",
                    "Cell 3": "$48",
                    "Cell 4": "$48",
                }),
                instance("TableRow/Default", 96, 272, {
                    "Cell 1": "Support",
                    "Cell 2": "1",
                    "Cell 3": "$40",
                    "Cell 4": "$40",
                }),
                instance("Stat", 1088, 136, { Label: "Total", Value: "$148", Delta: "Incl. tax" }),
                instance("Button/Primary/LG", 1088, 320, { Label: "Pay" }),
            ]),
            screen("Checkout / Payment", [
                instance("Input/Default", 560, 136, {
                    Label: "Card number",
                    Placeholder: "4242 4242 4242 4242",
                    Helper: "Visa, Mastercard or Amex",
                }),
                instance("Input/Default", 560, 240, {
                    Label: "Expiry",
                    Placeholder: "MM / YY",
                    Helper: "Shown on the front of your card",
                }),
                instance("Input/Default", 560, 344, {
                    Label: "CVC",
                    Placeholder: "123",
                    Helper: "Three digits on the back",
                }),
                instance("Checkbox/Unchecked", 560, 456, { Label: "Save card for later" }),
                instance("Button/Primary/LG", 560, 512, { Label: "Pay now" }),
            ]),
            screen("Checkout / Confirmation", [
                instance("Alert/Success", 480, 200, {
                    Title: "Payment received",
                    Message: "A receipt was sent to your email.",
                }),
                instance("Badge/Success", 480, 288, { Label: "Paid" }),
                instance("Button/Ghost/MD", 480, 340, { Label: "Back to dashboard" }),
            ]),
        ],
    },
];

/** Design tokens: palette colours, spacing, radii, font sizes and line heights. */
const TOKENS: readonly TokenSpec[] = [
    ...(Object.keys(PALETTE) as ColorName[]).map((key) => ({
        type: "color",
        name: `color.${key}`,
        value: PALETTE[key],
    })),
    ...["4", "8", "12", "16", "24", "32", "48", "64"].map((value) => ({
        type: "spacing",
        name: `spacing.${value}`,
        value,
    })),
    ...[
        ["none", "0"],
        ["sm", "4"],
        ["md", "8"],
        ["lg", "12"],
        ["full", "999"],
    ].map(([key, value]) => ({ type: "borderRadius", name: `radius.${key}`, value: value ?? "0" })),
    ...["12", "14", "16", "18", "20", "24", "32", "48"].map((value) => ({
        type: "fontSizes",
        name: `fontSize.${value}`,
        value,
    })),
    ...[
        ["tight", "1.2"],
        ["normal", "1.4"],
        ["relaxed", "1.5"],
    ].map(([key, value]) => ({ type: "lineHeights", name: `lineHeight.${key}`, value: Number(value ?? "1.4") })),
];

/** Complete design system of the parity harness. */
export const DESIGN_SPEC: DesignSpec = {
    fileName: "Design Lab",
    componentPageName: "Components",
    journeyPagePrefix: "Journey: ",
    palette: PALETTE,
    font: { fontId: "sourcesanspro", fontFamily: "Source Sans Pro" },
    tokens: TOKENS,
    typographies: TYPOGRAPHIES,
    families: FAMILIES,
    journeys: JOURNEYS,
    layout: LAYOUT,
};
