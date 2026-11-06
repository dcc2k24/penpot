import { writeFile } from "node:fs/promises";
import { type ComparisonReport } from "./Compare.js";
import { type MemoryFigures, type RunResult } from "./ResultFile.js";

/**
 * Renders a run as one self-contained HTML page: inline styles, no scripts and no external resources.
 */
export class HtmlReport {
    /**
     * Builds the page.
     *
     * @param result - the run to show
     * @param comparison - optional comparison with an earlier run
     */
    static render(result: RunResult, comparison?: ComparisonReport): string {
        const spec = result.machineSpec;
        const sections = [
            `<h1>${esc(result.scenario)}</h1>`,
            result.description === "" ? "" : `<p class="lead">${esc(result.description)}</p>`,
            HtmlReport.summaryTable(result),
            HtmlReport.backendTable(result),
            HtmlReport.stepTable(result),
            HtmlReport.memoryTable(result),
            comparison === undefined ? "" : HtmlReport.comparisonTable(comparison),
            HtmlReport.listSection("Error samples", result.errorSamples),
            HtmlReport.listSection("Warnings", result.warnings),
            `<h2>Machine</h2>${HtmlReport.keyValues([
                ["Platform", `${spec.platform} ${spec.arch}`],
                ["CPU", `${spec.cpuModel} (${spec.cpuCores} cores)`],
                ["Memory", formatBytes(spec.totalMemoryBytes)],
                ["Node.js", spec.nodeVersion],
                ["Note", spec.note ?? "none"],
            ])}`,
        ];
        return [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            `<title>${esc(result.scenario)} load test</title>`,
            `<style>${STYLE}</style>`,
            "</head>",
            "<body>",
            `<main>${sections.join("\n")}</main>`,
            "</body>",
            "</html>",
            "",
        ].join("\n");
    }

    /**
     * Writes the page to a file.
     *
     * @param file - path to write, usually results/<run>.html
     * @param result - the run to show
     * @param comparison - optional comparison with an earlier run
     */
    static async write(file: string, result: RunResult, comparison?: ComparisonReport): Promise<void> {
        await writeFile(file, HtmlReport.render(result, comparison), "utf8");
    }

    /**
     * Table with the run totals.
     */
    private static summaryTable(result: RunResult): string {
        return `<h2>Summary</h2>${HtmlReport.keyValues([
            ["Commit", result.commit],
            ["Started", result.startedAt],
            ["Wall clock", formatMs(result.durationMs)],
            ["Agents", String(result.agents)],
            ["Iterations", String(result.iterations)],
            ["Rate cap per agent", result.rateLimitPerSecond === null ? "none" : `${result.rateLimitPerSecond} /s`],
            ["Calls", String(result.calls)],
            ["Errors", String(result.errors)],
            ["Payload", formatBytes(result.bytes)],
            ["p50", formatMs(result.p50)],
            ["p95", formatMs(result.p95)],
            ["p99", formatMs(result.p99)],
            ["max", formatMs(result.max)],
            ["DB statements", result.dbStatements === undefined ? "not sampled" : String(result.dbStatements)],
        ])}`;
    }

    /**
     * Table with the backend, database and server figures. Empty when the run watched none of them.
     */
    private static backendTable(result: RunResult): string {
        const rows = backendRows(result);
        if (rows.length === 0) {
            return "";
        }
        return `<h2>Backend</h2>${HtmlReport.keyValues(rows)}`;
    }

    /**
     * Table with the figures of each step.
     */
    private static stepTable(result: RunResult): string {
        const rows = result.steps.map((step) => {
            return (
                `<tr><td>${esc(step.name)}</td><td><code>${esc(step.tool)}</code></td><td>${step.calls}</td>` +
                `<td class="${step.errors > 0 ? "bad" : ""}">${step.errors}</td><td>${formatBytes(step.bytes)}</td>` +
                `<td>${formatMs(step.p50)}</td><td>${formatMs(step.p95)}</td><td>${formatMs(step.p99)}</td>` +
                `<td>${formatMs(step.max)}</td></tr>`
            );
        });
        return (
            `<h2>Steps</h2><table><thead><tr><th>Step</th><th>Tool</th><th>Calls</th><th>Errors</th>` +
            `<th>Payload</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead><tbody>${rows.join("")}` +
            "</tbody></table>"
        );
    }

    /**
     * Table with heap and resident memory of the load driver.
     */
    private static memoryTable(result: RunResult): string {
        return (
            `<h2>Memory of the load driver</h2><table><thead><tr><th>Figure</th><th>Start</th><th>End</th>` +
            `<th>Peak</th></tr></thead><tbody>${memoryRow("Heap", result.heap)}${memoryRow("RSS", result.rss)}` +
            "</tbody></table>"
        );
    }

