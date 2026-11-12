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
                "Only check boards whose name matches this regular expression (up to 200 characters). " +
                    "Without mode it selects mode depth."
            ),
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
                    "scroll-candidate",
                    "sibling-overlay",
                ])
            )
            .min(1)
            .max(9)
            .optional()
            .describe(
                "Rules to run (1 to 9 of: empty-board, instance-only-board, clipped-control, invisible-control, " +
                    "scroll-hidden-control, off-board-control, scroll-candidate, sibling-overlay). Default: all of them."
            ),
        tolerance: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe(
                "Pixels of rounding noise to ignore in the edge tests (0 to 100, default 0.5). " +
                    "off-board-control needs an overflow above it on some side. clipped-control and " +
                    "invisible-control judge the control box shrunk by it on each side. 0 gives the strict tests."
            ),
        minOverflow: z
            .number()
            .min(0)
            .max(1000)
            .optional()
            .describe(
                "Pixels that the content of a frame must reach past its right or bottom edge before " +
                    "scroll-candidate reports the frame (0 to 1000, default 8)."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe("Most findings to return (1 to 2000, default 500)."),
        offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
                "Findings to skip, from the nextOffset of an earlier reply, to read a long list in parts " +
                    "(default 0)."
            ),
    };

    fileId!: string;

    pageId!: string;

    depth?: number;

    mode?: "depth" | "auto";

    boardNameRegex?: string;

    minShapes?: number;

    rules?: string[];

    tolerance?: number;

    minOverflow?: number;

    limit?: number;

    offset?: number;
}

