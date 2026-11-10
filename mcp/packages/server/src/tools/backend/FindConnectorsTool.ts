import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link FindConnectorsTool}. */
export class FindConnectorsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page to scan, from get_file_outline."),
        maxDistance: z
            .number()
            .min(0)
            .max(2000)
            .optional()
            .describe(
                "Largest distance in pixels from a line end to a board for the end to count as attached (0 to 2000, " +
                    "default 64)."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe("Most connectors to return (1 to 2000, default 500)."),
        withinId: BackendIds.uuid()
            .optional()
            .describe(
                "Id of a shape. Only the shapes under it are scanned, so a large page can be scanned one section at " +
                    "a time. Leave it out to scan the whole page. An id that is not on the page is refused."
            ),
    };

    fileId!: string;

    pageId!: string;

    maxDistance?: number;

    limit?: number;

    withinId?: string;
}

/** Finds arrows and lines that run from one board to another, drawn as plain paths. */
export class FindConnectorsTool extends BackendTool<FindConnectorsArgs> {
    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, FindConnectorsArgs.schema, services);
    }

    /** Marks the tool as read-only, so that clients run it without a prompt. */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "find_connectors";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        return (
            "Finds the connectors of a page: arrows and lines drawn as plain paths whose two ends each lie within " +
            "maxDistance of a different board. The scan takes at most a few seconds, so large pages may be cut. " +
            "Candidates are the visible paths and booleans, shallowest first: boolean children and hidden shapes are " +
            "skipped, and an arrow cap decides the direction only on an open path. " +
            "withinId (a shape id) limits the scan to the shapes under that shape, for a large page scanned one " +
            "section " +
            "at a time. " +
            "scanned is the number of candidate shapes looked at. " +
            "connectors lists each one with its id, name, type, length, and from and to, each with boardId, " +
            "boardName, " +
            "distance (from the end to the board, 0 when it is inside), and x and y of the end. " +
            "direction says how the ends were told apart: cap (an arrow head on one end), shape (one end is clearly " +
            "wider, so that end is the head), or none (from is the end further left). " +
            "When direction is cap or shape, to is the head end. " +
            "truncated true means the scan ran out of time or the limit was reached. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes for the full attributes of a connector, or get_interactions for prototype links."
        );
    }

    /**
     * Sends the connector scan to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: FindConnectorsArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.maxDistance !== undefined ? { maxDistance: args.maxDistance } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.withinId !== undefined ? { withinId: args.withinId } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "find-mcp-connectors", params);
        return this.jsonResponse(response);
    }
}
