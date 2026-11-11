import { ARROW_STYLES, arrowOutline, openArrowPath, type ArrowStyle, type KioskPoint } from "./KioskArrows.js";

/** Version of the kiosk plan. Bump it when the shapes, their names or their order change. */
export const KIOSK_PLAN_VERSION = 1;

/** Names of the sizes that the builder knows. */
export type KioskSizeName = "12" | "207" | "xl" | "cliff";

/** Screens and shapes aimed at by each size. */
export const KIOSK_SIZES: Record<KioskSizeName, { screens: number; shapes: number }> = {
    "12": { screens: 12, shapes: 1700 },
    "207": { screens: 207, shapes: 28700 },
    xl: { screens: 830, shapes: 115000 },
    cliff: { screens: 1500, shapes: 207000 },
};

/** Placeholder for the id of the page "Components", replaced by the build script. */
export const PAGE_COMPONENTS = "$page:components";

/** Placeholder for the id of the page "Journeys", replaced by the build script. */
export const PAGE_JOURNEYS = "$page:journeys";

/** One operation of `apply_operations`. */
export type KioskOperation = Record<string, unknown> & { op: string };

/** The twelve views of the kiosk. */
export type ViewKey =
    | "screensaver"
    | "login"
    | "loginFailure"
    | "mainMenu"
    | "mainMenuAdmin"
    | "cabinetSelect"
    | "checkOut"
    | "checkIn"
    | "logging"
    | "settings"
    | "boot"
    | "adminActions";

/** How a boot or blank screen is built. */
export type ScreenStructure = "a" | "b" | "c";

/** What a screen holds. */
export type ScreenKind = "content" | "blank" | "instance-only" | "empty";

/** One group of calls of the plan, in the order the build must send them. */
export interface KioskCall {
    /** Which part of the file the call builds. */
    stage: "components" | "skeleton" | "screens" | "connectors";
    /** Short text for progress lines. */
    label: string;
    /** The operations of the call. */
    operations: KioskOperation[];
    /** Shapes the call creates, instances counted with their contents. */
    shapes: number;
}

/** A flip that `apply_operations` cannot write, to be sent as a raw change once the shape exists. */
export interface FlipSpec {
    /** Handle of the shape. */
    shape: string;
    /** `rect` for an ordinary shape, `group` for a group. */
    kind: "rect" | "group";
    /** Mirror axis. */
    axis: "x" | "y";
    /** Handle of the screen that holds the shape. */
    screen: string;
    /** Box of the shape in page space. */
    box: { x: number; y: number; width: number; height: number };
    /**
     * `mirror` writes the mirror into `transform` and `points`, as the workspace does. `identity` writes mirrored
     * `points` and a `transform` that stays the identity, the state that the real file holds for its groups.
     */
    mode: "mirror" | "identity";
}

/** Result of {@link buildKioskPlan}. */
export interface KioskPlan {
    /** Size name. */
    size: KioskSizeName;
    /** Seed of every random choice. */
    seed: number;
    /** The `apply_operations` calls, in order. */
    calls: KioskCall[];
    /** Flips to send as raw changes after the last call. */
    flips: FlipSpec[];
    /** What the plan draws, with handles where the build script puts ids. */
    manifest: KioskManifest;
}

/** Description of what the plan draws. Handles (`$tmp:...`) stand for shape ids until the build resolves them. */
export interface KioskManifest {
    /** Version of this schema. */
    schemaVersion: number;
    /** Version of the plan. */
    planVersion: number;
    /** Size name. */
    size: KioskSizeName;
    /** Seed. */
    seed: number;
    /** Page names. */
    pages: { components: string; journeys: string };
    /** Totals over the file. */
    totals: Record<string, number>;
    /** The main components. */
    components: { key: string; name: string; handle: string; shapes: number; width: number; height: number }[];
    /** The twelve views and what each holds. */
    views: {
        key: ViewKey;
        humanName: string;
        screens: number;
        shapesPerScreen: number[];
    }[];
    /** Section frames, depth 1. */
    sections: {
        handle: string;
        name: string;
        x: number;
        y: number;
        width: number;
        height: number;
        screens: number;
    }[];
    /** Every screen frame (`Parent`). */
    screens: ManifestScreen[];
    /** Groups of screens that are exact copies. */
    copyGroups: { key: string; view: ViewKey; screens: string[] }[];
    /** Screens that show only a header, with their structure. */
    blankScreens: { screen: string; structure: ScreenStructure }[];
    /** Screens with no children. */
    emptyScreens: string[];
    /** Boot and asset screens, with their structure. */
    instanceOnlyScreens: { screen: string; structure: ScreenStructure }[];
    /** Decision frames. They are not screens. */
    decisionFrames: {
        shape: string;
        text: string;
        section: string;
        between: [string, string];
        x: number;
        y: number;
        width: number;
        height: number;
    }[];
    /** Arrows between screens, with their true direction. */
    connectors: ManifestConnector[];
    /** Shapes that look like connectors and are not. */
    noise: { dividerLines: { count: number; shapes: string[] }; chevronIcons: { count: number } };
    /** Flipped shapes. */
    flips: {
        total: number;
        ordinary: ManifestFlip[];
        groups: ManifestFlip[];
        route: string;
    };
    /** Clipping frames whose content runs past their edge, and the scroll bar next to each. */
    scrollCandidates: {
        frame: string;
        screen: string;
        axis: "vertical";
        frameHeight: number;
        contentHeight: number;
        overflowPx: number;
        rows: number;
        rowsBelowEdge: number;
        scrollBar: string | null;
        overflowScrollSet: boolean;
    }[];
    /** Controls that stick out of their screen. */
    offBoardControls: { shape: string; screen: string; edge: "right"; overhangPx: number }[];
    /** Controls that their frame clips away, wholly or partly. */
    clippedControls: {
        shape: string;
        screen: string;
        frame: string;
        clipped: "fully" | "half";
        visibleFraction: number;
    }[];
    /** Fonts that do not resolve. */
    fonts: { unresolved: { fontId: string; family: string; weight: number; texts: string[]; runs: number }[] };
    /** Counts of shapes by type, on the Journeys page. */
    shapeTypes: Record<string, number>;
    /** Counts of frames by size, on the Journeys page, most common first. */
    frameSizes: { size: string; count: number }[];
    /** Counts of other features, on the Journeys page. */
    features: Record<string, number>;
    /** Notes for people who read the file. */
    notes: string[];
}

/** One screen in the manifest. */
export interface ManifestScreen {
    /** Handle of the `Parent` frame. */
    handle: string;
    /** Frame name, always `Parent`. */
    name: "Parent";
    /** Name a person gives the screen, also the text of its label. */
    humanName: string;
    /** View of the screen. */
    view: ViewKey;
    /** What the screen holds. */
    kind: ScreenKind;
    /** Structure of a boot or blank screen. */
    structure?: ScreenStructure;
    /** Copy group, when the screen is a copy. */
    copyGroup?: string;
    /** Section frame handle. */
    section: string;
    /** Section name. */
    sectionName: string;
    /** Journey group frame handle. */
    journey: string;
    /** Step frame handle. */
    step: string;
    /** State frame handle. */
    state: string;
    /** Handle of the `Single` frame, when the screen sits one level deeper. */
    single?: string;
    /** Depth of the `Parent` frame under the page root: 5, or 6 inside a `Single`. */
    depth: number;
    /** Position and size in page space. */
    x: number;
    /** Top edge. */
    y: number;
    /** Width. */
    width: number;
    /** Height. */
    height: number;
    /** Shapes in the subtree of the `Parent`, the frame included, instances counted with their contents. */
    shapes: number;
    /** Handle of the text label. */
    label: string;
}

/** One arrow between screens, in the manifest. */
export interface ManifestConnector {
    /** Handle of the arrow shape. */
    shape: string;
    /** `filled-outline` is a closed, filled path. `open-stroked` is an open path with an arrow cap. */
    kind: "filled-outline" | "open-stroked";
    /** Style of the arrow. */
    style: ArrowStyle | "open-straight" | "open-curved";
    /** The screen the arrow leaves, or null when it leaves a decision frame. */
    fromScreen: string | null;
    /** The screen the arrow enters, or null when it enters a decision frame. */
    toScreen: string | null;
    /** Decision frame that the arrow leaves, if any. */
    fromDecision: string | null;
    /** Decision frame that the arrow enters, if any. */
    toDecision: string | null;
    /** True when the arrow ends on a decision frame. */
    endsOnDecision: boolean;
    /** Direction of the arrow, from tail to head. */
    direction: "left" | "right" | "up" | "down";
    /** Tail point. */
    tail: KioskPoint;
    /** Point of the head. */
    head: KioskPoint;
    /** Parent frame of the arrow. */
    container: string;
}

/** One flipped shape in the manifest. */
export interface ManifestFlip {
    /** Shape handle. */
    shape: string;
    /** Screen that holds it. */
    screen: string;
    /** Axis. */
    axis: "x" | "y";
    /** What a correct reader finds in the stored shape. */
    expected: {
        flipX: boolean;
        flipY: boolean;
        transform: Matrix;
        firstPoint: KioskPoint;
        points: KioskPoint[];
    };
    /** For a group: true when the stored state is the fault (identity transform, mirrored points). Set by the build. */
    faultReproduced?: boolean | null;
}

