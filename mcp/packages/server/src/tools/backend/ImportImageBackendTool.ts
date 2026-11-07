import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { FileUtils } from "../../utils/FileUtils";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { ImportDirectory } from "./ImportDirectory";
import { WriteOptions } from "./WriteOptions";

/** Arguments of {@link ImportImageBackendTool}. */
export class ImportImageBackendArgs {
    /** MIME types the tool accepts. */
    private static readonly MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

    /** Longest accepted base64 text, in characters (24 MB). */
    public static readonly BASE64_MAX_CHARS = 24 * 1024 * 1024;

    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file that receives the image, from list_files."),
        base64: z
            .string()
            .min(1)
            .max(ImportImageBackendArgs.BASE64_MAX_CHARS)
            .optional()
            .describe(
                "Image bytes as base64, up to 24 MB of base64 text. A data: URL is accepted too. " +
                    "Give exactly one of base64, url or filePath."
            ),
        url: z
            .string()
            .min(1)
            .max(2048)
            .optional()
            .describe(
                "http or https address of the image. The backend downloads it. Give exactly one of base64, url or filePath."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path of an image file inside the import directory (PENPOT_MCP_IMPORT_DIR, penpot-imports " +
                    "in the home directory by default). Give exactly one of base64, url or filePath."
            ),
        mimeType: z
            .enum(ImportImageBackendArgs.MIME_TYPES)
            .optional()
            .describe("MIME type to use when the bytes do not show their type. Usually not needed."),
        name: z
            .string()
            .min(1)
            .max(250)
            .optional()
            .describe("Name of the image file and of the media object. Default: the file name, or image."),
        pageId: BackendIds.uuid()
            .optional()
            .describe("Id of the page that receives the shape. Default: the first page."),
        parentId: BackendIds.uuid()
            .optional()
            .describe("Id of the board or group that receives the shape. Default: the page root."),
        x: z.number().optional().describe("X position of the shape. Default: 0."),
        y: z.number().optional().describe("Y position of the shape. Default: 0."),
        width: z
            .number()
            .positive()
            .optional()
            .describe(
                "Width of the shape. If only width is given, the height keeps the aspect ratio. Default: the image width."
            ),
        height: z
            .number()
            .positive()
            .optional()
            .describe(
                "Height of the shape. If only height is given, the width keeps the aspect ratio. Default: the image height."
            ),
        createShape: z
            .boolean()
            .optional()
            .describe("When false, only upload the image and return its media id. Default: true."),
        ...WriteOptions.schema,
    };

    fileId!: string;

    base64?: string;

    url?: string;

    filePath?: string;

    mimeType?: string;

    name?: string;

    pageId?: string;

    parentId?: string;

    x?: number;

    y?: number;

    width?: number;

    height?: number;

    createShape?: boolean;

    dryRun?: boolean;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    requestId?: string;
}

/** Image bytes read from base64 text or a local file. */
interface LoadedImage {
    /** Raw image bytes. */
    bytes: Uint8Array;
    /** File name of the image on disk, when it came from a file. */
    fileName?: string;
}

/** Media object that the backend returns for a stored image. */
interface MediaObject {
    /** Id of the media object. */
    id: string;
    /** Name of the media object. */
    name?: string;
    /** Width of the image in pixels. */
    width: number;
    /** Height of the image in pixels. */
    height: number;
    /** MIME type the backend stored. */
    mtype: string;
}

/** Answer of the `mcp-apply-operations` command. */
interface ApplyAnswer {
    /** Revision the file has after the write. */
    revn: number;
    /** Ids of the created shapes, keyed by their `$tmp:` handle. */
    createdIds: Record<string, string>;
    /** True when an earlier call with the same requestId already applied this write. */
    alreadyApplied?: boolean;
}

/** Stores a raster image in a file and places it as an image shape. */
export class ImportImageBackendTool extends BackendTool<ImportImageBackendArgs> {
    /** Largest image accepted, in bytes. */
    public static readonly MAX_IMAGE_BYTES = 50 * 1024 * 1024;

