import { z } from "zod";
import sharp, { type Sharp } from "sharp";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { ImageContent, TextContent, TextResponse, ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { ExporterError, type ExportFormat, type RenderedFile } from "../../backend/ExporterClient";
import { ExportConcurrency } from "../../utils/ExportConcurrency";
import { ExportDirectory } from "../../utils/ExportDirectory";
import { FileUtils } from "../../utils/FileUtils";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";

/** Largest image returned inline in the response, in bytes. Larger images need filePath. */
const IMAGE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest number of root shapes that one page export renders. The exporter renders one shape per call, so a page
 * export makes one call per root shape.
 */
const PAGE_MAX_SHAPES = 10;

/** Largest total of rendered bytes that one page export returns inline, in bytes. */
const PAGE_OUTPUT_MAX_BYTES = IMAGE_OUTPUT_MAX_BYTES;

/** Arguments of {@link ExportShapeBackendTool}. */
export class ExportShapeBackendArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        pageId: BackendIds.uuid().describe("Id of the page that holds the shape, from get_file_outline."),
        shapeId: z
            .union([BackendIds.uuid(), z.literal("page")])
            .describe(
                "Id of the shape to export, from get_page_tree or find_shapes. " +
                    "Use 'page' for the root shapes of the page, one image each, up to the first 10."
            ),
        format: z
            .enum(["png", "svg", "jpeg", "webp", "pdf"])
            .optional()
            .describe("Output format: png (default), svg, jpeg, webp or pdf."),
        scale: z.number().positive().max(10).optional().describe("Scale factor, above 0 and up to 10. Default 1."),
        mode: z
            .enum(["shape", "fill"])
            .optional()
            .describe(
                "'shape' (default) exports the shape as it is rendered, with its children. " +
                    "'fill' exports the raw image of the shape's image fill, or the image of an image shape."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path to save the exported file to, inside the export directory (PENPOT_MCP_EXPORT_DIR, " +
                    "the home directory by default). When omitted, the file is returned in the response."
            ),
    };

    fileId!: string;

    pageId!: string;

    shapeId!: string;

    format?: ExportFormat;

    scale?: number;

    mode?: "shape" | "fill";

    filePath?: string;
}

/** Exports a shape, the root shapes of a page or a shape's image fill as an image, text or file. */
export class ExportShapeBackendTool extends BackendTool<ExportShapeBackendArgs> {
    /**
     * Creates the tool. The filePath argument is offered only when file system access is enabled.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, exporter and render sessions shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ExportShapeBackendTool.schemaFor(mcpServer.isFileSystemAccessEnabled()), services);
    }

    /**
     * Returns the argument schema, without the filePath key when file system access is off.
     *
     * @param fileSystemAccess - whether the server offers file system access
     */
    private static schemaFor(fileSystemAccess: boolean): z.ZodRawShape {
        if (fileSystemAccess) {
            return ExportShapeBackendArgs.schema;
        }
        // leave the filePath key out of the copy
        const { filePath: _filePath, ...withoutFilePath } = ExportShapeBackendArgs.schema;
        return withoutFilePath;
    }

    public getToolName(): string {
        return "export_shape";
    }

