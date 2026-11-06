import type { BackendUpload, Feedback, PenpotBackend, RpcCallOptions } from "../../PenpotBackendClient";

/** One call received by {@link FakePenpotBackend}. */
export interface RecordedCall {
    /** Kind of call: a JSON command, a multipart command or a feedback submission. */
    kind: "command" | "multipart" | "feedback";
    /** Token the call was made with. */
    userToken: string;
    /** Command name, or `send-mcp-feedback` for feedback. */
    name: string;
    /** JSON parameters of a command or feedback payload. */
    params?: unknown;
    /** Form fields of a multipart call. */
    fields?: Record<string, string | number | boolean>;
    /** Uploads of a multipart call. */
    uploads?: BackendUpload[];
}

/** A canned answer: a fixed result, or a function computing it from the parameters. */
export type CannedResponse = unknown | ((params: object) => unknown);

/**
 * An in-memory {@link PenpotBackend} that records every call and answers with canned results.
 *
 * Commands without a canned answer resolve to `undefined`. A command given a failure throws it instead.
 */
export class FakePenpotBackend implements PenpotBackend {
    /** Calls in the order they were made. */
    public readonly calls: RecordedCall[] = [];

    private readonly responses = new Map<string, CannedResponse>();
    private readonly failures = new Map<string, Error>();

    /**
     * Sets the answer of a command.
     *
     * @param name - command name
     * @param response - fixed result, or a function receiving the parameters
     */
    public respond(name: string, response: CannedResponse): this {
        this.responses.set(name, response);
        return this;
    }

    /**
     * Makes a command fail with the given error.
     *
     * @param name - command name
     * @param error - error thrown by the command
     */
    public fail(name: string, error: Error): this {
        this.failures.set(name, error);
        return this;
    }

    /** Returns the recorded calls of one command name. */
    public callsTo(name: string): RecordedCall[] {
        return this.calls.filter((call) => call.name === name);
    }

    public async submitFeedback(userToken: string, feedback: Feedback): Promise<void> {
        this.calls.push({ kind: "feedback", userToken, name: "send-mcp-feedback", params: feedback });
    }

    public async callCommand<T = unknown>(
        userToken: string,
        name: string,
        params: object,
        _options?: RpcCallOptions
    ): Promise<T> {
        this.calls.push({ kind: "command", userToken, name, params });
        return this.answer<T>(name, params);
    }

    public async callMultipart<T = unknown>(
        userToken: string,
        name: string,
        fields: Record<string, string | number | boolean>,
        uploads: BackendUpload[],
        _options?: RpcCallOptions
    ): Promise<T> {
        this.calls.push({ kind: "multipart", userToken, name, fields, uploads });
        return this.answer<T>(name, fields);
    }

    private answer<T>(name: string, params: object): T {
        const failure = this.failures.get(name);
        if (failure) {
            throw failure;
        }
        const response = this.responses.get(name);
        if (typeof response === "function") {
            return (response as (params: object) => T)(params);
        }
        return response as T;
    }
}
