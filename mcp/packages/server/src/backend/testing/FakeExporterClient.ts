import {
    type ExportOptions,
    type ExportShapeRequest,
    type ExporterClient,
    type ExportRenderer,
    type RenderedFile,
} from "../ExporterClient";

/** A canned export answer: a fixed file, or a function computing it from the request. */
export type CannedExport = RenderedFile | ((request: ExportShapeRequest) => RenderedFile);

/** A canned download answer: a fixed file, or a function computing it from the asset identifier. */
export type CannedDownload = RenderedFile | ((assetId: string) => RenderedFile);

/** A canned batch answer: a function computing the file of each request from the whole list of requests. */
export type CannedBatch = (requests: ExportShapeRequest[]) => Map<string, RenderedFile>;

/** One single export call received by {@link FakeExporterClient}. */
export interface RecordedExport {
    /** Render session token the call was made with. */
    renderToken: string;
    /** Request that the call carried. */
    request: ExportShapeRequest;
    /** Renderer the call asked for: `browser` when the caller gave none. */
    renderer: ExportRenderer;
}

/** One batch export call received by {@link FakeExporterClient}. */
export interface RecordedBatch {
    /** Render session token the call was made with. */
    renderToken: string;
    /** Requests that the call carried, in order. */
    requests: ExportShapeRequest[];
    /** Renderer the call asked for: `browser` when the caller gave none. */
    renderer: ExportRenderer;
}

/** One download call received by {@link FakeExporterClient}. */
export interface RecordedDownload {
    /** Render session token the call was made with. */
    renderToken: string;
    /** Asset identifier that the call asked for. */
    assetId: string;
}

/**
 * An in-memory {@link ExporterClient} that records every call and answers with canned files.
 *
 * Single exports answer a small PNG unless another answer is set. A batch answers each request with the same
 * single answer, the way the exporter does: one request that fails fails the whole batch. Downloads have no
 * default answer and throw until one is set.
 *
 * Failures can be scripted: {@link failExport} and {@link failBatch} take a number of calls to fail, so that a test
 * can make the first call fail and let the next ones pass.
 */
export class FakeExporterClient implements ExporterClient {
    /** Single export calls in the order they were made. */
    public readonly exports: RecordedExport[] = [];
    /** Batch export calls in the order they were made. */
    public readonly batches: RecordedBatch[] = [];
    /** Download calls in the order they were made. */
    public readonly downloads: RecordedDownload[] = [];

    private exportAnswer: CannedExport = {
        bytes: new Uint8Array([137, 80, 78, 71]),
        mimeType: "image/png",
    };
    private batchAnswer: CannedBatch | undefined;
    private downloadAnswer: CannedDownload | undefined;
    private exportFailure: Error | undefined;
    private exportFailures = 0;
    private batchFailure: Error | undefined;
    private batchFailures = 0;
    private downloadFailure: Error | undefined;

    /**
     * Sets the answer of the single export calls.
     *
     * @param answer - fixed file, or a function receiving the request
     * @returns this client, for chaining
     */
    public respondExport(answer: CannedExport): this {
        this.exportAnswer = answer;
        return this;
    }

    /**
     * Sets the answer of the batch export calls, for a test that needs a ZIP-like answer of its own.
     *
     * @param answer - a function computing the file of each request
     * @returns this client, for chaining
     */
    public respondBatch(answer: CannedBatch): this {
        this.batchAnswer = answer;
        return this;
    }

    /**
     * Sets the answer of the download calls.
     *
     * @param answer - fixed file, or a function receiving the asset identifier
     * @returns this client, for chaining
     */
    public respondDownload(answer: CannedDownload): this {
        this.downloadAnswer = answer;
        return this;
    }

    /**
     * Makes the next single export calls fail with the given error.
     *
     * @param error - error thrown by the single export calls
     * @param times - how many calls fail; every call when omitted
     * @returns this client, for chaining
     */
    public failExport(error: Error, times: number = Number.POSITIVE_INFINITY): this {
        this.exportFailure = error;
        this.exportFailures = times;
        return this;
    }

    /**
     * Makes the next batch export calls fail with the given error.
     *
     * @param error - error thrown by the batch export calls
     * @param times - how many calls fail; every call when omitted
     * @returns this client, for chaining
     */
    public failBatch(error: Error, times: number = Number.POSITIVE_INFINITY): this {
        this.batchFailure = error;
        this.batchFailures = times;
        return this;
    }

    /**
     * Makes every download call fail with the given error.
     *
     * @param error - error thrown by the download calls
     * @returns this client, for chaining
     */
    public failDownload(error: Error): this {
        this.downloadFailure = error;
        return this;
    }

    /**
     * Counts the exporter requests made so far: single and batch calls together.
     *
     * @returns the number of single and batch export calls
     */
    public get requestCount(): number {
        return this.exports.length + this.batches.length;
    }

    /**
     * Records and answers one single export call.
     *
     * @param renderToken - render session token of the call
     * @param request - the shape to render
     * @param options - the renderer, or undefined for the browser renderer
     */
    public async exportShape(
        renderToken: string,
        request: ExportShapeRequest,
        options?: ExportOptions
    ): Promise<RenderedFile> {
        this.exports.push({ renderToken, request, renderer: options?.renderer ?? "browser" });
        if (this.exportFailure !== undefined && this.exportFailures > 0) {
            this.exportFailures--;
            throw this.exportFailure;
        }
        if (typeof this.exportAnswer === "function") {
            return this.exportAnswer(request);
        }
        return this.exportAnswer;
    }

    /**
     * Records and answers one batch export call. Each request gets its single answer; a request whose answer throws
     * fails the whole batch, as it does in the exporter.
     *
     * @param renderToken - render session token of the call
     * @param requests - the shapes to render
     * @param options - the renderer, or undefined for the browser renderer
     */
    public async exportShapes(
        renderToken: string,
        requests: ExportShapeRequest[],
        options?: ExportOptions
    ): Promise<Map<string, RenderedFile>> {
        this.batches.push({ renderToken, requests, renderer: options?.renderer ?? "browser" });
        if (this.batchFailure !== undefined && this.batchFailures > 0) {
            this.batchFailures--;
            throw this.batchFailure;
        }
        if (this.batchAnswer !== undefined) {
            return this.batchAnswer(requests);
        }
        const files = new Map<string, RenderedFile>();
        for (const request of requests) {
            const answer = typeof this.exportAnswer === "function" ? this.exportAnswer(request) : this.exportAnswer;
            files.set(request.name, answer);
        }
        return files;
    }

    /**
     * Records and answers one download call.
     *
     * @param renderToken - render session token of the call
     * @param assetId - the asset to download
     */
    public async downloadAsset(renderToken: string, assetId: string): Promise<RenderedFile> {
        this.downloads.push({ renderToken, assetId });
        if (this.downloadFailure) {
            throw this.downloadFailure;
        }
        if (this.downloadAnswer === undefined) {
            throw new Error("no download answer configured");
        }
        if (typeof this.downloadAnswer === "function") {
            return this.downloadAnswer(assetId);
        }
        return this.downloadAnswer;
    }
}
