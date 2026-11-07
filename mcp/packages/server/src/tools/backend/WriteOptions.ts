import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BackendIds } from "./BackendIds";

/** Options shared by every backend write tool. */
export class WriteOptions {
    static schema = {
        dryRun: z
            .boolean()
            .optional()
            .describe(
                "When true, apply the changes in memory, validate them and return the result without saving. " +
                    "Needs only the mcp:read scope. Use it to check operations before writing."
            ),
        snapshot: z
            .boolean()
            .optional()
            .describe(
                "When true, take a version snapshot before saving, even for small writes. " +
                    "Deletions always take one; the server keeps the 20 newest adapter snapshots."
            ),
        baseRevn: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                "Revision you read the file at (from get_file_outline). Changes made since then are reported as " +
                    "warnings with the affected shape ids."
            ),
        failOnConflict: z
            .boolean()
            .optional()
            .describe(
                "When true together with baseRevn, refuse the write if someone changed a shape you touch since " +
                    "that revision. Nothing is saved on refusal."
            ),
        requestId: BackendIds.uuid()
            .optional()
            .describe(
                "Client-chosen UUID that names this write. A retry of the same write must reuse this requestId: " +
                    "the server then answers alreadyApplied true for a repeat within an hour instead of applying " +
                    "the write twice. Without one, the server makes a new id for this call, so a retried call " +
                    "is not recognised."
            ),
    };

    /** Note added to a write result that an earlier call with the same requestId already applied. */
    private static readonly ALREADY_APPLIED_NOTE =
        "This write was already applied by an earlier call with the same requestId. This call changed nothing.";

    /**
     * Copies the write options that are set into backend command parameters, and always names the write.
     *
     * A write without a requestId gets a new UUID, so that the backend can tell a repeat of the same call.
     *
     * @param args - the parsed tool arguments that may contain write options
     * @returns the set options, keyed as the backend expects them, with a requestId
     */
    public static toParams(args: WriteOptionArgs): Record<string, unknown> {
        const params: Record<string, unknown> = {};
        for (const key of WriteOptions.KEYS) {
            if (args[key] !== undefined) {
                params[key] = args[key];
            }
        }
        params.requestId = WriteOptions.requestIdOf(args);
        return params;
    }

    /**
     * Returns the requestId of a write: the one the caller named, or a new UUID for this call.
     *
     * @param args - the tool arguments that may name a requestId
     * @returns the requestId to send to the backend
     */
    public static requestIdOf(args: { requestId?: string }): string {
        return args.requestId ?? randomUUID();
    }

    /**
     * Adds a note to a write result that the backend marked as already applied.
     *
     * The backend result already carries `alreadyApplied`; the note tells the agent that nothing changed in this
     * call. Other results are returned as they are.
     *
     * @param result - the backend result of the write
     * @returns the result, with `alreadyApplied` and a note when the backend said the write was already applied
     */
    public static withAlreadyApplied(result: unknown): unknown {
        if (result === null || typeof result !== "object" || Array.isArray(result)) {
            return result;
        }
        const record = result as Record<string, unknown>;
        if (record.alreadyApplied !== true) {
            return result;
        }
        return { ...record, alreadyApplied: true, note: WriteOptions.ALREADY_APPLIED_NOTE };
    }

    /** Names of the write options that are copied as they are. The requestId is set by {@link toParams}. */
    private static readonly KEYS: readonly (keyof WriteOptionArgs)[] = [
        "dryRun",
        "snapshot",
        "baseRevn",
        "failOnConflict",
    ];
}

/** The write option fields of a tool argument object. */
export interface WriteOptionArgs {
    dryRun?: boolean;
    snapshot?: boolean;
    baseRevn?: number;
    failOnConflict?: boolean;
    requestId?: string;
}
