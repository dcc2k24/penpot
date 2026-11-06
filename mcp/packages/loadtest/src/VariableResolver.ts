/** Names visible inside one tool call: loop variables and the built-in agent, index, iteration and runId. */
export type Scope = Readonly<Record<string, unknown>>;

/** Prefix of environment variables that supply scenario variables, for example PENPOT_LOADTEST_FILE_ID. */
const ENV_PREFIX = "PENPOT_LOADTEST_";

/** Matches ${name} and ${name[index]}, where the index is a scope name or an integer literal. */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z_][A-Za-z0-9_]*|\d+)\])?\}/g;

/** Upper bound on a single $repeat count, to keep a typo from creating millions of calls. */
const MAX_REPEAT = 100_000;

/**
 * Replaces `${name}` placeholders and expands `$repeat` directives in scenario arguments.
 *
 * A name is looked up in this order: the call scope, the values captured by earlier steps of the same agent, the
 * `--vars` file, and the `PENPOT_LOADTEST_*` environment. Captures come first, so a value that a step captured
 * overrides the same name from the vars file or the environment. A placeholder that is the whole string keeps the
 * type of its value, so `"${pageIds}"` yields an array. An index outside the array is an error, never a wrap. A `$repeat` object `{"$repeat": n, "as": "i", "value": t}` expands
 * to n copies of `t`, with `${i}` bound to the copy number; an array template inside a list is spliced in place.
 */
export class VariableResolver {
    /**
     * @param vars - values from the vars file or the command line
     * @param env - environment in which PENPOT_LOADTEST_* variables are read
     * @param captures - values captured by earlier steps of this agent, updated in place by the runner; they are
     *   looked up before vars and env
     */
    constructor(
        private readonly vars: Readonly<Record<string, unknown>>,
        private readonly env: Readonly<Record<string, string | undefined>>,
        private readonly captures: Record<string, unknown>
    ) {}

