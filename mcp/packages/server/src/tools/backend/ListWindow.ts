/** The items a list answer keeps, with the counts that tell the agent whether it saw all of them. */
export interface ListWindowResult<T> {
    /** The first items of the list, up to the limit. */
    items: T[];
    /** Number of items in `items`. */
    shown: number;
    /** Number of items the backend returned. */
    total: number;
    /** Empty when every item is shown; otherwise says how many were cut and how to see the rest. */
    note: string;
}

/** Cuts a list answer to a limit, so that an unbounded list cannot fill the context. */
export class ListWindow {
    /** Number of items a list answer keeps when the caller sets no limit. */
    public static readonly DEFAULT_LIMIT = 100;

    /**
     * Keeps the first items of a list, up to the limit or the default limit.
     *
     * @param list - the items the backend returned
     * @param limit - largest number of items to keep; `undefined` keeps the default
     * @param noun - plural name of the items, for the note, such as `files`
     */
    public static cut<T>(list: readonly T[], limit: number | undefined, noun: string): ListWindowResult<T> {
        const kept = limit ?? ListWindow.DEFAULT_LIMIT;
        const items = list.slice(0, kept);
        const note =
            items.length < list.length
                ? `Showing ${items.length} of ${list.length} ${noun}. Repeat the call with a larger limit, or narrow ` +
                  "the request, to see the rest."
                : "";
        return { items: [...items], shown: items.length, total: list.length, note };
    }
}
