import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** The actions of {@link ManageFilesTool}. */
export type ManageFilesAction =
    | "create_team"
    | "rename_team"
    | "create_project"
    | "rename_project"
    | "pin_project"
    | "delete_project"
    | "create_file"
    | "rename_file"
    | "duplicate_file"
    | "duplicate_project"
    | "move_files"
    | "move_project"
    | "delete_file"
    | "restore_files"
    | "set_shared"
    | "link_library"
    | "unlink_library";

/** Arguments of {@link ManageFilesTool}. Each action names the fields it needs. */
export class ManageFilesArgs {
    static schema = {
        action: z
            .enum([
                "create_team",
                "rename_team",
                "create_project",
                "rename_project",
                "pin_project",
                "delete_project",
                "create_file",
                "rename_file",
                "duplicate_file",
                "duplicate_project",
                "move_files",
                "move_project",
                "delete_file",
                "restore_files",
                "set_shared",
                "link_library",
                "unlink_library",
            ])
            .describe(
                "What to do: create_team (name); rename_team (teamId, name); create_project (teamId, name); " +
                    "rename_project (projectId, name); pin_project (projectId, teamId, isPinned); " +
                    "delete_project (projectId); create_file (projectId, name, isShared?); rename_file (fileId, name); " +
                    "duplicate_file (fileId, name?); duplicate_project (projectId, name?); move_files (fileIds, projectId); " +
                    "move_project (projectId, teamId); delete_file (fileId); restore_files (teamId, fileIds); " +
                    "set_shared (fileId, isShared); link_library (fileId, libraryId); unlink_library (fileId, libraryId)."
            ),
        teamId: BackendIds.uuid().optional().describe("Team id, from list_teams."),
        projectId: BackendIds.uuid().optional().describe("Project id, from list_projects."),
        fileId: BackendIds.uuid().optional().describe("File id, from list_files."),
        fileIds: z.array(BackendIds.uuid()).min(1).optional().describe("File ids, from list_files."),
        libraryId: BackendIds.uuid().optional().describe("Id of the library file to link or unlink."),
        name: z.string().min(1).max(250).optional().describe("Name for the team, project or file."),
        isPinned: z.boolean().optional().describe("Pin state of a project (pin_project)."),
        isShared: z.boolean().optional().describe("Whether a file is shared as a library (create_file, set_shared)."),
    };

    action!: ManageFilesAction;

    teamId?: string;

    projectId?: string;

    fileId?: string;

    fileIds?: string[];

    libraryId?: string;

    name?: string;

    isPinned?: boolean;

    isShared?: boolean;
}

/** How one action maps to a backend command. */
interface ActionSpec {
    /** Backend command name. */
    command: string;
    /** Argument fields the action needs. */
    requires: (keyof ManageFilesArgs)[];
    /** Whether the action changes one file, so that it runs through the write queue of that file. */
    fileScoped: boolean;
    /** Builds the command parameters from the arguments. */
    params: (args: ManageFilesArgs) => Record<string, unknown>;
}

