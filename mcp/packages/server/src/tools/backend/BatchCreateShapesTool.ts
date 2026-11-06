import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";
import { BatchTreeExpander, type BatchNode } from "./operations/BatchTreeExpander";
import { OperationValidator } from "./operations/OperationValidator";

/** Arguments of {@link BatchCreateShapesTool}. */
export class BatchCreateShapesArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file to change, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page that receives the shapes, from get_file_outline."),
        parentId: BackendIds.uuid()
            .optional()
            .describe(
                "Id of an existing shape that becomes the parent of the top-level nodes. Default: the page root."
            ),
        tree: z
            .array(BatchTreeExpander.NODE_SCHEMA)
            .min(1)
            .describe(
                "Top-level nodes. Each node has type, x, y, width, height, and optionally name, props, characters " +
                    "and children (nested nodes created inside it)."
            ),
        ...WriteOptions.schema,
    };

    fileId!: string;

    pageId!: string;

    parentId?: string;

    tree!: BatchNode[];

    dryRun?: boolean;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    requestId?: string;
}

/**
 * Creates a nested tree of shapes in one write.
 *
 * The tree is expanded into create operations with `$tmp:n<i>` handles, so each node's parent is wired by
 * handle, and the whole tree is committed through `mcp-apply-operations`.
 */
export class BatchCreateShapesTool extends BackendTool<BatchCreateShapesArgs> {
    private readonly expander = new BatchTreeExpander();
    private readonly validator = new OperationValidator();

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, BatchCreateShapesArgs.schema, services);
    }

    public getToolName(): string {
        return "batch_create_shapes";
    }

    public getToolDescription(): string {
        return (
            "Creates a nested tree of shapes in one atomic write. Each node takes type (board, rect, rectangle, " +
            "ellipse, circle, text, path, image, svg_raw), x, y, width, height, optional name, props and characters, " +
            "and children. The response lists each node's handle (n0, n1, ...) with its UUID in createdIds. " +
            "Use dryRun true to validate. Next: get_page_tree to check the result."
        );
    }

    protected async executeBackend(args: BatchCreateShapesArgs, userToken: string): Promise<ToolResponse> {
        const expanded = this.expander.expand(args.pageId, args.parentId, args.tree);
        this.validator.validate(expanded.operations);
        const params = {
            fileId: args.fileId,
            operations: expanded.operations,
            ...WriteOptions.toParams(args),
        };
        const result = await this.callWrite(userToken, args.fileId, "mcp-apply-operations", params);
        return this.jsonResponse({ nodes: expanded.nodes, result });
    }
}
