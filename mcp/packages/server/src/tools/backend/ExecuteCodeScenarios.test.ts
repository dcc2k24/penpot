import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BackendSettings } from "../../backend/BackendSettings";
import {
    FILE,
    PAGE,
    TEAM,
    applyResult,
    disposeHarnesses,
    harness,
    opNamesOf,
    opsOf,
    run,
    textOf,
    type FakeShape,
} from "./ExecuteCodeHarness";

const BOARD = "2c3d4e5f-0000-4000-8000-0000000000a1";
const RECT = "2c3d4e5f-0000-4000-8000-0000000000a2";
const GROUP = "2c3d4e5f-0000-4000-8000-0000000000a3";

test("create, style and nest shapes in one batch", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `const board = penpot.createBoard();
                 const rect = penpot.createRectangle();
                 rect.fills = [{ fillColor: "#ff0000", fillOpacity: 1 }];
                 rect.name = "Red";
                 board.appendChild(rect);
                 return "ok";`
            )
        )
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1, "expected one mcp-apply-operations call");
    // the name, the fill and the move of the rect fold into its create op.
    assert.deepEqual(opNamesOf(writes[0]), ["create_board", "create_rect"]);
    assert.ok(
        opsOf(writes[0]).every((op) => op.pageId === PAGE),
        "every op must name the page"
    );
    assert.equal((writes[0].params as { fileId: string }).fileId, FILE);
    const [board, rect] = opsOf(writes[0]);
    assert.equal(rect.parentId, board.id, "the rect is created inside the board");
    assert.equal(rect.name, "Red");
    assert.deepEqual(Object.keys(rect.props as object), ["fills"]);
    assert.equal(body.opsApplied, 2);
    assert.equal(body.flushes, 1);
    assert.equal(Object.keys(body.createdIds).length, 2, "board and rect get created ids");
});

test("a read after a write in the same script sees the pending x", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `const r = penpot.createRectangle();
                 r.x = 10;
                 return r.x;`
            )
        )
    );
    assert.equal(body.result, 10, "the read must see the queued write");
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1);
    // the x update folds into the create op.
    assert.deepEqual(opNamesOf(writes[0]), ["create_rect"]);
    assert.equal(opsOf(writes[0])[0].x, 10);
});

test("a write after a flush uses the real uuid of the first batch", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `const a = penpot.createRectangle();
                 penpot.waitForLayoutUpdate();
                 a.x = 10;
                 return a.id;`
            )
        )
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 2, "waitForLayoutUpdate must flush once more");
    assert.deepEqual(opNamesOf(writes[0]), ["create_rect"]);
    assert.deepEqual(opNamesOf(writes[1]), ["update_shape"]);
    const realId = body.createdIds["$tmp:s1"];
    assert.equal(realId, "uuid-s1");
    assert.equal(opsOf(writes[1])[0].id, realId, "the second batch must name the real uuid");
    assert.equal(body.result, realId, "the read after the flush must give the real uuid");
});

test("findShapes returns the rectangle of the page without a write", async () => {
    const { backend, tool } = harness({
        shapes: [
            { id: BOARD, type: "frame", name: "Board A" },
            { id: RECT, type: "rect", name: "Rect A" },
        ],
    });
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `const found = penpot.currentPage.findShapes({ type: "rectangle" });
                 return found.map((shape) => ({ type: shape.type, name: shape.name }));`
            )
        )
    );
    assert.deepEqual(body.result, [{ type: "rectangle", name: "Rect A" }]);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0, "a read must not write");
});

test("a board and a group read back their Plugin API types", async () => {
    const { tool } = harness({
        shapes: [
            { id: BOARD, type: "frame", name: "Board A" },
            { id: GROUP, type: "group", name: "Group A" },
        ],
    });
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `return {
                    board: penpot.currentPage.findShapes({ type: "board" }).map((shape) => shape.type),
                    group: penpot.currentPage.findShapes({ type: "group" }).map((shape) => shape.type)
                 };`
            )
        )
    );
    assert.deepEqual(body.result, { board: ["board"], group: ["group"] });
});

test("storage keeps its data between calls of the same token", async () => {
    const { tool } = harness();
    await run(tool, "storage.count = 2; return null;");
    const body = JSON.parse(textOf(await run(tool, "return storage.count * 3;")));
    assert.equal(body.result, 6);
});

test("console output keeps the level and the arguments", async () => {
    const { tool } = harness();
    const body = JSON.parse(textOf(await run(tool, 'console.log("a", 1); console.warn("w");')));
    assert.deepEqual(body.console, ["[LOG] a 1", "[WARN] w"]);
});

test("unavailable Plugin API members throw with their message", async () => {
    const { tool } = harness();
    const selection = textOf(await run(tool, "penpot.selection = [];"));
    assert.match(selection, /selection is not available in backend mode/);
    const ui = textOf(await run(tool, "penpot.ui.open();"));
    assert.match(ui, /ui\.open is not available in backend mode/);
});

