/** Outcome of a tool call, as the metrics count it. */
export type CallOutcome = "ok" | "error";

/**
 * Counts tool calls and records their durations, and renders them in the Prometheus text format.
 *
 * The state is kept in this process only. Labels are the tool name and the outcome, so the series
 * count stays small.
 */
export class AdapterMetrics {
    /** Upper bounds of the duration buckets, in seconds. */
    public static readonly BUCKET_BOUNDS_SECONDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

    private readonly counts = new Map<string, number>();
    private readonly bucketCounts = new Array<number>(AdapterMetrics.BUCKET_BOUNDS_SECONDS.length).fill(0);
    private durationSumSeconds = 0;
    private durationCount = 0;

    /**
     * Records one finished tool call.
     *
     * @param tool - name of the tool
     * @param outcome - `ok` or `error`
     * @param durationMs - wall-clock duration of the call, in milliseconds
     */
    public recordToolCall(tool: string, outcome: CallOutcome, durationMs: number): void {
        const key = `${tool}\u0000${outcome}`;
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
        const seconds = durationMs / 1000;
        this.durationSumSeconds += seconds;
        this.durationCount += 1;
        const index = AdapterMetrics.BUCKET_BOUNDS_SECONDS.findIndex((bound) => seconds <= bound);
        if (index >= 0) {
            this.bucketCounts[index] += 1;
        }
    }

    /**
     * Renders the metrics as Prometheus text.
     *
     * @param families - more metric families to add after the tool-call metrics, such as the sandbox counters
     * @returns the exposition text, one metric family after another
     */
    public render(families: MetricFamily[]): string {
        const lines: string[] = [];
        lines.push("# HELP penpot_mcp_tool_calls_total Finished tool calls by tool and outcome.");
        lines.push("# TYPE penpot_mcp_tool_calls_total counter");
        for (const [key, count] of [...this.counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            const [tool, outcome] = key.split("\u0000");
            lines.push(`penpot_mcp_tool_calls_total{tool="${escapeLabel(tool)}",outcome="${outcome}"} ${count}`);
        }

        lines.push("# HELP penpot_mcp_tool_call_duration_seconds Wall-clock duration of tool calls.");
        lines.push("# TYPE penpot_mcp_tool_call_duration_seconds histogram");
        let cumulative = 0;
        AdapterMetrics.BUCKET_BOUNDS_SECONDS.forEach((bound, index) => {
            cumulative += this.bucketCounts[index];
            lines.push(`penpot_mcp_tool_call_duration_seconds_bucket{le="${bound}"} ${cumulative}`);
        });
        lines.push(`penpot_mcp_tool_call_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`);
        lines.push(`penpot_mcp_tool_call_duration_seconds_sum ${this.durationSumSeconds}`);
        lines.push(`penpot_mcp_tool_call_duration_seconds_count ${this.durationCount}`);

        for (const family of families) {
            lines.push(`# HELP ${family.name} ${family.help}`);
            lines.push(`# TYPE ${family.name} ${family.type}`);
            for (const sample of family.samples) {
                const labels = Object.entries(sample.labels ?? {})
                    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
                    .join(",");
                lines.push(`${family.name}${labels === "" ? "" : `{${labels}}`} ${sample.value}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }
}

/** One metric family to render: its name, help text, type and samples. */
export interface MetricFamily {
    name: string;
    help: string;
    type: "gauge" | "counter";
    samples: { labels?: Record<string, string>; value: number }[];
}

/**
 * Escapes a value for a Prometheus label.
 *
 * @param value - the raw label value
 */
function escapeLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
