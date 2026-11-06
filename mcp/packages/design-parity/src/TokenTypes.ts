/**
 * Token types of the design spec, mapped to the type names the backend accepts.
 *
 * The spec uses camel case names, as the design tokens of the DTCG format do. The backend compiler reads the
 * `type` of `create_token` as a keyword and rejects camel case, so every type goes through `backendTokenType`
 * before it is sent. See KNOWN_GAPS.md, gap 6.
 */

/** Spec token type to backend token type. Line height is valid only inside a composite token, so it is a number. */
const BACKEND_TOKEN_TYPES: ReadonlyMap<string, string> = new Map([
    ["color", "color"],
    ["spacing", "spacing"],
    ["number", "number"],
    ["borderRadius", "border-radius"],
    ["fontSizes", "font-size"],
    ["lineHeights", "number"],
]);

/**
 * Returns the backend name of a spec token type.
 *
 * @param type - spec token type, for example `borderRadius`
 * @throws Error when the type is not a spec token type
 */
export function backendTokenType(type: string): string {
    const backend = BACKEND_TOKEN_TYPES.get(type);
    if (backend === undefined) {
        throw new Error(`token type "${type}" has no backend name`);
    }
    return backend;
}
