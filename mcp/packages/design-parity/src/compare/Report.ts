import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DomMismatch, DomResult, TargetDomResult } from "./DomCompare.js";
import type { PixelResult } from "./PixelCompare.js";
import type { TargetKind } from "./Budget.js";
import { REAL_MISMATCH_CLUSTER } from "./Clusters.js";

/** Combined result of the DOM and pixel comparisons, as written to the report files. */
export interface CompareReport {
    generatedFrom: string;
    viewport: { width: number; height: number };
    dom: DomResult;
    pixel: PixelResult[] | null;
    /** Pixel budget of each target kind, in percent. */
    budgets: Record<TargetKind, number>;
    /**
     * Device scale of the pixel results, an integer from 1 to 3. Absent in reports written before the scale was added.
     */
    scale?: number;
}

/**
 * Tells whether a pixel result is a real mismatch: its status is ok and its largest cluster of different pixels is above
 * REAL_MISMATCH_CLUSTER.
 *
 * @param result - pixel result of one target
 * @returns true when the target has a real mismatch
 */
export function isRealMismatch(result: PixelResult): boolean {
    return result.status === "ok" && (result.largestCluster ?? 0) > REAL_MISMATCH_CLUSTER;
}

/**
 * Reads a report written by ReportWriter. A file that is missing, cannot be parsed, or has no budgets (an older
 * report) gives null, so the caller treats it as no report.
 *
 * @param file - path of the report.json file
 * @returns the report, or null when it cannot be used
 */
export function readReport(file: string): CompareReport | null {
    if (!existsSync(file)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CompareReport> | null;
        if (typeof parsed !== "object" || parsed === null || typeof parsed.budgets !== "object") {
            return null;
        }
        if (typeof parsed.dom !== "object" || parsed.dom === null || !Array.isArray(parsed.dom.targets)) {
            return null;
        }
        return parsed as CompareReport;
    } catch {
        return null;
    }
}

/**
 * Merges the report of a comparison run into the previous report. Targets that were run replace their old entries,
 * and the other targets keep theirs. The DOM and pixel lists are rebuilt in the order of all targets. A run without
 * the pixel step (its pixel list is null) leaves the previous pixel results as they are.
 *
 * With no previous report, or a previous report of another pull (a different generatedFrom), the run is the result.
 *
 * Pixel results are kept only at one device scale. When the run has a pixel step at another scale than the previous
 * report, the previous pixel results are dropped and only the pixel results of the run remain. A run without the pixel
 * step keeps the previous scale.
 *
 * @param previous - the report read before the run, or null when there is none
 * @param fresh - the report of the run, whose DOM targets and pixel results cover only the run targets
 * @param rerun - ids of the targets that the run checked
 * @param order - ids of all targets, in the order of the model
 * @returns the merged report
 */
export function mergeReports(
    previous: CompareReport | null,
    fresh: CompareReport,
    rerun: readonly string[],
    order: readonly string[]
): CompareReport {
    if (previous === null || previous.generatedFrom !== fresh.generatedFrom) {
        return fresh;
    }

    const rerunIds = new Set(rerun);
    const previousPixelUsable = fresh.pixel === null || previous.scale === fresh.scale;
    const targets: TargetDomResult[] = [];
    const mismatches: DomMismatch[] = [];
    const pixel: PixelResult[] = [];
    for (const id of order) {
        const source = rerunIds.has(id) ? fresh : previous;
        const target = source.dom.targets.find((entry) => entry.id === id);
        if (target !== undefined) {
            targets.push(target);
        }
        mismatches.push(...source.dom.mismatches.filter((mismatch) => mismatch.targetId === id));

        let result: PixelResult | undefined = undefined;
        if (rerunIds.has(id) && fresh.pixel !== null) {
            result = fresh.pixel.find((entry) => entry.targetId === id);
        } else if (previousPixelUsable) {
            result = previous.pixel?.find((entry) => entry.targetId === id);
        }
        if (result !== undefined) {
            pixel.push(result);
        }
    }

    const hasPixel = fresh.pixel !== null || previous.pixel !== null;
    return {
        generatedFrom: fresh.generatedFrom,
        viewport: fresh.viewport,
        dom: {
            targets,
            mismatches,
            checked: targets.reduce((sum, target) => sum + target.checked, 0),
            info: targets.reduce((sum, target) => sum + target.info.length, 0),
        },
        pixel: hasPixel ? pixel : null,
        budgets: fresh.budgets,
        scale: fresh.pixel !== null ? fresh.scale : previous.scale,
    };
}

