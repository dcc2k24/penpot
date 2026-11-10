import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { createLogger } from "../logger";
import { BusyError, type PermitWait } from "./PermitGate";
import { ExportConcurrency } from "./ExportConcurrency";

/**
 * Takes one permit of a sorted set, as one step, in arrival order.
 *
 * KEYS[1]: the permit set. Scored by expiry, in the same format as before, so an older adapter on the same Redis
 * still respects the cap. KEYS[2]: the waiting callers, scored by the Redis time of their first take, so that
 * arrival order decides who gets a free permit; equal times order by member id. KEYS[3]: the same callers, scored
 * by the Redis time of their last take. A caller that has not asked for `stale` milliseconds is dropped, so a caller
 * that vanished cannot hold the head of the queue. A caller gets a permit only when its rank among the waiting
 * callers is below the number of free permits.
 *
 * ARGV[1]: the member id. ARGV[2]: the limit. ARGV[3]: the lease in milliseconds. ARGV[4]: the stale time in
 * milliseconds. The clock is the Redis TIME, not the clock of the adapter, so adapters with skewed clocks agree on
 * which permits have expired. Returns 1 when the permit was taken, 0 when the caller must wait.
 */
const TAKE_SCRIPT = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local member = ARGV[1]
local limit = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local stale = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local gone = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now - stale)
for _, m in ipairs(gone) do
  redis.call('ZREM', KEYS[2], m)
  redis.call('ZREM', KEYS[3], m)
end
if not redis.call('ZSCORE', KEYS[2], member) then
  redis.call('ZADD', KEYS[2], now, member)
end
redis.call('ZADD', KEYS[3], now, member)
local free = limit - redis.call('ZCARD', KEYS[1])
if free > 0 and redis.call('ZRANK', KEYS[2], member) < free then
  redis.call('ZREM', KEYS[2], member)
  redis.call('ZREM', KEYS[3], member)
  redis.call('ZADD', KEYS[1], now + lease, member)
  redis.call('PEXPIRE', KEYS[1], lease + 1000)
  return 1
