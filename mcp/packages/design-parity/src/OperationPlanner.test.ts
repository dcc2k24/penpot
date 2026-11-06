import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComponentSpec } from "./DesignSpec.js";
import { OperationPlanner, type Operation } from "./OperationPlanner.js";

/** A flex row with three rectangles, in spec order. */
const ROW: ComponentSpec = {
    name: "Test/Row",
    root: {
        kind: "board",
        name: "Row",
        x: 0,
        y: 0,
        width: 300,
        height: 40,
        flex: { direction: "row", gap: 8, padding: 0, align: "center" },
        children: [
            { kind: "rect", name: "A", x: 0, y: 0, width: 10, height: 10 },
            { kind: "rect", name: "B", x: 18, y: 0, width: 10, height: 10 },
            { kind: "rect", name: "C", x: 36, y: 0, width: 10, height: 10 },
        ],
    },
};

/**
 * Plans the flex row and returns its operations in emission order.
 */
function planRow(): Operation[] {
    const planner = new OperationPlanner(new Map(), new Map());
    return planner.planComponent("page-1", ROW, { x: 0, y: 0 }).ops;
}

describe("OperationPlanner child order", () => {
    it("creates the children of a flex board in spec order", () => {
        const names = planRow()
            .filter((op) => op.op === "create_rect")
            .map((op) => String(op.name));
        assert.deepEqual(names, ["A", "B", "C"]);
    });

    it("sets the flex layout after every child exists", () => {
        const ops = planRow();
        const lastChild = ops.findLastIndex((op) => op.op === "create_rect");
        const layout = ops.findIndex((op) => op.op === "set_flex_layout");
        assert.ok(lastChild >= 0, "no child was created");
        assert.ok(layout > lastChild, "set_flex_layout must come after the last child");
    });
});
