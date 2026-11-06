import type { DesignTarget } from "../Targets.js";

/** Kind of a design target: a library component or a journey screen. */
export type TargetKind = DesignTarget["kind"];

/** Pixel budget of each target kind, in percent of the pixels. A target over its budget is a pixel failure. */
export const PIXEL_BUDGETS: Readonly<Record<TargetKind, number>> = {
    component: 1.0,
    screen: 0.5,
};

/**
 * Returns the pixel budget of a target kind.
 *
 * @param kind - kind of the target, "component" or "screen"
 * @returns the budget in percent of the pixels
 */
export function budgetOf(kind: TargetKind): number {
    return PIXEL_BUDGETS[kind];
}