test("await in a script fails with the hint to remove it", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, "const v = await Promise.resolve(1); return v;"));
    assert.match(text, /remove await/);
});

test("a thrown error keeps the console output", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'console.log("before"); throw new Error("boom");'));
    assert.match(text, /boom/);
    assert.match(text, /\[LOG\] before/);
});

test("a backend failure on a flush stops the script before a second flush", async () => {
    const { backend, tool } = harness();
    backend.fail("mcp-apply-operations", new Error("Backend error validation: bad"));
    const text = textOf(
        await run(
            tool,
            `penpot.createRectangle();
             penpot.waitForLayoutUpdate();
             penpot.createRectangle();
             return "unreachable";`
        )
    );
    assert.match(text, /Backend error validation: bad/);
    assert.doesNotMatch(text, /unreachable/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1, "no second flush after the failure");
});

test("more than 5000 operations fail before any write is sent", async () => {
    const { backend, tool } = harness();
    const text = textOf(
        await run(
            tool,
            `for (let i = 0; i < 5001; i++) {
                penpot.createRectangle();
             }`
        )
    );
    assert.match(text, /5000 operations/);
    assert.equal(backend.callsTo("mcp-apply-operations").length, 0);
});

test("per-call overhead and cold start of execute_code", async () => {
    // the burst is raised so that one tool can run 21 calls without a rate limit error.
    const { tool } = harness({ settings: new BackendSettings(undefined, undefined, 100) });
    const coldStart = performance.now();
    const first = JSON.parse(textOf(await run(tool, "return 1;")));
    const cold = performance.now() - coldStart;
    assert.equal(first.result, 1);

    const started = performance.now();
    for (let i = 0; i < 20; i++) {
        const body = JSON.parse(textOf(await run(tool, "return 1;")));
        assert.equal(body.result, 1);
    }
    const average = (performance.now() - started) / 20;
    console.log("execute_code cold start ms", Math.round(cold * 100) / 100);
    console.log("execute_code per-call overhead ms", Math.round(average * 100) / 100);
    assert.ok(average < 200, `average call took ${average} ms`);
});

test("penpotUtils is a global object", async () => {
    const { tool } = harness();
    const body = JSON.parse(textOf(await run(tool, "return typeof penpotUtils;")));
    assert.equal(body.result, "object");
});

test("penpotMgmt.listTeams returns the teams of the rpc", async () => {
    const { backend, tool } = harness();
    backend.respond("get-teams", [{ id: TEAM, name: "Scenario team" }]);
    const body = JSON.parse(textOf(await run(tool, "return penpotMgmt.listTeams();")));
    assert.deepEqual(body.result, [{ id: TEAM, name: "Scenario team" }]);
    assert.equal(backend.callsTo("get-teams").length, 1);
});

/** A script that creates one board and 2100 rectangles inside it, which makes 2101 operations after folding. */
const LARGE_FLUSH = `const board = penpot.createBoard();
                 for (let i = 0; i < 2100; i++) {
                     board.appendChild(penpot.createRectangle());
                 }
                 return "ok";`;

test("a flush over 2000 operations goes in several calls, and later calls get the ids of earlier ones", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(textOf(await run(tool, LARGE_FLUSH)));
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 2, "2101 operations go in two calls");
    assert.equal(opsOf(writes[0]).length, 1500);
    assert.equal(opsOf(writes[1]).length, 601);
    const boardHandle = opsOf(writes[0])[0].id as string;
    assert.match(boardHandle, /^\$tmp:/);
    assert.equal(
        opsOf(writes[1])[0].parentId,
        "uuid-" + boardHandle.slice("$tmp:".length),
        "the second call names the board by the id that the first call returned"
    );
    assert.equal(body.opsApplied, 2101);
    assert.equal(body.flushes, 1);
    assert.equal(body.chunks, 2);
    assert.equal(body.result, "ok");
    assert.equal(body.createdIds[boardHandle], "uuid-" + boardHandle.slice("$tmp:".length));
});

test("a failing later call names its chunk and the operations committed before it", async () => {
    let calls = 0;
    let revn = 1;
    const { tool } = harness({
        responses: {
            "mcp-apply-operations": (params: object) => {
                calls += 1;
                if (calls === 2) {
                    throw new Error("Backend error validation: second call refused");
                }
                revn += 1;
                return applyResult(params, revn);
            },
        },
    });
    const text = textOf(await run(tool, LARGE_FLUSH));
    assert.match(
        text,
        /execute_code: chunk 2 of 2 of a flush failed\. 1500 of 2101 operations of this flush were committed by the earlier chunks, and those chunks stay applied\./
    );
    assert.match(text, /Backend error validation: second call refused/);
    assert.match(text, /Applied before the failure: opsApplied=1500, flushes=0, chunks=1, revn=2, createdIds=/);
});

