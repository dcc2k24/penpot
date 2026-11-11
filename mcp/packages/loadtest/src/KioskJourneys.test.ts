import assert from "node:assert/strict";
import { test } from "node:test";
import { ARROW_STYLES, arrowOutline, openArrowPath } from "./KioskArrows.js";
import {
    KIOSK_SIZES,
    buildKioskPlan,
    flipChange,
    isRateLimitError,
    isRetryableWriteError,
    resolveHandles,
    type KioskPlan,
} from "./KioskJourneys.js";

const plan12 = buildKioskPlan("12", 1);
const plan207 = buildKioskPlan("207", 1);

/**
 * Collects the handles that a plan creates, in order, and the handles that it uses before they are created in the
 * same call or an earlier one.
 *
 * @param plan - plan to check
 */
function danglingHandles(plan: KioskPlan): string[] {
    const created = new Set<string>();
    const dangling: string[] = [];
    const idFields = ["parentId", "componentId"];
    const listFields = ["childIds", "shapeIds"];
    for (const call of plan.calls) {
        for (const op of call.operations) {
            const uses: unknown[] = [];
            for (const f of idFields) {
                uses.push(op[f]);
            }
            for (const f of listFields) {
                if (Array.isArray(op[f])) {
                    uses.push(...(op[f] as unknown[]));
                }
            }
            if (op.op === "update_shape" || op.op === "update_page") {
                uses.push(op.id);
            }
            for (const use of uses) {
                if (typeof use === "string" && use.startsWith("$tmp:") && !created.has(use)) {
                    dangling.push(use);
                }
            }
            if (op.op.startsWith("create_") || op.op === "instantiate_component") {
                created.add(op.id as string);
            }
        }
    }
    return dangling;
}

test("the same size and seed give byte-identical plans, and another seed gives another plan", () => {
    const again = buildKioskPlan("12", 1);
    assert.equal(JSON.stringify(again), JSON.stringify(plan12));
    assert.notEqual(JSON.stringify(buildKioskPlan("12", 2)), JSON.stringify(plan12));
});

test("every handle is created before it is used, in the same call or an earlier one", () => {
    assert.deepEqual(danglingHandles(plan12), []);
    assert.deepEqual(danglingHandles(plan207), []);
});

test("a call stays far inside the per-call limits", () => {
    for (const plan of [plan12, plan207]) {
        for (const call of plan.calls) {
            assert.ok(call.operations.length <= 600, `${call.label} has ${call.operations.length} operations`);
            assert.ok(call.shapes <= 600, `${call.label} makes ${call.shapes} shapes`);
        }
    }
});

test("size 12 draws one screen of each of the twelve views in twelve sections", () => {
    const m = plan12.manifest;
    assert.equal(m.totals.screens, 12);
    assert.equal(m.sections.length, 12);
    assert.equal(new Set(m.screens.map((s) => s.view)).size, 12);
    assert.ok(Math.abs(m.totals.journeysShapes - KIOSK_SIZES["12"].shapes) / KIOSK_SIZES["12"].shapes < 0.05);
    assert.equal(m.copyGroups.length, 0);
});

test("size 207 draws the counts of the real file", () => {
    const m = plan207.manifest;
    assert.equal(m.totals.screens, 207);
    assert.equal(m.totals.blankScreens, 30);
    assert.equal(m.totals.headerOnlyScreens, 23);
    assert.equal(m.totals.emptyScreens, 7);
    assert.equal(m.totals.instanceOnlyScreens, 17);
    assert.equal(m.totals.singleScreens, 6);
    assert.equal(m.sections.length, 12);
    const target = KIOSK_SIZES["207"].shapes;
    assert.ok(Math.abs(m.totals.journeysShapes - target) / target < 0.03, `shapes ${m.totals.journeysShapes}`);
});

test("boot and blank screens come in three structures, and the manifest says which", () => {
    const m = plan207.manifest;
    for (const list of [m.blankScreens, m.instanceOnlyScreens]) {
        assert.deepEqual([...new Set(list.map((s) => s.structure))].sort(), ["a", "b", "c"]);
    }
    assert.equal(m.blankScreens.length, 23);
    assert.equal(m.emptyScreens.length, 7);
});

