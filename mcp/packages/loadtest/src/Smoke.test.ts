import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SMOKE = readFileSync(new URL("../scripts/smoke.mjs", import.meta.url), "utf8");

describe("smoke script", () => {
    test("the get_shapes rect check names the fill and the fields it reads", () => {
        assert.match(SMOKE, /ids: \[rectId\], fields: \["fills", "x", "width"\]/);
    });

    test("execute_code runs on a page of its own, not the main page", () => {
        assert.ok(SMOKE.includes("create_page"));
        assert.ok(SMOKE.includes("pageId: scriptPageId"));
    });

    test("the get_tokens check handles a truncated answer instead of reading tokens from it", () => {
        assert.match(SMOKE, /j\.truncated === true/);
        assert.match(SMOKE, /not verified/);
    });
});
