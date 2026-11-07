import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpImageClient } from "./McpExport.js";
import { budgetOf, DEFAULT_PIXEL_BUDGETS, type PixelBudgets } from "./Budget.js";
import { causeOf } from "./PixelCauses.js";
import { clusterMask, REAL_MISMATCH_CLUSTER } from "./Clusters.js";
import { COMPARE_DIR, MCP_URL } from "../Paths.js";
import { COMPONENTS_PAGE_NAME, NODE_ID_ATTRIBUTE, PIXEL_VIEWPORT, type DesignTarget } from "../Targets.js";
import type { DesignModel, NodeModel } from "../DesignModel.js";
import { newRunId, runDockerShots, type AppBrowser, type ShotRequest } from "./Screenshots.js";

// types the browser global document only, because the tsconfig lib has no DOM.
declare const document: any;

/**
 * Result of the pixel comparison of one target. The status is "ok" when the pixels were counted, which includes images
 * of different sizes, padded to a common canvas, and "unavailable" when the export or the screenshot could not be made.
 */
export interface PixelResult {
    /** Id of the target that was compared. */
    targetId: string;
    /**
     * Outcome of the comparison. "size-mismatch" is kept for compatibility and is no longer produced, because images of
     * different sizes are padded and compared.
     */
    status: "ok" | "unavailable" | "size-mismatch";
    /** Size of the design export as "<width>x<height>", set when the sizes differ. */
    design?: string;
    /** Size of the app screenshot as "<width>x<height>", set when the sizes differ. */
    implemented?: string;
    /** Note on the padding, set when the sizes differ. It names both sizes and the padded canvas size. */
    note?: string;
    /** Number of pixels that differ, set when the status is "ok". */
    differentPixels?: number;
    /** Number of pixels in the image, set when the status is "ok". The count covers the padded canvas. */
    totalPixels?: number;
    /** Share of the different pixels in percent, with two decimals, set when the status is "ok". */
    percent?: number;
    /** Why the target is unavailable, set when the status is "unavailable". */
    reason?: string;
    /** Absolute paths of the design, app and diff PNG files, set when the status is "ok". */
    files?: string[];
    /** Pixel budget of the target kind, in percent, set when the status is "ok". */
    budget?: number;
    /** True when the share of different pixels is above the budget, set when the status is "ok". */
    overBudget?: boolean;
    /** Cause note of the target from PIXEL_CAUSES, or null when none is recorded. Set when the status is "ok". */
    cause?: string | null;
    /**
     * Size in pixels, at the device scale used, of the largest cluster of different pixels, set when the status is "ok".
     * Zero when no pixel differs.
     */
    largestCluster?: number;
    /** Number of clusters of different pixels, set when the status is "ok". */
    clusters?: number;
    /** True when largestCluster is above REAL_MISMATCH_CLUSTER, set when the status is "ok". */
    realMismatch?: boolean;
}

/**
 * Marks the pixels that pixelmatch painted as different. pixelmatch paints a different pixel with its default diff
 * colour, pure red (255, 0, 0), and an anti-aliased pixel with yellow (255, 255, 0), which is not counted. So the mask
 * is the red pixels only. The image must be the diff image that pixelmatch wrote with its default options.
 *
 * @param diff - diff image written by pixelmatch
 * @returns one byte per pixel in row order, 1 for a red pixel and 0 for the rest
 */
export function differenceMask(diff: PNG): Uint8Array {
    const count = diff.width * diff.height;
    const mask = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
        const offset = index * 4;
        if (diff.data[offset] === 255 && diff.data[offset + 1] === 0 && diff.data[offset + 2] === 0) {
            mask[index] = 1;
        }
    }
    return mask;
}

/**
 * Outcome of the export of one target: the PNG bytes, or the unavailable result when the export failed.
 */
type ExportOutcome = { status: "exported"; png: Buffer } | { status: "failed"; result: PixelResult };

/**
 * Compares the Penpot PNG export of each target with a screenshot of the rendered app, pixel by pixel.
 *
 * Both images are composited over opaque white first, and an image smaller than the other is padded with white at the
 * top-left. The result is a report only. A pixel difference never makes run throw.
 */
