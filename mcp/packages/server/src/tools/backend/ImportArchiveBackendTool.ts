import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { FileUtils } from "../../utils/FileUtils";
import { BodyLimit } from "../../utils/BodyLimit";
import { PublicAddressPolicy } from "../../utils/PublicAddressPolicy";
import { Semaphore } from "../../utils/Semaphore";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Describes the base64 argument; the body cap is noted here because the cap is set by the environment. */
const BASE64_DESCRIPTION =
    "Archive bytes as base64. A data: URL is accepted too. Limited by the request body cap " +
    "(PENPOT_MCP_MAX_BODY_MB, 32 MB by default): archives above it must use filePath or url. " +
    "Give exactly one of base64, url or filePath.";

/** Arguments of {@link ImportArchiveBackendTool}. */
export class ImportArchiveBackendArgs {
    static schema = {
        projectId: BackendIds.uuid().describe("Id of the project that receives the new file, from list_projects."),
        base64: z.string().min(1).optional().describe(BASE64_DESCRIPTION),
        url: z
            .string()
            .min(1)
            .max(2048)
            .optional()
            .describe(
                "http or https address of a .penpot archive, downloaded by the MCP server (local mode only). " +
                    "Give exactly one of base64, url or filePath."
            ),
        filePath: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Absolute path of a .penpot archive on this machine. Give exactly one of base64, url or filePath."
            ),
        name: z
            .string()
            .min(1)
            .max(250)
            .optional()
            .describe("Name of the new file. Default: the archive file name without its extension, or Imported file."),
    };

    projectId!: string;

    base64?: string;

    url?: string;

    filePath?: string;

    name?: string;
}

/** Archive bytes read from base64 text, a URL or a local file. */
interface ArchiveSource {
    /** Raw archive bytes. */
    bytes: Uint8Array;
    /** File name of the archive without its extension, when it came from a file. */
    baseName?: string;
}

/** Imports a .penpot archive as a new file in a project. */
export class ImportArchiveBackendTool extends BackendTool<ImportArchiveBackendArgs> {
    /** Largest archive accepted, in bytes. */
    public static readonly MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

    /** Longest time a download may take, in milliseconds. */
    private static readonly DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

    /** Longest time the backend may take to import an archive, in milliseconds. */
    private static readonly IMPORT_TIMEOUT_MS = 15 * 60 * 1000;

    /** Most redirects that one download may follow. */
    private static readonly MAX_REDIRECTS = 5;

    /** Number of archive imports that may run at once, across all sessions of the process. */
    private static readonly imports = new Semaphore("import_archive", 2);

    /**
     * Creates the archive import tool. The filePath argument is offered only in local mode, and the url
     * argument only in local mode too, because the server then downloads on the user's machine.
     *
     * @param mcpServer - The MCP server instance, which tells whether local file paths and downloads may be used
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        const schema: Record<string, z.ZodType> = { ...ImportArchiveBackendArgs.schema };
        if (!mcpServer.isFileSystemAccessEnabled()) {
            // local file paths are only accepted when the server may read the local file system
            delete schema.filePath;
        }
        if (mcpServer.isRemoteMode()) {
            // the server must not fetch addresses on behalf of remote users
            delete schema.url;
        }
        // an inline archive travels in the request body, so the body cap bounds its base64 text
        schema.base64 = z.string().min(1).max(BodyLimit.bytesOf(process.env)).optional().describe(BASE64_DESCRIPTION);
        super(mcpServer, schema, services);
    }

    public getToolName(): string {
        return "import_archive";
    }

    public getToolDescription(): string {
        return (
            "Imports a .penpot archive into a project as a new file. " +
            "Give exactly one of base64, url or filePath. Up to 200 MB. " +
            "url is downloaded by the MCP server (local mode only). " +
            "Inline base64 is limited by the request body cap (PENPOT_MCP_MAX_BODY_MB, 32 MB by default); " +
            "archives above that cap must use filePath or url. " +
            "Returns the ids of the new files. " +
            "Next: list_files to see the new files."
        );
    }

    /**
     * Loads the archive from the one source that the arguments name, then uploads it to the backend.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when no source or more than one source is given, or the archive is invalid
     */
    protected async executeBackend(args: ImportArchiveBackendArgs, userToken: string): Promise<ToolResponse> {
        const sourceCount = [args.base64, args.url, args.filePath].filter((value) => value !== undefined).length;
        if (sourceCount !== 1) {
            throw new Error("Give exactly one of base64, url or filePath.");
        }
        const archive = await this.loadArchive(args);
        const name = args.name ?? archive.baseName ?? "Imported file";
        if (name.length < 1 || name.length > 250) {
            throw new Error("The file name must be 1 to 250 characters. Pass name.");
        }
        const answer = await ImportArchiveBackendTool.imports.withPermit(() =>
            this.callMultipart<unknown>(
                userToken,
                "import-binfile",
                { name, "project-id": args.projectId, version: "3" },
                [
                    {
                        fieldName: "file",
                        fileName: "archive.penpot",
                        mimeType: "application/octet-stream",
                        content: archive.bytes,
                    },
                ],
                { timeoutMs: ImportArchiveBackendTool.IMPORT_TIMEOUT_MS }
            )
        );
        const fileIds = ImportArchiveBackendTool.fileIdsOf(answer);
        return this.jsonResponse({ fileIds, ...(fileIds.length === 0 ? { result: answer } : {}) });
    }

