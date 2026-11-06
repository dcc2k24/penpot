import assert from "node:assert/strict";
import { test } from "node:test";
import { Transit } from "./Transit";

test("encodes keywords, uuids, maps and nested arrays in verbose form", () => {
    const encoded = Transit.encode({
        cmd: Transit.keyword("export-shapes"),
        "profile-id": Transit.uuid("1b2c3d4e-0000-4000-8000-000000000002"),
        wait: true,
        exports: [{ type: Transit.keyword("png"), suffix: "", scale: 1 }],
    });
    assert.equal(
        encoded,
        '["^ ","~:cmd","~:export-shapes","~:profile-id","~u1b2c3d4e-0000-4000-8000-000000000002","~:wait",true,"~:exports",[["^ ","~:type","~:png","~:suffix","","~:scale",1]]]'
    );
});

test("round trips nested plain data", () => {
    const value = {
        "file-id": "abc",
        count: 3,
        ratio: 0.5,
        negative: -2,
        ok: false,
        nothing: null,
        items: [1, "two", null, [true]],
        nested: { "page-id": "p1", tags: ["a", "b"], deeper: { depth: -2 } },
    };
    assert.deepStrictEqual(Transit.decode(Transit.encode(value)), value);
});

test("escapes strings that start with ~, ^ or a backtick", () => {
    assert.equal(Transit.encode("~x"), '"~~x"');
    assert.equal(Transit.decode('"~~x"'), "~x");
    assert.equal(Transit.encode("^caret"), '"~^caret"');
    assert.equal(Transit.decode('"~^caret"'), "^caret");
    assert.equal(Transit.encode("`tick"), '"~`tick"');
    assert.equal(Transit.decode('"~`tick"'), "`tick");
});

test("decodes keywords and uuids to their names and text", () => {
    assert.deepStrictEqual(Transit.decode('["^ ","~:name","~:png","~:id","~u1b2c3d4e-0000-4000-8000-000000000002"]'), {
        name: "png",
        id: "1b2c3d4e-0000-4000-8000-000000000002",
    });
});

test("decodes a realistic exporter error", () => {
    assert.deepStrictEqual(
        Transit.decode(
            '["^ ","~:type","~:authentication","~:code","~:authentication","~:hint","Authentication required"]'
        ),
        {
            type: "authentication",
            code: "authentication",
            hint: "Authentication required",
        }
    );
});

test("decodes the fixed escapes and numbers", () => {
    assert.equal(Transit.decode('"~?t"'), true);
    assert.equal(Transit.decode('"~?f"'), false);
    assert.equal(Transit.decode('"~_"'), null);
    assert.equal(Transit.decode('"~i42"'), 42);
    assert.equal(Transit.decode('"~d1.5"'), 1.5);
});

test("decodes keys through the same string rules", () => {
    assert.deepStrictEqual(Transit.decode('["^ ","~:a",1,"b",2]'), { a: 1, b: 2 });
});

test("keeps a __proto__ key as an own property", () => {
    const decoded = Transit.decode('["^ ","~:__proto__","x"]');
    assert.deepStrictEqual(Object.keys(decoded as object), ["__proto__"]);
});

test("omits undefined object entries and turns undefined array items into null", () => {
    assert.equal(Transit.encode({ a: undefined, b: 1 }), '["^ ","~:b",1]');
    assert.equal(Transit.encode([undefined, 1]), "[null,1]");
    assert.equal(Transit.encode(undefined), "null");
});

test("encodes plain objects with a null prototype", () => {
    const value: Record<string, unknown> = Object.create(null);
    value["file-id"] = "f1";
    assert.equal(Transit.encode(value), '["^ ","~:file-id","f1"]');
});

test("throws for values transit cannot encode", () => {
    assert.throws(() => Transit.encode(new Date()), /cannot encode value of type Date/);
    assert.throws(() => Transit.encode(new Uint8Array(2)), /Uint8Array/);
    assert.throws(() => Transit.encode(NaN), /non-finite/);
    assert.throws(() => Transit.encode(Infinity), /non-finite/);
    assert.throws(() => Transit.encode(new Map()), /Map/);
    assert.throws(() => Transit.encode(() => 1), /function/);
    assert.throws(() => Transit.encode(Symbol("s")), /symbol/);
    assert.throws(() => Transit.encode(BigInt(1)), /bigint/);
    assert.throws(() => Transit.encode({ "~x": 1 }), /must not start with/);
    assert.throws(() => Transit.encode({ "^x": 1 }), /must not start with/);
});

