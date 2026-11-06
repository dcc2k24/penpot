/**
 * One row of the property table: how a Plugin API shape property maps to a backend attribute.
 */
export interface PropertyEntry {
    /**
     * Camel-case backend attribute key, or a dotted path into a nested map such as `layoutItemMargin.m1`.
     */
    attr: string;
    /** Whether the sandbox can read the property, write it, or both. */
    access: "read" | "write" | "read-write";
    /** True when the stored boolean is the negation of the Plugin API value (for example `hidden` for `visible`). */
    invert?: boolean;
    /**
     * How the sandbox writes the value: `attr` is a plain `update_shape` prop, `geometry` goes through the
     * geometry path, `derived` is computed from other attributes, `content` lives inside the text content
     * tree, and `unsupported` has no direct mapping.
     */
    kind: "attr" | "geometry" | "derived" | "content" | "unsupported";
}

/**
 * Mapping between Plugin API shape names and backend shape attributes.
 *
 * This class is the one home of the mapping. The sandbox prelude reads the tables through
 * `toJsonTable`, and the operation layer writes the attributes it names. Text fills live in the text
 * content tree, so the `fills` entry covers shapes other than text.
 */
export class PropertyMap {
    /** Backend shape type names mapped to Plugin API type names. */
    public static readonly TYPES: Readonly<Record<string, string>> = {
        frame: "board",
        rect: "rectangle",
        circle: "ellipse",
        text: "text",
        path: "path",
        bool: "boolean",
        group: "group",
        image: "image",
        "svg-raw": "svg-raw",
    };

