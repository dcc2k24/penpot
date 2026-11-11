import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";

/** Arguments of {@link FindShapesTool}. */
export class FindShapesArgs {
    /** Shape types a search may match, with the aliases that the adapter maps to backend names. */
    static readonly TYPES = [
        "frame",
        "board",
        "rect",
        "ellipse",
        "circle",
        "text",
        "path",
        "group",
        "bool",
        "image",
        "svg-raw",
    ] as const;

    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file to search, from list_files."),
        pageId: BackendIds.uuid()
            .optional()
            .describe("Id of the one page to search. Leave it out to search every page, one page at a time."),
        type: z
            .enum(FindShapesArgs.TYPES)
            .optional()
            .describe(
                "Shape type to match: frame, rect, ellipse, text, path, bool, group, image or svg-raw. " +
                    "board is accepted as frame, and circle as ellipse."
            ),
        nameRegex: z.string().max(250).optional().describe("Regular expression that the shape name must match."),
        name: z.string().max(250).optional().describe("Exact shape name to match."),
        componentId: BackendIds.uuid().optional().describe("Id of a component; matches its instances."),
        hasToken: z
            .boolean()
            .optional()
            .describe("true matches shapes that use at least one design token; false matches shapes that use none."),
        textContains: z.string().max(250).optional().describe("Text that the characters of a text shape contain."),
        withinId: BackendIds.uuid().optional().describe("Id of a shape; only search its descendants."),
        colors: z
            .array(z.string().min(1).max(32))
            .max(50)
            .optional()
            .describe(
                "Hex colors, such as #ff0000, of up to 32 characters each; at most 50 colors. " +
                    "Matches shapes that use any of them."
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Maximum number of matches (1 to 1000, default 100)."),
        cursor: z
            .string()
            .min(1)
            .max(4096)
            .optional()
            .describe(
                "nextCursor of an earlier reply, to go on after the matches that reply held. " +
                    "Send the same filters with it."
            ),
    };

    fileId!: string;

    pageId?: string;

    type?: string;

    nameRegex?: string;

    name?: string;

    componentId?: string;

    hasToken?: boolean;

    textContains?: string;

    withinId?: string;

    colors?: string[];

    limit?: number;

    cursor?: string;
}

/** Finds shapes by type, name, component, token, text or color. */
export class FindShapesTool extends BackendTool<FindShapesArgs> {
    /**
     * Share of the response cap that the matches of one reply may fill. The backend counts its own encoding of the
     * matches, and the reply adds the fields around them and a cursor, so the matches get less than the whole cap.
     */
    public static readonly MATCH_SHARE = 0.85;

    /** Smallest byte budget the backend accepts for the matches of a reply. */
    private static readonly MIN_MATCH_BYTES = 1000;

    /** Largest byte budget the backend accepts for the matches of a reply. */
    private static readonly MAX_MATCH_BYTES = 1_000_000;

    /** Bytes of matches that the backend may put in one reply, from the response cap. */
    private readonly matchBytes: number;

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, FindShapesArgs.schema, services);
        this.matchBytes = FindShapesTool.matchBytesFor(BackendTool.readMaxResponseBytes(process.env));
    }

    /**
     * Returns the byte budget of the matches of one reply for a response cap. The backend keeps whole matches within
     * it, and gives a cursor when more remain, so the adapter never has to cut a reply that fits the cap.
     *
     * @param capBytes - the response cap of the tool, in bytes
     * @returns the budget the backend is asked for, within the range it accepts
     */
    public static matchBytesFor(capBytes: number): number {
        const budget = Math.floor(capBytes * FindShapesTool.MATCH_SHARE);
        return Math.min(FindShapesTool.MAX_MATCH_BYTES, Math.max(FindShapesTool.MIN_MATCH_BYTES, budget));
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "find_shapes";
    }

    public getToolDescription(): string {
        return (
            "Finds shapes by type, name, regular expression, component, design token, text or color. " +
            "Use type ellipse for ellipses; circle is accepted too. Matches show ellipses as ellipse. " +
            "Use type frame for boards; board is accepted too. Matches show boards as frame. " +
            "Each match carries its id, page id and a path such as Board / Group / Shape. " +
            "A search that ends early still returns the matches it found. truncated true means the list is " +
            "incomplete: reason says why (size: the reply is full, limit: the limit is reached, time: the search " +
            "budget of five seconds ran out), scanned counts the shapes the call looked at, and nextCursor goes " +
            "back in cursor, with the same filters, to get the next matches. " +
            "skippedLarge counts matches left out because one match alone is too large for a reply, and " +
            "skippedLargeIds lists the first ones: read such a shape with get_shapes or export_subtree. " +
            "Next: get_shapes with the ids you need."
        );
    }

    protected async executeBackend(args: FindShapesArgs, userToken: string): Promise<ToolResponse> {
        const { fileId, ...filters } = args;
        const params: Record<string, unknown> = { fileId, maxBytes: this.matchBytes };
        for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined) {
                params[key] = value;
            }
        }
        if (typeof params.type === "string") {
            params.type = BackendShapeTypes.toBackendType(params.type);
        }
        const response = await this.callCommand<{ matches?: unknown } | undefined>(
            userToken,
            "find-mcp-shapes",
            params
        );
        const matches = Array.isArray(response?.matches)
            ? response.matches.map((match) => BackendShapeTypes.toCallerShape(match))
            : response?.matches;
        return this.jsonResponse({ ...response, matches });
    }
}
