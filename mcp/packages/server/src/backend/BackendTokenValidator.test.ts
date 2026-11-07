import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendRpcError } from "./BackendRpcError";
import { BackendTokenValidator, BackendTooOldError } from "./BackendTokenValidator";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";
import { CallContext, type CallContextData } from "./CallContext";
import { TokenDigest } from "./TokenDigest";
import type { PenpotBackend } from "../PenpotBackendClient";

const whoami = { profileId: "profile-1", scopes: ["mcp:read"], contractVersion: 1 };

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

test("a rejected token is asked again once the 5 second rejection period ends", async () => {
    const clock = new ManualClock();
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
    const validator = new BackendTokenValidator(backend, clock.read);
    await assert.rejects(validator.validate("alice-token"));
    clock.now = 4_999;
    await assert.rejects(validator.validate("alice-token"), /rejected/);
    assert.equal(attempts, 1);
    clock.now = 5_000;
    assert.deepEqual(await validator.validate("alice-token"), whoami);
    assert.equal(attempts, 2);
});

test("a flood of one rejected token within 5 seconds reaches the backend once", async () => {
    const backend = new FakePenpotBackend().fail("mcp-whoami", new BackendRpcError(403, "mcp-whoami", undefined));
    const validator = new BackendTokenValidator(backend);
    for (let i = 0; i < 50; i++) {
        await assert.rejects(validator.validate("random-token"), /rejected/);
    }
    assert.equal(backend.callsTo("mcp-whoami").length, 1);
});

test("a backend without a contract version is refused with the reason", async () => {
    const { contractVersion: _omitted, ...withoutVersion } = whoami;
    const validator = new BackendTokenValidator(new FakePenpotBackend().respond("mcp-whoami", withoutVersion));
    await assert.rejects(validator.validate("alice-token"), /backend too old for backend mode/);
});

test("a backend with an older contract version is refused on every call, and not only the first", async () => {
    const validator = new BackendTokenValidator(
        new FakePenpotBackend().respond("mcp-whoami", { ...whoami, contractVersion: 0 })
    );
    await assert.rejects(validator.validate("alice-token"), BackendTooOldError);
    await assert.rejects(validator.validate("alice-token"), BackendTooOldError);
});

test("a backend at the supported contract version returns its operations and limits", async () => {
    const answer = { ...whoami, operations: ["add-shape", "set-fill"], limits: { maxBatch: 500 } };
    const validator = new BackendTokenValidator(new FakePenpotBackend().respond("mcp-whoami", answer));
    const result = await validator.validate("alice-token");
    assert.deepEqual(result.operations, ["add-shape", "set-fill"]);
    assert.deepEqual(result.limits, { maxBatch: 500 });
});

test("the answer binds the fingerprint of its token id to the current call", async () => {
    const backend = new FakePenpotBackend().respond("mcp-whoami", { ...whoami, tokenId: "token-id-1" });
    const validator = new BackendTokenValidator(backend);
    const call: CallContextData = { requestId: "req-1" };
    await CallContext.run(call, () => validator.validate("alice-token"));
    assert.equal(call.tokenFp, TokenDigest.tokenIdFingerprint("token-id-1"));
    assert.equal(call.tokenFp?.length, 8);
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
