/** A token set of the `get-mcp-tokens` catalogue, with its effective active state. */
export interface CatalogueSet {
    /** Id of the set. */
    id: string;
    /** True when the set is active: its `active` flag is set, or its id is listed in `activeSets`. */
    active: boolean;
}

/** One token of the `get-mcp-tokens` catalogue, as far as value resolution needs it. */
export interface CatalogueToken {
    /** Id of the set that holds the token. */
    setId: string;
    /** Dotted token name, such as `spacing.base`. */
    name: string;
    /** Token type, such as `spacing` or `color`; empty when the catalogue gives none. */
    type: string;
    /** Raw value: a string, a number, or a structured value such as a shadow list. */
    value: unknown;
}

/**
 * Base font size in pixels for `rem` units. The `get-mcp-tokens` answer does not carry the file's base font size
 * option, so the file default of 16px is used for every file.
 */
const REM_BASE_FONT_SIZE = 16;

/**
 * Converts a number and its unit to a number: `px` and no unit give the number, `rem` multiplies it by the base font
 * size, and `%` gives the fraction, so that 50% is 0.5.
 *
 * @param amount - the digits of the number, with an optional minus sign
 * @param unit - the unit, or undefined when the number has none
 * @returns the number in its plain form
 */
function toQuantity(amount: string, unit: string | undefined): number {
    const value = Number(amount);
    if (unit === "rem") {
        return value * REM_BASE_FONT_SIZE;
    }
    if (unit === "%") {
        return value / 100;
    }
    return value;
}

/** One lexeme of a token expression: a number, a whole token reference, or an operator or parenthesis. */
type Lexeme =
    { kind: "number"; value: number } | { kind: "reference"; name: string } | { kind: "symbol"; symbol: string };

/**
 * Evaluates an arithmetic token expression, such as `({spacing.base} + 4px) / 2`.
 *
 * The expression is read by a small recursive-descent parser, so no code is evaluated. The operators are `+`, `-`,
 * `*` and `/`, with parentheses. An operand is a number with an optional `px`, `rem` or `%` unit, or a whole token
 * reference, which is resolved through a callback.
 */
class TokenExpression {
    /** Expression text as the token has it, used in error messages. */
    private readonly source: string;

    /** Lexemes of the expression, read once when the expression is created. */
    private readonly lexemes: Lexeme[];

    /** Resolves a token name to its value, which must be a number to be used in arithmetic. */
    private readonly resolveReference: (name: string) => unknown;

    /** Index of the next lexeme to read. */
    private index = 0;

    /**
     * Reads the lexemes of an expression.
     *
     * @param source - the expression text, trimmed
     * @param resolveReference - resolves the name of a token reference to its value
     * @throws Error when the text holds a character that is not part of the expression grammar
     */
    constructor(source: string, resolveReference: (name: string) => unknown) {
        this.source = source;
        this.resolveReference = resolveReference;
        this.lexemes = TokenExpression.tokenize(source);
    }

    /**
     * Evaluates the expression.
     *
     * @returns the value of the expression
     * @throws Error when the expression is not well formed, uses an unsupported form, or divides by zero
     */
    public evaluate(): number {
        const value = this.sum();
        if (this.index < this.lexemes.length) {
            throw this.unsupported();
        }
        return value;
    }

