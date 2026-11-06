import assert from "node:assert/strict";
import { test } from "node:test";
import { FakePenpotBackend } from "../backend/testing/FakePenpotBackend";
import { ApplyTokenValues, TokenCatalogue } from "./ApplyTokenValues";

const TOKEN = "erin-token";
const FILE = "1b2c3d4e-0000-4000-8000-000000000021";
const PAGE = "1b2c3d4e-0000-4000-8000-000000000022";
const SHAPE = "1b2c3d4e-0000-4000-8000-000000000023";

/** The token catalogue of the test file, as `get-mcp-tokens` answers it. */
const CATALOGUE = {
    sets: [
        { id: "set-base", active: true },
        { id: "set-off", active: false },
    ],
    tokens: [
        { setId: "set-base", name: "spacing.base", type: "spacing", value: "8px" },
        { setId: "set-base", name: "spacing.large", type: "spacing", value: "{spacing.base}" },
        { setId: "set-base", name: "loop.a", type: "spacing", value: "{loop.b}" },
        { setId: "set-base", name: "loop.b", type: "spacing", value: "{loop.a}" },
        { setId: "set-off", name: "spacing.off", type: "spacing", value: "4px" },
    ],
    activeSets: ["set-base"],
};

/** Builds an `apply_token` operation for the test shape. */
function applyToken(tokenName: string, resolvedValue?: unknown): Record<string, unknown> {
    const operation: Record<string, unknown> = {
        op: "apply_token",
        pageId: PAGE,
        shapeIds: [SHAPE],
        tokenName,
        attributes: ["width"],
    };
    if (resolvedValue !== undefined) {
        operation.resolvedValue = resolvedValue;
    }
    return operation;
}

/** Builds the filler, a fake backend that answers the catalogue, and the catalogue of the test file. */
function setup() {
    const backend = new FakePenpotBackend().respond("get-mcp-tokens", CATALOGUE);
    const catalogue = new TokenCatalogue(backend, TOKEN, FILE);
    return { backend, catalogue, values: new ApplyTokenValues("apply_operations", " Pass resolvedValue.") };
}

test("an apply_token without a value gets the value of a plain token", async () => {
    const { backend, catalogue, values } = setup();
    const operations = [applyToken("spacing.base")];

    const warnings = await values.fill(operations, catalogue);

    assert.equal(operations[0].resolvedValue, 8);
    assert.deepEqual(warnings, []);
    assert.deepEqual(backend.callsTo("get-mcp-tokens")[0]?.params, { fileId: FILE });
});

test("an apply_token of a token that references another gets the referenced value", async () => {
    const { catalogue, values } = setup();
    const operations = [applyToken("spacing.large")];

    await values.fill(operations, catalogue);

    assert.equal(operations[0].resolvedValue, 8);
});

test("a supplied value that differs from the token's value is kept, with a warning", async () => {
    const { catalogue, values } = setup();
    const operations = [{ op: "delete_shapes", pageId: PAGE, ids: [SHAPE] }, applyToken("spacing.base", 12)];

    const warnings = await values.fill(operations, catalogue);

    assert.equal(operations[1].resolvedValue, 12);
    assert.equal(warnings.length, 1);
    assert.deepEqual(
        { ...warnings[0], message: undefined },
        {
            kind: "token-value-differs",
            operationIndex: 1,
            tokenName: "spacing.base",
            suppliedValue: 12,
            resolvedValue: 8,
            message: undefined,
        }
    );
});

test("a supplied value equal to the token's value gives no warning", async () => {
    const { catalogue, values } = setup();

    assert.deepEqual(await values.fill([applyToken("spacing.base", 8)], catalogue), []);
});

test("a supplied value of a token that cannot resolve is kept, with an unchecked warning", async () => {
    const { catalogue, values } = setup();
    const operations = [applyToken("missing.token", 3)];

    const warnings = await values.fill(operations, catalogue);

    assert.equal(operations[0].resolvedValue, 3);
    assert.equal(warnings[0]?.kind, "token-value-unchecked");
    assert.match(warnings[0]?.message ?? "", /was not found in the file/);
});

test("an unknown token without a value fails and names the operation", async () => {
    const { catalogue, values } = setup();

    await assert.rejects(values.fill([applyToken("missing.token")], catalogue), {
        message:
            'apply_operations: operation 0 (apply_token) cannot resolve token "missing.token": token ' +
            '"missing.token" was not found in the file. Pass resolvedValue.',
    });
});

test("a reference cycle and a token in an inactive set fail", async () => {
    const { catalogue, values } = setup();

    await assert.rejects(values.fill([applyToken("loop.a")], catalogue), { message: /reference cycle/ });
    await assert.rejects(values.fill([applyToken("spacing.off")], catalogue), { message: /not in an active set/ });
});

test("the catalogue is read once for several apply_token operations, and not at all without one", async () => {
    const { backend, catalogue, values } = setup();

    await values.fill([{ op: "delete_shapes", pageId: PAGE, ids: [SHAPE] }], catalogue);
    assert.equal(backend.callsTo("get-mcp-tokens").length, 0);

    await values.fill([applyToken("spacing.base"), applyToken("spacing.large")], catalogue);
    assert.equal(backend.callsTo("get-mcp-tokens").length, 1);
});

test("an apply_token without a value after a token write in the same batch fails", async () => {
    const { backend, catalogue, values } = setup();
    const operations = [{ op: "update_token", setId: "set-base", id: "t1", value: "10px" }, applyToken("spacing.base")];

    await assert.rejects(values.fill(operations, catalogue), {
        message: /operation 1 \(apply_token\) cannot read the value of token "spacing\.base", because operation 0/,
    });
    assert.equal(backend.callsTo("get-mcp-tokens").length, 0);
});

test("changesTokens covers token, set, theme and base font size writes, but not token applications", () => {
    for (const op of ["create_token", "update_token_set", "activate_theme", "toggle_set", "set_base_font_size"]) {
        assert.equal(ApplyTokenValues.changesTokens({ op }), true, op);
    }
    for (const op of ["apply_token", "unapply_token", "create_rect"]) {
        assert.equal(ApplyTokenValues.changesTokens({ op }), false, op);
    }
});

test("a failed catalogue read is not kept", async () => {
    let reads = 0;
    const backend = new FakePenpotBackend().respond("get-mcp-tokens", () => {
        reads += 1;
        if (reads === 1) {
            throw new Error("Backend error: down");
        }
        return CATALOGUE;
    });
    const catalogue = new TokenCatalogue(backend, TOKEN, FILE);

    await assert.rejects(catalogue.resolver(), { message: "Backend error: down" });
    assert.equal((await catalogue.resolver()).resolve("spacing.base"), 8);
    await catalogue.resolver();
    assert.equal(backend.callsTo("get-mcp-tokens").length, 2);
});
