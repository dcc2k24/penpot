import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JsonPath } from "./JsonPath.js";
import { VariableResolver } from "./VariableResolver.js";

/**
 * Builds a resolver with the given vars file values, environment and captures.
 */
function resolverWith(
    vars: Record<string, unknown> = {},
    env: Record<string, string | undefined> = {},
    captures: Record<string, unknown> = {}
): VariableResolver {
    return new VariableResolver(vars, env, captures);
}

describe("VariableResolver substitution", () => {
    test("a whole-string placeholder keeps the type of its value", () => {
        const resolver = resolverWith({ fileId: "f1", count: 2, ids: ["a", "b"] });
        assert.equal(resolver.expand("${fileId}", {}), "f1");
        assert.equal(resolver.expand("${count}", {}), 2);
        assert.deepEqual(resolver.expand("${ids}", {}), ["a", "b"]);
    });

    test("a longer string interpolates the placeholders as text", () => {
        const resolver = resolverWith({ fileId: "f1", count: 2, ids: ["a", "b"] });
        assert.equal(resolver.expand("id-${fileId}-x", {}), "id-f1-x");
        assert.equal(resolver.expand("n=${count}", {}), "n=2");
        assert.equal(resolver.expand("${ids}!", {}), '["a","b"]!');
    });

    test("an index selects an array element and an index outside the array fails instead of wrapping", () => {
        const resolver = resolverWith({ pageIds: ["p0", "p1"] });
        assert.equal(resolver.expand("${pageIds[index]}", { index: 0 }), "p0");
        assert.equal(resolver.expand("${pageIds[index]}", { index: 1 }), "p1");
        assert.equal(resolver.expand("${pageIds[1]}", {}), "p1");
        assert.throws(() => resolver.expand("${pageIds[index]}", { index: 3 }), /out of range.*do not wrap/);
        assert.throws(() => resolver.expand("${pageIds[2]}", {}), /out of range/);
    });

    test("an index on a value that is not an array fails", () => {
        const resolver = resolverWith({ fileId: "f1" });
        assert.throws(() => resolver.expand("${fileId[index]}", { index: 0 }), /not an array/);
    });

    test("an unknown name fails with the names that would supply it", () => {
        const resolver = resolverWith();
        assert.throws(
            () => resolver.expand("${missing}", {}),
            /unknown variable \$\{missing\}.*PENPOT_LOADTEST_MISSING/
        );
    });

    test("the scope wins, then the captures, then the vars file, then the environment", () => {
        const resolver = resolverWith(
            { fileId: "from-file", teamId: "team-from-file" },
            { PENPOT_LOADTEST_TEAM_ID: "team-from-env", PENPOT_LOADTEST_PROJECT_ID: "project-from-env" },
            { fileId: "captured", projectId: "captured-project", profileId: "captured-profile" }
        );
        assert.equal(resolver.expand("${index}", { index: 7 }), 7);
        assert.equal(resolver.expand("${fileId}", { fileId: "scope" }), "scope");
        assert.equal(resolver.expand("${fileId}", {}), "captured");
        assert.equal(resolver.expand("${teamId}", {}), "team-from-file");
        assert.equal(resolver.expand("${projectId}", {}), "captured-project");
        assert.equal(resolver.expand("${profileId}", {}), "captured-profile");
    });

    test("an environment value is used when no capture, vars file or scope names the variable", () => {
        const resolver = resolverWith({}, { PENPOT_LOADTEST_PROJECT_ID: "project-from-env" }, {});
        assert.equal(resolver.expand("${projectId}", {}), "project-from-env");
    });

    test("environment names are derived from camelCase names", () => {
        assert.equal(VariableResolver.envNameFor("fileId"), "PENPOT_LOADTEST_FILE_ID");
        assert.equal(VariableResolver.envNameFor("agentFileIds"), "PENPOT_LOADTEST_AGENT_FILE_IDS");
        assert.equal(VariableResolver.envNameFor("teamId"), "PENPOT_LOADTEST_TEAM_ID");
    });

    test("nested objects and lists are substituted", () => {
        const resolver = resolverWith({ fileId: "f1" });
        const expanded = resolver.expand({ fileId: "${fileId}", list: ["${fileId}", { id: "x-${fileId}" }] }, {});
        assert.deepEqual(expanded, { fileId: "f1", list: ["f1", { id: "x-f1" }] });
    });

    test("a $repeat directive expands to copies with the loop variable bound", () => {
        const resolver = resolverWith();
        const expanded = resolver.expand(
            [{ $repeat: 3, as: "k", value: { x: "${k}", name: "rect-${k}" } }, "tail"],
            {}
        );
        assert.deepEqual(expanded, [
            { x: 0, name: "rect-0" },
            { x: 1, name: "rect-1" },
            { x: 2, name: "rect-2" },
            "tail",
        ]);
    });

    test("an array template splices several items for each copy", () => {
        const resolver = resolverWith();
        const expanded = resolver.expand(
            [
                {
                    $repeat: 2,
                    as: "s",
                    value: [
                        { op: "set", id: "$tmp:set${s}" },
                        { op: "token", setId: "$tmp:set${s}" },
                    ],
                },
            ],
            {}
        );
        assert.deepEqual(expanded, [
            { op: "set", id: "$tmp:set0" },
            { op: "token", setId: "$tmp:set0" },
            { op: "set", id: "$tmp:set1" },
            { op: "token", setId: "$tmp:set1" },
        ]);
    });

    test("nested $repeat directives see both loop variables", () => {
        const resolver = resolverWith();
        const expanded = resolver.expand(
            [{ $repeat: 2, as: "a", value: [{ $repeat: 2, as: "b", value: "${a}-${b}" }] }],
            {}
        );
        assert.deepEqual(expanded, ["0-0", "0-1", "1-0", "1-1"]);
    });

    test("a $repeat count can come from a placeholder", () => {
        const resolver = resolverWith({ fileCount: "3" });
        assert.deepEqual(resolver.expand({ $repeat: "${fileCount}", value: "x" }, {}), ["x", "x", "x"]);
    });

    test("counts must be whole numbers from 0 to 100000", () => {
        assert.equal(VariableResolver.countOf(0), 0);
        assert.equal(VariableResolver.countOf("12"), 12);
        assert.throws(() => VariableResolver.countOf(1.5), /whole number/);
        assert.throws(() => VariableResolver.countOf(-1), /whole number/);
        assert.throws(() => VariableResolver.countOf(100_001), /whole number/);
        assert.throws(() => VariableResolver.countOf("abc"), /whole number/);
    });
});

