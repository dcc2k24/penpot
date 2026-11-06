import assert from "node:assert/strict";
import { test } from "node:test";
import { LargeFileGenerator, type GeneratorOptions, type ToolCaller } from "./LargeFileGenerator.js";
import type { ToolCallOutcome } from "./McpLoadClient.js";

/** One call that the fake server received. */
interface RecordedCall {
    /** Tool name. */
    name: string;
    /** Arguments as sent. */
    args: Record<string, unknown>;
}

/** One node of a batch_create_shapes tree, as the fake reads it. */
interface TreeNode {
    /** Shape type. */
    type: string;
    /** Layer name. */
    name: string;
    /** Child nodes. */
    children?: TreeNode[];
}

/** Page kept by the fake server. */
interface FakePage {
    /** Page id. */
    id: string;
    /** Page name. */
    name: string;
    /** Shapes on the page, as the outline reports them. */
    shapeCount: number;
}

/** Fixed uuid shape that the fake hands out. The tests replace it when they compare two runs. */
const UUID_PATTERN = /[0-9a-f]{8}-0000-4000-8000-000000000000/g;

/** Tools that write, which must all send snapshot false. */
const WRITE_TOOLS = new Set(["apply_operations", "batch_create_shapes"]);

/** Settings of a small run. Clock is fixed so that the durations are zero. */
const BASE_OPTIONS: Omit<GeneratorOptions, "log"> = {
    projectId: "project-1",
    shapes: 2000,
    pages: 3,
    batch: 300,
    components: 5,
    instancesPerPage: 4,
    seed: 7,
    now: () => 0,
};

/**
 * Fake MCP server for the generator. It keeps a page list and counts shapes per page the way the outline does,
 * and it hands out uuids that follow a counter, so two runs of the same seed send the same calls.
 */
class FakeServer implements ToolCaller {
    /** Every call received, failed calls included. */
    readonly calls: RecordedCall[] = [];

    /** Real id of every handle that apply_operations created. */
    readonly applied = new Map<string, string>();

    /** Pages in outline order. */
    private readonly pages: FakePage[] = [];

    /** Id of the file, set by create_file. */
    private fileId = "";

    /** Last number handed out. */
    private sequence = 0;

    /** Number of the call that fails, counted from 1. Zero means no failure. */
    private readonly failAt: number;

    /**
     * Makes a fake that fails one call.
     *
     * @param failAt - number of the call that fails, counted from 1; zero means none
     */
    constructor(failAt: number) {
        this.failAt = failAt;
    }

    /** Page ids in outline order. */
    get pageIds(): string[] {
        return this.pages.map((page) => page.id);
    }

    /** Sum of the shape counts of every page. */
    get totalShapes(): number {
        return this.pages.reduce((sum, page) => sum + page.shapeCount, 0);
    }

    /**
     * Answers one call. The call that matches failAt returns an error outcome.
     *
     * @param name - tool name
     * @param args - tool arguments
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
        this.calls.push({ name, args: structuredClone(args) });
        if (this.calls.length === this.failAt) {
            return failed(name, "forced failure");
        }
        try {
            return succeeded(this.answer(name, args));
        } catch (error) {
            return failed(name, error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Builds the JSON answer of one tool.
     *
     * @param name - tool name
     * @param args - tool arguments
     * @throws Error for a tool or an op that the fake does not handle
     */
    private answer(name: string, args: Record<string, unknown>): unknown {
        switch (name) {
            case "manage_files":
                this.fileId = this.nextId();
                this.pages.push({ id: this.nextId(), name: "Page 1", shapeCount: 0 });
                return { id: this.fileId, name: args.name };
            case "get_file_outline":
                return {
                    id: this.fileId,
                    revn: 1,
                    features: [],
                    pointerMap: true,
                    pages: this.pages.map((page, index) => ({ ...page, index, rootChildCount: 0 })),
                };
            case "apply_operations":
                return this.applyOperations(args);
            case "batch_create_shapes":
                return this.createTree(args);
            default:
                throw new Error(`fake has no tool ${name}`);
        }
    }

