import { type RunResult } from "./ResultFile.js";

/** One compared figure of a baseline and a candidate run. */
export interface ComparisonRow {
    /** "total" for the whole run, otherwise the name of a step. */
    scope: string;
    /** p50, p95, p99, max or errors. */
    metric: string;
    /** Value in the baseline run. */
    baseline: number;
    /** Value in the candidate run. */
    candidate: number;
    /** Relative change, or null when the baseline is zero. */
    changePct: number | null;
    /** True when the candidate is worse by more than the threshold. */
    regression: boolean;
}

/** Result of comparing two runs. */
export interface ComparisonReport {
    /** Name of the baseline result file or scenario. */
    baseline: string;
    /** Name of the candidate result file or scenario. */
    candidate: string;
    /** Relative slowdown that counts as a regression, for example 0.2 for 20 %. */
    threshold: number;
    /** Every compared figure. */
    rows: ComparisonRow[];
    /** Number of rows flagged as regressions. */
    regressions: number;
}

/**
 * Compares a candidate run with a baseline run, figure by figure.
 *
 * Latency figures are regressions when they rise by more than the threshold. Error counts are regressions when
 * they rise at all. A step is matched by its name, so steps that were added or removed are left out.
 */
export class ResultComparison {
    /** Relative slowdown flagged as a regression by default. */
    static readonly DEFAULT_THRESHOLD = 0.2;

    /**
     * @param threshold - relative slowdown that counts as a regression
     */
    constructor(private readonly threshold: number = ResultComparison.DEFAULT_THRESHOLD) {}

    /**
     * Compares two runs.
     *
     * @param baseline - earlier run
     * @param candidate - later run
     * @param baselineName - label of the baseline in the report
     * @param candidateName - label of the candidate in the report
     */
    compare(baseline: RunResult, candidate: RunResult, baselineName: string, candidateName: string): ComparisonReport {
        const rows: ComparisonRow[] = [
            ...this.latencyRows("total", baseline, candidate),
            this.errorRow("total", baseline.errors, candidate.errors),
        ];
        for (const candidateStep of candidate.steps) {
            const baselineStep = baseline.steps.find((step) => step.name === candidateStep.name);
            if (baselineStep === undefined) {
                continue;
            }
            rows.push(...this.latencyRows(candidateStep.name, baselineStep, candidateStep));
            rows.push(this.errorRow(candidateStep.name, baselineStep.errors, candidateStep.errors));
        }
        return {
            baseline: baselineName,
            candidate: candidateName,
            threshold: this.threshold,
            rows,
            regressions: rows.filter((row) => row.regression).length,
        };
    }

    /**
     * Formats a comparison as a plain-text table for the terminal.
     *
     * @param report - comparison to print
     */
    static format(report: ComparisonReport): string {
        const header = ["scope", "metric", "baseline", "candidate", "change", "flag"];
        const lines = report.rows.map((row) => [
            row.scope,
            row.metric,
            ResultComparison.formatNumber(row.baseline),
            ResultComparison.formatNumber(row.candidate),
            row.changePct === null ? "n/a" : `${(row.changePct * 100).toFixed(1)} %`,
            row.regression ? "REGRESSION" : "",
        ]);
        const widths = header.map((title, column) =>
            Math.max(title.length, ...lines.map((line) => line[column].length))
        );
        const render = (cells: string[]) =>
            cells
                .map((cell, column) => cell.padEnd(widths[column]))
                .join("  ")
                .trimEnd();
        return [
            `baseline:  ${report.baseline}`,
            `candidate: ${report.candidate}`,
            `threshold: ${(report.threshold * 100).toFixed(0)} %`,
            "",
            render(header),
            render(widths.map((width) => "-".repeat(width))),
            ...lines.map(render),
            "",
            `${report.regressions} regression(s)`,
        ].join("\n");
    }

    /**
     * Compares the four latency figures of one scope.
     */
    private latencyRows(
        scope: string,
        baseline: Pick<RunResult, "p50" | "p95" | "p99" | "max">,
        candidate: Pick<RunResult, "p50" | "p95" | "p99" | "max">
    ): ComparisonRow[] {
        return (["p50", "p95", "p99", "max"] as const).map((metric) => {
            const base = baseline[metric];
            const cand = candidate[metric];
            const changePct = base === 0 ? null : (cand - base) / base;
            return {
                scope,
                metric,
                baseline: base,
                candidate: cand,
                changePct,
                regression: changePct !== null && changePct > this.threshold,
            };
        });
    }

    /**
     * Compares the error count of one scope.
     */
    private errorRow(scope: string, baseline: number, candidate: number): ComparisonRow {
        return {
            scope,
            metric: "errors",
            baseline,
            candidate,
            changePct: baseline === 0 ? null : (candidate - baseline) / baseline,
            regression: candidate > baseline,
        };
    }

    /**
     * Formats a figure with a fixed number of decimals, without trailing noise.
     */
    private static formatNumber(value: number): string {
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }
}
