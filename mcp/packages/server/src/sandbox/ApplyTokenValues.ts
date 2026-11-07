import type { PenpotBackend } from "../PenpotBackendClient";
import { TokenResolver } from "./TokenResolver";

/** A warning about the value an `apply_token` operation carries, added to the result of the write. */
export interface TokenValueWarning {
    /**
     * `token-value-differs` when the supplied value is not the token's resolved value; `token-value-unchecked`
     * when the token could not be resolved, so the supplied value was not checked.
     */
    kind: "token-value-differs" | "token-value-unchecked";
    /** Position of the operation in the batch. */
    operationIndex: number;
    /** Name of the token the operation applies. */
    tokenName: string;
    /** Value the caller supplied, which the write keeps. */
    suppliedValue: unknown;
    /** Value of the token in the file's active sets, when it resolved. */
    resolvedValue?: unknown;
    /** What the warning means, in words. */
    message: string;
}

/**
 * Token catalogue of one file, read through `get-mcp-tokens` at most once.
 *
 * A failed read is not kept, so a later request reads the catalogue again.
 */
export class TokenCatalogue {
    /** Resolver over the catalogue, once a read has started. */
    private pending: Promise<TokenResolver> | undefined;

    /**
     * Creates the catalogue of a file. Nothing is read until {@link resolver} is called.
     *
     * @param backend - backend that answers `get-mcp-tokens`
     * @param userToken - MCP token the read runs under
     * @param fileId - file whose tokens are read
     */
    constructor(
        private readonly backend: PenpotBackend,
        private readonly userToken: string,
        private readonly fileId: string
    ) {}

    /**
     * Returns the resolver over the tokens of the file, reading the catalogue on the first call.
     *
     * @returns the resolver
     * @throws Error when the backend refuses the read
     */
    public resolver(): Promise<TokenResolver> {
        if (this.pending === undefined) {
            this.pending = this.backend
                .callCommand(this.userToken, "get-mcp-tokens", { fileId: this.fileId })
                .then((catalogue) => TokenResolver.fromCatalogue(catalogue));
            this.pending.catch(() => {
                this.pending = undefined;
            });
        }
        return this.pending;
    }
}

/**
 * The token write rule, shared by the host and the guest. The prelude copies it into the guest, so both sides name
 * the same operations. `pattern` matches the names of the ops that change tokens, sets, themes or the base font
 * size; `shapeOps` are the ops that apply or remove a token on shapes, which the pattern also matches and which do
 * not change the catalogue.
 */
export const TOKEN_WRITE_RULE: { readonly pattern: string; readonly shapeOps: readonly string[] } = {
    pattern: "token|theme|toggle_set|base_font_size",
    shapeOps: ["apply_token", "unapply_token"],
};

/**
 * Fills the values of the `apply_token` operations of one batch from the token catalogue of the file.
 *
 * Both write paths use it: `apply_operations` and the flushes of `execute_code`. An operation without
 * `resolvedValue` gets the token's value from the active sets, through {@link TokenResolver}. An operation with
 * `resolvedValue` keeps it, since the caller may set the value on purpose, and gets a warning when the value is not
 * the token's. The catalogue is read only when the batch holds an `apply_token` operation.
 *
 * An operation that changes tokens, sets, themes or the base font size makes the catalogue stale for the later
 * operations of the same batch, since the backend applies the batch only after the values are filled. An
 * `apply_token` after such an operation must carry its own value.
 */
export class ApplyTokenValues {
    /** Operation names that apply or remove a token on shapes, and so do not change the catalogue. */
    private static readonly SHAPE_TOKEN_OPS: ReadonlySet<string> = new Set(TOKEN_WRITE_RULE.shapeOps);

    /** Pattern of the operation names that change tokens, sets, themes or the base font size. */
    private static readonly TOKEN_WRITE = new RegExp(TOKEN_WRITE_RULE.pattern);

    /**
     * Creates a filler for one write path.
     *
     * @param prefix - text that starts each error message, such as `apply_operations`
     * @param hint - text added to an error about a value that cannot be resolved, or the empty string
     */
    constructor(
        private readonly prefix: string,
        private readonly hint: string
    ) {}