    /**
     * Applies the operations in order, the way the server does for the ops that the generator sends.
     *
     * @param args - arguments of the call
     * @throws Error for more than 2000 operations or an op the fake does not know
     */
    private applyOperations(args: Record<string, unknown>): unknown {
        const operations = args.operations as Record<string, unknown>[];
        if (operations.length > 2000) {
            throw new Error("too many operations");
        }
        const createdIds: Record<string, string> = {};
        for (const op of operations) {
            switch (op.op) {
                case "create_page":
                    this.pages.push({ id: this.handle(op.id, createdIds), name: String(op.name), shapeCount: 0 });
                    break;
                case "update_page":
                    this.page(op.id).name = String(op.name);
                    break;
                case "move_page": {
                    const from = this.pages.findIndex((page) => page.id === op.id);
                    const [moved] = this.pages.splice(from, 1);
                    this.pages.splice(Number(op.index), 0, moved);
                    break;
                }
                case "create_component":
                    this.handle(op.id, createdIds);
                    break;
                case "instantiate_component":
                    this.page(op.pageId).shapeCount += 3;
                    break;
                case "set_flex_layout":
                case "set_grid_layout":
                    break;
                default:
                    throw new Error(`fake does not know op ${String(op.op)}`);
            }
        }
        return { revn: 1, createdIds, changeCount: operations.length, commits: 1, warnings: [] };
    }

    /**
     * Creates a tree in document order, handles numbered depth first, and counts the nodes on the page.
     *
     * @param args - arguments of the call
     */
    private createTree(args: Record<string, unknown>): unknown {
        const page = this.page(args.pageId);
        const nodes: { handle: string; type: string; name: string }[] = [];
        const createdIds: Record<string, string> = {};
        const visit = (node: TreeNode): void => {
            const handle = `$tmp:n${nodes.length}`;
            nodes.push({ handle, type: node.type, name: node.name });
            createdIds[handle] = this.nextId();
            for (const child of node.children ?? []) {
                visit(child);
            }
        };
        for (const root of args.tree as TreeNode[]) {
            visit(root);
        }
        if (nodes.length > 2000) {
            throw new Error("too many nodes");
        }
        page.shapeCount += nodes.length;
        return { nodes, result: { revn: 1, createdIds, changeCount: nodes.length } };
    }

    /**
     * Gives a handle a new id and records it.
     *
     * @param handle - handle from the op
     * @param createdIds - map of the call that receives the id
     */
    private handle(handle: unknown, createdIds: Record<string, string>): string {
        const key = String(handle);
        const id = this.nextId();
        createdIds[key] = id;
        this.applied.set(key, id);
        return id;
    }

    /**
     * Finds a page by id.
     *
     * @param id - page id
     * @throws Error when no page has the id
     */
    private page(id: unknown): FakePage {
        const found = this.pages.find((page) => page.id === id);
        if (found === undefined) {
            throw new Error(`unknown page ${String(id)}`);
        }
        return found;
    }

