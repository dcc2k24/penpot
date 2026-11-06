import type { Request, Response } from "express";
import { createLogger } from "./logger";
import { TokenDigest } from "./backend/TokenDigest";
import { type BackendTokenValidator, TokenRejectedError } from "./backend/BackendTokenValidator";

/**
 * A set of token fingerprints that keeps at most a fixed number of entries.
 *
 * Adding a fingerprint that is already kept moves it to the newest position. Adding beyond the
 * capacity evicts the oldest fingerprint.
 */
export class BoundedFingerprintSet {
    private readonly fingerprints = new Set<string>();

    /**
     * Creates an empty set.
     *
     * @param capacity maximum number of fingerprints kept
     */
    constructor(private readonly capacity: number) {}

    /** Number of fingerprints currently kept. */
    public get size(): number {
        return this.fingerprints.size;
    }

    /**
     * Records a fingerprint as the newest entry.
     *
     * @param fingerprint the fingerprint to record
     * @returns true when the fingerprint was not kept before, false when it was refreshed
     */
    public add(fingerprint: string): boolean {
        const wasKept = this.fingerprints.delete(fingerprint);
        this.fingerprints.add(fingerprint);
        if (this.fingerprints.size > this.capacity) {
            const oldest = this.fingerprints.values().next();
            if (!oldest.done) {
                this.fingerprints.delete(oldest.value);
            }
        }
        return !wasKept;
    }
}

/**
 * Result of processing credentials from an MCP HTTP request.
 */
export class McpAuthenticationResult {
    /**
     * @param userToken the extracted user token, if present
     * @param isRejected whether the request was rejected and its HTTP error response sent
     */
    constructor(
        public readonly userToken: string | undefined,
        public readonly isRejected: boolean = false
    ) {}
}

/**
 * HTTP credential extraction and optional OAuth discovery for MCP clients.
 *
 * Tokens retain their existing role of matching requests to Penpot connections.
 */
export class McpAuthentication {
    public readonly isOAuthEnabled: boolean;
    private readonly resourceMetadataUri?: string;
    private readonly logger = createLogger("McpAuthentication");

    /** Fingerprints of the tokens for which the query-parameter warning was already logged, at most 1000. */
    private readonly warnedQueryFingerprints = new BoundedFingerprintSet(1000);

