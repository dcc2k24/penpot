import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenDigest } from "../../backend/TokenDigest";
import { TokenResolver } from "../../sandbox/TokenResolver";
import { TokenCatalogueCache } from "./TokenCatalogueCache";

const TOKEN = "ivan-token-secret";

/** A token set with no tokens, distinct per call so that identity can be checked. */
function resolverNamed(name: string): TokenResolver {
    return TokenResolver.fromCatalogue({ sets: [], themes: [], tokens: [], activeThemes: [], activeSets: [], name });
}

test("a token set is reused for the write count it was read at", () => {
    const cache = new TokenCatalogueCache(30_000, 10, () => 0);
    const resolver = resolverNamed("a");
    cache.store("key", 5, resolver);
    assert.equal(cache.lookup("key", 5), resolver);
    assert.equal(cache.lookup("key", 6), undefined, "a write since the read makes it stale");
});

test("a token set is dropped after the time to live", () => {
    let now = 0;
    const cache = new TokenCatalogueCache(30_000, 10, () => now);
    cache.store("key", 1, resolverNamed("a"));
    now = 29_999;
    assert.notEqual(cache.lookup("key", 1), undefined);
    now = 30_000;
    assert.equal(cache.lookup("key", 1), undefined);
});

test("the table never holds more entries than its capacity", () => {
    const cache = new TokenCatalogueCache(30_000, 3, () => 0);
    for (let index = 0; index < 50; index++) {
        cache.store(`file-${index}`, 1, resolverNamed(`${index}`));
    }
    assert.equal(cache.size, 3);
    assert.notEqual(cache.lookup("file-49", 1), undefined);
    assert.equal(cache.lookup("file-0", 1), undefined, "the oldest entries were dropped");
});

test("the least recently used entry is dropped first, and a lookup counts as a use", () => {
    const cache = new TokenCatalogueCache(30_000, 3, () => 0);
    cache.store("a", 1, resolverNamed("a"));
    cache.store("b", 1, resolverNamed("b"));
    cache.store("c", 1, resolverNamed("c"));
    assert.notEqual(cache.lookup("a", 1), undefined, "a is used again");
    cache.store("d", 1, resolverNamed("d"));
    assert.notEqual(cache.lookup("a", 1), undefined, "a was used, so it stays");
    assert.equal(cache.lookup("b", 1), undefined, "b was the least recently used");
});

test("a store prunes the expired entries, even when nothing is looked up", () => {
    let now = 0;
    const cache = new TokenCatalogueCache(10, 10, () => now);
    cache.store("old", 1, resolverNamed("old"));
    now = 20;
    cache.store("new", 1, resolverNamed("new"));
    assert.equal(cache.size, 1);
});

test("the size getter counts the kept entries", () => {
    const cache = new TokenCatalogueCache(30_000, 10, () => 0);
    assert.equal(cache.size, 0);
    cache.store("a", 1, resolverNamed("a"));
    cache.store("b", 1, resolverNamed("b"));
    assert.equal(cache.size, 2);
});

test("the key is the token digest and the file id, and never the raw token", () => {
    const key = TokenCatalogueCache.keyOf(TOKEN, "file-1");
    assert.equal(key, `${TokenDigest.sha256Hex(TOKEN)}:file-1`);
    assert.equal(key.includes(TOKEN), false);
    assert.notEqual(TokenCatalogueCache.keyOf("other-token", "file-1"), key, "another token has another key");
});

test("a dump of the cache holds no raw token", () => {
    const cache = new TokenCatalogueCache(30_000, 10, () => 0);
    cache.store(TokenCatalogueCache.keyOf(TOKEN, "file-1"), 1, resolverNamed("a"));
    const entries = (cache as unknown as { entries: Map<string, unknown> }).entries;
    assert.equal(JSON.stringify([...entries.entries()]).includes(TOKEN), false);
});
