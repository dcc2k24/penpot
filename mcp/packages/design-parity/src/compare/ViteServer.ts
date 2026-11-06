import { createServer, type ViteDevServer } from "vite";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Host the app server listens on for the host side. Only the local machine can reach it. */
const HOST = "127.0.0.1";

/** Address the app server listens on in docker mode, so that the exporter container can reach it. */
const CONTAINER_LISTEN_HOST = "0.0.0.0";

/** Name the exporter container uses for the host machine. Vite must accept it in docker mode. */
const CONTAINER_HOST_NAME = "host.docker.internal";

/** Milliseconds the app server gets to answer before start gives up. */
const READY_TIMEOUT_MS = 30_000;

/** Milliseconds between two readiness checks. */
const READY_POLL_MS = 250;

/** Config file names that the app may keep in its own folder. */
const APP_CONFIG_NAMES: readonly string[] = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];

/**
 * Options of AppServer.start.
 */
export interface AppServerOptions {
    /**
     * "local" (default) listens on 127.0.0.1 only. "docker" listens on 0.0.0.0 and accepts the host name
     * host.docker.internal, so that a container can open the app.
     */
    host?: "local" | "docker";
}

/**
 * A running Vite dev server that serves the generated React app.
 */
export class AppServer {
    /** Base URL of the app for the host side, `http://127.0.0.1:<port>`. */
    readonly url: string;

    /**
     * Base URL of the app for a container, `http://host.docker.internal:<port>`. Set only in docker mode, else
     * undefined.
     */
    readonly containerUrl: string | undefined;

    private readonly server: ViteDevServer;

    /**
     * Creates the wrapper. Use AppServer.start() to get a running server.
     *
     * @param url - base URL of the running app for the host side
     * @param containerUrl - base URL for a container, or undefined outside docker mode
     * @param server - the Vite dev server behind the URLs
     */
    private constructor(url: string, containerUrl: string | undefined, server: ViteDevServer) {
        this.url = url;
        this.containerUrl = containerUrl;
        this.server = server;
    }

    /**
     * Starts a Vite dev server for the app in appDir and waits until it answers.
     *
     * When appDir holds its own vite.config.ts, vite.config.js or vite.config.mjs, Vite loads that
     * file (configFile is undefined). Otherwise the server runs without a config file (configFile is false).
     *
     * @param appDir - folder of the generated React app
     * @param options - host mode, see AppServerOptions (default local)
     * @returns the running server
     * @throws Error when the server does not answer within 30 seconds, after the server is closed
     */
    static async start(appDir: string, options: AppServerOptions = {}): Promise<AppServer> {
        const docker = options.host === "docker";
        const port = await findFreePort();
        const hasOwnConfig = APP_CONFIG_NAMES.some((name) => existsSync(join(appDir, name)));
        if (docker) {
            // Vite reads this variable when the server is created, so it must be set before createServer.
            process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = CONTAINER_HOST_NAME;
        }
        const server = await createServer({
            root: appDir,
            configFile: hasOwnConfig ? undefined : false,
            server: { host: docker ? CONTAINER_LISTEN_HOST : HOST, port, strictPort: true },
            logLevel: "warn",
            clearScreen: false,
        });
        await server.listen();
        const url = `http://${HOST}:${port}`;
        const answering = await waitUntilAnswering(url);
        if (!answering) {
            await server.close();
            throw new Error(`app server did not answer within ${READY_TIMEOUT_MS / 1000} seconds: ${url}`);
        }
        const containerUrl = docker ? `http://${CONTAINER_HOST_NAME}:${port}` : undefined;
        return new AppServer(url, containerUrl, server);
    }

    /**
     * Stops the Vite dev server.
     */
    async close(): Promise<void> {
        await this.server.close();
    }
}

/**
 * Finds a free TCP port on 127.0.0.1 by listening on port 0 and reading the port the system gave.
 * The probe server is closed before the port is returned, so the caller can bind it.
 *
 * @returns a port number that was free when the probe closed
 * @throws Error when the probe cannot read its own port
 */
function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(0, HOST, () => {
            const address = probe.address();
            if (address === null || typeof address === "string") {
                probe.close();
                reject(new Error("could not read the port of the probe server"));
                return;
            }
            const port = address.port;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Polls the URL until it answers with a status below 500, or until the timeout ends.
 * Connection errors on a single attempt are ignored, because the server may not listen yet.
 *
 * @param url - URL to poll
 * @returns true when the URL answered in time, false on timeout
 */
async function waitUntilAnswering(url: string): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            await response.body?.cancel();
            if (response.status < 500) {
                return true;
            }
        } catch {
            // the server is not answering yet; the next poll tries again
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return false;
}
