import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendRpcError } from "./BackendRpcError";
import { BackendTokenValidator } from "./BackendTokenValidator";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";
import type { PenpotBackend } from "../PenpotBackendClient";

const whoami = { profileId: "profile-1", scopes: ["mcp:read"] };

/** A clock whose time the test moves by hand. */
class ManualClock {
    public now = 0;

    public read = (): number => this.now;
}

test("a second validation within 60 seconds does not reach the backend", async () => {
    const backend = new FakePenpotBackend().respond("mcp-whoami", whoami);
    const validator = new BackendTokenValidator(backend);
    assert.deepEqual(await validator.validate("alice-token"), whoami);
    assert.deepEqual(await validator.validate("alice-token"), whoami);
    assert.equal(backend.callsTo("mcp-whoami").length, 1);
});

test("validation at 59.999 seconds is still cached", async () => {
    const clock = new ManualClock();
    const backend = new FakePenpotBackend().respond("mcp-whoami", whoami);
    const validator = new BackendTokenValidator(backend, clock.read);
    await validator.validate("alice-token");
    clock.now = 59_999;
    await validator.validate("alice-token");
    assert.equal(backend.callsTo("mcp-whoami").length, 1);
});

test("validation after 60 seconds asks the backend again", async () => {
    const clock = new ManualClock();
    const backend = new FakePenpotBackend().respond("mcp-whoami", whoami);
    const validator = new BackendTokenValidator(backend, clock.read);
    await validator.validate("alice-token");
    clock.now = 60_000;
    await validator.validate("alice-token");
    assert.equal(backend.callsTo("mcp-whoami").length, 2);
});

test("cache entries are per token", async () => {
    const backend = new FakePenpotBackend().respond("mcp-whoami", whoami);
    const validator = new BackendTokenValidator(backend);
    await validator.validate("alice-token");
    await validator.validate("bob-token");
    assert.equal(backend.callsTo("mcp-whoami").length, 2);
});

for (const status of [401, 403]) {
    test(`a ${status} from the backend is reported as a rejected token`, async () => {
        const backend = new FakePenpotBackend().fail(
            "mcp-whoami",
            new BackendRpcError(status, "mcp-whoami", { code: "authentication" })
        );
        const validator = new BackendTokenValidator(backend);
        await assert.rejects(validator.validate("alice-token"), /The MCP token was rejected by the backend/);
    });
}

test("a rejected token is not cached, so a later valid answer is used", async () => {
    let attempts = 0;
    const backend = {
        callCommand: async () => {
            attempts++;
            if (attempts === 1) {
                throw new BackendRpcError(401, "mcp-whoami", undefined);
            }
            return whoami;
        },
    } as unknown as PenpotBackend;
    const validator = new BackendTokenValidator(backend);
    await assert.rejects(validator.validate("alice-token"));
    assert.deepEqual(await validator.validate("alice-token"), whoami);
    assert.equal(attempts, 2);
});

test("other backend failures propagate unchanged", async () => {
    const failure = new BackendRpcError(503, "mcp-whoami", undefined);
    const validator = new BackendTokenValidator(new FakePenpotBackend().fail("mcp-whoami", failure));
    await assert.rejects(validator.validate("alice-token"), (error: unknown) => error === failure);
});

test("concurrent validations of one token share a single backend call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-whoami", whoami);
    const validator = new BackendTokenValidator(backend);
    await Promise.all([validator.validate("alice-token"), validator.validate("alice-token")]);
    assert.equal(backend.callsTo("mcp-whoami").length, 1);
});
