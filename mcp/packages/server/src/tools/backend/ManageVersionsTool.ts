import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link ManageVersionsTool}. */
export class ManageVersionsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        action: z
            .enum(["list", "create", "restore", "pin", "unpin", "delete", "rename"])
            .describe(
                "What to do: list (all snapshots); create (label?); restore (snapshotId); pin or unpin (snapshotId; " +
                    "a pinned snapshot is kept); delete (snapshotId); rename (snapshotId, label)."
            ),
        snapshotId: BackendIds.uuid().optional().describe("Snapshot id, from the list action."),
        label: z
            .string()
            .max(250)
            .optional()
            .describe("Label of a snapshot: optional for create, required for rename."),
    };

    fileId!: string;

    action!: "list" | "create" | "restore" | "pin" | "unpin" | "delete" | "rename";

    snapshotId?: string;

    label?: string;
}

/** Lists, creates, restores, pins, renames and deletes version snapshots of a file. */
export class ManageVersionsTool extends BackendTool<ManageVersionsArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ManageVersionsArgs.schema, services);
    }

    public getToolName(): string {
        return "manage_versions";
    }

    public getToolDescription(): string {
        return (
            "Works with a file's version snapshots: list them, create a labelled snapshot, restore one, pin or unpin " +
            "it (pinned snapshots are kept), rename or delete it. Create one before a large change so it can be " +
            "restored. Restoring replaces the current content of the file."
        );
    }

    protected async executeBackend(args: ManageVersionsArgs, userToken: string): Promise<ToolResponse> {
        const result = await this.run(args, userToken);
        return this.jsonResponse(result ?? { status: "ok" });
    }

    /**
     * Runs the command of one action.
     *
     * @param args - the tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when the action needs a snapshot id or label that is missing
     */
    private run(args: ManageVersionsArgs, userToken: string): Promise<unknown> {
        const fileId = args.fileId;
        switch (args.action) {
            case "list":
                return this.callCommand(userToken, "get-file-snapshots", { fileId });
            case "create":
                return this.callWrite(userToken, fileId, "create-file-snapshot", {
                    fileId,
                    ...(args.label !== undefined ? { label: args.label } : {}),
                });
            case "restore":
                return this.callWrite(userToken, fileId, "restore-file-snapshot", {
                    fileId,
                    id: this.requireSnapshot(args),
                });
            case "pin":
                return this.callWrite(userToken, fileId, "lock-file-snapshot", { id: this.requireSnapshot(args) });
            case "unpin":
                return this.callWrite(userToken, fileId, "unlock-file-snapshot", { id: this.requireSnapshot(args) });
            case "delete":
                return this.callWrite(userToken, fileId, "delete-file-snapshot", { id: this.requireSnapshot(args) });
            case "rename":
                if (args.label === undefined) {
                    throw new Error('manage_versions action "rename" needs a label.');
                }
                return this.callWrite(userToken, fileId, "update-file-snapshot", {
                    id: this.requireSnapshot(args),
                    label: args.label,
                });
        }
    }

    /**
     * Returns the snapshot id, which the action needs.
     *
     * @param args - the tool arguments
     * @throws Error when no snapshot id is given
     */
    private requireSnapshot(args: ManageVersionsArgs): string {
        if (!args.snapshotId) {
            throw new Error(`manage_versions action "${args.action}" needs a snapshotId.`);
        }
        return args.snapshotId;
    }
}