/** A 2D matrix in SVG order. */
export interface Matrix {
    /** First column, x. */
    a: number;
    /** First column, y. */
    b: number;
    /** Second column, x. */
    c: number;
    /** Second column, y. */
    d: number;
    /** Translation x. */
    e: number;
    /** Translation y. */
    f: number;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Random numbers and small helpers                                                                                */
/* ------------------------------------------------------------------------------------------------------------- */

/**
 * Hashes text to a 32-bit number (FNV-1a).
 *
 * @param text - text to hash
 */
function hashText(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** Small seeded random number generator (mulberry32). */
class Rng {
    private state: number;

    /**
     * @param seed - 32-bit seed
     */
    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    /** Next number in [0, 1). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * Whole number in [lo, hi].
     *
     * @param lo - lowest
     * @param hi - highest
     */
    int(lo: number, hi: number): number {
        return lo + Math.floor(this.next() * (hi - lo + 1));
    }

    /**
     * True with the given chance.
     *
     * @param p - chance in [0, 1]
     */
    chance(p: number): boolean {
        return this.next() < p;
    }

    /**
     * One item of a list.
     *
     * @param items - non-empty list
     */
    pick<T>(items: readonly T[]): T {
        return items[this.int(0, items.length - 1)];
    }

    /** A version-4 style UUID. */
    uuid(): string {
        const hex = (n: number): string => Array.from({ length: n }, () => this.int(0, 15).toString(16)).join("");
        return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[this.int(0, 3)]}${hex(3)}-${hex(12)}`;
    }
}

/** A table of counts by name. */
type Counts = Record<string, number>;

/**
 * Adds one table of counts to another.
 *
 * @param into - table that grows
 * @param from - table to add
 * @param times - how many times to add it
 */
function addCounts(into: Counts, from: Counts, times = 1): void {
    for (const [key, value] of Object.entries(from)) {
        into[key] = (into[key] ?? 0) + value * times;
    }
}

/**
 * Sorts the keys of a table, so that the manifest text does not depend on insertion order.
 *
 * @param counts - table of counts
 */
function sortedCounts(counts: Counts): Counts {
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Solid fill list.
 *
 * @param color - hex colour
 */
function solid(color: string): Record<string, unknown>[] {
    return [{ fillColor: color, fillOpacity: 1 }];
}

/**
 * Linear gradient fill list.
 *
 * @param from - first colour
 * @param to - second colour
 * @param horizontal - true for left to right, false for a diagonal
 */
function gradient(from: string, to: string, horizontal: boolean): Record<string, unknown>[] {
    return [
        {
            fillColorGradient: {
                type: "linear",
                startX: 0,
                startY: horizontal ? 0.5 : 0,
                endX: 1,
                endY: horizontal ? 0.5 : 1,
                width: 1,
                stops: [
                    { color: from, opacity: 1, offset: 0 },
                    { color: to, opacity: 1, offset: 1 },
                ],
            },
            fillOpacity: 1,
        },
    ];
}

const COLOR = {
    brand: "#0B5FFF",
    dark: "#101828",
    mid: "#475467",
    soft: "#F2F4F7",
    line: "#D0D5DD",
    ok: "#12B76A",
    warn: "#F79009",
    err: "#F04438",
    white: "#FFFFFF",
    ink: "#344054",
};

/* ------------------------------------------------------------------------------------------------------------- */
/* Operation recorder                                                                                              */
/* ------------------------------------------------------------------------------------------------------------- */

/** Options for creating a shape. */
interface ShapeOptions {
    /** Handle to give the shape. A new one is made when it is left out. */
    id?: string;
    /** Extra shape properties. */
    props?: Record<string, unknown>;
}

/** Options for a text. */
interface TextOptions extends ShapeOptions {
    /** Font size in pixels. */
    size?: number;
    /** Text colour. */
    color?: string;
    /** Font weight. */
    weight?: number;
    /** Font family. */
    family?: string;
    /** Font id. */
    fontId?: string;
    /** Layer name. */
    name?: string;
}

/** A change of a text or properties inside a component copy. */
interface Override {
    /** Name of the shape in the copy. */
    name: string;
    /** New characters. */
    characters?: string;
}

/**
 * Records the operations of one part of the plan and counts the shapes they create. Coordinates passed to the
 * methods are relative to the origin, and the recorder adds the origin.
 */
class Recorder {
    /** The recorded operations. */
    readonly ops: KioskOperation[] = [];
    /** Counts of shapes by type, size and feature. */
    readonly counts: Counts = {};
    /** Origin of the coordinates that callers pass. */
    ox = 0;
    /** Origin of the coordinates that callers pass. */
    oy = 0;
    private seq = 0;

    /**
     * @param page - page placeholder or id
     * @param prefix - prefix of generated handles, unique in the plan
     * @param rng - random numbers, for shadow ids
     * @param components - shape counts of the components that exist, by key
     */
    constructor(
        readonly page: string,
        private readonly prefix: string,
        private readonly rng: Rng,
        private readonly components: Record<string, ComponentInfo>
    ) {}

    /** A new handle. */
    handle(): string {
        return `$tmp:${this.prefix}.${this.seq++}`;
    }

    /**
     * Counts a feature.
     *
     * @param name - feature name
     * @param n - how many
     */
    feature(name: string, n = 1): void {
        this.counts[`feature:${name}`] = (this.counts[`feature:${name}`] ?? 0) + n;
    }

    private count(type: string, w?: number, h?: number): void {
        this.counts.shapes = (this.counts.shapes ?? 0) + 1;
        this.counts[`type:${type}`] = (this.counts[`type:${type}`] ?? 0) + 1;
        if (w !== undefined && h !== undefined) {
            const key = `frame:${w}x${h}`;
            this.counts[key] = (this.counts[key] ?? 0) + 1;
        }
    }

    private place(
        op: string,
        id: string,
        parent: string | undefined,
        x: number,
        y: number,
        extra: Record<string, unknown>
    ): KioskOperation {
        const o: KioskOperation = { op, pageId: this.page, id };
        if (parent !== undefined) {
            o.parentId = parent;
        }
        o.x = x + this.ox;
        o.y = y + this.oy;
        Object.assign(o, extra);
        this.ops.push(o);
        return o;
    }

    private withProps(o: KioskOperation, props: Record<string, unknown> | undefined): void {
        if (props !== undefined && Object.keys(props).length > 0) {
            o.props = props;
        }
    }

    /**
     * Adds a board.
     *
     * @param parent - parent handle, or undefined for the page root
     * @param x - left, relative to the origin
     * @param y - top, relative to the origin
     * @param w - width
     * @param h - height
     * @param name - layer name
     * @param opts - handle and properties
     */
    board(
        parent: string | undefined,
        x: number,
        y: number,
        w: number,
        h: number,
        name: string,
        opts: ShapeOptions = {}
    ): string {
        const id = opts.id ?? this.handle();
        const o = this.place("create_board", id, parent, x, y, { width: w, height: h, name });
        this.withProps(o, opts.props);
        this.count("frame", w, h);
        return id;
    }

    /**
     * Adds a rectangle.
     *
     * @param parent - parent handle
     * @param x - left
     * @param y - top
     * @param w - width
     * @param h - height
     * @param name - layer name
     * @param opts - handle and properties
     */
    rect(
        parent: string | undefined,
        x: number,
        y: number,
        w: number,
        h: number,
        name: string,
        opts: ShapeOptions = {}
    ): string {
        const id = opts.id ?? this.handle();
        const o = this.place("create_rect", id, parent, x, y, { width: w, height: h, name });
        this.withProps(o, opts.props);
        this.count("rect");
        const props = opts.props ?? {};
        if (JSON.stringify(props.fills ?? "").includes("fillColorGradient")) {
            this.feature("gradient");
            if (w !== h) {
                this.feature("gradient-non-square");
            }
        }
        if (JSON.stringify(props.strokes ?? "").includes("strokeWidthTop")) {
            this.feature("per-side-stroke");
        }
        if (props.shadow !== undefined) {
            this.feature("shadow");
        }
        return id;
    }

    /**
     * Adds a circle (an ellipse of equal sides, which Penpot stores as `circle`).
     *
     * @param parent - parent handle
     * @param x - left
     * @param y - top
     * @param d - diameter
     * @param name - layer name
     * @param opts - handle and properties
     */
    circle(parent: string | undefined, x: number, y: number, d: number, name: string, opts: ShapeOptions = {}): string {
        const id = opts.id ?? this.handle();
        const o = this.place("create_ellipse", id, parent, x, y, { width: d, height: d, name });
        this.withProps(o, opts.props);
        this.count("circle");
        return id;
    }

    /**
     * Adds a text.
     *
     * @param parent - parent handle
     * @param x - left
     * @param y - top
     * @param w - width
     * @param h - height
     * @param characters - the text
     * @param opts - font and colour
     */
    text(
        parent: string | undefined,
        x: number,
        y: number,
        w: number,
        h: number,
        characters: string,
        opts: TextOptions = {}
    ): string {
        const id = opts.id ?? this.handle();
        const o = this.place("create_text", id, parent, x, y, {
            width: w,
            height: h,
            name: opts.name ?? characters.slice(0, 24),
            characters,
            growType: "fixed",
            fontSize: String(opts.size ?? 16),
            fontFamily: opts.family ?? "sourcesanspro",
        });
        if (opts.fontId !== undefined) {
            o.fontId = opts.fontId;
        }
        if (opts.weight !== undefined) {
            o.fontWeight = String(opts.weight);
            // the built-in family names its variants, a custom font names them by weight
            o.fontVariantId =
                opts.fontId === undefined ? (opts.weight >= 700 ? "bold" : "regular") : String(opts.weight);
            o.fontStyle = "normal";
        }
        o.fills = solid(opts.color ?? COLOR.dark);
        this.count("text");
        return id;
    }

    /**
     * Adds a path from absolute SVG data.
     *
     * @param parent - parent handle
     * @param d - path data in page space (the origin is not added)
     * @param box - box around the path, in page space
     * @param name - layer name
     * @param props - shape properties
     * @param id - handle
     */
    path(
        parent: string | undefined,
        d: string,
        box: { x: number; y: number; width: number; height: number },
        name: string,
        props: Record<string, unknown>,
        id?: string
    ): string {
        const handle = id ?? this.handle();
        const o: KioskOperation = {
            op: "create_path",
            pageId: this.page,
            id: handle,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            name,
            d,
        };
        if (parent !== undefined) {
            o.parentId = parent;
        }
        o.props = props;
        this.ops.push(o);
        this.count("path");
        return handle;
    }

    /**
     * Groups shapes.
     *
     * @param children - handles of the shapes to group
     * @param name - layer name
     */
    group(children: string[], name: string): string {
        const id = this.handle();
        this.ops.push({ op: "create_group", pageId: this.page, id, name, childIds: children });
        this.count("group");
        return id;
    }

    /**
     * Turns a board into a main component.
     *
     * @param board - handle of the board
     * @param name - component name
     * @param id - handle of the component
     */
    component(board: string, name: string, id: string): void {
        this.ops.push({ op: "create_component", pageId: this.page, id, shapeIds: [board], name });
    }

    /**
     * Adds a copy of a component, and counts every shape in it.
     *
     * @param key - component key
     * @param parent - parent handle
     * @param x - left
     * @param y - top
     * @param overrides - texts to change in the copy
     * @param id - handle of the copy
     */
    inst(
        key: string,
        parent: string | undefined,
        x: number,
        y: number,
        overrides: Override[] = [],
        id?: string
    ): string {
        const info = this.components[key];
        if (info === undefined) {
            throw new Error(`component ${key} is not defined`);
        }
        const handle = id ?? this.handle();
        const o = this.place("instantiate_component", handle, parent, x, y, { componentId: info.handle });
        if (overrides.length > 0) {
            o.overrides = overrides;
        }
        addCounts(this.counts, info.counts);
        this.feature("instance");
        return handle;
    }

    /**
     * Hides a shape.
     *
     * @param id - handle of the shape
     */
    hide(id: string): void {
        this.ops.push({ op: "update_shape", pageId: this.page, id, props: { hidden: true } });
    }

    /** A new shadow list with one drop shadow. */
    shadow(): Record<string, unknown>[] {
        return [
            {
                id: this.rng.uuid(),
                style: "drop-shadow",
                offsetX: 0,
                offsetY: 2,
                blur: 6,
                spread: 0,
                color: { color: "#000000", opacity: 0.25 },
                hidden: false,
            },
        ];
    }
}

/** What the plan knows about a component after it is defined. */
interface ComponentInfo {
    /** Handle of the component. */
    handle: string;
    /** Counts that one copy adds. */
    counts: Counts;
    /** Size of the root frame. */
    width: number;
    /** Size of the root frame. */
    height: number;
    /** Layer name. */
    name: string;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Components page                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------- */

/** Sizes of the main components, used by the views. */
const SIZE = {
    header: { w: 800, h: 60 },
    button: { w: 200, h: 56 },
    pin: { w: 80, h: 64 },
    row: { w: 500, h: 48 },
    card: { w: 220, h: 120 },
    tag: { w: 160, h: 80 },
    badge: { w: 90, h: 28 },
    boot: { w: 780, h: 520 },
    scroll: { w: 12, h: 320 },
    decision: { w: 200, h: 100 },
};

/** Border that is thick on one side only. */
const BOTTOM_BORDER = [
    {
        strokeColor: COLOR.line,
        strokeWidth: 1,
        strokeStyle: "solid",
        strokeAlignment: "inner",
        strokeWidthTop: 0,
        strokeWidthRight: 0,
        strokeWidthBottom: 3,
        strokeWidthLeft: 0,
    },
];

/**
 * Defines the main components on the page "Components".
 *
 * @param rec - recorder of the page
 * @param components - table that receives each component's handle and counts
 */
function defineComponents(rec: Recorder, components: Record<string, ComponentInfo>): void {
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    const define = (
        key: string,
        name: string,
        w: number,
        h: number,
        build: (board: string) => void,
        fill: string = COLOR.white
    ): void => {
        if (cursorX + w > 2400) {
            cursorX = 0;
            cursorY += rowHeight + 120;
            rowHeight = 0;
        }
        rec.ox = cursorX;
        rec.oy = cursorY;
        const before: Counts = { ...rec.counts };
        const board = rec.board(undefined, 0, 0, w, h, name, { props: { fills: solid(fill) } });
        build(board);
        const handle = `$tmp:c.${key}`;
        rec.component(board, name, handle);
        const counts: Counts = {};
        for (const [k, v] of Object.entries(rec.counts)) {
            const delta = v - (before[k] ?? 0);
            if (delta !== 0) {
                counts[k] = delta;
            }
        }
        components[key] = { handle, counts, width: w, height: h, name };
        cursorX += w + 120;
        rowHeight = Math.max(rowHeight, h);
    };

    define("header", "Header", SIZE.header.w, SIZE.header.h, (p) => {
        rec.rect(p, 0, 0, 800, 4, "Bar", { props: { fills: solid(COLOR.brand) } });
        rec.text(p, 16, 16, 120, 28, "LOGO", { size: 20, weight: 700, color: COLOR.brand, name: "Logo" });
        rec.text(p, 280, 16, 240, 28, "Title", { size: 20, color: COLOR.dark, name: "Title" });
        rec.text(p, 700, 16, 84, 28, "12:00", { size: 18, color: COLOR.mid, name: "Clock" });
    });
    define("buttonPrimary", "Button (primary)", SIZE.button.w, SIZE.button.h, (p) => {
        rec.rect(p, 0, 0, 200, 56, "Background", { props: { fills: solid(COLOR.brand), r1: 8, r2: 8, r3: 8, r4: 8 } });
        rec.text(p, 16, 14, 168, 28, "Button", { size: 20, weight: 700, color: COLOR.white, name: "Label" });
    });
    define("buttonSecondary", "Button (secondary)", SIZE.button.w, SIZE.button.h, (p) => {
        rec.rect(p, 0, 0, 200, 56, "Background", {
            props: { fills: solid(COLOR.soft), strokes: BOTTOM_BORDER, r1: 8, r2: 8, r3: 8, r4: 8 },
        });
        rec.text(p, 16, 14, 168, 28, "Button", { size: 20, color: COLOR.ink, name: "Label" });
    });
    define("pinKey", "PIN key", SIZE.pin.w, SIZE.pin.h, (p) => {
        rec.rect(p, 0, 0, 80, 64, "Key", { props: { fills: solid(COLOR.soft), r1: 6, r2: 6, r3: 6, r4: 6 } });
        rec.text(p, 28, 8, 24, 30, "0", { size: 24, weight: 700, name: "Digit" });
        rec.text(p, 20, 40, 40, 16, "ABC", { size: 10, color: COLOR.mid, name: "Letters" });
    });
    define("listRow", "List row", SIZE.row.w, SIZE.row.h, (p) => {
        rec.rect(p, 0, 0, 500, 48, "Row background", { props: { fills: solid(COLOR.white) } });
        rec.circle(p, 12, 10, 28, "Icon", { props: { fills: solid(COLOR.brand) } });
        rec.text(p, 56, 10, 220, 28, "Label", { size: 18, name: "Label" });
        rec.text(p, 300, 10, 150, 28, "Value", { size: 18, color: COLOR.mid, name: "Value" });
        const x = rec.ox + 470;
        const y = rec.oy + 17;
        rec.path(p, `M${x} ${y}L${x + 8} ${y + 7}L${x} ${y + 14}`, { x, y, width: 8, height: 14 }, "Chevron", {
            fills: [],
            strokes: [{ strokeColor: COLOR.mid, strokeWidth: 2 }],
        });
        rec.feature("chevron");
        rec.rect(p, 0, 46, 500, 2, "Underline", { props: { fills: solid(COLOR.line) } });
    });
    define("card", "Card", SIZE.card.w, SIZE.card.h, (p) => {
        rec.rect(p, 0, 0, 220, 120, "Card background", {
            props: { fills: solid(COLOR.soft), strokes: BOTTOM_BORDER, r1: 10, r2: 10, r3: 10, r4: 10 },
        });
        rec.circle(p, 16, 16, 32, "Accent", { props: { fills: solid(COLOR.brand) } });
        rec.text(p, 16, 56, 188, 26, "Title", { size: 20, weight: 700, name: "Title" });
        rec.text(p, 16, 86, 188, 22, "Body", { size: 14, color: COLOR.mid, name: "Body" });
    });
    define("keyTag", "Key tag", SIZE.tag.w, SIZE.tag.h, (p) => {
        rec.rect(p, 0, 0, 160, 80, "Tag", {
            props: { fills: gradient("#FEC84B", "#F79009", false), shadow: rec.shadow(), r1: 8, r2: 8, r3: 8, r4: 8 },
        });
        rec.circle(p, 12, 12, 16, "Hole", { props: { fills: solid(COLOR.white) } });
        rec.text(p, 40, 28, 110, 28, "Key 00", { size: 20, weight: 700, name: "Label" });
    });
    define("statusBadge", "Status badge", SIZE.badge.w, SIZE.badge.h, (p) => {
        rec.rect(p, 0, 0, 90, 28, "Badge background", {
            props: { fills: solid(COLOR.ok), r1: 14, r2: 14, r3: 14, r4: 14 },
        });
        rec.text(p, 10, 4, 70, 20, "OK", { size: 14, weight: 700, color: COLOR.white, name: "Label" });
    });
    define("bootSplash", "Boot splash", SIZE.boot.w, SIZE.boot.h, (p) => {
        rec.rect(p, 0, 0, 780, 520, "Splash background", { props: { fills: gradient(COLOR.dark, "#1D2939", false) } });
        rec.text(p, 190, 180, 400, 60, "KIOSK", { size: 48, weight: 700, color: COLOR.white, name: "Splash logo" });
        rec.rect(p, 190, 300, 400, 10, "Progress track", {
            props: { fills: solid(COLOR.mid), r1: 5, r2: 5, r3: 5, r4: 5 },
        });
        rec.rect(p, 190, 300, 160, 10, "Progress fill", {
            props: { fills: solid(COLOR.brand), r1: 5, r2: 5, r3: 5, r4: 5 },
        });
        rec.text(p, 190, 330, 400, 24, "Starting", { size: 16, color: "#98A2B3", name: "Status" });
    });
    define("scrollBar", "Scroll bar", SIZE.scroll.w, SIZE.scroll.h, (p) => {
        rec.rect(p, 0, 0, 12, 320, "Track", { props: { fills: solid(COLOR.soft), r1: 6, r2: 6, r3: 6, r4: 6 } });
        rec.rect(p, 1, 4, 10, 90, "Thumb", { props: { fills: solid(COLOR.mid), r1: 5, r2: 5, r3: 5, r4: 5 } });
    });
    define("decision", "Decision", SIZE.decision.w, SIZE.decision.h, (p) => {
        const o = { x: rec.ox, y: rec.oy };
        rec.path(
            p,
            `M${o.x + 100} ${o.y}L${o.x + 200} ${o.y + 50}L${o.x + 100} ${o.y + 100}L${o.x} ${o.y + 50}Z`,
            { x: o.x, y: o.y, width: 200, height: 100 },
            "Diamond",
            { fills: solid("#FEF0C7"), strokes: [{ strokeColor: COLOR.warn, strokeWidth: 2 }] }
        );
        rec.text(p, 40, 36, 120, 28, "Is it so?", { size: 16, color: COLOR.ink, name: "Question" });
    });
    define("screenTemplate", "Screen template", 800, 600, (p) => {
        rec.inst("header", p, 0, 0);
        rec.rect(p, 0, 60, 800, 540, "Content area", { props: { fills: solid(COLOR.soft) } });
    });
    define("screenTemplateContent", "Screen template with content", 800, 600, (p) => {
        rec.inst("header", p, 0, 0);
        const block = rec.board(p, 40, 100, 720, 400, "Content block", { props: { fills: solid(COLOR.soft) } });
        rec.text(block, 60, 120, 400, 36, "Content title", { size: 28, weight: 700, name: "Content title" });
        rec.rect(block, 60, 180, 680, 280, "Content body", { props: { fills: solid(COLOR.white) } });
    });
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Screens                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------- */

/** One screen to draw. */
interface ScreenSpec {
    /** Index in creation order. */
    index: number;
    /** View. */
    view: ViewKey;
    /** Name a person gives the screen. */
    humanName: string;
    /** Key that the content derives from. Copies share it. */
    contentKey: string;
    /** Kind. */
    kind: ScreenKind;
    /** Structure, for boot and blank screens. */
    structure?: ScreenStructure;
    /** Copy group. */
    copyGroup?: string;
    /** True when the screen sits inside a `Single` frame. */
    single: boolean;
    /** Number that varies the content of screens of one view. */
    variant: number;
    /** Section index. */
    section: number;
}

/** What a screen's drawing found worth recording. */
interface ScreenFacts {
    offBoard: { shape: string; overhangPx: number }[];
    clipped: { shape: string; frame: string; clipped: "fully" | "half"; visibleFraction: number }[];
    scroll: {
        frame: string;
        frameHeight: number;
        contentHeight: number;
        overflowPx: number;
        rows: number;
        rowsBelowEdge: number;
        scrollBar: string | null;
    }[];
    dividers: string[];
    fontTexts: string[];
    flips: FlipSpec[];
}

/** Everything a view needs while it draws. */
interface ViewContext {
    /** Recorder, with the origin at the screen's top-left corner. */
    b: Recorder;
    /** Handle of the `Parent` frame. */
    p: string;
    /** The screen. */
    spec: ScreenSpec;
    /** Random numbers of the content. */
    rng: Rng;
    /** Facts found. */
    facts: ScreenFacts;
    /** Handle of the screen, for flips. */
    screen: string;
    /** Flips to draw in the footer. */
    flips: { ordinary: number; groups: number };
    /** Shapes the screen should hold in all, filler included. */
    target: number;
}

/** Shapes in the subtree of a `Parent` frame, by view. Every screen of a view has this many, filler included. */
const VIEW_SHAPES: Record<ViewKey, number> = {
    screensaver: 40,
    login: 92,
    loginFailure: 92,
    mainMenu: 111,
    mainMenuAdmin: 140,
    cabinetSelect: 172,
    checkOut: 208,
    checkIn: 200,
    logging: 160,
    settings: 212,
    boot: 0,
    adminActions: 0,
};

const FIRST_NAMES = ["Alder", "Birch", "Cedar", "Dune", "Elm", "Fjord", "Grove", "Harbor", "Iris", "Juniper"];
const PLACES = ["North", "South", "East", "West", "Lobby", "Garage", "Depot", "Annex", "Yard", "Gate"];

/**
 * Draws the header at the top of a screen.
 *
 * @param c - view context
 * @param title - header title
 */
function drawHeader(c: ViewContext, title: string): string {
    return c.b.inst("header", c.p, 0, 0, [{ name: "Title", characters: title }]);
}

/**
 * Draws the footer flips: ordinary shapes and groups that the build mirrors with raw changes.
 *
 * @param c - view context
 */
function drawFlips(c: ViewContext): void {
    const b = c.b;
    let slot = 0;
    for (let i = 0; i < c.flips.ordinary; i++) {
        const x = 40 + slot * 60;
        const shape = b.rect(c.p, x, 562, 36, 22, `Flip ${i + 1}`, { props: { fills: solid(COLOR.warn) } });
        c.facts.flips.push({
            shape,
            kind: "rect",
            axis: i % 4 === 3 ? "y" : "x",
            screen: c.screen,
            box: { x: x + b.ox, y: 562 + b.oy, width: 36, height: 22 },
            mode: "mirror",
        });
        slot++;
    }
    for (let i = 0; i < c.flips.groups; i++) {
        const x = 40 + slot * 60;
        const first = b.rect(c.p, x, 562, 24, 16, "Part A", { props: { fills: solid(COLOR.err) } });
        const second = b.rect(c.p, x + 14, 572, 24, 16, "Part B", { props: { fills: solid(COLOR.brand) } });
        const shape = b.group([first, second], `Flip group ${i + 1}`);
        c.facts.flips.push({
            shape,
            kind: "group",
            axis: "x",
            screen: c.screen,
            box: { x: x + b.ox, y: 562 + b.oy, width: 38, height: 26 },
            mode: "identity",
        });
        slot++;
    }
}

/**
 * Adds small loose marks until the screen holds the shapes that its view should have.
 *
 * @param c - view context
 */
function fillTo(c: ViewContext): void {
    const target = c.target;
    const have = c.b.counts.shapes ?? 0;
    const flipShapes = c.flips.ordinary + c.flips.groups * 3;
    const need = target - have - flipShapes;
    if (need < 0) {
        throw new Error(
            `view ${c.spec.view} holds ${have + flipShapes} shapes before filler, above its target ${target}`
        );
    }
    if (need > 200) {
        throw new Error(`view ${c.spec.view} needs ${need} filler shapes, above the 200 that fit`);
    }
    for (let i = 0; i < need; i++) {
        const x = 40 + (i % 50) * 14;
        const y = 516 + Math.floor(i / 50) * 12;
        const kind = i % 3;
        if (kind === 0) {
            c.b.rect(c.p, x, y, 10, 10, `Tick ${i + 1}`, {
                props: { fills: solid(i % 7 === 0 ? COLOR.warn : COLOR.line) },
            });
        } else if (kind === 1) {
            c.b.circle(c.p, x, y, 8, `Pip ${i + 1}`, { props: { fills: solid(i % 5 === 0 ? COLOR.ok : COLOR.mid) } });
        } else {
            c.b.text(c.p, x, y, 10, 10, "-", { size: 8, color: COLOR.mid, name: `Mark ${i + 1}` });
        }
    }
}

/**
 * Draws a PIN pad of twelve keys.
 *
 * @param c - view context
 * @param x - left
 * @param y - top
 */
function drawPinPad(c: ViewContext, x: number, y: number): void {
    const labels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "OK"];
    labels.forEach((label, i) => {
        c.b.inst("pinKey", c.p, x + (i % 3) * 96, y + Math.floor(i / 3) * 76, [{ name: "Digit", characters: label }]);
    });
}

/**
 * Draws a clipping frame with list rows, some of which lie past its bottom edge.
 *
 * @param c - view context
 * @param rows - row count
 * @param y - top of the frame
 * @param height - height of the frame
 * @param prefix - label prefix of the rows
 * @param withScrollBar - true to draw a scroll bar beside the frame
 */
function drawClippedList(
    c: ViewContext,
    rows: number,
    y: number,
    height: number,
    prefix: string,
    withScrollBar: boolean
): string {
    const b = c.b;
    const frame = b.board(c.p, 40, y, 520, height, "Key list", { props: { fills: solid(COLOR.white) } });
    const place = (i: number): number => y + 10 + i * 52;
    for (let i = 0; i < rows; i++) {
        b.inst("listRow", frame, 50, place(i), [
            { name: "Label", characters: `${prefix} ${String(i + 1).padStart(2, "0")}` },
            { name: "Value", characters: `${(c.rng.int(10, 99) * 7) % 100}`.padStart(2, "0") },
        ]);
    }
    const last = place(rows - 1) + SIZE.row.h;
    let below = 0;
    for (let i = 0; i < rows; i++) {
        if (place(i) >= y + height) {
            below++;
        }
    }
    const bar = withScrollBar ? b.inst("scrollBar", c.p, 562, y, [], undefined) : null;
    c.facts.scroll.push({
        frame,
        frameHeight: height,
        contentHeight: last - y,
        overflowPx: last - (y + height),
        rows,
        rowsBelowEdge: below,
        scrollBar: bar,
    });
    return frame;
}

/**
 * Draws a side panel frame beside a list, with a divider line between the two frames.
 *
 * @param c - view context
 * @param y - top
 * @param height - height
 * @returns handle of the panel
 */
function drawPanelAndDivider(c: ViewContext, y: number, height: number): string {
    const b = c.b;
    const panel = b.board(c.p, 590, y, 200, height, "Side panel", { props: { fills: solid(COLOR.soft) } });
    const x = b.ox + 582;
    const top = b.oy + y;
    const handle = b.path(c.p, `M${x} ${top}L${x} ${top + height}`, { x, y: top, width: 0.01, height }, "Divider", {
        fills: [],
        strokes: [{ strokeColor: COLOR.line, strokeWidth: 2 }],
    });
    b.feature("divider-line");
    c.facts.dividers.push(handle);
    return panel;
}

/**
 * Draws one screen of a content view.
 *
 * @param c - view context
 */
function drawContentView(c: ViewContext): void {
    const b = c.b;
    const v = c.spec.variant;
    const place = `${PLACES[v % PLACES.length]} ${FIRST_NAMES[(v * 3) % FIRST_NAMES.length]}`;
    switch (c.spec.view) {
        case "screensaver": {
            drawHeader(c, "Idle");
            b.rect(c.p, 0, 60, 800, 540, "Backdrop", { props: { fills: solid(COLOR.dark) } });
            const brand = b.text(c.p, 100, 240, 600, 80, "Customer Brand", {
                size: 56,
                weight: 700,
                color: COLOR.white,
                family: "Access Sans",
                fontId: "gfont-access-sans",
                name: "Brand",
            });
            c.facts.fontTexts.push(brand);
            b.text(c.p, 100, 330, 600, 30, `Touch the screen to begin (${place})`, {
                size: 20,
                color: "#98A2B3",
                name: "Prompt",
            });
            for (let i = 0; i < 10; i++) {
                b.circle(c.p, 60 + i * 70, 430 + (i % 3) * 20, 24, `Orb ${i + 1}`, {
                    props: { fills: solid(COLOR.brand) },
                });
            }
            b.rect(c.p, 0, 540, 800, 6, "Glow", { props: { fills: gradient(COLOR.brand, COLOR.dark, true) } });
            break;
        }
        case "login":
        case "loginFailure": {
            const failure = c.spec.view === "loginFailure";
            drawHeader(c, failure ? "Login failed" : "Login");
            b.text(c.p, 40, 80, 300, 34, failure ? "Wrong PIN" : "Enter your PIN", {
                size: 28,
                weight: 700,
                name: "Heading",
            });
            b.inst("card", c.p, 40, 140, [
                { name: "Title", characters: failure ? "Card not read" : "Present your card" },
                { name: "Body", characters: place },
            ]);
            const field = b.board(c.p, 400, 70, 272, 56, "PIN field", { props: { fills: solid(COLOR.soft) } });
            for (let i = 0; i < 4; i++) {
                b.circle(field, 424 + i * 56, 88, 20, `Dot ${i + 1}`, {
                    props: { fills: solid(failure ? COLOR.err : COLOR.mid) },
                });
            }
            drawPinPad(c, 400, 140);
            b.inst("buttonPrimary", c.p, 40, 300, [{ name: "Label", characters: failure ? "Try again" : "Log in" }]);
            b.inst("buttonSecondary", c.p, 40, 372, [{ name: "Label", characters: "Help" }]);
            b.inst("statusBadge", c.p, 40, 450, [{ name: "Label", characters: failure ? "Error" : "Ready" }]);
            b.text(c.p, 40, 480, 300, 24, `Terminal ${String(v + 1).padStart(2, "0")}`, {
                size: 14,
                color: COLOR.mid,
                name: "Terminal",
            });
            break;
        }
        case "mainMenu":
        case "mainMenuAdmin": {
            const admin = c.spec.view === "mainMenuAdmin";
            drawHeader(c, admin ? "Main menu (admin)" : "Main menu");
            const tiles = admin
                ? ["Users", "Keys", "Cabinets", "Logs", "Settings", "Reports", "Sync", "Backup", "Service"]
                : ["Check out", "Check in", "My keys", "Help", "Language", "Log out"];
            tiles.forEach((name, i) => {
                b.inst("card", c.p, 40 + (i % 3) * 250, 90 + Math.floor(i / 3) * 130, [
                    { name: "Title", characters: name },
                    { name: "Body", characters: admin ? "Admin" : place },
                ]);
            });
            if (!admin) {
                b.inst("statusBadge", c.p, 40, 380, [{ name: "Label", characters: "Online" }]);
                b.inst("statusBadge", c.p, 140, 380, [{ name: "Label", characters: "3 keys" }]);
                b.inst("buttonPrimary", c.p, 40, 430, [{ name: "Label", characters: "Start" }]);
                b.inst("buttonSecondary", c.p, 260, 430, [{ name: "Label", characters: "Back" }]);
            }
            break;
        }
        case "cabinetSelect": {
            drawHeader(c, "Select cabinet");
            for (let i = 0; i < 6; i++) {
                b.inst("keyTag", c.p, 40 + (i % 3) * 180, 80 + Math.floor(i / 3) * 100, [
                    { name: "Label", characters: `Cab ${String(v * 6 + i + 1).padStart(3, "0")}` },
                ]);
            }
            for (let i = 0; i < 3; i++) {
                b.inst("listRow", c.p, 40, 290 + i * 52, [
                    { name: "Label", characters: `${place} ${i + 1}` },
                    { name: "Value", characters: `${(v + i) % 9}` },
                ]);
            }
            b.inst("buttonSecondary", c.p, 40, 450, [{ name: "Label", characters: "Back" }]);
            const select = b.inst("buttonPrimary", c.p, 681, 450, [{ name: "Label", characters: "Select" }], undefined);
            c.facts.offBoard.push({ shape: select, overhangPx: 681 + SIZE.button.w - 800 });
            break;
        }
        case "checkOut":
        case "checkIn": {
            const out = c.spec.view === "checkOut";
            drawHeader(c, out ? "Check out" : "Check in");
            const rows = out ? 14 + (v % 5) : 10 + (v % 4);
            drawClippedList(c, rows, 90, 320, out ? "Key" : "Return", true);
            drawPanelAndDivider(c, 90, 320);
            for (let i = 0; i < 3; i++) {
                b.inst("keyTag", c.p, 610, 100 + i * 100, [{ name: "Label", characters: `Tag ${v * 3 + i + 1}` }]);
            }
            b.inst("buttonPrimary", c.p, 40, 430, [{ name: "Label", characters: out ? "Check out" : "Check in" }]);
            b.inst("buttonSecondary", c.p, 260, 430, [{ name: "Label", characters: "Cancel" }]);
            b.inst("statusBadge", c.p, 500, 444, [{ name: "Label", characters: `${rows} keys` }]);
            break;
        }
        case "logging": {
            drawHeader(c, `Log ${v + 1}`);
            const frame = b.board(c.p, 40, 80, 720, 390, "Log table", { props: { fills: solid(COLOR.white) } });
            for (let i = 0; i < 7; i++) {
                b.inst("listRow", frame, 50, 90 + i * 52, [
                    { name: "Label", characters: `Event ${v * 7 + i + 1}` },
                    { name: "Value", characters: `${place}` },
                ]);
                b.inst("statusBadge", frame, 580, 100 + i * 52, [
                    { name: "Label", characters: i % 2 === 0 ? "OK" : "Alert" },
                ]);
            }
            b.inst("buttonSecondary", c.p, 40, 480, [{ name: "Label", characters: "Filter" }]);
            break;
        }
        case "settings": {
            drawHeader(c, "Settings");
            const frame = b.board(c.p, 40, 90, 520, 346, "Settings list", { props: { fills: solid(COLOR.white) } });
            const names = ["Language", "Volume", "Brightness", "Network", "Time", "Cabinet", "Proximity", "Service"];
            const rowY = (i: number): number => 100 + i * 52;
            names.forEach((name, i) => {
                const row = b.inst("listRow", frame, 50, rowY(i), [
                    { name: "Label", characters: name },
                    { name: "Value", characters: `${(v + i) % 10}` },
                ]);
                const top = rowY(i);
                const bottom = top + SIZE.row.h;
                const edge = 90 + 346;
                if (bottom > edge) {
                    const visible = Math.max(0, edge - top) / SIZE.row.h;
                    c.facts.clipped.push({
                        shape: row,
                        frame,
                        clipped: visible === 0 ? "fully" : "half",
                        visibleFraction: visible,
                    });
                }
            });
            const lastBottom = rowY(names.length - 1) + SIZE.row.h;
            c.facts.scroll.push({
                frame,
                frameHeight: 346,
                contentHeight: lastBottom - 90,
                overflowPx: lastBottom - (90 + 346),
                rows: names.length,
                rowsBelowEdge: names.filter((_n, i) => rowY(i) >= 90 + 346).length,
                scrollBar: null,
            });
            drawPanelAndDivider(c, 90, 346);
            b.inst("card", c.p, 570, 100, [
                { name: "Title", characters: "Device" },
                { name: "Body", characters: place },
            ]);
            b.inst("card", c.p, 570, 230, [
                { name: "Title", characters: "Network" },
                { name: "Body", characters: "Online" },
            ]);
            b.inst("buttonPrimary", c.p, 40, 440, [{ name: "Label", characters: "Save" }]);
            b.inst("buttonSecondary", c.p, 260, 440, [{ name: "Label", characters: "Reset" }]);
            break;
        }
        default:
            throw new Error(`view ${c.spec.view} is not a content view`);
    }
    fillTo(c);
    drawFlips(c);
}

/**
 * Draws a boot, blank or empty screen in its structure.
 *
 * @param c - view context
 */
function drawSimpleScreen(c: ViewContext): void {
    const b = c.b;
    const s = c.spec;
    const n = s.variant + 1;
    if (s.kind === "empty") {
        return;
    }
    if (s.view === "boot") {
        if (s.structure === "a") {
            b.inst("screenTemplateContent", c.p, 0, 0, [{ name: "Content title", characters: `Loading ${n}` }]);
        } else if (s.structure === "b") {
            const header = b.inst("header", c.p, 0, 0, [{ name: "Title", characters: `Boot ${n}` }]);
            b.hide(header);
            b.inst("bootSplash", c.p, 10, 70, [{ name: "Status", characters: `Starting ${n}` }]);
        } else {
            const wrapper = b.board(c.p, 0, 0, 800, 600, "Wrapper", { props: { fills: [] } });
            b.inst("header", wrapper, 0, 0, [{ name: "Title", characters: `Boot ${n}` }]);
            b.inst("bootSplash", wrapper, 10, 70, [{ name: "Status", characters: `Starting ${n}` }]);
        }
        return;
    }
    if (s.structure === "a") {
        b.inst("screenTemplate", c.p, 0, 0, [{ name: "Title", characters: `Action ${n}` }]);
    } else if (s.structure === "b") {
        b.inst("header", c.p, 0, 0, [{ name: "Title", characters: `Action ${n}` }]);
    } else {
        const wrapper = b.board(c.p, 0, 0, 800, 600, "Wrapper", { props: { fills: [] } });
        b.inst("header", wrapper, 0, 0, [{ name: "Title", characters: `Action ${n}` }]);
    }
}

/** What drawing one screen produced. */
interface ScreenUnit {
    ops: KioskOperation[];
    counts: Counts;
    facts: ScreenFacts;
    shapes: number;
    label: string;
}

/**
 * Draws one screen: its `Parent` frame, its content, and its label.
 *
 * @param spec - the screen
 * @param origin - top-left corner of the `Parent` frame in page space
 * @param holder - handle of the frame that holds the `Parent` (state or `Single`)
 * @param flips - flips to draw in the footer
 * @param seed - plan seed
 * @param components - component table
 */
function drawScreen(
    spec: ScreenSpec,
    origin: KioskPoint,
    holder: string,
    flips: { ordinary: number; groups: number },
    seed: number,
    components: Record<string, ComponentInfo>,
    shapeScale: number
): ScreenUnit {
    const prefix = `p${spec.index}`;
    const rng = new Rng(hashText(`${seed}:${spec.contentKey}`));
    const b = new Recorder(PAGE_JOURNEYS, prefix, rng, components);
    const handle = `$tmp:P${spec.index}`;
    b.ox = origin.x;
    b.oy = origin.y;
    b.board(holder, 0, 0, 800, 600, "Parent", { id: handle, props: { fills: solid(COLOR.white) } });
    const facts: ScreenFacts = { offBoard: [], clipped: [], scroll: [], dividers: [], fontTexts: [], flips: [] };
    const ctx: ViewContext = {
        b,
        p: handle,
        spec,
        rng,
        facts,
        screen: handle,
        flips,
        target: Math.round(VIEW_SHAPES[spec.view] * shapeScale),
    };
    if (spec.kind === "content") {
        drawContentView(ctx);
    } else {
        drawSimpleScreen(ctx);
    }
    const shapes = b.counts.shapes ?? 0;
    const label = `$tmp:L${spec.index}`;
    b.ox = origin.x;
    b.oy = origin.y;
    b.text(holder, 0, 614, 560, 28, spec.humanName, {
        size: 20,
        color: COLOR.ink,
        name: `Label ${spec.humanName}`,
        id: label,
    });
    return { ops: b.ops, counts: b.counts, facts, shapes, label };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Screen mix and sections                                                                                         */
/* ------------------------------------------------------------------------------------------------------------- */

const SECTIONS = [
    "Idle",
    "Login",
    "Main menu",
    "Admin",
    "Cabinet",
    "Check out",
    "Check in",
    "Logging",
    "Settings",
    "Boot",
    "Assets",
    "Misc",
] as const;

/** Human names of the views. */
const VIEW_NAMES: Record<ViewKey, string> = {
    screensaver: "Screen saver",
    login: "Login",
    loginFailure: "Login failure",
    mainMenu: "Main menu",
    mainMenuAdmin: "Main menu admin",
    cabinetSelect: "Cabinet select",
    checkOut: "Check out",
    checkIn: "Check in",
    logging: "Logging",
    settings: "Settings overview",
    boot: "Boot",
    adminActions: "Admin actions",
};

/** Screens of the 207 size, by group. Other sizes scale these. */
const BASE_MIX = {
    empty: 7,
    blankA: 8,
    blankB: 8,
    blankC: 7,
    bootA: 6,
    bootB: 6,
    bootC: 5,
    screensaver: 2,
    login: 8,
    loginFailure: 8,
    mainMenu: 14,
    cabinetSelect: 30,
    checkOut: 24,
    checkIn: 24,
    settings: 32,
} as const;

/**
 * Rounds a set of shares so that they add up to a total (largest remainder).
 *
 * @param weights - weight of each item
 * @param total - sum to reach
 */
function apportion(weights: number[], total: number): number[] {
    const sum = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map((w) => (w * total) / sum);
    const base = exact.map(Math.floor);
    let left = total - base.reduce((a, b) => a + b, 0);
    const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const { i } of order) {
        if (left <= 0) {
            break;
        }
        base[i]++;
        left--;
    }
    return base;
}

/** Where the six-section spread of Main menu admin copies goes. */
const COPY_SECTIONS = [3, 4, 5, 6, 8, 11];

/**
 * Builds the list of screens of a size, with their sections, copy groups and structures.
 *
 * @param size - size name
 */
function buildScreenList(size: KioskSizeName): ScreenSpec[] {
    const screens: ScreenSpec[] = [];
    const add = (spec: Omit<ScreenSpec, "index">): void => {
        screens.push({ ...spec, index: screens.length });
    };
    if (size === "12") {
        const one = (view: ViewKey, section: number, kind: ScreenKind, structure?: ScreenStructure): void =>
            add({
                view,
                humanName: VIEW_NAMES[view],
                contentKey: `${view}:0`,
                kind,
                structure,
                single: false,
                variant: 0,
                section,
            });
        one("screensaver", 0, "content");
        one("login", 1, "content");
        one("loginFailure", 1, "content");
        one("mainMenu", 1, "content");
        one("mainMenuAdmin", 1, "content");
        one("cabinetSelect", 4, "content");
        one("checkOut", 4, "content");
        one("checkIn", 4, "content");
        one("logging", 4, "content");
        one("settings", 8, "content");
        one("boot", 9, "instance-only", "a");
        one("adminActions", 8, "blank", "a");
        markSingles(screens, size);
        return screens;
    }
    const f = KIOSK_SIZES[size].screens / 207;
    const copies = Math.max(1, Math.round(6 * f));
    const loggingUnique = Math.max(1, Math.round(4 * f));
    const empty = Math.round(7 * f);
    const blank = [Math.round(8 * f), Math.round(8 * f), Math.round(7 * f)];
    const boot = [Math.round(6 * f), Math.round(6 * f), Math.round(5 * f)];
    const fixed =
        copies + loggingUnique * 3 + empty + blank.reduce((a, b) => a + b, 0) + boot.reduce((a, b) => a + b, 0);
    const bigKeys = [
        "screensaver",
        "login",
        "loginFailure",
        "mainMenu",
        "cabinetSelect",
        "checkOut",
        "checkIn",
        "settings",
    ] as const;
    const bigCounts = apportion(
        bigKeys.map((k) => BASE_MIX[k]),
        KIOSK_SIZES[size].screens - fixed
    );
    const counts: Record<string, number> = {};
    bigKeys.forEach((k, i) => (counts[k] = bigCounts[i]));
    const structures: ScreenStructure[] = ["a", "b", "c"];
    const sectionFor = (view: ViewKey, i: number): number => {
        switch (view) {
            case "screensaver":
                return 0;
            case "login":
            case "loginFailure":
                return 1;
            case "mainMenu":
                return 2;
            case "cabinetSelect":
                return 4;
            case "checkOut":
                return 5;
            case "checkIn":
                return 6;
            case "settings":
                return 8;
            default:
                return i;
        }
    };
    for (const k of bigKeys) {
        for (let i = 0; i < counts[k]; i++) {
            add({
                view: k,
                humanName: `${VIEW_NAMES[k]} ${String(i + 1).padStart(2, "0")}`,
                contentKey: `${k}:${i}`,
                kind: "content",
                single: false,
                variant: i,
                section: sectionFor(k, 0),
            });
        }
    }
    for (let i = 0; i < copies; i++) {
        add({
            view: "mainMenuAdmin",
            humanName: VIEW_NAMES.mainMenuAdmin,
            contentKey: "mainMenuAdmin:0",
            kind: "content",
            copyGroup: "main-menu-admin",
            single: false,
            variant: 0,
            section: COPY_SECTIONS[i % COPY_SECTIONS.length],
        });
    }
    for (let u = 0; u < loggingUnique; u++) {
        // the first copy sits in Logging, the second in Check in, the third in Check out
        for (const section of [7, 6, 5]) {
            add({
                view: "logging",
                humanName: `Logging ${u + 1}`,
                contentKey: `logging:${u}`,
                kind: "content",
                copyGroup: `logging-${u + 1}`,
                single: false,
                variant: u,
                section,
            });
        }
    }
    structures.forEach((structure, si) => {
        for (let i = 0; i < boot[si]; i++) {
            add({
                view: "boot",
                humanName: `${si < 2 ? "Boot" : "Asset"} ${structure}${i + 1}`,
                contentKey: `boot:${structure}:${i}`,
                kind: "instance-only",
                structure,
                single: false,
                variant: i,
                section: si < 2 ? 9 : 10,
            });
        }
    });
    structures.forEach((structure, si) => {
        for (let i = 0; i < blank[si]; i++) {
            add({
                view: "adminActions",
                humanName: `Admin action ${structure}${i + 1}`,
                contentKey: `admin:${structure}:${i}`,
                kind: "blank",
                structure,
                single: false,
                variant: i,
                section: si === 0 ? 3 : 11,
            });
        }
    });
    for (let i = 0; i < empty; i++) {
        add({
            view: "adminActions",
            humanName: `Empty ${i + 1}`,
            contentKey: `empty:${i}`,
            kind: "empty",
            single: false,
            variant: i,
            section: 11,
        });
    }
    markSingles(screens, size);
    // order by section, then keep creation order inside a section
    const ordered = screens
        .map((s, i) => ({ s, i }))
        .sort((a, b) => a.s.section - b.s.section || a.i - b.i)
        .map(({ s }, index) => ({ ...s, index }));
    return ordered;
}

/**
 * Marks screens that sit inside a `Single` frame, spread evenly over the content screens that are not copies.
 *
 * @param screens - the screens
 * @param size - size name
 */
function markSingles(screens: ScreenSpec[], size: KioskSizeName): void {
    const want = size === "12" ? 1 : Math.max(1, Math.round((6 * KIOSK_SIZES[size].screens) / 207));
    const pool = screens.filter((s) => s.kind === "content" && s.copyGroup === undefined && s.view !== "screensaver");
    for (let k = 0; k < want; k++) {
        pool[Math.floor(((k + 0.5) * pool.length) / want)].single = true;
    }
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Layout                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------- */

const SEC_PAD = 80;
const GRP_PAD = 40;
const STEP_PAD = 40;
const GAP_X = 240;
const DECISION_GAP = 600;
const STEP_GAP = 120;
const GROUP_GAP = 160;
const SECTION_GAP = 600;
const STATE_H = 660;

/** A state in the layout, relative to its section. */
interface LaidState {
    spec: ScreenSpec;
    x: number;
    y: number;
    handle: string;
    single?: string;
}

/** A step in the layout. */
interface LaidStep {
    handle: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    states: LaidState[];
    /** Gap after each state but the last. */
    gaps: { gap: number; decision: boolean; reversed: boolean }[];
}

/** A journey group in the layout. */
interface LaidGroup {
    handle: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    steps: LaidStep[];
}

/** A section in the layout. */
interface LaidSection {
    handle: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    groups: LaidGroup[];
    screens: number;
}

const DECISION_TEXTS = [
    "Is the PIN correct?",
    "Is the card valid?",
    "Is the key available?",
    "Is the user an admin?",
    "Is the cabinet open?",
    "Is the key returned?",
    "Is the network up?",
    "Are there more keys?",
];

/**
 * Lays out the nesting of one section: groups, steps and states, in section-relative coordinates.
 *
 * @param index - section index
 * @param specs - screens of the section, in order
 * @param statesPerStep - most states in a step
 * @param rng - random numbers
 * @param counters - running counters of handles
 */
function layoutSection(
    index: number,
    specs: ScreenSpec[],
    statesPerStep: number,
    rng: Rng,
    counters: { group: number; step: number; state: number; single: number }
): LaidSection {
    const groups: LaidGroup[] = [];
    const perGroup = statesPerStep * 4;
    let cursorY = SEC_PAD;
    let maxWidth = 0;
    for (let g = 0; g * perGroup < specs.length; g++) {
        const slice = specs.slice(g * perGroup, (g + 1) * perGroup);
        const steps: LaidStep[] = [];
        let stepY = GRP_PAD;
        let groupWidth = 0;
        for (let s = 0; s * statesPerStep < slice.length; s++) {
            const chunk = slice.slice(s * statesPerStep, (s + 1) * statesPerStep);
            const gaps = chunk.slice(1).map(() => {
                const decision = rng.chance(0.08);
                return { gap: decision ? DECISION_GAP : GAP_X, decision, reversed: rng.chance(0.25) };
            });
            const width = STEP_PAD * 2 + chunk.length * 800 + gaps.reduce((a, g2) => a + g2.gap, 0);
            const states: LaidState[] = [];
            let x = STEP_PAD;
            chunk.forEach((spec, i) => {
                states.push({
                    spec,
                    x,
                    y: STEP_PAD,
                    handle: `$tmp:S${counters.state++}`,
                    single: spec.single ? `$tmp:W${counters.single++}` : undefined,
                });
                x += 800 + (gaps[i]?.gap ?? 0);
            });
            steps.push({
                handle: `$tmp:T${counters.step++}`,
                x: GRP_PAD,
                y: stepY,
                width,
                height: STATE_H + STEP_PAD * 2,
                name: `Step ${s + 1}`,
                states,
                gaps,
            });
            stepY += STATE_H + STEP_PAD * 2 + STEP_GAP;
            groupWidth = Math.max(groupWidth, width);
        }
        const height = stepY - STEP_GAP + GRP_PAD;
        groups.push({
            handle: `$tmp:G${counters.group++}`,
            x: SEC_PAD,
            y: cursorY,
            width: groupWidth + GRP_PAD * 2,
            height,
            name: `Journey ${g + 1}`,
            steps,
        });
        cursorY += height + GROUP_GAP;
        maxWidth = Math.max(maxWidth, groupWidth + GRP_PAD * 2);
    }
    const width = Math.max(1000, maxWidth + SEC_PAD * 2);
    const height = groups.length === 0 ? 700 : cursorY - GROUP_GAP + SEC_PAD;
    return {
        handle: `$tmp:X${index}`,
        name: SECTIONS[index],
        x: 0,
        y: 0,
        width,
        height,
        groups,
        screens: specs.length,
    };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Flips                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------- */

/**
 * Points of a box, in the order top-left, top-right, bottom-right, bottom-left, mirrored on one axis.
 *
 * @param box - box in page space
 * @param axis - mirror axis, or undefined for none
 */
function boxPoints(box: FlipSpec["box"], axis?: "x" | "y"): KioskPoint[] {
    const { x, y, width: w, height: h } = box;
    const corners: KioskPoint[] = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
    ];
    if (axis === "x") {
        return [corners[1], corners[0], corners[3], corners[2]];
    }
    if (axis === "y") {
        return [corners[3], corners[2], corners[1], corners[0]];
    }
    return corners;
}

/**
 * What a reader should find in a flipped shape of the manifest.
 *
 * @param spec - the flip
 */
function expectedFlip(spec: FlipSpec): ManifestFlip["expected"] {
    const mirrored = boxPoints(spec.box, spec.axis);
    const mirror: Matrix =
        spec.mode === "identity"
            ? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
            : spec.axis === "x"
              ? { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }
              : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };
    return {
        flipX: spec.axis === "x",
        flipY: spec.axis === "y",
        transform: mirror,
        firstPoint: mirrored[0],
        points: mirrored,
    };
}

/**
 * Builds the raw change that writes a flip into a shape. `apply_operations` has no flip operation, and
 * `update_shape` with `flipX` sets the flag alone, so the build sends this through `apply_raw_changes`.
 *
 * @param spec - the flip
 * @param shapeId - real id of the shape
 * @param pageId - real id of the page
 * @returns a `mod-obj` change
 */
export function flipChange(spec: FlipSpec, shapeId: string, pageId: string): Record<string, unknown> {
    const expected = expectedFlip(spec);
    const value: Record<string, unknown> = {
        [spec.axis === "x" ? "flip-x" : "flip-y"]: true,
        points: expected.points,
    };
    if (spec.mode === "mirror") {
        value.transform = expected.transform;
        value["transform-inverse"] = expected.transform;
    }
    return { type: "mod-obj", id: shapeId, pageId, operations: [{ type: "assign", value }] };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Plan                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------- */

/**
 * Most shapes in one call. A call stays far below the limits of 2000 operations and 100000 changes. Large pages take
 * bigger calls, because the time of a write grows with the page and not with the call.
 */
function callShapes(size: KioskSizeName): number {
    // a call of about 2300 shapes on a page of 65000 took 55 s and tripped the adapter's backend timeout (see the
    // attempt on the cliff size), so the largest size takes the smallest calls of the large sizes
    if (size === "cliff") {
        return 600;
    }
    return size === "xl" ? 900 : 400;
}

/** Most operations in one call. The server takes 2000. */
function callOps(size: KioskSizeName): number {
    if (size === "cliff") {
        return 600;
    }
    return size === "xl" ? 900 : 600;
}

/**
 * Packs units of operations into calls. A unit never splits across calls, because its handles last one call only.
 *
 * @param stage - stage of the calls
 * @param label - label stem
 * @param units - units of operations and their shape counts
 */
function packCalls(
    size: KioskSizeName,
    stage: KioskCall["stage"],
    label: string,
    units: { ops: KioskOperation[]; shapes: number }[]
): KioskCall[] {
    const calls: KioskCall[] = [];
    let current: KioskCall | undefined;
    for (const unit of units) {
        if (
            current === undefined ||
            current.shapes + unit.shapes > callShapes(size) ||
            current.operations.length + unit.ops.length > callOps(size)
        ) {
            current = { stage, label: `${label} ${calls.length + 1}`, operations: [], shapes: 0 };
            calls.push(current);
        }
        current.operations.push(...unit.ops);
        current.shapes += unit.shapes;
    }
    return calls;
}

/**
 * Builds the whole plan for a size and a seed. It talks to no server and gives the same result for the same
 * arguments.
 *
 * @param size - size name
 * @param seed - seed of every random choice
 * @returns the calls, the raw flips and the manifest
 */
export function buildKioskPlan(size: KioskSizeName, seed: number): KioskPlan {
    const rng = new Rng(hashText(`kiosk:${size}:${seed}`));
    const components: Record<string, ComponentInfo> = {};

    // page "Components"
    const compRec = new Recorder(PAGE_COMPONENTS, "c", new Rng(hashText(`components:${seed}`)), components);
    defineComponents(compRec, components);
    const componentsCall: KioskCall = {
        stage: "components",
        label: "components",
        operations: compRec.ops,
        shapes: compRec.counts.shapes ?? 0,
    };

    // screens and sections
    const specs = buildScreenList(size);
    const statesPerStep = size === "12" ? 3 : 5;
    const counters = { group: 0, step: 0, state: 0, single: 0 };
    const bySection: ScreenSpec[][] = SECTIONS.map(() => []);
    for (const spec of specs) {
        bySection[spec.section].push(spec);
    }
    const sections = SECTIONS.map((_name, i) => layoutSection(i, bySection[i], statesPerStep, rng, counters));

    // grid: four columns, three rows
    const columns = 4;
    const colWidth: number[] = [];
    const rowHeight: number[] = [];
    sections.forEach((s, i) => {
        colWidth[i % columns] = Math.max(colWidth[i % columns] ?? 0, s.width);
        rowHeight[Math.floor(i / columns)] = Math.max(rowHeight[Math.floor(i / columns)] ?? 0, s.height);
    });
    sections.forEach((s, i) => {
        s.x = colWidth.slice(0, i % columns).reduce((a, w) => a + w + SECTION_GAP, 0);
        s.y = rowHeight.slice(0, Math.floor(i / columns)).reduce((a, h) => a + h + SECTION_GAP, 0);
    });

    // flips: spread over content screens that are not copies
    const flipPool = specs.filter((s) => s.kind === "content" && s.copyGroup === undefined);
    const totalFlips = 60 * Math.max(1, Math.round(KIOSK_SIZES[size].screens / 207));
    const groupFlips = totalFlips / 3;
    const flipAlloc = new Map<number, { ordinary: number; groups: number }>();
    for (let k = 0; k < totalFlips; k++) {
        const spec = flipPool[Math.floor((k * 7919) % flipPool.length)];
        const entry = flipAlloc.get(spec.index) ?? { ordinary: 0, groups: 0 };
        if (k < groupFlips) {
            entry.groups++;
        } else {
            entry.ordinary++;
        }
        flipAlloc.set(spec.index, entry);
    }

    // skeleton units
    const skeleton: { ops: KioskOperation[]; shapes: number }[] = [];
    const skelRec = new Recorder(PAGE_JOURNEYS, "k", rng, components);
    const nest = (
        id: string,
        parent: string | undefined,
        x: number,
        y: number,
        w: number,
        h: number,
        name: string,
        fill: Record<string, unknown>[]
    ): void => {
        skelRec.board(parent, x, y, w, h, name, { id, props: { fills: fill } });
    };

    const unitsScreens: { ops: KioskOperation[]; shapes: number }[] = [];
    const manifestScreens: ManifestScreen[] = [];
    const facts: ScreenFacts[] = [];
    const connectorUnits: { ops: KioskOperation[]; shapes: number }[] = [];
    const connectors: ManifestConnector[] = [];
    const decisionFrames: KioskManifest["decisionFrames"] = [];
    const flips: FlipSpec[] = [];
    const pageCounts: Counts = {};
    let connectorSeq = 0;
    let decisionSeq = 0;
    const screenById = new Map<string, ManifestScreen>();

    for (const sec of sections) {
        skelRec.ops.length = 0;
        nest(sec.handle, undefined, sec.x, sec.y, sec.width, sec.height, sec.name, solid("#F9FAFB"));
        for (const g of sec.groups) {
            nest(g.handle, sec.handle, sec.x + g.x, sec.y + g.y, g.width, g.height, g.name, []);
            for (const st of g.steps) {
                const stepX = sec.x + g.x + st.x;
                const stepY = sec.y + g.y + st.y;
                nest(st.handle, g.handle, stepX, stepY, st.width, st.height, st.name, []);
                for (const state of st.states) {
                    const sx = stepX + state.x;
                    const sy = stepY + state.y;
                    nest(state.handle, st.handle, sx, sy, 800, STATE_H, "State", []);
                    if (state.single !== undefined) {
                        nest(state.single, state.handle, sx, sy, 800, STATE_H, "Single", []);
                    }
                }
            }
        }
        // a nesting frame may sit in another call than its parent: the build resolves handles of earlier calls
        skeleton.push(...skelRec.ops.map((o) => ({ ops: [o], shapes: 1 })));
    }
    addCounts(pageCounts, skelRec.counts);
    // the recorder counted every nesting frame already (counts are cumulative)

    for (const sec of sections) {
        for (const g of sec.groups) {
            for (const st of g.steps) {
                const stepX = sec.x + g.x + st.x;
                const stepY = sec.y + g.y + st.y;
                for (const state of st.states) {
                    const spec = state.spec;
                    const origin = { x: stepX + state.x, y: stepY + state.y };
                    const holder = state.single ?? state.handle;
                    const alloc = flipAlloc.get(spec.index) ?? { ordinary: 0, groups: 0 };
                    const unit = drawScreen(spec, origin, holder, alloc, seed, components, size === "12" ? 1.15 : 1);
                    unitsScreens.push({ ops: unit.ops, shapes: unit.counts.shapes ?? 0 });
                    addCounts(pageCounts, unit.counts);
                    facts.push(unit.facts);
                    flips.push(...unit.facts.flips);
                    const entry: ManifestScreen = {
                        handle: `$tmp:P${spec.index}`,
                        name: "Parent",
                        humanName: spec.humanName,
                        view: spec.view,
                        kind: spec.kind,
                        section: sec.handle,
                        sectionName: sec.name,
                        journey: g.handle,
                        step: st.handle,
                        state: state.handle,
                        depth: state.single !== undefined ? 6 : 5,
                        x: origin.x,
                        y: origin.y,
                        width: 800,
                        height: 600,
                        shapes: unit.shapes,
                        label: unit.label,
                    };
                    if (spec.structure !== undefined) {
                        entry.structure = spec.structure;
                    }
                    if (spec.copyGroup !== undefined) {
                        entry.copyGroup = spec.copyGroup;
                    }
                    if (state.single !== undefined) {
                        entry.single = state.single;
                    }
                    manifestScreens.push(entry);
                    screenById.set(entry.handle, entry);
                }
            }
        }
    }

    // connectors: between neighbours in a step, and between steps of a group
    const styleOrder = (n: number): ArrowStyle | "open-straight" | "open-curved" => {
        const cycle: (ArrowStyle | "open-straight" | "open-curved")[] = [
            "triangle",
            "barbs",
            "dot-triangle",
            "curved",
            "open-straight",
            "triangle",
            "curved",
            "barbs",
            "dot-triangle",
            "triangle",
            "barbs",
            "curved",
            "triangle",
            "dot-triangle",
            "barbs",
            "curved",
            "triangle",
            "open-curved",
            "barbs",
            "dot-triangle",
            "triangle",
            "curved",
            "barbs",
            "triangle",
        ];
        return cycle[n % cycle.length];
    };
    const connRec = new Recorder(PAGE_JOURNEYS, "a", rng, components);
    const drawArrow = (
        container: string,
        tail: KioskPoint,
        head: KioskPoint,
        from: { screen?: string; decision?: string },
        to: { screen?: string; decision?: string }
    ): void => {
        const style = styleOrder(connectorSeq);
        const id = `$tmp:A${connectorSeq++}`;
        let kind: ManifestConnector["kind"] = "filled-outline";
        if (style === "open-straight" || style === "open-curved") {
            kind = "open-stroked";
            const p = openArrowPath(tail, head, style === "open-curved");
            connRec.path(
                container,
                p.d,
                p.box,
                "Navigation",
                {
                    fills: [],
                    strokes: [{ strokeColor: COLOR.ink, strokeWidth: 3, strokeCapEnd: "triangle-arrow" }],
                },
                id
            );
        } else {
            const p = arrowOutline(style, tail, head);
            connRec.path(container, p.d, p.box, "Navigation", { fills: solid(COLOR.ink), strokes: [] }, id);
        }
        const dx = head.x - tail.x;
        const dy = head.y - tail.y;
        const direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        connectors.push({
            shape: id,
            kind,
            style,
            fromScreen: from.screen ?? null,
            toScreen: to.screen ?? null,
            fromDecision: from.decision ?? null,
            toDecision: to.decision ?? null,
            endsOnDecision: to.decision !== undefined,
            direction,
            tail,
            head,
            container,
        });
    };
    for (const sec of sections) {
        for (const g of sec.groups) {
            const gx = sec.x + g.x;
            const gy = sec.y + g.y;
            g.steps.forEach((st, si) => {
                const stepX = gx + st.x;
                const stepY = gy + st.y;
                connRec.ops.length = 0;
                st.states.slice(1).forEach((right, i) => {
                    const left = st.states[i];
                    const gap = st.gaps[i];
                    const ay = stepY + st.states[0].y + 300;
                    const leftEdge = stepX + left.x + 800;
                    const rightEdge = stepX + right.x;
                    const a = `$tmp:P${left.spec.index}`;
                    const b = `$tmp:P${right.spec.index}`;
                    if (!gap.decision && !rng.chance(0.85)) {
                        return;
                    }
                    if (gap.decision) {
                        const dId = `$tmp:D${decisionSeq++}`;
                        const text = DECISION_TEXTS[(decisionSeq - 1) % DECISION_TEXTS.length];
                        const dx = leftEdge + (gap.gap - SIZE.decision.w) / 2;
                        connRec.ox = 0;
                        connRec.oy = 0;
                        connRec.inst("decision", st.handle, dx, ay - 50, [{ name: "Question", characters: text }], dId);
                        decisionFrames.push({
                            shape: dId,
                            text,
                            section: sec.handle,
                            between: [a, b],
                            x: dx,
                            y: ay - 50,
                            width: SIZE.decision.w,
                            height: SIZE.decision.h,
                        });
                        const dl = dx;
                        const dr = dx + SIZE.decision.w;
                        if (!gap.reversed) {
                            drawArrow(
                                st.handle,
                                { x: leftEdge + 20, y: ay },
                                { x: dl - 20, y: ay },
                                { screen: a },
                                { decision: dId }
                            );
                            drawArrow(
                                st.handle,
                                { x: dr + 20, y: ay },
                                { x: rightEdge - 20, y: ay },
                                { decision: dId },
                                { screen: b }
                            );
                        } else {
                            drawArrow(
                                st.handle,
                                { x: rightEdge - 20, y: ay },
                                { x: dr + 20, y: ay },
                                { screen: b },
                                { decision: dId }
                            );
                            drawArrow(
                                st.handle,
                                { x: dl - 20, y: ay },
                                { x: leftEdge + 20, y: ay },
                                { decision: dId },
                                { screen: a }
                            );
                        }
                        return;
                    }
                    if (!gap.reversed) {
                        drawArrow(
                            st.handle,
                            { x: leftEdge + 20, y: ay },
                            { x: rightEdge - 20, y: ay },
                            { screen: a },
                            { screen: b }
                        );
                    } else {
                        drawArrow(
                            st.handle,
                            { x: rightEdge - 20, y: ay },
                            { x: leftEdge + 20, y: ay },
                            { screen: b },
                            { screen: a }
                        );
                    }
                });
                if (connRec.ops.length > 0) {
                    connectorUnits.push({ ops: [...connRec.ops], shapes: connRec.ops.length * 2 });
                }
                // vertical arrows to the step below
                const below = g.steps[si + 1];
                if (below !== undefined) {
                    connRec.ops.length = 0;
                    st.states.forEach((upper, i) => {
                        const lower = below.states[i];
                        if (lower === undefined || !rng.chance(0.5)) {
                            return;
                        }
                        // columns can drift apart when a gap above holds a decision frame: keep to the overlap
                        const upperLeft = stepX + upper.x;
                        const lowerLeft = gx + below.x + lower.x;
                        const overlapRight = Math.min(upperLeft, lowerLeft) + 800;
                        if (overlapRight - Math.max(upperLeft, lowerLeft) < 120) {
                            return;
                        }
                        const x = overlapRight - 60;
                        const top = stepY + upper.y + 600 + 20;
                        const bottom = gy + below.y + lower.y - 20;
                        const a = `$tmp:P${upper.spec.index}`;
                        const b = `$tmp:P${lower.spec.index}`;
                        if (rng.chance(0.3)) {
                            drawArrow(g.handle, { x, y: bottom }, { x, y: top }, { screen: b }, { screen: a });
                        } else {
                            drawArrow(g.handle, { x, y: top }, { x, y: bottom }, { screen: a }, { screen: b });
                        }
                    });
                    if (connRec.ops.length > 0) {
                        connectorUnits.push({ ops: [...connRec.ops], shapes: connRec.ops.length * 2 });
                    }
                }
            });
        }
    }
    addCounts(pageCounts, connRec.counts);

    // calls
    const calls: KioskCall[] = [
        componentsCall,
        ...packCalls(size, "skeleton", "frames", skeleton),
        ...packCalls(size, "screens", "screens", unitsScreens),
        ...packCalls(size, "connectors", "connectors", connectorUnits),
    ];

    // manifest
    const manifest = assembleManifest({
        size,
        seed,
        components,
        sections,
        screens: manifestScreens,
        facts,
        connectors,
        decisionFrames,
        flips,
        pageCounts,
        componentCounts: compRec.counts,
        specs,
    });
    return { size, seed, calls, flips, manifest };
}

/** Inputs of {@link assembleManifest}. */
interface ManifestInput {
    size: KioskSizeName;
    seed: number;
    components: Record<string, ComponentInfo>;
    sections: LaidSection[];
    screens: ManifestScreen[];
    facts: ScreenFacts[];
    connectors: ManifestConnector[];
    decisionFrames: KioskManifest["decisionFrames"];
    flips: FlipSpec[];
    pageCounts: Counts;
    componentCounts: Counts;
    specs: ScreenSpec[];
}

/**
 * Puts the manifest together from what the plan drew.
 *
 * @param input - everything the plan drew
 */
function assembleManifest(input: ManifestInput): KioskManifest {
    const { pageCounts } = input;
    const byView = new Map<ViewKey, ManifestScreen[]>();
    for (const s of input.screens) {
        byView.set(s.view, [...(byView.get(s.view) ?? []), s]);
    }
    const views = (Object.keys(VIEW_NAMES) as ViewKey[]).map((key) => ({
        key,
        humanName: VIEW_NAMES[key],
        screens: byView.get(key)?.length ?? 0,
        shapesPerScreen: [...new Set((byView.get(key) ?? []).map((s) => s.shapes))].sort((a, b) => a - b),
    }));
    const copyMap = new Map<string, ManifestScreen[]>();
    for (const s of input.screens) {
        if (s.copyGroup !== undefined) {
            copyMap.set(s.copyGroup, [...(copyMap.get(s.copyGroup) ?? []), s]);
        }
    }
    const copyGroups = [...copyMap.entries()].map(([key, list]) => ({
        key,
        view: list[0].view,
        screens: list.map((s) => s.handle),
    }));
    const frameSizes = Object.entries(pageCounts)
        .filter(([k]) => k.startsWith("frame:"))
        .map(([k, v]) => ({ size: k.slice(6), count: v }))
        .sort((a, b) => b.count - a.count || (a.size < b.size ? -1 : 1));
    const shapeTypes: Counts = {};
    const features: Counts = {};
    for (const [k, v] of Object.entries(pageCounts)) {
        if (k.startsWith("type:")) {
            shapeTypes[k.slice(5)] = v;
        } else if (k.startsWith("feature:")) {
            features[k.slice(8)] = v;
        }
    }
    const flipRecord = (spec: FlipSpec): ManifestFlip => ({
        shape: spec.shape,
        screen: spec.screen,
        axis: spec.axis,
        expected: expectedFlip(spec),
        ...(spec.kind === "group" ? { faultReproduced: null } : {}),
    });
    const fontTexts = input.facts.flatMap((f) => f.fontTexts);
    const scrollCandidates = input.facts.flatMap((f, i) =>
        f.scroll.map((s) => ({
            frame: s.frame,
            screen: input.screens[i].handle,
            axis: "vertical" as const,
            frameHeight: s.frameHeight,
            contentHeight: s.contentHeight,
            overflowPx: s.overflowPx,
            rows: s.rows,
            rowsBelowEdge: s.rowsBelowEdge,
            scrollBar: s.scrollBar,
            overflowScrollSet: false,
        }))
    );
    const dividerShapes = input.facts.flatMap((f) => f.dividers);
    const blank = input.screens.filter((s) => s.kind === "blank" || s.kind === "empty");
    const totalShapes = pageCounts.shapes ?? 0;
    return {
        schemaVersion: 1,
        planVersion: KIOSK_PLAN_VERSION,
        size: input.size,
        seed: input.seed,
        pages: { components: "Components", journeys: "Journeys" },
        totals: {
            journeysShapes: totalShapes,
            componentsShapes: input.componentCounts.shapes ?? 0,
            screens: input.screens.length,
            sections: input.sections.length,
            blankScreens: blank.length,
            headerOnlyScreens: input.screens.filter((s) => s.kind === "blank").length,
            emptyScreens: input.screens.filter((s) => s.kind === "empty").length,
            instanceOnlyScreens: input.screens.filter((s) => s.kind === "instance-only").length,
            singleScreens: input.screens.filter((s) => s.single !== undefined).length,
            decisionFrames: input.decisionFrames.length,
            connectors: input.connectors.length,
            flippedShapes: input.flips.length,
        },
        components: Object.entries(input.components).map(([key, c]) => ({
            key,
            name: c.name,
            handle: c.handle,
            shapes: c.counts.shapes ?? 0,
            width: c.width,
            height: c.height,
        })),
        views,
        sections: input.sections.map((s) => ({
            handle: s.handle,
            name: s.name,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            screens: s.screens,
        })),
        screens: input.screens,
        copyGroups,
        blankScreens: input.screens
            .filter((s) => s.kind === "blank")
            .map((s) => ({ screen: s.handle, structure: s.structure as ScreenStructure })),
        emptyScreens: input.screens.filter((s) => s.kind === "empty").map((s) => s.handle),
        instanceOnlyScreens: input.screens
            .filter((s) => s.kind === "instance-only")
            .map((s) => ({ screen: s.handle, structure: s.structure as ScreenStructure })),
        decisionFrames: input.decisionFrames,
        connectors: input.connectors,
        noise: {
            dividerLines: { count: dividerShapes.length, shapes: dividerShapes },
            chevronIcons: { count: pageCounts["feature:chevron"] ?? 0 },
        },
        flips: {
            total: input.flips.length,
            ordinary: input.flips.filter((f) => f.kind === "rect").map(flipRecord),
            groups: input.flips.filter((f) => f.kind === "group").map(flipRecord),
            route: "apply_raw_changes, mod-obj assign",
        },
        scrollCandidates,
        offBoardControls: input.facts.flatMap((f, i) =>
            f.offBoard.map((o) => ({
                shape: o.shape,
                screen: input.screens[i].handle,
                edge: "right" as const,
                overhangPx: o.overhangPx,
            }))
        ),
        clippedControls: input.facts.flatMap((f, i) =>
            f.clipped.map((c) => ({ ...c, screen: input.screens[i].handle }))
        ),
        fonts: {
            unresolved:
                fontTexts.length === 0
                    ? []
                    : [
                          {
                              fontId: "gfont-access-sans",
                              family: "Access Sans",
                              weight: 700,
                              texts: fontTexts,
                              runs: fontTexts.length,
                          },
                      ],
        },
        shapeTypes: sortedCounts(shapeTypes),
        frameSizes,
        features: sortedCounts(features),
        notes: [
            "Blank and boot screens differ from each other by their title text, so only the listed copy groups are exact copies.",
            "Flipped groups keep their children unmirrored. Only the group's own points and flipX change.",
            "A screen's shape count includes the Parent frame and every shape inside instances.",
        ],
    };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Helpers for the build script                                                                                    */
/* ------------------------------------------------------------------------------------------------------------- */

/**
 * Replaces every string equal to a known handle, deep in a value, with its id. Strings that are not keys of the table
 * stay as they are, so a handle created in the same call keeps its name for the server to resolve.
 *
 * @param value - operations or any JSON value
 * @param ids - table from handle to id
 * @returns a copy with the handles replaced
 */
export function resolveHandles<T>(value: T, ids: ReadonlyMap<string, string>): T {
    if (typeof value === "string") {
        return (ids.get(value) ?? value) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveHandles(item, ids)) as T;
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = resolveHandles(v, ids);
        }
        return out as T;
    }
    return value;
}

/**
 * Tells whether a failed write may be sent again with the same request id: the file was busy, or a lock timed out.
 *
 * @param text - error text of the failed call
 */
export function isRetryableWriteError(text: string): boolean {
    return /mcp-file-busy|mcp-lock-timeout/.test(text);
}

/**
 * Tells whether a refusal came from the rate limit, and so may be sent again after a pause.
 *
 * @param text - error text of the failed call
 */
export function isRateLimitError(text: string): boolean {
    return /rate.?limit|too many requests|retry after/i.test(text);
}

/** The arrow styles that the filled connectors cycle through. */
export const KIOSK_ARROW_STYLES = ARROW_STYLES;
