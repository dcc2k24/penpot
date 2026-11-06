import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendFieldNames } from "./BackendFieldNames";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";

/** Arguments of {@link GetShapesTool}. */
export class GetShapesArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page that holds the shapes, from get_file_outline."),
        ids: z
            .array(BackendIds.uuid())
            .min(1)
            .max(200)
            .describe("Ids of the shapes to read, from get_page_tree or find_shapes (1 to 200 ids)."),
        fields: z
            .array(z.string().min(1))
            .optional()
            .describe(
                "Attributes to return per shape, such as width, parent-id or parentId. " +
                    "camelCase and kebab-case names both work. Default: all attributes."
            ),
        includeChildren: z
            .boolean()
            .optional()
            .describe("When true, also return every descendant of the given shapes in the shapes list."),
    };

    fileId!: string;

    pageId!: string;

    ids!: string[];

    fields?: string[];

    includeChildren?: boolean;
}

/** Returns the full attributes of specific shapes. */
export class GetShapesTool extends BackendTool<GetShapesArgs> {
    private readonly fieldNames = new BackendFieldNames();

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetShapesArgs.schema, services);
    }

    public getToolName(): string {
        return "get_shapes";
    }

    public getToolDescription(): string {
        return (
            "Returns the full attributes of up to 200 shapes by id, plus the ids that do not exist in missing. " +
            "Text shapes include their characters and textLayoutState. " +
            "Attribute names in the response are camelCase. " +
            "Use fields to keep the answer small. " +
            "Next: apply_operations to change them, using the ids here."
        );
    }

    protected async executeBackend(args: GetShapesArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ids: args.ids,
            ...(args.fields !== undefined ? { fields: this.fieldNames.toBackendFields(args.fields) } : {}),
            ...(args.includeChildren !== undefined ? { includeChildren: args.includeChildren } : {}),
        };
        const response = await this.callCommand<{ shapes?: unknown } | undefined>(userToken, "get-mcp-shapes", params);
        const shapes = Array.isArray(response?.shapes)
            ? response.shapes.map((shape) => BackendShapeTypes.toCallerShape(shape))
            : response?.shapes;
        return this.jsonResponse({ ...response, shapes });
    }
}
