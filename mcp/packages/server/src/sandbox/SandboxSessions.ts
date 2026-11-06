import type { SandboxRuntime } from "./SandboxRuntime";
import type { SandboxSettings } from "./SandboxSettings";

/** Runtime of one key, with the time it was last used. */
interface SessionEntry {
    /** Runtime that serves the key. */
    readonly runtime: SandboxRuntime;
    /** Instant of the last acquisition, in milliseconds. */
    lastUsedAt: number;
}

/**
 * Keeps one sandbox runtime per key, such as the token fingerprint of an MCP session.
 *
 * A runtime is created on first use, replaced once it is disposed, poisoned or spent, and disposed when it stays
 * idle for longer than the idle eviction time. When the registry holds more runtimes than the session limit, the
 * least recently used ones are disposed first. A disposed runtime is always dropped from the registry, because a
 * kept reference would keep its WebAssembly memory alive.
 */
export class SandboxSessions {
    /** Interval between idle sweeps, in milliseconds. */
    private static readonly SWEEP_INTERVAL_MS = 60_000;

    private readonly entries = new Map<string, SessionEntry>();
    private readonly creations = new Map<string, Promise<SandboxRuntime>>();
    private timer: ReturnType<typeof setInterval> | undefined = undefined;
    private isClosed = false;

    /**
     * Creates a session registry.
     *
     * @param settings - sandbox settings, which provide the idle eviction time
     * @param createRuntime - factory of new runtimes
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        public readonly settings: SandboxSettings,
        private readonly createRuntime: () => Promise<SandboxRuntime>,
        private readonly now: () => number = Date.now
    ) {}

    /** Number of keys that hold a runtime. */
    public get size(): number {
        return this.entries.size;
    }

    /**
     * Returns the live runtime of a key, creating it when none is usable.
     *
     * Concurrent calls for one key share a single creation.
     *
     * @param key - session key, such as the SHA-256 hex of the MCP token
     * @returns the runtime of the key
     * @throws Error when the registry is disposed
     */
    public async acquire(key: string): Promise<SandboxRuntime> {
        if (this.isClosed) {
            throw new Error("The sandbox sessions are disposed.");
        }
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            if (this.isUsable(existing.runtime)) {
                existing.lastUsedAt = this.now();
                return existing.runtime;
            }
            existing.runtime.dispose();
            this.entries.delete(key);
        }
        return this.creations.get(key) ?? this.createEntry(key);
    }

    /**
     * Disposes and forgets the runtime of a key.
     *
     * @param key - session key to discard
     */
    public discard(key: string): void {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return;
        }
        entry.runtime.dispose();
        this.entries.delete(key);
    }

    /**
     * Disposes and forgets the runtime of a key when it is spent: idle, with a WebAssembly memory above the
     * recycle size. The next acquisition creates a fresh runtime, so the data in `storage` is lost.
     *
     * @param key - session key to check after a call
     * @returns true when the runtime was disposed
     */
    public recycleIfSpent(key: string): boolean {
        const entry = this.entries.get(key);
        if (entry === undefined || !entry.runtime.spent) {
            return false;
        }
        entry.runtime.dispose();
        this.entries.delete(key);
        return true;
    }

    /**
     * Disposes the runtimes that have been idle for longer than the eviction time, and those that are no longer usable.
     *
     * @returns the number of runtimes disposed
     */
    public sweepIdle(): number {
        const current = this.now();
        let disposed = 0;
        for (const [key, entry] of this.entries) {
            if (current - entry.lastUsedAt > this.settings.idleEvictMs || !this.isUsable(entry.runtime)) {
                entry.runtime.dispose();
                this.entries.delete(key);
                disposed += 1;
            }
        }
        return disposed;
    }

    /** Starts the periodic idle sweep. The timer does not keep the process alive. */
    public start(): void {
        if (this.timer !== undefined) {
            return;
        }
        this.timer = setInterval(() => this.sweepIdle(), SandboxSessions.SWEEP_INTERVAL_MS);
        this.timer.unref();
    }

    /** Stops the periodic idle sweep. */
    public stop(): void {
        if (this.timer === undefined) {
            return;
        }
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Disposes every runtime, stops the idle sweep, and refuses later acquisitions. */
    public dispose(): void {
        this.stop();
        this.isClosed = true;
        for (const entry of this.entries.values()) {
            entry.runtime.dispose();
        }
        this.entries.clear();
    }

    /**
     * Creates the runtime of a key and records it, sharing the creation with concurrent callers.
     *
     * @param key - session key
     * @returns the new runtime
     */
    private createEntry(key: string): Promise<SandboxRuntime> {
        const creation = this.createRuntime()
            .then((runtime) => {
                if (this.isClosed) {
                    runtime.dispose();
                    throw new Error("The sandbox sessions are disposed.");
                }
                this.entries.set(key, { runtime, lastUsedAt: this.now() });
                this.evictOverflow(key);
                return runtime;
            })
            .finally(() => {
                this.creations.delete(key);
            });
        this.creations.set(key, creation);
        return creation;
    }

    /**
     * Disposes the least recently used runtimes while the registry holds more than the session limit.
     *
     * Ties go to the entry inserted first. The runtime that was just created is never evicted.
     *
     * @param keep - key of the runtime that was just created
     */
    private evictOverflow(keep: string): void {
        while (this.entries.size > this.settings.maxSessions) {
            let victimKey: string | undefined = undefined;
            let victim: SessionEntry | undefined = undefined;
            for (const [key, entry] of this.entries) {
                if (key !== keep && (victim === undefined || entry.lastUsedAt < victim.lastUsedAt)) {
                    victimKey = key;
                    victim = entry;
                }
            }
            if (victimKey === undefined || victim === undefined) {
                return;
            }
            victim.runtime.dispose();
            this.entries.delete(victimKey);
        }
    }

    /**
     * Tells whether a runtime can serve calls.
     *
     * @param runtime - runtime to check
     * @returns false when the runtime was disposed, poisoned or spent
     */
    private isUsable(runtime: SandboxRuntime): boolean {
        return !runtime.disposed && !runtime.poisoned && !runtime.spent;
    }
}
