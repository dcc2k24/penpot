import type { ServerContext } from "@modelcontextprotocol/server";
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    McpServer,
    type McpHttpHandler,
    originValidationResponse,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type {
    Express,
    NextFunction,
    Request as ExpressRequest,
    RequestHandler,
    Response as ExpressResponse,
} from "express";
import { z } from "zod";
import { AsyncLocalStorage } from "async_hooks";
import { ExecuteCodeTool } from "./tools/ExecuteCodeTool";
import { PluginBridge } from "./PluginBridge";
import { RedisBridge } from "./RedisBridge";
import { ConfigurationLoader } from "./ConfigurationLoader";
import { PenpotBackendClient } from "./PenpotBackendClient";
import { SubmitFeedbackTool } from "./tools/SubmitFeedbackTool";
import { createLogger } from "./logger";
import { Tool } from "./Tool";
import { HighLevelOverviewTool } from "./tools/HighLevelOverviewTool";
import { PenpotApiInfoTool } from "./tools/PenpotApiInfoTool";
import { ExportShapeTool } from "./tools/ExportShapeTool";
import { ImportImageTool } from "./tools/ImportImageTool";
import { CljsReplTool } from "./tools/dev/CljsReplTool";
import { ImportPenpotFileTool } from "./tools/dev/ImportPenpotFileTool";
import { CljsCompilerOutputTool } from "./tools/dev/CljsCompilerOutputTool";
import { CljCheckParentheses } from "./tools/dev/CljCheckParentheses";
import { ReadTaigaIssueTool } from "./tools/dev/ReadTaigaIssueTool";
import { NreplClient } from "./NreplClient";
import { ReplServer } from "./ReplServer";
import { ApiDocs } from "./ApiDocs";
import { McpAuthentication, type McpAuthenticationResult, RequestTokenCheck } from "./McpAuthentication";
import { BackendSettings } from "./backend/BackendSettings";
import { BackendTokenValidator } from "./backend/BackendTokenValidator";
import { AdapterMetrics } from "./backend/AdapterMetrics";
import { BackendReadiness } from "./backend/BackendReadiness";
import { withDispatcher } from "./backend/ConnectionPools";
import { TokenDigest } from "./backend/TokenDigest";
import { BodyLimit } from "./utils/BodyLimit";
import { ExportDirectory } from "./utils/ExportDirectory";
import type { BackendServices } from "./backend/BackendServices";
import type { ToolCallRecord, ToolAnnotations } from "./Tool";
import type { ProgressReporter } from "./backend/CallContext";
import type { Dispatcher } from "undici";

/**
 * Session context for request-scoped data.
 */
export interface SessionContext {
    userToken?: string;
}

/** The modes of the server, selected by PENPOT_MCP_MODE. */
const MCP_MODES = ["bridge", "backend", "both"] as const;

/**
 * A server mode: `bridge` (plugin tools only), `backend` (backend tools only) or `both`.
 */
export type McpMode = (typeof MCP_MODES)[number];

/** Host names that count as loopback, for the DNS rebinding checks. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** Time the HTTP server waits for open requests before it closes their connections, in milliseconds. */
const HTTP_CLOSE_DEADLINE_MS = 10_000;

/** Time the readiness probe waits for the backend, in milliseconds. */
const READINESS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Reports whether a socket address is a loopback address: an IPv4 address in 127.0.0.0/8, IPv6 `::1`, or the
 * IPv4 form of either.
 *
 * @param address - the remote address of a socket, or undefined when it is not known
 */
export function isLoopbackAddress(address: string | undefined): boolean {
    if (address === undefined) {
        return false;
    }
    const plain = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
    return plain === "::1" || /^127./.test(plain);
}

/** Headers that a reverse proxy adds to the requests it forwards. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

/**
 * Reports whether a request comes from this machine itself and was not forwarded by a proxy. A proxy on this
 * machine connects from loopback too, so the forwarding headers count against the request.
 *
 * @param req - the incoming request
 */
function isLoopbackClient(req: ExpressRequest): boolean {
    const forwarded = FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
    return !forwarded && isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Indicates whether a value names a known server mode.
 *
 * @param value - the value to check
 */
function isMcpMode(value: string): value is McpMode {
    return (MCP_MODES as readonly string[]).includes(value);
}

/**
 * Reads a TCP port from an environment variable.
 *
 * @param env - the environment to read
 * @param name - the variable name, named in the error
 * @param fallback - the port used when the variable is unset or blank
 * @throws Error naming the variable when the value is not a whole number from 0 to 65535
 */
export function readPortVariable(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value > 65535) {
        throw new Error(`${name} must be a port number from 0 to 65535 (got "${raw}").`);
    }
    return value;
}

