import { z } from "zod";
import { BackendIds } from "../BackendIds";

/**
 * One operation in the `apply_operations` vocabulary: an object with an `op` name and camelCase
 * parameters. Shape ids may be UUIDs or `$tmp:name` handles created earlier in the same call.
 *
 * The shapes mirror `schema:operation` in `common/src/app/common/mcp/operations.cljc`, the source of truth.
 */
type OperationShape = z.ZodRawShape;

/**
 * Reference to an existing id, or to a `$tmp:name` handle created earlier in the same call.
 * The compiler takes a UUID or any string of at least six characters.
 */
const ref = z.string().min(6);

/** Optional reference. */
const optionalRef = ref.optional();

/** Non-empty list of references. */
const refs = z.array(ref).min(1);

/** List of references that may be empty. */
const refList = z.array(ref);

/** Penpot UUID in canonical text form. */
const uuid = BackendIds.uuid();

/** Stack position of a shape or page: an integer from zero. */
const index = z.number().int().nonnegative();

/** Position of a grid row, column or span: an integer from one. */
const gridPosition = z.number().int().min(1);

/** Number within the int32 range the compiler accepts for positions and sizes. */
const safeNumber = z.number().min(-2147483648).max(2147483647);

/** Safe number that is not negative, for sizes and spacing. */
const nonNegativeNumber = safeNumber.min(0);

/** Safe number above zero, for media sizes. */
const positiveNumber = safeNumber.positive();

/** Number or string, for font sizes and text metrics. */
const numberOrText = z.union([z.string(), safeNumber]);

/** Plain object with any keys, the compiler's map type. */
const plainMap = z.record(z.string(), z.unknown());

/** Keys of `props` that mirror a shape. Neither a create nor an update operation sets them. */
const FLIP_KEYS = ["flipX", "flipY", "flip-x", "flip-y"];

/**
 * Refuses a flip in `props`, naming the key. A flip changes the transform and the points of a shape, so the flag
 * alone leaves an inconsistent shape; no operation sets it.
 *
 * @param props - the `props` of a create or update operation
 * @param context - receives one issue for each flip key
 */
function refuseFlips(props: Record<string, unknown>, context: z.RefinementCtx): void {
    for (const key of FLIP_KEYS) {
        if (key in props) {
            context.addIssue({
                code: "custom",
                path: [key],
                message: `${key} cannot be set: a flip cannot be set through this operation`,
            });
        }
    }
}

/** Keys of the page id, which `props` cannot set: the operation carries it. */
const PAGE_ID_KEYS = ["pageId", "page-id"];

/**
 * Refuses a page id in `props`, naming the key. The page id belongs to the operation, as the backend says.
 *
 * @param props - the `props` of a create or update operation
 * @param context - receives one issue for each page id key
 */
function refusePageId(props: Record<string, unknown>, context: z.RefinementCtx): void {
    for (const key of PAGE_ID_KEYS) {
        if (key in props) {
            context.addIssue({
                code: "custom",
                path: [key],
                message: `props cannot set the structural key ${key}; use the pageId of the operation instead`,
            });
        }
    }
}

/**
 * Refuses a rotation in the `props` of a create operation, as the backend does: a create operation sets no
 * transform.
 *
 * @param props - the `props` of a create operation
 * @param context - receives one issue when `rotation` is present
 */
function refuseRotation(props: Record<string, unknown>, context: z.RefinementCtx): void {
    if ("rotation" in props) {
        context.addIssue({
            code: "custom",
            path: ["rotation"],
            message:
                "props cannot set rotation on a create operation: a create operation sets no transform; " +
                "create the shape, then turn it with update_shape",
        });
    }
}

/** Shape attributes of a create operation: any keys, but no flip, no rotation and no page id. */
const shapeProps = plainMap.superRefine((props, context) => {
    refuseFlips(props, context);
    refuseRotation(props, context);
    refusePageId(props, context);
});

/** Value of any type that must be present, the compiler's any type. */
const requiredAny = z.unknown().refine((value) => value !== undefined, { error: "is required" });

/** Flex and grid direction values. */
const flexDirection = z.enum(["row", "row-reverse", "column", "column-reverse"]);
const gridDirection = z.enum(["row", "column"]);