    /**
     * Table with the rows of a comparison, flagged rows first in the colour of a regression.
     */
    private static comparisonTable(comparison: ComparisonReport): string {
        const rows = comparison.rows.map((row) => {
            const change = row.changePct === null ? "n/a" : `${(row.changePct * 100).toFixed(1)} %`;
            return (
                `<tr class="${row.regression ? "bad" : ""}"><td>${esc(row.scope)}</td><td>${esc(row.metric)}</td>` +
                `<td>${row.baseline}</td><td>${row.candidate}</td><td>${change}</td>` +
                `<td>${row.regression ? "REGRESSION" : ""}</td></tr>`
            );
        });
        return (
            `<h2>Compared with ${esc(comparison.baseline)}</h2><p>Threshold ` +
            `${(comparison.threshold * 100).toFixed(0)} %, ${comparison.regressions} regression(s).</p>` +
            `<table><thead><tr><th>Scope</th><th>Metric</th><th>Baseline</th><th>Candidate</th><th>Change</th>` +
            `<th>Flag</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        );
    }

    /**
     * Bulleted list, or nothing when the list is empty.
     */
    private static listSection(title: string, items: readonly string[]): string {
        if (items.length === 0) {
            return "";
        }
        return `<h2>${esc(title)}</h2><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
    }

    /**
     * Two-column definition list.
     */
    private static keyValues(pairs: [string, string][]): string {
        return `<dl>${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>`;
    }
}

/** Inline style of the page. Dark mode follows the system setting. */
const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #ffffff; --muted: #6e6e73; --line: #d2d2d7; --bad: #b42318; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #1c1c1e; --muted: #a1a1a6; --line: #3a3a3c; --bad: #ff8a80; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 24px; margin: 8px 0; }
h2 { font-size: 18px; margin: 28px 0 8px; }
.lead { color: var(--muted); margin-top: 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td { font-variant-numeric: tabular-nums; }
tr.bad td, td.bad { color: var(--bad); font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; word-break: break-all; }
code { font-size: 13px; }
ul { padding-left: 20px; }
li { word-break: break-word; }
`;

/**
 * Escapes text for HTML.
 *
 * @param text - text to escape
 */
function esc(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Formats a byte count as mebibytes with one decimal, for the summary lines.
 *
 * @param bytes - size in bytes
 */
export function formatMegabytes(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Divides a total by the number of calls, with one decimal. Shows n/a when the run made no calls.
 *
 * @param total - the figure over the whole run
 * @param calls - calls made in the run
 */
function perCall(total: number, calls: number): string {
    return calls > 0 ? (total / calls).toFixed(1) : "n/a";
}

/**
 * Average number of CPU cores that the backend kept busy. Shows n/a when the run lasted no time.
 *
 * @param cpuSeconds - CPU seconds the backend used
 * @param durationMs - length of the run in milliseconds
 */
function coresOn(cpuSeconds: number, durationMs: number): string {
    return durationMs > 0 ? (cpuSeconds / (durationMs / 1000)).toFixed(1) : "n/a";
}

/**
 * Lines that describe the backend, database and server figures of a run, for the console summary. Each figure
 * prints only when it was measured. Warnings come last.
 *
 * @param result - the finished run
 * @returns the lines, in print order, without a line break
 */
export function summaryLines(result: RunResult): string[] {
    const lines: string[] = [];
    const calls = result.calls;

    const heap = result.backendHeap;
    if (heap !== undefined) {
        const max = heap.maxBytes === undefined ? "" : `, max ${formatMegabytes(heap.maxBytes)} MB`;
        lines.push(
            `backend heap: start ${formatMegabytes(heap.startBytes)} MB, peak ${formatMegabytes(heap.peakBytes)} MB, ` +
                `end ${formatMegabytes(heap.endBytes)} MB${max}`
        );
    }

    const gc = result.gc;
    const cpu = result.backendCpuSeconds;
    if (gc !== undefined) {
        const cpuText =
            cpu === undefined ? "" : `; cpu ${cpu.toFixed(1)} s (${coresOn(cpu, result.durationMs)} cores on average)`;
        lines.push(`backend gc: ${gc.collections} collections, ${gc.seconds.toFixed(1)} s${cpuText}`);
    } else if (cpu !== undefined) {
        lines.push(`backend cpu: ${cpu.toFixed(1)} s (${coresOn(cpu, result.durationMs)} cores on average)`);
    }

    const counts: string[] = [];
    if (result.backendRequests !== undefined) {
        counts.push(`backend requests ${result.backendRequests}`);
    }
    if (result.mcpCommands !== undefined) {
        counts.push(`mcp commands ${result.mcpCommands}`);
    }
    if (result.connectionCheckouts !== undefined) {
        const checkouts = result.connectionCheckouts;
        counts.push(`pool checkouts ${checkouts} (${perCall(checkouts, calls)} per call)`);
    }
    if (counts.length > 0) {
        lines.push(counts.join(", "));
    }

    if (result.dbStatements !== undefined) {
        const statements = result.dbStatements;
        const source = result.dbStatementsSource ?? "unknown source";
        lines.push(`db statements ${statements} (${perCall(statements, calls)} per call, from ${source})`);
    } else if (result.pg !== undefined) {
        lines.push("db statements: not counted (pg_stat_statements is not loaded)");
    }

    const pg = result.pg;
    if (pg !== undefined) {
        lines.push(
            `db table scans ${pg.tableScans} (${perCall(pg.tableScans, calls)} per call), ` +
                `rows read ${pg.rowsRead}, ` +
                `rows written ${pg.rowsWritten} (${perCall(pg.rowsWritten, calls)} per call), ` +
                `transactions ${pg.transactions} (${perCall(pg.transactions, calls)} per call), ` +
                `file_change seq scans ${pg.fileChangeSeqScans}, index scans ${pg.fileChangeIdxScans}`
        );
    }

    const rss = result.serverRss;
    if (rss !== undefined) {
        lines.push(
            `mcp server rss: start ${formatMegabytes(rss.startBytes)} MB, peak ${formatMegabytes(rss.peakBytes)} MB, ` +
                `end ${formatMegabytes(rss.endBytes)} MB`
        );
    }

    for (const warning of result.warnings) {
        lines.push(`warning: ${warning}`);
    }
    return lines;
}

/**
 * Label and value pairs of the Backend table. Empty when the run watched nothing.
 *
 * @param result - the finished run
 */
function backendRows(result: RunResult): [string, string][] {
    const rows: [string, string][] = [];
    const calls = result.calls;
    const heap = result.backendHeap;
    if (heap !== undefined) {
        const max = heap.maxBytes === undefined ? "" : `, max ${formatBytes(heap.maxBytes)}`;
        rows.push([
            "Heap",
            `start ${formatBytes(heap.startBytes)}, peak ${formatBytes(heap.peakBytes)}, ` +
                `end ${formatBytes(heap.endBytes)}${max}`,
        ]);
    }
    if (result.gc !== undefined) {
        rows.push(["GC", `${result.gc.collections} collections, ${result.gc.seconds.toFixed(1)} s`]);
    }
    if (result.backendCpuSeconds !== undefined) {
        const cpu = result.backendCpuSeconds;
        rows.push(["CPU", `${cpu.toFixed(1)} s (${coresOn(cpu, result.durationMs)} cores on average)`]);
    }
    if (result.backendRequests !== undefined) {
        rows.push(["Backend requests", String(result.backendRequests)]);
    }
    if (result.mcpCommands !== undefined) {
        rows.push(["MCP commands", String(result.mcpCommands)]);
    }
    if (result.connectionCheckouts !== undefined) {
        const checkouts = result.connectionCheckouts;
        rows.push(["Pool checkouts", `${checkouts} (${perCall(checkouts, calls)} per call)`]);
    }
    if (result.dbStatements !== undefined) {
        const statements = result.dbStatements;
        const source = result.dbStatementsSource ?? "unknown source";
        rows.push(["DB statements", `${statements} (${perCall(statements, calls)} per call, from ${source})`]);
    } else if (result.pg !== undefined) {
        rows.push(["DB statements", "not counted (pg_stat_statements is not loaded)"]);
    }
    const pg = result.pg;
    if (pg !== undefined) {
        rows.push(["DB table scans", `${pg.tableScans} (${perCall(pg.tableScans, calls)} per call)`]);
        rows.push(["DB rows read", String(pg.rowsRead)]);
        rows.push(["DB rows written", `${pg.rowsWritten} (${perCall(pg.rowsWritten, calls)} per call)`]);
        rows.push(["DB transactions", `${pg.transactions} (${perCall(pg.transactions, calls)} per call)`]);
        rows.push(["file_change scans", `${pg.fileChangeSeqScans} seq, ${pg.fileChangeIdxScans} index`]);
    }
    const rss = result.serverRss;
    if (rss !== undefined) {
        rows.push([
            "MCP server RSS",
            `start ${formatBytes(rss.startBytes)}, peak ${formatBytes(rss.peakBytes)}, end ${formatBytes(rss.endBytes)}`,
        ]);
    }
    return rows;
}

/**
 * Formats milliseconds with one decimal.
 *
 * @param ms - duration in milliseconds
 */
function formatMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/**
 * Formats a byte count in binary units.
 *
 * @param bytes - size in bytes
 */
function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * One row of the memory table.
 *
 * @param label - name of the figure
 * @param memory - start, end and peak values
 */
function memoryRow(label: string, memory: MemoryFigures): string {
    return (
        `<tr><td>${label}</td><td>${formatBytes(memory.startBytes)}</td><td>${formatBytes(memory.endBytes)}</td>` +
        `<td>${formatBytes(memory.peakBytes)}</td></tr>`
    );
}
