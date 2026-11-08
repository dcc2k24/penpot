import { monitorEventLoopDelay } from "node:perf_hooks";
import type { MetricFamily } from "./AdapterMetrics";

/** Nanoseconds in one second, to convert the event loop delays. */
const NANOSECONDS_PER_SECOND = 1e9;

/**
 * Reports the memory and the event loop delay of this process, for `/metrics`.
 *
 * The event loop delay is sampled only between `start()` and `stop()`. Each call to `families()` reads the
 * window since the previous call and then clears it, so every scrape sees its own window.
 */
export class ProcessMetrics {
    /** Samples the event loop delay. Created once; enabled by `start()`. */
    private readonly eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({
        resolution: 20,
    });

    /** Starts sampling the event loop delay. Calling it again has no effect. */
    public start(): void {
        this.eventLoopDelay.enable();
    }

    /** Stops sampling the event loop delay. Calling it again has no effect. */
    public stop(): void {
        this.eventLoopDelay.disable();
    }

    /**
     * Reads the process metrics and clears the event loop window.
     *
     * @returns the resident memory, the heap in use and the event loop delay p50, p99 and max, in seconds
     */
    public families(): MetricFamily[] {
        const { rss, heapUsed } = process.memoryUsage();
        const window = this.eventLoopDelay;
        // an empty window has no delays to report, so it reads as 0 rather than the histogram's defaults
        const hasSamples = window.count > 0;
        const lag = (nanoseconds: number) => (hasSamples ? nanoseconds / NANOSECONDS_PER_SECOND : 0);
        const samples = {
            p50: lag(window.percentile(50)),
            p99: lag(window.percentile(99)),
            max: lag(window.max),
        };
        window.reset();
        return [
            {
                name: "process_resident_memory_bytes",
                help: "Resident memory of the process, in bytes.",
                type: "gauge",
                samples: [{ value: rss }],
            },
            {
                name: "nodejs_heap_used_bytes",
                help: "Used V8 heap of the process, in bytes.",
                type: "gauge",
                samples: [{ value: heapUsed }],
            },
            {
                name: "nodejs_eventloop_lag_p50_seconds",
                help: "Event loop delay p50 since the last scrape, in seconds.",
                type: "gauge",
                samples: [{ value: samples.p50 }],
            },
            {
                name: "nodejs_eventloop_lag_p99_seconds",
                help: "Event loop delay p99 since the last scrape, in seconds.",
                type: "gauge",
                samples: [{ value: samples.p99 }],
            },
            {
                name: "nodejs_eventloop_lag_max_seconds",
                help: "Event loop delay max since the last scrape, in seconds.",
                type: "gauge",
                samples: [{ value: samples.max }],
            },
        ];
    }
}
