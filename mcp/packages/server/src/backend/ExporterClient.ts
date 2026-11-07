import type { Dispatcher } from "undici";
import { BackendSettings } from "./BackendSettings";
import { withDispatcher } from "./ConnectionPools";
import { CappedBody } from "./CappedBody";
import { Transit } from "./Transit";
import { CallContext } from "./CallContext";

/** Format that the exporter can render a shape to. */
export type ExportFormat = "png" | "svg" | "jpeg" | "webp" | "pdf";

/** A request to render one shape. The exporter renders one object per request; a page export sends one request per root shape. */
export interface ExportShapeRequest {
    /** Identifier of the file that holds the shape. */
    fileId: string;
    /** Identifier of the page that holds the shape. */
    pageId: string;
    /** Identifier of the shape. */
    objectId: string;
    /** Format of the rendered file. */
    format: ExportFormat;
    /** Scale factor of the rendering. */
    scale: number;
    /** Identifier of the profile that owns the render session. */
    profileId: string;
    /** Name of the exported file. */
    name: string;
}

/** Bytes of a rendered file with the media type reported for them. */
export interface RenderedFile {
    /** Raw bytes of the file. */
    bytes: Uint8Array;
    /** Media type of the bytes, such as `image/png`. */
    mimeType: string;
}

/** Renders shapes through the Penpot exporter and downloads the rendered assets from the backend. */
export interface ExporterClient {
    /**
     * Renders one shape and downloads the rendered file.
     *
     * @param renderToken - render session token that authorizes the export
     * @param request - shape, file and format to render
     * @returns the rendered bytes and their media type
     * @throws ExporterError when the exporter answers with an error status
     * @throws Error when the exporter does not respond or its answer has no asset uri
     */
    exportShape(renderToken: string, request: ExportShapeRequest): Promise<RenderedFile>;

    /**
     * Downloads one stored asset from the backend.
     *
     * @param renderToken - render session token that authorizes the download
     * @param assetId - identifier of the asset, as a UUID
     * @returns the asset bytes and their media type
     * @param baseUri - base URI that the asset path is joined to; defaults to PENPOT_MCP_ASSETS_URI, or the backend
     * @throws ExporterError when the backend refuses the session or lacks the asset
     * @throws Error when the asset identifier is not a UUID
     */
    downloadAsset(renderToken: string, assetId: string, baseUri?: URL): Promise<RenderedFile>;
}

/** Error raised when the exporter or the backend answers a render request with an error status. */
export class ExporterError extends Error {
    /**
     * Creates an error for a failed render request.
     *
     * @param status - HTTP status returned by the exporter or the backend
     * @param message - message shown to users; a backend asset failure may quote the first 200 characters of its body
     */
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "ExporterError";
    }
}

/**
 * Exporter client that speaks HTTP: it posts transit export requests to the exporter and downloads the
 * rendered assets.
 *
 * Assets are downloaded from the base URI of PENPOT_MCP_ASSETS_URI when it is set. Otherwise they come from the
 * origin of the uri that the exporter answers with, which is the public URI of the backend. A download without an
 * exporter answer, such as a fill image, uses the backend URI.
 */
export class HttpExporterClient implements ExporterClient {
    /** Matches the asset identifier in the path of an asset uri. */
    private static readonly ASSET_URI_PATTERN = /\/assets\/by-id\/([0-9a-f-]{36})/i;
    /** Matches a canonical UUID, checked before an asset identifier enters a URL. */
    private static readonly UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    /** Media type that stands for an unknown type. */
    private static readonly OCTET_STREAM = "application/octet-stream";

    /** Hint that every no-file answer carries, so that the operator knows which variable to change. */
    private static readonly PUBLIC_URI_HINT =
        "Set PENPOT_MCP_ASSETS_URI to the public URI that serves /assets/by-id/ (the nginx URI), " +
        "or point PENPOT_MCP_BACKEND_URI at it.";

    private readonly exporterUri: URL;
    private readonly backendUri: URL;
    private readonly maxResponseBytes: number;
    private readonly maxResponseMb: number;
    /** Base URI of the asset downloads, with a trailing slash, or undefined to use the origin named by the exporter. */
    private readonly assetsUri: URL | undefined;

