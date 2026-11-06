import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendFieldNames } from "./BackendFieldNames";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";

/** Arguments of {@link GetPageTreeTool}. */
export class GetPageTreeArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page, from get_file_outline."),
        rootId: BackendIds.uuid()
            .optional()
            .describe("Id of the shape to start from. Leave it out to start at the page root."),
        depth: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("How many levels of children to include below the start shape (1 to 20, default 3)."),
        fields: z
            .array(z.string().min(1))
            .optional()
            .describe(
                "Shape attributes to include in each node, such as x, y, width, parent-id or parentId. " +
                    "camelCase and kebab-case names both work. Default: id, name, type, x, y, width, height, " +
                    "parent-id, frame-id, hidden, blocked, component-id, main-instance, component-root, shape-ref."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe("Maximum number of nodes in this response (1 to 5000, default 500)."),
        cursor: z
            .string()
            .optional()
            .describe("nextCursor of an earlier truncated response, to fetch the following nodes."),
    };

    fileId!: string;

    pageId!: string;

    rootId?: string;

    depth?: number;

    fields?: string[];

    limit?: number;

    cursor?: string;
}

/** Returns the shape hierarchy of one page, or of a subtree, one slice at a time. */
export class GetPageTreeTool extends BackendTool<GetPageTreeArgs> {
    private readonly fieldNames = new BackendFieldNames();

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetPageTreeArgs.schema, services);
    }

    public getToolName(): string {
        return "get_page_tree";
    }

    public getToolDescription(): string {
        return (
            "Returns the shape tree of a page (or of rootId) with ids, types, names and geometry, depth-first. " +
            "Large pages come back truncated with a nextCursor; pass it as cursor to continue. " +
            "Text nodes whose layout is approximate are marked textLayoutState: approximate. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes with the ids you need in full."
        );
    }

    protected async executeBackend(args: GetPageTreeArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.rootId !== undefined ? { rootId: args.rootId } : {}),
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.fields !== undefined ? { fields: this.fieldNames.toBackendFields(args.fields) } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        };
        const response = await this.callCommand<{ root?: unknown } | undefined>(userToken, "get-mcp-page-tree", params);
        return this.jsonResponse({ ...response, root: BackendShapeTypes.toCallerTree(response?.root) });
    }
}
