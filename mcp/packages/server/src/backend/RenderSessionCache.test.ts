import assert from "node:assert/strict";
import { test } from "node:test";
import { RenderSessionCache } from "./RenderSessionCache";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";

/** Lifetime of the render sessions issued by the fake backend, in milliseconds. */
const LIFETIME_MS = 600_000;

/**
 * Returns a fake backend that issues numbered tokens (rs-1, rs-2, ...) expiring one lifetime after the clock reading.
 *
 * @param clock - clock read at each mint
 */
function issuingBackend(clock: () => number): FakePenpotBackend {
    let counter = 0;
    return new FakePenpotBackend().respond("create-mcp-render-session", () => {
        counter += 1;
        return { token: `rs-${counter}`, expiresAt: new Date(clock() + LIFETIME_MS).toISOString() };
    });
}

test("the first call mints and a second call inside the lifetime reuses the token", async () => {
    let t = 0;
    const backend = issuingBackend(() => t);
    const cache = new RenderSessionCache(backend, () => t);
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    t = 60_000;
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    const calls = backend.callsTo("create-mcp-render-session");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userToken, "alice-token");
    assert.deepEqual(calls[0].params, { fileId: "file-1" });
});

test("a token is reused until 60 seconds before expiry and minted again at that instant", async () => {
    let t = 0;
    const backend = issuingBackend(() => t);
    const cache = new RenderSessionCache(backend, () => t);
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    t = LIFETIME_MS - RenderSessionCache.REFRESH_MARGIN_MS - 1;
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    assert.equal(backend.callsTo("create-mcp-render-session").length, 1);
    t = LIFETIME_MS - RenderSessionCache.REFRESH_MARGIN_MS;
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-2");
    assert.equal(backend.callsTo("create-mcp-render-session").length, 2);
});

test("a different file or a different user token mints separately", async () => {
    const now = (): number => 0;
    const backend = issuingBackend(now);
    const cache = new RenderSessionCache(backend, now);
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    assert.equal(await cache.tokenFor("alice-token", "file-2"), "rs-2");
    assert.equal(await cache.tokenFor("bob-token", "file-1"), "rs-3");
    assert.equal(backend.callsTo("create-mcp-render-session").length, 3);
});

test("concurrent requests for the same key share one mint", async () => {
    const now = (): number => 0;
    const backend = issuingBackend(now);
    const cache = new RenderSessionCache(backend, now);
    const tokens = await Promise.all([
        cache.tokenFor("alice-token", "file-1"),
        cache.tokenFor("alice-token", "file-1"),
        cache.tokenFor("alice-token", "file-1"),
    ]);
    assert.deepEqual(tokens, ["rs-1", "rs-1", "rs-1"]);
    assert.equal(backend.callsTo("create-mcp-render-session").length, 1);
});

test("a failed mint is not cached, so the next call mints again", async () => {
    let attempts = 0;
    const backend = new FakePenpotBackend().respond("create-mcp-render-session", () => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("backend unavailable");
        }
        return { token: "rs-2", expiresAt: new Date(LIFETIME_MS).toISOString() };
    });
    const cache = new RenderSessionCache(backend, () => 0);
    await assert.rejects(cache.tokenFor("alice-token", "file-1"), /backend unavailable/);
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-2");
    assert.equal(backend.callsTo("create-mcp-render-session").length, 2);
});

test("invalidate drops the session so that the next call mints again", async () => {
    const now = (): number => 0;
    const backend = issuingBackend(now);
    const cache = new RenderSessionCache(backend, now);
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-1");
    cache.invalidate("alice-token", "file-1");
    assert.equal(await cache.tokenFor("alice-token", "file-1"), "rs-2");
    assert.equal(backend.callsTo("create-mcp-render-session").length, 2);
});

const malformedAnswers: Array<{ label: string; answer: unknown }> = [
    { label: "no token", answer: { expiresAt: new Date(LIFETIME_MS).toISOString() } },
    { label: "a token that is not a string", answer: { token: 42, expiresAt: new Date(LIFETIME_MS).toISOString() } },
    { label: "an unparsable expiresAt", answer: { token: "rs-1", expiresAt: "soon" } },
    { label: "no answer at all", answer: undefined },
];

for (const { label, answer } of malformedAnswers) {
    test(`an answer with ${label} makes tokenFor throw`, async () => {
        const backend = new FakePenpotBackend().respond("create-mcp-render-session", answer);
        const cache = new RenderSessionCache(backend, () => 0);
        await assert.rejects(
            cache.tokenFor("alice-token", "file-1"),
            /The backend returned no usable render session\./
        );
    });
}
