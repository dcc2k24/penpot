/**
 * Packs whole groups of operations into batches of at most `maxOps` operations.
 *
 * A group is never split across batches, and the order of the groups and of the operations inside them is kept.
 * Empty groups are dropped. A group larger than `maxOps` cannot be placed and raises a RangeError.
 *
 * @param groups - ordered groups of operations, for example all operations that build one component
 * @param maxOps - largest number of operations one batch may hold
 * @returns the batches, each a flat list of operations in order
 */
export function splitIntoBatches<T>(groups: readonly (readonly T[])[], maxOps = 300): T[][] {
    if (!Number.isInteger(maxOps) || maxOps < 1) {
        throw new RangeError(`maxOps must be a positive integer, got ${maxOps}`);
    }
    const batches: T[][] = [];
    let current: T[] = [];
    for (const group of groups) {
        if (group.length > maxOps) {
            throw new RangeError(`group of ${group.length} operations exceeds the batch limit of ${maxOps}`);
        }
        if (group.length === 0) {
            continue;
        }
        if (current.length + group.length > maxOps) {
            batches.push(current);
            current = [];
        }
        current.push(...group);
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}
