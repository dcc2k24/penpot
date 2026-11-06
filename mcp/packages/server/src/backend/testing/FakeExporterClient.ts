import type { ExportShapeRequest, ExporterClient, RenderedFile } from "../ExporterClient";

/** A canned export answer: a fixed file, or a function computing it from the request. */
export type CannedExport = RenderedFile | ((request: ExportShapeRequest) => RenderedFile);

/** A canned download answer: a fixed file, or a function computing it from the asset identifier. */
export type CannedDownload = RenderedFile | ((assetId: string) => RenderedFile);

/** One export call received by {@link FakeExporterClient}. */
export interface RecordedExport {
    /** Render session token the call was made with. */
    renderToken: string;
    /** Request that the call carried. */
    request: ExportShapeRequest;
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
 * Exports answer a small PNG unless another answer is set. Downloads have no default answer and throw
 * until one is set. A failure set for a kind of call wins over the answer of that kind.
 */
export class FakeExporterClient implements ExporterClient {
    /** Export calls in the order they were made. */
    public readonly exports: RecordedExport[] = [];
    /** Download calls in the order they were made. */
    public readonly downloads: RecordedDownload[] = [];

    private exportAnswer: CannedExport = {
        bytes: new Uint8Array([137, 80, 78, 71]),
        mimeType: "image/png",
    };
    private downloadAnswer: CannedDownload | undefined;
    private exportFailure: Error | undefined;
    private downloadFailure: Error | undefined;

    /**
     * Sets the answer of the export calls.
     *
     * @param answer - fixed file, or a function receiving the request
     * @returns this client, for chaining
     */
    public respondExport(answer: CannedExport): this {
        this.exportAnswer = answer;
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
     * Makes every export call fail with the given error.
     *
     * @param error - error thrown by the export calls
     * @returns this client, for chaining
     */
    public failExport(error: Error): this {
        this.exportFailure = error;
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

    public async exportShape(renderToken: string, request: ExportShapeRequest): Promise<RenderedFile> {
        this.exports.push({ renderToken, request });
        if (this.exportFailure) {
            throw this.exportFailure;
        }
        if (typeof this.exportAnswer === "function") {
            return this.exportAnswer(request);
        }
        return this.exportAnswer;
    }

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
