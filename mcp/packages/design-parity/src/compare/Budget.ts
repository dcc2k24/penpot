import type { DesignTarget } from "../Targets.js";

/** Kind of a design target: a library component or a journey screen. */
export type TargetKind = DesignTarget["kind"];

/** Pixel budget of each target kind, in percent of the pixels. A target over its budget fails the pixel gate. */
export interface PixelBudgets {
    component: number;
    screen: number;
}

/** Budgets used when no budget option is given: 1 percent for a component and 0.5 percent for a screen. */
export const DEFAULT_PIXEL_BUDGETS: Readonly<PixelBudgets> = { component: 1, screen: 0.5 };

/**
 * Returns the pixel budget of a target kind.
 *
 * @param kind - kind of the target, "component" or "screen"
 * @param budgets - budgets of the run, defaults to DEFAULT_PIXEL_BUDGETS
 * @returns the budget in percent of the pixels
 */
export function budgetOf(kind: TargetKind, budgets: Readonly<PixelBudgets> = DEFAULT_PIXEL_BUDGETS): number {
    return budgets[kind];
}

/**
 * Reads a budget option, a percentage of 0 or more.
 *
 * @param text - value from the command line
 * @param flag - option name for error messages
 * @returns the percentage
 * @throws Error when the value is not a number of 0 or more
 */
export function parseBudgetOption(text: string, flag: string): number {
    const value = text.trim() === "" ? Number.NaN : Number(text);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${flag} must be a percentage of 0 or more, got "${text}"`);
    }
    return value;
}
