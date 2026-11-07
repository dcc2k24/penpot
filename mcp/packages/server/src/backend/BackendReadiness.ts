/**
 * Answers whether the backend can serve calls, for the `/readyz` endpoint.
 *
 * The check asks the backend's own readiness endpoint. The answer is kept for a few seconds, so a
 * flood of probes does not become a flood of backend calls.
 */
export class BackendReadiness {
    /** Time a probe answer is kept, in milliseconds. */
    public static readonly CACHE_MS = 5_000;

    private cached?: { ready: boolean; at: number };
    private inFlight?: Promise<boolean>;

    /**
     * Creates the check.
     *
     * @param probe - asks the backend and resolves to true when it is ready; a rejection counts as not ready
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        private readonly probe: () => Promise<boolean>,
        private readonly now: () => number = Date.now
    ) {}

    /** Resolves to true when the backend is ready. Concurrent callers share one probe. */
    public async isReady(): Promise<boolean> {
        if (this.cached && this.now() - this.cached.at < BackendReadiness.CACHE_MS) {
            return this.cached.ready;
        }
        this.inFlight ??= this.probe()
            .catch(() => false)
            .then((ready) => {
                this.cached = { ready, at: this.now() };
                this.inFlight = undefined;
                return ready;
            });
        return this.inFlight;
    }
}
