import type { PenpotBackend } from "../PenpotBackendClient";
import { BackendSettings } from "./BackendSettings";
import { BackendTokenValidator } from "./BackendTokenValidator";
import type { ExporterClient } from "./ExporterClient";
import { FileWriteQueue } from "./FileWriteQueue";
import { RenderSessionCache } from "./RenderSessionCache";
import { TokenRateLimiter } from "./TokenRateLimiter";
import { Prelude } from "../sandbox/Prelude";
import { SandboxRuntime } from "../sandbox/SandboxRuntime";
import { SandboxSessions } from "../sandbox/SandboxSessions";
import { SandboxSettings } from "../sandbox/SandboxSettings";

/**
 * The shared collaborators of every backend-mode tool: backend access, the exporter, render sessions,
 * token validation, rate limiting and write serialisation.
 */
export class BackendServices {
    public readonly validator: BackendTokenValidator;
    public readonly rateLimiter: TokenRateLimiter;
    public readonly writeQueue: FileWriteQueue;
    public readonly renderSessions: RenderSessionCache;
    public readonly sandboxes: SandboxSessions;

    /**
     * Creates the services around one backend and one exporter.
     *
     * @param backend - backend used by all tools
     * @param settings - rate limit configuration
     * @param exporter - exporter client that renders shapes
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        public readonly backend: PenpotBackend,
        settings: BackendSettings,
        public readonly exporter: ExporterClient,
        now: () => number = Date.now
    ) {
        this.validator = new BackendTokenValidator(backend, now);
        this.rateLimiter = new TokenRateLimiter(settings.rateLimitPerSecond, settings.rateLimitBurst, now);
        this.writeQueue = new FileWriteQueue();
        this.renderSessions = new RenderSessionCache(backend, now);
        this.sandboxes = new SandboxSessions(SandboxSettings.fromEnvironment(process.env), () =>
            SandboxRuntime.create(Prelude.build())
        );
        // idle sandbox runtimes are evicted by an unref'd timer, so the process can still exit.
        this.sandboxes.start();
    }
}