/** Creates, renames, moves, deletes and shares teams, projects and files. */
export class ManageFilesTool extends BackendTool<ManageFilesArgs> {
    /** Backend mapping of every action. */
    private static readonly ACTIONS: Record<ManageFilesAction, ActionSpec> = {
        create_team: {
            command: "create-team",
            requires: ["name"],
            fileScoped: false,
            params: (args) => ({ name: args.name }),
        },
        rename_team: {
            command: "update-team",
            requires: ["teamId", "name"],
            fileScoped: false,
            params: (args) => ({ id: args.teamId, name: args.name }),
        },
        create_project: {
            command: "create-project",
            requires: ["teamId", "name"],
            fileScoped: false,
            params: (args) => ({ teamId: args.teamId, name: args.name }),
        },
        rename_project: {
            command: "rename-project",
            requires: ["projectId", "name"],
            fileScoped: false,
            params: (args) => ({ id: args.projectId, name: args.name }),
        },
        pin_project: {
            command: "update-project-pin",
            requires: ["projectId", "teamId", "isPinned"],
            fileScoped: false,
            params: (args) => ({ id: args.projectId, teamId: args.teamId, isPinned: args.isPinned }),
        },
        delete_project: {
            command: "delete-project",
            requires: ["projectId"],
            fileScoped: false,
            params: (args) => ({ id: args.projectId }),
        },
        create_file: {
            command: "create-file",
            requires: ["projectId", "name"],
            fileScoped: false,
            params: (args) => ({
                projectId: args.projectId,
                name: args.name,
                ...(args.isShared !== undefined ? { isShared: args.isShared } : {}),
            }),
        },
        rename_file: {
            command: "rename-file",
            requires: ["fileId", "name"],
            fileScoped: true,
            params: (args) => ({ id: args.fileId, name: args.name }),
        },
        duplicate_file: {
            command: "duplicate-file",
            requires: ["fileId"],
            fileScoped: true,
            params: (args) => ({ fileId: args.fileId, ...(args.name !== undefined ? { name: args.name } : {}) }),
        },
        duplicate_project: {
            command: "duplicate-project",
            requires: ["projectId"],
            fileScoped: false,
            params: (args) => ({ projectId: args.projectId, ...(args.name !== undefined ? { name: args.name } : {}) }),
        },
        move_files: {
            command: "move-files",
            requires: ["fileIds", "projectId"],
            fileScoped: false,
            params: (args) => ({ ids: args.fileIds, projectId: args.projectId }),
        },
        move_project: {
            command: "move-project",
            requires: ["projectId", "teamId"],
            fileScoped: false,
            params: (args) => ({ projectId: args.projectId, teamId: args.teamId }),
        },
        delete_file: {
            command: "delete-file",
            requires: ["fileId"],
            fileScoped: true,
            params: (args) => ({ id: args.fileId }),
        },
        restore_files: {
            command: "restore-deleted-team-files",
            requires: ["teamId", "fileIds"],
            fileScoped: false,
            params: (args) => ({ teamId: args.teamId, ids: args.fileIds }),
        },
        set_shared: {
            command: "set-file-shared",
            requires: ["fileId", "isShared"],
            fileScoped: true,
            params: (args) => ({ id: args.fileId, isShared: args.isShared }),
        },
        link_library: {
            command: "link-file-to-library",
            requires: ["fileId", "libraryId"],
            fileScoped: true,
            params: (args) => ({ fileId: args.fileId, libraryId: args.libraryId }),
        },
        unlink_library: {
            command: "unlink-file-from-library",
            requires: ["fileId", "libraryId"],
            fileScoped: true,
            params: (args) => ({ fileId: args.fileId, libraryId: args.libraryId }),
        },
    };

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ManageFilesArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: false, destructiveHint: true };
    }

    public getToolName(): string {
        return "manage_files";
    }

    public getToolDescription(): string {
        return (
            "Manages teams, projects and files: create, rename, pin, move, duplicate, delete, restore, share, and " +
            "link or unlink libraries. Pick one action and pass the ids it names. " +
            "delete_project and delete_file remove data: confirm with the user first. " +
            "Next: get_file_outline for a file you created or duplicated."
        );
    }

    protected async executeBackend(args: ManageFilesArgs, userToken: string): Promise<ToolResponse> {
        const spec = ManageFilesTool.ACTIONS[args.action];
        const missing = spec.requires.filter((field) => args[field] === undefined);
        if (missing.length > 0) {
            throw new Error(`manage_files action "${args.action}" needs ${missing.join(", ")}.`);
        }
        const params = spec.params(args);
        // every action without a file id changes teams or projects and is not queued, so once sent it must finish
        const result = spec.fileScoped
            ? await this.callWrite(userToken, args.fileId!, spec.command, params)
            : await this.withoutAbort(() => this.callCommand(userToken, spec.command, params));
        return this.jsonResponse(result ?? { status: "ok" });
    }
}
