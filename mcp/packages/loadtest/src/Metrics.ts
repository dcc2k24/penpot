/** Summed values of a Prometheus scrape, keyed by metric name. */
export type MetricTotals = Record<string, number>;

/** JVM and backend figures read from one scrape. A field is undefined when its series is missing. */
export interface JvmFigures {
    /** Bytes used in the JVM heap. */
    heapUsedBytes?: number;
    /** Largest size of the JVM heap in bytes. */
    heapMaxBytes?: number;
    /** Seconds spent in garbage collection, summed over every collector. */
    gcSeconds?: number;
    /** Garbage collections, summed over every collector. */
    gcCount?: number;
    /** CPU seconds used by the backend process. */
    cpuSeconds?: number;
    /** Connections taken from the database pools, summed over every pool. */
    connectionCheckouts?: number;
    /** RPC requests served by the backend, summed over every name. */
    backendRequests?: number;
    /** MCP tool calls served by the backend, summed over every tool and outcome. */
    mcpCommands?: number;
}

/**
 * Reads the backend Prometheus endpoint before and after a run.
 */
export class MetricsSampler {
    /**
     * @param url - full URL of the metrics endpoint, for example http://localhost:6061/metrics
     * @param fetcher - fetch implementation, replaceable in tests
     */
    constructor(
        private readonly url: string,
        private readonly fetcher: typeof fetch = fetch
    ) {}

    /**
     * Scrapes the endpoint once and returns the raw Prometheus text.
     *
     * @throws Error when the endpoint does not answer with HTTP 200
     */
    async scrape(): Promise<string> {
        const response = await this.fetcher(this.url);
        if (!response.ok) {
            throw new Error(`metrics endpoint ${this.url} answered HTTP ${response.status}`);
        }
        return response.text();
    }

    /**
     * Scrapes the endpoint once.
     *
     * @throws Error when the endpoint does not answer with HTTP 200
     */
    async sample(): Promise<MetricTotals> {
        return MetricsSampler.parse(await this.scrape());
    }

    /**
     * Sums every sample of each metric in Prometheus text exposition format. Labels are ignored.
     *
     * @param text - body of a scrape
     */
    static parse(text: string): MetricTotals {
        const totals: MetricTotals = {};
        for (const line of text.split("\n")) {
            if (line === "" || line.startsWith("#")) {
                continue;
            }
            const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
            if (match === null) {
                continue;
            }
            const value = Number(match[2]);
            if (Number.isNaN(value)) {
                continue;
            }
            totals[match[1]] = (totals[match[1]] ?? 0) + value;
        }
        return totals;
    }

    /**
     * Reads every sample of a Prometheus text scrape, one entry per series. The key is the metric name plus its
     * label block exactly as written, for example jvm_memory_bytes_used{area="heap"}. A line without labels uses the
     * bare name. Comments, blank lines and NaN values are left out.
     *
     * @param text - body of a scrape
     */
    static parseSeries(text: string): Record<string, number> {
        const series: Record<string, number> = {};
        for (const line of text.split("\n")) {
            if (line === "" || line.startsWith("#")) {
                continue;
            }
            const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+(\S+)/.exec(line);
            if (match === null) {
                continue;
            }
            const value = Number(match[2]);
            if (Number.isNaN(value)) {
                continue;
            }
            series[match[1]] = value;
        }
        return series;
    }

    /**
     * Reads the JVM, garbage collection, CPU, connection pool and request figures out of the series of one scrape.
     * Several series of one metric, such as several collectors or pools, are summed.
     *
     * @param series - output of parseSeries()
     */
    static jvmFigures(series: Record<string, number>): JvmFigures {
        return {
            heapUsedBytes: MetricsSampler.sumOf(series, "jvm_memory_bytes_used", 'area="heap"'),
            heapMaxBytes: MetricsSampler.sumOf(series, "jvm_memory_bytes_max", 'area="heap"'),
            gcSeconds: MetricsSampler.sumOf(series, "jvm_gc_collection_seconds_sum"),
            gcCount: MetricsSampler.sumOf(series, "jvm_gc_collection_seconds_count"),
            cpuSeconds: MetricsSampler.sumOf(series, "process_cpu_seconds_total"),
            connectionCheckouts: MetricsSampler.sumOf(series, "hikaricp_connection_usage_millis_count"),
            backendRequests: MetricsSampler.sumOf(series, "penpot_rpc_main_timing_count"),
            mcpCommands: MetricsSampler.sumOf(series, "penpot_mcp_tool_duration_seconds_count"),
        };
    }

    /**
     * Sums the series of one metric, optionally only those whose label block contains a given text.
     *
     * @param series - output of parseSeries()
     * @param name - metric name without labels
     * @param label - text that the label block must contain, for example area="heap"
     * @returns the sum, or undefined when no series matches
     */
    private static sumOf(series: Record<string, number>, name: string, label?: string): number | undefined {
        let total: number | undefined;
        for (const [key, value] of Object.entries(series)) {
            const brace = key.indexOf("{");
            const metric = brace === -1 ? key : key.slice(0, brace);
            if (metric !== name) {
                continue;
            }
            if (label !== undefined && (brace === -1 || !key.slice(brace).includes(label))) {
                continue;
            }
            total = (total ?? 0) + value;
        }
        return total;
    }

    /**
     * Computes the change of every penpot_* counter between two scrapes, leaving out histogram buckets and
     * metrics that did not move.
     *
     * @param before - scrape at the start of the run
     * @param after - scrape at the end of the run
     */
    static delta(before: MetricTotals, after: MetricTotals): Record<string, number> {
        const changes: Record<string, number> = {};
        for (const [name, value] of Object.entries(after)) {
            if (!name.startsWith("penpot_") || name.endsWith("_bucket")) {
                continue;
            }
            const change = value - (before[name] ?? 0);
            if (change !== 0) {
                changes[name] = change;
            }
        }
        return changes;
    }

    /**
     * Picks the statement counter out of a metric delta. A metric counts as the statement counter when its name
     * ends in statement_total or statements_total.
     *
     * @param changes - output of delta()
     * @returns the summed change, or undefined when no such metric exists in the scrape
     */
    static dbStatements(changes: Record<string, number>): number | undefined {
        const names = Object.keys(changes).filter((name) => /statements?_total$/.test(name));
        if (names.length === 0) {
            return undefined;
        }
        return names.reduce((sum, name) => sum + changes[name], 0);
    }
}