/** Gap and padding mode values. */
const spacingMode = z.enum(["simple", "multiple"]);

/** Wrap values for flex layouts. */
const wrapType = z.enum(["wrap", "nowrap"]);

/** Content distribution values for justify-content and align-content. */
const contentAlign = z.enum(["start", "center", "end", "space-between", "space-around", "space-evenly", "stretch"]);

/** Item alignment values for align-items, justify-items and align-self. */
const itemAlign = z.enum(["start", "end", "center", "stretch"]);

/** Sizing values for layout children. */
const itemSizing = z.enum(["fill", "fix", "auto"]);

/** Grid track types. */
const gridTrackType = z.enum(["percent", "flex", "auto", "fixed"]);

/** Gap between layout children. */
const gap = z.looseObject({
    rowGap: nonNegativeNumber.optional(),
    columnGap: nonNegativeNumber.optional(),
});

/** Padding of a layout, all four sides required. */
const padding = z.looseObject({
    p1: nonNegativeNumber,
    p2: nonNegativeNumber,
    p3: nonNegativeNumber,
    p4: nonNegativeNumber,
});

/**
 * Grid rows or columns, each with a type and an optional value. A flex track value must be above zero
 * when present; a percent or fixed track needs a value; an auto track takes none.
 */
const gridTracks = z.array(
    z
        .looseObject({
            type: gridTrackType,
            value: nonNegativeNumber.nullable().optional(),
        })
        .refine(
            (track) => {
                switch (track.type) {
                    case "flex":
                        return track.value == null || track.value > 0;
                    case "percent":
                    case "fixed":
                        return track.value != null;
                    default:
                        return true;
                }
            },
            { error: "a flex track value must be > 0, and a percent or fixed track needs a value" }
        )
);

/** Layout container attributes of a flex layout. */
const flexLayout = {
    layoutFlexDir: flexDirection.optional(),
    layoutWrapType: wrapType.optional(),
    layoutGap: gap.optional(),
    layoutGapType: spacingMode.optional(),
    layoutPadding: padding.optional(),
    layoutPaddingType: spacingMode.optional(),
    layoutJustifyContent: contentAlign.optional(),
    layoutAlignItems: itemAlign.optional(),
    layoutAlignContent: contentAlign.optional(),
    layoutItemHSizing: itemSizing.optional(),
    layoutItemVSizing: itemSizing.optional(),
};

/** Layout container attributes of a grid layout. */
const gridLayout = {
    layoutGridDir: gridDirection.optional(),
    layoutGridRows: gridTracks.optional(),
    layoutGridColumns: gridTracks.optional(),
    layoutGap: gap.optional(),
    layoutGapType: spacingMode.optional(),
    layoutPadding: padding.optional(),
    layoutPaddingType: spacingMode.optional(),
    layoutAlignItems: itemAlign.optional(),
    layoutJustifyItems: itemAlign.optional(),
    layoutAlignContent: contentAlign.optional(),
    layoutJustifyContent: contentAlign.optional(),
};

/** Attributes of a layout child. */
const childLayout = {
    layoutItemMarginType: spacingMode.optional(),
    layoutItemMargin: z
        .looseObject({
            m1: safeNumber.optional(),
            m2: safeNumber.optional(),
            m3: safeNumber.optional(),
            m4: safeNumber.optional(),
        })
        .optional(),
    layoutItemMaxH: nonNegativeNumber.optional(),
    layoutItemMinH: nonNegativeNumber.optional(),
    layoutItemMaxW: nonNegativeNumber.optional(),
    layoutItemMinW: nonNegativeNumber.optional(),
    layoutItemHSizing: itemSizing.optional(),
    layoutItemVSizing: itemSizing.optional(),
    layoutItemAlignSelf: itemAlign.optional(),
    layoutItemAbsolute: z.boolean().optional(),
    layoutItemZIndex: safeNumber.optional(),
};

/** Descriptions of the font face fields, shared by the text and typography operations. */
const fontVariantIdDoc =
    "Font variant id. For the built-in font sourcesanspro: 200, 200italic, 300, 300italic, regular, italic, 600, 600italic, bold, bolditalic, black or blackitalic. Other fonts name the variant by weight, such as 600 or 600italic. Weight and style must agree with it. Alone, it sets weight and style.";
