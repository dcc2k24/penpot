import { type JvmFigures, MetricsSampler, type MetricTotals } from "./Metrics.js";
import { type CommandRunner, defaultRunner, type PgCounters, PgStats, type PgStatsTarget } from "./PgStats.js";
import { ProcessRss } from "./ProcessRss.js";

/** Where the watcher looks during a run. Each source is optional and fails on its own. */
export interface BackendWatchOptions {
    /** Prometheus endpoint of the backend, for example http://localhost:6061/metrics. */
    metricsUrl?: string;
    /** Postgres counters, read through docker exec. */
    pgStats?: PgStatsTarget;
    /** Process id of the MCP server to watch. */
    serverPid?: number;
    /** Time between two periodic samples in milliseconds. Defaults to 5000. */
    intervalMs?: number;
    /**
     * Wait before the final Postgres sample, in milliseconds. Defaults to 11000, because Postgres flushes the stats of
     * idle backends within 10 s.
     */
    pgSettleMs?: number;
    /** Fetch implementation, replaceable in tests. */
    fetcher?: typeof fetch;
    /** Command runner for docker and tasklist or ps, replaceable in tests. */
    runner?: CommandRunner;
    /** Wait function, replaceable in tests. */
    sleep?: (ms: number) => Promise<void>;
}

/** What the watcher measured during a run. A source that failed leaves out its figures and adds a warning. */
export interface BackendFigures {
    /** Change of every penpot_* counter between the first and the last scrape. */
    metricsDelta?: Record<string, number>;
    /** Statement count of the run, from the metrics when they have one, else from pg_stat_statements. */
    dbStatements?: number;
    /** Where dbStatements came from. */
    dbStatementsSource?: "metrics" | "pg_stat_statements";
    /** JVM heap of the backend in bytes. The peak covers the start, every periodic sample and the end. */
    backendHeap?: { startBytes: number; endBytes: number; peakBytes: number; maxBytes?: number };
    /** Garbage collection of the backend during the run. */
    gc?: { seconds: number; collections: number };
    /** CPU seconds the backend used during the run. */
    backendCpuSeconds?: number;
    /** RPC requests the backend served during the run. */
    backendRequests?: number;
    /** MCP tool calls the backend served during the run. */
    mcpCommands?: number;
    /** Connections the backend took from its database pools during the run. */
    connectionCheckouts?: number;
    /** Change of the Postgres counters during the run. */
    pg?: PgCounters;
    /** Resident memory of the MCP server in bytes. The peak covers the start, every periodic sample and the end. */
    serverRss?: { startBytes: number; endBytes: number; peakBytes: number };
    /** Problems that did not stop the run. */
    warnings: string[];
}

/** Metrics taken from one scrape. */
interface MetricsSnapshot {
    /** Summed values, input of MetricsSampler.delta. */
    totals: MetricTotals;
    /** JVM figures read from the series. */
    jvm: JvmFigures;
}

/**
 * Reads the Prometheus text of one scrape into the totals and the JVM figures.
 *
 * @param text - body of a scrape
 */
function snapshotOf(text: string): MetricsSnapshot {
    return {
        totals: MetricsSampler.parse(text),
        jvm: MetricsSampler.jvmFigures(MetricsSampler.parseSeries(text)),
    };
}

/**
 * Turns any thrown value into a message.
 *
 * @param error - the thrown value
 */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Subtracts two optional readings.
 *
 * @param before - reading at the start
 * @param after - reading at the end
 * @returns after minus before, or undefined when either reading is missing
 */
function difference(before: number | undefined, after: number | undefined): number | undefined {
    if (before === undefined || after === undefined) {
        return undefined;
    }
    return after - before;
}

/**
 * Watches the backend, its database and the MCP server while a run is in progress. Start it before the run and stop
 * it after the run.
 */
export class BackendWatch {
    /** Sampling period when the options leave it out. */
    private static readonly DEFAULT_INTERVAL_MS = 5000;
    /** Wait before the final Postgres sample when the options leave it out. */
    private static readonly DEFAULT_PG_SETTLE_MS = 11000;

