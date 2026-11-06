import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VariableResolver } from "./VariableResolver.js";
import { ScenarioLoader, type Scenario } from "./Scenario.js";

/** Substitution inputs that stand in for a real setup, so that every fixture can be expanded. */
const SETUP_VARS = {
    fileId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    pageIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
    shapeIds: ["44444444-4444-4444-8444-444444444444"],
    agentFileIds: ["55555555-5555-4555-8555-555555555555"],
    agentPageIds: ["66666666-6666-4666-8666-666666666666"],
    agentBoardId: "77777777-7777-4777-8777-777777777777",
    fileCount: 2,
};

/**
 * Expands the arguments of one step as the runner would for a given copy, with the setup values in place.
 */
function expandArgs(step: Scenario["steps"][number], scope: Record<string, unknown>): Record<string, unknown> {
    const resolver = new VariableResolver(SETUP_VARS, {}, {});
    return resolver.expand(step.args, { agent: 0, iteration: 0, runId: "test", index: 0, ...scope }) as Record<
        string,
        unknown
    >;
}

describe("ScenarioLoader.parse", () => {
    test("fills in defaults for agents, iterations, step names and repeat", () => {
        const scenario = ScenarioLoader.parse({ name: "tiny", steps: [{ tool: "whoami" }] }, "tiny.json");
        assert.equal(scenario.agents, 1);
        assert.equal(scenario.iterations, 1);
        assert.equal(scenario.description, "");
        assert.equal(scenario.steps[0].name, "whoami");
        assert.equal(scenario.steps[0].repeat, 1);
        assert.deepEqual(scenario.steps[0].capture, {});
    });

    test("rejects a scenario without steps", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [] }, "x.json"),
            /steps must be a non-empty array/
        );
    });

    test("rejects a repeat below one", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", repeat: 0 }] }, "x.json"),
            /repeat must be an integer of at least 1/
        );
    });

    test("accepts a repeat placeholder and rejects other strings", () => {
        const ok = ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", repeat: "${fileCount}" }] }, "x.json");
        assert.equal(ok.steps[0].repeat, "${fileCount}");
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", repeat: "many" }] }, "x.json"),
            /placeholder/
        );
    });

    test("rejects captures that are not JSONPath strings", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", capture: { id: "result.id" } }] }, "x.json"),
            /capture id must be a JSONPath/
        );
    });

    test("rejects a rate that is not positive and an expectation without a path", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", rateLimitPerSecond: 0 }] }, "x.json"),
            /rateLimitPerSecond must be a positive number/
        );
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", expect: {} }] }, "x.json"),
            /expect.path must be a non-empty string/
        );
    });

    test("names the step that is wrong", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "ok" }, { args: {} }] }, "x.json"),
            /x\.json: steps\[1\]: tool must be a non-empty string/
        );
    });
});