const fontWeightDoc =
    "Font weight, such as 400 or 700. Without fontVariantId, the variant follows from weight and fontStyle: 400 normal is regular, 700 normal is bold, 900 italic is blackitalic on sourcesanspro. Must agree with fontVariantId.";
const fontStyleDoc =
    "Font style: normal or italic. Without fontVariantId, the variant follows from fontWeight and fontStyle. Must agree with fontVariantId.";

/** Text attributes that `set_text_style` may change. */
const textAttrs = {
    fontFamily: z.string().optional(),
    fontId: z.string().optional(),
    fontVariantId: z.string().optional().describe(fontVariantIdDoc),
    fontSize: numberOrText.optional(),
    fontWeight: numberOrText.optional().describe(fontWeightDoc),
    fontStyle: z.string().optional().describe(fontStyleDoc),
    lineHeight: numberOrText.optional(),
    letterSpacing: numberOrText.optional(),
    textTransform: z.string().optional(),
    textDecoration: z.string().optional(),
    textAlign: z.string().optional(),
    verticalAlign: z.string().optional(),
    fills: z.array(plainMap).optional(),
};

/** Typography attrs. The font fields follow the text attrs. */
const typographyAttrs = {
    fontId: z.string().optional(),
    fontVariantId: z.string().optional().describe(fontVariantIdDoc),
    fontWeight: numberOrText.optional().describe(fontWeightDoc),
    fontStyle: z.string().optional().describe(fontStyleDoc),
};

/** Index of a child in its parent. In a flex or grid layout it is a visual index. */
const childIndexDoc =
    "Position among the parent's children. Inside a flex or grid layout the index is visual, counted from the first visual child. Without an index, a new child in a layout goes last visually.";

/** Token type names accepted by create_token and update_token. */
const tokenTypeDoc =
    "Token type. Penpot names: color, border-radius, font-size, and so on. DTCG and plugin names: borderRadius, fontSizes, fontSize, fontFamilies, fontFamily, fontWeights, fontWeight, letterSpacing, textCase, textDecoration, borderWidth, boxShadow, dimension, sizing, spacing, opacity, rotation, number, string, boolean, other, typography, shadow. An unknown type fails.";

/** Overrides of an instantiated component copy. */
const overridesDoc =
    "Changes to the copy, applied after it is made. Each entry names one shape of the copy with exactly one of name (a descendant's name, which must match exactly one descendant) or path (names from the copy's root child downwards, joined by ' / '). characters sets the text of a text shape. props sets non-geometry attributes; geometry keys are refused. A missing or ambiguous target fails. Keys are camelCase; the backend converts them.";

/** Geometry of a shape, all four values required. */
const box = {
    x: safeNumber,
    y: safeNumber,
    width: nonNegativeNumber,
    height: nonNegativeNumber,
};

/**
 * Builds the schema of one operation.
 *
 * @param opName - the op name the operation is selected by
 * @param shape - the parameters of the operation
 */
function operation<T extends OperationShape>(opName: string, shape: T) {
    return z.looseObject({ op: z.literal(opName), ...shape });
}

/**
 * Builds the schema of a shape-creating operation. The geometry in `box` applies unless `extra` replaces it.
 *
 * @param opName - the op name, for example `create_rect`
 * @param extra - parameters specific to the shape type
 */
function shapeOperation<T extends OperationShape>(opName: string, extra: T) {
    return operation(opName, {
        pageId: ref,
        id: optionalRef,
        parentId: optionalRef,
        index: index.optional().describe(childIndexDoc),
        name: z.string().optional(),
        props: shapeProps
            .optional()
            .describe(
                "Shape attributes to set. A flip (flipX, flipY) is refused. So is rotation: create the shape, " +
                    "then set rotation with update_shape."
            ),
        ...box,
        ...extra,
    });
}