    /** Plugin API shape property names mapped to their backend attribute and write rule. */
    public static readonly PROPERTIES: Readonly<Record<string, PropertyEntry>> = {
        // shape base properties.
        id: { attr: "id", access: "read", kind: "attr" },
        type: { attr: "type", access: "read", kind: "attr" },
        name: { attr: "name", access: "read-write", kind: "attr" },
        parent: { attr: "parentId", access: "read", kind: "derived" },
        parentIndex: { attr: "parentId", access: "read", kind: "derived" },

        x: { attr: "x", access: "read-write", kind: "geometry" },
        y: { attr: "y", access: "read-write", kind: "geometry" },
        width: { attr: "width", access: "read-write", kind: "geometry" },
        height: { attr: "height", access: "read-write", kind: "geometry" },
        rotation: { attr: "rotation", access: "read-write", kind: "geometry" },
        flipX: { attr: "flipX", access: "read-write", kind: "geometry" },
        flipY: { attr: "flipY", access: "read-write", kind: "geometry" },

        bounds: { attr: "selrect", access: "read", kind: "derived" },
        center: { attr: "selrect", access: "read", kind: "derived" },
        parentX: { attr: "selrect", access: "read", kind: "derived" },
        parentY: { attr: "selrect", access: "read", kind: "derived" },
        boardX: { attr: "selrect", access: "read", kind: "derived" },
        boardY: { attr: "selrect", access: "read", kind: "derived" },

        blocked: { attr: "blocked", access: "read-write", kind: "attr" },
        hidden: { attr: "hidden", access: "read-write", kind: "attr" },
        visible: { attr: "hidden", access: "read-write", kind: "attr", invert: true },
        proportionLock: { attr: "proportionLock", access: "read-write", kind: "attr" },
        constraintsHorizontal: { attr: "constraintsH", access: "read-write", kind: "attr" },
        constraintsVertical: { attr: "constraintsV", access: "read-write", kind: "attr" },
        fixedWhenScrolling: { attr: "fixedScroll", access: "read-write", kind: "attr" },

        // All four corners share the backend keys r1 to r4. A write to borderRadius sets every corner.
        borderRadius: { attr: "r1", access: "read-write", kind: "attr" },
        borderRadiusTopLeft: { attr: "r1", access: "read-write", kind: "attr" },
        borderRadiusTopRight: { attr: "r2", access: "read-write", kind: "attr" },
        borderRadiusBottomRight: { attr: "r3", access: "read-write", kind: "attr" },
        borderRadiusBottomLeft: { attr: "r4", access: "read-write", kind: "attr" },

        opacity: { attr: "opacity", access: "read-write", kind: "attr" },
        blendMode: { attr: "blendMode", access: "read-write", kind: "attr" },
        shadows: { attr: "shadow", access: "read-write", kind: "attr" },
        blur: { attr: "blur", access: "read-write", kind: "attr" },
        backgroundBlur: { attr: "backgroundBlur", access: "read-write", kind: "attr" },
        exports: { attr: "exports", access: "read-write", kind: "attr" },
        fills: { attr: "fills", access: "read-write", kind: "attr" },
        strokes: { attr: "strokes", access: "read-write", kind: "attr" },
        interactions: { attr: "interactions", access: "read", kind: "derived" },
        tokens: { attr: "appliedTokens", access: "read", kind: "derived" },

        // board and group properties.
        clipContent: { attr: "showContent", access: "read-write", kind: "attr", invert: true },
        showInViewMode: { attr: "hideInViewer", access: "read-write", kind: "attr", invert: true },
        guides: { attr: "grids", access: "read-write", kind: "attr" },
        children: { attr: "shapes", access: "read", kind: "derived" },
        flex: { attr: "layout", access: "read", kind: "derived" },
        grid: { attr: "layout", access: "read", kind: "derived" },

        // layout child properties, stored as shape attributes on the child.
        absolute: { attr: "layoutItemAbsolute", access: "read-write", kind: "attr" },
        zIndex: { attr: "layoutItemZIndex", access: "read-write", kind: "attr" },
        horizontalSizing: { attr: "layoutItemHSizing", access: "read-write", kind: "attr" },
        verticalSizing: { attr: "layoutItemVSizing", access: "read-write", kind: "attr" },
        alignSelf: { attr: "layoutItemAlignSelf", access: "read-write", kind: "attr" },
        // the layout child object, shape.layoutChild, sets the vertical and horizontal margins as pairs of sides.
        layoutChild: { attr: "layoutItemAbsolute", access: "read", kind: "derived" },
        verticalMargin: { attr: "layoutItemMargin.m1", access: "read", kind: "unsupported" },
        horizontalMargin: { attr: "layoutItemMargin.m2", access: "read", kind: "unsupported" },
        topMargin: { attr: "layoutItemMargin.m1", access: "read-write", kind: "attr" },
        rightMargin: { attr: "layoutItemMargin.m2", access: "read-write", kind: "attr" },
        bottomMargin: { attr: "layoutItemMargin.m3", access: "read-write", kind: "attr" },
        leftMargin: { attr: "layoutItemMargin.m4", access: "read-write", kind: "attr" },
        marginType: { attr: "layoutItemMarginType", access: "read-write", kind: "attr" },
        maxWidth: { attr: "layoutItemMaxW", access: "read-write", kind: "attr" },
        minWidth: { attr: "layoutItemMinW", access: "read-write", kind: "attr" },
        maxHeight: { attr: "layoutItemMaxH", access: "read-write", kind: "attr" },
        minHeight: { attr: "layoutItemMinH", access: "read-write", kind: "attr" },

        // layout cell properties. The cell lives in the parent grid's layout-grid-cells map, which shape.layoutCell reads.
        layoutCell: { attr: "layoutGridCells", access: "read", kind: "derived" },
        row: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },
        rowSpan: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },
        column: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },
        columnSpan: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },
        areaName: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },
        position: { attr: "layoutGridCells", access: "read-write", kind: "unsupported" },

        // path and boolean properties.
        content: { attr: "content", access: "read-write", kind: "attr" },
        d: { attr: "content", access: "read", kind: "derived" },
        commands: { attr: "content", access: "read", kind: "derived" },

        // image properties.
        mtype: { attr: "metadata.mtype", access: "read", kind: "derived" },
        keepAspectRatio: { attr: "keepAspectRatio", access: "read", kind: "unsupported" },

        // text properties. The typography values live in the text content tree, not on the shape.
        characters: { attr: "characters", access: "read-write", kind: "content" },
        growType: { attr: "growType", access: "read-write", kind: "attr" },
        fontId: { attr: "fontId", access: "read-write", kind: "content" },
        fontFamily: { attr: "fontFamily", access: "read-write", kind: "content" },
        fontVariantId: { attr: "fontVariantId", access: "read-write", kind: "content" },
        fontSize: { attr: "fontSize", access: "read-write", kind: "content" },
        fontWeight: { attr: "fontWeight", access: "read-write", kind: "content" },
        fontStyle: { attr: "fontStyle", access: "read-write", kind: "content" },
        lineHeight: { attr: "lineHeight", access: "read-write", kind: "content" },
        letterSpacing: { attr: "letterSpacing", access: "read-write", kind: "content" },
        textTransform: { attr: "textTransform", access: "read-write", kind: "content" },
        textDecoration: { attr: "textDecoration", access: "read-write", kind: "content" },
        direction: { attr: "textDirection", access: "read-write", kind: "content" },
        align: { attr: "textAlign", access: "read-write", kind: "content" },
        verticalAlign: { attr: "verticalAlign", access: "read-write", kind: "content" },
        textBounds: { attr: "positionData", access: "read", kind: "derived" },
    };

    /**
     * Returns the Plugin API type name for a backend shape type.
     *
     * Throws an `Error` that names the type when the backend type is unknown.
     */
    public static pluginTypeOf(backendType: string): string {
        if (!Object.prototype.hasOwnProperty.call(PropertyMap.TYPES, backendType)) {
            throw new Error(`Unknown backend shape type "${backendType}".`);
        }
        return PropertyMap.TYPES[backendType];
    }

    /**
     * Returns the backend shape type for a Plugin API type name.
     *
     * Throws an `Error` that names the type when the Plugin API type is unknown.
     */
    public static backendTypeOf(pluginType: string): string {
        for (const [backendType, mappedPluginType] of Object.entries(PropertyMap.TYPES)) {
            if (mappedPluginType === pluginType) {
                return backendType;
            }
        }
        throw new Error(`Unknown Plugin API shape type "${pluginType}".`);
    }

    /**
     * Returns a fresh JSON-ready copy of the type and property tables.
     *
     * The sandbox prelude serialises this result. Mutating the returned object never changes the
     * static tables.
     */
    public static toJsonTable(): {
        types: Record<string, string>;
        properties: Record<string, PropertyEntry>;
    } {
        const types: Record<string, string> = {};
        for (const [backendType, pluginType] of Object.entries(PropertyMap.TYPES)) {
            types[backendType] = pluginType;
        }

        // copy each entry so that callers cannot reach the static rows
        const properties: Record<string, PropertyEntry> = {};
        for (const [name, entry] of Object.entries(PropertyMap.PROPERTIES)) {
            properties[name] = { ...entry };
        }

        return { types, properties };
    }
}