    /**
     * Hands out the next uuid of the counter.
     */
    private nextId(): string {
        this.sequence += 1;
        return `${this.sequence.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    }
}

/**
 * Makes a successful outcome around a JSON answer.
 *
 * @param json - the answer
 */
function succeeded(json: unknown): ToolCallOutcome {
    const text = JSON.stringify(json);
    return { durationMs: 0, ok: true, text, isError: false, bytes: text.length, json };
}

/**
 * Makes a failed outcome.
 *
 * @param tool - tool that failed, kept for the reader of the call log
 * @param message - failure message
 */
function failed(tool: string, message: string): ToolCallOutcome {
    const text = `Tool execution failed: ${message}`;
    return { durationMs: 0, ok: false, text, isError: true, bytes: text.length, json: undefined, error: message };
}

/**
 * Runs the generator against a fake server.
 *
 * @param overrides - settings that replace the base settings
 * @param failAt - number of the call that fails, counted from 1; zero means none
 */
async function runWith(overrides: Partial<GeneratorOptions> = {}, failAt = 0) {
    const fake = new FakeServer(failAt);
    const lines: string[] = [];
    const generator = new LargeFileGenerator(fake, { ...BASE_OPTIONS, log: (line) => lines.push(line), ...overrides });
    const result = await generator.run();
    return { result, fake, lines };
}

/**
 * Counts the nodes of a tree, the roots and all their descendants.
 *
 * @param nodes - roots of the tree
 */
function countNodes(nodes: TreeNode[]): number {
    return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
}

/**
 * Collects the layer names and text characters in a value, in document order.
 *
 * @param value - value to search
 * @param found - list that receives the strings
 */
function labelsOf(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) {
            labelsOf(item, found);
        }
    } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            if ((key === "name" || key === "characters") && typeof child === "string") {
                found.push(child);
            } else {
                labelsOf(child, found);
            }
        }
    }
    return found;
}

/**
 * Lists the operations of the apply_operations calls, in order.
 *
 * @param calls - calls received by the fake
 */
function operationsOf(calls: RecordedCall[]): Record<string, unknown>[] {
    return calls
        .filter((call) => call.name === "apply_operations")
        .flatMap((call) => call.args.operations as Record<string, unknown>[]);
}

test("a small run hits the shape target and the per-page budgets", async () => {
    const { result, fake } = await runWith();
    assert.equal(result.error, undefined);
    assert.equal(result.complete, true);
    assert.equal(result.shapeCount, 2000);
    assert.equal(fake.totalShapes, 2000);
    // library: 5 components of 3 shapes; content: 1985 shapes split 662, 662, 661
    assert.deepEqual(result.pageShapeCounts, [662, 662, 661]);
    assert.equal(result.pageIds.length, 3);
    assert.equal(result.calls, fake.calls.length);
    assert.notEqual(result.fileId, "");
    assert.equal(result.pointerMap, true);
});

test("the first page is renamed and the file gets the default name", async () => {
    const { result, fake } = await runWith();
    assert.equal(fake.calls[0].name, "manage_files");
    assert.deepEqual(fake.calls[0].args, {
        action: "create_file",
        projectId: "project-1",
        name: "mcp-perf-large-2000-s7",
    });
    const renames = operationsOf(fake.calls).filter((op) => op.op === "update_page");
    assert.equal(renames.length, 1);
    assert.equal(renames[0].name, "Content 1");
    assert.equal(renames[0].id, result.pageId);
});

test("no batch call sends more nodes than the batch size", async () => {
    const { fake } = await runWith();
    const batches = fake.calls.filter((call) => call.name === "batch_create_shapes");
    assert.ok(batches.length > 0);
    for (const call of batches) {
        const nodes = countNodes(call.args.tree as TreeNode[]);
        assert.ok(nodes >= 1 && nodes <= 300, `batch of ${nodes} nodes`);
    }
});

test("every write sends snapshot false", async () => {
    const { fake } = await runWith();
    const writes = fake.calls.filter((call) => WRITE_TOOLS.has(call.name));
    assert.ok(writes.length > 0);
    for (const call of writes) {
        assert.equal(call.args.snapshot, false, `${call.name} sent snapshot ${String(call.args.snapshot)}`);
    }
});

test("the sections get flex and grid layouts", async () => {
    const { fake } = await runWith();
    const operations = operationsOf(fake.calls);
    const flex = operations.filter((op) => op.op === "set_flex_layout");
    const grid = operations.filter((op) => op.op === "set_grid_layout");
    assert.ok(flex.length > 0, "flex layouts on the rows");
    assert.ok(grid.length > 0, "a grid layout on a fifth section");
    for (const op of flex) {
        assert.equal(op.layoutFlexDir, "row");
    }
    for (const op of grid) {
        assert.equal((op.layoutGridColumns as unknown[]).length, 2);
        assert.ok((op.layoutGridRows as unknown[]).length >= 1);
    }
});

test("component ids follow the component index, and the components are created in order", async () => {
    const { result, fake } = await runWith();
    const expected = [0, 1, 2, 3, 4].map((k) => fake.applied.get(`$tmp:c${k}`));
    assert.deepEqual(result.componentIds, expected);
    const created = operationsOf(fake.calls).filter((op) => op.op === "create_component");
    assert.deepEqual(
        created.map((op) => op.name),
        ["Component 0", "Component 1", "Component 2", "Component 3", "Component 4"]
    );
    assert.deepEqual(
        created.map((op) => op.path),
        ["Perf/Group 0", "Perf/Group 1", "Perf/Group 2", "Perf/Group 3", "Perf/Group 4"]
    );
});

test("the library page is moved to the last index and nothing is written after the move", async () => {
    const { result, fake } = await runWith();
    const moves = operationsOf(fake.calls).filter((op) => op.op === "move_page");
    assert.equal(moves.length, 1);
    assert.equal(moves[0].id, result.libraryPageId);
    assert.equal(moves[0].index, 3);
    const moveCall = fake.calls.findIndex((call) => JSON.stringify(call.args).includes('"move_page"'));
    assert.deepEqual(
        fake.calls.slice(moveCall + 1).map((call) => call.name),
        ["get_file_outline"]
    );
    assert.equal(fake.pageIds.at(-1), result.libraryPageId);
    assert.deepEqual(
        result.pageIds,
        fake.pageIds.filter((id) => id !== result.libraryPageId)
    );
    assert.ok(!result.pageIds.includes(result.libraryPageId));
});

test("the same seed sends the same calls, and another seed changes the text", async () => {
    const first = await runWith();
    const second = await runWith();
    const normalize = (calls: RecordedCall[]) => JSON.stringify(calls).replace(UUID_PATTERN, "<id>");
    assert.equal(normalize(first.fake.calls), normalize(second.fake.calls));
    assert.deepEqual(labelsOf(first.fake.calls), labelsOf(second.fake.calls));

    const batchLabels = (calls: RecordedCall[]) =>
        labelsOf(calls.filter((call) => call.name === "batch_create_shapes").map((call) => call.args));
    const other = await runWith({ seed: 8 });
    assert.notDeepEqual(batchLabels(first.fake.calls), batchLabels(other.fake.calls));
});

test("progress is logged once per content page", async () => {
    const { lines } = await runWith();
    const progress = lines.filter((line) => line.startsWith("page "));
    assert.equal(progress.length, 3);
    for (const line of progress) {
        assert.match(
            line,
            /^page \d\/3: \d+ shapes in \d+ calls, \d+\.\d s \(file total \d+ shapes, elapsed \d+m\d\ds\)$/
        );
    }
});

test("a failed call stops the run and the result names the tool", async () => {
    const cases: [number, string][] = [
        [1, "manage_files"],
        [5, "batch_create_shapes"],
        [9, "batch_create_shapes"],
        [12, "apply_operations"],
    ];
    for (const [failAt, tool] of cases) {
        const { result, fake } = await runWith({}, failAt);
        assert.equal(fake.calls[failAt - 1].name, tool, `call ${failAt} should be ${tool}`);
        assert.equal(result.complete, false);
        assert.equal(result.error, `${tool} failed: forced failure`);
        assert.equal(result.calls, failAt);
        assert.equal(fake.calls.length, failAt, "no call follows the failed one");
    }
});

test("settings that leave no room for content are refused before any call", () => {
    const fake = new FakeServer(0);
    assert.throws(() => new LargeFileGenerator(fake, { ...BASE_OPTIONS, shapes: 15, components: 5 }), /shapes must be/);
    assert.throws(() => new LargeFileGenerator(fake, { ...BASE_OPTIONS, pages: 0 }), /pages must be/);
    assert.throws(() => new LargeFileGenerator(fake, { ...BASE_OPTIONS, batch: 1 }), /batch must be/);
    assert.equal(fake.calls.length, 0);
});
