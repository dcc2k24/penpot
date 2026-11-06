/**
 * Normalised model of a Penpot file. This is the shape that design.json holds.
 *
 * The format version is 1. The root frame of a page is never part of the model. The boards of a page are its
 * top-level shapes, and their `parentId` is null.
 */

/** Normalised model of one pull of a file. */
export interface DesignModel {
    /** Format version of design.json. Always 1. */
    readonly formatVersion: 1;
    /** The file that was pulled. */
    readonly file: {
        /** Id of the file. */
        readonly id: string;
        /** Name of the file. */
        readonly name: string;
        /** Revision number of the file, or null when the backend gave none. */
        readonly revn: number | null;
        /** Id of the project that holds the file, or null when the backend gave none. */
        readonly projectId: string | null;
    };
    /** Time of the pull, as an ISO 8601 string. */
    readonly pulledAt: string;
    /** Pages in the order of the file outline. */
    readonly pages: PageModel[];
    /** Components of the file library that are not deleted. */
    readonly components: ComponentModel[];
    /** Text styles of the file library. */
    readonly typographies: TypographyModel[];
    /** Token sets, themes and tokens of the file. */
    readonly tokens: TokensModel;
}

/** One page of the file. */
export interface PageModel {
    /** Id of the page. */
    readonly id: string;
    /** Name of the page. */
    readonly name: string;
    /** Position of the page in the file. */
    readonly index: number;
    /** Top-level shapes of the page, in list order. */
    readonly boards: NodeModel[];
}

/** One main component of the file library. */
export interface ComponentModel {
    /** Id of the component. */
    readonly id: string;
    /** Name of the component, without its path. */
    readonly name: string;
    /** Path of the component, for example "Button / Primary". Empty for a top-level component. */
    readonly path: string;
    /** Normalised full name, for example "Button/Primary/MD". */
    readonly fullName: string;
    /** Id of the main instance of the component. */
    readonly mainInstanceId: string;
    /** Id of the page that holds the main instance. */
    readonly mainInstancePageId: string;
}

/** One text style of the file library. */
export interface TypographyModel {
    /** Id of the text style. */
    readonly id: string;
    /** Name of the text style. */
    readonly name: string;
    /** Font family, or null when missing. */
    readonly fontFamily: string | null;
    /** Font size as a number, or null when missing. */
    readonly fontSize: number | null;
    /** Font weight as Penpot stores it, or null when missing. */
    readonly fontWeight: string | null;
    /** Line height as a number, or null when missing. */
    readonly lineHeight: number | null;
    /** Letter spacing as a number, or null when missing. */
    readonly letterSpacing: number | null;
    /** Text transform, or null when missing. */
    readonly textTransform: string | null;
}

/** Token sets, themes and tokens of the file. */
export interface TokensModel {
    /** Token sets of the file. */
    readonly sets: TokenSetModel[];
    /** Themes of the file. */
    readonly themes: TokenThemeModel[];
    /** Tokens of every set. */
    readonly tokens: TokenModel[];
    /** Names of the active themes. */
    readonly activeThemes: string[];
    /** Names of the active sets. */
    readonly activeSets: string[];
}

/** One token set. */
export interface TokenSetModel {
    /** Id of the set. */
    readonly id: string;
    /** Name of the set. */
    readonly name: string;
    /** True when the set is active. */
    readonly active: boolean;
}

/** One token theme. */
export interface TokenThemeModel {
    /** Id of the theme. */
    readonly id: string;
    /** Group of the theme, for example "mode". */
    readonly group: string;
    /** Name of the theme. */
    readonly name: string;
    /** Names of the sets that the theme uses. */
    readonly sets: string[];
    /** True when the theme is active. */
    readonly active: boolean;
}

/** One design token. */
export interface TokenModel {
    /** Name of the set that holds the token. */
    readonly setName: string;
    /** Name of the token. */
    readonly name: string;
    /** Type of the token, for example "color". */
    readonly type: string;
    /** Value of the token as a string. */
    readonly value: string;
}

/** Type of a node in the model. Types that the model does not name become "other". */
export type NodeType =
    "board" | "rect" | "ellipse" | "text" | "group" | "bool" | "path" | "image" | "svg-raw" | "other";