/** Characters that must be escaped before they are written into HTML text or attributes. */
const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** Page style, kept inline so the report needs no external file. */
const STYLE = `
body { font-family: system-ui, sans-serif; margin: 16px; color: #1d1d1f; background: #ffffff; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.2em; margin-top: 1.6em; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #c8c8cc; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f2f2f4; }
img { max-width: 100%; height: auto; border: 1px solid #c8c8cc; }
`;

/**
 * Escapes a value for use in HTML text or attributes.
 * Also breaks up "://" so that no URL scheme appears as plain text in the page.
 * @param value text to escape
 * @returns the escaped text
 */
function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]).replace(/:\/\//g, "&#58;//");
}

/**
 * Sorts the keys of every object in a value, recursively, in code-unit order.
 * Arrays keep their order.
 * @param value the value to copy
 * @returns a copy with sorted object keys
 */
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }

    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            out[key] = sortKeys(source[key]);
        }
        return out;
    }

    return value;
}

/**
 * Builds one HTML table cell with escaped text.
 * @param value the text to show, converted with String
 * @returns the cell markup
 */
function cell(value: unknown): string {
    return `<td>${escapeHtml(String(value))}</td>`;
}

/**
 * Builds the pixel summary text for one target.
 * @param pixel the pixel results, or null when the pixel step did not run
 * @param targetId the target to look up
 * @returns the text for the Pixel column
 */
function pixelSummary(pixel: PixelResult[] | null, targetId: string): string {
    if (pixel === null) {
        return "not run";
    }

    const result = pixel.find((entry) => entry.targetId === targetId);
    if (result === undefined) {
        return "not run";
    }

    if (result.status === "ok") {
        const flags = [result.overBudget === true ? "OVER BUDGET" : "", isRealMismatch(result) ? "REAL MISMATCH" : ""]
            .filter((flag) => flag !== "")
            .map((flag) => `, ${flag}`)
            .join("");
        return (
            `${String(result.percent)}% (${String(result.differentPixels)} of ${String(result.totalPixels)} pixels), ` +
            `budget ${String(result.budget ?? "")}%, ` +
            `largest cluster ${String(result.largestCluster ?? "")} px, clusters ${String(result.clusters ?? "")}` +
            flags
        );
    }

    if (result.status === "unavailable") {
        return `unavailable: ${String(result.reason)}`;
    }

    return `size mismatch: design ${String(result.design)}, app ${String(result.implemented)}`;
}

/**
 * Builds the section that lists the real mismatches: the targets whose largest cluster of different pixels is above
 * REAL_MISMATCH_CLUSTER. Each target is one line with its id, its percent, its largest cluster and its cause note.
 * @param pixel the pixel results, or null when the pixel step did not run
 * @returns the section markup
 */
function realMismatchSection(pixel: PixelResult[] | null): string {
    const title = `Real mismatches (largest cluster above ${REAL_MISMATCH_CLUSTER} pixels)`;
    const real = (pixel ?? []).filter(isRealMismatch);
    if (real.length === 0) {
        return `<h2>${title}</h2>\n<p>No target has a real mismatch.</p>`;
    }

    const items = real
        .map((result) => {
            const cause = result.cause === undefined || result.cause === null ? "" : `. Cause: ${result.cause}`;
            return `<li>${escapeHtml(
                `${result.targetId}, ${String(result.percent)}%, ` +
                    `largest cluster ${String(result.largestCluster)} px${cause}`
            )}</li>`;
        })
        .join("\n");
    return `<h2>${title}</h2>\n<ul>\n${items}\n</ul>`;
}

/**
 * Builds the section that lists the targets over their pixel budget, each with its cause note.
 * @param pixel the pixel results, or null when the pixel step did not run
 * @returns the section markup
 */
function overBudgetSection(pixel: PixelResult[] | null): string {
    const over = (pixel ?? []).filter((result) => result.status === "ok" && result.overBudget === true);
    if (over.length === 0) {
        return "<h2>Pixel over budget</h2>\n<p>No target is over its pixel budget.</p>";
    }

    const rows = over
        .map(
            (result) =>
                "<tr>" +
                cell(result.targetId) +
                cell(`${String(result.percent)}%`) +
                cell(`${String(result.budget ?? "")}%`) +
                cell(result.cause ?? "no cause recorded") +
                "</tr>"
        )
        .join("\n");
    return (
        "<h2>Pixel over budget</h2>\n" +
        "<table>\n<thead><tr><th>Target</th><th>Pixel</th><th>Budget</th><th>Cause</th></tr></thead>\n" +
        `<tbody>\n${rows}\n</tbody>\n</table>`
    );
}

