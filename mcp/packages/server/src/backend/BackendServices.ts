import type { PenpotBackend } from "../PenpotBackendClient";
import { createLogger } from "../logger";
import { ExportConcurrency } from "../utils/ExportConcurrency";
import { RedisExportPermitStore, RedisExportPermits } from "../utils/RedisExportPermits";
import { BackendSettings } from "./BackendSettings";
import { BackendTokenValidator } from "./BackendTokenValidator";
import type { ExporterClient } from "./ExporterClient";
import { FileWriteQueue } from "./FileWriteQueue";
import { RenderSessionCache } from "./RenderSessionCache";
import type { RateLimiter } from "./RateLimiter";
import { RedisRateLimiter } from "./RedisRateLimiter";
import { TokenRateLimiter } from "./TokenRateLimiter";
import { Prelude } from "../sandbox/Prelude";
import { SandboxRuntime } from "../sandbox/SandboxRuntime";
import { SandboxSessions } from "../sandbox/SandboxSessions";
import { SandboxSettings } from "../sandbox/SandboxSettings";
import { MemoryStorageStore, RedisStorageStore, type StorageLoad, type StorageStore } from "../sandbox/StorageStore";

/** One Redis client of the adapter and whether it reaches its server. */
export interface RedisClientState {
    /** Which client: the rate limiter, the sandbox storage or the export permits. */
    readonly client: "rate-limiter" | "storage" | "export-permits";
    /** True while the client reaches its server. */
    readonly up: boolean;
}

/**
 * Storage store that remembers whether its last load reached Redis, so that `/metrics` shows a storage outage.
 *
 * Loads are the reads that every shared call makes, so they tell an outage apart from a save that was refused
 * for its size. Every other method passes straight through.
 */
class ReachabilityStorageStore implements StorageStore {
    /** False after a load that Redis could not answer; true before any load and after one that it answered. */
    private reachable = true;

    /**
     * Wraps a store.
     *
     * @param inner - the store that does the work
     */
    constructor(private readonly inner: StorageStore) {}

    /** Whether other servers can read and write the same copies, as the wrapped store. */
    public get shared(): boolean {
        return this.inner.shared;
    }

    /** True when the last load reached Redis. */
    public get available(): boolean {
        return this.reachable;
    }

    /**
     * Reads the saved text of a key and records whether Redis answered.
     *
     * @param key - session key
     * @returns the answer of the wrapped store
     */
    public async load(key: string): Promise<StorageLoad> {
        const result = await this.inner.load(key);
        this.reachable = result.kind !== "unavailable";
        return result;
    }

    /**
     * Saves the text of a key.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns the answer of the wrapped store
     */
    public save(key: string, text: string): Promise<boolean> {
        return this.inner.save(key, text);
    }

    /**
     * Drops the saved text of a key.
     *
     * @param key - session key
     */
    public delete(key: string): Promise<void> {
        return this.inner.delete(key);
    }

    /** Drops every saved text that the wrapped store owns. */
    public clear(): void {
        this.inner.clear();
    }

    /** Releases the resources of the wrapped store. */
    public close(): Promise<void> {
        return this.inner.close();
    }
}

/**
 * The shared collaborators of every backend-mode tool: backend access, the exporter, render sessions,
 * token validation, rate limiting and write serialisation.
 *
 * This module pulls in the sandbox, so the server loads it only in backend mode.
 */
export class BackendServices {
    public readonly validator: BackendTokenValidator;
    public readonly rateLimiter: RateLimiter;
    /** Redis-backed limiter, or undefined when the limit is kept within this process. */
    public readonly redisLimiter: RedisRateLimiter | undefined;
    /** Store of the sandbox storage: shared through Redis when configured, else kept in this process. */
    private readonly storageStore: StorageStore;
    /** The Redis storage with its reachability, or undefined when the storage is kept in this process. */
    private readonly storageReach: ReachabilityStorageStore | undefined;
    public readonly writeQueue: FileWriteQueue;
    public readonly renderSessions: RenderSessionCache;
    public readonly sandboxes: SandboxSessions;
    /** Shared export permits, or undefined when the renders are capped per process only. */
    public readonly exportPermits: RedisExportPermits | undefined;
    /** Redis connection of the shared export permits, or undefined when the renders are capped per process only. */
    private readonly exportPermitStore: RedisExportPermitStore | undefined;