export class PixelComparator {
    /**
     * Runs the comparison for every target, in order, and returns one result per target.
     *
     * In local mode the host Chromium takes each app screenshot. In docker mode every target is exported first, then
     * one container run takes all the screenshots, and each target is compared with its screenshot.
     *
     * @param model - pulled design model
     * @param targets - targets to compare
     * @param baseUrl - base URL of the app as the screenshot side reaches it: the host URL in local mode, the container
     *   URL in docker mode
     * @param log - receives one line per target
     * @param scale - device scale of the export and the screenshot, an integer from 1 to 3
     * @param appBrowser - where the app is screenshotted (default local)
     * @param budgets - pixel budget of each target kind, in percent (default DEFAULT_PIXEL_BUDGETS)
     * @throws Error when the model has no Components page, or when the MCP server or the browser cannot start
     */
    async run(
        model: DesignModel,
        targets: DesignTarget[],
        baseUrl: string,
        log: (line: string) => void,
        scale: number,
        appBrowser: AppBrowser = { mode: "local" },
        budgets: Readonly<PixelBudgets> = DEFAULT_PIXEL_BUDGETS
    ): Promise<PixelResult[]> {
        const componentsPage = model.pages.find((page) => page.name === COMPONENTS_PAGE_NAME);
        if (componentsPage === undefined) {
            throw new Error("no page named Components");
        }
        const pageIdOf = (target: DesignTarget): string =>
            target.kind === "screen" ? target.pageId : componentsPage.id;
        const client = new McpImageClient();
        const results: PixelResult[] = [];
        try {
            await client.connect(MCP_URL);
            if (appBrowser.mode === "docker") {
                const runId = newRunId();
                const exported: ExportOutcome[] = [];
                for (const target of targets) {
                    exported.push(await this.exportTarget(client, model.file.id, pageIdOf(target), target, scale, log));
                }
                const requests: ShotRequest[] = [];
                for (const [index, target] of targets.entries()) {
                    if (exported[index].status === "exported") {
                        requests.push({
                            index,
                            route: target.route,
                            nodeId: target.board.id,
                            scale,
                            expand: outsideExtent(target.board),
                        });
                    }
                }
                const shots =
                    requests.length === 0
                        ? new Map<number, Buffer>()
                        : await runDockerShots({
                              container: appBrowser.container,
                              baseUrl,
                              requests,
                              runId,
                              scratchDir: join(COMPARE_DIR, "screenshots", runId),
                          });
                for (const [index, target] of targets.entries()) {
                    const outcome = exported[index];
                    if (outcome.status === "failed") {
                        results.push(outcome.result);
                        continue;
                    }
                    const shot = shots.get(index);
                    if (shot === undefined) {
                        const reason = "docker screenshot failed";
                        log(`[pixel] ${target.id} unavailable ${reason}`);
                        results.push({ targetId: target.id, status: "unavailable", reason });
                        continue;
                    }
                    results.push(this.compareImages(target, outcome.png, shot, log, budgets));
                }
            } else {
                // --disable-lcd-text turns off subpixel (LCD) antialiasing, so glyphs are greyscale like the export.
                const browser = await chromium.launch({ headless: true, args: ["--disable-lcd-text"] });
                try {
                    for (const target of targets) {
                        const exported = await this.exportTarget(
                            client,
                            model.file.id,
                            pageIdOf(target),
                            target,
                            scale,
                            log
                        );
                        if (exported.status === "failed") {
                            results.push(exported.result);
                            continue;
                        }
                        const shot = await this.screenshotTarget(browser, target, baseUrl, scale);
                        results.push(this.compareImages(target, exported.png, shot, log, budgets));
                    }
                } finally {
                    await browser.close();
                }
            }
        } finally {
            await client.close();
        }
        return results;
    }

