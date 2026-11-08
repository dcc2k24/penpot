import Redis from "ioredis";
import { createLogger } from "../logger";
import { STORAGE_LIMIT_BYTES } from "./SandboxWorkerProtocol";

/**
 * Result of a read of the store.
 *
 * - `value`: the key holds this text.
 * - `absent`: the key holds nothing, because it was never saved or it expired.
 * - `unavailable`: the read failed, so the store may hold a text that is not seen here.
 */
export type StorageLoad = { kind: "value"; text: string } | { kind: "absent" } | { kind: "unavailable" };

/**
 * Keeps the saved `storage` of sandbox sessions, as JSON text, by the key of the session.
 *
 * Every method is safe to call: a store never throws to its caller, because a failed save must not fail a call.
 */
export interface StorageStore {
    /** Whether other servers can read and write the same copies. A shared store is read before every call. */
    readonly shared: boolean;

    /**
     * Reads the saved text of a key.
     *
     * @param key - session key
     * @returns the saved text, or why there is none; a failed read is `unavailable`, not `absent`
     */
    load(key: string): Promise<StorageLoad>;

    /**
     * Saves the text of a key. A text above the storage limit is refused, and the previous copy stays.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns false when the text was refused or the write failed
     */
    save(key: string, text: string): Promise<boolean>;

    /**
     * Drops the saved text of a key.
     *
     * @param key - session key
     */
    delete(key: string): Promise<void>;

    /** Drops every saved text that this store owns. A shared store keeps its keys, which expire on their own. */
    clear(): void;

    /** Releases the resources of the store. */
    close(): Promise<void>;
}

/** Logger type shared by the stores. */
type StoreLogger = ReturnType<typeof createLogger>;

/**
 * Shared checks of the stores: the storage limit is enforced here, before any write.
 */
abstract class BoundedStorageStore implements StorageStore {
    /** Whether the refusal of an oversized text was already logged. */
    private refusalLogged = false;

    /**
     * Creates a store.
     *
     * @param log - logger of the store
     */
    protected constructor(protected readonly log: StoreLogger) {}

    abstract readonly shared: boolean;

    abstract load(key: string): Promise<StorageLoad>;

    abstract delete(key: string): Promise<void>;

    abstract clear(): void;

    abstract close(): Promise<void>;

    /**
     * Saves a text when it is within the storage limit.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns false when the text is above the limit, or the write failed
     */
    public async save(key: string, text: string): Promise<boolean> {
        if (Buffer.byteLength(text, "utf8") > STORAGE_LIMIT_BYTES) {
            if (!this.refusalLogged) {
                this.refusalLogged = true;
                this.log.warn("Sandbox storage above the %d byte limit was not saved", STORAGE_LIMIT_BYTES);
            }
            return false;
        }
        return this.write(key, text);
    }

    /**
     * Writes a text that is within the limit.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns true when the write succeeded
     */
    protected abstract write(key: string, text: string): Promise<boolean>;
}

/** One saved text with the instant after which it expires. */
interface MemoryEntry {
    /** Storage as JSON text. */
    readonly text: string;
    /** Instant after which the entry is gone, in milliseconds. */
    readonly expiresAt: number;
}

/**
 * Keeps the storage in this process. Entries expire after the time to live, and the oldest write is dropped
 * when the store holds more entries than its bound.
 */
export class MemoryStorageStore extends BoundedStorageStore {
    /** The copies live in this process only, so no other server changes them. */
    public readonly shared = false;
    private readonly entries = new Map<string, MemoryEntry>();

    /**
     * Creates an in-process store.
     *
     * @param maxEntries - most entries kept
     * @param ttlMs - time an entry lives after its last write, in milliseconds
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        private readonly maxEntries: number,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now
    ) {
        super(createLogger("MemoryStorageStore"));
    }

    /** Number of entries that have not expired. */
    public get size(): number {
        const current = this.now();
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.expiresAt > current) {
                count += 1;
            }
        }
        return count;
    }

    /**
     * Reads the text of a key.
     *
     * @param key - session key
     * @returns the text, or absent when there is none or it expired
     */
    public async load(key: string): Promise<StorageLoad> {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return { kind: "absent" };
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return { kind: "absent" };
        }
        return { kind: "value", text: entry.text };
    }

    /**
     * Drops a key.
     *
     * @param key - session key
     */
    public async delete(key: string): Promise<void> {
        this.entries.delete(key);
    }

    /** Drops every entry. */
    public clear(): void {
        this.entries.clear();
    }

    /** Nothing to release. */
    public async close(): Promise<void> {
        return;
    }

    /**
     * Stores a text, drops expired entries, and keeps the bound by dropping the oldest write.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns true
     */
    protected async write(key: string, text: string): Promise<boolean> {
        const current = this.now();
        for (const [other, entry] of this.entries) {
            if (entry.expiresAt <= current) {
                this.entries.delete(other);
            }
        }
        // a re-insert moves the key to the end, so the first key is always the oldest write.
        this.entries.delete(key);
        this.entries.set(key, { text, expiresAt: current + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done) {
                break;
            }
            this.entries.delete(oldest.value);
        }
        return true;
    }
}

