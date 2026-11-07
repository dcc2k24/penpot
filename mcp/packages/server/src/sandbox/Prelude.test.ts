import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { TOKEN_WRITE_RULE } from "./ApplyTokenValues";
import { Prelude } from "./Prelude";

/** Root frame id of every page. */
const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Result envelope of `__runScript`. */
interface Envelope {
    ok: boolean;
    result?: unknown;
    undefinedResult?: boolean;
    error?: { name: string; message: string; stack: string | null };
    log: string;
}

/** One `__host.flush` call as the fake host received it. */
interface FlushCall {
    fileId: string;
    operations: Array<Record<string, unknown>>;
    dryRun: boolean;
}

/** Calls received by the fake host, in order. */
interface HostCalls {
    loadFileOutline: string[];
    loadPage: Array<{ fileId: string; pageId: string }>;
    flush: FlushCall[];
    importSvg: unknown[];
    rpc: Array<{ name: string; params: unknown }>;
}

/** Synchronous stand-in for the host primitives of the sandbox. */
interface FakeHost {
    /** Makes the next `flush` call throw a backend error. */
    failNextFlush: boolean;
    /** Makes the next `loadPage` call throw, as when the file changed during the read. */
    failNextLoad: boolean;
    /** Makes the next `flush` call answer with a failure after one chunk was saved, as the host does. */
    partialFailureNext: boolean;
    /** Calls received so far. */
    readonly calls: HostCalls;
    loadFileOutline(fileId: string): string;
    loadPage(fileId: string, pageId: string): string;
    flush(fileId: string, operationsJson: string, dryRun: boolean): string;
    importSvg(paramsJson: string): string;
    rpc(name: string, paramsJson: string): string;
}

/** A sandbox context with the prelude loaded, and the fake host it uses. */
interface Sandbox {
    host: FakeHost;
    context: vm.Context;
}

/**
 * Builds the fixed page the fake host returns for every page id.
 *
 * @param revn - revision reported by the page
 * @returns the page as the backend describes it, before JSON encoding
 */