    /**
     * Reads the lexemes of the text, from left to right.
     *
     * @param source - the expression text
     * @returns the lexemes in order
     * @throws Error when a character does not start a lexeme
     */
    private static tokenize(source: string): Lexeme[] {
        const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)(px|rem|%)?|\{([^{}]+)\}|([-+*/()]))/y;
        const lexemes: Lexeme[] = [];
        let end = 0;
        while (end < source.length) {
            pattern.lastIndex = end;
            const match = pattern.exec(source);
            if (match === null) {
                if (source.slice(end).trim() === "") {
                    break;
                }
                throw new Error(`unsupported token expression "${source}"`);
            }
            end = pattern.lastIndex;
            if (match[1] !== undefined) {
                lexemes.push({ kind: "number", value: toQuantity(match[1], match[2]) });
            } else if (match[3] !== undefined) {
                lexemes.push({ kind: "reference", name: match[3] });
            } else {
                lexemes.push({ kind: "symbol", symbol: match[4] });
            }
        }
        return lexemes;
    }

    /**
     * Reads a sum: products joined by `+` or `-`.
     *
     * @returns the value of the sum
     */
    private sum(): number {
        let value = this.product();
        let symbol = this.peekSymbol("+", "-");
        while (symbol !== undefined) {
            this.index++;
            const right = this.product();
            value = symbol === "+" ? value + right : value - right;
            symbol = this.peekSymbol("+", "-");
        }
        return value;
    }

    /**
     * Reads a product: unary operands joined by `*` or `/`.
     *
     * @returns the value of the product
     * @throws Error when a division has a zero divisor
     */
    private product(): number {
        let value = this.unary();
        let symbol = this.peekSymbol("*", "/");
        while (symbol !== undefined) {
            this.index++;
            const right = this.unary();
            if (symbol === "*") {
                value *= right;
            } else {
                if (right === 0) {
                    throw new Error(`token expression "${this.source}" divides by zero`);
                }
                value /= right;
            }
            symbol = this.peekSymbol("*", "/");
        }
        return value;
    }

    /**
     * Reads an operand with an optional leading sign.
     *
     * @returns the value of the operand
     */
    private unary(): number {
        const symbol = this.peekSymbol("+", "-");
        if (symbol === undefined) {
            return this.primary();
        }
        this.index++;
        const value = this.unary();
        return symbol === "-" ? -value : value;
    }

    /**
     * Reads a number, a token reference, or a parenthesised sum.
     *
     * @returns the value of the operand
     * @throws Error when the operand is missing, or a reference does not resolve to a number
     */
    private primary(): number {
        const lexeme = this.lexemes[this.index];
        if (lexeme === undefined) {
            throw this.unsupported();
        }
        if (lexeme.kind === "number") {
            this.index++;
            return lexeme.value;
        }
        if (lexeme.kind === "reference") {
            this.index++;
            const value = this.resolveReference(lexeme.name);
            if (typeof value !== "number") {
                throw this.unsupported();
            }
            return value;
        }
        if (lexeme.symbol !== "(") {
            throw this.unsupported();
        }
        this.index++;
        const value = this.sum();
        if (this.peekSymbol(")") === undefined) {
            throw this.unsupported();
        }
        this.index++;
        return value;
    }

    /**
     * Returns the operator or parenthesis at the next position when it is one of the given symbols.
     *
     * @param symbols - the symbols to look for
     * @returns the symbol found, or undefined when the next lexeme is not one of them
     */
    private peekSymbol(...symbols: string[]): string | undefined {
        const lexeme = this.lexemes[this.index];
        if (lexeme !== undefined && lexeme.kind === "symbol" && symbols.includes(lexeme.symbol)) {
            return lexeme.symbol;
        }
        return undefined;
    }

    /**
     * Builds the error for an expression this resolver does not support.
     *
     * @returns the error, which names the expression text
     */
    private unsupported(): Error {
        return new Error(`unsupported token expression "${this.source}"`);
    }
}

/**
 * Resolves the value of a named token from the token catalogue of a file.
 *
 * A token is looked up in the active sets only. A set is active when its `active` flag is set or its id is listed in
 * `activeSets`. Active sets are read in the order the catalogue lists them, and the last active set that holds a name
 * wins. A value that is a whole reference, such as `{spacing.base}`, is followed through the catalogue for at most
 * {@link TokenResolver.MAX_HOPS} references, and a reference cycle is an error. A reference may also appear inside an
 * arithmetic expression, such as `({spacing.base} + 4px) / 2`, which follows the same rules.
 *
 * A number, or a string with a number and an optional unit (`px`, `rem` or `%`), becomes a number. `rem` uses
 * {@link TokenResolver.BASE_FONT_SIZE}. Any other string, such as a colour, is returned unchanged, and so is any
 * structured value.
 */
export class TokenResolver {
    /** Most references one token value may follow before resolution fails. */
    public static readonly MAX_HOPS = 20;

    /**
     * Base font size in pixels that `rem` units multiply. This is the file default of 16px, because the catalogue
     * does not carry the file's own base font size option.
     */
    public static readonly BASE_FONT_SIZE = REM_BASE_FONT_SIZE;

