import { z } from "zod";
import sharp, { type Sharp } from "sharp";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { ImageContent, TextContent, TextResponse, ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import {
    BatchRefusals,
    ExporterUnreachableError,
    ExportBatchError,
    ExporterError,
    ExportTooLargeError,
    type ExportFormat,
    type ExportRenderer,
    type ExportShapeRequest,
    type RenderedFile,
} from "../../backend/ExporterClient";
import { RenderCache } from "../../backend/RenderCache";
import { TokenDigest } from "../../backend/TokenDigest";
import { CallContext } from "../../backend/CallContext";
import { BusyError } from "../../utils/PermitGate";
import { ExportConcurrency, RenderDeadlineError } from "../../utils/ExportConcurrency";
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

/** Largest number of root shapes that one page export renders. */
const PAGE_MAX_SHAPES = 10;

/** Most shape ids that one call of shapeIds takes. */
const SHAPE_IDS_MAX = 200;

/** Wait before a single render is tried again after a 5xx answer, in milliseconds. */
const SINGLE_RETRY_DELAY_MS = 500;

/** Longest time that one call may run before it stops starting renders, in milliseconds. */
const CALL_BUDGET_MS = 10 * 60_000;

/** Longest time that the font check of a call may take, in milliseconds. */
const FONT_CHECK_MS = 3_000;

/** Most rounds of shape reads that one call makes while the backend says the answer is truncated. */
const SHAPE_READ_ROUNDS = 50;

/** The note that a render is kept, shown with a font notice. */
const CACHE_NOTE =
    "These renders are kept for up to 15 minutes; after the font is fixed, pass refresh: true to render again.";

/** Room that an inline reply keeps free: when less is left, the total is full and no further chunk is sent. */
const INLINE_HEADROOM_BYTES = 256 * 1024;

/** Why an inline reply stops rendering: the total is full. */
const INLINE_FULL_NOTE = "the inline total is full; pass outputDir to save every shape, or ask for fewer shapes";

/** Why the shapes after a failed page shape are not rendered. */
const FAILED_EARLIER_NOTE = "an earlier shape failed, so the shapes after it were not rendered";

/** Classes of failure that decide whether a failure keeps coming back. */
type FailureClass = "auth" | "network" | "server";

/** The cause and the way out of an svg export that times out on a text, appended to the error the caller sees. */
const SVG_TEXT_HINT =
    "An svg export fails this way when the shape holds a text that no browser has laid out yet: a text created or " +
    "changed through the MCP has no positionData until the file is opened in the workspace. Export png instead, or " +
    "open the file in the workspace once and retry.";

/** The part of the exporter message that a screenshot of a text node that no browser laid out leaves behind. */
const SCREENSHOT_TIMEOUT_TEXT = "locator.screenshot: Timeout";

/**
 * Tells whether a render failure gets the svg text hint: the format is svg, and the error is an exporter error whose
 * message holds a screenshot timeout. No other format and no other error gets the hint.
 *
 * @param format - the output format of the render
 * @param error - the value that the render threw
 * @returns true when the hint is added to the message that the caller sees
 */
export function needsSvgTextHint(format: ExportFormat, error: unknown): boolean {
    return format === "svg" && error instanceof ExporterError && error.message.includes(SCREENSHOT_TIMEOUT_TEXT);
}

/**
 * Returns the text that the caller sees for a render failure: the message of the error, with the svg text hint
 * after it when {@link needsSvgTextHint} says so. The error itself is not changed.
 *
 * @param format - the output format of the render
 * @param error - the value that the render threw
 * @returns the message, with the hint appended once when it applies
 */
export function renderFailureText(format: ExportFormat, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return needsSvgTextHint(format, error) ? `${message} ${SVG_TEXT_HINT}` : message;
}

/** File name extensions that each format may be saved with. The first one names the files that outputDir writes. */
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
            .optional()
            .describe(
                "Id of the shape to export, from get_page_tree or find_shapes. " +
                    "Use 'page' for the root shapes of the page, one image each, up to the first 10. " +
                    "Give either shapeId or shapeIds."
            ),
        shapeIds: z
            .array(BackendIds.uuid())
            .min(1)
            .max(SHAPE_IDS_MAX)
            .optional()
            .describe(
                "Ids of several shapes to export in one call, 1 to 200, from get_page_tree or find_shapes. " +
                    "Use it for many shapes: they go to the exporter in batches, and a shape that fails does not stop " +
                    "the others. Give either shapeId or shapeIds. Pass outputDir to save every image; without it the " +
                    "images come back inline, up to 8 MB in total, and the shapes that do not fit are listed as not returned."
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
        renderer: z
            .enum(["browser", "wasm"])
            .optional()
            .describe(
                "'browser' (default) renders with the exporter's browser renderer. 'wasm' renders with the headless " +
                    "renderer that the workspace uses, so the image matches what the editor shows. It needs an exporter " +
                    "that has that renderer; an older exporter ignores it."
            ),
        refresh: z
            .boolean()
            .optional()
            .describe(
                "When true, ignore the cached renders of these shapes and render them again, replacing the cache. " +
                    "Default false: a cached render is returned while it is less than 15 minutes old."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path to save the exported file to, inside the export directory (PENPOT_MCP_EXPORT_DIR, " +
                    "or penpot-exports in the home directory by default). The file name must end in the format's " +
                    "extension. When omitted, the file is returned in the response. Use it with one shape; use " +
                    "outputDir with shapeIds."
            ),
        outputDir: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path of a folder inside the export directory. With shapeIds, each image is saved there as " +
                    "<shapeId>.<extension>, and the reply lists the files. Needs shapeIds. Existing files are refused " +
                    "unless overwrite is true."
            ),
        overwrite: z
            .boolean()
            .optional()
            .describe(
                "When true, replace the file at filePath or outputDir if one is there. " +
                    "Default false: it is refused."
            ),
    };

    fileId!: string;

    pageId!: string;

    shapeId?: string;

    shapeIds?: string[];

    format?: ExportFormat;

    scale?: number;

    mode?: "shape" | "fill";

    renderer?: ExportRenderer;

    refresh?: boolean;

    filePath?: string;

    outputDir?: string;

    overwrite?: boolean;
}

/** Test seams of {@link ExportShapeBackendTool}: the clock, the waits and the deadline of one render. */
export interface ExportShapeOptions {
    /** Clock in milliseconds, which times the refusal of batches and the time budget of a call. Defaults to Date.now. */
    now?: () => number;
    /** Wait before a single render is tried again after a 5xx answer, in milliseconds. Defaults to 500. */
    retryDelayMs?: number;
    /** Longest wait for the font check, in milliseconds. Defaults to 3 s. */
    fontCheckMs?: number;
    /** Longest time of one render request, including the wait for a permit, in milliseconds. Defaults to 60 s. */
    renderDeadlineMs?: number;
}

/** Exports a shape, several shapes, the root shapes of a page or a shape's image fill as an image, text or file. */
export class ExportShapeBackendTool extends BackendTool<ExportShapeBackendArgs> {
    /** Clock that times the refusal of batches and the time budget of a call. */
    private readonly now: () => number;
    /** Wait before a single render is tried again after a 5xx answer, in milliseconds. */
    private readonly retryDelayMs: number;
    /** Longest wait for the font check, in milliseconds. */
    private readonly fontCheckMs: number;
    /** Longest time of one render request, in milliseconds. */
    private readonly renderDeadlineMs: number;