    /** Scraper of the backend, present when a metrics URL is set. */
    private readonly metrics?: MetricsSampler;
    /** Postgres reader, present when a target is set. */
    private readonly pg?: PgStats;
    /** Memory reader of the MCP server, present when a pid is set. */
    private readonly rss?: ProcessRss;
    /** Time between two periodic samples in milliseconds. */
    private readonly intervalMs: number;
    /** Wait before the final Postgres sample in milliseconds. */
    private readonly pgSettleMs: number;
    /** Wait function used before the final Postgres sample. */
    private readonly sleep: (ms: number) => Promise<void>;
    /** Problems found so far, copied into the figures by stop(). */
    private readonly warnings: string[] = [];
    /** Labels of the periodic failures that already added a warning. */
    private readonly periodicWarned = new Set<string>();
    /** Metrics at the start of the run. Undefined when the source is off or the start scrape failed. */
    private metricsBefore?: MetricsSnapshot;
    /** Largest JVM heap seen so far in bytes. */
    private heapPeak?: number;
    /** Resident memory of the MCP server at the start of the run. */
    private rssBefore?: number;
    /** Largest resident memory of the MCP server seen so far in bytes. */
    private rssPeak?: number;
    /** Postgres counters at the start of the run. */
    private pgBefore?: PgCounters;
    /** Interval that drives the periodic samples. */
    private timer?: NodeJS.Timeout;
    /** Periodic sample that is still running, so that samples never overlap. */
    private periodic?: Promise<void>;

    /**
     * @param options - sources to watch and the test seams
     */
    constructor(options: BackendWatchOptions) {
        const runner = options.runner ?? defaultRunner;
        this.metrics =
            options.metricsUrl === undefined ? undefined : new MetricsSampler(options.metricsUrl, options.fetcher);
        this.pg = options.pgStats === undefined ? undefined : new PgStats(options.pgStats, runner);
        this.rss = options.serverPid === undefined ? undefined : new ProcessRss(options.serverPid, runner);
        this.intervalMs = options.intervalMs ?? BackendWatch.DEFAULT_INTERVAL_MS;
        this.pgSettleMs = options.pgSettleMs ?? BackendWatch.DEFAULT_PG_SETTLE_MS;
        this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    }

    /**
     * True when at least one source is configured.
     */
    get enabled(): boolean {
        return this.metrics !== undefined || this.pg !== undefined || this.rss !== undefined;
    }

    /**
     * Takes the first sample of every configured source, then starts the periodic samples of the heap and the
     * resident memory. A failing source adds a warning and does not stop the others.
     */
    async start(): Promise<void> {
        const metrics = this.metrics;
        if (metrics !== undefined) {
            const snapshot = await this.attempt("metrics scrape", async () => snapshotOf(await metrics.scrape()));
            if (snapshot !== undefined) {
                this.metricsBefore = snapshot;
                this.heapPeak = snapshot.jvm.heapUsedBytes;
            }
        }
        const rss = this.rss;
        if (rss !== undefined) {
            this.rssBefore = await this.attempt("server rss", () => rss.read());
            this.rssPeak = this.rssBefore;
        }
        const pg = this.pg;
        if (pg !== undefined) {
            this.pgBefore = await this.attempt("postgres stats", () => pg.sample());
        }
        if (metrics !== undefined || rss !== undefined) {
            this.timer = setInterval(() => this.startPeriodic(), this.intervalMs);
            this.timer.unref();
        }
    }

    /**
     * Stops the periodic samples, waits for the Postgres settle time when Postgres is watched, takes the final samples
     * and returns the figures of the run.
     */
    async stop(): Promise<BackendFigures> {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.periodic;
        if (this.pg !== undefined && this.pgBefore !== undefined) {
            await this.sleep(this.pgSettleMs);
        }

        const figures: BackendFigures = { warnings: [] };

        const metrics = this.metrics;
        const metricsStart = this.metricsBefore;
        if (metrics !== undefined && metricsStart !== undefined) {
            const metricsEnd = await this.attempt("metrics scrape", async () => snapshotOf(await metrics.scrape()));
            if (metricsEnd !== undefined) {
                this.addMetricsFigures(figures, metricsStart, metricsEnd);
            }
        }

        const rss = this.rss;
        const rssStart = this.rssBefore;
        if (rss !== undefined && rssStart !== undefined) {
            const rssEnd = await this.attempt("server rss", () => rss.read());
            if (rssEnd !== undefined) {
                figures.serverRss = {
                    startBytes: rssStart,
                    endBytes: rssEnd,
                    peakBytes: Math.max(this.rssPeak ?? rssStart, rssStart, rssEnd),
                };
            }
        }

        const pg = this.pg;
        const pgStart = this.pgBefore;
        if (pg !== undefined && pgStart !== undefined) {
            const pgEnd = await this.attempt("postgres stats", () => pg.sample());
            if (pgEnd !== undefined) {
                const pgDelta = PgStats.delta(pgStart, pgEnd);
                figures.pg = pgDelta;
                if (figures.dbStatements === undefined && pgDelta.statements !== undefined) {
                    figures.dbStatements = pgDelta.statements;
                    figures.dbStatementsSource = "pg_stat_statements";
                }
            }
        }

        figures.warnings = [...this.warnings];
        return figures;
    }