    /**
     * Creates the services around one backend and one exporter.
     *
     * @param backend - backend used by all tools
     * @param settings - rate limit configuration
     * @param exporter - exporter client that renders shapes
     * @param now - clock in milliseconds, injectable for tests
     * @param validator - token validator shared with the request gate, so both use one cache
     */
    constructor(
        public readonly backend: PenpotBackend,
        settings: BackendSettings,
        public readonly exporter: ExporterClient,
        now: () => number = Date.now,
        validator: BackendTokenValidator = new BackendTokenValidator(backend, now, settings.tokenCacheSeconds * 1000)
    ) {
        this.validator = validator;
        const localLimiter = new TokenRateLimiter(settings.rateLimitPerSecond, settings.rateLimitBurst, now);
        // with Redis the limit is shared by all instances; the local bucket judges during a Redis outage
        this.redisLimiter =
            settings.redisUri === undefined
                ? undefined
                : new RedisRateLimiter(
                      settings.redisUri,
                      settings.rateLimitPerSecond,
                      settings.rateLimitBurst,
                      localLimiter
                  );
        this.rateLimiter = this.redisLimiter ?? localLimiter;
        // with Redis the renders are capped across all adapters that share it; without it, the process cap alone applies
        if (settings.redisUri === undefined) {
            this.exportPermitStore = undefined;
            this.exportPermits = undefined;
        } else {
            this.exportPermitStore = new RedisExportPermitStore(settings.redisUri);
            this.exportPermits = new RedisExportPermits(
                this.exportPermitStore,
                settings.exportTotalPermits,
                ExportConcurrency.PERMIT_LEASE_MS
            );
            ExportConcurrency.setSharedPermits(this.exportPermits);
            createLogger("ExportShapeTool").info(
                "Max parallel exports (shared): %d across adapters sharing Redis",
                settings.exportTotalPermits
            );
        }
        this.writeQueue = new FileWriteQueue();
        this.renderSessions = new RenderSessionCache(backend, now);
        // the settings decide the worker mode; the runtime reads the environment only when they are not given
        const sandboxSettings = SandboxSettings.fromEnvironment(process.env);
        // Redis keeps the storage across adapters; the memory store is the fallback for a single adapter
        this.storageReach =
            settings.redisUri === undefined
                ? undefined
                : new ReachabilityStorageStore(new RedisStorageStore(settings.redisUri, sandboxSettings.idleEvictMs));
        this.storageStore =
            this.storageReach ??
            new MemoryStorageStore(sandboxSettings.maxSessions, sandboxSettings.idleEvictMs, Date.now);
        this.sandboxes = new SandboxSessions(
            sandboxSettings,
            () => SandboxRuntime.create(Prelude.build(), {}, sandboxSettings.workers),
            Date.now,
            this.storageStore
        );
        // idle sandbox runtimes are evicted by an unref'd timer, so the process can still exit.
        this.sandboxes.start();
    }

    /**
     * Reports whether each Redis client of this adapter reaches its server.
     *
     * @returns one state per configured client; empty without Redis
     */
    public redisClientStates(): RedisClientState[] {
        const states: RedisClientState[] = [];
        if (this.redisLimiter !== undefined) {
            states.push({ client: "rate-limiter", up: this.redisLimiter.available });
        }
        if (this.storageReach !== undefined) {
            states.push({ client: "storage", up: this.storageReach.available });
        }
        if (this.exportPermits !== undefined) {
            states.push({ client: "export-permits", up: this.exportPermits.available });
        }
        return states;
    }

    /** Closes the Redis connections of the rate limiter, the export permits and the storage, when they are open. */
    public async close(): Promise<void> {
        if (this.exportPermitStore !== undefined) {
            ExportConcurrency.setSharedPermits(undefined);
        }
        await Promise.all([this.redisLimiter?.close(), this.exportPermitStore?.close(), this.storageStore.close()]);
    }
}