describe("JsonPath captures", () => {
    const document = {
        result: {
            pages: [
                { id: "p0", name: "one" },
                { id: "p1", name: "two" },
            ],
            createdIds: { "$tmp:board": "uuid-1" },
            matches: [{ id: "s1" }, { id: "s2" }],
        },
    };

    test("reads keys, indexes and quoted keys", () => {
        assert.equal(JsonPath.parse('$.result.createdIds["$tmp:board"]').read({ result: document.result }), "uuid-1");
        assert.equal(JsonPath.parse("$.result.pages[1].name").read(document), "two");
        assert.equal(JsonPath.parse("$.result.pages[0].id").read(document), "p0");
    });

    test("a wildcard maps the rest of the path over an array", () => {
        assert.deepEqual(JsonPath.parse("$.result.matches[*].id").read(document), ["s1", "s2"]);
        assert.deepEqual(JsonPath.parse("$.result.pages[*].id").read(document), ["p0", "p1"]);
    });

    test("a path that matches nothing reads as undefined", () => {
        assert.equal(JsonPath.parse("$.result.missing").read(document), undefined);
        assert.equal(JsonPath.parse("$.result.pages[5].id").read(document), undefined);
        assert.equal(JsonPath.parse("$.result.createdIds[*].x").read(document), undefined);
    });

    test("malformed paths are rejected", () => {
        assert.throws(() => JsonPath.parse("result.pages"), /must start with/);
        assert.throws(() => JsonPath.parse("$..pages"), /empty key/);
        assert.throws(() => JsonPath.parse("$.pages[abc]"), /bracket/);
        assert.throws(() => JsonPath.parse("$.pages["), /unterminated/);
    });
});
