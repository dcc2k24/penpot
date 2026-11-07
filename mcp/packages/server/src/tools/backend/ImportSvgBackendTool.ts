import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";

/** Arguments of {@link ImportSvgBackendTool}. */
export class ImportSvgBackendArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file that receives the shapes, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page that receives the shapes, from get_file_outline."),
        svg: z.string().min(1).max(5_000_000).describe("SVG markup to convert into shapes. Up to 5 MB."),
        parentId: BackendIds.uuid()
            .optional()
            .describe("Id of the board or group that receives the shapes. Default: the page root."),
        x: z.number().optional().describe("X position of the new root shape."),
        y: z.number().optional().describe("Y position of the new root shape."),
        name: z.string().min(1).max(250).optional().describe("Name of the new root shape."),
        dryRun: z
            .boolean()
            .optional()
            .describe("When true, convert the SVG and validate the result without saving it."),
        requestId: WriteOptions.schema.requestId,
    };

    fileId!: string;

    pageId!: string;

    svg!: string;

    parentId?: string;

    x?: number;

    y?: number;

    name?: string;

    dryRun?: boolean;

    requestId?: string;
}

/** Converts SVG markup into shapes on a page of a file. */
export class ImportSvgBackendTool extends BackendTool<ImportSvgBackendArgs> {
    /**
     * Creates the SVG import tool.
     *
     * @param mcpServer - The MCP server instance
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ImportSvgBackendArgs.schema, services);
    }

    public getToolName(): string {
        return "import_svg";
    }

    public getToolDescription(): string {
        return (
            "Converts SVG markup into shapes on a page of a file. " +
            "Returns the id of the new root shape and the ids of the shapes. " +
            "Embedded raster images are not uploaded. " +
            "To add an image, use import_image first, then apply_operations with create_image. " +
            "Set dryRun to true to validate the SVG without saving it. " +
            "Next: get_page_tree to see the new shapes."
        );
    }

    /**
     * Sends the SVG to the backend, with only the optional fields that were set.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: ImportSvgBackendArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            pageId: args.pageId,
            svg: args.svg,
            ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
            ...(args.x !== undefined ? { x: args.x } : {}),
            ...(args.y !== undefined ? { y: args.y } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
            requestId: WriteOptions.requestIdOf(args),
        };
        const result = await this.callWrite(userToken, args.fileId, "mcp-import-svg", params);
        return this.jsonResponse(WriteOptions.withAlreadyApplied(result));
    }
}
