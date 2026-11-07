import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenCatalogue } from "../../sandbox/ApplyTokenValues";
import { FakePenpotBackend } from "../../backend/testing/FakePenpotBackend";
import { TokenCatalogueCache } from "./TokenCatalogueCache";

/** A catalogue that reads nothing until a token is asked for, which is all these tests need. */
function newCatalogue(): TokenCatalogue {
    return new TokenCatalogue(new FakePenpotBackend(), "token", "file");
}

test("a catalogue is reused while the write count of its file is unchanged", () => {
    const cache = new TokenCatalogueCache(30_000, () => 0);
    const first = cache.get("key", 5, newCatalogue);
    const second = cache.get("key", 5, newCatalogue);
    assert.equal(second, first);
});

test("a catalogue is dropped when the write count of its file has changed", () => {
    const cache = new TokenCatalogueCache(30_000, () => 0);
    const first = cache.get("key", 5, newCatalogue);
    const second = cache.get("key", 6, newCatalogue);
    assert.notEqual(second, first);
});

test("a catalogue is dropped after the time to live", () => {
    let now = 0;
    const cache = new TokenCatalogueCache(30_000, () => now);
    const first = cache.get("key", 5, newCatalogue);
    now = 29_999;
    assert.equal(cache.get("key", 5, newCatalogue), first);
    now = 30_000;
    assert.notEqual(cache.get("key", 5, newCatalogue), first);
});

test("catalogues of different keys do not share an entry", () => {
    const cache = new TokenCatalogueCache(30_000, () => 0);
    const one = cache.get("token-one:file", 1, newCatalogue);
    const two = cache.get("token-two:file", 1, newCatalogue);
    assert.notEqual(one, two);
});