function pageFixture(revn: number): object {
    return {
        revn,
        shapes: [
            {
                id: ROOT_ID,
                type: "frame",
                name: "Root",
                parentId: null,
                frameId: null,
                shapes: ["B1"],
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            {
                id: "B1",
                type: "frame",
                name: "Board",
                parentId: ROOT_ID,
                frameId: ROOT_ID,
                shapes: ["R1"],
                x: 0,
                y: 0,
                width: 200,
                height: 200,
            },
            {
                id: "R1",
                type: "rect",
                name: "Rectangle",
                parentId: "B1",
                frameId: "B1",
                shapes: [],
                x: 0,
                y: 0,
                width: 50,
                height: 50,
                fills: [],
            },
        ],
    };
}

/**
 * Creates a fake host. Each `$tmp:` handle of a flush gets the next `uuid-N`, in order of appearance.
 *
 * @returns the fake host with its call log
 */
function createFakeHost(): FakeHost {
    const calls: HostCalls = { loadFileOutline: [], loadPage: [], flush: [], importSvg: [], rpc: [] };
    const uuids = new Map<string, string>();
    let revn = 1;
    const host: FakeHost = {
        failNextFlush: false,
        failNextLoad: false,
        partialFailureNext: false,
        calls,
        loadFileOutline(fileId: string): string {
            calls.loadFileOutline.push(fileId);
            return JSON.stringify({ id: fileId, name: "File", revn, pages: [{ id: "P1", name: "Page 1", index: 0 }] });
        },
        loadPage(fileId: string, pageId: string): string {
            calls.loadPage.push({ fileId, pageId });
            if (host.failNextLoad) {
                host.failNextLoad = false;
                throw new Error("the file changed while the page was read");
            }
            return JSON.stringify({ ...pageFixture(revn), pageId, fileId });
        },
        flush(fileId: string, operationsJson: string, dryRun: boolean): string {
            const operations = JSON.parse(operationsJson) as Array<Record<string, unknown>>;
            calls.flush.push({ fileId, operations, dryRun });
            if (host.failNextFlush) {
                host.failNextFlush = false;
                throw new Error("Backend error validation: bad");
            }
            const createdIds: Record<string, string> = {};
            for (const op of operations) {
                for (const value of Object.values(op)) {
                    const items: unknown[] = Array.isArray(value) ? value : [value];
                    for (const item of items) {
                        if (typeof item === "string" && item.startsWith("$tmp:")) {
                            let uuid = uuids.get(item);
                            if (uuid === undefined) {
                                uuid = "uuid-" + String(uuids.size + 1);
                                uuids.set(item, uuid);
                            }
                            createdIds[item] = uuid;
                        }
                    }
                }
            }
            if (host.partialFailureNext) {
                // one chunk is saved and the next one fails: the answer names the saved ids, and the revn is not sent
                host.partialFailureNext = false;
                revn += 1;
                return JSON.stringify({
                    failure: {
                        message: "execute_code: chunk 2 of 2 of a flush failed. Chunk 2 was not applied.",
                        committed: 1,
                        createdIds,
                    },
                });
            }
            if (!dryRun) {
                revn += 1;
            }
            return JSON.stringify({
                revn,
                createdIds,
                changeCount: operations.length,
                warnings: [],
                validation: { ok: true },
                dryRun,
            });
        },
        importSvg(paramsJson: string): string {
            calls.importSvg.push(JSON.parse(paramsJson));
            return JSON.stringify({ revn, rootId: "uuid-svg", shapeIds: [] });
        },
        rpc(name: string, paramsJson: string): string {
            calls.rpc.push({ name, params: JSON.parse(paramsJson) });
            return JSON.stringify({});
        },
    };
    return host;
}

/**
 * Creates a sandbox context with the prelude loaded.
 *
 * @returns the fake host and the context
 */
function setup(): Sandbox {
    const host = createFakeHost();
    const context = vm.createContext({ __host: host });
    vm.runInContext(Prelude.build(), context);
    return { host, context };
}

/**
 * Runs one script through `__runScript`. The code and ids reach the guest as context variables.
 *
 * @param context - sandbox context
 * @param code - user code of the script
 * @param fileId - current file
 * @param pageId - current page
 * @returns the parsed envelope
 */
function runScript(context: vm.Context, code: string, fileId = "F1", pageId = "P1"): Envelope {
    Object.assign(context, { __code: code, __fileId: fileId, __pageId: pageId });
    const text = vm.runInContext("__runScript(__code, __fileId, __pageId)", context) as string;
    return JSON.parse(text) as Envelope;
}

test("prelude defines the core globals and the property table", () => {
    const { context } = setup();
    const summary = vm.runInContext(
        '[typeof __core, typeof __runScript, typeof storage, typeof console, PROPERTY_MAP.types.frame].join(",")',
        context
    );
    assert.equal(summary, "object,function,object,object,board");
    assert.match(Prelude.build(), /^var PROPERTY_MAP = \{/);
});

test("one flush sends the board and its child in order, with the handle as parent", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const board = __core.enqueue({ op: "create_board", pageId: "P1", id: "$tmp:b1", x: 0, y: 0, width: 100, height: 80, name: "Board" });
        __core.enqueue({ op: "create_rect", pageId: "P1", parentId: board, x: 5, y: 5, width: 10, height: 10, name: "Rect" });
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(host.calls.flush, [
        {
            fileId: "F1",
            dryRun: false,
            operations: [
                { op: "create_board", pageId: "P1", id: "$tmp:b1", x: 0, y: 0, width: 100, height: 80, name: "Board" },
                {
                    op: "create_rect",
                    pageId: "P1",
                    id: "$tmp:s1",
                    parentId: "$tmp:b1",
                    x: 5,
                    y: 5,
                    width: 10,
                    height: 10,
                    name: "Rect",
                },
            ],
        },
    ]);
});

test("a handle resolves to the uuid of the flush that created it", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const board = __core.enqueue({ op: "create_board", pageId: "P1", id: "$tmp:b1", x: 0, y: 0, width: 100, height: 80 });
        const rect = __core.enqueue({ op: "create_rect", pageId: "P1", parentId: board, x: 5, y: 5, width: 10, height: 10 });
        __core.flush();
        __core.enqueue({ op: "move_shapes", pageId: "P1", ids: [rect], parentId: board });
        __core.end();
        return [board, rect];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["$tmp:b1", "$tmp:s1"]);
    assert.equal(host.calls.flush.length, 2);
    assert.deepEqual(host.calls.flush[1].operations, [
        { op: "move_shapes", pageId: "P1", ids: ["uuid-2"], parentId: "uuid-1" },
    ]);
});

test("a shape updated earlier in the call reads back before any flush", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const model = __core.page(__core.fileId(), __core.pageId());
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 10, fills: [] } });
        return model.get("R1").x;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, 10);
    // the only flush is the end-of-script one, sent after the read; a flush does not read the page back.
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.loadPage.length, 1);
});