    /**
     * Exports the board of one target as a PNG with the MCP server.
     *
     * @param client - connected MCP image client
     * @param fileId - id of the design file
     * @param pageId - id of the page that holds the board
     * @param target - target to export
     * @param scale - device scale of the export
     * @param log - receives one line when the export fails
     * @returns the PNG bytes, or the unavailable result when the export failed or came back empty
     */
    private async exportTarget(
        client: McpImageClient,
        fileId: string,
        pageId: string,
        target: DesignTarget,
        scale: number,
        log: (line: string) => void
    ): Promise<ExportOutcome> {
        const targetId = target.id;
        let exported: Buffer | "empty";
        try {
            exported = await client.exportPng(fileId, pageId, target.board.id, scale);
        } catch (error) {
            const reason = "export failed: " + errorMessage(error);
            log(`[pixel] ${targetId} unavailable ${reason}`);
            return { status: "failed", result: { targetId, status: "unavailable", reason } };
        }
        if (exported === "empty") {
            log(`[pixel] ${targetId} unavailable empty PNG`);
            return {
                status: "failed",
                result: {
                    targetId,
                    status: "unavailable",
                    reason: "export_shape returned an empty PNG (gap 15)",
                },
            };
        }
        return { status: "exported", png: exported };
    }

    /**
     * Counts the different pixels of one target and writes its design, app and diff PNG files.
     *
     * @param target - target that was compared
     * @param exported - PNG bytes of the design export
     * @param shot - PNG bytes of the app screenshot
     * @param log - receives one line for the target
     * @returns the result of the target, status ok
     */
    private compareImages(
        target: DesignTarget,
        exported: Buffer,
        shot: Buffer,
        log: (line: string) => void,
        budgets: Readonly<PixelBudgets>
    ): PixelResult {
        const targetId = target.id;
        const prefix = target.id.replace(/\//g, "-");

        const design = flattenOverWhite(PNG.sync.read(exported));
        const app = flattenOverWhite(PNG.sync.read(shot));

        const width = Math.max(design.width, app.width);
        const height = Math.max(design.height, app.height);
        const designSize = `${design.width}x${design.height}`;
        const implementedSize = `${app.width}x${app.height}`;
        const sizesDiffer = designSize !== implementedSize;
        const designCanvas = padToCanvas(design, width, height);
        const appCanvas = padToCanvas(app, width, height);

        const diff = new PNG({ width, height });
        // default diff colours, so different pixels are pure red and the mask from differenceMask counts them.
        const differentPixels = pixelmatch(designCanvas.data, appCanvas.data, diff.data, width, height, {
            threshold: 0.1,
        });
        const totalPixels = width * height;
        const percent = Math.round((differentPixels / totalPixels) * 10000) / 100;
        const cluster = clusterMask(differenceMask(diff), width, height);

        mkdirSync(COMPARE_DIR, { recursive: true });
        const designFile = join(COMPARE_DIR, `${prefix}-design.png`);
        const appFile = join(COMPARE_DIR, `${prefix}-app.png`);
        const diffFile = join(COMPARE_DIR, `${prefix}-diff.png`);
        writeFileSync(designFile, PNG.sync.write(designCanvas));
        writeFileSync(appFile, PNG.sync.write(appCanvas));
        writeFileSync(diffFile, PNG.sync.write(diff));

        const budget = budgetOf(target.kind, budgets);
        const result: PixelResult = {
            targetId,
            status: "ok",
            differentPixels,
            totalPixels,
            percent,
            budget,
            overBudget: percent > budget,
            cause: causeOf(targetId),
            files: [designFile, appFile, diffFile],
            largestCluster: cluster.largest,
            clusters: cluster.count,
            realMismatch: cluster.largest > REAL_MISMATCH_CLUSTER,
        };
        const summary =
            `${percent}% (${differentPixels} pixels, largest cluster ${cluster.largest} px, ` +
            `${cluster.count} clusters)`;
        if (sizesDiffer) {
            const note = `design ${designSize}, app ${implementedSize}, padded to ${width}x${height} at top-left`;
            result.design = designSize;
            result.implemented = implementedSize;
            result.note = note;
            log(`[pixel] ${targetId} ok ${summary} ${note}`);
        } else {
            log(`[pixel] ${targetId} ok ${summary}`);
        }
        return result;
    }

    /**
     * Opens the app page of a target in a new browser page and takes a screenshot of its board. The clip is the board box
     * grown outward by the outside extent of its stroke, so that the screenshot covers the same area as the export.
     * The clip is in CSS pixels, and the device scale makes the screenshot scale times that size.
     *
     * @param browser - browser that opens the page
     * @param target - target whose route and board are shown
     * @param baseUrl - base URL of the running app
     * @param scale - device scale factor of the page
     */
    private async screenshotTarget(
        browser: Browser,
        target: DesignTarget,
        baseUrl: string,
        scale: number
    ): Promise<Buffer> {
        const page = await browser.newPage({
            viewport: { width: PIXEL_VIEWPORT.width, height: PIXEL_VIEWPORT.height },
            deviceScaleFactor: scale,
        });
        try {
            const url = baseUrl + target.route;
            try {
                await page.goto(url, { waitUntil: "networkidle" });
            } catch {
                await page.goto(url, { waitUntil: "load" });
            }
            const selector = `[${NODE_ID_ATTRIBUTE}="${target.board.id}"]`;
            await page.waitForSelector(selector, { timeout: 15000 });
            await page.evaluate(() => document.fonts.ready);
            const box = await page.evaluate((sel: string) => {
                const rect = document.querySelector(sel).getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
            }, selector);
            const extent = outsideExtent(target.board);
            return await page.screenshot({
                clip: {
                    x: box.x - extent,
                    y: box.y - extent,
                    width: box.width + 2 * extent,
                    height: box.height + 2 * extent,
                },
                fullPage: false,
            });
        } finally {
            await page.close();
        }
    }
}

/**
 * Composites a PNG over opaque white, so that every pixel ends with alpha 255.
 *
 * Each colour channel becomes src * alpha + 255 * (1 - alpha), rounded to the nearest integer. The input is not changed.
 *
 * @param png - image to flatten, 8-bit RGBA
 * @returns a new 8-bit RGBA image of the same size with opaque pixels
 */
export function flattenOverWhite(png: PNG): PNG {
    const out = new PNG({ width: png.width, height: png.height });
    const src = png.data;
    const dst = out.data;
    for (let i = 0; i < src.length; i += 4) {
        const alpha = src[i + 3];
        for (let channel = 0; channel < 3; channel++) {
            dst[i + channel] = Math.round((src[i + channel] * alpha + 255 * (255 - alpha)) / 255);
        }
        dst[i + 3] = 255;
    }
    return out;
}

/**
 * Places a PNG at the top-left of an opaque white canvas of the given size.
 *
 * The pixels of the input are copied as they are. Pixels outside the input stay white with alpha 255. The input is not
 * changed.
 *
 * @param png - image to place, 8-bit RGBA
 * @param width - width of the canvas in pixels, not less than the width of the image
 * @param height - height of the canvas in pixels, not less than the height of the image
 * @throws RangeError when the canvas is smaller than the image
 */
export function padToCanvas(png: PNG, width: number, height: number): PNG {
    if (width < png.width || height < png.height) {
        throw new RangeError(`canvas ${width}x${height} is smaller than image ${png.width}x${png.height}`);
    }
    const out = new PNG({ width, height });
    out.data.fill(255);
    const rowBytes = png.width * 4;
    for (let y = 0; y < png.height; y++) {
        png.data.copy(out.data, y * width * 4, y * rowBytes, (y + 1) * rowBytes);
    }
    return out;
}

/**
 * Returns the whole-pixel distance by which the first stroke of a board reaches outside its box.
 *
 * A centred stroke, or a stroke with no alignment, reaches half its width outside, rounded up. An outer stroke reaches its
 * full width outside. An inner stroke reaches nothing outside, and so does a board with no stroke. A stroke with no width
 * counts as 1 px.
 *
 * @param board - board node of the design model
 * @returns the outside extent in whole pixels, not negative
 */
export function outsideExtent(board: NodeModel): number {
    if (board.strokes.length === 0) {
        return 0;
    }
    const stroke = board.strokes[0];
    const width = stroke.width ?? 1;
    if (stroke.alignment === "inner") {
        return 0;
    }
    if (stroke.alignment === "outer") {
        return Math.ceil(width);
    }
    return Math.ceil(width / 2);
}

/**
 * Returns the message of an error, or the text of the value when it is not an Error.
 *
 * @param error - value that was thrown
 */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
