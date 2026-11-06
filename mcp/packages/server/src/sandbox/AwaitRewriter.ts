import { parse } from "acorn";

/**
 * Syntax node of the acorn tree, typed only by the fields that the rewriter reads.
 */
interface SyntaxNode {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly [field: string]: unknown;
}

/**
 * Removes the `await` keyword in front of the facade calls that run synchronously in the sandbox.
 *
 * The code is parsed with acorn, so comments, strings, template literals and regular expressions are never changed.
 * The keyword of a qualifying `await` is replaced by spaces, so line and column numbers of the rest of the code stay
 * the same. An `await` in front of anything else, and any async function, is refused with a hint.
 */
export class AwaitRewriter {
    /** Text of the keyword that a qualifying `await` loses. */
    private static readonly AWAIT_KEYWORD = "await";

    /** Hint for an `await` in front of a value that is not a facade call; the same text as the guest reports. */
    private static readonly AWAIT_HINT =
        "execute_code runs synchronously in backend mode: penpot calls return values directly; remove await";

    /** Hint for an async function, which the synchronous facade cannot serve. */
    private static readonly ASYNC_HINT =
        "execute_code runs synchronously in backend mode: async functions do not work; write a plain function and call the penpot facade directly";

    /** Names of the facade objects whose calls may follow a stripped `await`. */
    private static readonly FACADE_ROOTS = new Set(["penpot", "penpotUtils", "penpotMgmt"]);

    /** Names of the export methods whose calls may follow a stripped `await` on any object. */
    private static readonly EXPORT_METHODS = new Set(["export", "exportImage"]);

    /** Types of the nodes that define a function. */
    private static readonly FUNCTION_TYPES = new Set([
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
    ]);

    /**
     * Returns the script with the `await` keyword removed in front of each facade call.
     *
     * @param code - the script as the user wrote it
     * @returns the script to run; identical to the input when no `await` qualifies or the script does not parse
     * @throws Error when an `await` does not precede a facade call, or when a function is async
     */
    public static rewrite(code: string): string {
        let tree: unknown;
        try {
            tree = parse(code, {
                ecmaVersion: "latest",
                sourceType: "script",
                allowAwaitOutsideFunction: true,
                allowReturnOutsideFunction: true,
            });
        } catch {
            // a syntax error is left to the guest, which reports it with its own message.
            return code;
        }
        if (!AwaitRewriter.isNode(tree)) {
            return code;
        }

        const starts: number[] = [];
        AwaitRewriter.collect(tree, starts);
        if (starts.length === 0) {
            return code;
        }

        const blank = " ".repeat(AwaitRewriter.AWAIT_KEYWORD.length);
        let out = "";
        let cursor = 0;
        for (const start of starts.sort((a, b) => a - b)) {
            out += code.slice(cursor, start) + blank;
            cursor = start + AwaitRewriter.AWAIT_KEYWORD.length;
        }
        return out + code.slice(cursor);
    }

    /**
     * Walks a subtree in source order and records the start of each qualifying `await` keyword.
     *
     * @param node - the root of the subtree
     * @param starts - receives the start offset of each `await` keyword to remove
     * @throws Error when an `await` does not precede a facade call, or when a function is async
     */
    private static collect(node: SyntaxNode, starts: number[]): void {
        if (node.type === "AwaitExpression") {
            if (!AwaitRewriter.isFacadeCall(node.argument)) {
                throw new Error(AwaitRewriter.AWAIT_HINT);
            }
            starts.push(node.start);
        } else if (AwaitRewriter.FUNCTION_TYPES.has(node.type) && node.async === true) {
            throw new Error(AwaitRewriter.ASYNC_HINT);
        }
        for (const child of AwaitRewriter.children(node)) {
            AwaitRewriter.collect(child, starts);
        }
    }

    /**
     * Tells whether an expression is a call that the sandbox serves synchronously.
     *
     * A call qualifies when its callee is a member chain that starts at `penpot`, `penpotUtils` or `penpotMgmt`, or a
     * non-computed `export` or `exportImage` member on any object.
     *
     * @param value - the argument of an `await` expression
     * @returns true when the call may lose its `await`
     */
    private static isFacadeCall(value: unknown): boolean {
        if (!AwaitRewriter.isNode(value) || value.type !== "CallExpression") {
            return false;
        }
        const callee = value.callee;
        if (!AwaitRewriter.isNode(callee) || callee.type !== "MemberExpression") {
            return false;
        }

        const property = AwaitRewriter.identifierName(callee.property);
        if (callee.computed !== true && property !== undefined && AwaitRewriter.EXPORT_METHODS.has(property)) {
            return true;
        }

        let root: unknown = callee;
        while (AwaitRewriter.isNode(root) && root.type === "MemberExpression") {
            root = root.object;
        }
        const rootName = AwaitRewriter.identifierName(root);
        return rootName !== undefined && AwaitRewriter.FACADE_ROOTS.has(rootName);
    }

    /**
     * Returns the direct child nodes of a syntax node, in property order.
     *
     * @param node - the syntax node
     * @returns the child nodes, including those held in arrays
     */
    private static children(node: SyntaxNode): SyntaxNode[] {
        const found: SyntaxNode[] = [];
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (AwaitRewriter.isNode(item)) {
                        found.push(item);
                    }
                }
            } else if (AwaitRewriter.isNode(value)) {
                found.push(value);
            }
        }
        return found;
    }

    /**
     * Returns the name of an identifier node.
     *
     * @param value - the candidate node
     * @returns the identifier name, or undefined when the value is not an identifier
     */
    private static identifierName(value: unknown): string | undefined {
        if (AwaitRewriter.isNode(value) && value.type === "Identifier" && typeof value.name === "string") {
            return value.name;
        }
        return undefined;
    }

    /**
     * Tells whether a value is an acorn syntax node.
     *
     * @param value - the candidate value
     * @returns true when the value has a string type and numeric source offsets
     */
    private static isNode(value: unknown): value is SyntaxNode {
        return (
            typeof value === "object" &&
            value !== null &&
            typeof (value as { type?: unknown }).type === "string" &&
            typeof (value as { start?: unknown }).start === "number" &&
            typeof (value as { end?: unknown }).end === "number"
        );
    }
}
