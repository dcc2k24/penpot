import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeModel } from "../DesignModel.js";
import type { DesignTarget } from "../Targets.js";
import type { DomMismatch } from "./DomCompare.js";
import type { CompareReport } from "./Report.js";
import { formatCompareTable, selectTargetList, selectTargets } from "./CompareCommand.js";

/**
 * Builds a minimal node with every field set to an empty value.
 *
 * @param id - id of the node
 * @param name - name of the node
 */
function makeNode(id: string, name: string): NodeModel {
    return {
        id,
        name,
        type: "board",
        parentId: null,
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        rotation: null,
        hidden: null,
        opacity: null,
        fills: [],
        strokes: [],
        radius: null,
        layout: null,
        layoutItem: null,
        text: null,
        component: null,
        children: [],
    };
}

/**
 * Builds a screen target for a journey and a screen name.
 *
 * @param journey - journey name, for example "Onboarding"
 * @param screen - screen name, for example "Welcome"
 */
function makeScreen(journey: string, screen: string): DesignTarget {
    const id = `${journey.toLowerCase()}/${screen.toLowerCase()}`;
    return {
        kind: "screen",
        id,
        journey,
        screen,
        name: `${journey} / ${screen}`,
        pageId: "page-1",
        pageName: `Journey: ${journey}`,
        board: makeNode(`board-${id}`, `${journey} / ${screen}`),
        route: `/${id}`,
        modulePath: `screens/${journey}/${screen}.tsx`,
        componentName: `${journey}${screen}`,
    };
}

/**
 * Builds a component target for a full component name.
 *
 * @param name - full name of the component, for example "Button/Primary/SM"
 */
function makeComponent(name: string): DesignTarget {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
        kind: "component",
        id: name,
        name,
        mainBoardId: `main-${slug}`,
        board: makeNode(`main-${slug}`, name),
        route: `/components/${slug}`,
        modulePath: `components/${name.replace(/[^A-Za-z0-9]+/g, "")}.tsx`,
        componentName: name.replace(/[^A-Za-z0-9]+/g, ""),
    };
}

test("selectTargets without a filter returns every target in the same order", () => {
    const targets = [
        makeComponent("Button/Primary/SM"),
        makeScreen("Onboarding", "Welcome"),
        makeScreen("Shop", "Cart"),
    ];
    const selected = selectTargets(targets, undefined);
    assert.deepEqual(selected, targets);
    assert.notEqual(selected, targets);
});

test("selectTargets matches an id or a name exactly and ignores case", () => {
    const welcome = makeScreen("Onboarding", "Welcome");
    const targets = [makeComponent("Button/Primary/SM"), welcome, makeScreen("Shop", "Cart")];

    assert.deepEqual(selectTargets(targets, "onboarding/welcome"), [welcome]);
    assert.deepEqual(selectTargets(targets, "ONBOARDING/WELCOME"), [welcome]);
    assert.deepEqual(selectTargets(targets, "Onboarding / Welcome"), [welcome]);
});

test("selectTargets does not match a substring of a name", () => {
    const targets = [makeScreen("Onboarding", "Welcome")];
    assert.throws(() => selectTargets(targets, "Welcome"), /no target matches/);
});

test("selectTargets throws with the filter in the message when nothing matches", () => {
    const targets = [makeScreen("Onboarding", "Welcome")];
    assert.throws(() => selectTargets(targets, "nothing"), /no target matches "nothing"/);
});

test("formatCompareTable prints one row per target, the pixel cell and the summary", () => {
    const mismatch: DomMismatch = {
        targetId: "onboarding/welcome",
        targetName: "Onboarding / Welcome",
        nodeId: "node-1",
        nodeName: "Title",
        path: "root/Title",
        attribute: "font-size",
        design: "24",
        implemented: "20",
        tolerance: "0",
        classification: "unclassified",
    };
    const report: CompareReport = {
        generatedFrom: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        dom: {
            targets: [
                {
                    id: "onboarding/welcome",
                    name: "Onboarding / Welcome",
                    nodes: 3,
                    checked: 10,
                    mismatches: 1,
                    info: ["x"],
                    duplicates: [],
                },
            ],
            mismatches: [mismatch],
            checked: 10,
            info: 1,
        },
        pixel: [{ targetId: "onboarding/welcome", status: "unavailable", reason: "empty PNG" }],
        budgets: { component: 1, screen: 0.5 },
        scale: 2,
    };

    const table = formatCompareTable(report);
    const lines = table.split("\n");

    assert.ok(table.includes("onboarding/welcome"));
    assert.ok(table.includes("unavailable: empty PNG"));
    assert.ok(table.includes("DOM mismatches: 1 across 1 targets"));
    assert.equal(lines[0].indexOf("pixel"), lines[1].indexOf("unavailable: empty PNG"));
});

