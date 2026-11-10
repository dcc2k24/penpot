import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link FindSimilarBoardsTool}. */
export class FindSimilarBoardsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page to check, from get_file_outline."),
        depth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe(
                "How many levels below the page root to look for boards (1 to 5, default 1: the direct children " +
                    "of the page root)."
            ),
        boardNameRegex: z
            .string()
            .max(200)
            .optional()
            .describe("Only compare boards whose name matches this regular expression (up to 200 characters)."),
        threshold: z
            .number()
            .min(0.5)
            .max(1)
            .optional()
            .describe(
                "Similarity from 0.5 to 1 at which two boards count as near copies (default 0.9). " +
                    "1 finds only exact copies."
            ),
        minShapes: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Boards with fewer visible shapes inside them are left out (1 to 1000, default 3)."),
        limit: z.number().int().min(1).max(500).optional().describe("Most groups to return (1 to 500, default 100)."),
    };

    fileId!: string;

    pageId!: string;

    depth?: number;

    boardNameRegex?: string;

    threshold?: number;

    minShapes?: number;

    limit?: number;
}

/** Finds boards on a page that are copies of each other, exact or near, by their shapes and their text. */
export class FindSimilarBoardsTool extends BackendTool<FindSimilarBoardsArgs> {
    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, FindSimilarBoardsArgs.schema, services);
    }

    /** Marks the tool as read-only, so that clients run it without a prompt. */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "find_similar_boards";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        return (
            "Finds groups of boards that are copies of each other. Boards are compared by their shape types, " +
            "component instances and text, not by position or name. " +
            "Each group has boards (id, name, path and shapeCount), similarity (1 for exact copies, otherwise the " +
            "lowest similarity between linked boards) and exact (true when every board in the group is the same). " +
            "Only groups of two or more boards are listed, largest first. " +
            "Run it before generating code from a page, so that repeated boards are built once. " +
            "boards is the number of boards compared, and compared the number of pairs whose similarity was " +
            "computed. " +
            "truncated true means more than 1000 boards were found, the time limit was reached, or there are more " +
            "groups than limit. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes on the ids of one board in a group, or lint_page to check the boards."
        );
    }

    /**
     * Sends the similar-board search to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: FindSimilarBoardsArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.boardNameRegex !== undefined ? { boardNameRegex: args.boardNameRegex } : {}),
            ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
            ...(args.minShapes !== undefined ? { minShapes: args.minShapes } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "find-mcp-similar-boards", params);
        return this.jsonResponse(response);
    }
}