/**
 * Reads the diff image of a pixel result and encodes it as a data URI.
 * @param result the pixel result that holds the file list
 * @returns the data URI, or null when the diff file is not listed or cannot be read
 */
function diffImageSource(result: PixelResult): string | null {
    const file = result.files?.find((path) => basename(path).endsWith("diff.png"));
    if (file === undefined) {
        return null;
    }

    try {
        const bytes = readFileSync(file);
        return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
        return null;
    }
}

/**
 * Builds the section that shows the diff image of one target.
 * @param result the pixel result with differences
 * @returns the section markup
 */
function diffSection(result: PixelResult): string {
    const source = diffImageSource(result);
    const body =
        source === null
            ? "<p>diff image missing</p>"
            : `<img src="${escapeHtml(source)}" alt="Diff image for ${escapeHtml(result.targetId)}">`;
    return `<h2>${escapeHtml(result.targetId)}</h2>\n${body}`;
}

/**
 * Builds the table row for one DOM mismatch.
 * @param mismatch the mismatch to show
 * @returns the row markup
 */
function mismatchRow(mismatch: DomMismatch): string {
    const classification = mismatch.classification === undefined ? "<td></td>" : cell(mismatch.classification);
    return (
        "<tr>" +
        cell(mismatch.targetName) +
        cell(mismatch.nodeId) +
        cell(mismatch.nodeName) +
        cell(mismatch.path) +
        cell(mismatch.attribute) +
        cell(mismatch.design) +
        cell(mismatch.implemented) +
        classification +
        "</tr>"
    );
}

/**
 * Builds the complete HTML page for a report.
 * @param report the report to show
 * @returns the HTML document text
 */
function renderHtml(report: CompareReport): string {
    const summaryRows = report.dom.targets
        .map(
            (target) =>
                "<tr>" +
                cell(target.name) +
                cell(target.nodes) +
                cell(target.mismatches) +
                cell(target.info.length) +
                cell(pixelSummary(report.pixel, target.id)) +
                "</tr>"
        )
        .join("\n");

    const diffSections = (report.pixel ?? [])
        .filter((result) => result.status === "ok" && (result.differentPixels ?? 0) > 0)
        .map(diffSection)
        .join("\n");

    const mismatchBody =
        report.dom.mismatches.length === 0
            ? "<p>No DOM mismatches.</p>"
            : "<table>\n<thead><tr><th>Target</th><th>Node id</th><th>Node name</th><th>Path</th>" +
              "<th>Attribute</th><th>Design</th><th>Implemented</th><th>Classification</th></tr></thead>\n" +
              `<tbody>\n${report.dom.mismatches.map(mismatchRow).join("\n")}\n</tbody>\n</table>`;

    const intro =
        `Generated from design pulled at ${escapeHtml(String(report.generatedFrom))}. ` +
        `Viewport ${escapeHtml(String(report.viewport.width))}x${escapeHtml(String(report.viewport.height))}. ` +
        `Device scale ${escapeHtml(String(report.scale ?? "not recorded"))}. ` +
        `Pixel budgets: component ${escapeHtml(String(report.budgets.component))} percent, ` +
        `screen ${escapeHtml(String(report.budgets.screen))} percent.`;

    return [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Design parity report</title>",
        `<style>${STYLE}</style>`,
        "</head>",
        "<body>",
        "<h1>Design parity report</h1>",
        `<p>${intro}</p>`,
        "<table>",
        "<thead><tr><th>Target</th><th>Nodes</th><th>DOM mismatches</th><th>Info</th><th>Pixel</th></tr></thead>",
        `<tbody>\n${summaryRows}\n</tbody>`,
        "</table>",
        overBudgetSection(report.pixel),
        realMismatchSection(report.pixel),
        diffSections,
        "<h2>DOM mismatches</h2>",
        mismatchBody,
        "</body>",
        "</html>",
        "",
    ].join("\n");
}

/** Writes a comparison report as a JSON file and a self-contained HTML page. */
export class ReportWriter {
    /**
     * Writes report.json and report.html into a folder, creating the folder when needed.
     * The output depends only on the report, so the same report always gives the same bytes.
     * @param report the comparison report to write
     * @param dir the folder to write into
     * @returns the paths of the JSON and HTML files
     */
    async write(report: CompareReport, dir: string): Promise<{ json: string; html: string }> {
        mkdirSync(dir, { recursive: true });

        const json = join(dir, "report.json");
        const html = join(dir, "report.html");

        writeFileSync(json, `${JSON.stringify(sortKeys(report), null, 2)}\n`, "utf8");
        writeFileSync(html, renderHtml(report), "utf8");

        return { json, html };
    }
}