test("formatCompareTable flags an ok pixel result over its budget and counts it in the summary", () => {
    const report: CompareReport = {
        generatedFrom: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        dom: {
            targets: [
                {
                    id: "onboarding/welcome",
                    name: "Onboarding / Welcome",
                    nodes: 3,
                    checked: 3,
                    mismatches: 0,
                    info: [],
                    duplicates: [],
                },
                {
                    id: "button/primary",
                    name: "Button/Primary",
                    nodes: 1,
                    checked: 1,
                    mismatches: 0,
                    info: [],
                    duplicates: [],
                },
            ],
            mismatches: [],
            checked: 4,
            info: 0,
        },
        pixel: [
            {
                targetId: "onboarding/welcome",
                status: "ok",
                percent: 0.8,
                budget: 0.5,
                overBudget: true,
                cause: null,
            },
            {
                targetId: "button/primary",
                status: "ok",
                percent: 0.2,
                budget: 1,
                overBudget: false,
                cause: null,
            },
        ],
        budgets: { component: 1, screen: 0.5 },
    };

    const lines = formatCompareTable(report).split("\n");

    assert.ok(lines[1].includes("0.8% (budget 0.5%) OVER BUDGET"));
    assert.ok(lines[2].includes("0.2% (budget 1%)"));
    assert.ok(!lines[2].includes("OVER BUDGET"));
    assert.ok(lines[3].includes("pixel over budget: 1 targets"));
    assert.ok(lines[3].includes("component 1 percent and screen 0.5 percent"));
});

test("formatCompareTable shows the largest cluster, the cluster count and the real mismatch count", () => {
    const report: CompareReport = {
        generatedFrom: "2026-01-01T00:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        dom: {
            targets: [
                {
                    id: "button/primary",
                    name: "Button/Primary",
                    nodes: 1,
                    checked: 1,
                    mismatches: 0,
                    info: [],
                    duplicates: [],
                },
                {
                    id: "tooltip",
                    name: "Tooltip",
                    nodes: 1,
                    checked: 1,
                    mismatches: 0,
                    info: [],
                    duplicates: [],
                },
            ],
            mismatches: [],
            checked: 2,
            info: 0,
        },
        pixel: [
            {
                targetId: "button/primary",
                status: "ok",
                percent: 0.4,
                budget: 1,
                overBudget: false,
                cause: null,
                largestCluster: 13,
                clusters: 3,
                realMismatch: true,
            },
            { targetId: "tooltip", status: "unavailable", reason: "empty PNG" },
        ],
        budgets: { component: 1, screen: 0.5 },
        scale: 2,
    };

    const lines = formatCompareTable(report).split("\n");

    assert.deepEqual(lines[0].split(/\s{2,}/), [
        "target",
        "nodes",
        "DOM mismatches",
        "info",
        "largest cluster",
        "clusters",
        "pixel",
    ]);
    assert.deepEqual(lines[1].split(/\s{2,}/), [
        "button/primary",
        "1",
        "0",
        "0",
        "13",
        "3",
        "0.4% (budget 1%) REAL MISMATCH",
    ]);
    assert.deepEqual(lines[2].split(/\s{2,}/), ["tooltip", "1", "0", "0", "-", "-", "unavailable: empty PNG"]);
    assert.ok(lines[3].includes("real mismatches: 1 targets"));
});

test("selectTargetList keeps model order, matches several filters and rejects an unknown one", () => {
    const welcome = makeScreen("Onboarding", "Welcome");
    const cart = makeScreen("Shop", "Cart");
    const button = makeComponent("Button/Primary/SM");
    const targets = [button, welcome, cart];

    assert.deepEqual(selectTargetList(targets, ["shop/cart", "button/primary/sm"]), [button, cart]);
    assert.deepEqual(selectTargetList(targets, ["shop/cart", "shop/cart"]), [cart]);
    assert.deepEqual(selectTargetList(targets, []), []);
    assert.throws(() => selectTargetList(targets, ["shop/cart", "nothing"]), /no target matches "nothing"/);
});