describe("bundled fixtures", () => {
    test("every fixture parses", async () => {
        const names = await ScenarioLoader.listFixtures();
        assert.deepEqual(names, [
            "bulk-allowsplit",
            "c1-different-files",
            "c2-same-file",
            "c3-agent-with-human",
            "c4-same-shape",
            "c5-large-readers",
            "s1-create-pages",
            "s2-reduced-shapes",
            "s3-tokens",
            "s4-components",
            "s5-read-exports",
            "s5-read-large",
            "s6-import-archive",
            "s7-execute-code-grid",
            "s8-snapshot-cost",
            "s9-hostile-code",
            "setup",
            "soak-mixed",
        ]);
        for (const name of names) {
            const scenario = await ScenarioLoader.load(name);
            assert.ok(scenario.steps.length > 0, name);
        }
    });

    test("S2 expands to four calls of 258 nodes, and its flex layouts come from set_flex_layout ops", async () => {
        const scenario = await ScenarioLoader.load("s2-reduced-shapes");
        const call = expandArgs(scenario.steps[0], { index: 0 });
        const roots = call.tree as Array<Record<string, unknown>>;
        assert.equal(roots.length, 3);

        // depth 0 is a root and depth 1 a frame: these are the flex parents that set_flex_layout covers
        let nodes = 0;
        let nonRoot = 0;
        let inFlex = 0;
        const visit = (node: Record<string, unknown>, depth: number): void => {
            nodes++;
            if (depth > 0) {
                nonRoot++;
                if (depth - 1 < 2) {
                    inFlex++;
                }
            }
            for (const child of (node.children ?? []) as Array<Record<string, unknown>>) {
                visit(child, depth + 1);
            }
        };
        for (const root of roots) {
            visit(root, 0);
        }
        assert.equal(nodes, 258, "nodes per batch call");
        assert.equal(scenario.steps[0].repeat, 4, "batches");
        const share = inFlex / nonRoot;
        assert.ok(share > 0.25 && share < 0.35, `flex share ${share.toFixed(3)}`);

        const layoutStep = scenario.steps.find((step) => step.name.startsWith("set flex layouts"));
        assert.ok(layoutStep !== undefined, "a step sets the flex layouts");
        const operations = (layoutStep.args as { operations: Array<Record<string, unknown>> }).operations;
        const counts = operations.map((directive) => ({
            repeat: directive.$repeat,
            op: (directive.value as { op: string }).op,
        }));
        assert.deepEqual(counts, [
            { repeat: 12, op: "set_flex_layout" },
            { repeat: 60, op: "set_flex_layout" },
        ]);
        for (const directive of operations) {
            assert.equal(
                JSON.stringify(directive).includes("props"),
                false,
                "no props.layout remains in the tree or the ops"
            );
        }
    });

    test("S3 writes 10 sets, 300 tokens and 10 themes in one call", async () => {
        const scenario = await ScenarioLoader.load("s3-tokens");
        const operations = expandArgs(scenario.steps[0], {}).operations as Array<Record<string, unknown>>;
        const count = (op: string): number => operations.filter((item) => item.op === op).length;
        assert.equal(count("create_token_set"), 10);
        assert.equal(count("create_token"), 300);
        assert.equal(count("create_theme"), 10);
        const tokenSets = new Set(operations.filter((item) => item.op === "create_token").map((item) => item.setId));
        assert.equal(tokenSets.size, 10, "every token points at one of the ten sets");
    });

    test("S1 creates a page and a board per copy", async () => {
        const scenario = await ScenarioLoader.load("s1-create-pages");
        assert.equal(scenario.steps[0].repeat, 50);
        const operations = expandArgs(scenario.steps[0], { index: 4 }).operations as Array<Record<string, unknown>>;
        assert.equal(operations[0].name, "Perf page 4");
        assert.equal(operations[1].pageId, "$tmp:page");
    });

    test("S7 builds about 800 operations in one execute_code call", async () => {
        const scenario = await ScenarioLoader.load("s7-execute-code-grid");
        const code = expandArgs(scenario.steps[0], {}).code as string;
        assert.match(code, /penpot\.createRectangle\(\)/);
        assert.equal(code.includes("${"), false, "the script must not contain placeholders");
        assert.match(code, /row < 66/);
        assert.match(code, /column < 12/);
    });

    test("C2 checks that all 100 rectangles are present", async () => {
        const scenario = await ScenarioLoader.load("c2-same-file");
        const check = scenario.steps[scenario.steps.length - 1];
        assert.deepEqual(check.expect, [{ path: "$.result.matches", length: 100 }]);
    });

    test("S2, S3, C4 and the bulk write make a fresh page per iteration, so a second run passes", async () => {
        for (const name of ["s2-reduced-shapes", "s3-tokens", "c4-same-shape", "bulk-allowsplit"]) {
            const scenario = await ScenarioLoader.load(name);
            assert.equal(scenario.freshPage, true, name);
            assert.equal(scenario.setupPer, "iteration", name);
            assert.deepEqual(scenario.setup[0].capture, { pageId: '$.result.createdIds["$tmp:page"]' }, name);
        }
        const tokens = await ScenarioLoader.load("s3-tokens");
        const operations = expandArgs(tokens.steps[0], {}).operations as Array<Record<string, unknown>>;
        assert.equal(operations.find((item) => item.op === "create_token_set")?.name, "Set test-0");
    });

    test("S4 makes 200 components, 5 x 200 copies, and edits 20 mains with one sync", async () => {
        const scenario = await ScenarioLoader.load("s4-components");
        assert.deepEqual(Object.keys(scenario.setup[0].capture), ["fileId"]);
        const vars = {
            mainIds: Array.from({ length: 200 }, (_, k) => `main-${k}`),
            componentIds: Array.from({ length: 200 }, (_, k) => `comp-${k}`),
        };
        const resolver = new VariableResolver({ ...SETUP_VARS, ...vars }, {}, {});
        const expand = (index: number) =>
            resolver.expand(scenario.steps[index].args, { agent: 0, iteration: 0, runId: "t", index: 2 }) as {
                operations: Array<Record<string, unknown>>;
            };
        assert.equal(expand(2).operations.length, 200);
        const copies = expand(4).operations;
        assert.equal(copies.length, 200);
        assert.equal(scenario.steps[4].repeat, 5);
        assert.deepEqual([copies[199].componentId, copies[199].y], ["comp-199", 2]);
        const edit = expand(5).operations;
        assert.equal(edit.length, 21);
        assert.equal(edit[20].op, "sync_components");
        assert.equal(scenario.steps[5].maxDurationMs, 10000);
    });

    test("S9 expects an error from every hostile script and a working plain script between them", async () => {
        const scenario = await ScenarioLoader.load("s9-hostile-code");
        const plain = scenario.steps.filter((step) => step.name.startsWith("plain script"));
        const hostile = scenario.steps.filter((step) => !step.name.startsWith("plain script"));
        assert.equal(plain.length, 5);
        assert.ok(hostile.length >= 8);
        for (const step of hostile) {
            assert.ok(step.expectError !== undefined, step.name);
        }
        for (const step of plain) {
            assert.deepEqual(step.expect, [{ path: "$.result.result", equals: 2 }], step.name);
        }
    });

    test("C4 checks the revn-lag warning, the refused conflict and the last value", async () => {
        const scenario = await ScenarioLoader.load("c4-same-shape");
        assert.deepEqual(
            scenario.steps[2].expect?.map((item) => item.contains),
            ["revn-lag", "${rectId}"]
        );
        assert.equal(scenario.steps[3].expectError, "conflict");
        assert.equal(scenario.steps[4].expect?.[0].equals, "#ff0000");
    });

    test("the soak fixture keeps the 70 / 25 / 5 mix and exports on a timer", async () => {
        const scenario = await ScenarioLoader.load("soak-mixed");
        const reads = ["get_file_outline", "get_page_tree", "find_shapes", "get_shapes"];
        const count = (test: (step: Scenario["steps"][number]) => boolean): number =>
            scenario.steps.filter(test).reduce((sum, step) => sum + Number(step.repeat), 0);
        assert.equal(
            count((step) => reads.includes(step.tool)),
            14
        );
        assert.equal(
            count((step) => step.tool === "apply_operations"),
            5
        );
        assert.equal(
            count((step) => step.tool === "batch_create_shapes"),
            1
        );
        assert.equal(scenario.steps.find((step) => step.tool === "export_shape")?.everyMs, 300000);
    });

    test("the setup fixture captures the vars that the other scenarios read", async () => {
        const scenario = await ScenarioLoader.load("setup");
        const captured = new Set(scenario.steps.flatMap((step) => Object.keys(step.capture)));
        for (const name of ["teamId", "projectId", "fileId", "pageId", "pageIds", "agentFileIds", "agentPageIds"]) {
            assert.ok(captured.has(name), `setup must capture ${name}`);
        }
    });
});