/** One node of a page, with its children. Geometry is in absolute page coordinates. */
export interface NodeModel {
    /** Id of the node. */
    readonly id: string;
    /** Name of the node. */
    readonly name: string;
    /** Type of the node. */
    readonly type: NodeType;
    /** Id of the parent node, or null for a top-level node. */
    readonly parentId: string | null;
    /** Absolute x position on the page. */
    readonly x: number;
    /** Absolute y position on the page. */
    readonly y: number;
    /** Width of the node. */
    readonly width: number;
    /** Height of the node. */
    readonly height: number;
    /** Rotation in degrees, or null when missing. */
    readonly rotation: number | null;
    /** Hidden flag as the node stores it, or null when missing. */
    readonly hidden: boolean | null;
    /** Opacity of the node, or null when missing. */
    readonly opacity: number | null;
    /** Fills of the node, in list order. Empty when the node has none. */
    readonly fills: FillModel[];
    /** Strokes of the node, in list order. Empty when the node has none. */
    readonly strokes: StrokeModel[];
    /** Corner radii in the order r1, r2, r3, r4, or null when the node has no radius. */
    readonly radius: [number, number, number, number] | null;
    /** Auto layout of the node, or null when the node has no auto layout. */
    readonly layout: LayoutModel | null;
    /** Sizing of the node inside an auto layout parent, or null when the backend gave none. */
    readonly layoutItem: LayoutItemModel | null;
    /** Text of the node, or null when the node is not a text. */
    readonly text: TextModel | null;
    /** Component reference of the node, or null when the node is not a component copy. */
    readonly component: ComponentRefModel | null;
    /** Children of the node, in list order. */
    readonly children: NodeModel[];
}

/** One fill of a node. */
export interface FillModel {
    /** Colour of the fill as "#RRGGBB" in upper case. */
    readonly hex: string;
    /** Opacity of the fill, or null when missing. */
    readonly opacity: number | null;
}

/** One stroke of a node. */
export interface StrokeModel {
    /** Colour of the stroke as "#RRGGBB" in upper case. */
    readonly hex: string;
    /** Opacity of the stroke, or null when missing. */
    readonly opacity: number | null;
    /** Width of the stroke, or null when missing. */
    readonly width: number | null;
    /** Where the stroke sits on the edge of the shape, or null when the backend gives none. Null means centred. */
    readonly alignment: "inner" | "center" | "outer" | null;
}

/** Auto layout of a board. */
export interface LayoutModel {
    /** Direction of the layout, "row" or "column", or null when missing. */
    readonly dir: string | null;
    /** Gaps between the children. */
    readonly gap: {
        /** Gap between rows, or null when missing. */
        readonly row: number | null;
        /** Gap between columns, or null when missing. */
        readonly column: number | null;
    };
    /** Padding in the order p1, p2, p3, p4, or null when the layout has none. */
    readonly padding: [number, number, number, number] | null;
    /** Alignment of the children across the layout, or null when missing. */
    readonly alignItems: string | null;
    /** Alignment of the children along the layout, or null when missing. */
    readonly justifyContent: string | null;
    /** Wrap mode of the layout, or null when missing. */
    readonly wrap: string | null;
}

/** Sizing of a node inside an auto layout parent. */
export interface LayoutItemModel {
    /** Horizontal sizing, or null when missing. */
    readonly hSizing: string | null;
    /** Vertical sizing, or null when missing. */
    readonly vSizing: string | null;
}

/** Text of a text node, read from its first text run. */
export interface TextModel {
    /** Characters of the text node. */
    readonly characters: string;
    /** Font family of the first run, or null when missing. */
    readonly fontFamily: string | null;
    /** Font size of the first run, or null when missing. */
    readonly fontSize: number | null;
    /** Font weight of the first run as a string, or null when missing. */
    readonly fontWeight: string | null;
    /** Line height of the first run, or null when missing. */
    readonly lineHeight: number | null;
    /** Letter spacing of the first run, or null when missing. */
    readonly letterSpacing: number | null;
    /** Horizontal alignment, from the first paragraph that has one, else from the text run, or null when missing. */
    readonly textAlign: string | null;
    /** Vertical alignment of the text box, from the content root, or null when missing. */
    readonly verticalAlign: string | null;
    /** Colour of the first fill of the first run as "#RRGGBB", or null when missing. */
    readonly fill: string | null;
    /** Font style of the first run, "normal" or "italic", or null when missing. Absent fields count as null. */
    readonly fontStyle?: string | null;
    /**
     * Line height of the first paragraph that states one, or null when no paragraph does. The run line height can
     * differ from it. Absent fields count as null.
     */
    readonly paragraphLineHeight?: number | null;
    /**
     * Grow type of the text shape, for example "fixed" or "auto-width", or null when missing. Absent counts as null.
     */
    readonly growType?: string | null;
}

/** Reference from a node to the library component it copies. */
export interface ComponentRefModel {
    /** Id of the library component. */
    readonly componentId: string;
    /** True when the node is the main instance of the component. */
    readonly mainInstance: boolean;
    /** True when the node is the root of a component. */
    readonly componentRoot: boolean;
}
