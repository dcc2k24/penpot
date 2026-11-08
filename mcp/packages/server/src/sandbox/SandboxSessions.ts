import { createHash } from "node:crypto";
import { createLogger } from "../logger";
import { CallSlots } from "./CallSlots";
import type { GuestRuntime } from "./GuestRuntime";
import { MemoryStorageStore, type StorageLoad, type StorageStore } from "./StorageStore";
import type { SandboxSettings } from "./SandboxSettings";

/** Runtime of one key, with the time it was last used and the storage that the store holds for it. */
interface SessionEntry {
    /** Runtime that serves the key. */
    readonly runtime: GuestRuntime;
    /** Instant of the last acquisition, in milliseconds. */
    lastUsedAt: number;
    /** Hash of the storage text that the store holds, as this runtime knows it: its last save or restore. */
    storageHash: string | undefined;
    /** Set while the store could not be read. This runtime then neither saves nor is trusted to save. */
    storageUnverified: boolean;
}

/** Outcome of one `execute_code` call, counted in {@link SandboxSessions.stats}. */
export type CallOutcome = "ok" | "failed" | "interrupted" | "discarded" | "busy";

/** Note given to the caller of a call whose storage could not be read, so that the call did not save it. */
export const STORAGE_UNAVAILABLE_NOTICE =
    "sandbox storage could not be read from the shared store, so this call ran on this " +
    "process's own copy, which may be stale, and did not save its storage";

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
 * Hashes a storage text, so that the registry can tell whether the store holds the same copy without keeping it.
 *
 * @param text - storage as JSON text
 * @returns the SHA-256 hex digest of the text
 */
