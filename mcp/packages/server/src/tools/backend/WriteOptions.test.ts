import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteOptions } from "./WriteOptions";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a write without a requestId gets a new UUID on every call", () => {
    const first = WriteOptions.toParams({});
    const second = WriteOptions.toParams({});
    assert.match(String(first.requestId), UUID_PATTERN);
    assert.match(String(second.requestId), UUID_PATTERN);
    assert.notEqual(first.requestId, second.requestId);
});

test("a requestId the caller names is sent as given, so that a retry can reuse it", () => {
    const requestId = "5f0c4f7e-7a3b-4c1d-9e2f-0a1b2c3d4e5f";
    assert.equal(WriteOptions.toParams({ requestId }).requestId, requestId);
});

test("the other write options are sent only when they are set", () => {
    const { requestId, ...rest } = WriteOptions.toParams({ dryRun: true, baseRevn: 7 });
    assert.deepEqual(rest, { dryRun: true, baseRevn: 7 });
    assert.match(String(requestId), UUID_PATTERN);
});

test("a result the backend marked as already applied gets a note and keeps the flag", () => {
    const result = WriteOptions.withAlreadyApplied({ revn: 3, alreadyApplied: true }) as Record<string, unknown>;
    assert.equal(result.alreadyApplied, true);
    assert.equal(result.revn, 3);
    assert.match(String(result.note), /already applied by an earlier call with the same requestId/);
});

test("a replay that carries the ids of the first answer says so, and says when they are cut", () => {
    const whole = WriteOptions.withAlreadyApplied({
        revn: 3,
        alreadyApplied: true,
        createdIds: { "$tmp:a": "id" },
    }) as Record<string, unknown>;
    assert.deepEqual(whole.createdIds, { "$tmp:a": "id" });
    assert.match(String(whole.note), /createdIds and opResults are those of the first answer/);
    assert.doesNotMatch(String(whole.note), /too large to keep whole/);
    const cut = WriteOptions.withAlreadyApplied({
        revn: 3,
        alreadyApplied: true,
        createdIds: {},
        replayTruncated: true,
    }) as Record<string, unknown>;
    assert.equal(cut.replayTruncated, true);
    assert.match(String(cut.note), /too large to keep whole/);
});

test("a replay without ids carries no sentence about them", () => {
    const result = WriteOptions.withAlreadyApplied({ revn: 3, alreadyApplied: true }) as Record<string, unknown>;
    assert.doesNotMatch(String(result.note), /first answer/);
});

test("a result that was applied now is returned unchanged", () => {
    const result = { revn: 3, createdIds: {} };
    assert.equal(WriteOptions.withAlreadyApplied(result), result);
});

test("a result that is not an object is returned unchanged", () => {
    assert.equal(WriteOptions.withAlreadyApplied("done"), "done");
    assert.equal(WriteOptions.withAlreadyApplied(undefined), undefined);
});
