import assert from "node:assert/strict";
import { test } from "node:test";
import { type CatalogueToken, TokenResolver } from "./TokenResolver";

/** Id of the set that the helpers put tokens in when a test names no set. */
const BASE = "base";

/** One token for the helpers, where the set and the type may be left out. */
interface Entry {
    name: string;
    value: unknown;
    type?: string;
    setId?: string;
}

/**
 * Converts a helper entry to a catalogue token.
 *
 * @param entry - the entry to convert
 * @returns the token, in the base set and of type `spacing` unless the entry says otherwise
 */
function toToken(entry: Entry): CatalogueToken {
    return { setId: entry.setId ?? BASE, name: entry.name, type: entry.type ?? "spacing", value: entry.value };
}

/**
 * Builds a resolver whose only set is active and holds the entries.
 *
 * @param entries - the tokens of the set
 * @returns the resolver
 */
function resolverOf(entries: Entry[]): TokenResolver {
    return new TokenResolver([{ id: BASE, active: true }], entries.map(toToken));
}

test("a dimension string with a px unit resolves to a number", () => {
    const resolver = resolverOf([{ name: "spacing.base", value: "8px" }]);
    assert.equal(resolver.resolve("spacing.base"), 8);
});

test("a plain numeric string and a number resolve to numbers", () => {
    const resolver = resolverOf([
        { name: "opacity.half", value: "0.5" },
        { name: "rotation.quarter", value: 90 },
    ]);
    assert.equal(resolver.resolve("opacity.half"), 0.5);
    assert.equal(resolver.resolve("rotation.quarter"), 90);
});

test("a colour passes through unchanged", () => {
    const resolver = resolverOf([{ name: "color.brand", value: "#ff8800" }]);
    assert.equal(resolver.resolve("color.brand"), "#ff8800");
});

test("a structured value passes through unchanged", () => {
    const shadow = [{ offsetX: 0, offsetY: 2 }];
    const resolver = resolverOf([{ name: "shadow.card", value: shadow }]);
    assert.deepEqual(resolver.resolve("shadow.card"), shadow);
});

test("a reference is followed through the catalogue", () => {
    const resolver = resolverOf([
        { name: "spacing.large", value: "{spacing.base}" },
        { name: "spacing.base", value: "{spacing.unit}" },
        { name: "spacing.unit", value: "4px" },
    ]);
    assert.equal(resolver.resolve("spacing.large"), 4);
});

test("a reference chain of exactly the limit resolves", () => {
    const tokens: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < TokenResolver.MAX_HOPS; i++) {
        tokens.push({ name: `t${i}`, value: `{t${i + 1}}` });
    }
    tokens.push({ name: `t${TokenResolver.MAX_HOPS}`, value: "12px" });
    assert.equal(resolverOf(tokens).resolve("t0"), 12);
});

test("a reference chain longer than the limit fails", () => {
    const tokens: Array<{ name: string; value: string }> = [];
    for (let i = 0; i <= TokenResolver.MAX_HOPS; i++) {
        tokens.push({ name: `t${i}`, value: `{t${i + 1}}` });
    }
    tokens.push({ name: `t${TokenResolver.MAX_HOPS + 1}`, value: "12px" });
    assert.throws(() => resolverOf(tokens).resolve("t0"), /more than 20 references/);
});

test("a reference cycle fails with the token name", () => {
    const resolver = resolverOf([
        { name: "a", value: "{b}" },
        { name: "b", value: "{a}" },
    ]);
    assert.throws(() => resolver.resolve("a"), /reference cycle/);
});

test("a missing token or a missing reference fails with its name", () => {
    const resolver = resolverOf([{ name: "a", value: "{missing.token}" }]);
    assert.throws(() => resolver.resolve("nope"), /token "nope" was not found in the file/);
    assert.throws(() => resolver.resolve("a"), /token "missing.token" was not found in the file/);
});

test("the first token of a name wins within one set", () => {
    const resolver = resolverOf([
        { name: "gap", value: "4px" },
        { name: "gap", value: "8px" },
    ]);
    assert.equal(resolver.resolve("gap"), 4);
});

test("a token of an inactive set is ignored, even when its set is listed first", () => {
    const resolver = new TokenResolver(
        [
            { id: "brand", active: false },
            { id: BASE, active: true },
        ],
        [toToken({ name: "gap", value: "8px", setId: "brand" }), toToken({ name: "gap", value: "4px", setId: BASE })]
    );
    assert.equal(resolver.resolve("gap"), 4);
});

test("a later active set wins over an earlier active set", () => {
    const resolver = new TokenResolver(
        [
            { id: BASE, active: true },
            { id: "brand", active: true },
        ],
        [toToken({ name: "gap", value: "4px", setId: BASE }), toToken({ name: "gap", value: "8px", setId: "brand" })]
    );
    assert.equal(resolver.resolve("gap"), 8);
});

test("a name present only in an inactive set fails", () => {
    const resolver = new TokenResolver(
        [
            { id: BASE, active: true },
            { id: "brand", active: false },
        ],
        [toToken({ name: "brand.only", value: "12px", setId: "brand" })]
    );
    assert.throws(() => resolver.resolve("brand.only"), {
        message: 'token "brand.only" is not in an active set',
    });
});

