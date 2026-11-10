import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link LintPageTool}. */
export class LintPageArgs {
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
            .describe("Only check boards whose name matches this regular expression (up to 200 characters)."),
        minShapes: z
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe("A board with fewer visible shapes inside it is empty (0 to 1000, default 3)."),
        rules: z
            .array(
                z.enum([
                    "empty-board",
                    "instance-only-board",
                    "clipped-control",
                    "invisible-control",
                    "scroll-hidden-control",
                    "off-board-control",
                ])
            )
            .min(1)
            .max(8)
            .optional()
            .describe(
                "Rules to run (1 to 8 of: empty-board, instance-only-board, clipped-control, invisible-control, " +
                    "scroll-hidden-control, off-board-control). Default: all of them."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe("Most findings to return (1 to 2000, default 500)."),
    };

    fileId!: string;

    pageId!: string;

    depth?: number;

    boardNameRegex?: string;

    minShapes?: number;

    rules?: string[];

    limit?: number;
}

/**
 * Checks the boards of a page for layout faults before code is generated from them: empty boards, boards that hold
 * only one instance, and controls that are clipped, hidden or off their board.
 */
export class LintPageTool extends BackendTool<LintPageArgs> {
    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, LintPageArgs.schema, services);
    }

    /** Marks the tool as read-only, so that clients run it without a prompt. */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "lint_page";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        return (
            "Checks the boards of a page for faults, and returns each finding with its board, shape and detail. " +
            "Run it before generating code from a page. Rules: empty-board (fewer visible shapes than minShapes); " +
            "instance-only-board (the board's only visible child is one component instance); " +
            "empty-board and instance-only-board skip a board that is, or lies inside, a component instance; " +
            "clipped-control (a component " +
            "instance with text is partly cut off by a clipping frame; detail visibleFraction and clippedBy); " +
            "invisible-control (the same, with nothing visible); " +
            "scroll-hidden-control (a control out of view inside a board that scrolls; reachable by scrolling); " +
            "off-board-control (a control sticks out of its " +
            "board; detail overflow with left, top, right and bottom in pixels). " +
            "Boards are the visible frames up to depth levels below the page root. " +
            "A control is reported once, under its innermost board, and with rules given under the first asked rule " +
            "that applies. findings are in board order, then shape order. counts totals the findings per rule over " +
            "all of them, even when limit cuts the list, and boards gives the number of boards checked. " +
            "truncated true means the findings were cut by limit or a time limit. " +
            "Attribute names in the response are camelCase. " +
            "Next: get_shapes on the shapeId of a finding, or find_similar_boards to check for repeated boards."
        );
    }

    /**
     * Sends the page lint to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: LintPageArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.boardNameRegex !== undefined ? { boardNameRegex: args.boardNameRegex } : {}),
            ...(args.minShapes !== undefined ? { minShapes: args.minShapes } : {}),
            ...(args.rules !== undefined ? { rules: args.rules } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "get-mcp-page-lint", params);
        return this.jsonResponse(response);
    }
}