    /**
     * Substitutes placeholders and expands directives anywhere in a value.
     *
     * @param value - JSON-like value from a scenario
     * @param scope - names visible at this point, including built-ins
     * @returns a new value with every placeholder replaced
     * @throws Error when a placeholder names an unknown variable or an index cannot be applied
     */
    expand(value: unknown, scope: Scope): unknown {
        if (typeof value === "string") {
            return this.substituteText(value, scope);
        }
        if (Array.isArray(value)) {
            return this.expandList(value, scope);
        }
        if (VariableResolver.isRepeat(value)) {
            return this.expandRepeat(value, scope);
        }
        if (value !== null && typeof value === "object") {
            const expanded: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(value)) {
                expanded[key] = this.expand(child, scope);
            }
            return expanded;
        }
        return value;
    }

    /**
     * Returns the value of a name, following the lookup order of the class.
     *
     * @param name - variable name without the dollar and braces
     * @param scope - names visible at this point
     * @throws Error when no source defines the name
     */
    lookup(name: string, scope: Scope): unknown {
        if (VariableResolver.hasOwn(scope, name)) {
            return scope[name];
        }
        if (VariableResolver.hasOwn(this.captures, name)) {
            return this.captures[name];
        }
        if (VariableResolver.hasOwn(this.vars, name)) {
            return this.vars[name];
        }
        const envValue = this.env[VariableResolver.envNameFor(name)];
        if (envValue !== undefined) {
            return envValue;
        }
        throw new Error(
            `unknown variable \${${name}}: pass it in --vars, set ${VariableResolver.envNameFor(name)}, ` +
                "or capture it in an earlier step"
        );
    }

    /**
     * Names the environment variable that supplies a scenario variable, for example fileId gives
     * PENPOT_LOADTEST_FILE_ID.
     *
     * @param name - camelCase variable name
     */
    static envNameFor(name: string): string {
        return ENV_PREFIX + name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
    }

    /**
     * Expands one string: a whole-string placeholder keeps the type of its value, a longer string is interpolated.
     *
     * @param text - string from a scenario
     * @param scope - names visible at this point
     */
    private substituteText(text: string, scope: Scope): unknown {
        const matches = [...text.matchAll(PLACEHOLDER)];
        if (matches.length === 1 && matches[0][0] === text) {
            return this.resolveMatch(matches[0], scope);
        }
        return text.replace(PLACEHOLDER, (...match: string[]) => {
            return VariableResolver.stringify(this.resolveMatch(match as unknown as RegExpMatchArray, scope));
        });
    }

    /**
     * Resolves one placeholder match, applying the optional index to an array value.
     *
     * @param match - regular expression match with the name at group 1 and the index at group 2
     * @param scope - names visible at this point
     */
    private resolveMatch(match: RegExpMatchArray | string[], scope: Scope): unknown {
        const name = match[1];
        const indexExpression = match[2];
        const value = this.lookup(name, scope);
        if (indexExpression === undefined) {
            return value;
        }
        if (!Array.isArray(value)) {
            throw new Error(`variable \${${name}} is not an array, so it cannot be indexed`);
        }
        if (value.length === 0) {
            throw new Error(`variable \${${name}} is an empty array`);
        }
        const position = /^\d+$/.test(indexExpression)
            ? Number(indexExpression)
            : this.indexValue(indexExpression, scope);
        if (position < 0 || position >= value.length) {
            throw new Error(
                `index ${position} is out of range for \${${name}} (length ${value.length}); ` +
                    "indexes do not wrap, so the scenario must supply enough values"
            );
        }
        return value[position];
    }

    /**
     * Reads the numeric value of an index name.
     *
     * @param name - scope name, such as agent or index
     * @param scope - names visible at this point
     */
    private indexValue(name: string, scope: Scope): number {
        const value = this.lookup(name, scope);
        if (typeof value !== "number" || !Number.isInteger(value)) {
            throw new Error(`index \${${name}} must be an integer`);
        }
        return value;
    }

    /**
     * Expands a list, splicing in the results of $repeat directives.
     *
     * @param items - list from a scenario
     * @param scope - names visible at this point
     */
    private expandList(items: readonly unknown[], scope: Scope): unknown[] {
        const expanded: unknown[] = [];
        for (const item of items) {
            if (VariableResolver.isRepeat(item)) {
                expanded.push(...this.expandRepeat(item, scope));
            } else {
                expanded.push(this.expand(item, scope));
            }
        }
        return expanded;
    }

    /**
     * Expands a $repeat directive into a list of copies.
     *
     * @param directive - object with $repeat (count), optional as (loop name, default i) and value (template)
     * @param scope - names visible at this point
     * @throws Error when the count is not a whole number between 0 and 100000
     */
    private expandRepeat(directive: Record<string, unknown>, scope: Scope): unknown[] {
        const count = VariableResolver.countOf(this.expand(directive.$repeat, scope));
        const loopName = typeof directive.as === "string" ? directive.as : "i";
        if (!("value" in directive)) {
            throw new Error("$repeat directive needs a value");
        }
        const copies: unknown[] = [];
        for (let copy = 0; copy < count; copy++) {
            const childScope = { ...scope, [loopName]: copy };
            const template = directive.value;
            if (Array.isArray(template)) {
                copies.push(...this.expandList(template, childScope));
            } else if (VariableResolver.isRepeat(template)) {
                copies.push(...this.expandRepeat(template, childScope));
            } else {
                copies.push(this.expand(template, childScope));
            }
        }
        return copies;
    }

    /**
     * Turns a resolved $repeat count into a number.
     *
     * @param value - number, or a string that holds an integer
     * @throws Error when the value is not a whole number from 0 to 100000
     */
    static countOf(value: unknown): number {
        const count = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_REPEAT) {
            throw new Error(
                `$repeat count must be a whole number from 0 to ${MAX_REPEAT}, got ${JSON.stringify(value)}`
            );
        }
        return count;
    }

    /**
     * Tells whether a value is a $repeat directive.
     *
     * @param value - any JSON-like value
     */
    static isRepeat(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value) && "$repeat" in value;
    }

    /**
     * Converts a substituted value to text for interpolation.
     *
     * @param value - resolved value
     */
    static stringify(value: unknown): string {
        if (typeof value === "string") {
            return value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        return JSON.stringify(value);
    }

    /**
     * Tells whether an object has its own property with the given name.
     *
     * @param target - object to test
     * @param name - property name
     */
    private static hasOwn(target: object, name: string): boolean {
        return Object.prototype.hasOwnProperty.call(target, name);
    }
}