test("typeOf prefers the active set over an earlier inactive set", () => {
    const resolver = new TokenResolver(
        [
            { id: "brand", active: false },
            { id: BASE, active: true },
        ],
        [
            toToken({ name: "x", value: "#000000", type: "color", setId: "brand" }),
            toToken({ name: "x", value: "4px", type: "spacing", setId: BASE }),
        ]
    );
    assert.equal(resolver.typeOf("x"), "spacing");
});

test("typeOf of a name present only in an inactive set reads that set", () => {
    const resolver = new TokenResolver(
        [
            { id: BASE, active: true },
            { id: "brand", active: false },
        ],
        [toToken({ name: "brand.main", value: "#ff8800", type: "color", setId: "brand" })]
    );
    assert.equal(resolver.typeOf("brand.main"), "color");
});

test("typeOf of a missing name throws", () => {
    assert.throws(() => resolverOf([]).typeOf("nope"), /token "nope" was not found in the file/);
});

test("units: px gives the number, rem uses the base font size, and % gives the fraction", () => {
    const resolver = resolverOf([
        { name: "a", value: "4px" },
        { name: "b", value: "1.5rem" },
        { name: "c", value: "50%" },
    ]);
    assert.equal(resolver.resolve("a"), 4);
    assert.equal(resolver.resolve("b"), 24);
    assert.equal(resolver.resolve("c"), 0.5);
});

test("a reference inside an arithmetic expression is resolved", () => {
    const resolver = resolverOf([
        { name: "spacing.base", value: "8px" },
        { name: "spacing.double", value: "{spacing.base} * 2" },
    ]);
    assert.equal(resolver.resolve("spacing.double"), 16);
});

test("parentheses group an arithmetic expression", () => {
    const resolver = resolverOf([
        { name: "a", value: "8px" },
        { name: "half", value: "({a} + 4) / 2" },
    ]);
    assert.equal(resolver.resolve("half"), 6);
});

test("an expression may hold units and a percentage", () => {
    const resolver = resolverOf([{ name: "opacity.double", value: "50% * 2" }]);
    assert.equal(resolver.resolve("opacity.double"), 1);
});

test("division by zero throws", () => {
    const resolver = resolverOf([{ name: "broken", value: "1 / 0" }]);
    assert.throws(() => resolver.resolve("broken"), /divides by zero/);
});

test("a function call is an unsupported expression", () => {
    const resolver = resolverOf([{ name: "f", value: "sum(1,2)" }]);
    assert.throws(() => resolver.resolve("f"), {
        message: 'unsupported token expression "sum(1,2)"',
    });
});

test("an incomplete expression is an unsupported expression", () => {
    const resolver = resolverOf([{ name: "f", value: "1 +" }]);
    assert.throws(() => resolver.resolve("f"), {
        message: 'unsupported token expression "1 +"',
    });
});

test("a reference cycle inside an expression still throws", () => {
    const resolver = resolverOf([
        { name: "a", value: "{b} + 1" },
        { name: "b", value: "{a} * 2" },
    ]);
    assert.throws(() => resolver.resolve("a"), /reference cycle/);
});

test("strings that only look like expressions pass through unchanged", () => {
    const resolver = resolverOf([
        { name: "color.rgb", value: "rgb(255, 0, 0)" },
        { name: "font.weight", value: "700 Italic" },
        { name: "font.family", value: "Inter (Variable)" },
    ]);
    assert.equal(resolver.resolve("color.rgb"), "rgb(255, 0, 0)");
    assert.equal(resolver.resolve("font.weight"), "700 Italic");
    assert.equal(resolver.resolve("font.family"), "Inter (Variable)");
});

test("fromCatalogue reads the name and value of each token of the get-mcp-tokens answer", () => {
    const resolver = TokenResolver.fromCatalogue({
        sets: [{ id: "s1", name: "Base", active: true, tokenCount: 1 }],
        themes: [],
        tokens: [{ setId: "s1", id: "t1", name: "radius.card", type: "borderRadius", value: "6px" }],
        activeThemes: [],
        activeSets: [],
    });
    assert.equal(resolver.resolve("radius.card"), 6);
});

test("fromCatalogue treats a set listed in activeSets as active", () => {
    const resolver = TokenResolver.fromCatalogue({
        sets: [{ id: "s1", name: "Base", active: false, tokenCount: 1 }],
        themes: [],
        tokens: [{ setId: "s1", id: "t1", name: "radius.card", type: "borderRadius", value: "6px" }],
        activeThemes: [],
        activeSets: ["s1"],
    });
    assert.equal(resolver.resolve("radius.card"), 6);
});

test("fromCatalogue fails for a set that is neither flagged nor listed as active", () => {
    const resolver = TokenResolver.fromCatalogue({
        sets: [{ id: "s2", name: "Brand", active: false, tokenCount: 1 }],
        themes: [],
        tokens: [{ setId: "s2", id: "t2", name: "radius.card", type: "borderRadius", value: "6px" }],
        activeThemes: [],
        activeSets: [],
    });
    assert.throws(() => resolver.resolve("radius.card"), /is not in an active set/);
});

test("fromCatalogue of an answer without tokens knows no token", () => {
    assert.throws(() => TokenResolver.fromCatalogue(undefined).resolve("a"), /was not found/);
});