describe("ScenarioLoader setup and freshPage", () => {
    test("setup is empty and setupPer is iteration by default", () => {
        const scenario = ScenarioLoader.parse({ name: "x", steps: [{ tool: "whoami" }] }, "x.json");
        assert.deepEqual(scenario.setup, []);
        assert.equal(scenario.setupPer, "iteration");
        assert.equal(scenario.freshPage, false);
    });

    test("parses setup steps like steps and accepts setupPer agent", () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "x",
                setupPer: "agent",
                setup: [{ tool: "list_teams", capture: { teamId: "$.result[0].id" } }],
                steps: [{ tool: "whoami" }],
            },
            "x.json"
        );
        assert.equal(scenario.setupPer, "agent");
        assert.equal(scenario.setup[0].name, "list_teams");
        assert.equal(scenario.setup[0].repeat, 1);
        assert.deepEqual(scenario.setup[0].capture, { teamId: "$.result[0].id" });
    });

    test("freshPage true adds a page step in front of the file setup steps", () => {
        const scenario = ScenarioLoader.parse(
            { name: "perf", freshPage: true, setup: [{ tool: "whoami" }], steps: [{ tool: "whoami" }] },
            "x.json"
        );
        assert.equal(scenario.freshPage, true);
        assert.equal(scenario.setup.length, 2);
        const [page, own] = scenario.setup;
        assert.equal(page.name, "fresh page");
        assert.equal(page.tool, "apply_operations");
        assert.deepEqual(page.args, {
            fileId: "${fileId}",
            snapshot: false,
            operations: [{ op: "create_page", id: "$tmp:page", name: "perf ${runId} a${agent} i${iteration}" }],
        });
        assert.deepEqual(page.capture, { pageId: '$.result.createdIds["$tmp:page"]' });
        assert.equal(own.tool, "whoami");
    });

    test("freshPage object sets the file id and the page name", () => {
        const scenario = ScenarioLoader.parse(
            { name: "x", freshPage: { fileId: "file-9", name: "Page ${index}" }, steps: [{ tool: "whoami" }] },
            "x.json"
        );
        assert.equal(scenario.setup.length, 1);
        assert.deepEqual(scenario.setup[0].args, {
            fileId: "file-9",
            snapshot: false,
            operations: [{ op: "create_page", id: "$tmp:page", name: "Page ${index}" }],
        });
    });

    test("rejects an unknown setupPer", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", setupPer: "run", steps: [{ tool: "t" }] }, "x.json"),
            /x\.json: setupPer must be "iteration" or "agent"/
        );
    });

    test("rejects a freshPage that is neither true nor an object, or has an unknown key", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", freshPage: "yes", steps: [{ tool: "t" }] }, "x.json"),
            /freshPage must be true or an object/
        );
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", freshPage: { fileid: "f" }, steps: [{ tool: "t" }] }, "x.json"),
            /freshPage: unknown key fileid/
        );
    });
});

