import { createLogger } from "../logger";
import { CallSlots } from "./CallSlots";
import type { GuestRuntime } from "./GuestRuntime";
import type { SandboxSettings } from "./SandboxSettings";

/** Runtime of one key, with the time it was last used. */
interface SessionEntry {
    /** Runtime that serves the key. */
    readonly runtime: GuestRuntime;
    /** Instant of the last acquisition, in milliseconds. */
    lastUsedAt: number;
}

/** Storage of a key whose runtime was disposed, kept for the runtime that replaces it. */
interface SavedStorage {
    /** Storage as JSON text. */
    readonly text: string;
    /** Instant the runtime that saved it was last used, in milliseconds. */
    readonly lastUsedAt: number;
}

/** Outcome of one `execute_code` call, counted in {@link SandboxSessions.stats}. */
export type CallOutcome = "ok" | "failed" | "interrupted" | "discarded" | "busy";

/** Counters of the sandbox registry, read by the metrics endpoint. */
export interface SandboxStats {
    /** Runtimes held now. */
    live: number;
    /** Runtimes created since start. */
    created: number;
    /** Runtimes disposed since start, for any reason. */
    disposed: number;
    /** Runtimes disposed because their WebAssembly memory grew past the recycle size. */
    memoryRecycles: number;
    /** Calls stopped by a CPU or wall-clock limit, or by the watchdog. */
    interrupted: number;
    /** Calls by outcome. */
    calls: Record<CallOutcome, number>;
}

/**
 * Keeps one sandbox runtime per key, such as the token fingerprint of an MCP session.
 *
 * A runtime is created on first use, replaced once it is disposed, poisoned or spent, and disposed when it stays
 * idle for longer than the idle eviction time. When the registry holds more runtimes than the session limit, the
 * least recently used ones are disposed first. A disposed runtime is always dropped from the registry, because a
 * kept reference would keep its WebAssembly memory alive.
 *
 * The storage of a runtime is saved when the runtime is disposed, and the runtime that replaces it starts with that
 * storage. The saved storage expires after the idle eviction time, as the runtime does, and {@link stop} drops it.
 *
 * The registry also holds one turn per key: a key runs one script at a time, with a short queue, so that one
 * token cannot take every call slot of the server.
 */
export class SandboxSessions {
    /** Interval between idle sweeps, in milliseconds. */
    private static readonly SWEEP_INTERVAL_MS = 60_000;
    /** Calls of one key that may wait behind the running one. */
    private static readonly TURN_QUEUE = 2;

    private readonly entries = new Map<string, SessionEntry>();
    private readonly creations = new Map<string, Promise<GuestRuntime>>();
    private readonly turns = new Map<string, CallSlots>();
    private readonly storages = new Map<string, SavedStorage>();
    private readonly log = createLogger("SandboxSessions");
    private timer: ReturnType<typeof setInterval> | undefined = undefined;
    private isClosed = false;
    /** Counts the stops, so that a runtime that is still being created is disposed when it arrives. */
    private generation = 0;
    private readonly counters = {
        created: 0,
        disposed: 0,
        memoryRecycles: 0,
        interrupted: 0,
        calls: { ok: 0, failed: 0, interrupted: 0, discarded: 0, busy: 0 } as Record<CallOutcome, number>,
    };

