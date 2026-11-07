import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignModel } from "../DesignModel.js";
import { APP_DIR, COMPARE_DIR, DESIGN_FILE } from "../Paths.js";
import { allTargets, VIEWPORT, type DesignTarget } from "../Targets.js";
import { DEFAULT_PIXEL_BUDGETS, type PixelBudgets } from "./Budget.js";
import type { PixelResult } from "./PixelCompare.js";
import type { AppBrowser } from "./Screenshots.js";
import { isRealMismatch, mergeReports, readReport, ReportWriter, type CompareReport } from "./Report.js";

/** Path of the generated routes file, relative to the app folder. Its presence shows that generate has run. */
const ROUTES_FILE_PARTS = ["src", "routes.tsx"] as const;

/** Name of the report file in the compare folder. */
const REPORT_NAME = "report.json";

/** Smallest device scale of the pixel compare. */
export const MIN_SCALE = 1;

/** Largest device scale of the pixel compare. */
export const MAX_SCALE = 3;

/** Device scale of the pixel compare when no scale is given. */
export const DEFAULT_SCALE = 2;

/**
 * Chooses the targets to compare. Without a filter every target is returned, in the given order. With a filter, the
 * targets whose id or name equals the filter are returned. The comparison ignores case and does not match substrings.
 *
 * @param targets - all targets of the model
 * @param filter - id or name of one target, or undefined for all of them
 * @throws Error when the filter matches no target
 */
export function selectTargets(targets: DesignTarget[], filter: string | undefined): DesignTarget[] {
    if (filter === undefined) {
        return [...targets];
    }
    return selectTargetList(targets, [filter]);
}

/**
 * Chooses the targets whose id or name equals one of the filters. The targets keep the order of the given list, and
 * each target appears once. The comparison ignores case and does not match substrings.
 *
 * @param targets - all targets of the model, in model order
 * @param filters - ids or names of the wanted targets
 * @returns the matching targets, in model order
 * @throws Error when a filter matches no target
 */
export function selectTargetList(targets: readonly DesignTarget[], filters: readonly string[]): DesignTarget[] {
    const selected = new Set<DesignTarget>();
    for (const filter of filters) {
        const wanted = filter.toLowerCase();
        const matched = targets.filter(
            (target) => target.id.toLowerCase() === wanted || target.name.toLowerCase() === wanted
        );
        if (matched.length === 0) {
            throw new Error(`no target matches "${filter}"`);
        }
        for (const target of matched) {
            selected.add(target);
        }
    }
    return targets.filter((target) => selected.has(target));
}

/**
 * Builds the text of the pixel column for one target.
 *
 * @param pixel - pixel results of the run, or null when the pixel step did not run
 * @param targetId - id of the target
 */
function pixelCell(pixel: PixelResult[] | null, targetId: string): string {
    if (pixel === null) {
        return "not run";
    }
    const result = pixel.find((candidate) => candidate.targetId === targetId);
    if (result === undefined) {
        return "not run";
    }
    if (result.status === "ok") {
        const flags = [result.overBudget === true ? "OVER BUDGET" : "", isRealMismatch(result) ? "REAL MISMATCH" : ""]
            .filter((flag) => flag !== "")
            .map((flag) => ` ${flag}`)
            .join("");
        return `${result.percent ?? "?"}% (budget ${result.budget ?? "?"}%)${flags}`;
    }
    if (result.status === "unavailable") {
        return `unavailable: ${result.reason ?? ""}`;
    }
    return `size mismatch ${result.design ?? ""} / ${result.implemented ?? ""}`;
}

/**
 * Builds the largest cluster and cluster count cells for one target. Both are "-" when the target has no ok pixel
 * result.
 *
 * @param pixel - pixel results of the run, or null when the pixel step did not run
 * @param targetId - id of the target
 * @returns the two cell texts, largest cluster first
 */
function clusterCells(pixel: PixelResult[] | null, targetId: string): [string, string] {
    const result = pixel?.find((candidate) => candidate.targetId === targetId);
    if (result === undefined || result.status !== "ok") {
        return ["-", "-"];
    }
    return [String(result.largestCluster ?? "?"), String(result.clusters ?? "?")];
}

/**
 * Formats a comparison report as a plain text table. There is one row per target, and the last line gives the DOM
 * mismatch count, the number of targets over their pixel budget, the number of real mismatches, and the budgets. The
 * function does not print.
 *
 * @param report - the comparison report
 */
export function formatCompareTable(report: CompareReport): string {
    const header = ["target", "nodes", "DOM mismatches", "info", "largest cluster", "clusters", "pixel"];
    const rows = report.dom.targets.map((target) => [
        target.id,
        String(target.nodes),
        String(target.mismatches),
        String(target.info.length),
        ...clusterCells(report.pixel, target.id),
        pixelCell(report.pixel, target.id),
    ]);
    const table: string[][] = [header, ...rows];
    const widths = header.map((_, column) => Math.max(...table.map((row) => row[column].length)));
    const lines = table.map((row) =>
        row
            .map((cell, column) => (column === header.length - 1 ? cell : cell.padEnd(widths[column])))
            .join("  ")
            .trimEnd()
    );
    const over = (report.pixel ?? []).filter((result) => result.status === "ok" && result.overBudget === true).length;
    const real = (report.pixel ?? []).filter(isRealMismatch).length;
    lines.push(
        `DOM mismatches: ${report.dom.mismatches.length} across ${report.dom.targets.length} targets, ` +
            `pixel over budget: ${over} targets, ` +
            `real mismatches: ${real} targets, ` +
            `budgets component ${report.budgets.component} percent and screen ${report.budgets.screen} percent`
    );
    return lines.join("\n");
}