    /**
     * Reads the archive bytes from the source that the arguments name.
     *
     * @param args - the validated tool arguments, with exactly one source set
     * @throws Error when the source is missing, invalid, empty, too large or not a zip archive
     */
    private async loadArchive(args: ImportArchiveBackendArgs): Promise<ArchiveSource> {
        if (args.base64 !== undefined) {
            // a data: URL prefix is optional, so the decoder strips it when present
            const bytes = Buffer.from(args.base64.replace(/^data:[^,]*;base64,/, ""), "base64");
            ImportArchiveBackendTool.checkSize(bytes.length);
            ImportArchiveBackendTool.checkZip(bytes);
            return { bytes };
        }
        if (args.url !== undefined) {
            if (this.mcpServer.isRemoteMode()) {
                throw new Error("url is not accepted in remote mode. Send the archive as base64.");
            }
            const bytes = await this.download(args.url);
            ImportArchiveBackendTool.checkZip(bytes);
            return { bytes };
        }
        if (args.filePath !== undefined) {
            FileUtils.checkPathIsAbsolute(args.filePath);
            if (!fs.existsSync(args.filePath)) {
                throw new Error(`File not found: ${args.filePath}`);
            }
            // check the size before reading, so that a large archive is never loaded
            ImportArchiveBackendTool.checkSize(fs.statSync(args.filePath).size);
            const bytes = fs.readFileSync(args.filePath);
            ImportArchiveBackendTool.checkZip(bytes);
            return {
                bytes,
                baseName: path.basename(args.filePath, path.extname(args.filePath)),
            };
        }
        throw new Error("Give exactly one of base64, url or filePath.");
    }

    /**
     * Downloads the archive from an http or https address. Each hop of a redirect is checked against the
     * address policy, and at most {@link MAX_REDIRECTS} redirects are followed.
     *
     * @param url - the address of the archive
     * @throws Error when the address is not http or https, points to a refused address, the status is not OK,
     *   there are too many redirects, or the archive is too large
     */
    private async download(url: string): Promise<Uint8Array> {
        if (!/^https?:\/\//i.test(url)) {
            throw new Error("The url must start with http:// or https://.");
        }
        const response = await this.followRedirects(new URL(url));
        if (!response.ok) {
            throw new Error(`The download failed with HTTP status ${response.status}.`);
        }
        // refuse early when the server declares a size above the limit
        if (Number(response.headers.get("content-length") ?? 0) > ImportArchiveBackendTool.MAX_ARCHIVE_BYTES) {
            throw new Error("The archive is larger than 200 MB.");
        }
        const body = response.body;
        if (body === null) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            ImportArchiveBackendTool.checkSize(bytes.length);
            return bytes;
        }
        // the declared size can be wrong or missing, so the bytes are counted while they arrive
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > ImportArchiveBackendTool.MAX_ARCHIVE_BYTES) {
                await reader.cancel();
                throw new Error("The archive is larger than 200 MB.");
            }
            chunks.push(value);
        }
        ImportArchiveBackendTool.checkSize(total);
        return Buffer.concat(chunks);
    }

    /**
     * Fetches an address by hand, checking every hop before it is requested.
     *
     * @param start - the first address to fetch
     * @returns the response of the final hop, with its body unread
     * @throws Error when a hop points to a refused address or a non-http scheme, or when there are too many redirects
     */
    private async followRedirects(start: URL): Promise<Response> {
        let current = start;
        for (let hop = 0; ; hop++) {
            if (!["http:", "https:"].includes(current.protocol)) {
                throw new Error("The url must start with http:// or https://.");
            }
            await PublicAddressPolicy.assertPublicHost(current);
            const response = await fetch(current, {
                redirect: "manual",
                signal: AbortSignal.timeout(ImportArchiveBackendTool.DOWNLOAD_TIMEOUT_MS),
            });
            const location = response.headers.get("location");
            if (response.status < 300 || response.status > 399 || location === null) {
                return response;
            }
            await response.body?.cancel();
            if (hop >= ImportArchiveBackendTool.MAX_REDIRECTS) {
                throw new Error(`The download followed more than ${ImportArchiveBackendTool.MAX_REDIRECTS} redirects.`);
            }
            current = new URL(location, current);
        }
    }

    /**
     * Returns the file ids in a `import-binfile` answer, under `fileIds`, `file-ids` or as a bare array.
     *
     * @param answer - the data of the last event of the backend answer
     */
    private static fileIdsOf(answer: unknown): string[] {
        const record = (answer ?? {}) as { fileIds?: unknown; "file-ids"?: unknown };
        let list: unknown[] = [];
        if (Array.isArray(answer)) {
            list = answer;
        } else if (Array.isArray(record.fileIds)) {
            list = record.fileIds;
        } else if (Array.isArray(record["file-ids"])) {
            list = record["file-ids"];
        }
        return list.filter((id): id is string => typeof id === "string");
    }

    /**
     * Rejects bytes that do not start with the zip signature, which every .penpot archive has.
     *
     * @param bytes - the archive bytes
     * @throws Error when the bytes are not a zip archive
     */
    private static checkZip(bytes: Uint8Array): void {
        const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (!isZip) {
            throw new Error("The file is not a .penpot archive (it is not a zip file).");
        }
    }

    /**
     * Rejects empty archives and archives above the size limit.
     *
     * @param size - the archive size in bytes
     * @throws Error when the size is zero or above {@link MAX_ARCHIVE_BYTES}
     */
    private static checkSize(size: number): void {
        if (size === 0) {
            throw new Error("The archive is empty.");
        }
        if (size > ImportArchiveBackendTool.MAX_ARCHIVE_BYTES) {
            throw new Error("The archive is larger than 200 MB.");
        }
    }
}