    /**
     * Tells whether an operation changes tokens, sets, themes or the base font size, which makes a catalogue read
     * before it stale.
     *
     * @param operation - one operation of a batch
     * @returns true for such an operation; false for `apply_token`, `unapply_token` and every other operation
     */
    public static changesTokens(operation: unknown): boolean {
        if (!ApplyTokenValues.isRecord(operation)) {
            return false;
        }
        const name = String(operation.op);
        return !ApplyTokenValues.SHAPE_TOKEN_OPS.has(name) && ApplyTokenValues.TOKEN_WRITE.test(name);
    }

    /**
     * Fills `resolvedValue` of every `apply_token` operation that has none, and checks the value of those that
     * have one.
     *
     * An operation whose `tokenName` is not text is left as it is, for the operation validator to report.
     *
     * @param operations - the operations of the batch, changed in place
     * @param catalogue - token catalogue of the file the batch writes to
     * @returns one warning per supplied value that differs from the token's value, or that could not be checked
     * @throws Error when an operation without a value names a token that is missing, is in no active set, has a
     *   reference cycle or an unsupported expression, or follows an operation of the batch that changes tokens
     */
    public async fill(operations: unknown[], catalogue: TokenCatalogue): Promise<TokenValueWarning[]> {
        const warnings: TokenValueWarning[] = [];
        let tokenWriteAt = -1;
        for (let index = 0; index < operations.length; index += 1) {
            const operation = operations[index];
            if (!ApplyTokenValues.isRecord(operation) || operation.op !== "apply_token") {
                if (ApplyTokenValues.changesTokens(operation)) {
                    tokenWriteAt = index;
                }
                continue;
            }
            const name = operation.tokenName;
            if (typeof name !== "string") {
                continue;
            }
            const supplied = operation.resolvedValue !== undefined && operation.resolvedValue !== null;
            if (tokenWriteAt >= 0) {
                if (!supplied) {
                    throw new Error(
                        `${this.prefix}: operation ${index} (apply_token) cannot read the value of token "${name}", ` +
                            `because operation ${tokenWriteAt} changes tokens earlier in the same batch. ` +
                            "Apply the token in a later call, or pass resolvedValue."
                    );
                }
                continue;
            }
            const resolver = await catalogue.resolver();
            let resolved: unknown;
            try {
                resolved = resolver.resolve(name);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (!supplied) {
                    throw new Error(
                        `${this.prefix}: operation ${index} (apply_token) cannot resolve token "${name}": ${reason}.` +
                            this.hint
                    );
                }
                warnings.push({
                    kind: "token-value-unchecked",
                    operationIndex: index,
                    tokenName: name,
                    suppliedValue: operation.resolvedValue,
                    message: `The supplied value was kept and not checked: ${reason}.`,
                });
                continue;
            }
            if (!supplied) {
                operation.resolvedValue = resolved;
            } else if (ApplyTokenValues.canonical(operation.resolvedValue) !== ApplyTokenValues.canonical(resolved)) {
                warnings.push({
                    kind: "token-value-differs",
                    operationIndex: index,
                    tokenName: name,
                    suppliedValue: operation.resolvedValue,
                    resolvedValue: resolved,
                    message:
                        "The supplied resolvedValue is not the token's value in the active sets. The write keeps " +
                        "the supplied value, so the shape does not match its token until the token is applied again.",
                });
            }
        }
        return warnings;
    }

    /**
     * Writes a value as JSON text with the keys of every object in sorted order, so that two equal values give the
     * same text.
     *
     * @param value - the value to write
     * @returns the JSON text
     */
    private static canonical(value: unknown): string {
        return JSON.stringify(value, (_key, item: unknown) => {
            if (!ApplyTokenValues.isRecord(item)) {
                return item;
            }
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(item).sort()) {
                sorted[key] = item[key];
            }
            return sorted;
        });
    }

    /**
     * Tells whether a value is a plain JSON object.
     *
     * @param value - the value to check
     * @returns true for an object that is not an array or null
     */
    private static isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }
}
