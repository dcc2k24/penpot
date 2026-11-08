import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { createLogger } from "../logger";
import type { PermitWait } from "./PermitGate";
import { ExportConcurrency } from "./ExportConcurrency";

/**
 * Takes one permit of a sorted set, as one step.
 *
 * KEYS[1]: the permit key. ARGV[1]: the member id. ARGV[2]: the limit. ARGV[3]: the lease in milliseconds.
 * Permits are scored by their expiry time. The clock is the Redis TIME, not the clock of the adapter, so adapters
 * with skewed clocks agree on which permits have expired. Returns 1 when the permit was taken, 0 when the set is full.
 */
const TAKE_SCRIPT = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now + lease, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], lease + 1000)
  return 1
end
return 0`;

/** The Redis calls that the permits need, behind an interface so that tests can use an in-memory fake. */
export interface ExportPermitStore {
    /**
     * Takes a permit of the key when fewer than the limit are held.
     *
     * @param key - the key of the permit set
     * @param member - a unique id of this permit
     * @param limit - permits that may be held at once
     * @param leaseMs - how long the permit stays held unless it is given back, in milliseconds
     * @returns true when the permit was taken, false when the set is full
     */
    take(key: string, member: string, limit: number, leaseMs: number): Promise<boolean>;
    /**
     * Gives a permit back.
     *
     * @param key - the key of the permit set
     * @param member - the id the permit was taken with
     */
    free(key: string, member: string): Promise<void>;
}

/** The Redis client with the take script registered as a command. */
type PermitClient = Redis & {
    exportPermitTake(key: string, member: string, limit: string, leaseMs: string): Promise<unknown>;
};

/**
 * Permits shared by all adapters that use one Redis, so that the renders of all of them stay under one cap.
 */
export interface SharedExportPermits {
    /**
     * Takes a shared permit, waiting for one within the budget of the wait.
     *
     * @param wait - the wait budget, and the signal that ends the wait
     * @returns a function that gives the permit back; it never throws
     * @throws Error with the busy text when the cap is still full at the end of the budget, or the signal's reason
     */
    acquire(wait: PermitWait): Promise<() => Promise<void>>;
}

/** Options of {@link RedisExportPermits}. */
export interface RedisExportPermitsOptions {
    /** Redis key of the permit set. */
    key?: string;
    /** Logs a warning. The default writes to the log of this module. */
    warn?: (error: unknown, message: string) => void;
    /** Longest render the permits must cover, in milliseconds. The default is the render timeout of the exports. */
    renderTimeoutMs?: number;
}

const logger = createLogger("RedisExportPermits");

/** Busy text of a wait that runs out. It is the text that PermitGate gives for the export gate. */
function busyError(waitMs: number): Error {
    return new Error(`export is busy, retry later: no slot was free for ${waitMs / 1000} seconds.`);
}

/** Resolves after the given time, or rejects with the signal's reason when the signal fires first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(signal.reason);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Caps the renders across all adapters that share one Redis.
 *
 * Each permit is a member of one sorted set, scored by its expiry, so a crashed adapter frees its permits when
 * they expire. A caller that finds the set full polls with a short backoff until the wait budget ends.
 *
 * When Redis cannot answer, the shared permit is neither granted nor refused: the call goes on with the
 * in-process permits only. A busy refusal happens only when Redis answers and the cap is still full.
 */
export class RedisExportPermits implements SharedExportPermits {
    /** Default Redis key of the permit set. */
    public static readonly DEFAULT_KEY = "penpot.mcp.export.permits";
    /** First pause between two takes, in milliseconds. */
    private static readonly FIRST_PAUSE_MS = 20;
    /** Longest pause between two takes, in milliseconds. */
    private static readonly MAX_PAUSE_MS = 250;
    /** Random extra pause, up to this many milliseconds, so waiting callers do not poll in step. */
    private static readonly JITTER_MS = 10;

    private readonly key: string;
    private readonly warn: (error: unknown, message: string) => void;
    /** Number of calls that went on without the shared permit because Redis failed. */
    private fallbacks = 0;
    /** True while takes fail, so the warning is logged once per outage. */
    private failing = false;
    /** True while gives-back fail, so their warning is logged once per outage. */
    private releaseFailing = false;

    /**
     * Creates the shared permits.
     *
     * @param store - the Redis calls
     * @param limit - renders at once across all adapters; a positive whole number
     * @param leaseMs - how long a permit stays held if its holder never gives it back, in milliseconds
     * @param options - the key and the warning hook
     * @throws Error when the limit is not a positive whole number, or the lease is not a positive number, or the
     *   lease is shorter than the render timeout: a permit that expires during its render lets another render in
     */
    constructor(
        private readonly store: ExportPermitStore,
        private readonly limit: number,
        private readonly leaseMs: number,
        options: RedisExportPermitsOptions = {}
    ) {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error("The shared export permit limit must be a positive whole number.");
        }
        if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
            throw new Error("The shared export permit lease must be a positive number of milliseconds.");
        }
        const renderTimeoutMs = options.renderTimeoutMs ?? ExportConcurrency.RENDER_TIMEOUT_MS;
        if (leaseMs < renderTimeoutMs) {
            throw new Error(
                `The shared export permit lease (${leaseMs} ms) must cover the render timeout (${renderTimeoutMs} ms).`
            );
        }
        this.key = options.key ?? RedisExportPermits.DEFAULT_KEY;
        this.warn = options.warn ?? ((error, message) => logger.warn(error, message));
    }

    /** Number of calls that went on without the shared permit because Redis failed. */
    public get fallbackCount(): number {
        return this.fallbacks;
    }

    /** False while the last take failed, so that a shared cap that is not in force shows on `/metrics`. */
    public get available(): boolean {
        return !this.failing;
    }

    /**
     * Takes a shared permit, polling Redis until one is free or the wait budget is spent.
     *
     * @param wait - the wait budget, and the signal that ends the wait
     * @returns a function that gives the permit back; it never throws. It does nothing when the call went on
     *   without a shared permit because Redis failed.
     * @throws Error with the busy text when the cap is still full at the end of the budget, or the signal's reason
     */
    public async acquire(wait: PermitWait): Promise<() => Promise<void>> {
        if (wait.signal?.aborted === true) {
            throw wait.signal.reason;
        }
        const deadline = Date.now() + wait.waitMs;
        let pauseMs = RedisExportPermits.FIRST_PAUSE_MS;
        for (;;) {
            const member = randomUUID();
            let taken: boolean;
            try {
                taken = await this.store.take(this.key, member, this.limit, this.leaseMs);
            } catch (error) {
                this.recordFailure(error);
                return async () => undefined;
            }
            this.failing = false;
            if (taken) {
                return () => this.free(member);
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw busyError(wait.waitMs);
            }
            const jitterMs = Math.floor(Math.random() * RedisExportPermits.JITTER_MS);
            await pause(Math.min(pauseMs + jitterMs, remainingMs), wait.signal);
            pauseMs = Math.min(pauseMs * 2, RedisExportPermits.MAX_PAUSE_MS);
        }
    }

    /**
     * Gives a permit back. A failure is logged once per outage and ignored, since the lease frees the permit.
     *
     * @param member - the id the permit was taken with
     */
    private async free(member: string): Promise<void> {
        try {
            await this.store.free(this.key, member);
            this.releaseFailing = false;
        } catch (error) {
            if (!this.releaseFailing) {
                this.releaseFailing = true;
                this.warn(error, "Could not give back a shared export permit; its lease will free it");
            }
        }
    }

    /**
     * Counts a failed take and logs the first one of an outage.
     *
     * @param error - the error of the take
     */
    private recordFailure(error: unknown): void {
        this.fallbacks++;
        if (!this.failing) {
            this.failing = true;
            this.warn(error, "Redis export permits unavailable, using the in-process permits only");
        }
    }
}

/**
 * The ioredis-backed permit store.
 *
 * The client is created like the one of the rate limiter: a dead Redis fails a command at once, and a hung one
 * gives up after the command timeout. The take script is registered with defineCommand, so ioredis sends its
 * SHA1 with EVALSHA and falls back to EVAL by itself when Redis answers NOSCRIPT.
 */
export class RedisExportPermitStore implements ExportPermitStore {
    private readonly client: PermitClient;
    /** Settles when the first connection attempt succeeds or fails. */
    private readonly firstAttempt: Promise<void>;

    /**
     * Creates a store on the given Redis.
     *
     * @param redisUri - Redis connection URI (`redis:` or `rediss:`)
     */
    constructor(redisUri: string) {
        this.client = new Redis(redisUri, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: 2000,
            commandTimeout: 2000,
        }) as PermitClient;
        this.client.defineCommand("exportPermitTake", { numberOfKeys: 1, lua: TAKE_SCRIPT });
        // failed commands report the error to their caller, so the connection error needs no listener of its own
        this.client.on("error", () => undefined);
        // the first take waits for the first connection attempt, since queuing is off and would fail it
        this.firstAttempt = new Promise<void>((resolve) => {
            this.client.once("ready", () => resolve());
            this.client.once("error", () => resolve());
        });
    }

    /**
     * Takes a permit with the Lua script.
     *
     * @param key - the key of the permit set
     * @param member - a unique id of this permit
     * @param limit - permits that may be held at once
     * @param leaseMs - lease in milliseconds
     * @returns true when the permit was taken
     */
    public async take(key: string, member: string, limit: number, leaseMs: number): Promise<boolean> {
        await this.firstAttempt;
        const reply = await this.client.exportPermitTake(key, member, String(limit), String(leaseMs));
        return reply === 1;
    }

    /**
     * Gives a permit back with ZREM.
     *
     * @param key - the key of the permit set
     * @param member - the id the permit was taken with
     */
    public async free(key: string, member: string): Promise<void> {
        await this.client.zrem(key, member);
    }

    /** Closes the Redis connection. Call it when the store is no longer used. */
    public async close(): Promise<void> {
        try {
            await this.client.quit();
        } catch {
            // a client that never connected cannot quit, so drop it
            this.client.disconnect();
        }
    }
}
