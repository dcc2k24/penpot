import assert from "node:assert/strict";
import { test } from "node:test";
import { AwaitRewriter } from "./AwaitRewriter";

const AWAIT_HINT = "execute_code runs synchronously in backend mode: penpot calls return values directly; remove await";
const ASYNC_HINT =
    "execute_code runs synchronously in backend mode: async functions do not work; write a plain function and call the penpot facade directly";

test("await before a penpot call is removed", () => {
    assert.equal(AwaitRewriter.rewrite("await penpot.waitForLayoutUpdate();"), "      penpot.waitForLayoutUpdate();");
});

test("await before penpotUtils and penpotMgmt calls is removed", () => {
    assert.equal(
        AwaitRewriter.rewrite("const pages = await penpotUtils.getPages();"),
        "const pages =       penpotUtils.getPages();"
    );
    assert.equal(AwaitRewriter.rewrite("return await penpotMgmt.listTeams();"), "return       penpotMgmt.listTeams();");
});

test("await before an export call is removed for any shape variable", () => {
    assert.equal(
        AwaitRewriter.rewrite('const png = await shape.export({ type: "png" });'),
        'const png =       shape.export({ type: "png" });'
    );
    assert.equal(
        AwaitRewriter.rewrite("const data = await penpotUtils.exportImage(shape, 'shape', false);"),
        "const data =       penpotUtils.exportImage(shape, 'shape', false);"
    );
});

test("await before a plain variable or a non-facade call throws the hint", () => {
    assert.throws(() => AwaitRewriter.rewrite("const v = await Promise.resolve(1); return v;"), {
        message: AWAIT_HINT,
    });
    assert.throws(() => AwaitRewriter.rewrite("const r = await fetch(url);"), { message: AWAIT_HINT });
    assert.throws(() => AwaitRewriter.rewrite("const x = await pending;"), { message: AWAIT_HINT });
});

test("an await on a facade member that is not called throws the hint", () => {
    assert.throws(() => AwaitRewriter.rewrite("const p = await penpot.currentPage;"), { message: AWAIT_HINT });
});

test("an async arrow function throws the async hint", () => {
    assert.throws(() => AwaitRewriter.rewrite("const f = async () => penpot.createRectangle();"), {
        message: ASYNC_HINT,
    });
});

test("an async function declaration throws the async hint", () => {
    assert.throws(() => AwaitRewriter.rewrite("async function run() { return penpot.createRectangle(); }"), {
        message: ASYNC_HINT,
    });
});

test("an async function expression and an async method throw the async hint", () => {
    assert.throws(() => AwaitRewriter.rewrite("const f = async function () { return 1; };"), {
        message: ASYNC_HINT,
    });
    assert.throws(() => AwaitRewriter.rewrite("const o = { async run() { return 1; } };"), { message: ASYNC_HINT });
});

test("await inside strings and comments is kept", () => {
    const code = [
        'const text = "await penpot.x()";',
        "const other = 'await penpot.y()';",
        "const template = `await penpot.z()`;",
        "// await penpot.w()",
        "/* await penpot.v() */",
        "const re = /await penpot/;",
    ].join("\n");
    assert.equal(AwaitRewriter.rewrite(code), code);
});

test("a real await is removed while the same word in a string is kept", () => {
    const code = 'const s = "await penpot.x()";\nawait penpot.y();';
    assert.equal(AwaitRewriter.rewrite(code), 'const s = "await penpot.x()";\n      penpot.y();');
});

test("a property named await is not a keyword", () => {
    const code = "return obj.await(penpot.x());";
    assert.equal(AwaitRewriter.rewrite(code), code);
});

test("nested qualifying awaits are both removed", () => {
    assert.equal(
        AwaitRewriter.rewrite("const r = await penpot.f(await penpotUtils.g());"),
        "const r =       penpot.f(      penpotUtils.g());"
    );
});

test("the rewrite keeps line breaks and columns, so error lines stay the same", () => {
    const code = 'const a = 1;\nconst b = await penpot.getPageById("x");\nreturn b;';
    const out = AwaitRewriter.rewrite(code);
    assert.equal(out, 'const a = 1;\nconst b =       penpot.getPageById("x");\nreturn b;');
    assert.equal(out.length, code.length);
    assert.deepEqual(
        out.split("\n").map((line) => line.length),
        code.split("\n").map((line) => line.length)
    );
});

test("a script without await is returned unchanged", () => {
    const code = "const r = penpot.createRectangle(); return r.id;";
    assert.equal(AwaitRewriter.rewrite(code), code);
});

test("a syntax error returns the input unchanged so the guest reports it", () => {
    const code = "const x = ;\nawait penpot.x(";
    assert.equal(AwaitRewriter.rewrite(code), code);
});

test("an await inside a non-async function is a syntax error and is returned unchanged", () => {
    const code = "function run() { return await penpot.x(); }";
    assert.equal(AwaitRewriter.rewrite(code), code);
});
