import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { ListWindow } from "./ListWindow";

/** Arguments of {@link ListFilesTool}. */
export class ListFilesArgs {
    static schema = {
        projectId: BackendIds.uuid()
            .optional()
            .describe("Id of the project whose files to list. Use it alone, or leave it out and pass teamId."),
        teamId: BackendIds.uuid()
            .optional()
            .describe(
                "Id of the team. Without query it lists the team's recent files; with query it searches the team; " +
                    "with deleted it lists the team's trash."
            ),
        query: z
            .string()
            .max(250)
            .optional()
            .describe("Text to search for in file names across the team. Needs teamId."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe(
                "Maximum number of files to return (1 to 1000, default 100). Applies to every listing. The backend " +
                    "answers in full, so the limit cuts the list after it answers; the output says how many files " +
                    "were shown and how many exist."
            ),
        deleted: z
            .boolean()
            .optional()
            .describe("When true, list the files in the team's trash instead. Needs teamId."),
    };

    projectId?: string;

    teamId?: string;

    query?: string;

    limit?: number;

    deleted?: boolean;
}

/** Lists the files of a project, a team's recent files, a team search, or a team's trash. */
export class ListFilesTool extends BackendTool<ListFilesArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ListFilesArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "list_files";
    }

    public getToolDescription(): string {
        return (
            "Lists files. Give a projectId to list one project's files, or a teamId alone to list the team's " +
            "recent files, or a teamId with query to search the team by name, or a teamId with deleted true to " +
            "list the team's trash. Every listing keeps the first 100 files unless limit says otherwise; the " +
            "output says how many were shown. " +
            "File ids returned here are the fileId for every later call. " +
            "Next: get_file_outline with a fileId."
        );
    }

    protected async executeBackend(args: ListFilesArgs, userToken: string): Promise<ToolResponse> {
        if (args.deleted) {
            this.requireTeam(args);
            return this.listed(
                await this.callCommand(userToken, "get-team-deleted-files", { teamId: args.teamId }),
                args
            );
        }
        if (args.projectId) {
            return this.listed(
                await this.callCommand(userToken, "get-project-files", { projectId: args.projectId }),
                args
            );
        }
        if (args.teamId) {
            if (args.query === undefined) {
                return this.listed(
                    await this.callCommand(userToken, "get-team-recent-files", { teamId: args.teamId }),
                    args
                );
            }
            return this.searchFiles(userToken, args.teamId, args.query, args);
        }
        throw new Error("list_files needs a projectId, or a teamId (alone, with query, or with deleted set to true).");
    }

    /**
     * Wraps the files of a listing with their counts, cut to the limit.
     *
     * @param answer - the files the backend returned; a non-list answer is returned unchanged
     * @param args - the tool arguments, which carry the limit
     */
    private listed(answer: unknown, args: ListFilesArgs): ToolResponse {
        if (!Array.isArray(answer)) {
            return this.jsonResponse(answer);
        }
        const kept = ListWindow.cut(answer, args.limit, "files");
        return this.jsonResponse({ files: kept.items, shown: kept.shown, total: kept.total, note: kept.note });
    }

    /**
     * Searches the file names of a team and cuts the matches to the limit.
     *
     * @param userToken - the MCP token of the request
     * @param teamId - team to search
     * @param query - text to find in the file names
     * @param args - the tool arguments, which carry the limit
     */
    private async searchFiles(
        userToken: string,
        teamId: string,
        query: string,
        args: ListFilesArgs
    ): Promise<ToolResponse> {
        const matches = await this.callCommand<unknown[]>(userToken, "search-files", {
            teamId,
            searchTerm: query,
        });
        return this.listed(matches, args);
    }

    /**
     * Ensures the team id is present for the trash listing.
     *
     * @param args - the tool arguments
     * @throws Error when no teamId is given
     */
    private requireTeam(args: ListFilesArgs): void {
        if (!args.teamId) {
            throw new Error("list_files with deleted set to true needs a teamId.");
        }
    }
}
