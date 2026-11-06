/**
 * Keyword value that encodes as `~:name` in transit text.
 */
export class TransitKeyword {
    /**
     * Creates a keyword value.
     *
     * @param name - the keyword name without the leading colon
     */
    constructor(public readonly name: string) {}
}

/**
 * UUID value that encodes as `~u` followed by its text in transit text.
 */
export class TransitUuid {
    /**
     * Creates a UUID value.
     *
     * @param value - the UUID text in canonical 8-4-4-4-12 hex form
     */
    constructor(public readonly value: string) {}
}

/**
 * JSON node that the encoder produces before serialization.
 */
type TransitJson = null | boolean | number | string | TransitJson[];

/**
 * Codec for transit-json, the format the Penpot exporter speaks.
 *
 * Encoding produces the verbose form and never uses the cache. Decoding accepts the verbose form and the
 * non-verbose form, which may use the read cache. Decoding rejects escapes that this codec does not handle.
 */
export class Transit {
    private static readonly UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /**
     * Creates a keyword value.
     *
     * @param name - the keyword name without the leading colon
     * @returns the keyword value
     */
    public static keyword(name: string): TransitKeyword {
        return new TransitKeyword(name);
    }

    /**
     * Creates a UUID value after checking its text.
     *
     * @param value - the UUID text in canonical 8-4-4-4-12 hex form, in any case
     * @returns the UUID value, with the text unchanged
     * @throws Error when the text is not a canonical UUID
     */
    public static uuid(value: string): TransitUuid {
        if (!Transit.UUID_PATTERN.test(value)) {
            throw new Error(`not a canonical uuid: ${value}`);
        }
        return new TransitUuid(value);
    }

    /**
     * Encodes a value as transit-json text in verbose form.
     *
     * @param value - the value to encode, where undefined at top level becomes null
     * @returns the transit-json text
     * @throws Error when the value holds a type that transit cannot encode
     */
    public static encode(value: unknown): string {
        return JSON.stringify(Transit.toJson(value));
    }

    /**
     * Decodes transit-json text into plain values.
     *
     * Accepts the verbose form, where a map is a JSON object whose keys are transit-encoded, and the
     * non-verbose form, where a map is a `["^ ", key, value, ...]` array and strings may be cache references.
     * Maps decode to plain objects, keywords to their names, UUIDs to their text, and `~m` milliseconds to
     * ISO 8601 text.
     *
     * A tagged value is an object with exactly one key that starts with `~#` (verbose form), or a
     * two-element `["~#tag", value]` array (non-verbose form). The tag `uri` decodes to its inner value, which
     * is a string in the exporter's answers. Any other tag decodes to `{ tag, value }`, where `tag` is the tag
     * name without `~#` and `value` is the decoded inner value.
     *
     * @param text - the transit-json text
     * @returns the decoded value
     * @throws Error when the text uses a transit feature that this codec does not support, or a cache
     * reference that names no cached string
     */
    public static decode(text: string): unknown {
        const parsed: unknown = JSON.parse(text);
        return new TransitReader().read(parsed, true);
    }

