import { z } from "zod";
import sharp, { type Sharp } from "sharp";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { ImageContent, TextContent, TextResponse, ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { ExporterError, type ExportFormat, type RenderedFile } from "../../backend/ExporterClient";
import { TokenDigest } from "../../backend/TokenDigest";
import { CallContext } from "../../backend/CallContext";
import { ExportConcurrency } from "../../utils/ExportConcurrency";
import { ExportDirectory } from "../../utils/ExportDirectory";
import { FileUtils } from "../../utils/FileUtils";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { BackendShapeTypes } from "./BackendShapeTypes";
import { FilePathAccess } from "./FilePathAccess";

/** Largest raster image returned inline in the response, in bytes. Larger images need filePath. */
const IMAGE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/** Largest svg or pdf file returned inline, in bytes. Larger files need filePath. */
const TEXT_OUTPUT_MAX_BYTES = 256_000;

/** Most pixels a raster export may have: the shape box times the scale. */
const RASTER_MAX_PIXELS = 16_000_000;

/**
 * Largest number of root shapes that one page export renders. The exporter renders one shape per call, so a page
 * export makes one call per root shape.
 */
const PAGE_MAX_SHAPES = 10;

/** Largest total of rendered bytes that one page export returns inline, in bytes. */
const PAGE_OUTPUT_MAX_BYTES = IMAGE_OUTPUT_MAX_BYTES;

/** File name extensions that each format may be saved with. */
const EXTENSIONS: Record<ExportFormat, readonly string[]> = {
    png: [".png"],
    jpeg: [".jpg", ".jpeg"],
    webp: [".webp"],
    svg: [".svg"],
    pdf: [".pdf"],
};

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
                    "or penpot-exports in the home directory by default). The file name must end in the format's " +
                    "extension. When omitted, the file is returned in the response."
            ),
        overwrite: z
            .boolean()
            .optional()
            .describe("When true, replace the file at filePath if one is there. Default false: it is refused."),
    };

    fileId!: string;

    pageId!: string;

    shapeId!: string;

    format?: ExportFormat;

    scale?: number;

    mode?: "shape" | "fill";

    filePath?: string;

    overwrite?: boolean;
}

/** Exports a shape, the root shapes of a page or a shape's image fill as an image, text or file. */
export class ExportShapeBackendTool extends BackendTool<ExportShapeBackendArgs> {
    /**
     * Creates the tool. The filePath and overwrite arguments are offered only when file system access is enabled.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, exporter and render sessions shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        // the file keys stay in the schema even in multi-user mode, so that a call with them is refused and not stripped
        super(mcpServer, ExportShapeBackendArgs.schema, services);
    }

    public getToolName(): string {
        return "export_shape";
    }

    public getToolDescription(): string {
        let description =
            "Exports a shape as png, svg, jpeg, webp or pdf. When shapeId is 'page', it exports the root shapes of " +
            "the page, in page order, one image each, up to the first 10; the rest must be exported by id. " +
            "Fill mode exports the raw image of the shape's image fill instead. " +
            "png, jpeg and webp return the image (up to 8 MB, and up to 16 million pixels: the shape box times the " +
            "scale). svg and pdf return text (pdf as base64 JSON), up to 256 kB. " +
            "A page export returns up to 8 MB in total and does not take filePath.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description +=
                "\nAlternatively, set filePath to save the file instead. filePath must lie inside the export " +
                "directory (PENPOT_MCP_EXPORT_DIR, or penpot-exports in the home directory by default), end in the " +
                "format's extension, and not replace a file unless overwrite is true.";
        } else {
            description += "\nIn multi-user mode file paths are off, so a filePath is refused.";
        }
        return description;
    }

    protected async executeBackend(args: ExportShapeBackendArgs, userToken: string): Promise<ToolResponse> {
        const format = args.format ?? "png";
        const scale = args.scale ?? 1;
        if (args.filePath !== undefined) {
            this.checkFilePath(args.filePath, args.overwrite === true, format);
        }
        const fill = (args.mode ?? "shape") === "fill";
        if (args.shapeId === "page" && !fill) {
            return this.renderPage(args, userToken, format, scale);
        }
        const file = fill
            ? await this.renderFill(args, userToken, format)
            : await this.renderShape(args, userToken, format, scale);
        return this.outputFile(file, format, args.filePath, args.overwrite === true);
    }

    /**
     * Checks a path that the tool is asked to save to, before anything is exported.
     *
     * @param filePath - the path the caller gave
     * @param overwrite - whether an existing file may be replaced
     * @param format - the output format, which fixes the extension
     * @throws Error when the path is relative, outside the export directory, has a link on the way, has the wrong
     *   extension, or names a file that exists and may not be replaced
     */
    private checkFilePath(filePath: string, overwrite: boolean, format: ExportFormat): void {
        FilePathAccess.assertAllowed(this.mcpServer);
        FileUtils.checkPathIsAbsolute(filePath);
        ExportDirectory.assertInside(filePath, process.env);
        ExportDirectory.assertExtension(filePath, EXTENSIONS[format]);
        if (!overwrite) {
            ExportDirectory.assertAbsent(filePath);
        }
    }

