/**
 * Measures how deeply objects and arrays are nested in a parsed JSON value.
 *
 * The walk uses an explicit stack, so a deep value cannot overflow the call stack of the walk itself. It stops as
 * soon as the depth passes `stopAbove`, so a hostile body costs no more than the limit.
 *
 * @param value - the parsed value, for example the body of a request
 * @param stopAbove - the depth above which the walk stops and reports the depth it reached
 * @returns the deepest nesting seen, where a scalar is depth 0 and the outermost object is depth 1; at most
 *   `stopAbove + 1`
 */
export function jsonNestingDepth(value: unknown, stopAbove: number): number {
    let deepest = 0;
    const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    while (stack.length > 0) {
        const entry = stack.pop();
        if (entry === undefined) {
            break;
        }
        if (typeof entry.value !== "object" || entry.value === null) {
            continue;
        }
        const depth = entry.depth + 1;
        if (depth > deepest) {
            deepest = depth;
        }
        if (deepest > stopAbove) {
            return stopAbove + 1;
        }
        const children = Array.isArray(entry.value) ? entry.value : Object.values(entry.value);
        for (const child of children) {
            stack.push({ value: child, depth });
        }
    }
    return deepest;
}