/**
 * Holds information about a registered tool, including its instance, name, and configuration.
 */
class ToolInfo {
    constructor(
        public readonly instance: Tool<any>,
        public readonly name: string,
        public readonly config: { description: string; inputSchema: z.ZodObject<z.ZodRawShape> }
    ) {}
}

/** What the gate in front of `/mcp` learned about a request. */
interface RequestAuth {
    /** The MCP token of the request, when one was sent. */
    userToken: string | undefined;
    /** True when the request may use the large body limit: its token was accepted. */
    authenticated: boolean;
}

/** The authentication of each request, keyed by its response. */
const requestAuthOf = new WeakMap<ExpressResponse, RequestAuth>();

/**
 * Indicates whether developer tools may be registered for the current server mode.
 */
export function shouldRegisterDeveloperTools(isDevEnv: boolean, isMultiUserMode: boolean): boolean {
    return isDevEnv && !isMultiUserMode;
}

/**
 * Indicates whether the REPL server may be started for the current server mode.
 *
 * The REPL server never starts in multi-user mode, even when explicitly
 * enabled, mirroring the developer tools policy.
 */
export function shouldStartReplServer(isReplEnabled: boolean, isMultiUserMode: boolean): boolean {
    return isReplEnabled && !isMultiUserMode;
}

/**
 * Splits tool names into the plain names and the plugin bridge names, each sorted.
 *
 * @param names - the registered tool names
 * @param bridgeNames - the names that the plugin bridge tools carry in `both` mode
 * @returns the plain names and the bridge names, in alphabetical order
 */
export function partitionToolNames(
    names: readonly string[],
    bridgeNames: readonly string[]
): { plain: string[]; bridge: string[] } {
    const sorted = [...names].sort();
    return {
        plain: sorted.filter((name) => !bridgeNames.includes(name)),
        bridge: sorted.filter((name) => bridgeNames.includes(name)),
    };
}

/**
 * Builds a web `Request` from a Node request, so that the SDK's Host and Origin checks can read it.
 *
 * @param req - the incoming request
 * @returns the web request, or undefined when a header cannot be represented
 */
function webRequestOf(req: IncomingMessage): Request | undefined {
    try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) {
                headers.append(name, item);
            }
        }
        return new Request(`http://localhost${req.url ?? "/"}`, { method: "GET", headers });
    } catch {
        return undefined;
    }
}

export class PenpotMcpServer {
    /**
     * Determines whether the server is running in a Penpot development
     * environment, based on the given environment variables.
     *
     * Returns ``true`` only when ``PENPOT_MCP_DEVENV`` is ``"true"``.
     */
    public static isDevEnvEnabled(env: Record<string, string | undefined>): boolean {
        return env.PENPOT_MCP_DEVENV === "true";
    }

    /**
     * Determines whether the REPL server should be enabled.
     *
     * If ``PENPOT_MCP_REPL_ENABLE`` is set, its value controls the result
     * (``"true"`` enables, any other value disables). When the variable is
     * not set, the result falls back to {@link isDevEnvEnabled}.
     */
    public static isReplEnabled(env: Record<string, string | undefined>): boolean {
        if (env.PENPOT_MCP_REPL_ENABLE !== undefined) {
            return env.PENPOT_MCP_REPL_ENABLE === "true";
        }
        return PenpotMcpServer.isDevEnvEnabled(env);
    }

    /**
     * Resolves the server mode from the environment.
     *
     * The mode is `bridge` unless PENPOT_MCP_MODE says otherwise. Setting PENPOT_MCP_BACKEND_URI alone does
     * not change the mode, so an upgrade does not rename the plugin tools behind the operator's back.
     *
     * @param env - the environment to read
     * @throws Error when the mode is unknown, or when backend or both mode has no PENPOT_MCP_BACKEND_URI
     */
    public static resolveMode(env: Record<string, string | undefined>): McpMode {
        const backendUri = env.PENPOT_MCP_BACKEND_URI?.trim();
        const requested = env.PENPOT_MCP_MODE?.trim().toLowerCase();
        if (requested === undefined || requested === "") {
            return "bridge";
        }
        if (!isMcpMode(requested)) {
            throw new Error(`PENPOT_MCP_MODE must be one of ${MCP_MODES.join(", ")} (got "${env.PENPOT_MCP_MODE}").`);
        }
        if (requested !== "bridge" && !backendUri) {
            throw new Error(`PENPOT_MCP_MODE=${requested} requires PENPOT_MCP_BACKEND_URI to be set.`);
        }
        return requested;
    }