    /**
     * Renders one shape through the exporter.
     *
     * The shape is first read, so that a wrong pageId fails at once and not in the exporter, and so that a raster
     * above the pixel limit is refused before it is rendered.
     *
     * @param args - the validated tool arguments; the shape id is not "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @returns the rendered bytes and their media type
     * @throws Error when the page does not hold the shape, or the raster would be too large
     */
    private async renderShape(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat,
        scale: number
    ): Promise<RenderedFile> {
        const { profileId } = await this.services.validator.validate(userToken);
        const shape = await this.readShape(userToken, args.fileId, args.pageId, args.shapeId, [
            "id",
            "width",
            "height",
        ]);
        ExportShapeBackendTool.assertRasterSize(shape, scale, format);
        return this.renderObject(userToken, args, args.shapeId, format, scale, profileId);
    }

    /**
     * Renders the root shapes of a page, one exporter call each, and returns them in page order.
     *
     * The root shapes are read first, so a page with no shapes fails here and not in the exporter. At most
     * {@link PAGE_MAX_SHAPES} root shapes are rendered. The renders start together, and the permits decide how many
     * run at once. The answer keeps the shapes rendered before the first one that fails, and then says which one
     * failed and makes the response an error.
     *
     * @param args - the validated tool arguments; the shape id is "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @returns a text line with the counts, then for each rendered shape a text line with its id and the content
     * @throws Error when a filePath is given, the page has no shapes, or the first root shape cannot be returned
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
        const chosen = roots.shapes.slice(0, PAGE_MAX_SHAPES);
        const renders = await Promise.allSettled(
            chosen.map(async (root) => {
                ExportShapeBackendTool.assertRasterSize(root, scale, format);
                return this.renderObject(userToken, args, root.id, format, scale, profileId);
            })
        );
        const items: Array<TextContent | ImageContent> = [];
        let renderedBytes = 0;
        let rendered = 0;
        let cut: string | undefined;
        let failure: string | undefined;
        for (let index = 0; index < chosen.length; index++) {
            const root = chosen[index];
            const outcome = renders[index];
            if (outcome.status === "rejected") {
                failure = `Shape ${root.id} could not be exported: ${ExportShapeBackendTool.messageOf(outcome.reason)}.`;
                break;
            }
            const file = outcome.value;
            const overText = (format === "svg" || format === "pdf") && file.bytes.length > TEXT_OUTPUT_MAX_BYTES;
            const overTotal = renderedBytes + file.bytes.length > PAGE_OUTPUT_MAX_BYTES;
            if (overText || overTotal) {
                if (rendered === 0) {
                    throw ExportShapeBackendTool.pageLimitError(file, format, overText);
                }
                cut = overText
                    ? `Stopped at a shape whose ${format} is above the 256 kB limit for inline output.`
                    : "Stopped before the total would pass the 8 MB limit for page output.";
                break;
            }
            renderedBytes += file.bytes.length;
            rendered++;
            items.push(new TextContent(`Shape ${root.id} (${root.type}) "${root.name}"`));
            items.push(ExportShapeBackendTool.inlineItem(file, format));
            this.reportProgress(rendered, chosen.length, `Rendered shape ${root.id}.`);
        }
        if (rendered === 0 && failure !== undefined) {
            throw new Error(failure);
        }
        let header = `Page ${args.pageId}: exported ${rendered} of ${roots.total} root shapes, in page order.`;
        if (cut !== undefined) {
            header += ` ${cut} Export the rest by id, or at a smaller scale.`;
        } else if (rendered < roots.total && failure === undefined) {
            header += ` Only the first ${PAGE_MAX_SHAPES} are rendered per call. Export the rest by id.`;
        }
        if (failure !== undefined) {
            header += ` ${failure} The shapes after it were not exported.`;
        }
        return new ToolResponse([new TextContent(header), ...items], failure !== undefined);
    }

    /**
     * Reads the root shapes of a page, the children of the page root, in page order.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the page
     * @param pageId - id of the page
     * @returns the root shapes that the backend listed, with their boxes, and the number of root shapes the page holds
     * @throws Error when the backend does not hold the page; other backend errors pass through unchanged
     */
    private async rootShapesOf(
        userToken: string,
        fileId: string,
        pageId: string
    ): Promise<{ shapes: RootShape[]; total: number }> {
        const answer = await this.callCommand<{ root?: unknown } | undefined>(userToken, "get-mcp-page-tree", {
            fileId,
            pageId,
            depth: 2,
            limit: 5000,
            fields: ["name", "width", "height"],
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
                width: node.width,
                height: node.height,
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
        const digest = TokenDigest.sha256Hex(userToken);
        const downloaded = await ExportConcurrency.withBackendPermit(digest, (signal) =>
            this.withRenderSession(userToken, args.fileId, (renderToken) =>
                ExportShapeBackendTool.underSignal(signal, () =>
                    this.services.exporter.downloadAsset(renderToken, mediaId)
                )
            )
        );
        return ExportShapeBackendTool.convertFill(downloaded, format);
    }

    /**
     * Asks the exporter for one object of the file, under the permits of the token.
     *
     * @param userToken - the MCP token of the request
     * @param args - the validated tool arguments, which name the file and the page
     * @param objectId - id of the shape to render
     * @param format - the output format
     * @param scale - the scale factor
     * @param profileId - profile that makes the export
     */
    private renderObject(
        userToken: string,
        args: ExportShapeBackendArgs,
        objectId: string,
        format: ExportFormat,
        scale: number,
        profileId: string
    ): Promise<RenderedFile> {
        return ExportConcurrency.withBackendPermit(TokenDigest.sha256Hex(userToken), (signal) =>
            this.withRenderSession(userToken, args.fileId, (renderToken) =>
                ExportShapeBackendTool.underSignal(signal, () =>
                    this.services.exporter.exportShape(renderToken, {
                        fileId: args.fileId,
                        pageId: args.pageId,
                        objectId,
                        format,
                        scale,
                        profileId,
                        name: "export",
                    })
                )
            )
        );
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
     * A saved file answers with `{savedTo, bytes, format}`. A pdf answers with `{format, bytes, base64}`. svg and pdf
     * are refused above 256 kB, and images above 8 MB, where filePath must be used instead.
     *
     * @param file - the bytes and media type to return
     * @param format - the output format
     * @param filePath - absolute path to save to, or undefined to return the file
     * @param overwrite - whether the saved file may replace an existing one
     * @returns the response of the tool
     * @throws Error when the file is above the inline limit
     */
    private outputFile(
        file: RenderedFile,
        format: ExportFormat,
        filePath: string | undefined,
        overwrite: boolean
    ): ToolResponse {
        const bytes = Buffer.from(file.bytes);
        if (filePath !== undefined) {
            const options = { overwrite };
            if (format === "svg") {
                FileUtils.writeTextFile(filePath, bytes.toString("utf8"), options);
            } else {
                FileUtils.writeBinaryFile(filePath, file.bytes, options);
            }
            return new TextResponse(JSON.stringify({ savedTo: filePath, bytes: bytes.length, format }));
        }
        if (format === "svg" || format === "pdf") {
            if (bytes.length > TEXT_OUTPUT_MAX_BYTES) {
                throw ExportShapeBackendTool.textLimitError(file, format);
            }
        } else if (bytes.length > IMAGE_OUTPUT_MAX_BYTES) {
            const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
            throw new Error(
                `The image is ${megabytes} MB, above the 8 MB limit for image output. ` +
                    "Pass filePath to save it, or export at a smaller scale."
            );
        }
        return new ToolResponse([ExportShapeBackendTool.inlineItem(file, format)]);
    }

    /**
     * Refuses a raster export whose box times the scale has more pixels than the limit.
     *
     * The check needs the box of the shape. A box that the backend did not report is not checked.
     *
     * @param box - the shape as the backend returned it, with its width and height when known
     * @param scale - the scale factor of the export
     * @param format - the output format; svg and pdf have no pixels
     * @throws Error when the raster would have more than {@link RASTER_MAX_PIXELS} pixels
     */
    private static assertRasterSize(
        box: { width?: unknown; height?: unknown },
        scale: number,
        format: ExportFormat
    ): void {
        if (format === "svg" || format === "pdf") {
            return;
        }
        if (typeof box.width !== "number" || typeof box.height !== "number") {
            return;
        }
        const pixels = Math.ceil(box.width * scale) * Math.ceil(box.height * scale);
        if (pixels > RASTER_MAX_PIXELS) {
            throw new Error(
                `The export would be ${(pixels / 1_000_000).toFixed(1)} million pixels, above the 16 million limit ` +
                    `for ${format} output. Export at a smaller scale.`
            );
        }
    }

    /**
     * Builds the error for a first page shape that is too large to return.
     *
     * @param file - the rendered shape that is too large
     * @param format - the output format
     * @param overText - true when the limit is the inline limit of svg or pdf, false for the page total
     */
    private static pageLimitError(file: RenderedFile, format: ExportFormat, overText: boolean): Error {
        if (overText) {
            return new Error(
                `The first root shape of the page is ${Math.round(file.bytes.length / 1000)} kB ${format}, above the ` +
                    `256 kB limit for inline ${format} output. Export that shape by id with filePath, or at a smaller scale.`
            );
        }
        const megabytes = (file.bytes.length / (1024 * 1024)).toFixed(1);
        return new Error(
            `The first root shape of the page is ${megabytes} MB, above the 8 MB limit for page output. ` +
                "Export that shape by id at a smaller scale."
        );
    }

    /**
     * Builds the error for an svg or pdf that is too large to return inline.
     *
     * @param file - the rendered file
     * @param format - the output format
     */
    private static textLimitError(file: RenderedFile, format: ExportFormat): Error {
        return new Error(
            `The ${format} is ${Math.round(file.bytes.length / 1000)} kB, above the 256 kB limit for inline ${format} ` +
                "output. Pass filePath to save it, or export a smaller shape."
        );
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
            return new TextContent(JSON.stringify({ format, bytes: bytes.length, base64: bytes.toString("base64") }));
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
     * Runs an exporter call with the render signal in the call context, so that the exporter stops when the render
     * is held past its deadline. The signal of the caller, when it has one, is combined with it.
     *
     * @param signal - the signal that fires at the render deadline
     * @param call - the exporter call to run
     */
    private static underSignal<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
        const caller = CallContext.current();
        const combined = caller?.signal === undefined ? signal : AbortSignal.any([signal, caller.signal]);
        return CallContext.run({ ...caller, signal: combined }, call);
    }

    /**
     * Returns the text of an error, or its text form when it is not an error.
     *
     * @param reason - the reason of a rejected render
     */
    private static messageOf(reason: unknown): string {
        return reason instanceof Error ? reason.message : String(reason);
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

/** A root shape of a page, as the page export reads it. */
interface RootShape {
    /** Id of the shape. */
    id: string;
    /** Caller-facing type name of the shape. */
    type: string;
    /** Name of the shape, or the empty string. */
    name: string;
    /** Width of the shape box, when the backend reports it. */
    width?: unknown;
    /** Height of the shape box, when the backend reports it. */
    height?: unknown;
}