    public getToolDescription(): string {
        let description =
            "Exports a shape as png, svg, jpeg, webp or pdf. When shapeId is 'page', it exports the root shapes of " +
            "the page, in page order, one image each, up to the first 10; the rest must be exported by id. " +
            "Fill mode exports the raw image of the shape's image fill instead. " +
            "png, jpeg and webp return the image (up to 8 MB), svg returns text, and pdf returns base64 text " +
            "unless filePath is given. A page export returns up to 8 MB in total and does not take filePath.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description +=
                "\nAlternatively, set filePath to save the file instead. " +
                "filePath must lie inside the export directory (PENPOT_MCP_EXPORT_DIR, the home directory by default).";
        }
        return description;
    }

    protected async executeBackend(args: ExportShapeBackendArgs, userToken: string): Promise<ToolResponse> {
        if (args.filePath !== undefined) {
            FileUtils.checkPathIsAbsolute(args.filePath);
            if (!this.mcpServer.isFileSystemAccessEnabled()) {
                throw new Error("File system access is not enabled on the MCP server!");
            }
            ExportDirectory.assertInside(args.filePath, process.env);
        }
        const format = args.format ?? "png";
        const scale = args.scale ?? 1;
        const fill = (args.mode ?? "shape") === "fill";
        if (args.shapeId === "page" && !fill) {
            return this.renderPage(args, userToken, format, scale);
        }
        const file = fill
            ? await this.renderFill(args, userToken, format)
            : await this.renderShape(args, userToken, format, scale);
        return this.outputFile(file, format, args.filePath);
    }

    /**
     * Renders one shape through the exporter.
     *
     * The shape is first checked to be on the page, so that a wrong pageId fails at once and not in the exporter.
     *
     * @param args - the validated tool arguments; the shape id is not "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @returns the rendered bytes and their media type
     * @throws Error when the page does not hold the shape
     */
    private async renderShape(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat,
        scale: number
    ): Promise<RenderedFile> {
        const { profileId } = await this.services.validator.validate(userToken);
        // one cheap read, asking for the id only
        await this.readShape(userToken, args.fileId, args.pageId, args.shapeId, ["id"]);
        return ExportConcurrency.withBackendPermit(() =>
            this.withRenderSession(userToken, args.fileId, (renderToken) =>
                this.services.exporter.exportShape(renderToken, {
                    fileId: args.fileId,
                    pageId: args.pageId,
                    objectId: args.shapeId,
                    format,
                    scale,
                    profileId,
                    name: "export",
                })
            )
        );
    }

    /**
     * Renders the root shapes of a page, one exporter call each, and returns them in page order.
     *
     * The exporter renders one shape per call and has no mode for a whole page. The root shapes are read first, so
     * a page with no shapes fails here and not in the exporter. At most {@link PAGE_MAX_SHAPES} root shapes are
     * rendered, and the rendered images stop before their total passes {@link PAGE_OUTPUT_MAX_BYTES}.
     *
     * @param args - the validated tool arguments; the shape id is "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @returns a text line with the counts, then for each rendered shape a text line with its id and the content
     * @throws Error when a filePath is given, the page has no shapes, or the first root shape is above the byte limit
     */
    private async renderPage(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat,
        scale: number
    ): Promise<ToolResponse> {
        if (args.filePath !== undefined) {
            throw new Error(
                "filePath is not supported with shapeId page. Export one shape by id to save it to a file."
            );
        }
        const { profileId } = await this.services.validator.validate(userToken);
        const roots = await this.rootShapesOf(userToken, args.fileId, args.pageId);
        if (roots.shapes.length === 0) {
            throw new Error(`page ${args.pageId} of file ${args.fileId} has no shapes to export`);
        }
        const items: Array<TextContent | ImageContent> = [];
        let renderedBytes = 0;
        let rendered = 0;
        let cutByBytes = false;
        for (const root of roots.shapes.slice(0, PAGE_MAX_SHAPES)) {
            const file = await ExportConcurrency.withBackendPermit(() =>
                this.withRenderSession(userToken, args.fileId, (renderToken) =>
                    this.services.exporter.exportShape(renderToken, {
                        fileId: args.fileId,
                        pageId: args.pageId,
                        objectId: root.id,
                        format,
                        scale,
                        profileId,
                        name: "export",
                    })
                )
            );
            if (renderedBytes + file.bytes.length > PAGE_OUTPUT_MAX_BYTES) {
                if (rendered === 0) {
                    const megabytes = (file.bytes.length / (1024 * 1024)).toFixed(1);
                    throw new Error(
                        `The first root shape of the page is ${megabytes} MB, above the 8 MB limit for page output. ` +
                            "Export that shape by id at a smaller scale."
                    );
                }
                cutByBytes = true;
                break;
            }
            renderedBytes += file.bytes.length;
            rendered++;
            items.push(new TextContent(`Shape ${root.id} (${root.type}) "${root.name}"`));
            items.push(ExportShapeBackendTool.inlineItem(file, format));
        }
        let header = `Page ${args.pageId}: exported ${rendered} of ${roots.total} root shapes, in page order.`;
        if (cutByBytes) {
            header +=
                " Stopped before the total would pass the 8 MB limit for page output. " +
                "Export the rest by id, or at a smaller scale.";
        } else if (rendered < roots.total) {
            header += ` Only the first ${PAGE_MAX_SHAPES} are rendered per call. Export the rest by id.`;
        }
        return new ToolResponse([new TextContent(header), ...items]);
    }

    /**
     * Reads the root shapes of a page, the children of the page root, in page order.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the page
     * @param pageId - id of the page
     * @returns the root shapes that the backend listed, and the number of root shapes the page holds
     * @throws Error when the backend does not hold the page; other backend errors pass through unchanged
     */
    private async rootShapesOf(
        userToken: string,
        fileId: string,
        pageId: string
    ): Promise<{ shapes: Array<{ id: string; type: string; name: string }>; total: number }> {
        const answer = await this.callCommand<{ root?: unknown } | undefined>(userToken, "get-mcp-page-tree", {
            fileId,
            pageId,
            depth: 2,
            limit: 5000,
            fields: ["name"],
        });
        const root = ExportShapeBackendTool.recordOf(answer?.root);
        const listed: unknown = root?.children;
        const shapes = (Array.isArray(listed) ? listed : [])
            .map((node) => ExportShapeBackendTool.recordOf(node))
            .filter((node): node is Record<string, unknown> => typeof node?.id === "string")
            .map((node) => ({
                id: node.id as string,
                type: BackendShapeTypes.toCallerType(typeof node.type === "string" ? node.type : "unknown"),
                name: typeof node.name === "string" ? node.name : "",
            }));
        const total = typeof root?.childCount === "number" ? root.childCount : shapes.length;
        return { shapes, total };
    }

    /**
     * Downloads the image of a shape fill and converts it to the requested format.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @returns the image bytes and their media type
     * @throws Error when the shape is a page, has no image, or the format cannot hold a fill image
     */
    private async renderFill(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat
    ): Promise<RenderedFile> {
        if (args.shapeId === "page") {
            throw new Error("Fill mode needs a shape id, not page.");
        }
        const shape = await this.readShape(userToken, args.fileId, args.pageId, args.shapeId);
        const mediaId = ExportShapeBackendTool.imageIdOf(shape);
        if (mediaId === undefined) {
            throw new Error("The shape has no image fill or image content to export.");
        }
        const downloaded = await ExportConcurrency.withBackendPermit(() =>
            this.withRenderSession(userToken, args.fileId, (renderToken) =>
                this.services.exporter.downloadAsset(renderToken, mediaId)
            )
        );
        return ExportShapeBackendTool.convertFill(downloaded, format);
    }

    /**
     * Reads one shape of a page from the backend.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the shape
     * @param pageId - id of the page that holds the shape
     * @param shapeId - id of the shape to read
     * @param fields - attributes to return per shape; undefined returns the whole shape
     * @returns the shape as the backend returns it
     * @throws Error when the page does not hold the shape; other backend errors pass through unchanged
     */
    private async readShape(
        userToken: string,
        fileId: string,
        pageId: string,
        shapeId: string,
        fields?: string[]
    ): Promise<Record<string, unknown>> {
        const answer = await this.callCommand<{ shapes?: unknown }>(userToken, "get-mcp-shapes", {
            fileId,
            pageId,
            ids: [shapeId],
            ...(fields !== undefined ? { fields } : {}),
        });
        const listed: unknown = answer?.shapes;
        const shapes = Array.isArray(listed) ? listed : [];
        const shape = shapes
            .map((candidate) => ExportShapeBackendTool.recordOf(candidate))
            .find((candidate) => candidate?.id === shapeId);
        if (shape === undefined) {
            throw new Error(
                `shape ${shapeId} is not on page ${pageId} of file ${fileId}; ` +
                    "check pageId with find_shapes or get_page_tree"
            );
        }
        return shape;
    }

    /**
     * Runs an exporter or backend call with a render session, and retries it once when the session is refused.
     *
     * A 401 answer drops the render session of the file, so that the retry is made with a fresh one.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that the render session renders
     * @param call - the exporter or backend call, given the render session token
     * @returns the value of the call
     * @throws the error of the call when it fails again, or for any other failure
     */
    private async withRenderSession<T>(
        userToken: string,
        fileId: string,
        call: (renderToken: string) => Promise<T>
    ): Promise<T> {
        const renderToken = await this.services.renderSessions.tokenFor(userToken, fileId);
        try {
            return await call(renderToken);
        } catch (error) {
            if (!(error instanceof ExporterError && error.status === 401)) {
                throw error;
            }
            this.services.renderSessions.invalidate(userToken, fileId);
            return call(await this.services.renderSessions.tokenFor(userToken, fileId));
        }
    }

    /**
     * Builds the tool response for a rendered file, or saves it to the requested path.
     *
     * A saved file answers with `{savedTo, bytes, format}`. A pdf answers with `{format, bytes, base64}`. An
     * image answers as image content, and is refused above 8 MB, where filePath must be used instead.
     *
     * @param file - the bytes and media type to return
     * @param format - the output format
     * @param filePath - absolute path to save to, or undefined to return the file
     * @returns the response of the tool
     * @throws Error when an image is above the inline limit
     */
    private outputFile(file: RenderedFile, format: ExportFormat, filePath: string | undefined): ToolResponse {
        const bytes = Buffer.from(file.bytes);
        if (filePath !== undefined) {
            if (format === "svg") {
                FileUtils.writeTextFile(filePath, bytes.toString("utf8"));
            } else {
                FileUtils.writeBinaryFile(filePath, file.bytes);
            }
            return new TextResponse(JSON.stringify({ savedTo: filePath, bytes: bytes.length, format }, null, 2));
        }
        if (format !== "svg" && format !== "pdf" && bytes.length > IMAGE_OUTPUT_MAX_BYTES) {
            const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
            throw new Error(
                `The image is ${megabytes} MB, above the 8 MB limit for image output. ` +
                    "Pass filePath to save it, or export at a smaller scale."
            );
        }
        return new ToolResponse([ExportShapeBackendTool.inlineItem(file, format)]);
    }

    /**
     * Builds the inline content of one rendered file: the text of an svg, JSON with the base64 bytes of a pdf, or
     * an image.
     *
     * @param file - the bytes and media type of the rendered file
     * @param format - the output format
     * @returns the content item to return to the client
     */
    private static inlineItem(file: RenderedFile, format: ExportFormat): TextContent | ImageContent {
        const bytes = Buffer.from(file.bytes);
        if (format === "svg") {
            return new TextContent(bytes.toString("utf8"));
        }
        if (format === "pdf") {
            return new TextContent(
                JSON.stringify({ format, bytes: bytes.length, base64: bytes.toString("base64") }, null, 2)
            );
        }
        const mimeType = file.mimeType !== "" ? file.mimeType : `image/${format}`;
        return new ImageContent(bytes.toString("base64"), mimeType);
    }

    /**
     * Converts a downloaded fill image to the requested format, keeping the bytes when they already match.
     *
     * @param file - the downloaded fill image
     * @param format - the requested format
     * @returns the image in the requested format
     * @throws Error when the format is pdf, or when an svg is requested for a fill that is not an svg image
     */
    private static async convertFill(file: RenderedFile, format: ExportFormat): Promise<RenderedFile> {
        if (format === "pdf") {
            throw new Error("Fill mode does not export PDF.");
        }
        if (format === "svg") {
            if (file.mimeType !== "image/svg+xml") {
                throw new Error("The fill is not an SVG image.");
            }
            return file;
        }
        if (file.mimeType === `image/${format}`) {
            return file;
        }
        // encode with sharp; the format is png, jpeg or webp here
        const pipeline: Sharp = sharp(file.bytes);
        const encoded = format === "png" ? pipeline.png() : format === "jpeg" ? pipeline.jpeg() : pipeline.webp();
        const converted = await encoded.toBuffer();
        return { bytes: new Uint8Array(converted), mimeType: `image/${format}` };
    }

    /**
     * Finds the id of the image that a shape shows, from its image content or its first image fill.
     *
     * @param shape - the shape as the backend returns it
     * @returns the media id, or undefined when the shape has no image
     */
    private static imageIdOf(shape: Record<string, unknown>): string | undefined {
        if (shape.type === "image") {
            const metadataId = ExportShapeBackendTool.recordOf(shape.metadata)?.id;
            if (typeof metadataId === "string") {
                return metadataId;
            }
        }
        const fills = Array.isArray(shape.fills) ? shape.fills : [];
        for (const fill of fills) {
            const fillRecord = ExportShapeBackendTool.recordOf(fill);
            const image = ExportShapeBackendTool.recordOf(fillRecord?.fillImage ?? fillRecord?.["fill-image"]);
            if (typeof image?.id === "string") {
                return image.id;
            }
        }
        return undefined;
    }

    /**
     * Views a value as a record when it is a plain object.
     *
     * @param value - the value to view
     * @returns the value as a record, or undefined when it is not an object or is an array
     */
    private static recordOf(value: unknown): Record<string, unknown> | undefined {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return undefined;
    }
}
