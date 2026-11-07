import assert from "node:assert/strict";
import { test } from "node:test";
import { Tool, type ToolCallRecord } from "./Tool";
import { TextResponse } from "./ToolResponse";
import type { PenpotMcpServer } from "./PenpotMcpServer";
import { TokenDigest } from "./backend/TokenDigest";
import { CallContext, type CallContextData } from "./backend/CallContext";

const TOKEN = "secret-token-value";

/**
 * Returns the text of the first content item of a tool response.
 *
 * @param response - the tool response
 */
function textOf(response: { content: unknown[] }): string {
    return (response.content[0] as { text: string }).text;
}

/** A tool that echoes its text, or throws when told to fail. */
class EchoTool extends Tool<{ text?: string; fail?: boolean }> {
    constructor(server: PenpotMcpServer) {
        super(server, {});
    }

    public getToolName(): string {
        return "echo";
    }

    public getToolDescription(): string {
        return "Echoes the text.";
    }

    protected async executeCore(args: { text?: string; fail?: boolean }): Promise<TextResponse> {
        if (args.fail) {
            throw new Error("boom");
        }
        return new TextResponse(args.text ?? "");
    }
}

/**
 * Builds a server stub that carries the session and records the tool-call hook.
 *
 * @param userToken - token of the request, or undefined for none
 * @param records - receives every record that the hook gets
 */
function serverStub(userToken: string | undefined, records: ToolCallRecord[]): PenpotMcpServer {
    return {
        getSessionContext: () => (userToken === undefined ? undefined : { userToken }),
        recordToolCall: (record: ToolCallRecord) => records.push(record),
    } as unknown as PenpotMcpServer;
}

test("a successful call returns a response without isError", async () => {
    const response = await new EchoTool(serverStub(TOKEN, [])).execute({ text: "hi" });
    assert.equal(response.isError, undefined);
    assert.equal(JSON.stringify(response).includes("isError"), false);
    assert.equal(textOf(response), "hi");
});

test("a failed call keeps the failure text and sets isError", async () => {
    const response = await new EchoTool(serverStub(TOKEN, [])).execute({ fail: true });
    assert.equal(response.isError, true);
    assert.equal(textOf(response), "Tool execution failed: Error: boom");
});

test("the hook gets the tool name, the token fingerprint, the duration and the outcome", async () => {
    const records: ToolCallRecord[] = [];
    await new EchoTool(serverStub(TOKEN, records)).execute({ text: "hi" });
    await new EchoTool(serverStub(TOKEN, records)).execute({ fail: true });
    assert.equal(records.length, 2);
    assert.deepEqual(Object.keys(records[0]).sort(), ["durationMs", "outcome", "requestId", "tokenFp", "tool"]);
    assert.equal(records[0].tool, "echo");
    assert.equal(records[0].tokenFp, TokenDigest.fingerprint(TOKEN));
    assert.equal(records[0].outcome, "ok");
    assert.equal(records[1].outcome, "error");
    assert.ok(records[0].durationMs >= 0);
});

test("the hook never carries the token itself", async () => {
    const records: ToolCallRecord[] = [];
    await new EchoTool(serverStub(TOKEN, records)).execute({ text: "hi" });
    assert.equal(JSON.stringify(records).includes(TOKEN), false);
});

test("a call without a token is recorded with the none fingerprint", async () => {
    const records: ToolCallRecord[] = [];
    await new EchoTool(serverStub(undefined, records)).execute({ text: "hi" });
    assert.equal(records[0].tokenFp, "<none>");
});

test("a server without the hook still runs the tool", async () => {
    const server = { getSessionContext: () => undefined } as unknown as PenpotMcpServer;
    const response = await new EchoTool(server).execute({ text: "plain" });
    assert.equal(textOf(response), "plain");
});

/** A tool that records the call context it sees while it runs. */
class ContextTool extends Tool<Record<string, never>> {
    /** The context seen by the last call. */
    public seen: CallContextData | undefined;

    constructor(server: PenpotMcpServer) {
        super(server, {});
    }

    public getToolName(): string {
        return "context";
    }

    public getToolDescription(): string {
        return "Reports the call context.";
    }

    protected async executeCore(): Promise<TextResponse> {
        this.seen = CallContext.current();
        return new TextResponse("ok");
    }
}

test("each call gets its own request id, and the signal of the request reaches the tool", async () => {
    const tool = new ContextTool(serverStub(TOKEN, []));
    const controller = new AbortController();
    await tool.execute({}, controller.signal);
    const first = tool.seen;
    await tool.execute({});
    const second = tool.seen;
    assert.match(first?.requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(first?.signal, controller.signal);
    assert.notEqual(second?.requestId, first?.requestId);
    assert.equal(second?.signal, undefined);
});

test("the hook gets the request id that the tool saw", async () => {
    const records: ToolCallRecord[] = [];
    const tool = new ContextTool(serverStub(TOKEN, records));
    await tool.execute({});
    assert.equal(records[0].requestId, tool.seen?.requestId);
});

test("a token id bound during the call replaces the digest in the hook", async () => {
    class BindingTool extends Tool<Record<string, never>> {
        constructor(server: PenpotMcpServer) {
            super(server, {});
        }

        public getToolName(): string {
            return "binding";
        }

        public getToolDescription(): string {
            return "Binds a token fingerprint.";
        }

        protected async executeCore(): Promise<TextResponse> {
            const call = CallContext.current();
            if (call) {
                call.tokenFp = "0a1b2c3d";
            }
            return new TextResponse("ok");
        }
    }
    const records: ToolCallRecord[] = [];
    await new BindingTool(serverStub(TOKEN, records)).execute({});
    assert.equal(records[0].tokenFp, "0a1b2c3d");
});

test("the default annotations are not read-only and destructive", () => {
    assert.deepEqual(new EchoTool(serverStub(TOKEN, [])).annotations(), {
        readOnlyHint: false,
        destructiveHint: true,
    });
});

test("the progress reporter of the call reaches the tool through the call context", async () => {
    const seen: unknown[] = [];
    class ProgressTool extends Tool<Record<string, never>> {
        constructor(server: PenpotMcpServer) {
            super(server, {});
        }

        public getToolName(): string {
            return "progress";
        }

        public getToolDescription(): string {
            return "Reports progress.";
        }

        protected async executeCore(): Promise<TextResponse> {
            seen.push(CallContext.current()?.progress);
            await CallContext.current()?.progress?.(1, 2, "half");
            return new TextResponse("ok");
        }
    }
    const reports: unknown[] = [];
    await new ProgressTool(serverStub(TOKEN, [])).execute({}, undefined, async (...args) => {
        reports.push(args);
    });
    await new ProgressTool(serverStub(TOKEN, [])).execute({});
    assert.equal(typeof seen[0], "function");
    assert.equal(seen[1], undefined);
    assert.deepEqual(reports, [[1, 2, "half"]]);
});