test("queued creates are visible to a page loaded after they were queued", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const board = __core.enqueue({ op: "create_board", pageId: "P1", x: 0, y: 0, width: 50, height: 50 });
        __core.enqueue({ op: "create_rect", pageId: "P1", parentId: board, x: 0, y: 0, width: 5, height: 5 });
        const model = __core.page("F1", "P1");
        return {
            boardType: model.get(board).type,
            childTypes: model.children(board).map(function (child) { return child.type; }),
            parentIsBoard: model.parentOf(model.children(board)[0].id).id === board,
        };
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, { boardType: "frame", childTypes: ["rect"], parentIsBoard: true });
    // the reads happen before the end-of-script flush, which sends both creates in one batch.
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.flush[0].operations.length, 2);
});

test("a script that never flushes gets exactly one flush at the end", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 1 } });
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 2 } });
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.flush[0].operations.length, 2);
});

test("a mid-script flush and the end-of-script flush give two flush calls", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 1 } });
        __core.flush();
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 2 } });
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(host.calls.flush.length, 2);
    assert.equal(host.calls.flush[1].operations.length, 1);
});

test("a flush does not read the touched page back; the next read loads it again", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.page("F1", "P1");
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 3 } });
        __core.flush();
        __core.page("F1", "P1");
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.loadPage.length, 2);
});

test("a read that fails after a saved flush says that the write is saved", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.page("F1", "P1");
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 3 } });
        __core.flush();
        __host.failNextLoad = true;
        __core.page("F1", "P1");
        `
    );
    assert.equal(envelope.ok, false);
    assert.equal(host.calls.flush.length, 1);
    assert.match(envelope.error?.message ?? "", /^execute_code: the writes that ran before this read are saved/);
    assert.match(envelope.error?.message ?? "", /the file changed while the page was read$/);
});

test("a read that fails before any write does not mention a saved write", () => {
    const { context } = setup();
    const envelope = runScript(context, '__host.failNextLoad = true;\n__core.page("F1", "P1");');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.message, "the file changed while the page was read");
});

test("a page read again after a flush counts once against the page cap", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        for (let i = 1; i <= 20; i += 1) {
            __core.page("F1", "P" + i);
        }
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 3 } });
        __core.flush();
        __core.page("F1", "P1");
        return "read";
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "read");
    assert.equal(host.calls.loadPage.length, 21);
});

test("a failed write that saved one chunk gives the guest the ids of that chunk", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        const handle = __core.enqueue({ op: "create_rect", pageId: "P1", x: 0, y: 0, width: 1, height: 1 });
        __host.partialFailureNext = true;
        let message = null;
        try {
            __core.end();
        } catch (err) {
            message = String(err.message);
        }
        // the batch is dropped, so the end-of-script flush sends nothing
        return [message, __core.resolve(handle)];
        `
    );
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, [
        "execute_code: chunk 2 of 2 of a flush failed. Chunk 2 was not applied.",
        "uuid-1",
    ]);
    assert.equal(host.calls.flush.length, 1);
});

test("the token write rule of the guest is the host rule", () => {
    const { host, context } = setup();
    assert.equal(vm.runInContext("JSON.stringify(TOKEN_WRITE_RULE)", context), JSON.stringify(TOKEN_WRITE_RULE));
    const envelope = runScript(
        context,
        `
        __core.enqueue({ op: "apply_token", pageId: "P1", shapeIds: ["R1"], tokenName: "t", attributes: ["fill"] });
        __core.flushTokens();
        const afterApply = __host.calls.flush.length;
        __core.enqueue({ op: "create_token", pageId: "P1", tokenName: "t" });
        __core.flushTokens();
        return [afterApply, __host.calls.flush.length];
        `
    );
    assert.equal(envelope.ok, true);
    // a token application is no token write, so only the write before the second check sends the queue
    assert.deepEqual(envelope.result, [0, 1]);
    assert.equal(host.calls.flush.length, 1);
});

test("a dry run flush keeps the pending ops and the end flush sends them again", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.enqueue({ op: "create_rect", pageId: "P1", id: "$tmp:r1", x: 0, y: 0, width: 1, height: 1 });
        const dry = __core.flush(true);
        __core.end();
        return dry.dryRun;
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, true);
    assert.deepEqual(
        host.calls.flush.map((call) => call.dryRun),
        [true, false]
    );
    assert.deepEqual(host.calls.flush[0].operations, host.calls.flush[1].operations);
});

