import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { budgetOf, PIXEL_BUDGETS } from "./Budget.js";
import { causeOf } from "./PixelCauses.js";

describe("PIXEL_BUDGETS", () => {
    it("gives components 1.0 percent and screens 0.5 percent", () => {
        assert.deepEqual(PIXEL_BUDGETS, { component: 1.0, screen: 0.5 });
    });
});

describe("budgetOf", () => {
    it("returns the budget of a component", () => {
        assert.equal(budgetOf("component"), 1.0);
    });

    it("returns the budget of a screen", () => {
        assert.equal(budgetOf("screen"), 0.5);
    });
});

describe("causeOf", () => {
    it("returns null for a target with no recorded cause", () => {
        assert.equal(causeOf("onboarding/welcome"), null);
    });

    it("does not treat inherited object keys as causes", () => {
        assert.equal(causeOf("constructor"), null);
        assert.equal(causeOf("toString"), null);
    });
});
