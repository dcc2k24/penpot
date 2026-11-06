import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { WriteOptions } from "./WriteOptions";

/** Arguments of {@link ApplyRawChangesTool}. */
export class ApplyRawChangesArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file to change, from list_files."),
        changes: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .max(2000)
            .describe(
                "Raw Penpot change records, each an object with a type such as add-obj, mod-obj or del-obj and " +
                    "its payload in camelCase. Prefer apply_operations; use this only for changes it cannot express. " +
                    "Set-tokens-lib, purge and page-wide library changes are refused."
            ),
        ...WriteOptions.schema,
    };

    fileId!: string;

    changes!: Record<string, unknown>[];

    dryRun?: boolean;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    requestId?: string;
}

/** Applies raw Penpot change records to a file. */
export class ApplyRawChangesTool extends BackendTool<ApplyRawChangesArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ApplyRawChangesArgs.schema, services);
    }

    public getToolName(): string {
        return "apply_raw_changes";
    }

    public getToolDescription(): string {
        return (
            "Applies raw Penpot change records to a file in one atomic write. This is the escape hatch for changes " +
            "that apply_operations does not cover. Prefer apply_operations, which validates its input. " +
            "Use dryRun true to validate first, and baseRevn from get_file_outline to detect concurrent edits."
        );
    }

    protected async executeBackend(args: ApplyRawChangesArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            changes: args.changes,
            ...WriteOptions.toParams(args),
        };
        return this.jsonResponse(await this.callWrite(userToken, args.fileId, "mcp-apply-changes", params));
    }
}
