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
            .describe("Client-chosen UUID that names this write in snapshot labels and logs."),
    };

    /**
     * Copies the write options that are set into backend command parameters. Other arguments are ignored.
     *
     * @param args - the parsed tool arguments that may contain write options
     * @returns the set options, keyed as the backend expects them
     */
    public static toParams(args: WriteOptionArgs): Record<string, unknown> {
        const params: Record<string, unknown> = {};
        for (const key of WriteOptions.KEYS) {
            if (args[key] !== undefined) {
                params[key] = args[key];
            }
        }
        return params;
    }

    /** Names of the write options, in the form the tool arguments use. */
    private static readonly KEYS: readonly (keyof WriteOptionArgs)[] = [
        "dryRun",
        "snapshot",
        "baseRevn",
        "failOnConflict",
        "requestId",
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
