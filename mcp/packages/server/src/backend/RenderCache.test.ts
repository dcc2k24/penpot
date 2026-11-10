import assert from "node:assert/strict";
import { test } from "node:test";
import { RENDER_CACHE_TTL_MS, RenderCache } from "./RenderCache";

const MB = 1024 * 1024;

/**
 * Builds a render of a given size.
 *
 * @param size - number of bytes
 * @param fill - the byte that fills the render, which tells renders apart
 */
function render(size: number, fill = 1) {
    return { bytes: new Uint8Array(size).fill(fill), mimeType: "image/png" };
}

/**
 * Builds a key for a shape of the test file at a revision.
 *
 * @param shapeId - the shape id
 * @param revn - the file revision
 * @param renderer - the renderer
 * @param pageId - the page of the shape
 */
function key(shapeId: string, revn = 1, renderer = "browser", pageId = "page-1"): string {
    return RenderCache.keyOf({ fileId: "file-1", revn, pageId, shapeId, format: "png", scale: 1, renderer });
}

test("a stored render is a hit and carries its bytes and media type", () => {
    const cache = new RenderCache(MB);
    cache.put(key("a"), render(10, 7));
    const found = cache.get(key("a"));
    assert.ok(found);
    assert.equal(found.bytes[0], 7);
    assert.equal(found.mimeType, "image/png");
});

test("a key that was never stored is a miss", () => {
    const cache = new RenderCache(MB);
    cache.put(key("a"), render(10));
    assert.equal(cache.get(key("b")), undefined);
});

test("a different revision, page, format, scale or renderer is a miss", () => {
    const cache = new RenderCache(MB);
    cache.put(key("a", 1), render(10));
    assert.equal(cache.get(key("a", 2)), undefined);
    assert.equal(cache.get(key("a", 1, "wasm")), undefined);
    assert.equal(cache.get(key("a", 1, "browser", "page-2")), undefined);
    assert.equal(
        cache.get(
            RenderCache.keyOf({
                fileId: "file-1",
                revn: 1,
                pageId: "page-1",
                shapeId: "a",
                format: "png",
                scale: 2,
                renderer: "browser",
            })
        ),
        undefined
    );
    assert.equal(
        cache.get(
            RenderCache.keyOf({
                fileId: "file-1",
                revn: 1,
                pageId: "page-1",
                shapeId: "a",
                format: "svg",
                scale: 1,
                renderer: "browser",
            })
        ),
        undefined
    );
    assert.ok(cache.get(key("a", 1)));
});

test("the key joins the file, revision, page, shape, format, scale and renderer with bars", () => {
    assert.equal(key("shape-9", 4, "wasm", "page-7"), "file-1|4|page-7|shape-9|png|1|wasm");
});

test("the least recently used render is dropped first when the budget is passed", () => {
    const cache = new RenderCache(30);
    cache.put("a", render(10));
    cache.put("b", render(10));
    cache.put("c", render(10));
    assert.ok(cache.get("a"));
    cache.put("d", render(10));
    assert.equal(cache.get("b"), undefined, "b was the least recently used");
    assert.ok(cache.get("a"));
    assert.ok(cache.get("c"));
    assert.ok(cache.get("d"));
    assert.equal(cache.bytes, 30);
});

test("eviction drops as many renders as needed to fit a large new one", () => {
    const cache = new RenderCache(30);
    cache.put("a", render(10));
    cache.put("b", render(10));
    cache.put("c", render(10));
    cache.put("big", render(25));
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), undefined);
    assert.ok(cache.get("big"));
    assert.equal(cache.bytes, 25);
});

test("a render larger than the whole budget is not kept and does not drop the others", () => {
    const cache = new RenderCache(30);
    cache.put("a", render(10));
    cache.put("huge", render(31));
    assert.equal(cache.get("huge"), undefined);
    assert.ok(cache.get("a"));
    assert.equal(cache.bytes, 10);
});

test("a budget of zero turns the cache off: nothing is stored", () => {
    const cache = new RenderCache(0);
    assert.equal(cache.enabled, false);
    cache.put("a", render(1));
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.bytes, 0);
});

test("putting a key again replaces its render and its bytes", () => {
    const cache = new RenderCache(MB);
    cache.put("a", render(100, 1));
    cache.put("a", render(10, 2));
    assert.equal(cache.bytes, 10);
    assert.equal(cache.get("a")?.bytes[0], 2);
});

test("a use moves a render to the newest place, so a later eviction spares it", () => {
    const cache = new RenderCache(20);
    cache.put("a", render(10));
    cache.put("b", render(10));
    cache.get("a");
    cache.put("c", render(10));
    assert.ok(cache.get("a"));
    assert.equal(cache.get("b"), undefined);
});

test("a render older than fifteen minutes is a miss and is dropped", () => {
    let now = 1_000;
    const cache = new RenderCache(MB, RENDER_CACHE_TTL_MS, () => now);
    cache.put("a", render(10));
    now += RENDER_CACHE_TTL_MS - 1;
    assert.ok(cache.get("a"), "still fresh just before the limit");
    now += 1;
    assert.equal(cache.get("a"), undefined, "a miss at the limit");
    assert.equal(cache.bytes, 0, "the old render is dropped");
});

test("delete drops one render and frees its bytes", () => {
    const cache = new RenderCache(MB);
    cache.put("a", render(10));
    cache.put("b", render(20));
    cache.delete("a");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.bytes, 20);
    cache.delete("missing");
    assert.equal(cache.bytes, 20);
});

test("the capacity is the budget in bytes", () => {
    assert.equal(new RenderCache(MB).capacity, MB);
    assert.equal(new RenderCache(0).capacity, 0);
});