    /**
     * Creates the tool. The filePath and overwrite arguments are offered only when file system access is enabled.
     *
     * @param mcpServer - the MCP server instance
     * @param services - backend, exporter, render sessions, render cache and batch size shared by all backend tools
     * @param options - the clock, the waits and the deadline; the defaults are the real ones
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices, options: ExportShapeOptions = {}) {
        // the file keys stay in the schema even in multi-user mode, so that a call with them is refused and not stripped
        super(mcpServer, ExportShapeBackendArgs.schema, services);
        this.now = options.now ?? Date.now;
        this.retryDelayMs = options.retryDelayMs ?? SINGLE_RETRY_DELAY_MS;
        this.fontCheckMs = options.fontCheckMs ?? FONT_CHECK_MS;
        this.renderDeadlineMs = options.renderDeadlineMs ?? ExportConcurrency.RENDER_TIMEOUT_MS;
    }

    public getToolName(): string {
        return "export_shape";
    }

    /**
     * Describes the tool to the client: what each argument does and how the cache, the fonts and the limits behave.
     *
     * @returns the description text
     */
    public getToolDescription(): string {
        let description =
            "Exports shapes as png, svg, jpeg, webp or pdf. shapeId exports one shape. When shapeId is 'page', it " +
            "exports the root shapes of the page, in page order, one image each, up to the first 10. " +
            "shapeIds exports up to 200 shapes in one call: the shapes go to the exporter in batches, and a shape " +
            "that fails does not stop the others. With outputDir, each image is saved as <shapeId>.<extension> in " +
            "that folder, through a temporary file, and the reply is a JSON summary. Without it the images come back " +
            "inline, in the order asked, up to 8 MB in total: an image too large for what is left is skipped with its " +
            "own reason, and the shapes after a full total are listed as not rendered: pass outputDir, or ask for " +
            "fewer shapes. Fill mode exports the raw image of the shape's image fill instead. " +
            "png, jpeg and webp return the image (up to 8 MB, and up to 16 million pixels: the shape box times the " +
            "scale). svg and pdf return text (pdf as base64 JSON), up to 256 kB. " +
            "renderer 'wasm' renders with the same renderer as the workspace, when the exporter has it. " +
            "Each render is cached as soon as it arrives and kept for 15 minutes, whatever its fonts. " +
            "Pass refresh true to render again instead of using the cache. " +
            "The fonts of the shapes are checked once per call; when a font does not resolve, the reply has a warning " +
            "that names it, and says how to render again. " +
            "A page export returns up to 8 MB in total and does not take filePath.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description +=
                " Alternatively, set filePath to save one file instead. filePath must lie inside the export " +
                "directory (PENPOT_MCP_EXPORT_DIR, or penpot-exports in the home directory by default), end in the " +
                "format's extension, and not replace a file unless overwrite is true.";
        } else {
            description += " In multi-user mode file paths are off, so a filePath or outputDir is refused.";
        }
        description += " Next: get_shapes for the attributes of a shape, or list_fonts when a warning names a font.";
        return description;
    }
    protected async executeBackend(args: ExportShapeBackendArgs, userToken: string): Promise<ToolResponse> {
        const format = args.format ?? "png";
        const scale = args.scale ?? 1;
        const renderer = args.renderer ?? "browser";
        const refresh = args.refresh === true;
        if (args.shapeId !== undefined && args.shapeIds !== undefined) {
            throw new Error("Give shapeId or shapeIds, not both.");
        }
        if (args.shapeIds !== undefined) {
            const ids = args.shapeIds.map((id) => id.toLowerCase());
            return this.renderMany(args, userToken, format, scale, renderer, refresh, ids);
        }
        if (args.shapeId === undefined) {
            throw new Error("Give shapeId, or shapeIds for several shapes.");
        }
        if (args.outputDir !== undefined) {
            throw new Error("outputDir saves several shapes: pass shapeIds with it. For one shape, use filePath.");
        }
        const shapeId = args.shapeId.toLowerCase();
        if (args.filePath !== undefined) {
            this.checkFilePath(args.filePath, args.overwrite === true, format);
        }
        const fill = (args.mode ?? "shape") === "fill";
        if (shapeId === "page" && !fill) {
            return this.renderPage(args, userToken, format, scale, renderer, refresh);
        }
        if (fill) {
            const file = await this.renderFill(args, shapeId, userToken, format);
            return this.outputFile(file, format, args.filePath, args.overwrite === true);
        }
        return this.renderOneShape(args, shapeId, userToken, format, scale, renderer, refresh);
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
     * Checks the folder that outputDir names, and every file that the call would write, before anything is rendered.
     *
     * @param outputDir - the folder the caller gave
     * @param overwrite - whether existing files may be replaced
     * @param format - the output format, which fixes the file names
     * @param ids - the shape ids of the call, which name the files
     * @returns the folder, to write into
     * @throws Error when file system access is off, the folder is relative, outside the export directory, or not a
     *   folder, a file would pass through a link, or files exist and may not be replaced
     */
    private checkOutputDir(outputDir: string, overwrite: boolean, format: ExportFormat, ids: string[]): string {
        FilePathAccess.assertAllowed(this.mcpServer);
        FileUtils.checkPathIsAbsolute(outputDir);
        ExportDirectory.assertInside(outputDir, process.env);
        if (ExportShapeBackendTool.isFileNotFolder(outputDir)) {
            throw new Error(`outputDir ${outputDir} exists and is not a folder. Choose another folder name.`);
        }
        const targets = ids.map((id) => path.join(outputDir, ExportShapeBackendTool.fileNameOf(id, format)));
        for (const target of targets) {
            ExportDirectory.assertInside(target, process.env);
        }
        if (!overwrite) {
            const existing = targets.filter((target) => ExportShapeBackendTool.isThere(target)).length;
            if (existing > 0) {
                throw new Error(
                    `${existing} of the ${targets.length} output files already exist in ${outputDir}. ` +
                        "Pass overwrite: true to replace them, or choose another folder."
                );
            }
        }
        return outputDir;
    }

    /**
     * Renders one shape. A render is cached as soon as it arrives, so a shape too large for the reply, or a reply
     * that fails to write, still leaves its render in the cache for the retry. The fonts are checked after the
     * render, when the call was not cancelled.
     *
     * @param args - the validated tool arguments
     * @param shapeId - the lower-case shape id; not "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @param renderer - the renderer
     * @param refresh - whether the cache is ignored
     * @returns the reply of the render
     */
    private async renderOneShape(
        args: ExportShapeBackendArgs,
        shapeId: string,
        userToken: string,
        format: ExportFormat,
        scale: number,
        renderer: ExportRenderer,
        refresh: boolean
    ): Promise<ToolResponse> {
        const { profileId } = await this.services.validator.validate(userToken);
        const { shape, revn } = await this.readShape(userToken, args.fileId, args.pageId, shapeId, [
            "id",
            "width",
            "height",
        ]);
        ExportShapeBackendTool.assertRasterSize(shape, scale, format);
        const plan = this.planOf(
            args.fileId,
            args.pageId,
            userToken,
            format,
            scale,
            renderer,
            profileId,
            revn,
            refresh
        );
        let file = this.cachedFile(plan, shapeId);
        if (file === undefined) {
            try {
                file = await this.renderSingle(plan, shapeId);
            } catch (error) {
                if (error instanceof ExporterError && needsSvgTextHint(format, error)) {
                    throw new ExporterError(error.status, renderFailureText(format, error), error.source);
                }
                throw error;
            }
        }
        const response = this.outputFile(file, format, args.filePath, args.overwrite === true);
        const check = await this.fontCheck(plan, [shapeId]);
        return this.withFontNotice(response, check);
    }
    /**
     * Renders the root shapes of a page, in order, in batches, and returns them in page order.
     *
     * The root shapes are read first, so a page with no shapes fails here and not in the exporter. At most
     * {@link PAGE_MAX_SHAPES} root shapes are rendered. The answer keeps the shapes rendered before the first one that
     * fails or does not fit, and says why it stopped. A call that stops on its time budget reports what it returned,
     * and is not an error when it returned images.
     *
     * @param args - the validated tool arguments; the shape id is "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @param renderer - the renderer
     * @param refresh - whether the cache is ignored
     * @returns a text line with the counts, then for each rendered shape a text line with its id and the content
     * @throws Error when a filePath is given, the page has no shapes, or the first root shape cannot be returned
     */
    private async renderPage(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat,
        scale: number,
        renderer: ExportRenderer,
        refresh: boolean
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
        const plan = this.planOf(
            args.fileId,
            args.pageId,
            userToken,
            format,
            scale,
            renderer,
            profileId,
            roots.revn,
            refresh
        );
        const state = this.newState(chosen.length, true, false);
        const results = new Map<string, Result>();
        const renderIds: string[] = [];
        for (const root of chosen) {
            try {
                ExportShapeBackendTool.assertRasterSize(root, scale, format);
                renderIds.push(root.id);
            } catch (error) {
                results.set(root.id, { kind: "failed", error: ExportShapeBackendTool.messageOf(error) });
                this.reportStep(state, `Shape ${root.id} failed.`);
                break;
            }
        }
        await this.renderAll(
            plan,
            renderIds,
            { format, inline: true, outputDir: undefined, overwrite: false },
            state,
            results
        );
        const check = await this.fontCheck(
            plan,
            ExportShapeBackendTool.servedIdsOf(
                chosen.map((root) => root.id),
                results
            )
        );
        const items: Array<TextContent | ImageContent> = [];
        let rendered = 0;
        let cut: string | undefined;
        let failure: string | undefined;
        for (const root of chosen) {
            const result = results.get(root.id);
            if (result?.kind === "file" && result.file !== undefined) {
                items.push(new TextContent(`Shape ${root.id} (${root.type}) "${root.name}"`));
                items.push(ExportShapeBackendTool.inlineItem(result.file, format));
                rendered++;
                continue;
            }
            if (result?.kind === "notReturned") {
                const overText = result.reason === "text";
                if (rendered === 0) {
                    throw ExportShapeBackendTool.pageLimitError(result.bytes, format, overText);
                }
                cut = overText
                    ? `Stopped at a shape whose ${format} is above the 256 kB limit for inline output. Export the rest by id, or at a smaller scale.`
                    : "Stopped before the total would pass the 8 MB limit for page output. Export the rest by id, or at a smaller scale.";
                break;
            }
            if (result?.kind === "notRendered") {
                cut = `Stopped: ${result.reason}. Export the rest by id.`;
                break;
            }
            const reason = result?.kind === "failed" ? result.error : "the shape was not reached";
            failure = `Shape ${root.id} could not be exported: ${ExportShapeBackendTool.endSentence(reason)}`;
            break;
        }
        if (rendered === 0 && failure !== undefined) {
            throw new Error(failure);
        }
        let header = `Page ${args.pageId}: exported ${rendered} of ${roots.total} root shapes, in page order.`;
        if (cut !== undefined) {
            header += ` ${cut}`;
        } else if (rendered < roots.total && failure === undefined) {
            header += ` Only the first ${PAGE_MAX_SHAPES} are rendered per call. Export the rest by id.`;
        }
        if (failure !== undefined) {
            header += ` ${failure} The shapes after it were not exported.`;
        }
        const content: Array<TextContent | ImageContent> = [new TextContent(header), ...items];
        if (check.checked && check.warnings.length > 0) {
            content.push(new TextContent(ExportShapeBackendTool.fontWarningText(check.warnings)));
        }
        return new ToolResponse(content, failure !== undefined);
    }
    /**
     * Renders several shapes, and either saves them to outputDir or returns them inline.
     *
     * The shapes are read first, in one call, so that a missing shape or a raster above the pixel limit becomes a
     * failed entry and not a failed call. The rest render in batches, in the order asked.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @param scale - the scale factor
     * @param renderer - the renderer
     * @param refresh - whether the cache is ignored
     * @param requested - the lower-case shape ids as the caller gave them, which may hold a repeat
     * @returns the JSON summary with outputDir, or the images inline in the order asked
     * @throws Error when the call names a filePath or fill mode, or the folder is refused
     */
    private async renderMany(
        args: ExportShapeBackendArgs,
        userToken: string,
        format: ExportFormat,
        scale: number,
        renderer: ExportRenderer,
        refresh: boolean,
        requested: string[]
    ): Promise<ToolResponse> {
        if (args.filePath !== undefined) {
            throw new Error("filePath saves one shape: with shapeIds, pass outputDir instead.");
        }
        if ((args.mode ?? "shape") === "fill") {
            throw new Error("Fill mode takes one shape: pass shapeId, not shapeIds.");
        }
        const ids = [...new Set(requested)];
        const outputDir =
            args.outputDir === undefined
                ? undefined
                : this.checkOutputDir(args.outputDir, args.overwrite === true, format, ids);
        const { profileId } = await this.services.validator.validate(userToken);
        const read = await this.readShapes(userToken, args.fileId, args.pageId, ids);
        const plan = this.planOf(
            args.fileId,
            args.pageId,
            userToken,
            format,
            scale,
            renderer,
            profileId,
            read.revn,
            refresh
        );
        const state = this.newState(ids.length, false, outputDir !== undefined);
        const results = new Map<string, Result>();
        const renderIds: string[] = [];
        for (const id of ids) {
            const shape = read.shapes.get(id);
            if (shape === undefined) {
                const error = read.missing.has(id)
                    ? `shape ${id} is not on page ${args.pageId} of file ${args.fileId}; ` +
                      "check pageId with find_shapes or get_page_tree"
                    : `the backend did not return shape ${id}; call again.`;
                results.set(id, { kind: "failed", error });
                this.reportStep(state, `Shape ${id} failed.`);
                continue;
            }
            try {
                ExportShapeBackendTool.assertRasterSize(shape, scale, format);
                renderIds.push(id);
            } catch (error) {
                results.set(id, { kind: "failed", error: ExportShapeBackendTool.messageOf(error) });
                this.reportStep(state, `Shape ${id} failed.`);
            }
        }
        await this.renderAll(
            plan,
            renderIds,
            { format, inline: outputDir === undefined, outputDir, overwrite: args.overwrite === true },
            state,
            results
        );
        const check = await this.fontCheck(plan, ExportShapeBackendTool.servedIdsOf(ids, results));
        if (outputDir !== undefined) {
            return this.outputDirReply(ids, results, state, check);
        }
        return this.inlineReply(ids, results, read.shapes, format, state, check);
    }
    /**
     * Builds the JSON reply of a call with outputDir.
     *
     * @param ids - the requested shape ids, in the order asked
     * @param results - the outcome of each shape
     * @param state - the counts of the call
     * @param check - the font check of the call
     * @returns the reply
     */
    private outputDirReply(
        ids: string[],
        results: Map<string, Result>,
        state: CallState,
        check: FontCheck
    ): ToolResponse {
        const files: Array<{ shapeId: string; path: string; bytes: number }> = [];
        const failed: Array<{ shapeId: string; error: string }> = [];
        const notRendered: Array<{ shapeId: string; reason: string }> = [];
        for (const id of ids) {
            const result = results.get(id);
            if (result?.kind === "file" && result.path !== undefined) {
                files.push({ shapeId: id, path: result.path, bytes: result.bytes });
            } else if (result?.kind === "failed") {
                failed.push({ shapeId: id, error: result.error });
            } else if (result?.kind === "notRendered") {
                notRendered.push({ shapeId: id, reason: result.reason });
            }
        }
        const payload: Record<string, unknown> = {
            rendered: state.renderedTotal,
            cached: state.cachedTotal,
            failed,
            files,
            notRendered,
        };
        if (check.warnings.length > 0) {
            payload.warnings = check.warnings;
            payload.note = CACHE_NOTE;
        }
        const json = this.jsonResponse(payload);
        return new ToolResponse(json.content, ids.length > 0 && failed.length === ids.length);
    }
    /**
     * Builds the inline reply of a call: one text line and one image for each kept shape, in the order asked. An image
     * too large on its own, or too large for what is left, is skipped with its own reason; shapes that the call did not
     * reach because the total was full, or because the call ran out of time, are listed as not rendered.
     *
     * @param ids - the requested shape ids, in the order asked
     * @param results - the outcome of each shape
     * @param shapes - the shapes as the backend read them, for their names
     * @param format - the output format
     * @param state - the counts of the call
     * @param check - the font check of the call
     * @returns the reply
     */
    private inlineReply(
        ids: string[],
        results: Map<string, Result>,
        shapes: Map<string, Record<string, unknown>>,
        format: ExportFormat,
        state: CallState,
        check: FontCheck
    ): ToolResponse {
        const items: Array<TextContent | ImageContent> = [];
        const single: string[] = [];
        const bySize: string[] = [];
        const byText: string[] = [];
        const failures: string[] = [];
        const notRendered = new Map<string, string[]>();
        let returned = 0;
        for (const id of ids) {
            const result = results.get(id);
            if (result?.kind === "file" && result.file !== undefined) {
                const name = shapes.get(id)?.name;
                const caption = typeof name === "string" && name !== "" ? `Shape ${id} "${name}"` : `Shape ${id}`;
                items.push(new TextContent(caption), ExportShapeBackendTool.inlineItem(result.file, format));
                returned++;
            } else if (result?.kind === "notReturned") {
                const list = result.reason === "text" ? byText : result.reason === "single" ? single : bySize;
                list.push(id);
            } else if (result?.kind === "failed") {
                failures.push(`${id}: ${ExportShapeBackendTool.endSentence(result.error)}`);
            } else if (result?.kind === "notRendered") {
                const list = notRendered.get(result.reason) ?? [];
                list.push(id);
                notRendered.set(result.reason, list);
            }
        }
        let header =
            `Returned ${returned} of ${ids.length} shapes: ${state.renderedTotal} rendered, ` +
            `${state.cachedTotal} from the cache, ${failures.length} failed.`;
        if (single.length > 0) {
            header +=
                ` ${single.length} too large for an inline reply on their own, not returned: ${single.join(", ")}. ` +
                "Pass outputDir or filePath to save them.";
        }
        if (bySize.length > 0) {
            header +=
                ` ${bySize.length} not returned, because the images would pass the 8 MB limit for inline output: ` +
                `${bySize.join(", ")}. Pass outputDir to save every shape to a folder.`;
        }
        if (byText.length > 0) {
            header +=
                ` ${byText.length} not returned, because each svg or pdf is above the 256 kB limit for inline output: ` +
                `${byText.join(", ")}. Pass outputDir, or filePath with one shape, to save it.`;
        }
        for (const [reason, list] of notRendered) {
            header += ` ${list.length} not rendered (${reason}): ${list.join(", ")}.`;
        }
        const content: Array<TextContent | ImageContent> = [new TextContent(header), ...items];
        if (failures.length > 0) {
            content.push(new TextContent(`Failed: ${failures.join("; ")}`));
        }
        if (check.checked && check.warnings.length > 0) {
            content.push(new TextContent(ExportShapeBackendTool.fontWarningText(check.warnings)));
        }
        return new ToolResponse(content, ids.length > 0 && failures.length === ids.length);
    }
    /**
     * Renders the given shapes in order, in groups of the batch size, with the cache, the call budget and the inline
     * total applied. Each shape is recorded once, and its progress is reported as it is recorded.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param ids - the shape ids to render, in the order asked, without the shapes that failed before the render
     * @param options - the format, whether the answer is inline, the output folder and the overwrite rule
     * @param state - the state of the call
     * @param results - receives the outcome of each shape
     */
    private async renderAll(
        plan: RenderPlan,
        ids: string[],
        options: RenderOptions,
        state: CallState,
        results: Map<string, Result>
    ): Promise<void> {
        const record = (id: string, result: Result, message: string): void => {
            results.set(id, result);
            this.reportStep(state, message);
        };
        for (let start = 0; start < ids.length; start += this.services.exportBatchSize) {
            const group = ids.slice(start, start + this.services.exportBatchSize);
            this.checkBudget(state);
            if (options.inline && state.inlineFull && state.stop === undefined) {
                state.stop = { kind: "notRendered", message: INLINE_FULL_NOTE };
            }
            const uncached: string[] = [];
            for (const id of group) {
                if (state.stop !== undefined) {
                    record(id, ExportShapeBackendTool.stopResult(state.stop), `Shape ${id} was not rendered.`);
                    continue;
                }
                const hit = this.cachedFile(plan, id);
                if (hit !== undefined) {
                    record(id, this.deliver(plan, id, hit, true, options, state), `Shape ${id} came from the cache.`);
                } else {
                    uncached.push(id);
                }
            }
            if (uncached.length > 0) {
                await this.renderChunk(plan, uncached, state, (id, outcome) => {
                    if (outcome.kind === "file") {
                        record(
                            id,
                            this.deliver(plan, id, outcome.file, false, options, state),
                            `Rendered shape ${id}.`
                        );
                    } else if (outcome.kind === "failed") {
                        record(id, { kind: "failed", error: outcome.error }, `Shape ${id} failed.`);
                    } else {
                        record(id, { kind: "notRendered", reason: outcome.reason }, `Shape ${id} was not rendered.`);
                    }
                });
            }
            if (options.inline) {
                for (const id of group) {
                    const result = results.get(id);
                    if (result?.kind === "file") {
                        results.set(id, this.keepInline(result, options.format, state));
                    }
                }
            }
        }
    }
    /**
     * Decides whether a rendered image of an inline reply is kept, in the order the shapes were asked. An image that is
     * too large on its own, or too large for what is left, is skipped with its own reason; the total is full when it
     * reaches the cap exactly.
     *
     * @param result - the file result of the shape
     * @param format - the output format
     * @param state - the state of the call, which holds the running total
     * @returns the file result when it is kept, otherwise a result that says why it was not returned
     */
    private keepInline(result: FileResult, format: ExportFormat, state: CallState): Result {
        if ((format === "svg" || format === "pdf") && result.bytes > TEXT_OUTPUT_MAX_BYTES) {
            return { kind: "notReturned", reason: "text", bytes: result.bytes };
        }
        if (result.bytes > IMAGE_OUTPUT_MAX_BYTES) {
            return { kind: "notReturned", reason: "single", bytes: result.bytes };
        }
        if (state.inlineBytes + result.bytes > IMAGE_OUTPUT_MAX_BYTES) {
            return { kind: "notReturned", reason: "size", bytes: result.bytes };
        }
        state.inlineBytes += result.bytes;
        if (IMAGE_OUTPUT_MAX_BYTES - state.inlineBytes < INLINE_HEADROOM_BYTES) {
            state.inlineFull = true;
        }
        return result;
    }
    /**
     * Turns a rendered or cached file into the result of its shape: a file written to the folder, through a temporary
     * file, or the file itself for an inline reply.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param id - the shape id
     * @param file - the bytes and media type
     * @param cached - whether the file came from the cache
     * @param options - the output folder and the overwrite rule
     * @param state - the counts of the call
     * @returns the result of the shape
     */
    private deliver(
        plan: RenderPlan,
        id: string,
        file: RenderedFile,
        cached: boolean,
        options: RenderOptions,
        state: CallState
    ): Result {
        if (options.outputDir === undefined) {
            ExportShapeBackendTool.count(state, cached);
            return { kind: "file", cached, bytes: file.bytes.length, file };
        }
        const target = path.join(options.outputDir, ExportShapeBackendTool.fileNameOf(id, plan.format));
        try {
            ExportDirectory.assertInside(target, process.env);
            FileUtils.writeBinaryFileReplacing(target, file.bytes, { overwrite: options.overwrite });
        } catch (error) {
            return { kind: "failed", error: ExportShapeBackendTool.messageOf(error) };
        }
        ExportShapeBackendTool.count(state, cached);
        return { kind: "file", cached, bytes: file.bytes.length, path: target };
    }
    /**
     * Renders one chunk of uncached shapes: in one request when batches work, otherwise one shape at a time.
     *
     * A busy exporter or a cancelled call ends the call. A deadline, an answer too large or an unmappable batch switch
     * the rest of this call to single renders. A failure that keeps coming back ends the call: when every single of a
     * chunk fails with the same class of error (authentication, network or exporter 5xx) and the next chunk's first
     * request fails with that class again, the shapes not yet rendered are failed with that error. Other failures
     * render the chunk one by one; only an exporter 5xx on the batch that the singles then get past is remembered.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param chunk - the uncached shape ids of the chunk, in order
     * @param state - the state of the call
     * @param onOutcome - receives the outcome of each shape, once it is known
     */
    private async renderChunk(
        plan: RenderPlan,
        chunk: string[],
        state: CallState,
        onOutcome: (id: string, outcome: ChunkOutcome) => void
    ): Promise<void> {
        const exporter = this.services.exporter;
        let exporterRefused = false;
        if (!state.singles && chunk.length > 1 && !BatchRefusals.refusesBatches(exporter, this.now())) {
            try {
                const files = await this.renderBatch(plan, chunk);
                const resolved = chunk.map((id) => {
                    const file = files.get(id);
                    if (file === undefined) {
                        throw new ExportBatchError(`The exporter batch has no file for shape ${id}.`);
                    }
                    return { id, file };
                });
                // every render is cached as soon as its bytes arrive, before it is reported or written
                for (const { id, file } of resolved) {
                    this.store(plan, id, file);
                }
                // the shapes of one batch finish together, but they are reported one by one, in order, so that the
                // progress rises by one at a time
                for (const { id, file } of resolved) {
                    onOutcome(id, { kind: "file", file, cached: false });
                }
                return;
            } catch (error) {
                const cls = ExportShapeBackendTool.classOf(error);
                if (cls !== undefined && state.breaker === cls) {
                    state.stop = { kind: "failed", message: ExportShapeBackendTool.messageOf(error) };
                    for (const id of chunk) {
                        onOutcome(id, ExportShapeBackendTool.stopOutcome(state.stop));
                    }
                    return;
                }
                const policy = this.batchPolicy(error, state);
                if (policy.stop !== undefined) {
                    state.stop = policy.stop;
                    for (const id of chunk) {
                        onOutcome(id, ExportShapeBackendTool.stopOutcome(policy.stop));
                    }
                    return;
                }
                if (policy.singlesForCall) {
                    state.singles = true;
                }
                exporterRefused = policy.exporterRefused;
            }
        }
        const classes: Array<FailureClass | undefined> = [];
        let allRendered = true;
        for (let index = 0; index < chunk.length; index++) {
            const id = chunk[index];
            this.checkBudget(state);
            if (state.stop !== undefined) {
                allRendered = false;
                onOutcome(id, ExportShapeBackendTool.stopOutcome(state.stop));
                continue;
            }
            const outcome = await this.renderOne(plan, id, state);
            if (outcome.kind === "failed") {
                allRendered = false;
                classes.push(outcome.cls);
                if (index === 0 && outcome.cls !== undefined && state.breaker === outcome.cls) {
                    state.stop = { kind: "failed", message: outcome.error };
                }
                if (state.stopOnFailure && state.stop === undefined) {
                    state.stop = { kind: "notRendered", message: FAILED_EARLIER_NOTE };
                }
            } else {
                classes.push(undefined);
            }
            onOutcome(id, outcome);
        }
        const first = classes[0];
        state.breaker =
            classes.length === chunk.length && first !== undefined && classes.every((cls) => cls === first)
                ? first
                : undefined;
        if (exporterRefused && allRendered) {
            BatchRefusals.refuse(exporter, this.now());
        }
    }
    /**
     * Decides what a failed batch request means for the call.
     *
     * @param error - the error that the batch threw
     * @param state - the state of the call, which gives the wording of a stop
     * @returns the stop of the call, or the change of the policy: singles for the call, and whether the exporter
     *   answered with a 5xx to the batch request
     */
    private batchPolicy(
        error: unknown,
        state: CallState
    ): { stop?: Stop; singlesForCall: boolean; exporterRefused: boolean } {
        if (this.callAborted()) {
            return {
                stop: { kind: "failed", message: ExportShapeBackendTool.stopText(state, "cancelled") },
                singlesForCall: false,
                exporterRefused: false,
            };
        }
        if (ExportShapeBackendTool.isBusy(error)) {
            return {
                stop: { kind: "failed", message: ExportShapeBackendTool.stopText(state, "busy") },
                singlesForCall: false,
                exporterRefused: false,
            };
        }
        if (
            ExportShapeBackendTool.isDeadline(error) ||
            error instanceof ExportTooLargeError ||
            error instanceof ExportBatchError
        ) {
            return { singlesForCall: true, exporterRefused: false };
        }
        const exporterRefused = error instanceof ExporterError && error.status >= 500 && error.source === "export";
        return { singlesForCall: false, exporterRefused };
    }
    /**
     * Renders one shape alone, and turns a failure into an outcome. A busy exporter or a cancelled call stops the call.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param id - the shape id
     * @param state - the state of the call, which receives a stop
     * @returns the file, or the failure with its class of error
     */
    private async renderOne(plan: RenderPlan, id: string, state: CallState): Promise<ChunkOutcome> {
        try {
            const file = await this.renderSingle(plan, id);
            return { kind: "file", file, cached: false };
        } catch (error) {
            if (this.callAborted()) {
                const message = ExportShapeBackendTool.stopText(state, "cancelled");
                state.stop = { kind: "failed", message };
                return { kind: "failed", error: message };
            }
            if (ExportShapeBackendTool.isBusy(error)) {
                const message = ExportShapeBackendTool.stopText(state, "busy");
                state.stop = { kind: "failed", message };
                return { kind: "failed", error: message };
            }
            return {
                kind: "failed",
                error: renderFailureText(plan.format, error),
                cls: ExportShapeBackendTool.classOf(error),
            };
        }
    }
    /**
     * Renders one shape alone, under its own permit, and caches it as soon as it arrives. A 5xx answer is tried once
     * more after a short wait; a 4xx answer is not retried. The svg text timeout is not retried either: its retry
     * cannot succeed, and it would push the answer past a client's 60 s timeout.
     *
     * @param plan - the file, the page, the output and the renderer
     * @param id - the shape id
     * @returns the rendered file
     * @throws ExporterError or Error when the render fails, after the retry
     */
    private async renderSingle(plan: RenderPlan, id: string): Promise<RenderedFile> {
        const render = () =>
            this.renderPermit(plan, (renderToken) =>
                this.services.exporter.exportShape(renderToken, ExportShapeBackendTool.requestOf(plan, id, "export"), {
                    renderer: plan.renderer,
                })
            );
        let file: RenderedFile;
        try {
            file = await render();
        } catch (error) {
            // The retry cannot succeed for an svg text timeout: the text stays unlaid. The retry would also push the
            // answer past a client's 60 s timeout, so the error goes to the caller at once.
            if (!ExportShapeBackendTool.isServerError(error) || needsSvgTextHint(plan.format, error)) {
                throw error;
            }
            await this.pause(this.retryDelayMs);
            file = await render();
        }
        this.store(plan, id, file);
        return file;
    }
    /**
     * Sends one batch request for a chunk of shapes, under one permit and one render session.
     *
     * @param plan - the file, the page, the output and the renderer
     * @param chunk - the shape ids of the chunk
     * @returns the file of each shape, keyed by its id
     * @throws ExporterError, ExportBatchError or ExportTooLargeError when the batch fails
     */
    private renderBatch(plan: RenderPlan, chunk: string[]): Promise<Map<string, RenderedFile>> {
        const requests = chunk.map((id) => ExportShapeBackendTool.requestOf(plan, id));
        return this.renderPermit(plan, (renderToken) =>
            this.services.exporter.exportShapes(renderToken, requests, { renderer: plan.renderer })
        );
    }

    /**
     * Runs an exporter call under the render permits of the token, with a render session and the render deadline.
     *
     * @param plan - the file and the token of the render
     * @param call - the exporter call, given the render session token
     * @returns the value of the call
     */
    private renderPermit<T>(plan: RenderPlan, call: (renderToken: string) => Promise<T>): Promise<T> {
        return ExportConcurrency.withBackendPermit(
            TokenDigest.sha256Hex(plan.userToken),
            (signal) =>
                this.withRenderSession(plan.userToken, plan.fileId, (renderToken) =>
                    ExportShapeBackendTool.underSignal(signal, () => call(renderToken))
                ),
            { timeoutMs: this.renderDeadlineMs }
        );
    }

    /**
     * Asks the backend for the fonts of the given shapes, and reports the ones that did not resolve. The check is
     * independent of the cache, and runs once per call. It is skipped when the call was cancelled, and it is raced
     * against a short timer: a call that fails, or is late, makes the check "not made", which shows no notice.
     *
     * @param plan - the file, the page and the token of the call
     * @param ids - the shape ids of the reply, at most 200
     * @returns whether the check was made, and the warnings of the fonts that did not resolve
     */
    private async fontCheck(plan: RenderPlan, ids: string[]): Promise<FontCheck> {
        if (ids.length === 0 || this.callAborted()) {
            return { checked: false, warnings: [] };
        }
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), this.fontCheckMs);
        });
        try {
            const answer = await Promise.race([
                this.callCommand<{ fonts?: unknown } | undefined>(plan.userToken, "get-mcp-fonts", {
                    fileId: plan.fileId,
                    pageId: plan.pageId,
                    rootIds: ids,
                }),
                late,
            ]);
            if (answer === TIMED_OUT) {
                return { checked: false, warnings: [] };
            }
            return { checked: true, warnings: ExportShapeBackendTool.unresolvedOf(answer) };
        } catch {
            return { checked: false, warnings: [] };
        } finally {
            clearTimeout(timer);
        }
    }
    /**
     * Adds the font notice of a check to a single-shape reply, when a font did not resolve.
     *
     * @param response - the reply of the render
     * @param check - the outcome of the font check
     * @returns the same reply, or a copy with one more text item
     */
    private withFontNotice(response: ToolResponse, check: FontCheck): ToolResponse {
        if (!check.checked || check.warnings.length === 0) {
            return response;
        }
        const text = new TextContent(ExportShapeBackendTool.fontWarningText(check.warnings));
        return new ToolResponse([...response.content, text], response.isError === true);
    }

    /**
     * Reads the shapes of a list of ids, following the truncation of the backend until every id is returned or listed
     * as missing, and reads the file revision.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the shapes
     * @param pageId - id of the page that holds the shapes
     * @param ids - the lower-case shape ids
     * @returns the shapes by id, the ids the page does not hold, the ids no answer covered, and the revision
     */
    private async readShapes(
        userToken: string,
        fileId: string,
        pageId: string,
        ids: string[]
    ): Promise<{
        shapes: Map<string, Record<string, unknown>>;
        missing: Set<string>;
        unread: string[];
        revn: number | undefined;
    }> {
        const shapes = new Map<string, Record<string, unknown>>();
        const missing = new Set<string>();
        let revn: number | undefined;
        let remaining = ids;
        for (let round = 0; remaining.length > 0 && round < SHAPE_READ_ROUNDS; round++) {
            const answer = await this.callCommand<
                { shapes?: unknown; missing?: unknown; revn?: unknown; truncated?: unknown } | undefined
            >(userToken, "get-mcp-shapes", {
                fileId,
                pageId,
                ids: remaining,
                fields: ["id", "type", "name", "width", "height"],
            });
            if (revn === undefined && typeof answer?.revn === "number") {
                revn = answer.revn;
            }
            for (const candidate of Array.isArray(answer?.shapes) ? answer.shapes : []) {
                const record = ExportShapeBackendTool.recordOf(candidate);
                if (typeof record?.id === "string") {
                    shapes.set(record.id.toLowerCase(), record);
                }
            }
            for (const listed of Array.isArray(answer?.missing) ? answer.missing : []) {
                if (typeof listed === "string") {
                    missing.add(listed.toLowerCase());
                }
            }
            const before = remaining.length;
            remaining = remaining.filter((id) => !shapes.has(id) && !missing.has(id));
            if (answer?.truncated !== true || remaining.length === before) {
                break;
            }
        }
        return { shapes, missing, unread: remaining, revn };
    }

    /**
     * Reads the root shapes of a page, the children of the page root, in page order.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the page
     * @param pageId - id of the page
     * @returns the root shapes that the backend listed, with their boxes, the number of root shapes the page holds and
     *   the revision of the file
     * @throws Error when the backend does not hold the page; other backend errors pass through unchanged
     */
    private async rootShapesOf(
        userToken: string,
        fileId: string,
        pageId: string
    ): Promise<{ shapes: RootShape[]; total: number; revn: number | undefined }> {
        const answer = await this.callCommand<{ root?: unknown; revn?: unknown } | undefined>(
            userToken,
            "get-mcp-page-tree",
            {
                fileId,
                pageId,
                depth: 2,
                limit: 5000,
                fields: ["name", "width", "height"],
            }
        );
        const root = ExportShapeBackendTool.recordOf(answer?.root);
        const listed: unknown = root?.children;
        const shapes = (Array.isArray(listed) ? listed : [])
            .map((node) => ExportShapeBackendTool.recordOf(node))
            .filter((node): node is Record<string, unknown> => typeof node?.id === "string")
            .map((node) => ({
                id: (node.id as string).toLowerCase(),
                type: BackendShapeTypes.toCallerType(typeof node.type === "string" ? node.type : "unknown"),
                name: typeof node.name === "string" ? node.name : "",
                width: node.width,
                height: node.height,
            }));
        const total = typeof root?.childCount === "number" ? root.childCount : shapes.length;
        const revn = typeof answer?.revn === "number" ? answer.revn : undefined;
        return { shapes, total, revn };
    }

    /**
     * Downloads the image of a shape fill and converts it to the requested format.
     *
     * @param args - the validated tool arguments
     * @param shapeId - id of the shape whose fill is exported; not "page"
     * @param userToken - the MCP token of the request
     * @param format - the output format
     * @returns the image bytes and their media type
     * @throws Error when the shape is a page, has no image, or the format cannot hold a fill image
     */
    private async renderFill(
        args: ExportShapeBackendArgs,
        shapeId: string,
        userToken: string,
        format: ExportFormat
    ): Promise<RenderedFile> {
        if (shapeId === "page") {
            throw new Error("Fill mode needs a shape id, not page.");
        }
        const { shape } = await this.readShape(userToken, args.fileId, args.pageId, shapeId);
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
     * Reads one shape of a page from the backend.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - id of the file that holds the shape
     * @param pageId - id of the page that holds the shape
     * @param shapeId - id of the shape to read
     * @param fields - attributes to return per shape; undefined returns the whole shape
     * @returns the shape as the backend returns it, and the revision of the file
     * @throws Error when the page does not hold the shape; other backend errors pass through unchanged
     */
    private async readShape(
        userToken: string,
        fileId: string,
        pageId: string,
        shapeId: string,
        fields?: string[]
    ): Promise<{ shape: Record<string, unknown>; revn: number | undefined }> {
        const answer = await this.callCommand<{ shapes?: unknown; revn?: unknown }>(userToken, "get-mcp-shapes", {
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
        const revn = typeof answer?.revn === "number" ? answer.revn : undefined;
        return { shape, revn };
    }

    /**
     * Builds the tool response for a rendered file, or saves it to the requested path through a temporary file.
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
            FileUtils.writeBinaryFileReplacing(filePath, file.bytes, { overwrite });
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
     * Returns the cached render of a shape, unless the call asks for a refresh.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param id - the shape id
     * @returns the cached file, or undefined when there is none, the revision is unknown or a refresh is asked
     */
    private cachedFile(plan: RenderPlan, id: string): RenderedFile | undefined {
        if (plan.refresh) {
            return undefined;
        }
        const key = ExportShapeBackendTool.cacheKeyOf(plan, id);
        return key === undefined ? undefined : this.services.renderCache.get(key);
    }

    /**
     * Stores a render in the cache, when its file revision is known.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param id - the shape id
     * @param file - the rendered file
     */
    private store(plan: RenderPlan, id: string, file: RenderedFile): void {
        const key = ExportShapeBackendTool.cacheKeyOf(plan, id);
        if (key !== undefined) {
            this.services.renderCache.put(key, file);
        }
    }
    /**
     * Stops the call when its time budget is spent. The shapes that are left are not rendered.
     *
     * @param state - the state of the call
     */
    private checkBudget(state: CallState): void {
        if (state.stop === undefined && this.now() - state.startedAt >= CALL_BUDGET_MS) {
            state.stop = { kind: "notRendered", message: ExportShapeBackendTool.stopText(state, "budget") };
        }
    }
    /**
     * Counts one step of a call and reports its progress to the client.
     *
     * @param state - the state of the call
     * @param message - what has just happened
     */
    private reportStep(state: CallState, message: string): void {
        state.done++;
        this.reportProgress(state.done, state.total, message);
    }

    /**
     * Creates the state of a call.
     *
     * @param total - the number of shapes of the call, for progress
     * @param stopOnFailure - whether a failed shape ends the rendering of the shapes after it
     * @param outputDir - whether the images are written to a folder, which changes the advice of a stop
     */
    private newState(total: number, stopOnFailure: boolean, outputDir: boolean): CallState {
        return {
            startedAt: this.now(),
            singles: false,
            stop: undefined,
            stopOnFailure,
            outputDir,
            breaker: undefined,
            inlineBytes: 0,
            inlineFull: false,
            done: 0,
            total,
            renderedTotal: 0,
            cachedTotal: 0,
        };
    }
    /**
     * Builds the plan of a render from the arguments and the reads of the call.
     *
     * @returns the plan
     */
    private planOf(
        fileId: string,
        pageId: string,
        userToken: string,
        format: ExportFormat,
        scale: number,
        renderer: ExportRenderer,
        profileId: string,
        revn: number | undefined,
        refresh: boolean
    ): RenderPlan {
        return { userToken, fileId, pageId, format, scale, renderer, profileId, revn, refresh };
    }

    /**
     * Waits for a number of milliseconds, or ends the wait at once when the caller cancels the call.
     *
     * @param ms - the wait in milliseconds
     * @throws the reason of the caller's signal when the call is cancelled during the wait
     */
    private pause(ms: number): Promise<void> {
        const signal = CallContext.current()?.signal;
        return new Promise<void>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(signal.reason);
                return;
            }
            const onAbort = (): void => {
                clearTimeout(timer);
                reject(signal?.reason);
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * Tells whether the caller of the call has cancelled it.
     *
     * @returns true when the MCP request was aborted
     */
    private callAborted(): boolean {
        return CallContext.current()?.signal?.aborted === true;
    }

    /**
     * Returns the cache key of a shape of a plan, or undefined when the file revision is not known.
     *
     * @param plan - the file, the page, the output and the revision of the render
     * @param id - the shape id
     * @returns the key, or undefined when nothing can be cached
     */
    private static cacheKeyOf(plan: RenderPlan, id: string): string | undefined {
        if (plan.revn === undefined) {
            return undefined;
        }
        return RenderCache.keyOf({
            fileId: plan.fileId,
            revn: plan.revn,
            pageId: plan.pageId,
            shapeId: id,
            format: plan.format,
            scale: plan.scale,
            renderer: plan.renderer,
        });
    }

    /**
     * Builds the exporter request of one shape of a plan. Its name is the shape id, which names its entry in a ZIP.
     *
     * @param plan - the file, the page, the output and the profile of the render
     * @param id - the shape id
     * @param name - the name of the export; a batch names each export by its shape id
     * @returns the request
     */
    private static requestOf(plan: RenderPlan, id: string, name: string = id): ExportShapeRequest {
        return {
            fileId: plan.fileId,
            pageId: plan.pageId,
            objectId: id,
            format: plan.format,
            scale: plan.scale,
            profileId: plan.profileId,
            name,
        };
    }

    /**
     * Returns the file name of a shape in outputDir: the shape id and the first extension of the format.
     *
     * @param id - the shape id
     * @param format - the output format
     */
    private static fileNameOf(id: string, format: ExportFormat): string {
        return `${id}${EXTENSIONS[format][0]}`;
    }

    /**
     * Tells whether an error is a busy exporter: a 429 answer, or a permit that no slot freed in time.
     *
     * @param error - the value that a call threw
     */
    private static isBusy(error: unknown): boolean {
        return error instanceof BusyError || (error instanceof ExporterError && error.status === 429);
    }

    /**
     * Tells whether an error is the render deadline of a request, which the permit reports.
     *
     * @param error - the value that a call threw
     */
    private static isDeadline(error: unknown): boolean {
        return error instanceof RenderDeadlineError;
    }
    /**
     * Tells whether an error is a server error, which is a 5xx answer.
     *
     * @param error - the value that a call threw
     */
    private static isServerError(error: unknown): boolean {
        return error instanceof ExporterError && error.status >= 500;
    }

    /**
     * Sorts an error into the class that decides whether a failure keeps coming back: authentication or authorization,
     * network or timeout, or an exporter 5xx. Other errors have no class.
     *
     * @param error - the value that a call threw
     * @returns the class, or undefined when the error has none
     */
    private static classOf(error: unknown): FailureClass | undefined {
        if (error instanceof ExporterError) {
            if (error.status === 401 || error.status === 403) {
                return "auth";
            }
            return error.status >= 500 ? "server" : undefined;
        }
        if (error instanceof ExporterUnreachableError || error instanceof RenderDeadlineError) {
            return "network";
        }
        return undefined;
    }

    /**
     * Returns the wording of a stop, without a final period. With outputDir the advice is to call again with
     * overwrite true, since the files of the first call exist.
     *
     * @param state - the state of the call
     * @param reason - why the call stops
     */
    private static stopText(state: CallState, reason: "busy" | "cancelled" | "budget"): string {
        const cause =
            reason === "busy"
                ? "export is busy, retry later"
                : reason === "cancelled"
                  ? "the call was cancelled"
                  : "the call ran out of time";
        const advice = state.outputDir
            ? "call again with overwrite: true; the shapes already rendered come from the cache"
            : "call again; the shapes already rendered come from the cache";
        return `${cause}; ${advice}`;
    }

    /**
     * Ends a text with exactly one period.
     *
     * @param text - the text
     */
    private static endSentence(text: string): string {
        return text.endsWith(".") ? text : `${text}.`;
    }
    /**
     * Returns the outcome that a stopped call gives to a shape it did not reach.
     *
     * @param stop - the stop of the call
     */
    private static stopOutcome(stop: Stop): ChunkOutcome {
        return stop.kind === "failed"
            ? { kind: "failed", error: stop.message }
            : { kind: "notRendered", reason: stop.message };
    }

    /**
     * Returns the result that a stopped call gives to a shape it did not reach.
     *
     * @param stop - the stop of the call
     */
    private static stopResult(stop: Stop): Result {
        return stop.kind === "failed"
            ? { kind: "failed", error: stop.message }
            : { kind: "notRendered", reason: stop.message };
    }

    /**
     * Counts a shape as cached or rendered by the call.
     *
     * @param state - the state of the call
     * @param cached - whether the shape came from the cache
     */
    private static count(state: CallState, cached: boolean): void {
        if (cached) {
            state.cachedTotal++;
        } else {
            state.renderedTotal++;
        }
    }

    /**
     * Lists the shape ids that a reply shows or counts as rendered: the kept images and the images too large to keep.
     *
     * @param ids - the shape ids of the call
     * @param results - the outcome of each shape
     * @returns the ids that were rendered or cached, in the order asked
     */
    private static servedIdsOf(ids: string[], results: Map<string, Result>): string[] {
        return ids.filter((id) => {
            const kind = results.get(id)?.kind;
            return kind === "file" || kind === "notReturned";
        });
    }
    /**
     * Returns the warnings of the fonts that did not resolve in a fonts answer.
     *
     * @param answer - the answer of the fonts command
     */
    private static unresolvedOf(answer: { fonts?: unknown } | undefined): FontWarning[] {
        const warnings: FontWarning[] = [];
        for (const candidate of Array.isArray(answer?.fonts) ? answer.fonts : []) {
            const font = ExportShapeBackendTool.recordOf(candidate);
            if (font?.resolved !== false) {
                continue;
            }
            warnings.push({
                kind: "font-unresolved",
                fontId: typeof font.fontId === "string" ? font.fontId : "",
                family: typeof font.family === "string" ? font.family : "",
                reason: typeof font.reason === "string" ? font.reason : "",
                runs: typeof font.runs === "number" ? font.runs : 0,
            });
        }
        return warnings;
    }

    /**
     * Returns the text of the font notice: which fonts fell back, where to look them up, and how long the renders
     * stay in the cache.
     *
     * @param warnings - the warnings, one per unresolved font
     */
    private static fontWarningText(warnings: FontWarning[]): string {
        const names = warnings.map(
            (warning) => `${warning.family || "(no family)"} (font ${warning.fontId}, reason ${warning.reason})`
        );
        return (
            "Font warning: these fonts did not resolve, so the render used a fallback font: " +
            `${names.join("; ")}. Use list_fonts to see every font of the file and where it comes from. ` +
            `${CACHE_NOTE}`
        );
    }
    /**
     * Tells whether a path exists and is not a folder.
     *
     * @param folder - the path to look at
     * @throws Error when the path cannot be read for another reason than being absent
     */
    private static isFileNotFolder(folder: string): boolean {
        try {
            return !fs.statSync(folder).isDirectory();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
            }
            throw error;
        }
    }

    /**
     * Tells whether anything is at a path, a link included.
     *
     * @param target - the path to look at
     */
    private static isThere(target: string): boolean {
        try {
            fs.lstatSync(target);
            return true;
        } catch {
            return false;
        }
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
     * @param bytes - the size of the rendered shape
     * @param format - the output format
     * @param overText - true when the limit is the inline limit of svg or pdf, false for the page total
     */
    private static pageLimitError(bytes: number, format: ExportFormat, overText: boolean): Error {
        if (overText) {
            return new Error(
                `The first root shape of the page is ${Math.round(bytes / 1000)} kB ${format}, above the ` +
                    `256 kB limit for inline ${format} output. Export that shape by id with filePath, or at a smaller scale.`
            );
        }
        const megabytes = (bytes / (1024 * 1024)).toFixed(1);
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

/** What one render needs: the file, the page, the output, the renderer, the profile and the file revision. */
interface RenderPlan {
    /** MCP token of the request. */
    userToken: string;
    /** Id of the file. */
    fileId: string;
    /** Id of the page that holds the shapes. */
    pageId: string;
    /** Output format. */
    format: ExportFormat;
    /** Scale factor. */
    scale: number;
    /** Renderer of the exporter. */
    renderer: ExportRenderer;
    /** Profile that makes the export. */
    profileId: string;
    /** Revision of the file from the read, or undefined when the read did not give one: nothing is cached then. */
    revn: number | undefined;
    /** True when the cache is ignored for this call. */
    refresh: boolean;
}

/** Options of one run of the renders of a call. */
interface RenderOptions {
    /** Output format, which decides the text limit of an inline reply. */
    format: ExportFormat;
    /** True when the images come back inline. */
    inline: boolean;
    /** Folder that the images are written to, or undefined for an inline reply. */
    outputDir: string | undefined;
    /** Whether an existing file may be replaced. */
    overwrite: boolean;
}

/** Why a call stopped early, and what the shapes it did not reach get. */
interface Stop {
    /** Failed when the failure is the cause (busy, cancelled); not rendered when the call ran out of room or time. */
    kind: "failed" | "notRendered";
    /** The text of the failure, or of the reason. */
    message: string;
}

/** The state of one call: its clock, its stop, its inline total, its breaker and its counts. */
interface CallState {
    /** Time the call started, in milliseconds on the clock of the tool. */
    startedAt: number;
    /** True when the rest of the call goes one shape at a time, after a deadline, an answer too large or a batch that cannot be mapped. */
    singles: boolean;
    /** Set when the call ends early. */
    stop: Stop | undefined;
    /** True when a failed shape ends the renders of the shapes after it, as a page export does. */
    stopOnFailure: boolean;
    /** True when the images are written to a folder, which changes the advice of a stop. */
    outputDir: boolean;
    /** The class of failure that every single of the previous chunk failed with, or undefined. */
    breaker: FailureClass | undefined;
    /** Bytes of the inline images kept so far. */
    inlineBytes: number;
    /** True once the inline total is full: no further chunk is sent. */
    inlineFull: boolean;
    /** Steps reported so far. */
    done: number;
    /** Steps of the call, for progress. */
    total: number;
    /** Shapes rendered by the call, not taken from the cache. */
    renderedTotal: number;
    /** Shapes taken from the cache. */
    cachedTotal: number;
}

/** The outcome of one shape of a chunk, before it is delivered. */
type ChunkOutcome =
    | { kind: "file"; file: RenderedFile; cached: boolean }
    | { kind: "failed"; error: string; cls?: FailureClass }
    | { kind: "notRendered"; reason: string };

/** A shape that was rendered or taken from the cache, and is kept as the file or written to the folder. */
interface FileResult {
    /** The result is a file. */
    kind: "file";
    /** Whether the file came from the cache. */
    cached: boolean;
    /** Size of the file in bytes. */
    bytes: number;
    /** The file, kept for an inline reply only. */
    file?: RenderedFile;
    /** The path the file was written to, for outputDir only. */
    path?: string;
}

/** The result of one shape of a call. */
type Result =
    | FileResult
    | { kind: "failed"; error: string }
    | { kind: "notReturned"; reason: "size" | "single" | "text"; bytes: number }
    | { kind: "notRendered"; reason: string };

/** The outcome of the font check of a call. */
interface FontCheck {
    /** True when the fonts were asked for and answered in time. */
    checked: boolean;
    /** The fonts that did not resolve. */
    warnings: FontWarning[];
}

/** Marks a font check that did not answer in time. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/** A font that did not resolve, so that the render used a fallback. */
interface FontWarning {
    /** Kind of the warning. */
    kind: "font-unresolved";
    /** Id of the font. */
    fontId: string;
    /** Family of the font. */
    family: string;
    /** Why the font did not resolve. */
    reason: string;
    /** Number of text runs that use the font. */
    runs: number;
}

/** A root shape of a page, as the page export reads it. */
interface RootShape {
    /** Id of the shape, in lower case. */
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
