// Case 4 of T4: the exporter container is stopped; export_shape fails, the other tools keep working.
//
// Expected (plan T4): export_shape fails within the exporter timeout with a clear error (ExporterClient default
// 120 s, see --export-timeout-s), get_file_outline still answers, and an export works again after the container
// starts.
//
// Usage:
//   node exporter-stopped.mjs --dry-run
//   node exporter-stopped.mjs --yes --token-file <file> --vars <vars.json>
//
// --yes is required: the case stops and starts the exporter container.

import {
    runCase,
    CONTAINERS,
    containerAction,
    ensureRunning,
    createScratchPage,
    dbRevn,
    isRunning,
    outcome,
    outlineShapeCount,
    runTag,
    waitFor,
} from "./lib.mjs";

const NAME = "exporter-stopped";

const USAGE = `${NAME}: stops ${CONTAINERS.exporter}; export_shape must fail fast, other tools must still work.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url, --results-dir, --adapter-log
Extra: --export-timeout-s <120> (exporter call timeout the adapter uses), --recover-wait-s <150>`;

function boardOperation(pageId, name) {
    return {
        op: "create_board",
        pageId,
        id: "$tmp:board",
        name,
        x: 100,
        y: 100,
        width: 200,
        height: 150,
        props: { fills: [{ fillColor: "#FFFFFF", fillOpacity: 1 }] },
    };
}

await runCase(NAME, { "--export-timeout-s": 120, "--recover-wait-s": 150 }, async (c) => {
    const tag = runTag("c4");
    const pageName = `chaos ${tag}`;
    const fileId = c.config.vars.fileId;
    let pageId;
    let boardId;
    let baseline;
    let during;
    let duringOutline;
    let after;

    pageId = await c.step(
        "create a scratch page",
        () => createScratchPage(c, pageName),
        "a new page, so the test page of the file is not touched"
    );

    boardId = await c.step(
        "create a board to export",
        async () => {
            const answer = await c.call("apply_operations", {
                fileId,
                pageId,
                operations: [boardOperation(pageId, `${tag}-board`)],
            });
            const id = answer.json?.createdIds?.["$tmp:board"];
            if (!answer.ok || !id) {
                throw new Error(`could not create the board: ${answer.text.slice(0, 200)}`);
            }
            return id;
        },
        "one create_board"
    );

    baseline = await c.step(
        "export while the exporter runs",
        () => c.call("export_shape", { fileId, pageId, shapeId: boardId, format: "png" }),
        "export_shape png, baseline"
    );
    c.observe("exportBaseline", outcome(baseline));

    await c.step(
        `stop ${CONTAINERS.exporter}`,
        () => {
            c.registerCleanup(`start ${CONTAINERS.exporter}`, () => ensureRunning(CONTAINERS.exporter, c.opts.yes));
            return containerAction("stop", CONTAINERS.exporter, { yes: c.opts.yes });
        },
        "docker stop, no volume is touched"
    );

    during = await c.step(
        "export while the exporter is down",
        () => c.call("export_shape", { fileId, pageId, shapeId: boardId, format: "png" }),
        `expected to fail within ${c.opts.extra["--export-timeout-s"]} s`
    );
    c.observe("exportDuringOutage", outcome(during));

    duringOutline = await c.step(
        "read the outline while the exporter is down",
        async () => {
            const answer = await c.call("get_file_outline", { fileId });
            return { ok: answer.ok, text: answer.text.slice(0, 160) };
        },
        "get_file_outline must still answer"
    );
    c.observe("outlineDuringOutage", duringOutline);
    c.observe(
        "shapesDuringOutage",
        await c.step(
            "read the shape count of the scratch page",
            () => outlineShapeCount(c, pageName),
            "outline shapeCount"
        )
    );

    await c.step(
        `start ${CONTAINERS.exporter}`,
        () => containerAction("start", CONTAINERS.exporter, { yes: c.opts.yes }),
        "docker start"
    );
    await c.step(
        "wait until the container runs",
        () =>
            waitFor("exporter running", () => isRunning(CONTAINERS.exporter), { timeoutMs: 60_000, intervalMs: 2000 }),
        "docker inspect State.Running"
    );

    after = await c.step(
        "export after the restart (retried for the recovery window)",
        async () => {
            try {
                return await waitFor(
                    "an export that works",
                    async () => {
                        const answer = await c.call("export_shape", {
                            fileId,
                            pageId,
                            shapeId: boardId,
                            format: "png",
                        });
                        return answer.ok ? answer : false;
                    },
                    { timeoutMs: c.opts.extra["--recover-wait-s"] * 1000, intervalMs: 5000 }
                );
            } catch (error) {
                return { ok: false, isError: true, text: "", error: error.message };
            }
        },
        "export_shape png on the same board"
    );
    c.observe("exportAfterRestart", after.error ? { error: after.error } : outcome(after));

    const exportDbRevn = await c.step(
        "read the revision",
        () => dbRevn(fileId),
        "file.revn (an export writes nothing)"
    );
    c.observe("revnAtEnd", exportDbRevn);

    c.check(
        "export fails while the exporter is down",
        "export_shape returns an error, not an image",
        during.ok === false && (during.isError === true || during.error !== undefined),
        outcome(during)
    );
    c.check(
        "export fails within the exporter timeout",
        "the failure comes within 15 s: the exporter is down, so the connection is refused at once; a hang is a failure",
        during.durationMs < 15_000,
        { durationMs: Math.round(during.durationMs) }
    );
    c.check(
        "error text is clear",
        "the answer names the failure (non-empty text or a transport error), with no Java stack trace",
        (during.text?.length > 0 || during.error !== undefined) &&
            !/NullPointer|\bat [a-z]+\.[a-z]/i.test(during.text ?? ""),
        { text: (during.text ?? during.error ?? "").slice(0, 200) }
    );
    c.check(
        "other tools unaffected",
        "get_file_outline answers while the exporter is down",
        duringOutline.ok === true,
        duringOutline
    );
    c.check(
        "export works after the restart",
        "export_shape answers with an image once the container runs",
        after.ok === true && after.isError !== true,
        after.error ? { error: after.error } : outcome(after)
    );
    c.note(
        "A timed out export is retried against the same board; the export writes no change, so the retry has no side effect."
    );
});
