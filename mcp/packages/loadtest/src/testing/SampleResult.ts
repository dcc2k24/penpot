import { RESULT_SCHEMA_VERSION, type RunResult } from "../ResultFile.js";

/**
 * Builds a complete result document for tests. Fields can be overridden one by one.
 *
 * @param overrides - fields to replace in the sample
 */
export function sampleResult(overrides: Partial<RunResult> = {}): RunResult {
    return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        scenario: "sample",
        description: "sample scenario",
        commit: "0123456789abcdef",
        startedAt: "2026-11-04T09:00:00.000Z",
        finishedAt: "2026-11-04T09:01:00.000Z",
        durationMs: 60_000,
        agents: 2,
        iterations: 2,
        rateLimitPerSecond: null,
        machineSpec: {
            platform: "linux",
            arch: "x64",
            cpuModel: "Test CPU",
            cpuCores: 8,
            totalMemoryBytes: 34_359_738_368,
            nodeVersion: "v24.14.1",
        },
        calls: 20,
        errors: 0,
        bytes: 4096,
        p50: 100,
        p95: 200,
        p99: 300,
        max: 400,
        heap: { startBytes: 1_000_000, endBytes: 1_200_000, peakBytes: 1_500_000 },
        rss: { startBytes: 50_000_000, endBytes: 52_000_000, peakBytes: 55_000_000 },
        steps: [
            {
                name: "1. first",
                tool: "whoami",
                calls: 10,
                errors: 0,
                bytes: 1024,
                p50: 90,
                p95: 180,
                p99: 250,
                max: 300,
            },
            {
                name: "2. second",
                tool: "apply_operations",
                calls: 10,
                errors: 0,
                bytes: 3072,
                p50: 110,
                p95: 220,
                p99: 350,
                max: 400,
            },
        ],
        errorSamples: [],
        warnings: [],
        ...overrides,
    };
}