describe("ScenarioLoader step options", () => {
    test("compiles expectError and keeps its source", () => {
        const scenario = ScenarioLoader.parse(
            { name: "x", steps: [{ tool: "t", expectError: "quota|limit" }] },
            "x.json"
        );
        assert.equal(scenario.steps[0].expectError, "quota|limit");
    });

    test("rejects an expectError that is not a regular expression", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", expectError: "(" }] }, "x.json"),
            /x\.json: steps\[0\]: expectError is not a valid regular expression/
        );
    });

    test("rejects an expectError with capture or expect", () => {
        assert.throws(
            () =>
                ScenarioLoader.parse(
                    { name: "x", steps: [{ tool: "t", expectError: "x", capture: { id: "$.result.id" } }] },
                    "x.json"
                ),
            /cannot also have capture or expect/
        );
        assert.throws(
            () =>
                ScenarioLoader.parse(
                    { name: "x", steps: [{ tool: "t", expectError: "x", expect: { path: "$.result" } }] },
                    "x.json"
                ),
            /cannot also have capture or expect/
        );
    });

    test("rejects maxDurationMs and everyMs that are not positive", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", maxDurationMs: 0 }] }, "x.json"),
            /maxDurationMs must be a positive number/
        );
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", everyMs: -5 }] }, "x.json"),
            /everyMs must be a positive number/
        );
    });

    test("keeps maxDurationMs and everyMs", () => {
        const scenario = ScenarioLoader.parse(
            { name: "x", steps: [{ tool: "t", maxDurationMs: 2500, everyMs: 60000 }] },
            "x.json"
        );
        assert.equal(scenario.steps[0].maxDurationMs, 2500);
        assert.equal(scenario.steps[0].everyMs, 60000);
    });

    test("reads one expectation object as a list of one", () => {
        const scenario = ScenarioLoader.parse(
            { name: "x", steps: [{ tool: "t", expect: { path: "$.result.revn", equals: 1 } }] },
            "x.json"
        );
        assert.deepEqual(scenario.steps[0].expect, [{ path: "$.result.revn", equals: 1 }]);
    });

    test("reads an array of expectations with the new checks", () => {
        const scenario = ScenarioLoader.parse(
            {
                name: "x",
                steps: [
                    {
                        tool: "t",
                        expect: [
                            { path: "$.result.items", maxLength: 3 },
                            { path: "$.result.counts", sum: "${total}", contains: "${rectId}" },
                        ],
                    },
                ],
            },
            "x.json"
        );
        assert.deepEqual(scenario.steps[0].expect, [
            { path: "$.result.items", maxLength: 3 },
            { path: "$.result.counts", sum: "${total}", contains: "${rectId}" },
        ]);
    });

    test("rejects an empty expectation list and a non-integer maxLength", () => {
        assert.throws(
            () => ScenarioLoader.parse({ name: "x", steps: [{ tool: "t", expect: [] }] }, "x.json"),
            /expect must not be an empty array/
        );
        assert.throws(
            () =>
                ScenarioLoader.parse(
                    { name: "x", steps: [{ tool: "t", expect: [{ path: "$.result", maxLength: 2.5 }] }] },
                    "x.json"
                ),
            /expect\[0\]\.maxLength must be an integer or a placeholder/
        );
    });
});
