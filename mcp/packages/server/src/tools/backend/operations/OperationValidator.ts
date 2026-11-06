import { OPERATION_NAMES, OPERATION_UNION } from "./OperationSchemas";

/**
 * Checks each operation of an `apply_operations` call against the operation vocabulary.
 *
 * Validation only: the operations are returned unchanged and the backend compiles them. An unknown op
 * name is reported with the full list of valid names, and a malformed operation with its index, op name
 * and the problem at each failing field.
 */
export class OperationValidator {
    /** Largest number of operations in one call. */
    public static readonly MAX_OPERATIONS = 2000;

    /**
     * Validates every operation.
     *
     * @param operations - the operations as sent by the client
     * @returns the same operations, unchanged
     * @throws Error naming the first invalid operation
     */
    public validate(operations: unknown[]): Record<string, unknown>[] {
        if (operations.length > OperationValidator.MAX_OPERATIONS) {
            throw new Error(
                `apply_operations accepts at most ${OperationValidator.MAX_OPERATIONS} operations per call ` +
                    `(got ${operations.length}). Split the work into several calls.`
            );
        }
        operations.forEach((operation, index) => this.validateOne(operation, index));
        return operations as Record<string, unknown>[];
    }

    /**
     * Validates one operation.
     *
     * @param operation - the operation as sent by the client
     * @param index - position of the operation in the call, for messages
     * @throws Error when the op is unknown or a parameter is missing or malformed
     */
    private validateOne(operation: unknown, index: number): void {
        const name = OperationValidator.opName(operation);
        if (name === undefined) {
            throw new Error(
                `Operation ${index} must be an object with an "op" field. Valid ops: ${OPERATION_NAMES.join(", ")}.`
            );
        }
        if (!OPERATION_NAMES.includes(name)) {
            throw new Error(`Operation ${index} has unknown op "${name}". Valid ops: ${OPERATION_NAMES.join(", ")}.`);
        }
        const result = OPERATION_UNION.safeParse(operation);
        if (!result.success) {
            const problems = result.error.issues
                .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(operation)"}: ${issue.message}`)
                .join("; ");
            throw new Error(
                `Operation ${index} (${name}) is invalid: ${problems}. Parameters are camelCase, for example pageId and parentId.`
            );
        }
    }

    /**
     * Returns the op name of an operation, or `undefined` when the value has none.
     *
     * @param operation - the operation as sent by the client
     */
    private static opName(operation: unknown): string | undefined {
        if (operation === null || typeof operation !== "object") {
            return undefined;
        }
        const name = (operation as { op?: unknown }).op;
        return typeof name === "string" ? name : undefined;
    }
}