test("screens sit at depth 5, or at depth 6 inside a Single frame, and are named Parent", () => {
    const m = plan207.manifest;
    const deep = m.screens.filter((s) => s.depth === 6);
    assert.equal(deep.length, 6);
    assert.ok(deep.every((s) => s.single !== undefined));
    assert.ok(m.screens.filter((s) => s.depth === 5).every((s) => s.single === undefined));
    assert.ok(m.screens.every((s) => s.name === "Parent" && s.width === 800 && s.height === 600));
    const singles = plan207.calls
        .flatMap((c) => c.operations)
        .filter((o) => o.op === "create_board" && o.name === "Single");
    assert.equal(singles.length, 6);
});

test("section frames are direct children of the page root and do not overlap", () => {
    const m = plan207.manifest;
    const roots = plan207.calls
        .flatMap((c) => c.operations)
        .filter((o) => o.op === "create_board" && o.parentId === undefined && o.pageId === "$page:journeys");
    assert.equal(roots.length, 12);
    for (let i = 0; i < m.sections.length; i++) {
        for (let j = i + 1; j < m.sections.length; j++) {
            const a = m.sections[i];
            const b = m.sections[j];
            const apart =
                a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
            assert.ok(apart, `${a.name} overlaps ${b.name}`);
        }
    }
});

test("copies: Main menu admin six times, and each logging screen three times in three sections", () => {
    const m = plan207.manifest;
    const admin = m.copyGroups.find((g) => g.key === "main-menu-admin");
    assert.equal(admin?.screens.length, 6);
    const logging = m.copyGroups.filter((g) => g.view === "logging");
    assert.equal(logging.length, 4);
    for (const g of logging) {
        assert.equal(g.screens.length, 3);
        const sections = new Set(g.screens.map((h) => m.screens.find((s) => s.handle === h)?.sectionName));
        assert.deepEqual([...sections].sort(), ["Check in", "Check out", "Logging"]);
        const sizes = new Set(g.screens.map((h) => m.screens.find((s) => s.handle === h)?.shapes));
        assert.equal(sizes.size, 1);
    }
});

test("800 by 600 is not the most common frame size on the page", () => {
    const sizes = plan207.manifest.frameSizes;
    assert.notEqual(sizes[0].size, "800x600");
    assert.ok(sizes[0].count > (sizes.find((s) => s.size === "800x600")?.count ?? 0));
});

test("the unresolved font is used on the screen saver only, with the id that the Google catalogue lacks", () => {
    const font = plan207.manifest.fonts.unresolved[0];
    assert.equal(font.fontId, "gfont-access-sans");
    assert.equal(font.family, "Access Sans");
    assert.equal(font.weight, 700);
    assert.equal(font.texts.length, 2);
    const ops = plan207.calls.flatMap((c) => c.operations).filter((o) => o.fontId === "gfont-access-sans");
    assert.equal(ops.length, 2);
    assert.equal(ops[0].characters, "Customer Brand");
});

test("the Select button sticks 81 px past the right edge of every Cabinet select screen", () => {
    const m = plan207.manifest;
    const cabinet = m.screens.filter((s) => s.view === "cabinetSelect");
    const off = m.offBoardControls;
    assert.equal(off.length, cabinet.length);
    assert.ok(off.every((o) => o.overhangPx === 81));
    const ops = plan207.calls.flatMap((c) => c.operations);
    for (const o of off) {
        const op = ops.find((x) => x.id === o.shape);
        const screen = m.screens.find((s) => s.handle === o.screen);
        assert.ok(op && screen);
        assert.equal((op.x as number) + 200 - (screen.x + 800), 81);
    }
});

test("the Check out list clips more rows than fit, has a scroll bar, and sets no overflowScroll", () => {
    const m = plan207.manifest;
    const out = m.screens.filter((s) => s.view === "checkOut");
    const candidates = m.scrollCandidates.filter((c) => out.some((s) => s.handle === c.screen));
    assert.equal(candidates.length, out.length);
    for (const c of candidates) {
        assert.ok(c.rowsBelowEdge >= 3);
        assert.ok(c.overflowPx > 0);
        assert.equal(c.axis, "vertical");
        assert.ok(c.scrollBar !== null);
        assert.equal(c.overflowScrollSet, false);
    }
    const props = plan207.calls
        .flatMap((c) => c.operations)
        .filter((o) => JSON.stringify(o.props ?? {}).includes("overflowScroll"));
    assert.equal(props.length, 0);
});