    /**
     * Creates a new MCP authentication handler.
     *
     * @param authUri the authentication URI from PENPOT_MCP_AUTH_URI, or undefined/empty to disable OAuth
     * @param multiUser whether the server is running in multi-user mode
     * @param allowQueryToken whether the `userToken` query parameter is accepted (PENPOT_MCP_ALLOW_QUERY_TOKEN)
     */
    constructor(
        authUri: string | undefined,
        multiUser: boolean,
        private readonly allowQueryToken: boolean = true
    ) {
        if (!authUri?.trim()) {
            this.isOAuthEnabled = false;
        } else {
            if (!multiUser) {
                throw new Error("PENPOT_MCP_AUTH_URI (which enables OAuth) requires multi-user mode");
            }

            // validate the authentication URI
            let uri: URL;
            try {
                uri = new URL(authUri);
            } catch {
                throw new Error("PENPOT_MCP_AUTH_URI must be an absolute HTTP(S) URL");
            }
            const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
            if (
                (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback)) ||
                uri.username ||
                uri.password ||
                uri.search ||
                uri.hash
            ) {
                throw new Error(
                    "PENPOT_MCP_AUTH_URI must use HTTPS (HTTP is allowed on loopback) without credentials, query, or fragment"
                );
            }

            this.resourceMetadataUri = uri.href.replace(/\/$/, "") + "/resource";
            this.isOAuthEnabled = true;
        }
    }

    /**
     * Extracts credentials.
     * If credentials are absent while OAuth is enabled, sends an authentication error.
     */
    public authenticate(req: Request, res: Response): McpAuthenticationResult {
        let userToken: string | undefined;

        // reject the query parameter outright when the operator disabled it
        if (req.query.userToken !== undefined && !this.allowQueryToken) {
            this.rejectJson(res, "query_token_disabled", "Send the MCP token in the Authorization header instead.");
            return new McpAuthenticationResult(undefined, true);
        }

        // check for a Bearer token in the Authorization header
        const header = req.headers.authorization;
        if (header !== undefined) {
            const headerCount = req.rawHeaders.filter(
                (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization"
            ).length;
            const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(header);
            if (headerCount !== 1 || !match) {
                this.rejectOAuth(res, "invalid_token");
                return new McpAuthenticationResult(undefined, true);
            }
            userToken = match[1];
        }
        // check for a userToken query parameter
        else if (req.query.userToken !== undefined) {
            const value = req.query.userToken;
            if (typeof value !== "string" || !/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
                this.rejectOAuth(res, "invalid_token");
                return new McpAuthenticationResult(undefined, true);
            }
            this.warnAboutQueryToken(value);
            userToken = value;
        }

        // NOTE: The MCP server does not validate userToken against the backend.
        // It uses the token to match MCP requests to a connection established
        // from the Penpot webapp. Without that matching connection, requests
        // cannot access or modify designs. The user must be logged in to Penpot
        // to establish that connection; Penpot login and file permissions thus
        // provide the authentication and access control boundary.

        if (this.isOAuthEnabled && !userToken) {
            this.rejectOAuth(res);
            return new McpAuthenticationResult(undefined, true);
        } else {
            return new McpAuthenticationResult(userToken);
        }
    }

    /**
     * Logs once per token that the token travels in the URL, which proxies and logs may record.
     *
     * @param token the token taken from the query parameter
     */
    private warnAboutQueryToken(token: string): void {
        const fingerprint = TokenDigest.fingerprint(token);
        if (!this.warnedQueryFingerprints.add(fingerprint)) {
            return;
        }
        this.logger.warn(
            `MCP token sent as the userToken query parameter (tokenFp=${fingerprint}); URLs can leak into logs. ` +
                "Prefer the Authorization header, or set PENPOT_MCP_ALLOW_QUERY_TOKEN=false."
        );
    }

    /**
     * Sends a JSON error with status 401 and no caching.
     *
     * @param res the response to answer
     * @param error machine-readable error code
     * @param description human-readable explanation
     */
    private rejectJson(res: Response, error: string, description: string): void {
        res.setHeader("Cache-Control", "no-store");
        res.status(401).json({ error, error_description: description });
    }

    /**
     * Sends a 401 response with a Bearer challenge, naming the resource metadata when OAuth is enabled.
     *
     * @param res the response to answer
     * @param error the OAuth error code to report, or undefined when the client only lacks credentials
     */
    public rejectOAuth(res: Response, error?: "invalid_token"): void {
        let challenge = "Bearer";
        if (this.resourceMetadataUri) {
            challenge += ` resource_metadata="${this.resourceMetadataUri}", scope="mcp"`;
        }
        if (error) challenge += `${this.resourceMetadataUri ? "," : ""} error="${error}"`;
        res.setHeader("WWW-Authenticate", challenge);
        res.setHeader("Cache-Control", "no-store");
        res.status(401).json({ error: error ?? "unauthorized" });
    }
}

/**
 * Checks the token of a request that starts a new MCP session against the backend.
 *
 * A token that the backend rejects gets a 401 response at `initialize`, so the client learns of the
 * rejection before it starts a session. Other backend failures let the request through, as before,
 * so that the tool calls report them.
 */
export class InitializeTokenCheck {
    private readonly logger = createLogger("InitializeTokenCheck");

    /**
     * Creates a check.
     *
     * @param authentication the handler whose challenge answers a rejected token
     * @param validator validates the token against the backend
     */
    constructor(
        private readonly authentication: McpAuthentication,
        private readonly validator: Pick<BackendTokenValidator, "validate">
    ) {}

    /**
     * Indicates whether a request starts a new MCP session.
     *
     * A session starts with an `initialize` call that carries no `mcp-session-id` header.
     *
     * @param req the incoming request, whose JSON body the server has already parsed
     */
    public static startsSession(req: Request): boolean {
        return req.body?.method === "initialize" && req.headers["mcp-session-id"] === undefined;
    }

    /**
     * Validates the token of a request that starts a session, and sends a 401 response when the backend rejects it.
     *
     * @param req the incoming request
     * @param res the response to answer on rejection
     * @param userToken the MCP token taken from the request
     * @returns true when the request was rejected and its 401 response sent
     */
    public async rejectsRequest(req: Request, res: Response, userToken: string): Promise<boolean> {
        if (!InitializeTokenCheck.startsSession(req)) {
            return false;
        }
        try {
            await this.validator.validate(userToken);
            return false;
        } catch (error) {
            if (error instanceof TokenRejectedError) {
                this.authentication.rejectOAuth(res, "invalid_token");
                return true;
            }
            this.logger.warn(`Could not validate the MCP token at initialize; the request continues. ${String(error)}`);
            return false;
        }
    }
}