/** Key prefix of the storage in Redis. */
const REDIS_KEY_PREFIX = "penpot.mcp.sandbox.storage.";

/**
 * Keeps the storage in Redis, so that every server that shares the Redis sees it. Each write refreshes the
 * time to live. Redis errors are logged once and do not reach the caller.
 */
export class RedisStorageStore extends BoundedStorageStore {
    /** Every server that uses this Redis shares the copies. */
    public readonly shared = true;
    private readonly client: Redis;
    /** Settles after the first connection attempt. */
    private readonly ready: Promise<void>;
    /** Whether the last Redis operation failed, so that the failure is logged once. */
    private failing = false;

    /**
     * Creates a Redis store.
     *
     * @param redisUri - Redis connection URI, such as `redis://host:6379`
     * @param ttlMs - time a saved text lives after its last write, in milliseconds
     */
    constructor(
        redisUri: string,
        private readonly ttlMs: number
    ) {
        super(createLogger("RedisStorageStore"));
        this.client = new Redis(redisUri, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: 2000,
            // a hung Redis must not hold a call's turn: the command fails and the call goes on without the store
            commandTimeout: 2000,
        });
        // without a listener, ioredis reports every connection error on the console.
        this.client.on("error", (error: Error) => this.fail("connection", error));
        // the offline queue is off, so an operation sent before the first connection would fail; wait for it instead
        this.ready = new Promise<void>((resolve) => {
            this.client.once("ready", () => resolve());
            this.client.once("error", () => resolve());
        });
    }

    /**
     * Resolves once the first connection attempt has succeeded or failed.
     *
     * @returns a promise that resolves after the first connection attempt
     */
    public whenReady(): Promise<void> {
        return this.ready;
    }

    /**
     * Reads the text of a key.
     *
     * @param key - session key
     * @returns the text, absent when there is none, or unavailable when Redis failed
     */
    public async load(key: string): Promise<StorageLoad> {
        try {
            await this.ready;
            const text = await this.client.get(REDIS_KEY_PREFIX + key);
            this.succeeded();
            return text === null ? { kind: "absent" } : { kind: "value", text };
        } catch (error) {
            this.fail("load", error);
            return { kind: "unavailable" };
        }
    }

    /**
     * Drops a key.
     *
     * @param key - session key
     */
    public async delete(key: string): Promise<void> {
        try {
            await this.ready;
            await this.client.del(REDIS_KEY_PREFIX + key);
            this.succeeded();
        } catch (error) {
            this.fail("delete", error);
        }
    }

    /** Does nothing: the keys are shared with other servers, and their time to live expires them. */
    public clear(): void {
        return;
    }

    /** Quits the Redis client, or disconnects it when quitting fails. */
    public async close(): Promise<void> {
        try {
            await this.client.quit();
        } catch {
            this.client.disconnect();
        }
    }

    /**
     * Writes a text with the time to live.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns true when Redis acknowledged the write
     */
    protected async write(key: string, text: string): Promise<boolean> {
        try {
            await this.ready;
            const reply = await this.client.set(REDIS_KEY_PREFIX + key, text, "PX", this.ttlMs);
            this.succeeded();
            return reply === "OK";
        } catch (error) {
            this.fail("save", error);
            return false;
        }
    }

    /** Clears the failure flag, so that the next failure is logged again. */
    private succeeded(): void {
        this.failing = false;
    }

    /**
     * Logs a failure once, until the next success.
     *
     * @param operation - what failed
     * @param error - the thrown value
     */
    private fail(operation: string, error: unknown): void {
        if (this.failing) {
            return;
        }
        this.failing = true;
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn("Sandbox storage %s failed on Redis: %s", operation, message);
    }
}