test("setFile flushes the current file before it switches", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: 2 } });
        __core.setFile("F2");
        return __core.fileId();
        `
    );
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "F2");
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.flush[0].fileId, "F1");
});

test("console.log formats its arguments into the envelope log", () => {
    const { context } = setup();
    const envelope = runScript(context, 'console.log("a", { x: 1 });');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.log, '[LOG] a {\n  "x": 1\n}\n');
    assert.equal(envelope.undefinedResult, true);
    assert.equal(envelope.result, null);
});

test("console.warn and console.error use their level tags", () => {
    const { context } = setup();
    const envelope = runScript(context, 'console.warn("w", 2); console.error(new Error("e"));');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.log, "[WARN] w 2\n[ERROR] Error: e\n");
});

test("an uncaught throw gives ok false with the log captured before it", () => {
    const { context } = setup();
    const envelope = runScript(context, 'console.log("before");\nthrow new Error("boom");');
    assert.equal(envelope.ok, false);
    assert.ok(envelope.error);
    assert.equal(envelope.error.name, "Error");
    assert.equal(envelope.error.message, "boom");
    assert.equal(envelope.log, "[LOG] before\n");
});

test("a failing flush reports the backend error and does not resend the pending ops", () => {
    const { host, context } = setup();
    host.failNextFlush = true;
    const first = runScript(
        context,
        '__core.enqueue({ op: "create_rect", pageId: "P1", x: 0, y: 0, width: 1, height: 1 });\n__core.end();'
    );
    assert.equal(first.ok, false);
    assert.equal(first.error?.message, "Backend error validation: bad");
    assert.equal(host.calls.flush.length, 1);

    const second = runScript(context, '__core.end();\nreturn "done";');
    assert.equal(second.ok, true);
    assert.equal(second.result, "done");
    assert.equal(host.calls.flush.length, 1);
});

test("storage keeps its values between runs on the same context", () => {
    const { context } = setup();
    const first = runScript(context, "storage.count = (storage.count || 0) + 1; return storage.count;");
    const second = runScript(context, "storage.count = (storage.count || 0) + 1; return storage.count;");
    assert.equal(first.result, 1);
    assert.equal(second.result, 2);
});

test("await in the script gives ok false with the synchronous-mode hint", () => {
    const { context } = setup();
    const envelope = runScript(context, "const x = await 1;\nreturn x;");
    assert.equal(envelope.ok, false);
    assert.ok(envelope.error?.message.includes("execute_code runs synchronously in backend mode"));
});

test("5000 operations are accepted and the 5001st is refused", () => {
    const { host, context } = setup();
    const accepted = runScript(
        context,
        `
        for (let i = 0; i < 5000; i += 1) {
            __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: i } });
        }
        __core.end();
        return __core.summary().opCount;
        `
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.result, 5000);
    assert.equal(host.calls.flush.length, 1);
    assert.equal(host.calls.flush[0].operations.length, 5000);

    const refused = runScript(
        context,
        `
        for (let i = 0; i < 5001; i += 1) {
            __core.enqueue({ op: "update_shape", pageId: "P1", id: "R1", props: { x: i } });
        }
        `
    );
    assert.equal(refused.ok, false);
    assert.equal(
        refused.error?.message,
        "execute_code allows at most 5000 operations per script; split the work into several calls"
    );
    assert.equal(host.calls.flush.length, 1);
});

test("the 21st page load is refused", () => {
    const { host, context } = setup();
    const envelope = runScript(
        context,
        `
        for (let i = 1; i <= 21; i += 1) {
            __core.page("F1", "P" + i);
        }
        `
    );
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.message, "execute_code loads at most 20 pages per script");
    assert.equal(host.calls.loadPage.length, 20);
});

test("a value with a cycle is returned as its string form", () => {
    const { context } = setup();
    const envelope = runScript(context, "const a = {}; a.self = a; return a;");
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result, "[object Object]");
});

test("__drainLog returns the captured log and clears it", () => {
    const { context } = setup();
    vm.runInContext('console.log("x")', context);
    const drained = vm.runInContext("__drainLog()", context);
    const again = vm.runInContext("__drainLog()", context);
    assert.equal(drained, "[LOG] x\n");
    assert.equal(again, "");
});

test("handles increase within a call", () => {
    const { context } = setup();
    const envelope = runScript(context, 'return [__core.handle(), __core.handle("x")];');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.result, ["$tmp:s1", "$tmp:x2"]);
});
