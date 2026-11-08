import assert from "node:assert/strict";
import { test } from "node:test";
import { failureOf, jsonRpcErrorBody } from "./RequestErrors";

test("an oversized body is a 413 with a short JSON-RPC message", () => {
    assert.deepEqual(failureOf({ type: "entity.too.large", status: 413 }), {
        status: 413,
        code: -32600,
        message: "request body too large",
    });
});

test("a body that is not JSON is a 400 parse error", () => {
    assert.deepEqual(failureOf({ type: "entity.parse.failed", status: 400 }), {
        status: 400,
        code: -32700,
        message: "invalid JSON",
    });
});

test("another client error keeps its status and names no detail", () => {
    assert.deepEqual(failureOf({ status: 404, message: "Cannot GET /x at /home/u/app.js" }), {
        status: 404,
        code: -32600,
        message: "invalid request",
    });
});

test("any other error is a 500 internal error, whatever its message says", () => {
    assert.deepEqual(failureOf(new Error("C:\dev\secret\file.ts exploded")), {
        status: 500,
        code: -32603,
        message: "internal error",
    });
});

test("the JSON-RPC body carries the code and message only, with no stack", () => {
    const body = JSON.stringify(jsonRpcErrorBody({ status: 413, code: -32600, message: "request body too large" }));
    assert.equal(body, '{"jsonrpc":"2.0","error":{"code":-32600,"message":"request body too large"},"id":null}');
    assert.equal(body.includes("at "), false);
});
