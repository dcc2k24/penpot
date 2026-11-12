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
                "Largest distance in pixels from a connector end to a frame for the end to count as attached (0 to " +
                    "2000, default 64)."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(2000)
            .optional()
            .describe("Most connectors to return (1 to 2000, default 500)."),
        offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
                "Connectors to skip, from the nextOffset of an earlier reply, to read a long list in parts " +
                    "(default 0)."
            ),
        withinId: BackendIds.uuid()
            .optional()
            .describe(
                "Id of a shape. Only the shapes under it are scanned, so a large page can be scanned one section at " +
                    "a time. Leave it out to scan the whole page. An id that is not on the page is refused."
            ),
        depth: z
            .number()
            .int()
            .min(1)
            .max(12)
            .optional()
            .describe(
                "How many levels below the page root to look for screens (1 to 12). Giving depth selects mode " +
                    "depth: the visible frames up to that level, 1 being the direct children of the page root. " +
                    "Not allowed with mode auto."
            ),
        mode: z
            .enum(["depth", "auto"])
            .optional()
            .describe(
                "How screens are selected. auto finds the screens by size: frames of one size that occur at least " +
                    "three times, wherever they lie in the page. depth takes the frames up to depth levels " +
                    "(default 1). With none of depth, boardNameRegex and mode, the mode is auto. With depth or " +
                    "boardNameRegex alone, it is depth. auto with boardNameRegex keeps the matching screens."
            ),
        boardNameRegex: z
            .string()
            .max(200)
            .optional()
            .describe(
                "Only frames whose name matches this regular expression (up to 200 characters) are screens. " +
                    "Without mode it selects mode depth."
            ),
        includeSameScreen: z
            .boolean()
            .optional()
            .describe(
                "Also return the connectors whose two ends lie in the same screen, each flagged sameScreen true " +
                    "(default false: they are dropped and only counted)."
            ),
    };

    fileId!: string;

    pageId!: string;

    maxDistance?: number;

    limit?: number;

    offset?: number;

    withinId?: string;

    depth?: number;

    mode?: "depth" | "auto";

    boardNameRegex?: string;

    includeSameScreen?: boolean;
}