/** Schemas of every operation, keyed by op name. */
export const OPERATION_SCHEMAS = {
    create_page: operation("create_page", {
        id: optionalRef,
        name: z.string(),
        index: index.optional(),
    }),
    update_page: operation("update_page", {
        id: ref,
        name: z.string().optional(),
        background: z.string().optional(),
        backgroundToken: z.string().nullable().optional(),
    }),
    delete_page: operation("delete_page", { id: ref }),
    move_page: operation("move_page", { id: ref, index }),
    create_board: shapeOperation("create_board", {}),
    create_rect: shapeOperation("create_rect", {}),
    create_ellipse: shapeOperation("create_ellipse", {}),
    create_text: shapeOperation("create_text", {
        width: nonNegativeNumber.optional(),
        height: nonNegativeNumber.optional(),
        characters: z.string(),
        growType: z.enum(["fixed", "auto-width", "auto-height"]).optional(),
        fontSize: numberOrText.optional(),
        fontFamily: z.string().optional(),
        fontId: z.string().optional(),
        fontVariantId: z.string().optional().describe(fontVariantIdDoc),
        fontWeight: numberOrText.optional().describe(fontWeightDoc),
        fontStyle: z.string().optional().describe(fontStyleDoc),
        fills: z.array(plainMap).optional(),
    }),
    create_path: shapeOperation("create_path", {
        props: shapeProps
            .optional()
            .describe(
                "Shape attributes to set. A path gets the default stroke of a path drawn in the workspace: a " +
                    "centered 1 px black stroke and no fill. Pass strokes: [] for a filled outline. A flip " +
                    "(flipX, flipY) is refused. So is rotation: create the path, then set rotation with update_shape."
            ),
        content: z.unknown().optional(),
        d: z.string().optional(),
    }),
    set_path_content: operation("set_path_content", {
        pageId: ref.describe("Id of the page that holds the path shape."),
        id: ref.describe("Id of the path shape, or a $tmp: handle of a path created earlier in the call."),
        content: z.unknown().describe("Path content, in the same form that create_path takes for its content."),
    }),
    create_image: shapeOperation("create_image", {
        mediaId: uuid,
        mediaWidth: positiveNumber,
        mediaHeight: positiveNumber,
        mediaMtype: z.string().optional(),
    }),
    create_svg_raw: shapeOperation("create_svg_raw", { content: plainMap }),
    create_group: operation("create_group", {
        pageId: ref,
        id: optionalRef,
        name: z.string().optional(),
        childIds: refs,
    }),
    create_boolean: operation("create_boolean", {
        pageId: ref,
        id: optionalRef,
        name: z.string().optional(),
        boolType: z.enum(["union", "difference", "intersection", "exclude"]),
        childIds: refs,
    }),
    update_shape: operation("update_shape", {
        pageId: ref,
        id: ref,
        props: z
            .looseObject({
                x: safeNumber.optional(),
                y: safeNumber.optional(),
                width: nonNegativeNumber.optional(),
                height: nonNegativeNumber.optional(),
                rotation: safeNumber.optional(),
            })
            .superRefine((props, context) => {
                refuseFlips(props, context);
                refusePageId(props, context);
            }),
    }),
    move_shapes: operation("move_shapes", {
        pageId: ref,
        ids: refs,
        parentId: ref,
        index: index.optional().describe(childIndexDoc),
    }),
    reorder: operation("reorder", {
        pageId: ref,
        parentId: ref,
        ids: refs.describe(
            "Every child of the parent, once each, in the new order. For a flex or grid layout parent the ids are in visual order."
        ),
    }),
    delete_shapes: operation("delete_shapes", { pageId: ref, ids: refs }),
    clone_shape: operation("clone_shape", {
        pageId: ref,
        id: ref,
        parentId: optionalRef,
        newId: optionalRef,
        // cloneId was the earlier name of newId; rejecting it stops the old key from being ignored silently.
        cloneId: z.never({ error: "use newId, the $tmp handle of the clone" }).optional(),
    }),
    ungroup: operation("ungroup", { pageId: ref, id: ref }),
    flatten: operation("flatten", { pageId: ref, ids: refs }),
    make_mask: operation("make_mask", { pageId: ref, groupId: ref }),
    remove_mask: operation("remove_mask", { pageId: ref, groupId: ref }),
    set_flex_layout: operation("set_flex_layout", { pageId: ref, id: ref, ...flexLayout }),
    set_grid_layout: operation("set_grid_layout", { pageId: ref, id: ref, ...gridLayout }),
    remove_layout: operation("remove_layout", { pageId: ref, id: ref }),
    set_layout_child: operation("set_layout_child", { pageId: ref, id: ref, ...childLayout }),
    set_grid_cell: operation("set_grid_cell", {
        pageId: ref,
        gridId: ref,
        childId: ref,
        row: gridPosition,
        column: gridPosition,
        rowSpan: gridPosition.optional(),
        columnSpan: gridPosition.optional(),
    }),
    set_text: operation("set_text", { pageId: ref, id: ref, characters: z.string() }),
    set_text_style: operation("set_text_style", {
        pageId: ref,
        id: ref,
        attrs: z.looseObject(textAttrs),
    }),
    apply_typography: operation("apply_typography", {
        pageId: ref,
        id: ref,
        typographyId: ref,
        libraryId: optionalRef,
    }),
    create_component: operation("create_component", {
        pageId: ref,
        shapeIds: refs,
        name: z.string().optional(),
        path: z.string().optional(),
        id: optionalRef,
    }),
    instantiate_component: operation("instantiate_component", {
        pageId: ref,
        componentId: ref,
        libraryId: optionalRef,
        parentId: optionalRef,
        id: optionalRef,
        x: safeNumber,
        y: safeNumber,
        overrides: z
            .array(
                z.looseObject({
                    name: z.string().optional(),
                    path: z.string().optional(),
                    characters: z.string().optional(),
                    props: z
                        .looseObject({})
                        .superRefine((props, context) => {
                            refuseFlips(props, context);
                            refusePageId(props, context);
                        })
                        .optional(),
                })
            )
            .optional()
            .describe(overridesDoc),
    }),
    detach: operation("detach", { pageId: ref, ids: refs }),
    swap_component: operation("swap_component", {
        pageId: ref,
        id: ref,
        componentId: ref,
        libraryId: optionalRef,
    }),
    reset_overrides: operation("reset_overrides", { pageId: ref, id: ref }),
    update_main: operation("update_main", { pageId: ref, id: ref }),
    rename_component: operation("rename_component", {
        componentId: ref,
        name: z.string(),
        path: z.string().optional(),
    }),
    delete_component: operation("delete_component", { componentId: ref }),
    restore_component: operation("restore_component", { componentId: ref, pageId: optionalRef }),
    sync_components: operation("sync_components", { componentIds: refList.optional() }),
    create_color: operation("create_color", { color: plainMap }),
    update_color: operation("update_color", { color: z.looseObject({ id: ref }) }),
    delete_color: operation("delete_color", { id: ref }),
    create_typography: operation("create_typography", { typography: z.looseObject(typographyAttrs) }),
    update_typography: operation("update_typography", { typography: z.looseObject({ id: ref, ...typographyAttrs }) }),
    delete_typography: operation("delete_typography", { id: ref }),
    create_token_set: operation("create_token_set", {
        id: optionalRef,
        name: z.string(),
        active: z.boolean().optional(),
    }),
    update_token_set: operation("update_token_set", { id: ref, name: z.string().optional() }),
    delete_token_set: operation("delete_token_set", { id: ref }),
    move_token_set: operation("move_token_set", { id: ref, beforeId: optionalRef }),
    create_token: operation("create_token", {
        setId: ref,
        id: optionalRef,
        type: z.string().describe(tokenTypeDoc),
        name: z.string(),
        value: requiredAny,
        description: z.string().optional(),
    }),
    update_token: operation("update_token", {
        setId: ref,
        id: ref,
        type: z.string().optional().describe(tokenTypeDoc),
        name: z.string().optional(),
        value: z.unknown().optional(),
        description: z.string().optional(),
    }),
    delete_token: operation("delete_token", { setId: ref, id: ref }),
    create_theme: operation("create_theme", {
        id: optionalRef,
        group: z.string(),
        name: z.string(),
        sets: z.array(z.string()),
    }),
    update_theme: operation("update_theme", {
        id: ref,
        group: z.string().optional(),
        name: z.string().optional(),
        sets: z.array(z.string()).optional(),
    }),
    delete_theme: operation("delete_theme", { id: ref }),
    activate_theme: operation("activate_theme", { id: ref }),
    deactivate_theme: operation("deactivate_theme", { id: ref }),
    toggle_set: operation("toggle_set", { setId: ref }),
    set_tokens_status: operation("set_tokens_status", {
        themeIds: refList,
        setIds: refList,
    }),
    set_tokens_source: operation("set_tokens_source", { libraryId: ref.nullable() }),
    import_tokens_dtcg: operation("import_tokens_dtcg", {
        json: z.string(),
        mode: z.enum(["merge", "replace"]),
    }),
    set_base_font_size: operation("set_base_font_size", { value: z.string() }),
    apply_token: operation("apply_token", {
        pageId: ref,
        shapeIds: refs,
        tokenName: z.string(),
        attributes: z.array(z.string()),
        resolvedValue: requiredAny,
    }),
    unapply_token: operation("unapply_token", {
        pageId: ref,
        shapeIds: refs,
        tokenName: z.string(),
        attributes: z.array(z.string()),
    }),
    add_interaction: operation("add_interaction", {
        pageId: ref,
        id: ref,
        interaction: plainMap,
    }),
    remove_interaction: operation("remove_interaction", { pageId: ref, id: ref, index }),
    create_flow: operation("create_flow", {
        pageId: ref,
        id: optionalRef,
        name: z.string(),
        startingFrame: ref,
    }),
    remove_flow: operation("remove_flow", { pageId: ref, id: ref }),
    add_ruler_guide: operation("add_ruler_guide", {
        pageId: ref,
        id: optionalRef,
        axis: z.enum(["horizontal", "vertical"]),
        position: safeNumber,
        frameId: optionalRef,
    }),
    remove_ruler_guide: operation("remove_ruler_guide", { pageId: ref, id: ref }),
    set_board_grid_guides: operation("set_board_grid_guides", {
        pageId: ref,
        id: ref,
        grids: z.array(plainMap),
    }),
    set_plugin_data: operation("set_plugin_data", {
        target: z.enum(["file", "page", "shape", "component", "color", "typography"]),
        id: optionalRef,
        pageId: optionalRef,
        namespace: z.string(),
        key: z.string(),
        value: z.string().nullable(),
    }),
    align: operation("align", {
        pageId: ref,
        ids: refs,
        axis: z.enum(["hleft", "hcenter", "hright", "vtop", "vcenter", "vbottom"]),
    }),
    distribute: operation("distribute", {
        pageId: ref,
        ids: refs,
        axis: z.enum(["horizontal", "vertical"]),
    }),
    replace_font: operation("replace_font", {
        pageId: ref,
        fromFontId: z.string().min(1).describe("Font id to replace, as the texts store it, such as gfont-access-sans."),
        toFontId: z
            .string()
            .min(1)
            .describe("Font id to use instead. It must resolve: a bundled font, a Google font, or a font of the team."),
        rootIds: z
            .array(ref)
            .min(1)
            .max(500)
            .optional()
            .describe("Limits the swap to these shapes and what they hold. Without it, every text on the page."),
        variantMatch: z
            .enum(["exact", "nearest"])
            .optional()
            .describe(
                "exact (default) refuses the whole op when a weight and style in use is missing in the target. nearest takes the closest variant."
            ),
        maxTexts: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe("Most texts to change. Default 1000. More matching texts refuse the op."),
    }),
};

/** Discriminated union of every operation, selected by the `op` field. */
export const OPERATION_UNION = z.discriminatedUnion(
    "op",
    Object.values(OPERATION_SCHEMAS) as unknown as [z.ZodObject, ...z.ZodObject[]]
);

/** Names of every valid operation, in table order. */
export const OPERATION_NAMES: readonly string[] = Object.keys(OPERATION_SCHEMAS);

/** Rules that span several operations, keyed by the topic they cover. */
export const OPERATION_RULES: Readonly<Record<string, string>> = {
    fontVariantId: fontVariantIdDoc,
    fontWeight: fontWeightDoc,
    fontStyle: fontStyleDoc,
    tokenType: tokenTypeDoc,
    overrides: overridesDoc,
    childIndex: childIndexDoc,
};

/** Parameter schemas of every operation, keyed by op name, for reading them by name. */
export const OPERATION_SCHEMA_BY_NAME: Readonly<Record<string, z.ZodType>> = OPERATION_SCHEMAS;