end
redis.call('PEXPIRE', KEYS[2], stale + 1000)
redis.call('PEXPIRE', KEYS[3], stale + 1000)
return 0`;

/**
 * The keys of the waiting callers of a permit set.
 *
 * The braces are a Redis Cluster hash tag whose text equals the permit key, so the permit set and both waiter sets
 * land in one cluster slot.
 *
 * @param key - the key of the permit set
 * @returns the key of the waiting callers by arrival, and the key of their last takes
 */
export function waiterKeysOf(key: string): { waiters: string; seen: string } {
    return { waiters: `{${key}}:waiters`, seen: `{${key}}:seen` };
}

/** The Redis calls that the permits need, behind an interface so that tests can use an in-memory fake. */
export interface ExportPermitStore {
    /**
     * Takes a permit of the key when fewer than the limit are held and this caller is among the first waiting
     * callers. A refused caller is kept as waiting, in arrival order, as long as it asks again within `staleMs`.
     *
     * @param key - the key of the permit set
     * @param member - a unique id of this caller, the same for every take of one acquire
     * @param limit - permits that may be held at once
     * @param leaseMs - how long the permit stays held unless it is given back, in milliseconds
     * @param staleMs - how long a waiting caller may go without asking before it loses its place, in milliseconds
     * @returns true when the permit was taken, false when the caller must wait
     */
    take(key: string, member: string, limit: number, leaseMs: number, staleMs: number): Promise<boolean>;
    /**
     * Gives a permit back.
     *
     * @param key - the key of the permit set
     * @param member - the id the permit was taken with
     */
    free(key: string, member: string): Promise<void>;
    /**
     * Removes a waiting caller, so that it no longer holds its place in the queue.
     *
     * @param key - the key of the permit set
     * @param member - the id of the waiting caller
     */
    leave(key: string, member: string): Promise<void>;
}

/** The Redis client with the take script registered as a command. */
type PermitClient = Redis & {
    exportPermitTake(
        permitKey: string,
        waitersKey: string,
        seenKey: string,
        member: string,
        limit: string,
        leaseMs: string,
        staleMs: string
    ): Promise<unknown>;
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
    /** Number of shared permits this process holds at the moment. */
    readonly heldCount: number;
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
 * they expire. A caller that finds the set full waits in arrival order: it polls with a short backoff until the
 * wait budget ends, and the first waiting callers get a freed permit. An older adapter on the same Redis takes a free
 * permit without queuing, so the cap holds but the order does not until every adapter is upgraded.
 *
 * When Redis cannot answer, the shared permit is neither granted nor refused: the call goes on with the
 * in-process permits only. A busy refusal happens only when Redis answers and the cap is still full.
 */
export class RedisExportPermits implements SharedExportPermits {
    /** Default Redis key of the permit set. */
    public static readonly DEFAULT_KEY = "penpot.mcp.export.permits";
    /** First pause between two takes, in milliseconds. */
    private static readonly FIRST_PAUSE_MS = 20;
    /** Longest pause between two takes, in milliseconds. Short, so that waiting callers ask often enough. */
    private static readonly MAX_PAUSE_MS = 100;
    /** Random extra pause, up to this many milliseconds, so waiting callers do not poll in step. */
    private static readonly JITTER_MS = 10;
    /** A waiting caller that has not asked for this long loses its place, in milliseconds. */
    private static readonly WAITER_STALE_MS = 3_000;

    private readonly key: string;
    private readonly warn: (error: unknown, message: string) => void;
    /** Number of calls that went on without the shared permit because Redis failed. */
    private fallbacks = 0;
    /** True while takes fail, so the warning is logged once per outage. */
    private failing = false;
    /** True while gives-back fail, so their warning is logged once per outage. */
    private releaseFailing = false;
    /** Number of shared permits held by this process at the moment. */
    private held = 0;

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

    /** Number of shared permits this process holds at the moment. */
    public get heldCount(): number {
        return this.held;
    }

    /**
     * Takes a shared permit, polling Redis until one is free or the wait budget is spent.
     *
     * One member id serves every take of this call, so the caller keeps its place in the queue between polls.
     *
     * @param wait - the wait budget, and the signal that ends the wait
     * @returns a function that gives the permit back; it never throws, and a second call does nothing. It does
     *   nothing when the call went on without a shared permit because Redis failed.
     * @throws BusyError when the cap is still full at the end of the budget, or the signal's reason
     */
    public async acquire(wait: PermitWait): Promise<() => Promise<void>> {
        if (wait.signal?.aborted === true) {
            throw wait.signal.reason;
        }
        const member = randomUUID();
        const deadline = Date.now() + wait.waitMs;
        let pauseMs = RedisExportPermits.FIRST_PAUSE_MS;
        for (;;) {
            let taken: boolean;
            try {
                taken = await this.store.take(
                    this.key,
                    member,
                    this.limit,
                    this.leaseMs,
                    RedisExportPermits.WAITER_STALE_MS
                );
            } catch (error) {
                this.recordFailure(error);
                return async () => undefined;
            }
            this.failing = false;
            if (taken) {
                this.held += 1;
                let released = false;
                return async () => {
                    if (!released) {
                        released = true;
                        await this.free(member);
                    }
                };
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                await this.leave(member);
                throw new BusyError("export", wait.waitMs);
            }
            const jitterMs = Math.floor(Math.random() * RedisExportPermits.JITTER_MS);
            try {
                await pause(Math.min(pauseMs + jitterMs, remainingMs), wait.signal);
            } catch (error) {
                await this.leave(member);
                throw error;
            }
            pauseMs = Math.min(pauseMs * 2, RedisExportPermits.MAX_PAUSE_MS);
        }
    }

    /**
     * Gives a permit back. A failure is logged once per outage and ignored, since the lease frees the permit.
     * The count of held permits drops at once, whether or not Redis removes the permit.
     *
     * @param member - the id the permit was taken with
     */
    private async free(member: string): Promise<void> {
        this.held -= 1;
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
     * Removes a waiting caller from the queue. A failure is ignored, since a caller that stops asking loses its
     * place by itself.
     *
     * @param member - the id of the waiting caller
     */
    private async leave(member: string): Promise<void> {
        try {
            await this.store.leave(this.key, member);
        } catch {
            // the stale rule drops the caller, so a failed leave needs no other action
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
        this.client.defineCommand("exportPermitTake", { numberOfKeys: 3, lua: TAKE_SCRIPT });
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
     * @param member - a unique id of this caller
     * @param limit - permits that may be held at once
     * @param leaseMs - lease in milliseconds
     * @param staleMs - time without a take after which a waiting caller loses its place, in milliseconds
     * @returns true when the permit was taken
     */
    public async take(key: string, member: string, limit: number, leaseMs: number, staleMs: number): Promise<boolean> {
        await this.firstAttempt;
        const waiters = waiterKeysOf(key);
        const reply = await this.client.exportPermitTake(
            key,
            waiters.waiters,
            waiters.seen,
            member,
            String(limit),
            String(leaseMs),
            String(staleMs)
        );
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

    /**
     * Removes a waiting caller from both waiter sets.
     *
     * @param key - the key of the permit set
     * @param member - the id of the waiting caller
     */
    public async leave(key: string, member: string): Promise<void> {
        const waiters = waiterKeysOf(key);
        await this.client.multi().zrem(waiters.waiters, member).zrem(waiters.seen, member).exec();
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