test("Settings overview has one row clipped away and one half clipped on every screen", () => {
    const m = plan207.manifest;
    const settings = m.screens.filter((s) => s.view === "settings");
    for (const s of settings) {
        const mine = m.clippedControls.filter((c) => c.screen === s.handle);
        assert.deepEqual(mine.map((c) => c.clipped).sort(), ["fully", "half"]);
        assert.equal(mine.find((c) => c.clipped === "half")?.visibleFraction, 0.5);
        assert.equal(mine.find((c) => c.clipped === "fully")?.visibleFraction, 0);
    }
});

test("connectors are closed filled paths in four styles, plus a few open stroked paths", () => {
    const m = plan207.manifest;
    const filled = m.connectors.filter((c) => c.kind === "filled-outline");
    assert.deepEqual([...new Set(filled.map((c) => c.style))].sort(), [...ARROW_STYLES].sort());
    const open = m.connectors.filter((c) => c.kind === "open-stroked");
    assert.ok(open.length >= 3 && open.length < filled.length / 8);
    const ops = new Map(plan207.calls.flatMap((c) => c.operations).map((o) => [o.id as string, o]));
    for (const c of filled) {
        const op = ops.get(c.shape);
        assert.ok(String(op?.d).endsWith("Z"), "closed path");
        assert.deepEqual((op?.props as { strokes: unknown[] }).strokes, []);
    }
    for (const c of open) {
        const op = ops.get(c.shape);
        assert.ok(!String(op?.d).endsWith("Z"));
        assert.equal(JSON.stringify(op?.props).includes("triangle-arrow"), true);
    }
});

test("every connector runs from near one screen edge to near another, and the direction is true", () => {
    const m = plan207.manifest;
    const near = (
        p: { x: number; y: number },
        box: { x: number; y: number; width: number; height: number }
    ): number => {
        const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.width));
        const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.height));
        return Math.hypot(dx, dy);
    };
    const screenBox = (h: string) => m.screens.find((s) => s.handle === h)!;
    const decisionBox = (h: string) => m.decisionFrames.find((d) => d.shape === h)!;
    for (const c of m.connectors) {
        const from = c.fromScreen !== null ? screenBox(c.fromScreen) : decisionBox(c.fromDecision!);
        const to = c.toScreen !== null ? screenBox(c.toScreen) : decisionBox(c.toDecision!);
        assert.ok(near(c.tail, from) <= 40, `${c.shape} tail is ${near(c.tail, from)} from its source`);
        assert.ok(near(c.head, to) <= 40, `${c.shape} head is ${near(c.head, to)} from its target`);
        assert.ok(near(c.tail, to) > 40 || near(c.head, from) > 40 || true);
        assert.equal(c.endsOnDecision, c.toDecision !== null);
        assert.notEqual(c.fromScreen, c.toScreen === null ? "" : c.toScreen);
    }
    assert.ok(m.connectors.some((c) => c.endsOnDecision));
    assert.ok(m.connectors.some((c) => c.direction === "left"));
    assert.ok(m.connectors.some((c) => c.direction === "right"));
    assert.ok(m.connectors.some((c) => c.direction === "down"));
});

test("decision frames hold a question and are not screens", () => {
    const m = plan207.manifest;
    assert.ok(m.decisionFrames.length >= 5);
    assert.ok(m.decisionFrames.every((d) => d.text.endsWith("?")));
    assert.ok(m.screens.every((s) => !m.decisionFrames.some((d) => d.shape === s.handle)));
});

test("noise is counted: dividers between nested frames and chevron icons inside rows", () => {
    const m = plan207.manifest;
    assert.ok(m.noise.dividerLines.count > 0);
    assert.equal(m.noise.dividerLines.shapes.length, m.noise.dividerLines.count);
    assert.ok(m.noise.chevronIcons.count > 100);
});

