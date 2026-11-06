import { z } from "zod";
import { Tool } from "../Tool";
import { ImageContent, PNGResponse, TextContent, TextResponse, ToolResponse } from "../ToolResponse";
import "reflect-metadata";
import { PenpotMcpServer } from "../PenpotMcpServer";
import { ExecuteCodePluginTask } from "../tasks/ExecuteCodePluginTask";
import { ExportConcurrency } from "../utils/ExportConcurrency";
import { FileUtils } from "../utils/FileUtils";
import { ExportDirectory } from "../utils/ExportDirectory";
import sharp from "sharp";

/**
 * Arguments class for ExportShapeTool
 */
export class ExportShapeArgs {
    static schema = {
        shapeId: z
            .string()
            .min(1, "shapeId cannot be empty")
            .describe(
                "Identifier of the shape to export. " +
                    "Special identifiers you can use: 'selection' (first shape currently selected by the user), 'page' (entire current page)"
            ),
        format: z.enum(["svg", "png"]).default("png").describe("The output format, either 'png' (default) or 'svg'."),
        mode: z
            .enum(["shape", "fill"])
            .default("shape")
            .describe(
                "The export mode: either 'shape' (full shape as it appears in the design, including descendants; the default) or " +
                    "'fill' (export the raw image that is used as a fill for the shape; PNG format only)"
            ),
        filePath: z
            .string()
            .optional()
            .describe(
                "Optional file path to save the exported image to. If not provided, " +
                    "the image data is returned directly for you to see."
            ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    shapeId!: string;

    format: "svg" | "png" = "png";

    mode: "shape" | "fill" = "shape";

    filePath?: string;

    sessionId?: string;
}

/**
 * Tool for executing JavaScript code in the Penpot plugin context
 */
export class ExportShapeTool extends Tool<ExportShapeArgs> {
    /**
     * Creates a new ExecuteCode tool instance.
     *
     * @param mcpServer - The MCP server instance
     * @param toolName - The name the tool is registered under; `export_shape_from_tab` when backend tools own the plain name
     */
    constructor(
        mcpServer: PenpotMcpServer,
        private readonly toolName: string = "export_shape"
    ) {
        let schema: any = ExportShapeArgs.schema;
        if (!mcpServer.isFileSystemAccessEnabled()) {
            // remove filePath key from schema
            schema = { ...schema };
            delete schema.filePath;
        }
        super(mcpServer, schema);
    }

    public getToolName(): string {
        return this.toolName;
    }

    public getToolDescription(): string {
        let description =
            "Exports a shape (or a shape's image fill) from the Penpot design to a PNG or SVG image, " +
            "such that you can get an impression of what it looks like.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description += "\nAlternatively, you can save it to a file.";
        }
        return description;
    }

    protected async executeCore(args: ExportShapeArgs): Promise<ToolResponse> {
        // bound concurrent exports in multi-user mode to keep peak server memory under control;
        // in single-user mode (or when no limit is configured) the gate is irrelevant
        // and the export runs directly
        if (this.mcpServer.isMultiUserMode()) {
            return ExportConcurrency.withPermit(() => this.exportImage(args));
        } else {
            return this.exportImage(args);
        }
    }

    /**
     * Performs the actual image export: requests the image via the plugin and either
     * returns it as a tool response or saves it to the requested file path. The bulk
     * of the memory pressure (parsed plugin response, decoded image buffer, optional
     * re-encoding via sharp) lives here, which is why executeCore gates the call.
     *
     * @param args - the validated tool arguments
     */
    private async exportImage(args: ExportShapeArgs): Promise<ToolResponse> {
        // check arguments
        if (args.filePath) {
            FileUtils.checkPathIsAbsolute(args.filePath);
            ExportDirectory.assertInside(args.filePath, process.env);
        }

        // create code for exporting the shape
        let shapeCode: string;
        if (args.shapeId === "selection") {
            shapeCode = `penpot.selection[0]`;
        } else if (args.shapeId === "page") {
            shapeCode = `penpot.root`;
        } else {
            shapeCode = `penpotUtils.findShapeById("${args.shapeId}")`;
        }
        const asSvg = args.format === "svg";
        const code = `return penpotUtils.exportImage(${shapeCode}, "${args.mode}", ${asSvg});`;

        // execute the code and obtain the image data
        const task = new ExecuteCodePluginTask({ code: code });
        const result = await this.mcpServer.pluginBridge.executePluginTask(task, args.sessionId);
        const imageData = result.data!.result;

        // handle output and return response
        if (!args.filePath) {
            // return image data directly (for the LLM to "see" it)
            if (args.format === "png") {
                return new PNGResponse(await this.toPngImageBytes(imageData));
            } else {
                return TextResponse.fromData(imageData);
            }
        } else {
            // save to file requested: make sure file system access is enabled
            if (!this.mcpServer.isFileSystemAccessEnabled()) {
                throw new Error("File system access is not enabled on the MCP server!");
            }
            // save to file
            if (args.format === "png") {
                FileUtils.writeBinaryFile(args.filePath, await this.toPngImageBytes(imageData));
            } else {
                FileUtils.writeTextFile(args.filePath, TextContent.textData(imageData));
            }
            return new TextResponse(`The shape has been exported to ${args.filePath}`);
        }
    }

    /**
     * Converts image data to PNG format if necessary.
     *
     * @param data - The original image data as Uint8Array or as object (from JSON conversion of Uint8Array)
     * @return The image data as PNG bytes
     */
    private async toPngImageBytes(data: Uint8Array | object): Promise<Uint8Array> {
        const originalBytes = ImageContent.byteData(data);

        // use sharp to detect format and convert to PNG if necessary
        const image = sharp(originalBytes);
        const metadata = await image.metadata();

        // if already PNG, return as-is to avoid unnecessary re-encoding
        if (metadata.format === "png") {
            return originalBytes;
        }

        // convert to PNG
        const pngBuffer = await image.png().toBuffer();
        return new Uint8Array(pngBuffer);
    }
}