    /** Pattern of a value that is a whole token reference. */
    private static readonly REFERENCE = /^\{([^{}]+)\}$/;

    /** Pattern of a plain number with an optional unit: px, rem or %. */
    private static readonly LITERAL = /^(-?\d+(?:\.\d+)?)(px|rem|%)?$/;

    /** Pattern of a colour function, which is a plain string even though it has parentheses. */
    private static readonly COLOUR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

    /** Pattern of a call of a named function, such as `sum(1,2)`. */
    private static readonly FUNCTION_CALL = /^[A-Za-z_][\w-]*\(/;

    /** Tokens of the active sets by name; a later active set replaces an earlier one. */
    private readonly activeTokens = new Map<string, CatalogueToken>();

    /** Tokens of all sets by name; the first set in catalogue order that holds a name wins. */
    private readonly knownTokens = new Map<string, CatalogueToken>();

    /**
     * Creates a resolver over the sets and tokens of one file. Within one set, the first token of a name wins.
     *
     * @param sets - the sets of the file, in catalogue order
     * @param tokens - the tokens of the file; a token whose set is not in `sets` is ignored
     */
    constructor(sets: CatalogueSet[], tokens: CatalogueToken[]) {
        const tokensBySet = new Map<string, Map<string, CatalogueToken>>();
        for (const token of tokens) {
            let names = tokensBySet.get(token.setId);
            if (names === undefined) {
                names = new Map<string, CatalogueToken>();
                tokensBySet.set(token.setId, names);
            }
            if (!names.has(token.name)) {
                names.set(token.name, token);
            }
        }
        for (const set of sets) {
            const names = tokensBySet.get(set.id);
            if (names === undefined) {
                continue;
            }
            for (const [name, token] of names) {
                if (!this.knownTokens.has(name)) {
                    this.knownTokens.set(name, token);
                }
                if (set.active) {
                    this.activeTokens.set(name, token);
                }
            }
        }
    }

    /**
     * Builds a resolver from the answer of the `get-mcp-tokens` command.
     *
     * @param catalogue - the answer, with the `sets`, `tokens` and `activeSets` lists
     * @returns the resolver; an answer without a token list yields a resolver that knows no token
     */
    public static fromCatalogue(catalogue: unknown): TokenResolver {
        const answer = TokenResolver.recordOf(catalogue);
        const activeIds = new Set<string>();
        for (const id of TokenResolver.listOf(answer?.activeSets)) {
            if (typeof id === "string") {
                activeIds.add(id);
            }
        }
        const sets: CatalogueSet[] = [];
        for (const entry of TokenResolver.listOf(answer?.sets)) {
            const record = TokenResolver.recordOf(entry);
            if (record !== undefined && typeof record.id === "string") {
                sets.push({ id: record.id, active: record.active === true || activeIds.has(record.id) });
            }
        }
        const tokens: CatalogueToken[] = [];
        for (const entry of TokenResolver.listOf(answer?.tokens)) {
            const record = TokenResolver.recordOf(entry);
            if (record !== undefined && typeof record.setId === "string" && typeof record.name === "string") {
                tokens.push({
                    setId: record.setId,
                    name: record.name,
                    type: typeof record.type === "string" ? record.type : "",
                    value: record.value,
                });
            }
        }
        return new TokenResolver(sets, tokens);
    }

    /**
     * Resolves the value of a token by name.
     *
     * @param name - dotted name of the token
     * @returns a number for a number, a literal or an expression; the string itself for any other string; and the
     *   value itself for a structured value
     * @throws Error when the token is missing from the active sets, a reference is missing, a reference cycle
     *   exists, the chain is longer than {@link TokenResolver.MAX_HOPS}, or an expression is not supported
     */
    public resolve(name: string): unknown {
        return this.resolveName(name, name, []);
    }

    /**
     * Returns the type of a token by name. A token of an active set wins; otherwise the first set in catalogue order
     * that holds the name gives the type.
     *
     * @param name - dotted name of the token
     * @returns the type of the token, such as `spacing`
     * @throws Error when no set holds the name
     */
    public typeOf(name: string): string {
        const token = this.activeTokens.get(name) ?? this.knownTokens.get(name);
        if (token === undefined) {
            throw new Error(`token "${name}" was not found in the file`);
        }
        return token.type;
    }

    /**
     * Resolves the value of a token that a chain of references reached.
     *
     * @param name - name of the token to resolve
     * @param root - name of the token the whole chain started from, used in error messages
     * @param chain - names of the tokens the chain passed before this one
     * @returns the resolved value
     * @throws Error when the token is missing from the active sets or the chain loops
     */
    private resolveName(name: string, root: string, chain: string[]): unknown {
        if (chain.includes(name)) {
            throw new Error(`token "${root}" has a reference cycle at "${name}"`);
        }
        const token = this.lookupActive(name);
        const next = [...chain, name];
        const value = token.value;
        if (typeof value !== "string") {
            return value;
        }
        return this.resolveText(value, root, next);
    }

    /**
     * Resolves the text of a token value: a whole reference, a literal, an expression, or a plain string.
     *
     * @param text - the raw string value of the token
     * @param root - name of the token the whole chain started from
     * @param chain - names of the tokens the chain passed, including the token that has this text
     * @returns the resolved value
     * @throws Error when a reference or an expression fails
     */
    private resolveText(text: string, root: string, chain: string[]): unknown {
        const trimmed = text.trim();
        const reference = TokenResolver.REFERENCE.exec(trimmed);
        if (reference !== null) {
            return this.resolveReference(reference[1], root, chain);
        }
        const literal = TokenResolver.LITERAL.exec(trimmed);
        if (literal !== null) {
            return toQuantity(literal[1], literal[2]);
        }
        if (TokenResolver.isExpression(trimmed)) {
            const expression = new TokenExpression(trimmed, (target) => this.resolveReference(target, root, chain));
            return expression.evaluate();
        }
        return text;
    }

    /**
     * Resolves a reference that a value makes to another token, and checks the hop limit.
     *
     * @param target - name of the referenced token
     * @param root - name of the token the whole chain started from
     * @param chain - names of the tokens the chain passed, including the token that makes the reference
     * @returns the resolved value of the referenced token
     * @throws Error when the chain already has {@link TokenResolver.MAX_HOPS} references
     */
    private resolveReference(target: string, root: string, chain: string[]): unknown {
        if (chain.length > TokenResolver.MAX_HOPS) {
            throw new Error(`token "${root}" follows more than ${TokenResolver.MAX_HOPS} references`);
        }
        return this.resolveName(target, root, chain);
    }

    /**
     * Finds a token of the active sets by name.
     *
     * @param name - dotted name of the token
     * @returns the token
     * @throws Error when the token is in an inactive set only, or in no set
     */
    private lookupActive(name: string): CatalogueToken {
        const token = this.activeTokens.get(name);
        if (token !== undefined) {
            return token;
        }
        if (this.knownTokens.has(name)) {
            throw new Error(`token "${name}" is not in an active set`);
        }
        throw new Error(`token "${name}" was not found in the file`);
    }

    /**
     * Tells whether a value is an arithmetic expression rather than a plain string. A value is an expression when it
     * holds a token reference, calls a named function other than a colour function, or starts with a number or a
     * parenthesis and has an operator. Any other string, such as `#ff8800` or `700 Italic`, is a plain string.
     *
     * @param text - the trimmed value
     * @returns true when the value should be read as an expression
     */
    private static isExpression(text: string): boolean {
        if (text.includes("{")) {
            return true;
        }
        if (TokenResolver.COLOUR_FUNCTION.test(text)) {
            return false;
        }
        if (TokenResolver.FUNCTION_CALL.test(text)) {
            return true;
        }
        const body = text.startsWith("-") ? text.slice(1) : text;
        return /^[\d.(]/.test(body) && /[-+*/()]/.test(body);
    }

    /**
     * Views a value as a record when it is a plain object.
     *
     * @param value - the value to view
     * @returns the value as a record, or undefined when it is not an object or is an array
     */
    private static recordOf(value: unknown): Record<string, unknown> | undefined {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return undefined;
    }

    /**
     * Views a value as a list.
     *
     * @param value - the value to view
     * @returns the items when the value is an array, or no items otherwise
     */
    private static listOf(value: unknown): unknown[] {
        return Array.isArray(value) ? value : [];
    }
}
