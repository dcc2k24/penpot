/** Admits or refuses one request of an MCP token. */
export interface RateLimiter {
    /**
     * Consumes one request of the token.
     *
     * @param token - the MCP user token
     * @throws RateLimitError when the token has no request left
     */
    acquire(token: string): void | Promise<void>;
}