    /** File name extension of an uploaded image, by MIME type. */
    private static readonly EXTENSIONS: Readonly<Record<string, string>> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
    };

    /** Magic bytes that start every PNG file. */
    private static readonly PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    /** Magic bytes that start every JPEG file. */
    private static readonly JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

    /**
     * Creates the image import tool.
     *
     * @param mcpServer - The MCP server instance, which tells whether local file paths may be read
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        const schema: Record<string, z.ZodType> = { ...ImportImageBackendArgs.schema };
        if (!mcpServer.isFileSystemAccessEnabled()) {
            // local file paths are only accepted when the server may read the local file system
            delete schema.filePath;
        }
        super(mcpServer, schema, services);
    }

    public getToolName(): string {
        return "import_image";
    }

    public getToolDescription(): string {
        return (
            "Adds a raster image to a file as a media object, and by default as an image shape. " +
            "Supported formats: PNG, JPEG, GIF, WEBP. Up to 50 MB from a url or filePath; inline base64 is limited " +
            "to 24 MB of base64 text, about 18 MB of image. Give exactly one of base64, url or filePath. " +
            "The shape goes on the first page unless pageId is given. Give parentId to place it in a board or group. " +
            "If only width or only height is given, the other size keeps the aspect ratio. " +
            "Without width or height, the image keeps its own size. " +
            "Set createShape to false to only upload the image. " +
            "The write options apply to the shape; the upload is always stored. " +
            "Next: get_page_tree to find the new shape."
        );
    }

    /**
     * Uploads the image, then places it as an image shape unless createShape is false.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     */
    protected async executeBackend(args: ImportImageBackendArgs, userToken: string): Promise<ToolResponse> {
        const sourceCount = [args.base64, args.url, args.filePath].filter((value) => value !== undefined).length;
        if (sourceCount !== 1) {
            throw new Error("Give exactly one of base64, url or filePath.");
        }

        const media =
            args.url !== undefined
                ? await this.createMediaFromUrl(userToken, args.fileId, args.url, args.name)
                : await this.uploadImage(userToken, args, await this.loadImage(args));

        if (args.createShape === false) {
            return this.jsonResponse(ImportImageBackendTool.mediaSummary(media));
        }

        const pageId = args.pageId ?? (await this.firstPageId(userToken, args.fileId));
        const answer = await this.callWrite<ApplyAnswer>(userToken, args.fileId, "mcp-apply-operations", {
            fileId: args.fileId,
            operations: [ImportImageBackendTool.createImageOperation(args, media, pageId)],
            ...WriteOptions.toParams(args),
        });
        return this.jsonResponse(
            WriteOptions.withAlreadyApplied({
                ...ImportImageBackendTool.mediaSummary(media),
                shapeId: answer.createdIds["$tmp:image"],
                revn: answer.revn,
                alreadyApplied: answer.alreadyApplied,
            })
        );
    }

    /**
     * Reads the image bytes from the base64 text or the local file that the arguments name.
     *
     * @param args - the validated tool arguments, with exactly one source set
     * @throws Error when the file is outside the import directory, missing, relative, empty or too large
     */
    private async loadImage(args: ImportImageBackendArgs): Promise<LoadedImage> {
        if (args.base64 !== undefined) {
            // a data: URL prefix is optional, so the decoder strips it when present
            const bytes = Buffer.from(args.base64.replace(/^data:[^,]*;base64,/, ""), "base64");
            ImportImageBackendTool.checkSize(bytes.length);
            return { bytes };
        }
        if (args.filePath !== undefined) {
            FileUtils.checkPathIsAbsolute(args.filePath);
            // the root check comes first, so that a path outside the root never shows whether it exists
            ImportDirectory.assertReadable(args.filePath, process.env);
            const size = await ImportImageBackendTool.sizeOf(args.filePath);
            // check the size before reading, so that a large file is never loaded
            ImportImageBackendTool.checkSize(size);
            const bytes = await fs.promises.readFile(args.filePath);
            // a file that is not a supported image is refused before any upload
            if (ImportImageBackendTool.detectMimeType(bytes) === undefined) {
                throw new Error("The file is not a PNG, JPEG, GIF or WEBP image.");
            }
            return { bytes, fileName: path.basename(args.filePath) };
        }
        throw new Error("Give exactly one of base64, url or filePath.");
    }

    /**
     * Uploads image bytes to the media library of the file.
     *
     * @param userToken - the MCP token of the request
     * @param args - the validated tool arguments
     * @param image - the image bytes and the file name they came from
     * @throws Error when the bytes are not a PNG, JPEG, GIF or WEBP image and no mimeType is given
     */
    private uploadImage(userToken: string, args: ImportImageBackendArgs, image: LoadedImage): Promise<MediaObject> {
        const mimeType = ImportImageBackendTool.detectMimeType(image.bytes) ?? args.mimeType;
        if (mimeType === undefined) {
            throw new Error("Unsupported image format. Use PNG, JPEG, GIF or WEBP.");
        }
        const fileName = args.name ?? image.fileName ?? `image.${ImportImageBackendTool.EXTENSIONS[mimeType]}`;
        return this.callMultipartWrite<MediaObject>(
            userToken,
            args.fileId,
            "upload-file-media-object",
            { "file-id": args.fileId, "is-local": "true", name: fileName },
            [{ fieldName: "content", fileName, mimeType, content: image.bytes }]
        );
    }

    /**
     * Asks the backend to download an image and store it in the media library of the file.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file that receives the media object
     * @param url - http or https address of the image
     * @param name - name of the media object, when given
     * @throws Error when the address does not start with http:// or https://
     */
    private createMediaFromUrl(
        userToken: string,
        fileId: string,
        url: string,
        name: string | undefined
    ): Promise<MediaObject> {
        if (!/^https?:\/\//i.test(url)) {
            throw new Error("The url must start with http:// or https://.");
        }
        return this.callWrite<MediaObject>(userToken, fileId, "create-file-media-object-from-url", {
            fileId,
            isLocal: true,
            url,
            ...(name !== undefined ? { name } : {}),
        });
    }

    /**
     * Returns the id of the first page of a file.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - file whose outline is read
     * @throws Error when the file has no pages
     */
    private async firstPageId(userToken: string, fileId: string): Promise<string> {
        const outline = await this.callCommand<{ pages?: { id: string }[] }>(userToken, "get-mcp-file-outline", {
            fileId,
        });
        const first = outline.pages?.[0];
        if (first === undefined) {
            throw new Error("The file has no pages.");
        }
        return first.id;
    }

    /**
     * Builds the `create_image` operation that places the stored image on a page.
     *
     * @param args - the validated tool arguments
     * @param media - the stored image
     * @param pageId - page that receives the shape
     */
    private static createImageOperation(
        args: ImportImageBackendArgs,
        media: MediaObject,
        pageId: string
    ): Record<string, unknown> {
        const size = ImportImageBackendTool.shapeSize(args, media);
        const name = args.name ?? media.name;
        return {
            op: "create_image",
            id: "$tmp:image",
            pageId,
            ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
            x: args.x ?? 0,
            y: args.y ?? 0,
            width: size.width,
            height: size.height,
            mediaId: media.id,
            mediaWidth: media.width,
            mediaHeight: media.height,
            mediaMtype: media.mtype,
            ...(name !== undefined ? { name } : {}),
        };
    }

    /**
     * Returns the size of the shape. A missing width or height follows the aspect ratio of the image.
     *
     * @param args - the validated tool arguments
     * @param media - the stored image, whose size is the default
     */
    private static shapeSize(args: ImportImageBackendArgs, media: MediaObject): { width: number; height: number } {
        if (args.width !== undefined && args.height !== undefined) {
            return { width: args.width, height: args.height };
        }
        if (args.width !== undefined) {
            return { width: args.width, height: (args.width * media.height) / media.width };
        }
        if (args.height !== undefined) {
            return { width: (args.height * media.width) / media.height, height: args.height };
        }
        return { width: media.width, height: media.height };
    }

    /**
     * Returns the fields of the media object that the response reports.
     *
     * @param media - the stored image
     */
    private static mediaSummary(media: MediaObject): { mediaId: string; width: number; height: number; mtype: string } {
        return { mediaId: media.id, width: media.width, height: media.height, mtype: media.mtype };
    }

    /**
     * Detects the image type from the first bytes of the file.
     *
     * @param bytes - the image bytes
     * @returns the MIME type, or undefined when the bytes are not a supported image
     */
    private static detectMimeType(bytes: Uint8Array): string | undefined {
        const head = Buffer.from(bytes.subarray(0, 12));
        if (head.subarray(0, 8).equals(ImportImageBackendTool.PNG_SIGNATURE)) {
            return "image/png";
        }
        if (head.subarray(0, 3).equals(ImportImageBackendTool.JPEG_SIGNATURE)) {
            return "image/jpeg";
        }
        const start = head.toString("latin1", 0, 6);
        if (start === "GIF87a" || start === "GIF89a") {
            return "image/gif";
        }
        if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
            return "image/webp";
        }
        return undefined;
    }

    /**
     * Returns the size of a file, or fails with the file-not-found text when it is missing.
     *
     * @param filePath - the absolute path, already checked to lie in the import directory
     * @throws Error when the file is missing or is not a file
     */
    private static async sizeOf(filePath: string): Promise<number> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            throw new Error(`File not found: ${filePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`File not found: ${filePath}`);
        }
        return stat.size;
    }

    /**
     * Rejects empty images and images above the size limit.
     *
     * @param size - the image size in bytes
     * @throws Error when the size is zero or above {@link MAX_IMAGE_BYTES}
     */
    private static checkSize(size: number): void {
        if (size === 0) {
            throw new Error("The image is empty.");
        }
        if (size > ImportImageBackendTool.MAX_IMAGE_BYTES) {
            throw new Error("The image is larger than 50 MB.");
        }
    }
}
