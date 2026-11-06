import { execFileSync } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { type MachineSpec, type MemoryFigures } from "./ResultFile.js";

/**
 * Describes the machine and the source tree that a run measures.
 */
export class SystemInfo {
    /** Root directory of this package, used to find the git checkout. */
    private static readonly PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

    /**
     * Collects the machine spec of the load driver.
     *
     * @param note - optional free text, for example Docker limits, Postgres settings or the JVM heap size
     */
    static machineSpec(note?: string): MachineSpec {
        const cores = cpus();
        const spec: MachineSpec = {
            platform: platform(),
            arch: arch(),
            cpuModel: cores[0]?.model ?? "unknown",
            cpuCores: cores.length,
            totalMemoryBytes: totalmem(),
            nodeVersion: process.version,
        };
        if (note !== undefined && note.trim() !== "") {
            spec.note = note.trim();
        }
        return spec;
    }

    /**
     * Returns the commit that HEAD points to, or "unknown" when git is missing or the code is not a checkout.
     *
     * @param directory - directory inside the checkout, defaults to this package
     */
    static commit(directory: string = SystemInfo.PACKAGE_ROOT): string {
        try {
            return execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: directory,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            return "unknown";
        }
    }
}

/**
 * Samples heap and resident memory of this process while a run is in progress.
 */
export class ProcessMemorySampler {
    private static readonly INTERVAL_MS = 1000;
    private timer: NodeJS.Timeout | undefined;
    private startHeap = 0;
    private startRss = 0;
    private peakHeap = 0;
    private peakRss = 0;

    /**
     * Takes the first sample and starts sampling once per second.
     */
    start(): void {
        const usage = process.memoryUsage();
        this.startHeap = usage.heapUsed;
        this.startRss = usage.rss;
        this.peakHeap = usage.heapUsed;
        this.peakRss = usage.rss;
        this.timer = setInterval(() => this.sample(), ProcessMemorySampler.INTERVAL_MS);
        this.timer.unref();
    }

    /**
     * Stops sampling and returns the figures of the run.
     */
    stop(): { heap: MemoryFigures; rss: MemoryFigures } {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        const usage = process.memoryUsage();
        this.sample();
        return {
            heap: { startBytes: this.startHeap, endBytes: usage.heapUsed, peakBytes: this.peakHeap },
            rss: { startBytes: this.startRss, endBytes: usage.rss, peakBytes: this.peakRss },
        };
    }

    /**
     * Records the current values and keeps the peaks.
     */
    private sample(): void {
        const usage = process.memoryUsage();
        this.peakHeap = Math.max(this.peakHeap, usage.heapUsed);
        this.peakRss = Math.max(this.peakRss, usage.rss);
    }
}
