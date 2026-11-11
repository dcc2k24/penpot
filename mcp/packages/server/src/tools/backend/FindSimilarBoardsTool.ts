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
            .max(12)
            .optional()
            .describe(
                "How many levels below the page root to look for boards (1 to 12). Giving depth selects mode " +
                    "depth: the visible frames up to that level, 1 being the direct children of the page root. " +
                    "Not allowed with mode auto."
            ),
        mode: z
            .enum(["depth", "auto"])
            .optional()
            .describe(
                "How boards are selected. auto finds the screens by size: frames of one size that occur at least " +
                    "three times, wherever they lie in the page. depth takes the frames up to depth levels " +
                    "(default 1). With none of depth, boardNameRegex and mode, the mode is auto. With depth or " +
                    "boardNameRegex alone, it is depth. auto with boardNameRegex keeps the matching screens."
            ),
        boardNameRegex: z
            .string()
            .max(200)
            .optional()
            .describe(
                "Only compare boards whose name matches this regular expression (up to 200 characters). " +
                    "Without mode it selects mode depth."
            ),
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

    mode?: "depth" | "auto";

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
            "Finds groups of boards that are copies of each other. Boards are the screens of the page. With no " +
            "depth, boardNameRegex or mode, mode auto first looks for frames of a standard screen size (a phone, " +
            "tablet, desktop or kiosk size) that occur at least three times, outside component instances, " +
            "wherever they lie, and that are not parts of repeated frames that outnumber them. If there are none, it uses the " +
            "nesting of repeated frame sizes. Frames under " +
            "200 px on a side are never boards. When no size repeats, it falls back to the frames at depth 1. " +
            "A frame up to a quarter taller than a standard screen is a wrapper, not a board, when most such frames hold " +
            "exactly one frame of the exact standard size and the same width: the screens inside are the boards. " +
            "Mode depth takes the visible frames up to depth levels below the page root; depth or boardNameRegex " +
            "alone chooses boards by hand. " +
            "selection says what was selected: mode, depth, fallback (true when auto fell back), basis " +
            "(standard-size, structure or depth-fallback), sizes (width, " +
            "height and boards per size), sizesOmitted (sizes left out of the list of 20), boards, minDepth and " +
            "maxDepth. In mode auto, selection also has otherSizes: up to 5 sizes that repeat on the page but " +
            "were not selected, each with width, height, boards and relation (inside when they lie inside the " +
            "selected boards, outside otherwise, wrapper when the frames only wrap the screens), the largest " +
            "first. nestedSameSize counts the boards that sit in a chain of frames of their own size; the board of a chain is the frame that matches boardNameRegex, else the one named like the unwrapped boards of that size, else the outermost. " +
            "In mode depth, deeperBoards is the number of frames below the selected boards that are screen-sized " +
            "(200 px or more on both sides) and of a size that occurs three times or more: when it is not 0, " +
            "repeated screen-sized frames exist deeper; call again without depth to let the selection find them, " +
            "or with a larger depth. Mode auto has no deeperBoards. " +
            "Boards are compared by their shape types, " +
            "component instances and text, not by position or name. " +
            "A screen that holds a frame of its own size counts that frame too, so it is close to, but not an exact copy of, the same screen without the frame. " +
            "Each group has boards (id, name, path and shapeCount), similarity (1 for exact copies, otherwise the " +
            "lowest similarity between linked boards) and exact (true when every board in the group is the same). " +
            "Only groups of two or more boards are listed, largest first. " +
            "Run it before generating code from a page, so that repeated boards are built once. " +
            "boards is the number of boards compared, and compared the number of pairs whose similarity was " +
            "computed. " +
            "Boards with fewer visible shapes than minShapes are not compared. skippedSmall lists them: count, and " +
            "ids for the first 50 in page order. So every selected board is either compared or in skippedSmall. " +
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
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.boardNameRegex !== undefined ? { boardNameRegex: args.boardNameRegex } : {}),
            ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
            ...(args.minShapes !== undefined ? { minShapes: args.minShapes } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "find-mcp-similar-boards", params);
        return this.jsonResponse(response);
    }
}