/**
 * Checks the boards of a page for layout faults before code is generated from them: empty boards, boards that hold
 * only chrome (the components that repeat in the same place on the screens, such as a header), controls that are
 * clipped, hidden or off their board, and frames that need to scroll.
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
            "Run it before generating code from a page. " +
            "Boards are the screens of the page. With no depth, boardNameRegex or mode, mode auto first looks for " +
            "frames of a standard screen size (a phone, tablet, desktop or kiosk size) that occur at least three " +
            "times, outside component instances, wherever they lie, and that are not parts of repeated " +
            "frames that outnumber them. If there are none, it uses the nesting of " +
            "repeated frame sizes. Frames under 200 px on a side are never boards. When no size repeats, it falls " +
            "back to the frames at depth 1. " +
            "A frame up to a quarter taller than a standard screen is a wrapper, not a board, when most such frames hold " +
            "exactly one frame of the exact standard size and the same width: the screens inside are the boards. " +
            "A frame size is also a wrapper when at least 90% of its frames each hold exactly one screen, of any exact standard size, as a direct child, centred with equal gaps on opposite sides (within 2 px) of at most 200 px; the size appears in otherSizes with relation wrapper, and a class below 90% is reported outside. " +
            "Standard sizes are always kept. Loose boards that are clearly not screens are dropped: a frame larger than the screens in both directions with at least 4 times the area of the largest screen class (a section); a frame that holds exactly one loose board with a wrapper margin; a non-portrait frame that holds, or sits in, a frame of its own size (an annotation and its widget) and is under half the smallest screen class. An overlay (a sibling frame of a screen inside its wrapper, with at least half of its own area over that screen) is not a board. " +
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
            "Rules: empty-board (fewer visible shapes than minShapes); " +
            "instance-only-board (the board holds an instance of a chrome component and no content outside chrome; " +
            "detail chromeComponentIds and contentShapes 0). " +
            "Chrome components are the components that repeat in the same place across the screens and " +
            "touch a screen edge or sit on most screens, such as a header, a footer or a side rail: a component " +
            "occurs in at least 3 selected boards and 30 % of them, its instances are on average under half the " +
            "area of a board, it occurs once in at least 90 % of the boards that hold it, at the same offset " +
            "(within 2 px) from the board corner in at least 80 % of them, and there it lies within 4 px of a " +
            "board edge or the component is in at least 70 % of the selected boards. The variants of one " +
            "component count as one. " +
            "chromeComponents lists up to 10 as id, name and boards (and variants, the number of variants, when " +
            "above 1), the most boards first, and is empty when " +
            "there is none, and then the rule reports nothing. It is looked for only when this rule runs. " +
            "Content is an image of any size (a shape of type image, or a shape with an image fill), a visible " +
            "shape that draws something else (a rect, text and so on) unless it is a " +
            "backdrop covering 90 % of the board or more (a background split into several shapes is content), or a frame or group with a fill, stroke or image fill of " +
            "its own, holding nothing else, whose box is under 50 % of the board. " +
            "empty-board and instance-only-board skip a board that is, or lies inside, a component instance; " +
            "clipped-control (a component " +
            "instance with text is partly cut off by a clipping frame; detail visibleFraction and clippedBy); " +
            "invisible-control (the same, with nothing visible; visibleFraction is 0, and rawVisibleFraction " +
            "gives the share of the whole box when that is above 0); " +
            "scroll-hidden-control (a control out of view inside a board that scrolls; reachable by scrolling); " +
            "off-board-control (a control sticks out of its " +
            "board; detail overflow with left, top, right and bottom in pixels); " +
            "scroll-candidate (a frame that clips its content, has no overflowScroll, and has visible children " +
            "that reach past its right or bottom edge by at least minOverflow pixels and more " +
            "than tolerance; detail overflow with right and bottom, suggested (vertical, horizontal or both) and " +
            "inComponentCopy); sibling-overlay (mode auto only: a board or group of any size that is not a screen and lies over a screen " +
            "as its sibling in the same wrapper, covering at least half of its own area, not a component instance; a section child over a screen is not found; boardId is the covered screen, " +
            "shapeId the overlay, detail coveredFraction and overlayBox). A background that covers the frame on both axes does not count. " +
            "For a frame with inComponentCopy true, set overflowScroll on the main component, because a write " +
            "on the copy is an override. " +
            "To apply the suggestions, send one apply_operations call with an update_shape operation per frame, " +
            "with props overflowScroll set to the suggested value. " +
            "tolerance (pixels, default 0.5) keeps rounding noise out of the edge tests: off-board-control needs an " +
            "overflow above it on some side, clipped-control and invisible-control judge the control box shrunk " +
            "by it on each side, and a control within it of a scroll frame on the axis that does not scroll " +
            "still counts as reachable; 0 gives the strict tests, and detail overflow keeps the raw values. " +
            "A control is reported once, under its innermost board, and with rules given under the first asked rule " +
            "that applies. A scroll-candidate frame is reported once, under its innermost board. " +
            "findings are in board order, then shape order. counts totals the findings per rule over " +
            "all of them, even when limit cuts the list, total is their sum, and boards gives the number of " +
            "boards checked. The order depends only on the file at one revn and the arguments. A reply holds " +
            "whole findings only, as many as fit the reply size cap and limit. When more remain, truncated is " +
            "true and nextOffset is set: call again with offset set to nextOffset until no nextOffset comes " +
            "back to read every finding once, while revn stays the same and no reply has timedOut. " +
            "timedOut true means the scan ran out of time: the reply is not complete, carries a note that says so, has no nextOffset and cannot " +
            "be continued, and counts cover only what it reached. Start again with a narrower call, with fewer " +
            "rules or boardNameRegex. " +
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
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.boardNameRegex !== undefined ? { boardNameRegex: args.boardNameRegex } : {}),
            ...(args.minShapes !== undefined ? { minShapes: args.minShapes } : {}),
            ...(args.rules !== undefined ? { rules: args.rules } : {}),
            ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
            ...(args.minOverflow !== undefined ? { minOverflow: args.minOverflow } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "get-mcp-page-lint", params);
        return this.pagedJsonResponse(response, "findings", args.offset ?? 0, "fewer rules, or boardNameRegex");
    }
}
