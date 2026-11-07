/** Raw JSON object as the backend returns it. */
type RawRecord = Record<string, unknown>;

/** What one get_shapes call answered. */
export interface ShapeAnswer {
    /** Shapes that the answer carries, in the order of the request. */
    readonly shapes: RawRecord[];
    /** Ids that the page does not hold. */
    readonly missing: string[];
    /** True when the adapter cut the answer at its size limit. */
    readonly truncated: boolean;
}

/** One get_shapes call for a list of ids. */
export type ShapeRequest = (ids: string[]) => Promise<ShapeAnswer>;

/** Ids in the first request for a list. Halved again when an answer is cut. */
export const FIRST_CHUNK = 40;

/** Shapes and missing ids that a list of requests read. */
export interface ShapeChunkResult {
    /** Shapes by id, for the ids that the answers carried. */
    readonly shapes: Map<string, RawRecord>;
    /** Ids that no answer carried and that the page does not hold. */
    readonly missing: string[];
}

/**
 * Reads the shapes of a list of ids. The list goes out in chunks of FIRST_CHUNK ids. When an answer is cut, the ids
 * it did not answer go out again in two halves, and so on, until every id is answered. Shapes that a cut answer
 * carried are kept, so nothing is asked twice.
 *
 * @param ids - ids to read
 * @param request - one get_shapes call for a list of ids
 * @param label - name of the page or the list, for error messages
 * @returns the shapes and the missing ids
 * @throws Error when a single id is still cut at the size limit, so that its shape cannot be read
 */
export async function fetchShapeChunks(
    ids: readonly string[],
    request: ShapeRequest,
    label: string
): Promise<ShapeChunkResult> {
    const shapes = new Map<string, RawRecord>();
    const missing: string[] = [];
    const pending: string[][] = [];
    for (let start = 0; start < ids.length; start += FIRST_CHUNK) {
        pending.push(ids.slice(start, start + FIRST_CHUNK));
    }
    while (pending.length > 0) {
        const chunk = pending.shift() ?? [];
        const answer = await request(chunk);
        const answered = new Set<string>();
        for (const shape of answer.shapes) {
            if (typeof shape.id === "string") {
                shapes.set(shape.id, shape);
                answered.add(shape.id);
            }
        }
        for (const id of answer.missing) {
            missing.push(id);
            answered.add(id);
        }
        if (!answer.truncated) {
            continue;
        }
        const dropped = chunk.filter((id) => !answered.has(id));
        if (dropped.length === 0) {
            continue;
        }
        if (chunk.length === 1) {
            throw new Error(`${label}: shape ${chunk[0]} is cut at the response size limit, so it cannot be read`);
        }
        // Each half is smaller than the chunk, so the loop ends: a single id is either answered or reported above.
        const half = Math.ceil(dropped.length / 2);
        const halves = [dropped.slice(0, half), dropped.slice(half)].filter((part) => part.length > 0);
        pending.unshift(...halves);
    }
    return { shapes, missing };
}