    /**
     * Creates a client for one exporter and one backend.
     *
     * @param exporterUri - absolute HTTP(S) URI of the exporter, which receives the export requests as is
     * @param backendUri - absolute HTTP(S) URI of the backend, which serves the rendered assets
     * @param timeoutSeconds - time limit of each exporter or backend call, in seconds
     * @param fetchImpl - fetch function used for every call, injectable for tests
     * @param maxResponseMb - cap on the body of one exporter or asset answer, in megabytes
     * @param assetsUri - base URI of the asset downloads, or undefined to use the origin named by the exporter
     * @param dispatcher - connection pool passed to `fetch` for every call, or undefined for the global pool
     * @throws Error naming the variable when either URI is not an absolute HTTP(S) URI
     */
    constructor(
        exporterUri: string,
        backendUri: string,
        private readonly timeoutSeconds: number = 120,
        private readonly fetchImpl: typeof fetch = fetch,
        maxResponseMb: number = BackendSettings.readMaxResponseMb(process.env),
        assetsUri?: string,
        private readonly dispatcher?: Dispatcher
    ) {
        this.exporterUri = HttpExporterClient.parseHttpUri(exporterUri, "PENPOT_MCP_EXPORTER_URI");
        this.backendUri = HttpExporterClient.parseHttpUri(backendUri, "PENPOT_MCP_BACKEND_URI");
        this.maxResponseMb = maxResponseMb;
        this.maxResponseBytes = Math.floor(maxResponseMb * 1024 * 1024);
        if (assetsUri === undefined) {
            this.assetsUri = undefined;
        } else {
            this.assetsUri = HttpExporterClient.parseHttpUri(assetsUri, "PENPOT_MCP_ASSETS_URI");
            if (!this.assetsUri.pathname.endsWith("/")) {
                this.assetsUri.pathname += "/";
            }
        }
        // keep a path prefix of the backend when joining asset paths
        if (!this.backendUri.pathname.endsWith("/")) {
            this.backendUri.pathname += "/";
        }
    }

