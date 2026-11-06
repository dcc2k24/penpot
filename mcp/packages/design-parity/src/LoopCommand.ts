import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignModel } from "./DesignModel.js";
import { allTargets } from "./Targets.js";
import { runCompare } from "./compare/CompareCommand.js";
import type { DomMismatch } from "./compare/DomCompare.js";
import { readReport, type CompareReport } from "./compare/Report.js";
import { runGenerate } from "./generate/GenerateCommand.js";
import { COMPARE_DIR, DESIGN_FILE } from "./Paths.js";

/** Exit code of a loop that failed, or that still has DOM mismatches. */
const EXIT_FAILURE = 1;

/** Largest number of iterations that `--max` accepts. */
const MAX_ITERATIONS_LIMIT = 20;

/** Path of the report of the last comparison. */
const REPORT_FILE = join(COMPARE_DIR, "report.json");

/** Attributes whose cause is in the generator. */
const GENERATOR_ATTRIBUTES: ReadonlySet<string> = new Set([
    "element",
    "text",
    "font-size",
    "font-weight",
    "font-family",
    "line-height",
    "letter-spacing",
    "text-align",
    "color",
    "background-color",
    "opacity",
]);

/** Attributes of the position and the size. Their cause is in the model or in the generator. */
const MODEL_OR_GENERATOR_ATTRIBUTES: ReadonlySet<string> = new Set(["x", "y", "width", "height"]);

/**
 * Gives the likely cause of a mismatch in one attribute. The class is a hint for the person who fixes the mismatch.
 * Attributes that start with "outline-" or "border-" belong to the generator.
 *
 * @param attribute - attribute name of a DOM mismatch
 * @returns "generator", "model-or-generator" or "unclassified"
 */
export function classifyAttribute(attribute: string): string {
    if (MODEL_OR_GENERATOR_ATTRIBUTES.has(attribute)) {
        return "model-or-generator";
    }
    if (GENERATOR_ATTRIBUTES.has(attribute) || attribute.startsWith("outline-") || attribute.startsWith("border-")) {
        return "generator";
    }
    return "unclassified";
}

/**
 * Lists the ids of the failed targets of a report. A target failed when its DOM mismatch count is above 0. Pixel
 * results do not count, because the loop runs with the pixel step off and those results can be stale.
 *
 * @param report - report of a comparison
 * @returns the ids of the failed targets, in the order of the report
 */
export function failedTargetIds(report: CompareReport): string[] {
    return report.dom.targets.filter((target) => target.mismatches > 0).map((target) => target.id);
}

/**
 * Chooses the targets that the next comparison runs. It is every target when `all` is set, when there is no usable
 * report, when the report comes from another pull, when the report lacks a target, or when the report has no failed
 * target. Otherwise it is the failed targets.
 *
 * @param report - report of the last comparison, or null when there is none
 * @param pulledAt - pull time of the current design model
 * @param order - ids of all targets, in model order
 * @param all - true when every target must run
 * @returns the ids to run, in model order
 */
export function chooseRerunIds(
    report: CompareReport | null,
    pulledAt: string,
    order: readonly string[],
    all: boolean
): string[] {
    if (all || report === null || report.generatedFrom !== pulledAt) {
        return [...order];
    }
    const known = new Set(report.dom.targets.map((target) => target.id));
    if (order.some((id) => !known.has(id))) {
        return [...order];
    }
    const failed = new Set(failedTargetIds(report));
    const rerun = order.filter((id) => failed.has(id));
    return rerun.length === 0 ? [...order] : rerun;
}

/**
 * Reads the pulled design model.
 *
 * @throws Error when the design file is missing
 */
function readDesignModel(): DesignModel {
    if (!existsSync(DESIGN_FILE)) {
        throw new Error(`design file not found: ${DESIGN_FILE}, run pull first`);
    }
    return JSON.parse(readFileSync(DESIGN_FILE, "utf8")) as DesignModel;
}

/**
 * Reads the report of the last comparison. The report holds every target, not only the ones that ran last.
 *
 * @throws Error when the report file is missing or cannot be used
 */
function readLastReport(): CompareReport {
    const report = readReport(REPORT_FILE);
    if (report === null) {
        throw new Error(`no usable report: ${REPORT_FILE}`);
    }
    return report;
}

/**
 * Prints the mismatches grouped by attribute. Each group shows its count, the first three mismatches, and a class.
 *
 * @param mismatches - DOM mismatches of the last comparison
 */
function printGroups(mismatches: DomMismatch[]): void {
    const groups = new Map<string, DomMismatch[]>();
    for (const mismatch of mismatches) {
        const group = groups.get(mismatch.attribute) ?? [];
        group.push(mismatch);
        groups.set(mismatch.attribute, group);
    }
    for (const [attribute, group] of groups) {
        console.log(`[loop] ${attribute}: ${group.length}`);
        for (const mismatch of group.slice(0, 3)) {
            console.log(
                `[loop]   ${mismatch.targetId} ${mismatch.nodeName} ${mismatch.path} ` +
                    `design=${mismatch.design} implemented=${mismatch.implemented}`
            );
        }
        console.log(`[loop]   class: ${classifyAttribute(attribute)}`);
        if (MODEL_OR_GENERATOR_ATTRIBUTES.has(attribute)) {
            console.log("[loop]   check flex layout");
        }
    }
}

/**
 * Runs generate, then the DOM comparison of the failed targets, and reports the result of each iteration. The
 * exit check uses the merged report, so it counts the mismatches of every target. It stops at the first comparison
 * with no DOM mismatches. When mismatches remain, it prints them grouped by attribute and stops too, because nothing
 * changes between iterations. No fix is applied.
 *
 * @param maxIterations - largest number of iterations, from 1 to 20
 * @param all - true to compare every target on each iteration, not only the failed ones
 * @returns 0 when the comparison has no DOM mismatches, or 1 when generate fails or mismatches remain
 * @throws Error when maxIterations is not an integer from 1 to 20, or when the comparison cannot run
 */
export async function runLoop(maxIterations: number, all = false): Promise<number> {
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ITERATIONS_LIMIT) {
        throw new Error(`max iterations must be an integer from 1 to ${MAX_ITERATIONS_LIMIT}, found ${maxIterations}`);
    }
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if ((await runGenerate()) !== 0) {
            return EXIT_FAILURE;
        }
        const model = readDesignModel();
        const order = allTargets(model).map((target) => target.id);
        const rerun = chooseRerunIds(readReport(REPORT_FILE), model.pulledAt, order, all);
        console.log(`[loop] rerun ${rerun.length} of ${order.length} targets: ${rerun.join(", ")}`);
        const count = await runCompare({ targets: rerun, pixel: false });
        console.log(`[loop] iteration ${iteration}: ${count} DOM mismatches`);
        if (count === 0) {
            console.log(`[loop] converged after ${iteration} iteration(s)`);
            return 0;
        }
        printGroups(readLastReport().dom.mismatches);
        console.log(
            "[loop] stopped: no automatic fix is applied, fix the generator or the puller by hand and run loop again"
        );
        return EXIT_FAILURE;
    }
    // Not reached: the first iteration always returns. The return keeps every path explicit.
    return EXIT_FAILURE;
}