function textHash(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Keeps one sandbox runtime per key, such as the token fingerprint of an MCP session.
 *
 * A runtime is created on first use, replaced once it is disposed, poisoned or spent, and disposed when it stays
 * idle for longer than the idle eviction time. When the registry holds more runtimes than the session limit, the
 * least recently used ones are disposed first. A disposed runtime is always dropped from the registry, because a
 * kept reference would keep its WebAssembly memory alive.
 *
 * The storage of a runtime is saved after each call, and when the runtime is disposed. The runtime that replaces it
 * starts with the saved storage. The {@link StorageStore} keeps the saved copies and expires them. A shared store
 * can be written by another server, so before each call the registry reads the copy and restores it when it differs
 * from the one this runtime last saved or restored.
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
    /** Notes for the next call of a key, such as an unreadable store. Taken once by {@link takeStorageNotice}. */
    private readonly notices = new Map<string, string>();
    /** Saves that have not finished yet, so that {@link flushStorage} can wait for them. */
    private readonly pendingSaves = new Set<Promise<void>>();
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
     * @param settings - sandbox settings, which provide the session limit and the idle eviction time
     * @param createRuntime - factory of new runtimes
     * @param now - clock in milliseconds, injectable for tests
     * @param store - keeps the saved storage of the keys; by default, an in-process store with the same bounds
     */
    constructor(
        public readonly settings: SandboxSettings,
        private readonly createRuntime: () => Promise<GuestRuntime>,
        private readonly now: () => number = Date.now,
        private readonly store: StorageStore = new MemoryStorageStore(settings.maxSessions, settings.idleEvictMs, now)
    ) {}

    /**
     * Number of keys whose storage is saved for their next runtime. Counted for the in-process store only;
     * a shared store does not report its size, so this is 0 for it.
     */
    public get savedStorageCount(): number {
        return this.store instanceof MemoryStorageStore ? this.store.size : 0;
    }

    /** Number of keys that hold a runtime. */
    public get size(): number {
        return this.entries.size;
    }

    /**
     * Returns the live runtime of a key, creating it when none is usable. With a shared store, the saved storage of
     * the key is read first and restored when it differs from the copy this runtime last saved or restored.
     *
     * Concurrent calls for one key share a single creation.
     *
     * @param key - session key, such as the SHA-256 hex of the MCP token
     * @returns the runtime of the key
     * @throws Error when the registry is disposed, or stopped while the storage is read
     */
    public async acquire(key: string): Promise<GuestRuntime> {
        if (this.isClosed) {
            throw new Error("The sandbox sessions are disposed.");
        }
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            if (this.isUsable(existing.runtime)) {
                existing.lastUsedAt = this.now();
                return this.store.shared ? this.reloadStorage(key, existing) : existing.runtime;
            }
            this.retire(key, existing);
            this.entries.delete(key);
        }
        return this.creations.get(key) ?? this.createEntry(key);
    }

    /**
     * Takes the turn of a key: one running call per key, with a short queue behind it.
     *
     * The turn is taken before the global call slot, so a key that sends many calls cannot hold every slot.
     * The returned release saves the storage of the runtime of the key before it gives the turn to the next call,
     * so that the next call reads the new copy.
     *
     * @param key - session key
     * @returns the function that gives the turn back, which the caller must await once the call ends
     * @throws Error when the queue of the key is full, or the turn does not come within the wait limit
     */
    public async acquireTurn(key: string): Promise<() => Promise<void>> {
        let turn = this.turns.get(key);
        if (turn === undefined) {
            turn = new CallSlots(1, this.settings.slotWaitMs, SandboxSessions.TURN_QUEUE);
            this.turns.set(key, turn);
        }
        const current = turn;
        try {
            const release = await current.acquire();
            return async () => {
                try {
                    await this.saveStorage(key);
                } finally {
                    release();
                    this.dropTurnIfIdle(key, current);
                }
            };
        } catch (error) {
            this.dropTurnIfIdle(key, current);
            throw error;
        }
    }

    /**
     * Saves the storage of the live runtime of a key to the store after a call. The text is saved even when it is
     * unchanged, because the write refreshes the time to live of the copy. Does nothing when the key holds no
     * runtime, the runtime keeps no storage, or the store could not be read. The store does not throw, so this does not either.
     *
     * @param key - session key
     */
    public async saveStorage(key: string): Promise<void> {
        const entry = this.entries.get(key);
        if (entry === undefined || entry.storageUnverified) {
            return;
        }
        const text = entry.runtime.storageSnapshot;
        if (text === undefined) {
            return;
        }
        await this.persist(key, entry, text);
    }

    /**
     * Waits for the saves that are in flight. Tests use it to read the store after a call.
     *
     * @returns a promise that resolves when the saves started so far have finished
     */
    public async flushStorage(): Promise<void> {
        await Promise.all([...this.pendingSaves]);
    }

    /**
     * Takes the note for the last call of a key about its storage, and clears it.
     *
     * @param key - session key
     * @returns the note, or undefined when there is none
     */
    public takeStorageNotice(key: string): string | undefined {
        const notice = this.notices.get(key);
        this.notices.delete(key);
        return notice;
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
        this.retire(key, entry);
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
        this.retire(key, entry);
        this.entries.delete(key);
        return true;
    }

    /**
     * Disposes the runtimes that have been idle for longer than the eviction time, and those that are no longer usable.
     * The saved storage expires in the store.
     *
     * @returns the number of runtimes disposed
     */
    public sweepIdle(): number {
        const current = this.now();
        let disposed = 0;
        for (const [key, entry] of this.entries) {
            if (current - entry.lastUsedAt > this.settings.idleEvictMs || !this.isUsable(entry.runtime)) {
                this.retire(key, entry);
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

    /**
     * Saves the storage of every live runtime, waits for the saves, and then disposes every runtime. Runtimes whose
     * storage could not be read are not saved. Call it when the server stops.
     *
     * @returns a promise that resolves when the last storage is in the store and the runtimes are disposed
     */
    public async shutdown(): Promise<void> {
        await Promise.all([...this.entries.keys()].map((key) => this.saveStorage(key)));
        await this.flushStorage();
        this.dispose();
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
            this.retire(key, entry);
        }
        this.entries.clear();
        this.notices.clear();
        this.store.clear();
    }

    /** Disposes every runtime, stops the idle sweep, and refuses later acquisitions. */
    public dispose(): void {
        this.stop();
        this.isClosed = true;
    }

    /**
     * Reads the saved storage of a key before a call, when the store is shared, and restores it when it differs from
     * the copy this runtime last saved or restored.
     *
     * @param key - session key
     * @param entry - entry of the key, whose runtime is about to run a call
     * @returns the runtime of the entry
     * @throws Error when the registry was stopped while the storage was read
     */
    private async reloadStorage(key: string, entry: SessionEntry): Promise<GuestRuntime> {
        const generation = this.generation;
        const loaded = await this.store.load(key);
        if (this.isClosed || generation !== this.generation) {
            throw this.stoppedError();
        }
        // the entry may have been dropped while the storage was read; the acquisition starts again.
        if (this.entries.get(key) !== entry || !this.isUsable(entry.runtime)) {
            return this.acquire(key);
        }
        this.applyLoaded(key, entry, loaded);
        return entry.runtime;
    }

    /**
     * Creates the runtime of a key and records it, sharing the creation with concurrent callers. The runtime starts
     * with the storage saved for the key, if any.
     *
     * @param key - session key
     * @returns the new runtime
     */
    private createEntry(key: string): Promise<GuestRuntime> {
        const generation = this.generation;
        const creation = this.createRuntime()
            .then(async (runtime) => {
                this.counters.created += 1;
                if (this.isClosed || generation !== this.generation) {
                    runtime.dispose();
                    this.counters.disposed += 1;
                    throw this.stoppedError();
                }
                const loaded = await this.store.load(key);
                // a stop may arrive while the storage loads.
                if (this.isClosed || generation !== this.generation) {
                    runtime.dispose();
                    this.counters.disposed += 1;
                    throw this.stoppedError();
                }
                const entry: SessionEntry = {
                    runtime,
                    lastUsedAt: this.now(),
                    storageHash: undefined,
                    storageUnverified: false,
                };
                this.applyLoaded(key, entry, loaded);
                this.entries.set(key, entry);
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
     * Applies the result of a read of the store to the runtime of a key.
     *
     * An unreadable store leaves the runtime as it is, marks it unverified, and records a note for the call. A
     * readable copy is restored when its hash differs from the one this runtime knows.
     *
     * @param key - session key
     * @param entry - entry of the key
     * @param loaded - result of the read
     */
    private applyLoaded(key: string, entry: SessionEntry, loaded: StorageLoad): void {
        if (loaded.kind === "unavailable") {
            entry.storageUnverified = true;
            this.notices.set(key, STORAGE_UNAVAILABLE_NOTICE);
            return;
        }
        entry.storageUnverified = false;
        this.notices.delete(key);
        if (loaded.kind === "absent") {
            entry.storageHash = undefined;
            return;
        }
        const hash = textHash(loaded.text);
        if (hash !== entry.storageHash) {
            entry.runtime.restoreStorage(loaded.text);
            entry.storageHash = hash;
        }
    }

    /**
     * Builds the error of a creation that ran into a stop.
     *
     * @returns the error that the caller of the acquisition gets
     */
    private stoppedError(): Error {
        return new Error(this.isClosed ? "The sandbox sessions are disposed." : "The sandbox sessions were stopped.");
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
            this.retire(victimKey, victim);
            this.entries.delete(victimKey);
        }
    }

    /**
     * Disposes a runtime, counts it, and saves its storage for the next runtime of the key when the store needs it.
     *
     * @param key - session key of the runtime
     * @param entry - entry of the runtime to dispose; a runtime that is already disposed is not counted again
     */
    private retire(key: string, entry: SessionEntry): void {
        if (!entry.runtime.disposed) {
            this.counters.disposed += 1;
        }
        const text = this.pendingText(entry);
        entry.runtime.dispose();
        if (text !== undefined) {
            void this.persist(key, entry, text);
        }
    }

    /**
     * Tells which storage text of an entry still has to be saved.
     *
     * @param entry - entry to check
     * @returns the text to save, or undefined when nothing must be saved: the runtime keeps no storage, its copy is
     *   the one the store holds, or the store could not be read
     */
    private pendingText(entry: SessionEntry): string | undefined {
        if (entry.storageUnverified) {
            return undefined;
        }
        const text = entry.runtime.storageSnapshot;
        if (text === undefined || textHash(text) === entry.storageHash) {
            return undefined;
        }
        return text;
    }

    /**
     * Saves a text in the store and tracks the save until it finishes. The entry records the hash of the text once the
     * store has acknowledged it.
     *
     * The store is called before this returns, so a later load sees the text even before the save completes.
     *
     * @param key - session key
     * @param entry - entry whose storage the text is
     * @param text - storage as JSON text
     * @returns a promise that resolves when the save finishes
     */
    private persist(key: string, entry: SessionEntry, text: string): Promise<void> {
        const hash = textHash(text);
        const save = this.store.save(key, text).then(
            (saved) => {
                if (saved) {
                    entry.storageHash = hash;
                }
            },
            () => undefined
        );
        this.pendingSaves.add(save);
        void save.finally(() => {
            this.pendingSaves.delete(save);
        });
        return save;
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