/**
 * Finds arrows and lines that run from one screen to another, drawn as plain paths, booleans or small groups of
 * shapes. A design with no prototype links carries its navigation in these.
 */
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
            "Finds the connectors of a page: arrows and lines that are drawn as shapes, not as prototype links, and " +
            "whose two ends each lie within maxDistance of a different frame. Use it when get_interactions finds " +
            "no links. " +
            "A screen is a board that is one whole screen of the app. A section frame, a decision frame and a frame " +
            "inside a screen are not screens. Screens are selected as in lint_page: " +
            "with no depth, boardNameRegex or mode, mode auto finds them by size; depth takes the frames up to that " +
            "level. A frame up to a quarter taller than a standard screen is a wrapper, not a board, when most such " +
            "frames hold exactly one frame of the exact standard size and the same width: the screens inside are " +
            "the boards. A frame size is also a wrapper when at least 90% of its frames each hold exactly one screen, of any exact standard size, as a direct child, centred with equal gaps on opposite sides (within 2 px) of at most 200 px. " +
            "For the ends of a connector a screen's wrapper is looser: its parent frame when that frame holds only that screen, centred within 2 px with gaps up to 400 px. An end within maxDistance of the wrapper, or of one of the screen's overlays, is a candidate for the screen, and the nearest screen by true distance wins. distance is measured to the screen and may exceed maxDistance. " +
            "Direction is read only from heads: arrow caps on strokes, a head shape on the path, or a head grouped with the line. Bare bars and unions of rectangles read none by design; designers who want machine-readable flows should use line-arrow caps or prototype links. " +
            "selection says what was selected; nestedSameSize counts the boards that sit in a chain of frames of their own size; the board of a chain is the frame that matches boardNameRegex, else the one named like the unwrapped boards of that size, else the outermost. When it is present, deeperBoards counts the visible frames " +
            "below the selected boards. " +
            "An end snaps to the nearest frame and reports it (boardId, boardName). Its screen is found apart " +
            "from that frame: the nearest screen or loose frame (a visible frame outside every screen, such as a " +
            "decision frame) within maxDistance. A frame that holds screens, such as a section, is never that " +
            "target, so an arrow between screens of two sections names both screens. A screen gives screenId and " +
            "screenName. A loose frame, or nothing in reach, gives nonScreen true and no screen keys. The connector " +
            "is kept, and nonScreenEnds counts such ends. " +
            "A connector whose two ends lie in the same screen, such as a divider between two frames of one " +
            "screen, is dropped by default, and sameScreenSkipped counts them. includeSameScreen true returns " +
            "them, each with sameScreen true. " +
            "A shape that lies wholly inside a frame that holds no other frame is skipped. " +
            "Candidates are the visible paths and booleans, shallowest first: boolean children and hidden shapes are " +
            "skipped, and an arrow cap decides the direction only on an open path. A group drawn as an arrow is a " +
            "candidate too: 2 to 6 rects, circles, paths or booleans (no text, no frame) in a group with a long thin " +
            "box, for example a rect shaft and a triangle head. It must have the anatomy of one arrow: a shaft " +
            "that spans most of the group, and every other part at an end of the shaft. It is one connector with " +
            "composed true, and its children are not candidates of their own. Any other group, such as a row of " +
            "arrows, is no arrow: its paths are candidates. An arrow drawn inside a screen is found: an end that " +
            "snaps to no frame takes its screen in place of the frame. " +
            "withinId (a shape id) limits the scan to the shapes under that shape, for a large page scanned one " +
            "section at a time. " +
            "scanned is the number of candidates looked at. " +
            "connectors lists each one with its id, name, type, length (the straight distance between the ends), " +
            "direction, confidence, and from and to, each with boardId, boardName, screenId, screenName, distance " +
            "(from the end to the frame, 0 when it is inside), and x and y of the end. " +
            "direction says how the ends were told apart: cap (an arrow cap on one end of an open path; " +
            "confidence high), shape (a head was found in the outline: a sharp corner at the end of a shaft, " +
            "confidence high or medium), both (a head at each end; " +
            "confidence medium), or none (no head: from is the end further left; confidence none). A shape whose " +
            "head cannot be read has direction none: take the direction then from other evidence, such as labels " +
            "or the order of the screens. A rounded or " +
            "blunt tip, and a 90 degree head on a long shaft, are read too, with confidence medium. Two tips make " +
            "both only when they point opposite ways at the two ends of the outline; a short arrow with a wide " +
            "head has one head. " +
            "When direction is cap or shape, to is the head end. " +
            "The list is in a fixed order for one revn and one set of arguments. total counts all the connectors " +
            "found. A reply holds whole connectors only, as many as fit the reply size cap and limit. When more " +
            "remain, truncated is true and nextOffset is set: call again with offset set to nextOffset until no " +
            "nextOffset comes back to read every connector once, while revn stays the same and no reply has " +
            "timedOut. timedOut true means the scan ran out of time: the reply is not complete, carries a note that says so, has no " +
            "nextOffset and cannot be continued, and total is what it found. Start again with a narrower call, with withinId " +
            "or boardNameRegex. " +
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
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.withinId !== undefined ? { withinId: args.withinId } : {}),
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.boardNameRegex !== undefined ? { boardNameRegex: args.boardNameRegex } : {}),
            ...(args.includeSameScreen !== undefined ? { includeSameScreen: args.includeSameScreen } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "find-mcp-connectors", params);
        return this.pagedJsonResponse(
            response,
            "connectors",
            args.offset ?? 0,
            "a smaller scan with withinId or boardNameRegex"
        );
    }
}
