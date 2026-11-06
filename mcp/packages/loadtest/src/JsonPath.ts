/** One step of a parsed path. */
type PathSegment = { kind: "key"; name: string } | { kind: "index"; index: number } | { kind: "wildcard" };

/**
 * A small JSONPath reader for capture expressions.
 *
 * Supported syntax: `$` for the root, `.name`, `["name"]`, `[n]` and `[*]`. A wildcard maps the rest of the
 * path over every element of an array and returns the array of results without undefined entries.
 */
export class JsonPath {
    private readonly segments: readonly PathSegment[];

    /**
     * @param expression - the source text, kept for error messages
     * @param segments - parsed segments, applied in order
     */
    private constructor(
        readonly expression: string,
        segments: readonly PathSegment[]
    ) {
        this.segments = segments;
    }

    /**
     * Parses a path expression.
     *
     * @param expression - path that starts with `$`
     * @throws Error when the expression is malformed
     */
    static parse(expression: string): JsonPath {
        if (!expression.startsWith("$")) {
            throw new Error(`JSONPath must start with $: ${expression}`);
        }
        const segments: PathSegment[] = [];
        let pos = 1;
        while (pos < expression.length) {
            const ch = expression[pos];
            if (ch === ".") {
                const start = pos + 1;
                let end = start;
                while (end < expression.length && expression[end] !== "." && expression[end] !== "[") {
                    end++;
                }
                if (end === start) {
                    throw new Error(`JSONPath has an empty key at ${pos}: ${expression}`);
                }
                segments.push({ kind: "key", name: expression.slice(start, end) });
                pos = end;
            } else if (ch === "[" && expression[pos + 1] === '"') {
                const end = expression.indexOf('"]', pos + 2);
                if (end < 0) {
                    throw new Error(`JSONPath has an unterminated quoted key: ${expression}`);
                }
                segments.push({ kind: "key", name: expression.slice(pos + 2, end) });
                pos = end + 2;
            } else if (ch === "[") {
                const end = expression.indexOf("]", pos);
                if (end < 0) {
                    throw new Error(`JSONPath has an unterminated bracket: ${expression}`);
                }
                const inner = expression.slice(pos + 1, end).trim();
                if (inner === "*") {
                    segments.push({ kind: "wildcard" });
                } else if (/^\d+$/.test(inner)) {
                    segments.push({ kind: "index", index: Number(inner) });
                } else {
                    throw new Error(`JSONPath bracket must be [n], ["name"] or [*]: ${expression}`);
                }
                pos = end + 1;
            } else {
                throw new Error(`Unexpected character "${ch}" in JSONPath at ${pos}: ${expression}`);
            }
        }
        return new JsonPath(expression, segments);
    }

    /**
     * Reads the value at this path.
     *
     * @param root - parsed JSON document
     * @returns the value, or undefined when the path matches nothing
     */
    read(root: unknown): unknown {
        return JsonPath.readFrom(root, this.segments, 0);
    }

    /**
     * Applies segments from a position onwards.
     *
     * @param value - current value
     * @param segments - all segments of the path
     * @param start - index of the first segment still to apply
     */
    private static readFrom(value: unknown, segments: readonly PathSegment[], start: number): unknown {
        let current = value;
        for (let i = start; i < segments.length; i++) {
            const segment = segments[i];
            if (segment.kind === "wildcard") {
                if (!Array.isArray(current)) {
                    return undefined;
                }
                return current
                    .map((item) => JsonPath.readFrom(item, segments, i + 1))
                    .filter((item) => item !== undefined);
            }
            if (current === null || typeof current !== "object") {
                return undefined;
            }
            if (segment.kind === "index") {
                if (!Array.isArray(current)) {
                    return undefined;
                }
                current = current[segment.index];
            } else {
                if (Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment.name)) {
                    return undefined;
                }
                current = (current as Record<string, unknown>)[segment.name];
            }
        }
        return current;
    }
}
