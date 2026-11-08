import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CallContext } from "../../backend/CallContext";
import { disposeHarnesses, FILE, harness, run, textOf } from "./ExecuteCodeHarness";

after(disposeHarnesses);

test("a script that replaces Promise.prototype.then ends with an error, and the next call runs", async () => {
    const { tool } = harness();
    const failure = textOf(await run(tool, "Promise.prototype.then = function () {};"));
    assert.match(failure, /promises and their callbacks/);
    const answer = JSON.parse(textOf(await run(tool, 'return "still here";')));
    assert.equal(answer.result, "still here");
});

test("a script that writes a facade global cannot change the calls after it", async () => {
    const { tool } = harness();
    await run(tool, "__core.flush = function () { return 'x' }; __runScript = null; return 'tampered';");
    const answer = JSON.parse(textOf(await run(tool, 'return "second";')));
    assert.equal(answer.result, "second");
});

test("a console log of 300 000 characters is cut to 256 kB before it is returned", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'console.log("x".repeat(300000)); return "ok";'));
    assert.ok(text.length < 300_000, `the response has ${text.length} characters`);
    assert.ok(text.includes("truncated"), "the cut is marked");
});

test("an error with a 300 000 character console log is capped in the error text too", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'console.log("y".repeat(300000)); throw new Error("boom");'));
    assert.ok(text.length < 300_000, `the error text has ${text.length} characters`);
    assert.match(text, /boom/);
    assert.match(text, /truncated/);
});

test("a result of 300 000 characters is capped, and the response says so", async () => {
    const { tool } = harness();
    const text = textOf(await run(tool, 'return "z".repeat(300000);'));
    assert.ok(text.length < 300_000, `the response has ${text.length} characters`);
    assert.match(text, /truncated/);
});

test("replacing JSON.stringify and penpot.currentPage in one call does not change the flush or the next call", async () => {
    const { backend, tool } = harness();
    await run(
        tool,
        'JSON.stringify = function () { return "x" }; penpot.currentPage = null; console.log = null; return "tampered";'
    );
    const answer = JSON.parse(textOf(await run(tool, 'penpot.createBoard(); return "ok";')));
    assert.equal(answer.result, "ok");
    assert.equal(backend.callsTo("mcp-apply-operations").length, 1);
});

test("a requestId given to the script is the request id of its first write, and the answer repeats it", async () => {
    const { backend, tool } = harness();
    const id = "2c3d4e5f-0000-4000-8000-0000000000f1";
    const answer = JSON.parse(textOf(await run(tool, 'penpot.createBoard(); return "ok";', { requestId: id })));
    assert.equal(answer.requestId, id);
    assert.equal((backend.callsTo("mcp-apply-operations")[0].params as { requestId: string }).requestId, id);
});

test("without a requestId the call makes one, sends it with its first write, and returns it", async () => {
    const { backend, tool } = harness();
    const answer = JSON.parse(textOf(await run(tool, 'penpot.createBoard(); return "ok";')));
    assert.match(answer.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(
        (backend.callsTo("mcp-apply-operations")[0].params as { requestId: string }).requestId,
        answer.requestId
    );
});

test("a flush reports progress after each chunk, through the progress reporter of the call", async () => {
    const { tool } = harness();
    const reports: Array<{ done: number; total?: number; text?: string }> = [];
    await tool.execute(
        { code: 'for (let i = 0; i < 2100; i++) { penpot.createRectangle(); } return "ok";', fileId: FILE },
        undefined,
        async (done, total, text) => {
            reports.push({ done, total, text });
        }
    );
    const chunkReports = reports.filter((report) => /operations of the flush are applied/.test(report.text ?? ""));
    assert.deepEqual(
        chunkReports.map((report) => [report.done, report.total]),
        [
            [1500, 2100],
            [2100, 2100],
        ]
    );
});

test("a backend read of a later call sees the signal of that call, not the signal of the call that made the runtime", async () => {
    const outline = {
        id: FILE,
        name: "Scenario file",
        teamId: "3d4e5f60-0000-4000-8000-0000000000b1",
        revn: 1,
        pages: [{ id: "1b2c3d4e-0000-4000-8000-000000000012", name: "Page 1", index: 0 }],
    };
    const seenSignals: Array<AbortSignal | undefined> = [];
    const { tool } = harness({
        responses: {
            "get-mcp-file-outline": () => {
                seenSignals.push(CallContext.current()?.signal);
                return outline;
            },
        },
    });
    const code = 'return penpot.currentPage ? "page" : "none";';
    const first = new AbortController();
    const second = new AbortController();
    await tool.execute({ code, fileId: FILE }, first.signal);
    await tool.execute({ code, fileId: FILE }, second.signal);
    assert.equal(seenSignals.length, 2);
    assert.equal(seenSignals[0], first.signal);
    assert.equal(seenSignals[1], second.signal);
});

test("a read flood ends at the host-time budget, with an error that names the setting", async () => {
    const saved = process.env.PENPOT_MCP_SANDBOX_HOST_MS;
    process.env.PENPOT_MCP_SANDBOX_HOST_MS = "150";
    let harnessed: ReturnType<typeof harness>;
    try {
        harnessed = harness({
            responses: {
                "get-teams": async () => {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    return [];
                },
            },
        });
    } finally {
        if (saved === undefined) {
            delete process.env.PENPOT_MCP_SANDBOX_HOST_MS;
        } else {
            process.env.PENPOT_MCP_SANDBOX_HOST_MS = saved;
        }
    }
    const { backend, tool } = harnessed;
    const text = textOf(await run(tool, "for (let i = 0; i < 10; i++) { penpotMgmt.listTeams(); } return 'done';"));
    assert.match(text, /host-time budget of 150 ms \(PENPOT_MCP_SANDBOX_HOST_MS\)/);
    assert.ok(backend.callsTo("get-teams").length <= 3, `the script made ${backend.callsTo("get-teams").length} reads`);
});
