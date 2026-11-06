/**
 * Size in pixels, at the device scale used by the pixel compare, above which the largest cluster of different pixels
 * marks a real mismatch. The rule is a guess and does not separate glyph anti-aliasing from real errors: text-heavy
 * targets form large clusters even when their percent is small, so a flag means look, not a verdict.
 */
export const REAL_MISMATCH_CLUSTER = 12;

/**
 * Counts the clusters of different pixels in a mask. Two pixels belong to the same cluster when they touch, including
 * diagonally (8-neighbour connectivity). The search uses an explicit stack, so a large image cannot overflow the call
 * stack.
 *
 * @param mask - one byte per pixel in row order, 1 for a different pixel and 0 for the rest
 * @param width - width of the mask in pixels
 * @param height - height of the mask in pixels
 * @returns the size of the largest cluster (0 when there is none) and the number of clusters
 * @throws RangeError when the mask length is not width times height
 */
export function clusterMask(mask: Uint8Array, width: number, height: number): { largest: number; count: number } {
    if (mask.length !== width * height) {
        throw new RangeError(`mask length ${mask.length} does not match ${width}x${height}`);
    }
    const seen = new Uint8Array(mask.length);
    const stack: number[] = [];
    let largest = 0;
    let count = 0;
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] !== 1 || seen[start] === 1) {
            continue;
        }
        count++;
        let size = 0;
        seen[start] = 1;
        stack.push(start);
        for (;;) {
            const index = stack.pop();
            if (index === undefined) {
                break;
            }
            size++;
            const x = index % width;
            const y = (index - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        continue;
                    }
                    const next = ny * width + nx;
                    if (mask[next] === 1 && seen[next] === 0) {
                        seen[next] = 1;
                        stack.push(next);
                    }
                }
            }
        }
        largest = Math.max(largest, size);
    }
    return { largest, count };
}