    /**
     * Converts a value to the JSON node of its transit encoding.
     *
     * @param value - the value to convert
     * @returns the transit JSON node
     * @throws Error when the value has no transit encoding
     */
    private static toJson(value: unknown): TransitJson {
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value === "boolean") {
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                throw new Error(`cannot encode non-finite number: ${value}`);
            }
            return value;
        }
        if (typeof value === "string") {
            return Transit.escapeString(value);
        }
        if (value instanceof TransitKeyword) {
            return `~:${value.name}`;
        }
        if (value instanceof TransitUuid) {
            return `~u${value.value}`;
        }
        if (Array.isArray(value)) {
            const items: unknown[] = value;
            return items.map((item) => Transit.toJson(item));
        }
        if (Transit.isPlainObject(value)) {
            return Transit.encodeMap(value);
        }
        throw new Error(`cannot encode value of type ${Transit.typeName(value)}`);
    }

    /**
     * Escapes a string that would otherwise read as a transit escape or cache reference.
     *
     * @param value - the string to escape
     * @returns the string with one leading `~` added when its first character is `~`, `^` or a backtick
     */
    private static escapeString(value: string): string {
        if (/^[~^`]/.test(value)) {
            return `~${value}`;
        }
        return value;
    }

    /**
     * Encodes a plain object as a transit map.
     *
     * @param value - the plain object whose own entries are encoded
     * @returns the `["^ ", key, value, ...]` node, with undefined entries left out
     * @throws Error when a key starts with `~` or `^`
     */
    private static encodeMap(value: Record<string, unknown>): TransitJson {
        const parts: TransitJson[] = ["^ "];
        for (const [key, entry] of Object.entries(value)) {
            if (key.startsWith("~") || key.startsWith("^")) {
                throw new Error(`map key must not start with ~ or ^: ${key}`);
            }
            if (entry === undefined) {
                continue;
            }
            parts.push(`~:${key}`, Transit.toJson(entry));
        }
        return parts;
    }

    /**
     * Checks whether a value is a plain object whose prototype is Object.prototype or null.
     *
     * @param value - the value to check
     * @returns true when the value is a plain object
     */
    private static isPlainObject(value: unknown): value is Record<string, unknown> {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const proto: unknown = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    /**
     * Names the type of a value for an error message.
     *
     * @param value - the value to name
     * @returns the constructor name for objects, or the typeof result otherwise
     */
    private static typeName(value: unknown): string {
        if (typeof value === "object" && value !== null) {
            return value.constructor?.name || "object";
        }
        return typeof value;
    }
}

/**
 * Reads the parsed nodes of one transit-json text into plain values.
 *
 * One reader serves one decode. Its read cache fills in reading order, so that a cache reference resolves
 * to the string that the writer cached under the same position. Strings inside verbose objects never use
 * the cache. The cache has no reset: a writer that resets its cache after many entries is not supported.
 */
class TransitReader {
    /** Shortest string that the writer caches. */
    private static readonly MIN_CACHEABLE_LENGTH = 4;
    /** Number of codes in one cache code digit; a two-character code is `first * 44 + second`. */
    private static readonly CODE_BASE = 44;
    /** Character code of the digit zero, which is the first code character. */
    private static readonly CODE_ZERO = 48;

    /** Raw strings of the read cache, in the order that the writer assigned them. */
    private readonly cache: string[] = [];

    /**
     * Reads one parsed node.
     *
     * @param node - the parsed JSON node
     * @param cached - true when the node is in non-verbose form, where strings may use the cache
     * @returns the decoded value
     * @throws Error when the node uses an unsupported transit feature
     */
    public read(node: unknown, cached: boolean): unknown {
        if (typeof node === "string") {
            return TransitReader.decodeScalar(this.readRaw(node, cached, false));
        }
        if (Array.isArray(node)) {
            const items: unknown[] = node;
            return this.readArray(items, cached);
        }
        if (node === null || typeof node === "boolean" || typeof node === "number") {
            return node;
        }
        if (typeof node === "object") {
            return this.readObject(node as Record<string, unknown>);
        }
        throw new Error("unsupported transit JSON object");
    }

    /**
     * Reads a non-verbose array, which is a map, a tagged value or a plain array.
     *
     * @param items - the elements of the array
     * @param cached - true when the array is in non-verbose form
     * @returns the decoded map, tagged value or array
     * @throws Error when the head is a tag that does not hold exactly one value
     */
    private readArray(items: unknown[], cached: boolean): unknown {
        const head: unknown = items[0];
        if (head === "^ ") {
            return this.readMap(items.slice(1), cached);
        }
        if (typeof head !== "string") {
            return items.map((item) => this.read(item, cached));
        }
        const headText = this.readRaw(head, cached, false);
        if (headText.startsWith("~#")) {
            if (items.length !== 2) {
                throw new Error("unsupported transit tag");
            }
            return TransitReader.tagged(headText.slice(2), this.read(items[1], cached));
        }
        return [TransitReader.decodeScalar(headText), ...items.slice(1).map((item) => this.read(item, cached))];
    }

    /**
     * Builds a plain object from the alternating keys and values of a non-verbose map.
     *
     * @param entries - the map elements that follow the `^ ` marker
     * @param cached - true when the map is in non-verbose form
     * @returns the plain object with own properties for every key
     * @throws Error when the entries do not pair up or a key does not decode to a string
     */
    private readMap(entries: unknown[], cached: boolean): Record<string, unknown> {
        if (entries.length % 2 !== 0) {
            throw new Error("transit map has a key without a value");
        }
        const result: Record<string, unknown> = {};
        for (let index = 0; index < entries.length; index += 2) {
            const key = this.readKey(entries[index], cached);
            TransitReader.defineEntry(result, key, this.read(entries[index + 1], cached));
        }
        return result;
    }

    /**
     * Reads a map key of the non-verbose form, which the cache may hold.
     *
     * @param node - the parsed key
     * @param cached - true when the map is in non-verbose form
     * @returns the decoded key text
     * @throws Error when the key does not decode to a string
     */
    private readKey(node: unknown, cached: boolean): string {
        const key: unknown =
            typeof node === "string"
                ? TransitReader.decodeScalar(this.readRaw(node, cached, true))
                : this.read(node, cached);
        if (typeof key !== "string") {
            throw new Error("transit map key must be a string");
        }
        return key;
    }

    /**
     * Builds a plain object from a verbose JSON object, or returns the value of a verbose tagged object.
     *
     * @param node - the parsed JSON object
     * @returns the decoded map, or the tagged value when the object has exactly one `~#` key
     * @throws Error when a key does not decode to a string
     */
    private readObject(node: Record<string, unknown>): unknown {
        const keys = Object.keys(node);
        if (keys.length === 1 && keys[0].startsWith("~#")) {
            return TransitReader.tagged(keys[0].slice(2), this.read(node[keys[0]], false));
        }
        const result: Record<string, unknown> = {};
        for (const key of keys) {
            const name = TransitReader.decodeScalar(key);
            if (typeof name !== "string") {
                throw new Error("transit map key must be a string");
            }
            TransitReader.defineEntry(result, name, this.read(node[key], false));
        }
        return result;
    }

    /**
     * Returns the raw text of a string, resolving a cache reference and caching a cacheable string.
     *
     * Only the non-verbose form uses the cache. A string that is cacheable is appended to the cache in reading
     * order, before any unescaping.
     *
     * @param text - the string as it appears in the JSON text
     * @param cached - true when the string is in non-verbose form
     * @param isKey - true when the string is a map key
     * @returns the raw text that the cache holds for a reference, or the text itself
     * @throws Error when a cache reference names no cached string
     */
    private readRaw(text: string, cached: boolean, isKey: boolean): string {
        if (cached && text.startsWith("^") && text !== "^ ") {
            return this.lookup(text);
        }
        if (cached && TransitReader.isCacheable(text, isKey)) {
            this.cache.push(text);
        }
        return text;
    }

    /**
     * Finds the raw text that a cache reference names.
     *
     * A reference of one character is `^` followed by a code character, and its index is the code minus 48.
     * A reference of two characters has the index `first * 44 + second`, where each character is minus 48.
     *
     * @param reference - the cache reference, such as `^0` or `^10`
     * @returns the raw text that the cache holds at that index
     * @throws Error when the reference has the wrong length or its index is outside the cache
     */
    private lookup(reference: string): string {
        if (reference.length !== 2 && reference.length !== 3) {
            throw new Error(`unsupported transit cache reference: ${reference}`);
        }
        const first = reference.charCodeAt(1) - TransitReader.CODE_ZERO;
        const index =
            reference.length === 2
                ? first
                : first * TransitReader.CODE_BASE + (reference.charCodeAt(2) - TransitReader.CODE_ZERO);
        if (index < 0 || index >= this.cache.length) {
            throw new Error(`unsupported transit cache reference: ${reference}`);
        }
        return this.cache[index];
    }

    /**
     * Checks whether a raw string is one the writer caches.
     *
     * @param text - the raw string
     * @param isKey - true when the string is a map key
     * @returns true when the string is at least four characters long and is a map key or starts with `~:`, `~$` or `~#`
     */
    private static isCacheable(text: string, isKey: boolean): boolean {
        return text.length >= TransitReader.MIN_CACHEABLE_LENGTH && (isKey || /^~[:$#]/.test(text));
    }

    /**
     * Builds the value of a tagged node.
     *
     * @param tag - the tag name without its `~#` prefix
     * @param value - the decoded inner value
     * @returns the inner value for tag `uri`, or `{ tag, value }` for any other tag
     */
    private static tagged(tag: string, value: unknown): unknown {
        if (tag === "uri") {
            return value;
        }
        return { tag, value };
    }

    /**
     * Sets an own enumerable property, which keeps a key such as `__proto__` as a property.
     *
     * @param target - the object that receives the property
     * @param key - the property name
     * @param value - the property value
     */
    private static defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
        Object.defineProperty(target, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    /**
     * Decodes one raw string into its plain value, without any cache handling.
     *
     * @param text - the raw string, with its escapes still in place
     * @returns the decoded string, keyword or UUID text, number, boolean, null or ISO 8601 text
     * @throws Error when the string is a cache reference or an unsupported escape
     */
    private static decodeScalar(text: string): unknown {
        if (text === "^ ") {
            throw new Error("unsupported transit map marker");
        }
        if (text.startsWith("^")) {
            throw new Error("unsupported transit cache reference");
        }
        if (!text.startsWith("~")) {
            return text;
        }
        // escaped `~`, `^` or backtick: drop the escape character.
        if (/^~[~^`]/.test(text)) {
            return text.slice(1);
        }
        // keyword, symbol, uuid and text: keep the name or text.
        if (text.startsWith("~:") || text.startsWith("~$") || text.startsWith("~u") || text.startsWith("~t")) {
            return text.slice(2);
        }
        // milliseconds since the epoch, which may be negative.
        if (/^~m-?\d+$/.test(text)) {
            return new Date(Number(text.slice(2))).toISOString();
        }
        if (text === "~_") {
            return null;
        }
        if (text === "~?t") {
            return true;
        }
        if (text === "~?f") {
            return false;
        }
        if (/^~i-?\d+$/.test(text) || /^~d-?\d+(\.\d+)?$/.test(text)) {
            return Number(text.slice(2));
        }
        throw new Error("unsupported transit escape");
    }
}