test("a script that queues more than 5000 ops but folds under the cap is not refused", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `for (let i = 0; i < 2600; i++) {
                     const rect = penpot.createRectangle();
                     rect.x = i;
                 }
                 return "ok";`
            )
        )
    );
    assert.equal(body.result, "ok");
    assert.equal(body.opsApplied, 2600);
    assert.equal(body.chunks, 2);
    const writes = backend.callsTo("mcp-apply-operations");
    assert.deepEqual(
        writes.map((write) => opsOf(write).length),
        [1500, 1100]
    );
});

test("the write options of the call reach every mcp-apply-operations call of the script", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(await run(tool, LARGE_FLUSH, { snapshot: true, baseRevn: 1, failOnConflict: true, allowSplit: true }))
    );
    assert.equal(body.chunks, 2);
    const writes = backend.callsTo("mcp-apply-operations").map((write) => write.params as Record<string, unknown>);
    // the harness answers revn 2 for the first call, which becomes the base of the second.
    assert.deepEqual(
        writes.map((params) => params.baseRevn),
        [1, 2]
    );
    for (const params of writes) {
        // the first call takes the snapshot, so one restore undoes the whole script.
        assert.equal(params.snapshot, writes.indexOf(params) === 0);
        assert.equal(params.failOnConflict, true);
        assert.equal(params.allowSplit, true);
    }
});

test("the 12-column grid of 792 rectangles folds into 793 operations in one call", async () => {
    const { backend, tool } = harness();
    const body = JSON.parse(
        textOf(
            await run(
                tool,
                `const board = penpot.createBoard();
                 board.name = "Grid 12 columns";
                 board.resize(1440, 7300);
                 for (let row = 0; row < 66; row++) {
                     for (let column = 0; column < 12; column++) {
                         const cell = penpot.createRectangle();
                         cell.name = "Cell " + row + "-" + column;
                         cell.resize(100, 100);
                         cell.x = column * 110;
                         cell.y = row * 110;
                         board.appendChild(cell);
                     }
                 }
                 return "ok";`
            )
        )
    );
    const writes = backend.callsTo("mcp-apply-operations");
    assert.equal(writes.length, 1, "the grid goes in one call");
    const ops = opsOf(writes[0]);
    assert.equal(ops.length, 793);
    assert.equal(ops[0].op, "create_board");
    assert.equal(ops[0].name, "Grid 12 columns");
    assert.equal(ops[0].width, 1440);
    assert.equal(ops[0].height, 7300);
    // the cell at row 5, column 7 is the 1 + 5 * 12 + 7 th operation.
    const cell = ops[68];
    assert.equal(cell.op, "create_rect");
    assert.equal(cell.name, "Cell 5-7");
    assert.equal(cell.parentId, ops[0].id);
    assert.equal(cell.x, 770);
    assert.equal(cell.y, 550);
    assert.equal(cell.width, 100);
    assert.equal(cell.height, 100);
    assert.equal(body.opsApplied, 793);
    assert.equal(body.chunks, 1);
});

test("a move into a parent named by a later op stays a move", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        `const a = penpot.createBoard();
         const b = penpot.createRectangle();
         const c = penpot.createRectangle();
         a.appendChild(c);
         a.appendChild(b);
         return "ok";`
    );
    const ops = opsOf(backend.callsTo("mcp-apply-operations")[0]);
    assert.deepEqual(
        ops.map((op) => op.op),
        ["create_board", "create_rect", "create_rect", "move_shapes"]
    );
    assert.equal(ops[3].parentId, ops[0].id);
    assert.deepEqual(ops[3].ids, [ops[1].id]);
});

test("an update after the move of its shape stays a separate op", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        `const a = penpot.createBoard();
         const b = penpot.createRectangle();
         a.appendChild(b);
         b.x = 5;
         return "ok";`
    );
    const ops = opsOf(backend.callsTo("mcp-apply-operations")[0]);
    assert.deepEqual(
        ops.map((op) => op.op),
        ["create_board", "create_rect", "update_shape"]
    );
});

test("a move into a parent created later stays a move", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        `const r = penpot.createRectangle();
         const a = penpot.createBoard();
         a.appendChild(r);
         return "ok";`
    );
    const ops = opsOf(backend.callsTo("mcp-apply-operations")[0]);
    assert.deepEqual(
        ops.map((op) => op.op),
        ["create_rect", "create_board", "move_shapes"]
    );
});

test("a rotation stays an update op, because a create does not take it", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        `const r = penpot.createRectangle();
         r.rotation = 45;
         return "ok";`
    );
    const ops = opsOf(backend.callsTo("mcp-apply-operations")[0]);
    assert.deepEqual(
        ops.map((op) => op.op),
        ["create_rect", "update_shape"]
    );
});

after(() => {
    disposeHarnesses();
});
