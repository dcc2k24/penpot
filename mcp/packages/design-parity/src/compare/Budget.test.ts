import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { budgetOf, DEFAULT_PIXEL_BUDGETS, parseBudgetOption } from "./Budget.js";
import { causeOf } from "./PixelCauses.js";

describe("DEFAULT_PIXEL_BUDGETS", () => {
    it("gives components 1 percent and screens 0.5 percent", () => {
        assert.deepEqual(DEFAULT_PIXEL_BUDGETS, { component: 1, screen: 0.5 });
    });
});

describe("budgetOf", () => {
    it("returns the default budget of a component", () => {
        assert.equal(budgetOf("component"), 1);
    });

    it("returns the default budget of a screen", () => {
        assert.equal(budgetOf("screen"), 0.5);
    });

    it("returns the budget given for the run", () => {
        assert.equal(budgetOf("component", { component: 2.5, screen: 0.1 }), 2.5);
        assert.equal(budgetOf("screen", { component: 2.5, screen: 0.1 }), 0.1);
    });
});

describe("parseBudgetOption", () => {
    it("reads a percentage, including 0", () => {
        assert.equal(parseBudgetOption("0.75", "--pixel-budget-screens"), 0.75);
        assert.equal(parseBudgetOption("0", "--pixel-budget-screens"), 0);
    });

    it("refuses a negative, empty or non-numeric value and names the flag", () => {
        for (const text of ["-1", "", "  ", "abc", "Infinity"]) {
            assert.throws(() => parseBudgetOption(text, "--pixel-budget-components"), /--pixel-budget-components/);
        }
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