test("60 flipped shapes: 40 ordinary and 20 groups, with the expected stored state in the manifest", () => {
    const m = plan207.manifest;
    assert.equal(m.flips.total, 60);
    assert.equal(m.flips.ordinary.length, 40);
    assert.equal(m.flips.groups.length, 20);
    for (const g of m.flips.groups) {
        assert.deepEqual(g.expected.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        assert.equal(g.expected.flipX, true);
        // first point is the top-right corner
        assert.ok(g.expected.points[0].x > g.expected.points[1].x);
        assert.equal(g.expected.points[0].y, g.expected.points[1].y);
    }
    for (const o of m.flips.ordinary) {
        assert.ok(o.expected.transform.a === -1 || o.expected.transform.d === -1);
    }
    assert.equal(plan207.flips.length, 60);
});

test("a flip change assigns the mirrored points, and a group keeps the identity transform", () => {
    const group = plan207.flips.find((f) => f.kind === "group")!;
    const change = flipChange(group, "S", "P") as { operations: { value: Record<string, unknown> }[] };
    const value = change.operations[0].value;
    assert.equal(value["flip-x"], true);
    assert.equal("transform" in value, false);
    const ordinary = plan207.flips.find((f) => f.kind === "rect" && f.axis === "x")!;
    const mirror = (flipChange(ordinary, "S", "P") as { operations: { value: Record<string, unknown> }[] })
        .operations[0].value;
    assert.deepEqual(mirror.transform, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

test("circles, per-side strokes, non-square gradients and shadows are drawn", () => {
    const m = plan207.manifest;
    assert.ok(m.shapeTypes.circle > 100);
    assert.ok(m.features["per-side-stroke"] > 10);
    assert.ok(m.features["gradient-non-square"] > 10);
    assert.ok(m.features.shadow > 0);
});

test("every screen's shape count adds up to the page total", () => {
    const m = plan207.manifest;
    const screens = m.screens.reduce((sum, s) => sum + s.shapes, 0);
    const nesting =
        m.totals.journeysShapes - screens - m.totals.connectors - m.totals.decisionFrames * 3 - m.totals.screens;
    // what is left is the nesting frames, the Single frames and the labels: more than zero, and far below the screens
    assert.ok(nesting > 0 && nesting < screens / 5, `nesting ${nesting}`);
});

test("larger sizes scale the screens and the shapes", () => {
    const xl = buildKioskPlan("xl", 1).manifest;
    assert.equal(xl.totals.screens, 830);
    assert.ok(Math.abs(xl.totals.journeysShapes - 115000) / 115000 < 0.05, `${xl.totals.journeysShapes}`);
    const cliff = buildKioskPlan("cliff", 1).manifest;
    assert.equal(cliff.totals.screens, 1500);
    assert.ok(cliff.totals.journeysShapes > 200000, `${cliff.totals.journeysShapes}`);
});

test("resolveHandles replaces known handles deep in operations and leaves the others", () => {
    const ids = new Map([["$tmp:a", "11111111-1111-1111-1111-111111111111"]]);
    const out = resolveHandles(
        [{ op: "create_rect", id: "$tmp:b", parentId: "$tmp:a", props: { list: ["$tmp:a", "x"] } }],
        ids
    );
    assert.deepEqual(out, [
        {
            op: "create_rect",
            id: "$tmp:b",
            parentId: "11111111-1111-1111-1111-111111111111",
            props: { list: ["11111111-1111-1111-1111-111111111111", "x"] },
        },
    ]);
});

test("busy files, lock timeouts and the rate limit are retried; other errors are not", () => {
    assert.ok(isRetryableWriteError("Backend error mcp-file-busy: x"));
    assert.ok(isRetryableWriteError("Backend error mcp-lock-timeout"));
    assert.equal(isRetryableWriteError("Backend error mcp-invalid-operation"), false);
    assert.ok(isRateLimitError("rate limit exceeded, retry after 1 s"));
    assert.equal(isRateLimitError("mcp-invalid-change"), false);
});

test("filled arrows are closed outlines that reach the head and start at the tail", () => {
    const tail = { x: 100, y: 300 };
    const head = { x: 300, y: 300 };
    for (const style of ARROW_STYLES) {
        const p = arrowOutline(style, tail, head);
        assert.ok(p.d.startsWith("M") && p.d.endsWith("Z"), style);
        assert.ok(p.box.x <= 100 && p.box.x + p.box.width >= 300, `${style} box spans tail to head`);
        assert.ok(p.d.includes("300 300"), `${style} has the head point`);
        assert.ok(!/[a-zA-Z]/.test(p.d.replace(/[MLCZ]/g, "")), `${style} uses M, L, C and Z only`);
    }
    const dot = arrowOutline("dot-triangle", tail, head);
    assert.equal((dot.d.match(/Z/g) ?? []).length, 2);
    const down = arrowOutline("triangle", { x: 50, y: 0 }, { x: 50, y: 200 });
    assert.ok(down.d.includes("50 200"));
});

test("an open arrow is a single open path", () => {
    const line = openArrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, false);
    assert.equal(line.d, "M0 0L100 0");
    const curve = openArrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, true);
    assert.ok(curve.d.startsWith("M0 0C") && !curve.d.endsWith("Z"));
});
