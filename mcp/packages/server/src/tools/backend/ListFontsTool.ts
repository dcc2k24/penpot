import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link ListFontsTool}. */
export class ListFontsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid()
            .optional()
            .describe("Id of one page to read, from get_file_outline. Leave it out to read every page of the file."),
        rootIds: z
            .array(BackendIds.uuid())
            .min(1)
            .max(200)
            .optional()
            .describe(
                "Ids of shapes on pageId (1 to 200 ids). Only the text under these shapes is read. Needs pageId."
            ),
    };

    fileId!: string;

    pageId?: string;

    rootIds?: string[];
}

/** Lists the fonts that the text of a file uses, and tells which of them the file can load. */
export class ListFontsTool extends BackendTool<ListFontsArgs> {
    /**
     * Creates the tool.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ListFontsArgs.schema, services);
    }

    /** Marks the tool as read-only, so that clients run it without a prompt. */
    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    /** Returns the name of the tool as clients call it. */
    public getToolName(): string {
        return "list_fonts";
    }

    /** Returns the description that tells clients what the tool is for and what its fields mean. */
    public getToolDescription(): string {
        return (
            "Lists the fonts used by the text of a file, or of one page, or of some shapes, with what each one is " +
            "and whether it resolves. Run it before an export or a code generation: a font that does not resolve " +
            "renders with a fallback font. " +
            "At most 500 fonts come back. fonts is sorted by runs (how many text runs use the font), then by fontId. " +
            "Each font has fontId, family, source (builtin, google, custom or unknown), resolved, reason when it is " +
            "not resolved, runs, shapes (text shapes that use it), pages (runs per page) and variants. " +
            "Runs of one face are merged into one variant, under the font's own variantId. " +
            "Each variant has variantId, weight, style, runs, resolved, reason when it is not resolved, and url " +
            "to the font file when there is one. " +
            "reason says why: not-in-google-catalog, google-fonts-disabled, custom-font-not-in-team, unknown-font-id " +
            "or variant-not-found. unresolved counts the fonts that do not resolve. truncated true means the read " +
            "ran out of time, the reply holds more than 500 fonts, or the reply reached the response size; " +
            "only what was read is listed. " +
            "Attribute names in the response are camelCase. " +
            "Next: fix the unresolved fonts in the design, then export_shape or get_shapes."
        );
    }

    /**
     * Sends the font read to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when rootIds is given without pageId
     */
    protected async executeBackend(args: ListFontsArgs, userToken: string): Promise<ToolResponse> {
        if (args.rootIds !== undefined && args.pageId === undefined) {
            throw new Error("rootIds needs pageId: name the page that holds the shapes.");
        }
        const params = {
            fileId: args.fileId,
            ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
            ...(args.rootIds !== undefined ? { rootIds: args.rootIds } : {}),
        };
        const response = await this.callCommand<unknown>(userToken, "get-mcp-fonts", params);
        return this.jsonResponse(response);
    }
}
