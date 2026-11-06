import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
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
import { InitializeTokenCheck, McpAuthentication } from "./McpAuthentication";
import { BackendSettings } from "./backend/BackendSettings";
import { BackendTokenValidator } from "./backend/BackendTokenValidator";
import { BackendServices } from "./backend/BackendServices";
import { HttpExporterClient } from "./backend/ExporterClient";
import { BackendToolSet } from "./tools/backend/BackendToolSet";
import { TokenDigest } from "./backend/TokenDigest";
import { BodyLimit } from "./utils/BodyLimit";
import type { ToolCallRecord } from "./Tool";

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

/**
 * Indicates whether a value names a known server mode.
 *
 * @param value - the value to check
 */
function isMcpMode(value: string): value is McpMode {
    return (MCP_MODES as readonly string[]).includes(value);
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
     * An explicit PENPOT_MCP_MODE wins. When the variable is unset, the mode is `both` if
     * PENPOT_MCP_BACKEND_URI is configured and `bridge` otherwise, so that bridge-only deployments keep
     * working without changes.
     *
     * @param env - the environment to read
     * @throws Error when the mode is unknown, or when backend or both mode has no PENPOT_MCP_BACKEND_URI
     */
    public static resolveMode(env: Record<string, string | undefined>): McpMode {
        const backendUri = env.PENPOT_MCP_BACKEND_URI?.trim();
        const requested = env.PENPOT_MCP_MODE?.trim().toLowerCase();
        if (requested === undefined || requested === "") {
            return backendUri ? "both" : "bridge";
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
     * Returns the fingerprint of a user token for log lines, from {@link TokenDigest.fingerprint}.
     *
     * @param token - the token to fingerprint, or `undefined`
     * @returns a short non-reversible fingerprint, or `<none>` if no token was given
     */
    private static tokenFingerprint(token: string | undefined): string {
        return TokenDigest.fingerprintOrNone(token);
    }

    /**
     * Describes the startup warning for a mode that was implied rather than set, or returns undefined.
     *
     * The mode is implied as `both` when PENPOT_MCP_MODE is unset and PENPOT_MCP_BACKEND_URI is configured.
     * That mode serves the backend tools and the plugin tools side by side, so the warning names the cause.
     *
     * @param env - the environment to read
     * @returns the warning text, or undefined when the mode was set explicitly or no backend is configured
     */
    public static impliedModeWarning(env: Record<string, string | undefined>): string | undefined {
        const requested = env.PENPOT_MCP_MODE?.trim() ?? "";
        const backendUri = env.PENPOT_MCP_BACKEND_URI?.trim() ?? "";
        if (requested !== "" || backendUri === "") {
            return undefined;
        }
        return (
            "PENPOT_MCP_MODE is not set, so the mode is implied as both because PENPOT_MCP_BACKEND_URI is set. " +
            "Both mode serves the backend tools and the plugin tools side by side. " +
            "Set PENPOT_MCP_MODE=backend or PENPOT_MCP_MODE=bridge to choose one."
        );
    }

    private readonly logger = createLogger("PenpotMcpServer");
    private readonly tools: ToolInfo[];
    public readonly configLoader: ConfigurationLoader;
    private app!: Express;
    private httpServer?: HttpServer;
    private readonly mcpHandler: McpHttpHandler;
    private readonly authentication: McpAuthentication;
    /** Plugin bridge, absent in backend mode. */
    private readonly bridge?: PluginBridge;
    private readonly mode: McpMode;
    private readonly backendSettings: BackendSettings;
    private readonly backendClient?: PenpotBackendClient;
    private readonly backendServices?: BackendServices;
    /** Checks the token of each new session at initialize, present only when OAuth is enabled and a backend is configured. */
    private readonly initializeTokenCheck?: InitializeTokenCheck;
    /** Names of the plugin bridge tools in `both` mode, which carry names other than the plain ones. */
    private bridgeToolNames: string[] = [];
    private readonly replServer: ReplServer | null;
    private apiDocs: ApiDocs;
    private readonly penpotHighLevelOverview: string;
    private readonly connectionInstructions: string;

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
        this.backendSettings = BackendSettings.fromEnvironment(process.env);
        this.authentication = new McpAuthentication(
            process.env.PENPOT_MCP_AUTH_URI,
            isMultiUser,
            this.backendSettings.allowQueryToken
        );
        // read port configuration from environment variables
        this.host = process.env.PENPOT_MCP_SERVER_HOST ?? "localhost";
        this.port = parseInt(process.env.PENPOT_MCP_SERVER_PORT ?? "4401", 10);
        this.webSocketPort = parseInt(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? "4402", 10);
        this.replHost = process.env.PENPOT_MCP_REPL_HOST ?? "localhost";
        this.replPort = parseInt(process.env.PENPOT_MCP_REPL_PORT ?? "4403", 10);
        this.tenant = process.env.PENPOT_TENANT ?? "default";
        const toolTimeoutSecs = parseInt(process.env.PENPOT_MCP_TOOL_TIMEOUT_S ?? "120", 10);

        this.configLoader = new ConfigurationLoader(process.cwd());
        this.apiDocs = new ApiDocs();

        // prepare instructions
        let instructions = this.configLoader.getInitialInstructions();
        instructions = instructions.replace("$api_types", this.apiDocs.getTypeNames().join(", "));
        this.penpotHighLevelOverview = instructions;
        this.connectionInstructions = this.configLoader.getBaseInstructions();

        const backendUri = process.env.PENPOT_MCP_BACKEND_URI?.trim();
        if (backendUri) {
            this.backendClient = new PenpotBackendClient(backendUri, this.backendSettings.timeoutSeconds);
        }
        if (this.mode !== "bridge" && backendUri && this.backendClient) {
            this.backendServices = new BackendServices(
                this.backendClient,
                this.backendSettings,
                new HttpExporterClient(
                    this.backendSettings.exporterUri,
                    backendUri,
                    this.backendSettings.timeoutSeconds,
                    undefined,
                    this.backendSettings.maxResponseMb,
                    this.backendSettings.assetsUri
                )
            );
        }

        if (this.authentication.isOAuthEnabled) {
            const validator =
                this.backendServices?.validator ??
                (this.backendClient ? new BackendTokenValidator(this.backendClient) : undefined);
            if (validator) {
                this.initializeTokenCheck = new InitializeTokenCheck(this.authentication, validator);
            }
        }

        this.tools = this.initTools();
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
     * Logs one structured line for a finished tool call. The line names the tool, the token fingerprint, the
     * duration and the outcome, and never carries the token. Tools call this hook after each execution.
     *
     * @param record - the facts of the call
     */
    public recordToolCall(record: ToolCallRecord): void {
        this.logger.info(
            { tool: record.tool, tokenFp: record.tokenFp, durationMs: record.durationMs, outcome: record.outcome },
            "Tool call finished"
        );
    }

    /**
     * Retrieves the current session context.
     *
     * @returns The session context for the current request, or undefined if not in a request context
     */
    public getSessionContext(): SessionContext | undefined {
        return this.sessionContext.getStore();
    }

    private initTools(): ToolInfo[] {
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
            server.registerTool(tool.name, tool.config, async (args) => tool.instance.execute(args));
        }

        return server;
    }

    private setupHttpEndpoints(): void {
        const handleMcpRequest = toNodeHandler(this.mcpHandler);
        this.app.all("/mcp", async (req, res) => {
            const authResult = this.authentication.authenticate(req, res);
            if (authResult.isRejected) {
                return;
            }
            this.logger.info(
                `Received MCP request: method=${req.body?.method ?? "<none>"}; userTokenFp=${PenpotMcpServer.tokenFingerprint(authResult.userToken)}`
            );
            if (this.initializeTokenCheck && authResult.userToken !== undefined) {
                const rejected = await this.initializeTokenCheck.rejectsRequest(req, res, authResult.userToken);
                if (rejected) {
                    return;
                }
            }
            await this.sessionContext.run({ userToken: authResult.userToken }, () =>
                handleMcpRequest(req, res, req.body)
            );
        });
    }

    async start(): Promise<void> {
        const { default: express } = await import("express");
        this.app = express();
        this.app.use(express.json({ limit: BodyLimit.bytesOf(process.env) }));

        this.setupHttpEndpoints();

        return new Promise((resolve, reject) => {
            this.httpServer = this.app.listen(this.port, this.host, async () => {
                this.logger.info(`Server mode: ${this.mode}`);
                const impliedWarning = PenpotMcpServer.impliedModeWarning(process.env);
                if (impliedWarning !== undefined) {
                    this.logger.warn(impliedWarning);
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
     * Stops the MCP server and associated services.
     *
     * Gracefully shuts down the REPL server and other components.
     */
    public async stop(): Promise<void> {
        this.logger.info("Stopping Penpot MCP Server...");
        const httpClosed = this.httpServer
            ? new Promise<void>((resolve, reject) => {
                  this.httpServer!.close((error) => (error ? reject(error) : resolve()));
              })
            : Promise.resolve();
        await this.mcpHandler.close();
        await httpClosed;
        await this.bridge?.close();
        await this.redisBridge?.close();
        if (this.replServer) {
            await this.replServer.stop();
        }
        this.logger.info("Penpot MCP Server stopped");
    }
}