    /**
     * Explains why the server runs in its mode, for the startup log.
     *
     * @param env - the environment to read
     * @returns a short sentence that names the variable that chose the mode, or the default
     */
    public static modeReason(env: Record<string, string | undefined>): string {
        const requested = env.PENPOT_MCP_MODE?.trim() ?? "";
        if (requested !== "") {
            return `set by PENPOT_MCP_MODE=${requested}`;
        }
        return "PENPOT_MCP_MODE is not set, so the default applies";
    }

    /**
     * Warns when a backend URI is configured but the mode is not set, which keeps the backend tools off.
     *
     * @param env - the environment to read
     * @returns the warning text, or undefined when there is nothing to warn about
     */
    public static unusedBackendWarning(env: Record<string, string | undefined>): string | undefined {
        const requested = env.PENPOT_MCP_MODE?.trim() ?? "";
        const backendUri = env.PENPOT_MCP_BACKEND_URI?.trim() ?? "";
        if (requested !== "" || backendUri === "") {
            return undefined;
        }
        return (
            "PENPOT_MCP_BACKEND_URI is set but PENPOT_MCP_MODE is not, so the mode is bridge and the backend tools are off. " +
            "Set PENPOT_MCP_MODE=both to serve the backend tools beside the plugin tools, or PENPOT_MCP_MODE=backend for the backend tools only."
        );
    }

    /**
     * Returns the fingerprint of a user token for log lines, from {@link TokenDigest.fingerprint}.
     *
     * @param token - the token to fingerprint, or `undefined`
     * @returns a short non-reversible fingerprint, or `<none>` if no token was given
     */
    private static tokenFingerprint(token: string | undefined): string {
        return TokenDigest.fingerprintOrNone(token);
    }

    private readonly logger = createLogger("PenpotMcpServer");
    private tools: ToolInfo[] = [];
    public readonly configLoader: ConfigurationLoader;
    private app!: Express;
    private httpServer?: HttpServer;
    private readonly mcpHandler: McpHttpHandler;
    private readonly authentication: McpAuthentication;
    /** Plugin bridge, absent in backend mode. */
    private readonly bridge?: PluginBridge;
    private readonly mode: McpMode;
    private readonly backendSettings: BackendSettings;
    /** Client of the backend, present when PENPOT_MCP_BACKEND_URI is set. Created at startup. */
    private backendClient?: PenpotBackendClient;
    /** Shared backend services, present only in backend and both mode. Created at startup. */
    private backendServices?: BackendServices;
    /** Validates the token of each request against the backend, present when a backend is configured. */
    private tokenValidator?: BackendTokenValidator;
    /** Checks the token of each request, present when OAuth or backend mode is on. */
    private tokenCheck?: RequestTokenCheck;
    /** Answers `/readyz`, present when a backend is configured. */
    private backendReadiness?: BackendReadiness;
    /** Connection pool of the backend, used by the readiness probe. */
    private backendPool?: Dispatcher;
    /** Every connection pool the server made, closed at shutdown. */
    private readonly connectionPools: Dispatcher[] = [];
    /** Names of the plugin bridge tools in `both` mode, which carry names other than the plain ones. */
    private bridgeToolNames: string[] = [];
    private readonly replServer: ReplServer | null;
    private apiDocs: ApiDocs;
    private readonly penpotHighLevelOverview: string;
    private readonly connectionInstructions: string;
    /** Counts and times the tool calls for `/metrics`. */
    private readonly metrics = new AdapterMetrics();
    /** Settles when the backend parts and the tools are ready; rejects when they could not be built. */
    private readonly ready: Promise<void>;

    /**
     * Carries the user token through each request and its asynchronous tool execution.
     */
    private readonly sessionContext = new AsyncLocalStorage<SessionContext>();

    public readonly host: string;
    public readonly port: number;
    public readonly webSocketPort: number;
    public readonly replHost: string;
    public readonly replPort: number;

    /**
     * Optional Redis bridge for multi-instance task routing; present only when running
     * in multi-user mode with a configured Redis URI.
     */
    private readonly redisBridge?: RedisBridge;

    /**
     * Tenant identifier, read from the `PENPOT_TENANT` environment variable.
     *
     * Used to qualify Redis channel names so that multiple environments sharing a
     * Redis instance do not interfere with each other. Defaults to `"default"`,
     * matching the backend default.
     */
    private readonly tenant: string;

