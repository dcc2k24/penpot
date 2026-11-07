import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchShapeChunks, FIRST_CHUNK, type ShapeAnswer } from "./ShapeChunks.js";

/**
 * A fake get_shapes tool. It holds the ids of a page and cuts every answer above `cutAbove` ids, the way the adapter
 * cuts at its size limit: it keeps the first ids of the request and reports truncated.
 *
 * @param pageIds - ids that the page holds
 * @param cutAbove - largest number of ids one answer carries when cut
 */
function fakeShapesTool(pageIds: readonly string[], cutAbove: number) {
    const present = new Set(pageIds);
    const calls: string[][] = [];
    const request = async (ids: string[]): Promise<ShapeAnswer> => {
        calls.push([...ids]);
        const truncated = ids.length > cutAbove;
        const answered = truncated ? ids.slice(0, cutAbove) : ids;
        return {
            shapes: answered.filter((id) => present.has(id)).map((id) => ({ id, type: "rect" })),
            missing: answered.filter((id) => !present.has(id)),
            truncated,
        };
    };
    return { request, calls };
}

/**
 * Builds ids of the form shape-0, shape-1, and so on.
 *
 * @param count - number of ids
 */
function idsOf(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `shape-${index}`);
}

describe("fetchShapeChunks", () => {
    it("reads every shape when the answers are cut, in the order of the ids", async () => {
        const ids = idsOf(200);
        const tool = fakeShapesTool(ids, 30);
        const result = await fetchShapeChunks(ids, tool.request, "page one");
        assert.equal(result.shapes.size, 200);
        assert.deepEqual(result.missing, []);
        assert.deepEqual(
            ids.map((id) => result.shapes.get(id)?.id),
            ids,
            "every id has its shape, in order"
        );
    });

    it("starts with chunks of the first chunk size", async () => {
        const ids = idsOf(100);
        const tool = fakeShapesTool(ids, 1000);
        const result = await fetchShapeChunks(ids, tool.request, "page one");
        assert.equal(FIRST_CHUNK, 40);
        assert.deepEqual(
            tool.calls.map((call) => call.length),
            [40, 40, 20]
        );
        assert.equal(result.shapes.size, 100);
    });

    it("asks again only the ids that a cut answer did not carry, in halves", async () => {
        const ids = idsOf(40);
        const tool = fakeShapesTool(ids, 30);
        await fetchShapeChunks(ids, tool.request, "page one");
        assert.equal(tool.calls[0].length, 40, "the first request is the whole chunk");
        assert.deepEqual(tool.calls[1], ids.slice(30, 35), "the dropped ids go out in a first half");
        assert.deepEqual(tool.calls[2], ids.slice(35, 40), "then in a second half");
        assert.equal(tool.calls.length, 3);
    });

    it("keeps the shapes that a cut answer carried and does not ask for them again", async () => {
        const ids = idsOf(90);
        const tool = fakeShapesTool(ids, 25);
        await fetchShapeChunks(ids, tool.request, "page one");
        const asked = tool.calls.flat();
        const first40 = ids.slice(0, 40);
        for (const id of first40.slice(0, 25)) {
            assert.equal(asked.filter((item) => item === id).length, 1, `${id} asked once`);
        }
    });

    it("reports the ids that the page does not hold, and does not ask for them again", async () => {
        const ids = idsOf(50);
        const tool = fakeShapesTool(ids.slice(0, 45), 1000);
        const result = await fetchShapeChunks(ids, tool.request, "page one");
        assert.deepEqual(result.missing, ids.slice(45));
        assert.equal(result.shapes.size, 45);
    });

    it("reads a shape when the answer is cut to one id at a time", async () => {
        const ids = idsOf(7);
        const tool = fakeShapesTool(ids, 1);
        const result = await fetchShapeChunks(ids, tool.request, "page one");
        assert.equal(result.shapes.size, 7);
    });

    it("fails and names the shape when a single id is still cut", async () => {
        const ids = idsOf(3);
        const tool = fakeShapesTool(ids, 0);
        await assert.rejects(() => fetchShapeChunks(ids, tool.request, "page one"), /shape-0 .*cannot be read/);
    });

    it("makes an empty list of requests for no ids", async () => {
        const tool = fakeShapesTool([], 10);
        const result = await fetchShapeChunks([], tool.request, "page one");
        assert.equal(tool.calls.length, 0);
        assert.equal(result.shapes.size, 0);
    });
});