    /**
     * Creates a session registry.
     *
     * @param settings - sandbox settings, which provide the idle eviction time
     * @param createRuntime - factory of new runtimes
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        public readonly settings: SandboxSettings,
        private readonly createRuntime: () => Promise<GuestRuntime>,
        private readonly now: () => number = Date.now
    ) {}

    /** Number of keys whose storage is saved for their next runtime. */
    public get savedStorageCount(): number {
        return this.storages.size;
    }

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
    public async acquire(key: string): Promise<GuestRuntime> {
        if (this.isClosed) {
            throw new Error("The sandbox sessions are disposed.");
        }
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            if (this.isUsable(existing.runtime)) {
                existing.lastUsedAt = this.now();
                return existing.runtime;
            }
            this.retire(key, existing.runtime, existing.lastUsedAt);
            this.entries.delete(key);
        }
        return this.creations.get(key) ?? this.createEntry(key);
    }

    /**
     * Takes the turn of a key: one running call per key, with a short queue behind it.
     *
     * The turn is taken before the global call slot, so a key that sends many calls cannot hold every slot.
     *
     * @param key - session key
     * @returns the function that gives the turn back, which the caller must call once the call ends
     * @throws Error when the queue of the key is full, or the turn does not come within the wait limit
     */
    public async acquireTurn(key: string): Promise<() => void> {
        let turn = this.turns.get(key);
        if (turn === undefined) {
            turn = new CallSlots(1, this.settings.slotWaitMs, SandboxSessions.TURN_QUEUE);
            this.turns.set(key, turn);
        }
        const current = turn;
        try {
            const release = await current.acquire();
            return () => {
                release();
                this.dropTurnIfIdle(key, current);
            };
        } catch (error) {
            this.dropTurnIfIdle(key, current);
            throw error;
        }
    }

    /**
     * Counts the outcome of one call.
     *
     * @param outcome - how the call ended
     */
    public recordOutcome(outcome: CallOutcome): void {
        this.counters.calls[outcome] += 1;
        if (outcome === "interrupted") {
            this.counters.interrupted += 1;
        }
    }

    /**
     * Returns the counters and the live count of the registry.
     *
     * @returns a copy of the counters
     */
    public stats(): SandboxStats {
        return {
            live: this.entries.size,
            created: this.counters.created,
            disposed: this.counters.disposed,
            memoryRecycles: this.counters.memoryRecycles,
            interrupted: this.counters.interrupted,
            calls: { ...this.counters.calls },
        };
    }

    /**
     * Disposes and forgets the runtime of a key. Its storage is kept for the next runtime of the key.
     *
     * @param key - session key to discard
     */
    public discard(key: string): void {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return;
        }
        this.retire(key, entry.runtime, entry.lastUsedAt);
        this.entries.delete(key);
    }

    /**
     * Disposes and forgets the runtime of a key when it is spent: idle, with a WebAssembly memory above the
     * recycle size. The next acquisition creates a fresh runtime, which starts with the storage of the spent one.
     *
     * @param key - session key to check after a call
     * @returns true when the runtime was disposed
     */
    public recycleIfSpent(key: string): boolean {
        const entry = this.entries.get(key);
        if (entry === undefined || !entry.runtime.spent) {
            return false;
        }
        this.counters.memoryRecycles += 1;
        this.log.info("Sandbox runtime recycled: its memory grew to %d bytes", entry.runtime.wasmMemoryBytes);
        this.retire(key, entry.runtime, entry.lastUsedAt);
        this.entries.delete(key);
        return true;
    }

    /**
     * Disposes the runtimes that have been idle for longer than the eviction time, and those that are no longer usable.
     * Saved storage that has been idle for longer than the eviction time is dropped too.
     *
     * @returns the number of runtimes disposed
     */
    public sweepIdle(): number {
        const current = this.now();
        let disposed = 0;
        for (const [key, entry] of this.entries) {
            if (current - entry.lastUsedAt > this.settings.idleEvictMs || !this.isUsable(entry.runtime)) {
                this.retire(key, entry.runtime, entry.lastUsedAt);
                this.entries.delete(key);
                disposed += 1;
            }
        }
        for (const [key, saved] of this.storages) {
            if (current - saved.lastUsedAt > this.settings.idleEvictMs) {
                this.storages.delete(key);
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

    /**
     * Stops the periodic idle sweep and disposes every runtime, which terminates every worker. A runtime that is still
     * being created is disposed as soon as it arrives. The saved storage is dropped too. The registry stays open, so a
     * later acquisition creates a fresh runtime.
     */
    public stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.generation += 1;
        for (const [key, entry] of this.entries) {
            this.retire(key, entry.runtime, entry.lastUsedAt);
        }
        this.entries.clear();
        this.storages.clear();
    }

    /** Disposes every runtime, stops the idle sweep, and refuses later acquisitions. */
    public dispose(): void {
        this.stop();
        this.isClosed = true;
    }

    /**
     * Creates the runtime of a key and records it, sharing the creation with concurrent callers. The runtime starts
     * with the storage that its predecessor saved, if any.
     *
     * @param key - session key
     * @returns the new runtime
     */
    private createEntry(key: string): Promise<GuestRuntime> {
        const generation = this.generation;
        const creation = this.createRuntime()
            .then((runtime) => {
                this.counters.created += 1;
                if (this.isClosed || generation !== this.generation) {
                    runtime.dispose();
                    this.counters.disposed += 1;
                    throw new Error(
                        this.isClosed ? "The sandbox sessions are disposed." : "The sandbox sessions were stopped."
                    );
                }
                const saved = this.storages.get(key);
                if (saved !== undefined) {
                    runtime.restoreStorage(saved.text);
                    this.storages.delete(key);
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
            this.retire(victimKey, victim.runtime, victim.lastUsedAt);
            this.entries.delete(victimKey);
        }
    }

    /**
     * Disposes a runtime, counts it, and saves its storage for the next runtime of the key.
     *
     * @param key - session key of the runtime
     * @param runtime - runtime to dispose; a runtime that is already disposed is not counted again
     * @param lastUsedAt - instant the runtime was last used, which sets when its saved storage expires
     */
    private retire(key: string, runtime: GuestRuntime, lastUsedAt: number): void {
        if (!runtime.disposed) {
            this.counters.disposed += 1;
        }
        const text = runtime.storageSnapshot;
        runtime.dispose();
        if (text !== undefined) {
            this.storages.set(key, { text, lastUsedAt });
            this.boundStorages();
        }
    }

    /**
     * Drops the least recently used saved storage while more than the session limit is saved.
     *
     * Saved storage is kept for the runtime that replaces a disposed one, so the number kept is bounded like the
     * number of runtimes.
     */
    private boundStorages(): void {
        while (this.storages.size > this.settings.maxSessions) {
            let victimKey: string | undefined = undefined;
            let victim: SavedStorage | undefined = undefined;
            for (const [key, saved] of this.storages) {
                if (victim === undefined || saved.lastUsedAt < victim.lastUsedAt) {
                    victimKey = key;
                    victim = saved;
                }
            }
            if (victimKey === undefined) {
                return;
            }
            this.storages.delete(victimKey);
        }
    }

    /**
     * Removes the turn of a key once nothing runs or waits on it.
     *
     * @param key - session key
     * @param turn - the turn that the caller used
     */
    private dropTurnIfIdle(key: string, turn: CallSlots): void {
        if (turn.running === 0 && turn.queued === 0 && this.turns.get(key) === turn) {
            this.turns.delete(key);
        }
    }

    /**
     * Tells whether a runtime can serve calls.
     *
     * @param runtime - runtime to check
     * @returns false when the runtime was disposed, poisoned or spent
     */
    private isUsable(runtime: GuestRuntime): boolean {
        return !runtime.disposed && !runtime.poisoned && !runtime.spent;
    }
}