test("throws for transit text outside the supported forms", () => {
    assert.throws(() => Transit.decode('["~#foo",1,2]'), /unsupported transit tag/);
    assert.throws(() => Transit.decode('"^0"'), /unsupported transit cache reference/);
    assert.throws(() => Transit.decode('"~zfoo"'), /unsupported transit escape/);
    assert.throws(() => Transit.decode('["^ ","~i1","x"]'), /key must be a string/);
    assert.throws(() => Transit.decode('["^ ","~:a"]'), /key without a value/);
    assert.throws(() => Transit.decode('{"~#foo":1,"~:b":2}'), /unsupported transit escape/);
});

const VERBOSE_ANSWER =
    '{"~:mtype":"image/png","~:name":"export","~:filename":"export.png","~:id":"~ub7a8c5da-5765-8008-8008-e4e12150945d","~:uri":{"~#uri":"http://localhost:9002/assets/by-id/8559e494-c794-4f89-bbcc-b9847ce9af00"}}';
const NON_VERBOSE_ANSWER =
    '["^ ","~:mtype","image/png","~:name","export","~:filename","export.png","~:id","~ub7a8c5da-5765-8008-8008-e4e12150945d","~:uri",["~#uri","http://localhost:9002/assets/by-id/8559e494-c794-4f89-bbcc-b9847ce9af00"]]';
const ANSWER = {
    mtype: "image/png",
    name: "export",
    filename: "export.png",
    id: "b7a8c5da-5765-8008-8008-e4e12150945d",
    uri: "http://localhost:9002/assets/by-id/8559e494-c794-4f89-bbcc-b9847ce9af00",
};

test("decodes the verbose form of an exporter answer", () => {
    assert.deepStrictEqual(Transit.decode(VERBOSE_ANSWER), ANSWER);
});

test("decodes the non-verbose form of an exporter answer to the same object", () => {
    assert.deepStrictEqual(Transit.decode(NON_VERBOSE_ANSWER), ANSWER);
});

test("reads the read cache in reading order, through keys and tag heads", () => {
    assert.deepStrictEqual(Transit.decode('["^ ","~:a-key","x","~:b-key","^0"]'), { "a-key": "x", "b-key": "a-key" });
    // cache: 0 "~:tag-key", 1 "~#foo" (the tag head), 2 "~:next-key", 3 "~:third-key".
    assert.deepStrictEqual(Transit.decode('["^ ","~:tag-key",["~#foo",1],"~:next-key","^0","~:third-key","^2"]'), {
        "tag-key": { tag: "foo", value: 1 },
        "next-key": "tag-key",
        "third-key": "next-key",
    });
});

test("resolves a two-character cache code", () => {
    const entries: unknown[] = [];
    for (let index = 0; index < 44; index++) {
        entries.push(`~:k${index}`, index);
    }
    entries.push("~:k44", "^10");
    const decoded = Transit.decode(JSON.stringify(["^ ", ...entries])) as Record<string, unknown>;
    assert.equal(decoded.k44, "k44");
});

test("throws for a cache reference outside the cache", () => {
    assert.throws(() => Transit.decode('["^ ","~:a-key","^5"]'), /unsupported transit cache reference/);
});

test("decodes an unknown verbose tag to its name and value", () => {
    assert.deepStrictEqual(Transit.decode('{"~:v":{"~#foo":1}}'), { v: { tag: "foo", value: 1 } });
});

test("decodes the millisecond and text escapes", () => {
    assert.equal(Transit.decode('"~m0"'), "1970-01-01T00:00:00.000Z");
    assert.equal(Transit.decode('"~m-1000"'), "1969-12-31T23:59:59.000Z");
    assert.equal(Transit.decode('"~tabc"'), "abc");
});

test("decodes an empty verbose object to an empty object", () => {
    assert.deepStrictEqual(Transit.decode("{}"), {});
});

test("accepts upper-case uuid text and returns it unchanged", () => {
    const value = "1B2C3D4E-0000-4000-8000-00000000000A";
    assert.equal(Transit.uuid(value).value, value);
    assert.equal(Transit.encode(Transit.uuid(value)), `"~u${value}"`);
});

test("throws for a uuid that is not canonical", () => {
    assert.throws(() => Transit.uuid("not-a-uuid"), /not a canonical uuid/);
    assert.throws(() => Transit.uuid("1b2c3d4e00004000800000000000000002"), /not a canonical uuid/);
});
