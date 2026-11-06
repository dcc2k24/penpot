import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";
import { OperationValidator } from "./operations/OperationValidator";
import { ApplyTokenValues, TokenCatalogue, type TokenValueWarning } from "../../sandbox/ApplyTokenValues";

/** Arguments of {@link ApplyOperationsTool}. */
export class ApplyOperationsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file to change, from list_files."),
        operations: z
            .array(
                z.looseObject({
                    op: z.string().describe("Operation name, such as create_rect, update_shape or set_text."),
                })
            )
            .min(1)
            .max(OperationValidator.MAX_OPERATIONS)
            .describe(
                "Operations applied in order, each an object with an op name and camelCase parameters. " +
                    "A create operation may set id to a $tmp:name handle that later operations use. " +
                    "Unknown ops and missing parameters are reported with the valid names and fields."
            ),
        allowSplit: z
            .boolean()
            .optional()
            .describe(
                "When true, commit large batches in several transactions of up to 300 creations. " +
                    "On failure the response names lastCommittedRevn and failedOperationIndex. Default false."
            ),
        ...WriteOptions.schema,
    };

    fileId!: string;

    operations!: Record<string, unknown>[];

    allowSplit?: boolean;

    dryRun?: boolean;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    requestId?: string;
}

/**
 * Applies a list of typed design operations to a file in one write.
 *
 * Before the write, every `apply_token` operation without `resolvedValue` gets the token's value from the file's
 * token catalogue, read once per call and only when the call holds an `apply_token` operation. A supplied value is
 * kept, with a warning in the result when it is not the token's value.
 */
export class ApplyOperationsTool extends BackendTool<ApplyOperationsArgs> {
    private readonly validator = new OperationValidator();

    private readonly tokenValues = new ApplyTokenValues(
        "apply_operations",
        " Fix the token, or pass resolvedValue to set the value yourself."
    );

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ApplyOperationsArgs.schema, services);
    }

    public getToolName(): string {
        return "apply_operations";
    }

    public getToolDescription(): string {
        return (
            "Applies typed design operations to a file in one atomic write. Preferred over apply_raw_changes. " +
            "Ids are explicit UUIDs from get_page_tree or get_shapes. " +
            "Use $tmp:name handles to refer to shapes created earlier in the same call; the response maps them to UUIDs. " +
            "Set dryRun true to validate without saving. Pass baseRevn from get_file_outline to detect concurrent edits. " +
            "Shape params are camelCase: pageId, parentId, x, y, width, height, props (fills, strokes, radius, ...). " +
            "Ops: create_page, update_page, delete_page, move_page, create_board, create_rect, create_ellipse, " +
            "create_text (characters), create_path, create_image (mediaId, mediaWidth, mediaHeight), create_svg_raw, " +
            "create_group (childIds), create_boolean (boolType, childIds), update_shape (id, props), move_shapes " +
            "(ids, parentId), reorder, delete_shapes, clone_shape, ungroup, flatten, make_mask, remove_mask, " +
            "set_flex_layout, set_grid_layout, remove_layout, set_layout_child, set_grid_cell, set_text, " +
            "set_text_style, apply_typography, create_component, instantiate_component, detach, swap_component, " +
            "reset_overrides, update_main, rename_component, delete_component, restore_component, sync_components, " +
            "create_color, update_color, delete_color, create_typography, update_typography, delete_typography, " +
            "create_token_set, update_token_set, delete_token_set, move_token_set, create_token, update_token, " +
            "delete_token, create_theme, update_theme, delete_theme, activate_theme, deactivate_theme, toggle_set, " +
            "set_tokens_status, set_tokens_source, import_tokens_dtcg, set_base_font_size, apply_token " +
            "(resolvedValue is optional and defaults to the token's value in the active sets), " +
            "unapply_token, add_interaction, remove_interaction, create_flow, remove_flow, add_ruler_guide, " +
            "remove_ruler_guide, set_board_grid_guides, set_plugin_data, align, distribute. " +
            'Example: {op: create_rect, pageId, id: "$tmp:bg", x: 0, y: 0, width: 100, height: 40, props: {fills: [{fillColor: "#ff0000", fillOpacity: 1}]}}. ' +
            "Read the schema of an op from the error message if a parameter is rejected."
        );
    }

    protected async executeBackend(args: ApplyOperationsArgs, userToken: string): Promise<ToolResponse> {
        const catalogue = new TokenCatalogue(this.services.backend, userToken, args.fileId);
        const tokenWarnings = await this.tokenValues.fill(args.operations, catalogue);
        const operations = this.validator.validate(args.operations);
        const params = {
            fileId: args.fileId,
            operations,
            ...(args.allowSplit !== undefined ? { allowSplit: args.allowSplit } : {}),
            ...WriteOptions.toParams(args),
        };
        const result = await this.callWrite(userToken, args.fileId, "mcp-apply-operations", params);
        return this.jsonResponse(ApplyOperationsTool.withWarnings(result, tokenWarnings));
    }

    /**
     * Adds the token value warnings to the warnings of the backend result.
     *
     * @param result - the backend result of the write
     * @param tokenWarnings - the warnings about supplied token values
     * @returns the result itself when there is no token warning, otherwise a copy whose `warnings` list ends with
     *   the token warnings
     */
    private static withWarnings(result: unknown, tokenWarnings: TokenValueWarning[]): unknown {
        if (tokenWarnings.length === 0) {
            return result;
        }
        if (result === null || typeof result !== "object" || Array.isArray(result)) {
            return { result, warnings: tokenWarnings };
        }
        const record = result as Record<string, unknown>;
        const warnings = Array.isArray(record.warnings) ? record.warnings : [];
        return { ...record, warnings: [...warnings, ...tokenWarnings] };
    }
}
