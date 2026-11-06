import assert from "node:assert/strict";
import { test } from "node:test";
import { ServerSentEvents } from "./ServerSentEvents";

/** Returns the name and data of each parsed event, for compact comparisons. */
function pairs(body: string): [string, string][] {
    return ServerSentEvents.parse(body).map((event) => [event.name, event.data]);
}

test("returns the events in order with their names and data", () => {
    assert.deepEqual(pairs('event: progress\ndata: {"a":1}\n\nevent: end\ndata: {"a":2}\n\n'), [
        ["progress", '{"a":1}'],
        ["end", '{"a":2}'],
    ]);
});

test("names a frame without an event field message", () => {
    assert.deepEqual(pairs("data: plain\n\n"), [["message", "plain"]]);
});

test("resets the event name after each blank line", () => {
    assert.deepEqual(pairs("event: error\n\ndata: 7\n\n"), [["message", "7"]]);
});

test("joins the data lines of one event with newlines", () => {
    assert.deepEqual(pairs("event: end\ndata: first\ndata: second\n\n"), [["end", "first\nsecond"]]);
});

test("counts a trailing event that has no blank line after it", () => {
    assert.deepEqual(pairs("event: error\ndata: only"), [["error", "only"]]);
});

test("ignores comment, id and other fields", () => {
    assert.deepEqual(pairs(": keep-alive\n\nid: 3\nevent: done\ndata: 7\n\n"), [["done", "7"]]);
});

test("returns no events when the body holds none", () => {
    assert.deepEqual(ServerSentEvents.parse(": keep-alive\n\n"), []);
});