    constructor(private isMultiUser: boolean = false) {
        this.mode = PenpotMcpServer.resolveMode(process.env);
        this.backendSettings = BackendSettings.fromEnvironment(process.env, this.mode);
        this.authentication = new McpAuthentication(
            process.env.PENPOT_MCP_AUTH_URI,
            isMultiUser,
            this.backendSettings.allowQueryToken
        );
        // read port configuration from environment variables
        this.host = process.env.PENPOT_MCP_SERVER_HOST ?? "localhost";
        this.port = readPortVariable(process.env, "PENPOT_MCP_SERVER_PORT", 4401);
        this.webSocketPort = readPortVariable(process.env, "PENPOT_MCP_WEBSOCKET_PORT", 4402);
        this.replHost = process.env.PENPOT_MCP_REPL_HOST ?? "localhost";
        this.replPort = readPortVariable(process.env, "PENPOT_MCP_REPL_PORT", 4403);
        this.tenant = process.env.PENPOT_TENANT ?? "default";
        const toolTimeoutSecs = parseInt(process.env.PENPOT_MCP_TOOL_TIMEOUT_S ?? "120", 10);

        this.configLoader = new ConfigurationLoader(process.cwd());
        this.apiDocs = new ApiDocs();

        // prepare instructions
        let instructions = this.configLoader.getInitialInstructions();
        instructions = instructions.replace("$api_types", this.apiDocs.getTypeNames().join(", "));
        this.penpotHighLevelOverview = instructions;
        this.connectionInstructions = this.configLoader.getBaseInstructions();

        this.mcpHandler = createMcpHandler(() => this.createMcpServer());

        // Enable multi-instance task routing when running in multi-user mode with a
        // configured Redis URI. Without it, the server operates in single-instance mode,
        // requiring the plugin and the MCP client to connect to the same instance.
        const redisUri = process.env.PENPOT_MCP_REDIS_URI;
        if (this.isMultiUser && redisUri && this.mode !== "backend") {
            this.redisBridge = new RedisBridge(redisUri, this.tenant);
        }

        // backend mode has no plugin bridge, so no WebSocket server is opened
        if (this.mode !== "backend") {
            this.bridge = new PluginBridge(this, this.webSocketPort, toolTimeoutSecs, this.redisBridge);
        }

        if (this.bridge && shouldStartReplServer(PenpotMcpServer.isReplEnabled(process.env), this.isMultiUserMode())) {
            this.replServer = new ReplServer(this.bridge, this.replPort, this.replHost);
        } else {
            this.replServer = null;
        }

        // the tools need the bridge and the flags above, so the backend parts start last
        this.ready = this.initializeBackendParts();
        // a failed start is reported by start(); this keeps Node from reporting it as unhandled first
        this.ready.catch(() => undefined);
    }

    /**
     * Builds the parts that depend on the backend, and the tool list.
     *
     * The backend modules load here, and only when the server needs them. A bridge-only server therefore
     * does not load the sandbox, its font catalogue or the backend tools.
     */
    private async initializeBackendParts(): Promise<void> {
        const backendUri = process.env.PENPOT_MCP_BACKEND_URI?.trim();
        if (backendUri) {
            const { ConnectionPools } = await import("./backend/ConnectionPools");
            const pool = ConnectionPools.create(this.backendSettings.timeoutSeconds);
            this.backendPool = pool;
            this.connectionPools.push(pool);
            this.backendClient = new PenpotBackendClient(
                backendUri,
                this.backendSettings.timeoutSeconds,
                this.backendSettings.maxResponseMb,
                pool
            );
            this.tokenValidator = new BackendTokenValidator(this.backendClient);
            this.backendReadiness = new BackendReadiness(() => this.probeBackend(backendUri));
            if (this.authentication.isOAuthEnabled || this.mode !== "bridge") {
                this.tokenCheck = new RequestTokenCheck(this.authentication, this.tokenValidator);
            }

            if (this.mode !== "bridge") {
                const [{ BackendServices: Services }, { HttpExporterClient }] = await Promise.all([
                    import("./backend/BackendServices"),
                    import("./backend/ExporterClient"),
                ]);
                const exporterPool = ConnectionPools.create(this.backendSettings.timeoutSeconds);
                this.connectionPools.push(exporterPool);
                const exporter = new HttpExporterClient(
                    this.backendSettings.exporterUri,
                    backendUri,
                    this.backendSettings.timeoutSeconds,
                    undefined,
                    this.backendSettings.maxResponseMb,
                    this.backendSettings.assetsUri,
                    exporterPool
                );
                this.backendServices = new Services(
                    this.backendClient,
                    this.backendSettings,
                    exporter,
                    Date.now,
                    this.tokenValidator
                );
            }
        }
        this.tools = await this.initTools();
    }

