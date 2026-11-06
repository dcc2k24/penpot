import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

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
            .optional()
            .describe(
                "Maximum number of search matches to return (1 or more). Needs query. The search is not paginated, " +
                    "so the limit cuts the matches after the backend answers."
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

    public getToolName(): string {
        return "list_files";
    }

    public getToolDescription(): string {
        return (
            "Lists files. Give a projectId to list one project's files, or a teamId alone to list the team's " +
            "recent files, or a teamId with query to search the team by name, or a teamId with deleted true to " +
            "list the team's trash. The search is not paginated; limit cuts its matches client-side and the " +
            "output says how many were shown. " +
            "File ids returned here are the fileId for every later call. " +
            "Next: get_file_outline with a fileId."
        );
    }

    protected async executeBackend(args: ListFilesArgs, userToken: string): Promise<ToolResponse> {
        if (args.deleted) {
            this.requireTeam(args);
            return this.jsonResponse(
                await this.callCommand(userToken, "get-team-deleted-files", { teamId: args.teamId })
            );
        }
        if (args.projectId) {
            return this.jsonResponse(
                await this.callCommand(userToken, "get-project-files", { projectId: args.projectId })
            );
        }
        if (args.teamId) {
            if (args.query === undefined) {
                return this.jsonResponse(
                    await this.callCommand(userToken, "get-team-recent-files", { teamId: args.teamId })
                );
            }
            return this.searchFiles(userToken, args.teamId, args.query, args.limit);
        }
        throw new Error("list_files needs a projectId, or a teamId (alone, with query, or with deleted set to true).");
    }

    /**
     * Searches the file names of a team and cuts the matches to the limit, when one is given.
     *
     * @param userToken - the MCP token of the request
     * @param teamId - team to search
     * @param query - text to find in the file names
     * @param limit - largest number of matches to return; `undefined` returns every match
     */
    private async searchFiles(
        userToken: string,
        teamId: string,
        query: string,
        limit: number | undefined
    ): Promise<ToolResponse> {
        const matches = await this.callCommand<unknown[]>(userToken, "search-files", {
            teamId,
            searchTerm: query,
        });
        const shown = limit === undefined ? matches : matches.slice(0, limit);
        const note =
            shown.length < matches.length
                ? `Showing ${shown.length} of ${matches.length} matches. Narrow the query to see the rest.`
                : "";
        return this.jsonResponse({ files: shown, shown: shown.length, total: matches.length, note });
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