    /**
     * Renders one shape through the exporter and downloads the rendered file from the backend.
     *
     * The export request carries the render session as the auth-token cookie. The asset identifier is taken
     * from the uri of the answer. The media type of the answer applies when the download reports none.
     *
     * @param renderToken - render session token, sent as the auth-token cookie
     * @param request - shape, file and format to render
     * @returns the rendered bytes and their media type
     * @throws ExporterError for the 400, 401, 404 and 429 statuses and for any other error status
     * @throws Error when the exporter does not respond or its answer has no asset uri
     */
    public async exportShape(renderToken: string, request: ExportShapeRequest): Promise<RenderedFile> {
        const body = Transit.encode({
            cmd: Transit.keyword("export-shapes"),
            "profile-id": Transit.uuid(request.profileId),
            wait: true,
            "is-wasm": false,
            exports: [
                {
                    "file-id": Transit.uuid(request.fileId),
                    "page-id": Transit.uuid(request.pageId),
                    "object-id": Transit.uuid(request.objectId),
                    type: Transit.keyword(request.format),
                    suffix: "",
                    scale: request.scale,
                    name: request.name,
                },
            ],
        });
        let response: Response;
        try {
            response = await this.fetchImpl(
                this.exporterUri.href,
                withDispatcher(
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/transit+json",
                            Cookie: HttpExporterClient.cookieOf(renderToken),
                        },
                        body,
                        redirect: "manual",
                        signal: this.callSignal(),
                    },
                    this.dispatcher
                )
            );
        } catch (error) {
            throw new Error(
                `The exporter did not respond (${HttpExporterClient.reasonOf(error)}). Check PENPOT_MCP_EXPORTER_URI.`
            );
        }
        const text = new TextDecoder().decode(await this.readCapped(response, "exporter answer"));
        if (!response.ok) {
            throw HttpExporterClient.exportFailure(response.status, text);
        }
        const noFileCause = HttpExporterClient.noFileCause(response, text.trim() === "");
        if (noFileCause !== undefined) {
            throw new Error(
                `The exporter answered without a file (${noFileCause}). ${HttpExporterClient.PUBLIC_URI_HINT}`
            );
        }
        return this.downloadRendered(renderToken, text);
    }

    /**
     * Downloads one stored asset from the backend with the render session cookie.
     *
     * @param renderToken - render session token, sent as the auth-token cookie
     * @param assetId - identifier of the asset, as a UUID
     * @returns the asset bytes and the content type of the response, or application/octet-stream when none is sent
     * @throws ExporterError for any error status; the message names the HTTP status and quotes the first 200
     * characters of the response body, and the status is 401 for 401 and 403 answers
     * @throws Error when the asset identifier is not a UUID or the backend does not respond
     */
    public async downloadAsset(renderToken: string, assetId: string, baseUri?: URL): Promise<RenderedFile> {
        if (!HttpExporterClient.UUID_PATTERN.test(assetId)) {
            throw new Error("The asset id must be a UUID.");
        }
        const url = new URL(`assets/by-id/${assetId}`, baseUri ?? this.assetBaseFor(undefined)).href;
        const response = await this.fetchAsset(url, renderToken);
        if (!response.ok) {
            throw HttpExporterClient.assetFailure(response.status, await HttpExporterClient.snippetOf(response));
        }
        const bytes = await this.readCapped(response, "asset");
        const noFileCause = HttpExporterClient.noFileCause(response, bytes.length === 0);
        if (noFileCause !== undefined) {
            throw new Error(
                `The asset download answered without a file (${noFileCause}). ${HttpExporterClient.PUBLIC_URI_HINT}`
            );
        }
        const mimeType = response.headers.get("content-type") ?? HttpExporterClient.OCTET_STREAM;
        return { bytes, mimeType };
    }

    /**
     * Chooses the base URI of an asset download: PENPOT_MCP_ASSETS_URI when it is set, else the origin of the
     * exporter's absolute asset uri, else the backend URI.
     *
     * @param answerUri - the uri of the exporter answer, or undefined when no answer names the asset
     * @returns the base URI, with a trailing slash
     */
    private assetBaseFor(answerUri: string | undefined): URL {
        if (this.assetsUri !== undefined) {
            return this.assetsUri;
        }
        return HttpExporterClient.absoluteOriginOf(answerUri) ?? this.backendUri;
    }

    /**
     * Returns the origin of an absolute HTTP(S) uri as a base URI with a trailing slash.
     *
     * @param uri - the uri to read, which may be undefined or relative
     * @returns the origin, or undefined when the uri is not an absolute HTTP(S) uri
     */
    private static absoluteOriginOf(uri: string | undefined): URL | undefined {
        if (uri === undefined || uri === "") {
            return undefined;
        }
        let parsed: URL;
        try {
            parsed = new URL(uri);
        } catch {
            return undefined;
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return undefined;
        }
        return new URL(`${parsed.origin}/`);
    }

    /**
     * Fetches an asset. A redirect is not followed by the runtime; one redirect to the same origin is followed
     * here with the cookie, and a redirect to another origin is refused.
     *
     * @param url - the asset URL
     * @param renderToken - render session token, sent as the auth-token cookie
     * @returns the final response, with its body unread
     * @throws ExporterError when the redirect leaves the origin of the asset URL
     * @throws Error when the backend does not respond
     */
    private async fetchAsset(url: string, renderToken: string): Promise<Response> {
        const first = await this.sendAsset(url, renderToken);
        const location = first.headers.get("location");
        if (first.status < 300 || first.status > 399 || location === null) {
            return first;
        }
        await first.body?.cancel();
        const next = new URL(location, url);
        if (next.origin !== new URL(url).origin) {
            throw new ExporterError(
                first.status,
                `The asset answer redirected to another origin (${next.origin}), which the server does not follow. ` +
                    "Set PENPOT_MCP_ASSETS_URI to the public URI that serves the assets."
            );
        }
        return this.sendAsset(next.href, renderToken);
    }

    /**
     * Sends one asset request with the render session cookie, without following redirects.
     *
     * @param url - the asset URL
     * @param renderToken - render session token, sent as the auth-token cookie
     * @returns the response, with its body unread
     * @throws Error when the backend does not respond
     */
    private async sendAsset(url: string, renderToken: string): Promise<Response> {
        try {
            return await this.fetchImpl(
                url,
                withDispatcher(
                    {
                        method: "GET",
                        headers: { Cookie: HttpExporterClient.cookieOf(renderToken) },
                        redirect: "manual",
                        signal: this.callSignal(),
                    },
                    this.dispatcher
                )
            );
        } catch (error) {
            throw new Error(
                `The backend did not respond (${HttpExporterClient.reasonOf(error)}) while downloading the asset.`
            );
        }
    }

    /**
     * Reads a response body as bytes, refusing bodies over the configured cap.
     *
     * @param response - response whose body is still unread
     * @param what - the kind of body, named in the error
     * @throws Error naming the cap and its environment variable when the body is over the cap
     */
    private readCapped(response: Response, what: string): Promise<Uint8Array> {
        return CappedBody.bytes(
            response,
            this.maxResponseBytes,
            () =>
                new Error(
                    `The ${what} exceeds ${this.maxResponseMb} MB (PENPOT_MCP_BACKEND_MAX_RESPONSE_MB); ` +
                        "the export was not completed."
                )
        );
    }

    /**
     * Names why an answer carries no file: a 204, an x-accel-redirect header, or an empty body.
     *
     * @param response - the answer, whose status and headers are read
     * @param bodyIsEmpty - whether the body holds no bytes
     * @returns the cause in words, or undefined when the answer may carry a file
     */
    private static noFileCause(response: Response, bodyIsEmpty: boolean): string | undefined {
        if (response.status === 204) {
            return "HTTP 204 No Content";
        }
        if (response.headers.has("x-accel-redirect")) {
            return "an x-accel-redirect header";
        }
        if (bodyIsEmpty) {
            return "an empty body";
        }
        return undefined;
    }

    /**
     * Reads the asset identifier from a successful export answer and downloads the asset.
     *
     * @param renderToken - render session token, sent as the auth-token cookie
     * @param answerText - raw transit body of the successful export answer
     * @returns the rendered bytes, with the resource media type when the download reports none
     * @throws Error when the answer is not transit or its uri names no asset
     */
    private async downloadRendered(renderToken: string, answerText: string): Promise<RenderedFile> {
        let decoded: unknown;
        try {
            decoded = Transit.decode(answerText);
        } catch {
            throw new Error("The exporter answer is not a transit resource.");
        }
        const answer = HttpExporterClient.asRecord(decoded);
        const uri = typeof answer?.uri === "string" ? answer.uri : "";
        const assetId = HttpExporterClient.ASSET_URI_PATTERN.exec(uri)?.[1];
        if (assetId === undefined) {
            throw new Error("the exporter answer has no asset uri");
        }
        const rendered = await this.downloadAsset(renderToken, assetId, this.assetBaseFor(uri));
        const mtype = answer?.mtype;
        const resourceType = typeof mtype === "string" ? mtype : HttpExporterClient.OCTET_STREAM;
        return {
            bytes: rendered.bytes,
            mimeType: rendered.mimeType === HttpExporterClient.OCTET_STREAM ? resourceType : rendered.mimeType,
        };
    }

    /**
     * Maps an error status of the exporter to an ExporterError with a readable message.
     *
     * @param status - HTTP status of the failed answer
     * @param text - raw body of the failed answer, used only for its hint
     * @returns the error to throw
     */
    private static exportFailure(status: number, text: string): ExporterError {
        const hint = HttpExporterClient.hintOf(text);
        const withHint = (message: string): string => (hint === undefined ? message : `${message}: ${hint}`);
        switch (status) {
            case 400:
                return new ExporterError(400, withHint("The exporter rejected the export request"));
            case 401:
                return new ExporterError(
                    401,
                    "The exporter rejected the render session. It is renewed on the next call; retry the operation."
                );
            case 404:
                return new ExporterError(404, withHint("The exporter could not find the shape or file"));
            case 429:
                return new ExporterError(
                    429,
                    "The exporter is busy: too many exports are queued. Retry in a few seconds."
                );
            default:
                return new ExporterError(
                    status,
                    `The exporter failed to render the shape: ${hint ?? "no details were returned"}`
                );
        }
    }

    /**
     * Maps an error status of the backend asset download to an ExporterError with a readable message.
     *
     * The message keeps a friendly reason for 401, 403 and 404, names the HTTP status and quotes the body snippet.
     *
     * @param status - HTTP status of the failed answer
     * @param snippet - first 200 characters of the failed answer's body
     * @returns the error to throw
     */
    private static assetFailure(status: number, snippet: string): ExporterError {
        if (status === 401 || status === 403) {
            const reason = "The render session cannot read this asset";
            return new ExporterError(401, HttpExporterClient.withDetail(reason, status, snippet));
        }
        if (status === 404) {
            const reason = "The asset was not found or is not visible to the render session";
            return new ExporterError(404, HttpExporterClient.withDetail(reason, status, snippet));
        }
        const reason = "The backend failed to return the asset";
        return new ExporterError(status, HttpExporterClient.withDetail(reason, status, snippet));
    }

    /**
     * Joins a message with the HTTP status and the body snippet of a failed backend answer.
     *
     * @param reason - the friendly reason, without a final period
     * @param status - HTTP status of the failed answer
     * @param snippet - first 200 characters of the failed answer's body, which may be empty
     * @returns the message text
     */
    private static withDetail(reason: string, status: number, snippet: string): string {
        const base = `${reason} (HTTP ${status})`;
        return snippet === "" ? base : `${base}: ${snippet}`;
    }

    /**
     * Builds the signal of one exporter or asset call: it fires at the configured timeout, or when the call
     * of the tool is abandoned, whichever comes first. A render that the caller gave up on then stops at once.
     */
    private callSignal(): AbortSignal {
        const timeout = AbortSignal.timeout(this.timeoutSeconds * 1000);
        const abandoned = CallContext.current()?.signal;
        return abandoned === undefined ? timeout : AbortSignal.any([timeout, abandoned]);
    }

    /** Longest snippet of a failed answer that goes into an error message, in characters. */
    private static readonly SNIPPET_CHARS = 200;

    /**
     * Reads the first 200 characters of the body of a failed answer.
     *
     * Only the bytes needed for the snippet are read, so a large error page costs no more than a small one.
     *
     * @param response - the failed answer
     * @returns the snippet, or an empty text when the body cannot be read
     */
    private static async snippetOf(response: Response): Promise<string> {
        if (response.body === null) {
            return "";
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
            while (text.length < HttpExporterClient.SNIPPET_CHARS) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }
                text += decoder.decode(result.value, { stream: true });
            }
        } catch {
            // unreadable: keep the part that was read
        }
        await reader.cancel().catch(() => undefined);
        return text.slice(0, HttpExporterClient.SNIPPET_CHARS);
    }

    /**
     * Reads the hint of an error body of the exporter.
     *
     * @param text - raw body of the failed answer
     * @returns the hint, or undefined when the body is not transit or carries no non-empty string hint
     */
    private static hintOf(text: string): string | undefined {
        let decoded: unknown;
        try {
            decoded = Transit.decode(text);
        } catch {
            return undefined;
        }
        const hint = HttpExporterClient.asRecord(decoded)?.hint;
        return typeof hint === "string" && hint !== "" ? hint : undefined;
    }

    /**
     * Parses an absolute HTTP(S) URI.
     *
     * @param value - the URI text
     * @param name - name of the variable that holds the URI, used in the error message
     * @returns the parsed URI
     * @throws Error naming the variable when the text does not parse or the scheme is not HTTP(S)
     */
    private static parseHttpUri(value: string, name: string): URL {
        let uri: URL;
        try {
            uri = new URL(value);
        } catch {
            throw new Error(`${name} must be an absolute HTTP(S) URI.`);
        }
        if (!["http:", "https:"].includes(uri.protocol)) {
            throw new Error(`${name} must be an absolute HTTP(S) URI.`);
        }
        return uri;
    }

    /**
     * Builds the auth-token cookie that carries a render session.
     *
     * @param renderToken - render session token
     * @returns the cookie header value
     */
    private static cookieOf(renderToken: string): string {
        return `auth-token=${renderToken}`;
    }

    /**
     * Names the kind of a failed call without its message, so that no secret reaches an error text.
     *
     * @param error - the value that the call threw
     * @returns the error name, or a generic word for values that are not errors
     */
    private static reasonOf(error: unknown): string {
        return error instanceof Error ? error.name : "unknown error";
    }

    /**
     * Views a decoded transit value as a record when it is a map.
     *
     * @param value - the decoded value
     * @returns the value as a record, or undefined when it is not a map
     */
    private static asRecord(value: unknown): Record<string, unknown> | undefined {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return undefined;
    }
}