    /**
     * Asks the backend whether it is ready. A failed or slow answer counts as not ready.
     *
     * @param backendUri - the configured backend URI
     * @returns true when the backend answers its readiness endpoint with a success status
     */
    private async probeBackend(backendUri: string): Promise<boolean> {
        const response = await fetch(
            new URL("readyz", backendUri),
            withDispatcher(
                { method: "GET", redirect: "manual", signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT_MS) },
                this.backendPool
            )
        );
        await response.body?.cancel();
        return response.ok;
    }

    /** Settles when the server is ready to start; rejects when a backend part could not be built. */
    public whenReady(): Promise<void> {
        return this.ready;
    }

    /**
     * Returns the server mode.
     */
    public getMode(): McpMode {
        return this.mode;
    }

    /**
     * Returns the names of the registered tools, in registration order.
     */
    public getToolNames(): string[] {
        return this.tools.map((tool) => tool.name);
    }

    /**
     * Returns the names of the plugin bridge tools in `both` mode, which differ from the plain names.
     * The list is empty in the other modes.
     */
    public getBridgeToolNames(): string[] {
        return [...this.bridgeToolNames];
    }

    /**
     * Returns the plugin bridge, which routes tasks to the Penpot tabs that have the plugin open.
     *
     * @throws Error when the server runs in backend mode, which has no plugin bridge
     */
    public get pluginBridge(): PluginBridge {
        if (!this.bridge) {
            throw new Error("The plugin bridge is disabled in backend mode (PENPOT_MCP_MODE=backend).");
        }
        return this.bridge;
    }

    /**
     * Retrieves the overview of the backend tools, which the high-level overview tool returns in backend mode.
     */
    public getBackendInstructions(): string {
        return this.configLoader.getBackendInstructions();
    }

    /**
     * Indicates whether the server is running in multi-user mode,
     * where user tokens are required for authentication.
     */
    public isMultiUserMode(): boolean {
        return this.isMultiUser;
    }

    /**
     * Indicates whether the server is running in remote mode.
     *
     * In remote mode, the server is not assumed to be accessed only by a local user on the same machine,
     * with corresponding limitations being enforced.
     * Remote mode can be explicitly enabled by setting the environment variable PENPOT_MCP_REMOTE_MODE
     * to "true". Enabling multi-user mode forces remote mode, regardless of the value of the environment
     * variable.
     */
    public isRemoteMode(): boolean {
        const isRemoteModeRequested: boolean = process.env.PENPOT_MCP_REMOTE_MODE === "true";
        return this.isMultiUserMode() || isRemoteModeRequested;
    }

    /**
     * Indicates whether file system access is enabled for MCP tools.
     * Access is enabled only in local mode, where the file system is assumed
     * to belong to the user running the server locally.
     */
    public isFileSystemAccessEnabled(): boolean {
        return !this.isRemoteMode();
    }

    /**
     * Indicates whether the server is running in a Penpot development environment.
     *
     * When enabled (by setting the environment variable PENPOT_MCP_DEVENV to "true"),
     * additional developer tools such as ClojureScript expression evaluation are exposed.
     */
    public isDevEnv(): boolean {
        return PenpotMcpServer.isDevEnvEnabled(process.env);
    }

    /**
     * Indicates whether the REPL server was created.
     *
     * The REPL server is created when {@link isReplEnabled} returns true and
     * the server is not running in multi-user mode, which means either
     * ``PENPOT_MCP_REPL_ENABLE=true`` or, when that variable is unset,
     * ``PENPOT_MCP_DEVENV=true``, in single-user mode.
     */
    public hasReplServer(): boolean {
        return this.replServer !== null;
    }

    /**
     * Retrieves the high-level overview instructions explaining core Penpot usage.
     */
    public getHighLevelOverviewInstructions(): string {
        return this.penpotHighLevelOverview;
    }

    /**
     * Logs one structured line for a finished tool call, and counts the call for `/metrics`. The line names the
     * tool, the request id, the token fingerprint, the duration and the outcome, and never carries the token.
     *
     * @param record - the facts of the call
     */
    public recordToolCall(record: ToolCallRecord): void {
        this.logger.info(
            {
                tool: record.tool,
                requestId: record.requestId,
                tokenFp: record.tokenFp,
                durationMs: record.durationMs,
                outcome: record.outcome,
            },
            "Tool call finished"
        );
        this.metrics.recordToolCall(record.tool, record.outcome, record.durationMs);
    }

    /**
     * Retrieves the current session context.
     *
     * @returns The session context for the current request, or undefined if not in a request context
     */
    public getSessionContext(): SessionContext | undefined {
        return this.sessionContext.getStore();
    }

    private async initTools(): Promise<ToolInfo[]> {
        const toolInstances: Tool<any>[] = [new HighLevelOverviewTool(this), new PenpotApiInfoTool(this, this.apiDocs)];
        if (this.mode !== "backend") {
            // in both mode the backend tools own the plain names, so the plugin tools get suffixed names
            const bridgeNames =
                this.mode === "both"
                    ? {
                          executeCode: "execute_code_in_tab",
                          exportShape: "export_shape_from_tab",
                          importImage: "import_image_in_tab",
                      }
                    : { executeCode: "execute_code", exportShape: "export_shape", importImage: "import_image" };
            this.bridgeToolNames = this.mode === "both" ? Object.values(bridgeNames) : [];
            toolInstances.push(new ExecuteCodeTool(this, bridgeNames.executeCode));
            toolInstances.push(new ExportShapeTool(this, bridgeNames.exportShape));
            if (this.isFileSystemAccessEnabled()) {
                toolInstances.push(new ImportImageTool(this, bridgeNames.importImage));
            }
        }
        if (this.backendServices) {
            const { BackendToolSet } = await import("./tools/backend/BackendToolSet");
            toolInstances.push(...BackendToolSet.create(this, this.backendServices));
        }
        if (this.backendClient) {
            toolInstances.push(new SubmitFeedbackTool(this, this.backendClient));
        }
        if (shouldRegisterDeveloperTools(this.isDevEnv(), this.isMultiUserMode())) {
            const nreplClient = new NreplClient();
            toolInstances.push(new CljsReplTool(this, nreplClient));
            toolInstances.push(new ImportPenpotFileTool(this, nreplClient));
            toolInstances.push(new CljsCompilerOutputTool(this, nreplClient));
            toolInstances.push(new CljCheckParentheses(this));
            toolInstances.push(new ReadTaigaIssueTool(this));
        }

        return toolInstances.map((instance) => {
            this.logger.info(`Registering tool: ${instance.getToolName()}`);
            return new ToolInfo(instance, instance.getToolName(), {
                description: instance.getToolDescription(),
                inputSchema: z.object(instance.getInputSchema()),
            });
        });
    }

    /**
     * Creates a fresh {@link McpServer} instance with all tools registered.
     */
    private createMcpServer(): McpServer {
        const server = new McpServer(
            { name: "penpot", version: "1.0.0" },
            { instructions: this.connectionInstructions }
        );

        for (const tool of this.tools) {
            const annotations: ToolAnnotations = tool.instance.annotations();
            server.registerTool(tool.name, { ...tool.config, annotations }, async (args, ctx) =>
                tool.instance.execute(args, ctx.mcpReq.signal, PenpotMcpServer.progressReporterOf(ctx))
            );
        }

        return server;
    }

    /**
     * Answers whether the request comes from a page that the server should not serve: a Host or an Origin
     * that is not a loopback name. Runs only when the server binds to a loopback host.
     *
     * @param req - the incoming request
     * @returns the rejection, or undefined when the request may pass
     */
    private static hostRejectionOf(req: IncomingMessage): globalThis.Response | undefined {
        const web = webRequestOf(req);
        if (web === undefined) {
            return new globalThis.Response("Bad request headers", { status: 400 });
        }
        return (
            hostHeaderValidationResponse(web, localhostAllowedHostnames()) ??
            originValidationResponse(web, localhostAllowedOrigins())
        );
    }

    /**
     * Writes a web response from the SDK checks to an Express response.
     *
     * @param res - the Express response to write
     * @param response - the web response to copy
     */
    private static async sendWebResponse(res: ExpressResponse, response: globalThis.Response): Promise<void> {
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
    }

    /**
     * Checks the token of a request and the credentials it carries, before the body is read.
     *
     * A syntax error, or a missing token under OAuth, gets a 401. A token that the backend rejects gets a 401
     * with a challenge. Only then does the request get the large body limit.
     *
     * @param req - the incoming request
     * @param res - the response, which carries the 401 when the request is refused
     * @param next - continues to the body parser and the handler
     */
    private async authorizeRequest(req: ExpressRequest, res: ExpressResponse, next: NextFunction): Promise<void> {
        const auth: McpAuthenticationResult = this.authentication.authenticate(req, res);
        if (auth.isRejected) {
            return;
        }
        // only a token that the backend validated earns the large body limit; a token that nobody checked
        // gets the floor, so any Bearer string cannot buy 32 MB
        let authenticated = false;
        if (this.tokenCheck !== undefined && auth.userToken !== undefined) {
            const outcome = await this.tokenCheck.check(res, auth.userToken);
            if (outcome === "rejected") {
                return;
            }
            authenticated = outcome === "validated";
        }
        requestAuthOf.set(res, { userToken: auth.userToken, authenticated });
        next();
    }

    private setupHttpEndpoints(json: (options: { limit: number }) => RequestHandler): void {
        const handleMcpRequest = toNodeHandler(this.mcpHandler);
        // a request without a token gets the small limit; the large one is for authenticated requests only
        const smallJson = json({ limit: BodyLimit.UNAUTHENTICATED_BYTES });
        const largeJson = json({ limit: BodyLimit.bytesOf(process.env) });

        this.app.get("/healthz", (_req, res) => {
            res.setHeader("Cache-Control", "no-store");
            res.type("text/plain").send("ok\n");
        });

        this.app.get("/readyz", async (_req, res) => {
            res.setHeader("Cache-Control", "no-store");
            // without a backend, or in bridge mode, there is nothing to wait for; the process being up is ready
            const ready =
                this.mode === "bridge" || this.backendReadiness === undefined
                    ? true
                    : await this.backendReadiness.isReady();
            res.status(ready ? 200 : 503)
                .type("text/plain")
                .send(ready ? "ready\n" : "not ready\n");
        });

        // metrics name tools and sandboxes, so they are served on loopback only, or to a validated token
        this.app.get(
            "/metrics",
            async (req, res, next) => {
                // the same Host check as /mcp, then no token only for a client that is on this machine itself
                const loopbackBind = LOOPBACK_HOSTS.includes(this.host);
                if (loopbackBind) {
                    const rejected = PenpotMcpServer.hostRejectionOf(req);
                    if (rejected !== undefined) {
                        await PenpotMcpServer.sendWebResponse(res, rejected);
                        return;
                    }
                }
                if (loopbackBind && isLoopbackClient(req)) {
                    next();
                    return;
                }
                await this.authorizeRequest(req, res, () => {
                    if (requestAuthOf.get(res)?.authenticated) {
                        next();
                    } else {
                        this.authentication.rejectOAuth(res);
                    }
                });
            },
            (_req, res) => {
                res.setHeader("Cache-Control", "no-store");
                res.type("text/plain; version=0.0.4").send(this.renderMetrics());
            }
        );

        this.app.all(
            "/mcp",
            async (req, res, next) => {
                // a page on another host can reach a loopback server through DNS rebinding; refuse it first
                if (LOOPBACK_HOSTS.includes(this.host)) {
                    const rejected = PenpotMcpServer.hostRejectionOf(req);
                    if (rejected !== undefined) {
                        await PenpotMcpServer.sendWebResponse(res, rejected);
                        return;
                    }
                }
                await this.authorizeRequest(req, res, next);
            },
            (req, res, next) => {
                const auth = requestAuthOf.get(res);
                const parser = auth?.authenticated ? largeJson : smallJson;
                parser(req, res, next);
            },
            async (req, res) => {
                const auth = requestAuthOf.get(res);
                const userToken = auth?.userToken;
                this.logger.info(
                    `Received MCP request: method=${req.body?.method ?? "<none>"}; userTokenFp=${PenpotMcpServer.tokenFingerprint(userToken)}`
                );
                await this.sessionContext.run({ userToken }, () => handleMcpRequest(req, res, req.body));
            }
        );
    }

    /**
     * Renders the metrics of the tool calls and of the sandboxes as Prometheus text.
     */
    private renderMetrics(): string {
        const stats = this.backendServices?.sandboxes.stats();
        const calls = stats?.calls ?? { ok: 0, error: 0, interrupted: 0 };
        const counter = (name: string, help: string, value: number, labels?: Record<string, string>) => ({
            name,
            help,
            type: "counter" as const,
            samples: [{ labels, value }],
        });
        return this.metrics.render([
            {
                name: "penpot_mcp_active_sandboxes",
                help: "Sandbox runtimes held by the server.",
                type: "gauge",
                samples: [{ value: stats?.live ?? 0 }],
            },
            counter("penpot_mcp_sandbox_runtimes_created_total", "Sandbox runtimes created.", stats?.created ?? 0),
            counter("penpot_mcp_sandbox_runtimes_disposed_total", "Sandbox runtimes disposed.", stats?.disposed ?? 0),
            counter(
                "penpot_mcp_sandbox_memory_recycles_total",
                "Sandbox runtimes recycled for memory growth.",
                stats?.memoryRecycles ?? 0
            ),
            {
                name: "penpot_mcp_sandbox_calls_total",
                help: "Sandbox calls by outcome.",
                type: "counter",
                samples: Object.entries(calls).map(([outcome, value]) => ({ labels: { outcome }, value })),
            },
        ]);
    }

    /**
     * Builds the progress reporter of a request, when the client sent a progress token.
     *
     * The reporter sends `notifications/progress` with that token, so a long tool keeps the connection alive
     * and shows progress. Without a token the client asked for no progress, and the result is undefined.
     *
     * @param ctx - the request context that the SDK passes to the tool callback
     * @returns the reporter, or undefined when the request carries no progress token
     */
    public static progressReporterOf(ctx: ServerContext): ProgressReporter | undefined {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        if (progressToken === undefined) {
            return undefined;
        }
        return (progress, total, message) =>
            ctx.mcpReq.notify({
                method: "notifications/progress",
                params: {
                    progressToken,
                    progress,
                    ...(total !== undefined ? { total } : {}),
                    ...(message !== undefined ? { message } : {}),
                },
            });
    }

    async start(): Promise<void> {
        await this.ready;
        const { default: express } = await import("express");
        if (this.isFileSystemAccessEnabled()) {
            // fails at start, not at the first export, when PENPOT_MCP_EXPORT_DIR is not usable
            ExportDirectory.rootOf(process.env);
        }
        this.app = express();

        this.setupHttpEndpoints(express.json);

        return new Promise((resolve, reject) => {
            this.httpServer = this.app.listen(this.port, this.host, async () => {
                this.logger.info(`Server mode: ${this.mode} (${PenpotMcpServer.modeReason(process.env)})`);
                const unusedBackend = PenpotMcpServer.unusedBackendWarning(process.env);
                if (unusedBackend !== undefined) {
                    this.logger.warn(unusedBackend);
                }
                if (this.mode === "both") {
                    const { plain, bridge } = partitionToolNames(this.getToolNames(), this.bridgeToolNames);
                    this.logger.info(`Plain tool names in both mode: ${plain.join(", ")}`);
                    this.logger.info(`Plugin bridge tool names in both mode: ${bridge.join(", ")}`);
                }
                this.logger.info(`Backend tools enabled: ${this.backendServices !== undefined}`);
                this.logger.info(`Plugin bridge enabled: ${this.bridge !== undefined}`);
                this.logger.info(`Multi-user mode: ${this.isMultiUserMode()}`);
                this.logger.info(`OAuth enabled: ${this.authentication.isOAuthEnabled}`);
                this.logger.info(
                    `Multi-instance mode with Redis-backed transport: ${this.redisBridge ? "true" : "false"}`
                );
                this.logger.info(`Remote mode: ${this.isRemoteMode()}`);
                this.logger.info(`DevEnv mode: ${this.isDevEnv()}`);
                this.logger.info(`Modern Streamable HTTP endpoint: http://${this.host}:${this.port}/mcp`);
                if (this.bridge) {
                    this.logger.info(`WebSocket server URL: ws://${this.host}:${this.webSocketPort}`);
                } else {
                    this.logger.info("Plugin bridge WebSocket server not started (backend mode)");
                }

                // start the REPL server when enabled
                if (this.replServer) {
                    await this.replServer.start();
                } else if (this.mode === "backend") {
                    this.logger.info("REPL server disabled in backend mode (it needs the plugin bridge)");
                } else if (this.isMultiUserMode()) {
                    this.logger.info("REPL server disabled in multi-user mode (never started with --multi-user)");
                } else {
                    this.logger.info(
                        "REPL server disabled (set PENPOT_MCP_REPL_ENABLE=true or PENPOT_MCP_DEVENV=true to enable)"
                    );
                }

                resolve();
            });
            this.httpServer.once("error", reject);
        });
    }

    /**
     * Closes the HTTP server. Requests still open after the deadline have their connections closed, so a long
     * call cannot block the shutdown.
     */
    private closeHttpServer(): Promise<void> {
        const server = this.httpServer;
        if (server === undefined) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => server.closeAllConnections(), HTTP_CLOSE_DEADLINE_MS);
            server.close((error) => {
                clearTimeout(deadline);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Stops the MCP server and associated services.
     *
     * Gracefully shuts down the REPL server and other components.
     */
    public async stop(): Promise<void> {
        this.logger.info("Stopping Penpot MCP Server...");
        const httpClosed = this.closeHttpServer();
        await this.mcpHandler.close();
        await httpClosed;
        this.backendServices?.sandboxes.dispose();
        await Promise.all(this.connectionPools.map((pool) => pool.close()));
        await this.bridge?.close();
        await this.redisBridge?.close();
        if (this.replServer) {
            await this.replServer.stop();
        }
        this.logger.info("Penpot MCP Server stopped");
    }
}
