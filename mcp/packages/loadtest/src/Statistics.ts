/** Latency figures of one set of calls, in milliseconds. */
export interface LatencySummary {
    /** Number of samples. */
    count: number;
    /** Median, nearest-rank. */
    p50: number;
    /** 95th percentile, nearest-rank. */
    p95: number;
    /** 99th percentile, nearest-rank. */
    p99: number;
    /** Largest sample. */
    max: number;
    /** False when the sample count is too small for that percentile. */
    reliable: PercentileReliability;
}

/** Whether each percentile rests on enough samples. */
export interface PercentileReliability {
    p50: boolean;
    p95: boolean;
    p99: boolean;
}

/**
 * Fewest samples a percentile needs before it is reported as measured. With fewer, the nearest-rank value is
 * one of the largest samples and says little about the tail.
 */
export const MIN_SAMPLES: Readonly<Record<keyof PercentileReliability, number>> = {
    p50: 20,
    p95: 200,
    p99: 200,
};

/**
 * Tells which percentiles a sample count supports.
 *
 * @param count - number of samples the percentiles rest on
 */
export function percentileReliability(count: number): PercentileReliability {
    return {
        p50: count >= MIN_SAMPLES.p50,
        p95: count >= MIN_SAMPLES.p95,
        p99: count >= MIN_SAMPLES.p99,
    };
}

/**
 * Nearest-rank percentile of samples that are already sorted in ascending order.
 *
 * @param sorted - samples in ascending order
 * @param percent - percentile from 0 to 100
 * @returns the sample at rank ceil(percent / 100 * n), or 0 when there are no samples
 */
export function percentile(sorted: readonly number[], percent: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    const rank = Math.ceil((percent / 100) * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[index];
}

/**
 * Collects latency samples and reports their percentiles.
 */
export class LatencyRecorder {
    private readonly samples: number[] = [];

    /**
     * Adds one sample.
     *
     * @param durationMs - duration of one call in milliseconds
     */
    add(durationMs: number): void {
        this.samples.push(durationMs);
    }

    /**
     * Number of samples collected so far.
     */
    get count(): number {
        return this.samples.length;
    }

    /**
     * Percentiles and maximum of the samples. An empty recorder reports zeros. A percentile with too few samples
     * is still given, but its reliable flag is false.
     */
    summary(): LatencySummary {
        const sorted = [...this.samples].sort((a, b) => a - b);
        return {
            count: sorted.length,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
            reliable: percentileReliability(sorted.length),
        };
    }
}

/**
 * Text printed after a percentile that rests on too few samples, or an empty string when it is reliable.
 *
 * @param name - which percentile
 * @param count - number of samples it rests on
 */
export function percentileNote(name: keyof PercentileReliability, count: number): string {
    return percentileReliability(count)[name] ? "" : ` (unreliable: ${count} samples, needs ${MIN_SAMPLES[name]})`;
}