/** Failing checks of one compare run. */
export interface CompareOutcome {
    /** DOM mismatches in the merged report. */
    domMismatches: number;
    /** Pixel results of this run that fail the pixel gate: over budget, or not compared. */
    pixelFailures: number;
}

/**
 * Counts the pixel results that fail the gate: a target over its budget, or a target that could not be compared.
 *
 * @param pixel - pixel results of the run, or null when the pixel step did not run
 * @returns the number of failing targets, 0 when the pixel step did not run
 */
export function countPixelFailures(pixel: PixelResult[] | null): number {
    return (pixel ?? []).filter((result) => result.status !== "ok" || result.overBudget === true).length;
}

/**
 * Turns the failing checks of a run into an exit code. A DOM mismatch always fails. A pixel failure fails too, unless
 * the run is advisory.
 *
 * @param outcome - failing checks of the run
 * @param advisory - true to report the pixel results without failing on them
 * @returns 1 when the run fails, otherwise 0
 */
export function compareExitCode(outcome: CompareOutcome, advisory: boolean): number {
    const failed = outcome.domMismatches > 0 || (!advisory && outcome.pixelFailures > 0);
    return failed ? 1 : 0;
}

/**
 * Runs the comparison of the design file against the generated app. It checks the design file, starts the app
 * server, runs the DOM and pixel comparators, merges the result into the report and prints the merged table. Targets
 * that were not run keep their entries from the previous report.
 *
 * @param args - `screen` is the id or name of one target, `targets` is a list of ids or names, `pixel` turns on the
 *   pixel comparison, and `scale` is the device scale of the pixel comparison, an integer from MIN_SCALE to MAX_SCALE
 *   (default DEFAULT_SCALE), and `appBrowser` is where the pixel screenshots are taken (default local). Without
 *   `screen` and `targets` every target runs.
 * @returns the DOM mismatches of the merged report and the pixel failures of this run, used by the caller for the exit code
 * @throws Error when the scale is not an integer from MIN_SCALE to MAX_SCALE, when the design file is missing or has
 *   another format version, when a filter matches no target, when no target is selected, or when the app has not been
 *   generated
 */
export async function runCompare(args: {
    screen?: string;
    targets?: string[];
    pixel: boolean;
    scale?: number;
    appBrowser?: AppBrowser;
    budgets?: PixelBudgets;
}): Promise<CompareOutcome> {
    const appBrowser: AppBrowser = args.appBrowser ?? { mode: "local" };
    const scale = args.scale ?? DEFAULT_SCALE;
    const budgets: PixelBudgets = { ...(args.budgets ?? DEFAULT_PIXEL_BUDGETS) };
    if (!Number.isInteger(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
        throw new Error(`scale must be an integer from ${MIN_SCALE} to ${MAX_SCALE}, found ${scale}`);
    }
    if (!existsSync(DESIGN_FILE)) {
        throw new Error(`design file not found: ${DESIGN_FILE}, run pull first`);
    }
    const model = JSON.parse(readFileSync(DESIGN_FILE, "utf8")) as DesignModel;
    if (model.formatVersion !== 1) {
        throw new Error(`design file format version is not 1, found ${String(model.formatVersion)}`);
    }
    const all = allTargets(model);
    const filters =
        args.screen === undefined && args.targets === undefined
            ? undefined
            : [...(args.screen === undefined ? [] : [args.screen]), ...(args.targets ?? [])];
    const targets = filters === undefined ? all : selectTargetList(all, filters);
    if (targets.length === 0) {
        throw new Error("no target selected to compare");
    }
    const routesFile = join(APP_DIR, ...ROUTES_FILE_PARTS);
    if (!existsSync(routesFile)) {
        throw new Error(`app not generated: run generate first, missing ${routesFile}`);
    }

    // the servers and browsers are heavy, so they load only when a comparison really runs.
    const { AppServer } = await import("./ViteServer.js");
    const { DomComparator } = await import("./DomCompare.js");
    const { PixelComparator } = await import("./PixelCompare.js");

    const server = await AppServer.start(APP_DIR, { host: appBrowser.mode === "docker" ? "docker" : "local" });
    try {
        const log = (line: string): void => {
            console.log(line);
        };
        const dom = await new DomComparator().run(model, targets, server.url, log);
        // the DOM step always uses the host URL. The pixel step uses the container URL in docker mode.
        const pixelUrl = appBrowser.mode === "docker" ? server.containerUrl : server.url;
        if (args.pixel && pixelUrl === undefined) {
            throw new Error("the app server has no container URL for the docker screenshots");
        }
        const pixel =
            args.pixel && pixelUrl !== undefined
                ? await new PixelComparator().run(model, targets, pixelUrl, log, scale, appBrowser, budgets)
                : null;
        const fresh: CompareReport = {
            generatedFrom: model.pulledAt,
            viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
            dom,
            pixel,
            budgets,
            scale,
        };
        const report = mergeReports(
            readReport(join(COMPARE_DIR, REPORT_NAME)),
            fresh,
            targets.map((target) => target.id),
            all.map((target) => target.id)
        );
        const paths = await new ReportWriter().write(report, COMPARE_DIR);
        console.log(formatCompareTable(report));
        console.log(`report json: ${paths.json}`);
        console.log(`report html: ${paths.html}`);
        return { domMismatches: report.dom.mismatches.length, pixelFailures: countPixelFailures(pixel) };
    } finally {
        await server.close();
    }
}
