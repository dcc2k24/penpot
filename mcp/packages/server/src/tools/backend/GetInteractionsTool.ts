import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";

/** Arguments of {@link GetInteractionsTool}. */
export class GetInteractionsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page to read, from get_file_outline."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe(
                "Most shapes with interactions to return (1 to 5000, default 1000). " +
                    "A response cut for size or by this limit has truncated true."
            ),
    };

    fileId!: string;

    pageId!: string;

    limit?: number;
}

/** Returns the prototype interactions of one page in one call: the flows and every shape that has an interaction. */
export class GetInteractionsTool extends BackendTool<GetInteractionsArgs> {
    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetInteractionsArgs.schema, services);
    }

    /** Marks the tool as read-only, so that clients run it without a prompt. */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "get_interactions";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        return (
            "Returns the prototype wiring of a page in one call: the flows, and every shape that has at least one " +
            "interaction, with the interactions of each. " +
            "flows lists each flow with its id, name, startingFrame (a board id) and startingFrameName. " +
            "shapes lists each shape with its id, name, type, frameId (the board it sits in), path, and " +
            "interactions. " +
            "Each interaction is as stored, with destinationName when its destination is a shape on the page. " +
            "totalInteractions and totalShapes count the whole page. truncated true means shapes were left out, " +
            "by limit or by the response size. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes for the full attributes of a shape, or export_subtree for the whole page as data."
        );
    }

    /**
     * Sends the interaction read to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: GetInteractionsArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        const response = await this.callCommand<{ shapes?: unknown } | undefined>(
            userToken,
            "get-mcp-interactions",
            params
        );
        const shapes = Array.isArray(response?.shapes)
            ? response.shapes.map((shape) => BackendShapeTypes.toCallerShape(shape))
            : response?.shapes;
        return this.jsonResponse({ ...response, shapes });
    }
}