    /**
     * Fills the figures that come from the backend metrics.
     *
     * @param figures - figures being built, changed in place
     * @param start - metrics at the start of the run
     * @param end - metrics at the end of the run
     */
    private addMetricsFigures(figures: BackendFigures, start: MetricsSnapshot, end: MetricsSnapshot): void {
        figures.metricsDelta = MetricsSampler.delta(start.totals, end.totals);
        const statements = MetricsSampler.dbStatements(figures.metricsDelta);
        if (statements !== undefined) {
            figures.dbStatements = statements;
            figures.dbStatementsSource = "metrics";
        }

        const startHeap = start.jvm.heapUsedBytes;
        const endHeap = end.jvm.heapUsedBytes;
        if (startHeap !== undefined && endHeap !== undefined) {
            figures.backendHeap = {
                startBytes: startHeap,
                endBytes: endHeap,
                peakBytes: Math.max(this.heapPeak ?? startHeap, startHeap, endHeap),
            };
            if (end.jvm.heapMaxBytes !== undefined) {
                figures.backendHeap.maxBytes = end.jvm.heapMaxBytes;
            }
        } else {
            this.warnings.push("metrics endpoint has no jvm_memory_bytes_used heap series");
        }

        const seconds = difference(start.jvm.gcSeconds, end.jvm.gcSeconds);
        const collections = difference(start.jvm.gcCount, end.jvm.gcCount);
        if (seconds !== undefined && collections !== undefined) {
            figures.gc = { seconds, collections };
        }
        const cpu = difference(start.jvm.cpuSeconds, end.jvm.cpuSeconds);
        if (cpu !== undefined) {
            figures.backendCpuSeconds = cpu;
        }
        const requests = difference(start.jvm.backendRequests, end.jvm.backendRequests);
        if (requests !== undefined) {
            figures.backendRequests = requests;
        }
        const mcp = difference(start.jvm.mcpCommands, end.jvm.mcpCommands);
        if (mcp !== undefined) {
            figures.mcpCommands = mcp;
        }
        const checkouts = difference(start.jvm.connectionCheckouts, end.jvm.connectionCheckouts);
        if (checkouts !== undefined) {
            figures.connectionCheckouts = checkouts;
        }
    }

    /**
     * Starts one periodic sample unless the previous one is still running.
     */
    private startPeriodic(): void {
        if (this.periodic !== undefined) {
            return;
        }
        this.periodic = this.samplePeriodic().finally(() => {
            this.periodic = undefined;
        });
    }

    /**
     * Takes one periodic sample of the heap and of the resident memory. Failures add at most one warning per source.
     */
    private async samplePeriodic(): Promise<void> {
        const metrics = this.metrics;
        if (metrics !== undefined && this.metricsBefore !== undefined) {
            const snapshot = await this.attempt("metrics scrape", async () => snapshotOf(await metrics.scrape()), true);
            const heap = snapshot?.jvm.heapUsedBytes;
            if (heap !== undefined) {
                this.heapPeak = Math.max(this.heapPeak ?? heap, heap);
            }
        }
        const rss = this.rss;
        if (rss !== undefined && this.rssBefore !== undefined) {
            const bytes = await this.attempt("server rss", () => rss.read(), true);
            if (bytes !== undefined) {
                this.rssPeak = Math.max(this.rssPeak ?? bytes, bytes);
            }
        }
    }

    /**
     * Runs one sample. A failure adds a warning that starts with the label and returns undefined.
     *
     * @param label - name of the source, used at the start of the warning, for example metrics scrape
     * @param action - the sample
     * @param periodic - true for the periodic samples, which add at most one warning per label
     */
    private async attempt<T>(label: string, action: () => Promise<T>, periodic = false): Promise<T | undefined> {
        try {
            return await action();
        } catch (error) {
            const message = `${label} failed: ${errorText(error)}`;
            if (!periodic) {
                this.warnings.push(message);
            } else if (!this.periodicWarned.has(label)) {
                this.periodicWarned.add(label);
                this.warnings.push(message);
            }
            return undefined;
        }
    }
}
